// webtix — WebGPU progressive path tracer.
//
// The WebGL2 original ran the whole integrator in a GLSL fragment shader, read
// geometry + BVH out of RGB float *textures* via computed UVs, and accumulated
// through a ping-pong of framebuffers (see webtix `path-trace-engine.ts`). This
// is the WebGPU reimplementation:
//
//   • Geometry and the BVH live in `var<storage, read>` buffers — random access
//     by index, no texel-address arithmetic. The BVH is a flat skip-list walked
//     with a single forward scan (no stack).
//   • A full-screen fragment pass traces one new sample per draw and blends it
//     into an rgba16float accumulation target (ping-pong A/B).
//   • A present pass tonemaps the HDR accumulator into an rgba8unorm texture the
//     host UI composites with `draw_texture`.
//
// It shares the host `GPUDevice` (no second WebGPU context), exactly like the
// asset-audit viewport.

import type { webtix_bvh } from './ui_webtix_bvh'

/** Disney-style material — mirrors the engine's `material` struct. */
export interface webtix_material {
  emission: [number, number, number]
  color: [number, number, number]
  absorption: [number, number, number]
  eta: number
  metallic: number
  subsurface: number
  specular: number
  roughness: number
  specular_tint: number
  anisotropic: number
  sheen: number
  sheen_tint: number
  clearcoat: number
  clearcoat_glossiness: number
  transmission: number
}

export function default_material(): webtix_material {
  return {
    emission: [0, 0, 0],
    color: [0.82, 0.82, 0.85],
    absorption: [0, 0, 0],
    eta: 1.5,
    metallic: 0.0,
    subsurface: 0.0,
    specular: 0.5,
    roughness: 0.25,
    specular_tint: 0.0,
    anisotropic: 0.0,
    sheen: 0.0,
    sheen_tint: 0.0,
    clearcoat: 0.0,
    clearcoat_glossiness: 0.0,
    transmission: 0.0,
  }
}

export interface webtix_render_params {
  eye: [number, number, number]
  target: [number, number, number]
  fov: number
  bounces: number
  material: webtix_material
  /** Linear sky/zenith colour. */
  env_top: [number, number, number]
  /** Linear horizon/ground colour. */
  env_bottom: [number, number, number]
  env_intensity: number
}

const UNIFORM_F32 = 52 // 13 × vec4
const MAX_DEPTH = 32

export class webtix_tracer {
  private device: GPUDevice | null = null
  private trace_pipeline: GPURenderPipeline | null = null
  private present_pipeline: GPURenderPipeline | null = null
  private trace_layout: GPUBindGroupLayout | null = null
  private present_layout: GPUBindGroupLayout | null = null

  private uniform: GPUBuffer | null = null
  private bvh_buffer: GPUBuffer | null = null
  private position_buffer: GPUBuffer | null = null
  private normal_buffer: GPUBuffer | null = null
  private index_buffer: GPUBuffer | null = null
  private node_count = 0
  private has_scene = false

  private accum: [GPUTexture, GPUTexture] | null = null
  private display: GPUTexture | null = null
  private width = 0
  private height = 0

  // Ping-pong bind groups: trace[p] reads accum[p], writes accum[p^1];
  // present[p] reads accum[p^1] (the just-written target).
  private trace_bind: [GPUBindGroup, GPUBindGroup] | null = null
  private present_bind: [GPUBindGroup, GPUBindGroup] | null = null
  private pp = 0
  private uniform_data = new Float32Array(UNIFORM_F32)

  /** 0-based index of the next sample to accumulate. */
  frame_index = 0

  init(device: GPUDevice): void {
    if (this.device === device && this.trace_pipeline) return
    this.device = device
    const module = device.createShaderModule({ label: 'webtix.trace_shader', code: TRACE_WGSL })
    const present_module = device.createShaderModule({ label: 'webtix.present_shader', code: PRESENT_WGSL })

    this.trace_layout = device.createBindGroupLayout({
      label: 'webtix.trace_layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    })
    this.present_layout = device.createBindGroupLayout({
      label: 'webtix.present_layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'unfilterable-float' } },
      ],
    })

    this.trace_pipeline = device.createRenderPipeline({
      label: 'webtix.trace_pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.trace_layout] }),
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba16float' }] },
      primitive: { topology: 'triangle-list' },
    })
    this.present_pipeline = device.createRenderPipeline({
      label: 'webtix.present_pipeline',
      layout: device.createPipelineLayout({ bindGroupLayouts: [this.present_layout] }),
      vertex: { module: present_module, entryPoint: 'vs_main' },
      fragment: { module: present_module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })

    this.uniform = device.createBuffer({
      label: 'webtix.uniform',
      size: UNIFORM_F32 * 4,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
  }

  /** Upload a built BVH + geometry into storage buffers. Resets accumulation. */
  set_scene(bvh: webtix_bvh, positions: Float32Array, normals: Float32Array): void {
    const device = this.device
    if (!device) return
    this.bvh_buffer?.destroy()
    this.position_buffer?.destroy()
    this.normal_buffer?.destroy()
    this.index_buffer?.destroy()

    this.node_count = bvh.node_count
    this.bvh_buffer = make_storage(device, 'webtix.bvh', bvh.nodes)
    this.position_buffer = make_storage(device, 'webtix.positions', positions)
    this.normal_buffer = make_storage(device, 'webtix.normals', normals)
    this.index_buffer = make_storage(device, 'webtix.indices', bvh.indices)
    this.has_scene = true
    this.trace_bind = null // geometry changed → rebind
    this.reset()
  }

  /** Restart accumulation (call on any camera/material/scene change). */
  reset(): void {
    this.frame_index = 0
    this.pp = 0
  }

  private ensure_targets(w: number, h: number): void {
    const device = this.device!
    if (this.accum && this.width === w && this.height === h) return
    this.accum?.[0].destroy()
    this.accum?.[1].destroy()
    this.display?.destroy()
    this.width = w
    this.height = h
    const make_accum = (label: string) => device.createTexture({
      label, size: [w, h, 1], format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.accum = [make_accum('webtix.accum_a'), make_accum('webtix.accum_b')]
    this.display = device.createTexture({
      label: 'webtix.display', size: [w, h, 1], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.trace_bind = null
    this.present_bind = null
  }

  private ensure_bind_groups(): void {
    const device = this.device!
    if (!this.accum || !this.trace_layout || !this.present_layout) return
    if (this.trace_bind && this.present_bind) return
    const geom = (p: number): GPUBindGroup => device.createBindGroup({
      label: 'webtix.trace_bind',
      layout: this.trace_layout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniform! } },
        { binding: 1, resource: { buffer: this.bvh_buffer! } },
        { binding: 2, resource: { buffer: this.position_buffer! } },
        { binding: 3, resource: { buffer: this.normal_buffer! } },
        { binding: 4, resource: { buffer: this.index_buffer! } },
        { binding: 5, resource: this.accum![p].createView() },
      ],
    })
    this.trace_bind = [geom(0), geom(1)]
    const present = (p: number): GPUBindGroup => device.createBindGroup({
      label: 'webtix.present_bind',
      layout: this.present_layout!,
      entries: [{ binding: 0, resource: this.accum![p].createView() }],
    })
    this.present_bind = [present(0), present(1)]
  }

  /** Number of fully-accumulated samples currently in the display texture. */
  get samples(): number { return this.frame_index }

  /**
   * Trace one more sample at the given size and return the rgba8unorm display
   * texture (or null until init/scene/targets are ready).
   */
  render_sample(w: number, h: number, params: webtix_render_params): GPUTexture | null {
    const device = this.device
    if (!device || !this.trace_pipeline || !this.present_pipeline || !this.has_scene) return null
    const pw = Math.max(1, Math.floor(w))
    const ph = Math.max(1, Math.floor(h))
    this.ensure_targets(pw, ph)
    this.ensure_bind_groups()
    if (!this.accum || !this.display || !this.trace_bind || !this.present_bind) return null

    this.write_uniforms(pw, ph, params)

    const read = this.pp
    const write = this.pp ^ 1
    const encoder = device.createCommandEncoder({ label: 'webtix.encoder' })

    // Trace + accumulate into accum[write], reading history from accum[read].
    const trace_pass = encoder.beginRenderPass({
      label: 'webtix.trace_pass',
      colorAttachments: [{ view: this.accum[write].createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    })
    trace_pass.setPipeline(this.trace_pipeline)
    trace_pass.setBindGroup(0, this.trace_bind[read])
    trace_pass.draw(3)
    trace_pass.end()

    // Tonemap accum[write] → display.
    const present_pass = encoder.beginRenderPass({
      label: 'webtix.present_pass',
      colorAttachments: [{ view: this.display.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    })
    present_pass.setPipeline(this.present_pipeline)
    present_pass.setBindGroup(0, this.present_bind[write])
    present_pass.draw(3)
    present_pass.end()

    device.queue.submit([encoder.finish()])
    this.pp = write
    this.frame_index += 1
    return this.display
  }

  private write_uniforms(w: number, h: number, p: webtix_render_params): void {
    const u = this.uniform_data
    const m = p.material
    const fwd = normalize(sub(p.target, p.eye))
    u[0] = p.eye[0]; u[1] = p.eye[1]; u[2] = p.eye[2]; u[3] = 0
    u[4] = fwd[0]; u[5] = fwd[1]; u[6] = fwd[2]; u[7] = 0
    u[8] = 0; u[9] = 1; u[10] = 0; u[11] = 0 // world up
    u[12] = this.frame_index; u[13] = 0; u[14] = Math.random(); u[15] = this.node_count
    u[16] = m.emission[0]; u[17] = m.emission[1]; u[18] = m.emission[2]; u[19] = m.eta
    u[20] = m.color[0]; u[21] = m.color[1]; u[22] = m.color[2]; u[23] = m.metallic
    u[24] = m.absorption[0]; u[25] = m.absorption[1]; u[26] = m.absorption[2]; u[27] = m.subsurface
    u[28] = m.specular; u[29] = m.roughness; u[30] = m.specular_tint; u[31] = m.anisotropic
    u[32] = m.sheen; u[33] = m.sheen_tint; u[34] = m.clearcoat; u[35] = m.clearcoat_glossiness
    u[36] = m.transmission; u[37] = Math.min(MAX_DEPTH, Math.max(1, p.bounces | 0)); u[38] = p.fov; u[39] = p.env_intensity
    u[40] = p.env_top[0]; u[41] = p.env_top[1]; u[42] = p.env_top[2]; u[43] = 0
    u[44] = p.env_bottom[0]; u[45] = p.env_bottom[1]; u[46] = p.env_bottom[2]; u[47] = 0
    u[48] = w; u[49] = h; u[50] = 0; u[51] = 0
    this.device!.queue.writeBuffer(this.uniform!, 0, u)
  }

  dispose(): void {
    this.bvh_buffer?.destroy()
    this.position_buffer?.destroy()
    this.normal_buffer?.destroy()
    this.index_buffer?.destroy()
    this.uniform?.destroy()
    this.accum?.[0].destroy()
    this.accum?.[1].destroy()
    this.display?.destroy()
    this.accum = null
    this.display = null
    this.has_scene = false
  }
}

function make_storage(device: GPUDevice, label: string, data: Float32Array | Uint32Array): GPUBuffer {
  const buffer = device.createBuffer({ label, size: Math.max(4, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(buffer, 0, data as unknown as GPUAllowSharedBufferSource)
  return buffer
}

function sub(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function normalize(a: [number, number, number]): [number, number, number] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

// ============================================================================
// WGSL — full-screen progressive path tracer.
// ============================================================================

const TRACE_WGSL = /* wgsl */ `
const PI: f32 = 3.141592653589793;
const PI2: f32 = 6.283185307179586;
const PI_INV: f32 = 0.3183098861837907;
const EPS: f32 = 1e-4;
const MAX_T: f32 = 1e10;
const MAX_DEPTH: i32 = ${MAX_DEPTH};

struct Uniforms {
  cam_pos: vec4f,
  cam_fwd: vec4f,
  cam_up: vec4f,
  frame: vec4f,     // frame_index, _, seed, node_count
  emission: vec4f,  // rgb, w = eta
  color: vec4f,     // rgb, w = metallic
  absorption: vec4f,// rgb, w = subsurface
  p0: vec4f,        // specular, roughness, specular_tint, anisotropic
  p1: vec4f,        // sheen, sheen_tint, clearcoat, clearcoat_gloss
  p2: vec4f,        // transmission, depth, fov, env_intensity
  env_top: vec4f,
  env_bot: vec4f,
  res: vec4f,       // width, height
}

struct bvh_node {
  bmin: vec3f,
  count: f32,
  bmax: vec3f,
  prim: f32,
}

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var<storage, read> bvh: array<bvh_node>;
@group(0) @binding(2) var<storage, read> positions: array<f32>;
@group(0) @binding(3) var<storage, read> normals: array<f32>;
@group(0) @binding(4) var<storage, read> indices: array<u32>;
@group(0) @binding(5) var history: texture_2d<f32>;

struct Material {
  emission: vec3f,
  color: vec3f,
  absorption: vec3f,
  eta: f32,
  metallic: f32,
  subsurface: f32,
  specular: f32,
  roughness: f32,
  specular_tint: f32,
  sheen: f32,
  sheen_tint: f32,
  clearcoat: f32,
  clearcoat_glossiness: f32,
  transmission: f32,
}

fn get_material() -> Material {
  var m: Material;
  m.emission = U.emission.xyz;
  m.color = U.color.xyz;
  m.absorption = U.absorption.xyz;
  m.eta = U.emission.w;
  m.metallic = U.color.w;
  m.subsurface = U.absorption.w;
  m.specular = U.p0.x;
  m.roughness = U.p0.y;
  m.specular_tint = U.p0.z;
  m.sheen = U.p1.x;
  m.sheen_tint = U.p1.y;
  m.clearcoat = U.p1.z;
  m.clearcoat_glossiness = U.p1.w;
  m.transmission = U.p2.x;
  return m;
}

// --- RNG (PCG hash + advancing state) ---------------------------------------
var<private> rng_state: u32;

fn pcg(v: u32) -> u32 {
  let state = v * 747796405u + 2891336453u;
  let word = ((state >> ((state >> 28u) + 4u)) ^ state) * 277803737u;
  return (word >> 22u) ^ word;
}

fn rand() -> f32 {
  rng_state = pcg(rng_state);
  return f32(rng_state) * (1.0 / 4294967296.0);
}

fn fetch_pos(i: u32) -> vec3f {
  return vec3f(positions[i * 3u], positions[i * 3u + 1u], positions[i * 3u + 2u]);
}
fn fetch_nrm(i: u32) -> vec3f {
  return vec3f(normals[i * 3u], normals[i * 3u + 1u], normals[i * 3u + 2u]);
}

// Slab test → entry distance (0 if the ray origin is already inside).
fn box_intersect(bmin: vec3f, bmax: vec3f, ro: vec3f, inv_dir: vec3f) -> f32 {
  let t0 = (bmin - ro) * inv_dir;
  let t1 = (bmax - ro) * inv_dir;
  let tn = min(t0, t1);
  let tf = max(t0, t1);
  let t_near = max(tn.x, max(tn.y, tn.z));
  let t_far = min(tf.x, min(tf.y, tf.z));
  if (t_far < 0.0 || t_near > t_far) { return -1.0; }
  return max(t_near, 0.0);
}

struct Hit {
  t: f32,
  position: vec3f,
  normal: vec3f,
  hit: bool,
}

// Möller–Trumbore (double sided). Returns (t,u,v); t<0 on miss.
fn tri_intersect(p0: vec3f, p1: vec3f, p2: vec3f, ro: vec3f, rd: vec3f) -> vec3f {
  let e1 = p2 - p0;
  let e2 = p1 - p0;
  let pv = cross(rd, e2);
  let det = dot(e1, pv);
  if (abs(det) < 1e-12) { return vec3f(-1.0, 0.0, 0.0); }
  let inv = 1.0 / det;
  let tv = ro - p0;
  let u = dot(tv, pv) * inv;
  if (u < 0.0 || u > 1.0) { return vec3f(-1.0, 0.0, 0.0); }
  let qv = cross(tv, e1);
  let v = dot(rd, qv) * inv;
  if (v < 0.0 || u + v > 1.0) { return vec3f(-1.0, 0.0, 0.0); }
  let t = dot(e2, qv) * inv;
  if (t <= 0.0) { return vec3f(-1.0, 0.0, 0.0); }
  return vec3f(t, u, v);
}

// Stackless BVH walk: descend on a box hit, skip the whole subtree on a miss.
fn trace(ro: vec3f, rd: vec3f) -> Hit {
  var result: Hit;
  result.hit = false;
  result.t = MAX_T;
  let inv_dir = 1.0 / rd;
  let n = i32(U.frame.w);
  var best = MAX_T;
  var best_n0 = vec3f(0.0);
  var best_n1 = vec3f(0.0);
  var best_n2 = vec3f(0.0);
  var best_u = 0.0;
  var best_v = 0.0;
  var i = 0;
  loop {
    if (i >= n) { break; }
    let node = bvh[i];
    let t = box_intersect(node.bmin, node.bmax, ro, inv_dir);
    if (t >= 0.0 && t < best) {
      if (node.count < 0.5) {
        // leaf — intersect its triangle
        let pi = u32(node.prim) * 3u;
        let i0 = indices[pi]; let i1 = indices[pi + 1u]; let i2 = indices[pi + 2u];
        let hit = tri_intersect(fetch_pos(i0), fetch_pos(i1), fetch_pos(i2), ro, rd);
        if (hit.x > 0.0 && hit.x < best) {
          best = hit.x;
          best_u = hit.y; best_v = hit.z;
          best_n0 = fetch_nrm(i0); best_n1 = fetch_nrm(i1); best_n2 = fetch_nrm(i2);
        }
      }
      i = i + 1;
    } else {
      // box miss (or farther than the closest hit): jump past this subtree.
      if (node.count >= 0.5) { i = i + i32(node.count) + 1; } else { i = i + 1; }
    }
  }
  if (best < MAX_T) {
    result.hit = true;
    result.t = best;
    result.position = ro + rd * best;
    result.normal = normalize(best_n0 * (1.0 - best_u - best_v) + best_n1 * best_u + best_n2 * best_v);
  }
  return result;
}

fn trace_shadow(ro: vec3f, rd: vec3f, max_dist: f32) -> bool {
  let inv_dir = 1.0 / rd;
  let n = i32(U.frame.w);
  var i = 0;
  loop {
    if (i >= n) { break; }
    let node = bvh[i];
    let t = box_intersect(node.bmin, node.bmax, ro, inv_dir);
    if (t >= 0.0 && t < max_dist) {
      if (node.count < 0.5) {
        let pi = u32(node.prim) * 3u;
        let hit = tri_intersect(fetch_pos(indices[pi]), fetch_pos(indices[pi + 1u]), fetch_pos(indices[pi + 2u]), ro, rd);
        if (hit.x > 0.0 && hit.x < max_dist) { return true; }
      }
      i = i + 1;
    } else {
      if (node.count >= 0.5) { i = i + i32(node.count) + 1; } else { i = i + 1; }
    }
  }
  return false;
}

// --- environment (procedural sky) -------------------------------------------
fn sample_environment(dir: vec3f) -> vec3f {
  let t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  let sky = mix(U.env_bot.xyz, U.env_top.xyz, t);
  // soft sun towards (0.4, 0.8, 0.3)
  let sun = normalize(vec3f(0.4, 0.8, 0.3));
  let s = pow(max(dot(dir, sun), 0.0), 64.0);
  return (sky + vec3f(1.0, 0.9, 0.7) * s * 1.5) * U.p2.w;
}

// --- Disney BSDF (ported from disney.glsl) ----------------------------------
fn square(a: f32) -> f32 { return a * a; }
fn luminance(c: vec3f) -> f32 { return dot(c, vec3f(0.299, 0.587, 0.114)); }

fn ggx_smith(n_dot_v: f32, roughness: f32) -> f32 {
  let a = roughness * roughness;
  let b = n_dot_v * n_dot_v;
  return 1.0 / (n_dot_v + sqrt(a + b - a * b));
}

fn fresnel_schlick(u: f32) -> f32 {
  let m = clamp(1.0 - u, 0.0, 1.0);
  let m2 = m * m;
  return m2 * m2 * m;
}

fn fresnel(v_dot_n: f32, eta_i: f32, eta_o: f32) -> f32 {
  let sin_t2 = square(eta_i / eta_o) * (1.0 - v_dot_n * v_dot_n);
  if (sin_t2 > 1.0) { return 1.0; }
  let l_dot_n = sqrt(1.0 - sin_t2);
  let eta = eta_o / eta_i;
  let r1 = (v_dot_n - eta * l_dot_n) / (v_dot_n + eta * l_dot_n);
  let r2 = (l_dot_n - eta * v_dot_n) / (l_dot_n + eta * v_dot_n);
  return clamp(0.5 * (square(r1) + square(r2)), 0.0, 1.0);
}

fn gtr2(n_dot_h: f32, a: f32) -> f32 {
  let a2 = a * a;
  let t = 1.0 + (a2 - 1.0) * n_dot_h * n_dot_h;
  return a2 / (PI * t * t);
}

fn gtr1(n_dot_h: f32, a: f32) -> f32 {
  if (a >= 1.0) { return PI_INV; }
  let a2 = a * a;
  let t = 1.0 + (a2 - 1.0) * n_dot_h * n_dot_h;
  return (a2 - 1.0) / (PI * log(a2) * t);
}

fn basis(n: vec3f) -> mat3x3<f32> {
  var up = vec3f(0.0, 1.0, 0.0);
  if (abs(n.y) > 0.999) { up = vec3f(1.0, 0.0, 0.0); }
  let left = normalize(cross(n, up));
  let upv = cross(left, n);
  return mat3x3<f32>(left, upv, n);
}

fn hemisphere_cos(n: vec3f, r: vec2f) -> vec3f {
  let phi = r.y * PI2;
  let cos_theta = sqrt(1.0 - r.x);
  let sin_theta = sqrt(max(0.0, 1.0 - cos_theta * cos_theta));
  let b = basis(n);
  return normalize(b * vec3f(cos(phi) * sin_theta, sin(phi) * sin_theta, cos_theta));
}

fn sample_half(a: f32, r: vec2f, n: vec3f) -> vec3f {
  let phi = r.x * PI2;
  let ct = sqrt((1.0 - r.y) / (1.0 + (square(a) - 1.0) * r.y));
  let st = sqrt(max(0.0, 1.0 - ct * ct));
  let b = basis(n);
  return normalize(b * vec3f(st * cos(phi), st * sin(phi), ct));
}

fn disney_pdf(m: Material, normal: vec3f, view: vec3f, light: vec3f) -> f32 {
  var bsdf_pdf = 0.0;
  var brdf_pdf = 0.0;
  if (dot(normal, light) <= 0.0) {
    brdf_pdf = (1.0 / PI2) * m.subsurface * 0.5;
  } else {
    let f = fresnel(dot(normal, view), 1.0, m.eta);
    let a = max(0.001, m.roughness);
    let h = normalize(light + view);
    let cos_h = abs(dot(h, normal));
    let pdf_half = gtr2(cos_h, a) * cos_h;
    let pdf_spec = 0.25 * pdf_half / max(EPS, dot(light, h));
    let pdf_diff = abs(dot(light, normal)) * PI_INV * (1.0 - m.subsurface);
    bsdf_pdf = pdf_spec * f;
    brdf_pdf = mix(pdf_diff, pdf_spec, 0.5);
  }
  return mix(brdf_pdf, bsdf_pdf, m.transmission);
}

struct SampleResult {
  light: vec3f,
  pdf: f32,
}

fn disney_sample(m: Material, normal: vec3f, view: vec3f) -> SampleResult {
  var res: SampleResult;
  res.pdf = 0.0;
  let r0 = rand();
  if (r0 < m.transmission) {
    let f = fresnel(dot(normal, view), 1.0, m.eta);
    if (rand() < f) {
      let a = max(0.001, m.roughness);
      var h = sample_half(a, vec2f(rand(), rand()), normal);
      if (dot(h, view) <= 0.0) { h = -h; }
      res.light = normalize(reflect(-view, h));
    } else {
      let eta = 1.0 / m.eta;
      let refr = refract(-view, normal, eta);
      if (dot(refr, refr) > 0.0) {
        res.light = normalize(refr);
        res.pdf = (1.0 - f) * m.transmission;
        return res;
      }
      return res;
    }
  } else {
    if (rand() < 0.5) {
      res.light = hemisphere_cos(normal, vec2f(rand(), rand()));
    } else {
      let a = max(0.001, m.roughness);
      var h = sample_half(a, vec2f(rand(), rand()), normal);
      if (dot(h, view) <= 0.0) { h = -h; }
      res.light = normalize(reflect(-view, h));
    }
  }
  res.pdf = disney_pdf(m, normal, view, res.light);
  return res;
}

fn disney_eval(m: Material, normal: vec3f, view: vec3f, light: vec3f) -> vec3f {
  let n_dot_l = dot(normal, light);
  let n_dot_v = dot(normal, view);
  let h = normalize(light + view);
  let n_dot_h = dot(normal, h);
  let l_dot_h = dot(light, h);

  let color = m.color;
  let lum = luminance(color);
  var tint = vec3f(1.0);
  if (lum > 0.0) { tint = color / lum; }
  let spec = mix(m.specular * 0.08 * mix(vec3f(1.0), tint, m.specular_tint), color, m.metallic);

  var bsdf = vec3f(0.0);
  var brdf = vec3f(0.0);

  if (m.transmission > 0.0) {
    if (n_dot_l <= 0.0) {
      let f = fresnel(n_dot_v, 1.0, m.eta);
      bsdf = vec3f(m.transmission * (1.0 - f) / max(EPS, abs(n_dot_l)) * (1.0 - m.metallic));
    } else {
      let a = max(0.001, m.roughness);
      let ds = gtr2(n_dot_h, a);
      let fh = fresnel(l_dot_h, 1.0, m.eta);
      let fs = mix(spec, vec3f(1.0), fh);
      let gs = ggx_smith(n_dot_v, a) * ggx_smith(n_dot_l, a);
      bsdf = gs * fs * ds;
    }
  }

  if (m.transmission < 1.0) {
    if (n_dot_l <= 0.0) {
      if (m.subsurface > 0.0) {
        let s = sqrt(color);
        let fl = fresnel_schlick(abs(n_dot_l));
        let fv = fresnel_schlick(n_dot_v);
        let fd = (1.0 - 0.5 * fl) * (1.0 - 0.5 * fv);
        brdf = PI_INV * s * m.subsurface * fd * (1.0 - m.metallic);
      }
    } else {
      let a = max(0.001, m.roughness);
      let ds = gtr2(n_dot_h, a);
      let fh = fresnel_schlick(l_dot_h);
      let fs = mix(spec, vec3f(1.0), fh);
      let gs = ggx_smith(n_dot_v, a) * ggx_smith(n_dot_l, a);
      let fl = fresnel_schlick(n_dot_l);
      let fv = fresnel_schlick(n_dot_v);
      let f0 = 0.5 + 2.0 * l_dot_h * l_dot_h * m.roughness;
      let fd = mix(1.0, f0, fl) * mix(1.0, f0, fv);
      let dr = gtr1(n_dot_h, mix(0.1, 0.001, m.clearcoat_glossiness));
      let fc = mix(0.04, 1.0, fh);
      let gr = ggx_smith(n_dot_l, 0.25) * ggx_smith(n_dot_v, 0.25);
      brdf = PI_INV * fd * color * (1.0 - m.metallic) * (1.0 - m.subsurface) + gs * fs * ds + m.clearcoat * gr * fc * dr;
    }
  }
  return mix(brdf, bsdf, m.transmission);
}

fn face_normal(n: vec3f, v: vec3f) -> vec3f {
  return select(-n, n, dot(n, v) > 0.0);
}

// --- integrator -------------------------------------------------------------
fn integrate(ro_in: vec3f, rd_in: vec3f) -> vec3f {
  let m = get_material();
  var throughput = vec3f(1.0);
  var radiance = vec3f(0.0);
  var ro = ro_in;
  var rd = rd_in;
  var ray_eta = 1.0;
  let depth = i32(U.p2.y);

  for (var bounce = 0; bounce < MAX_DEPTH; bounce = bounce + 1) {
    if (bounce >= depth) { break; }
    let hit = trace(ro, rd);
    if (!hit.hit) {
      radiance = radiance + throughput * sample_environment(rd);
      break;
    }

    var normal = hit.normal;
    let view = -rd;
    var surface_eta = m.eta;
    if (ray_eta != 1.0) { surface_eta = 1.0; }

    radiance = radiance + throughput * m.emission;

    let samp = disney_sample(m, normal, view);
    if (samp.pdf <= 0.0) { break; }
    let f = disney_eval(m, normal, view, samp.light);
    if (dot(normal, samp.light) <= 0.0) { ray_eta = surface_eta; }
    throughput = clamp(throughput * f * abs(dot(normal, samp.light)) / samp.pdf, vec3f(0.0), vec3f(1.0));

    // Russian roulette after a few bounces keeps deep paths cheap.
    if (bounce > 3) {
      let q = max(throughput.x, max(throughput.y, throughput.z));
      if (rand() > q) { break; }
      throughput = throughput / max(EPS, q);
    }

    ro = hit.position + face_normal(normal, samp.light) * EPS;
    rd = samp.light;
  }
  return radiance;
}

// --- full-screen plumbing ---------------------------------------------------
struct VsOut {
  @builtin(position) pos: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VsOut;
  let xy = p[vi];
  out.pos = vec4f(xy, 0.0, 1.0);
  out.uv = xy * 0.5 + vec2f(0.5);
  return out;
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let width = U.res.x;
  let height = U.res.y;
  let px = vec2u(u32(in.pos.x), u32(in.pos.y));
  let frame_index = U.frame.x;
  // Seed per pixel + sample so each accumulation step is decorrelated.
  rng_state = pcg(px.x + px.y * u32(width) + u32(frame_index) * 9781u + u32(U.frame.z * 4294967295.0));

  // Camera ray with sub-pixel jitter for antialiasing.
  let fwd = U.cam_fwd.xyz;
  let x_axis = normalize(cross(fwd, U.cam_up.xyz));
  let y_axis = normalize(cross(x_axis, fwd));
  let aspect = width / max(1.0, height);
  let jitter = vec2f(rand(), rand()) - vec2f(0.5);
  let ndc = (vec2f(in.pos.xy) + jitter) / vec2f(width, height) * 2.0 - vec2f(1.0);
  let scale = tan(U.p2.z * 0.5);
  let dir = normalize(fwd + x_axis * ndc.x * scale * aspect - y_axis * ndc.y * scale);

  var radiance = integrate(U.cam_pos.xyz, dir);
  radiance = min(radiance, vec3f(1e3));

  let prev = textureLoad(history, vec2i(px), 0).xyz;
  let blended = mix(prev, radiance, 1.0 / (frame_index + 1.0));
  return vec4f(blended, 1.0);
}
`

const PRESENT_WGSL = /* wgsl */ `
@group(0) @binding(0) var src: texture_2d<f32>;

struct VsOut { @builtin(position) pos: vec4f }

@vertex
fn vs_main(@builtin(vertex_index) vi: u32) -> VsOut {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: VsOut;
  out.pos = vec4f(p[vi], 0.0, 1.0);
  return out;
}

fn aces(x: vec3f) -> vec3f {
  let a = 2.51; let b = 0.03; let c = 2.43; let d = 0.59; let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

fn linear_to_srgb(c: vec3f) -> vec3f {
  let lo = c * 12.92;
  let hi = pow(c, vec3f(1.0 / 2.4)) * 1.055 - vec3f(0.055);
  return select(hi, lo, c <= vec3f(0.0031308));
}

@fragment
fn fs_main(in: VsOut) -> @location(0) vec4f {
  let hdr = textureLoad(src, vec2i(i32(in.pos.x), i32(in.pos.y)), 0).xyz;
  return vec4f(linear_to_srgb(aces(hdr)), 1.0);
}
`
