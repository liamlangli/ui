// webtix — WebGPU wavefront path tracer.
//
// The WebGL2 original ran the whole integrator in a GLSL fragment shader, read
// geometry + BVH out of RGB float *textures* via computed UVs, and accumulated
// through a ping-pong of framebuffers. The first WebGPU port kept that
// "megakernel" shape: a single full-screen fragment pass walked the *entire*
// bounce loop for every pixel in one draw. That made frame time scale with the
// deepest path on screen and wasted GPU lanes once short paths terminated —
// frames stuttered whenever the bounce budget went up.
//
// This is the wavefront reimplementation:
//
//   • One ray "task" slot per pixel lives in a persistent `read_write` storage
//     buffer (origin, direction, throughput, accumulated radiance, bounce,
//     alive). Because this is a single-sample-per-pixel integrator (no path
//     splitting), a pixel owns at most one live ray, so the queue is just
//     indexed by pixel — no atomics, no compaction.
//   • A compute "run" traces every live ray exactly **once**, shades it, and
//     either writes the continuation ray back into its own slot or finalizes the
//     path (adding its radiance to the accumulation buffer and starting a fresh
//     primary next time the slot is visited).
//   • Each frame issues a small, fixed number of runs (`runs_per_frame`). Deep
//     paths simply spill across frames, so per-frame GPU cost is bounded and
//     roughly constant regardless of the bounce budget — the image refines
//     progressively and frames stay smooth.
//   • A present pass divides the accumulation buffer by its per-pixel sample
//     count, tonemaps, and writes the rgba8unorm texture the host composites.
//
// It shares the host `GPUDevice` (no second WebGPU context), exactly like the
// asset-audit viewport.

import { build_tlas_from_bvh, type webtix_bvh, type webtix_tlas } from './ui_webtix_bvh'
import type { webtix_hdr_image } from '../ui_webtix_hdr'

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
  render_mode?: webtix_render_mode
}

export type webtix_render_mode = 'ao' | 'lighting'

const UNIFORM_F32 = 52 // 13 × vec4
const MAX_DEPTH = 32
const WORKGROUP = 8 // 8×8 = 64 invocations
const TASK_F32 = 16 // 4 × vec4 per ray task
const TASK_BYTES = TASK_F32 * 4

export class webtix_tracer {
  private device: GPUDevice | null = null
  private trace_pipeline: GPUComputePipeline | null = null
  private clear_pipeline: GPUComputePipeline | null = null
  private present_pipeline: GPURenderPipeline | null = null
  private trace_layout: GPUBindGroupLayout | null = null
  private present_layout: GPUBindGroupLayout | null = null

  private uniform: GPUBuffer | null = null
  private tlas_buffer: GPUBuffer | null = null
  private blas_buffer: GPUBuffer | null = null
  private instance_buffer: GPUBuffer | null = null
  private vertex_buffer: GPUBuffer | null = null
  private index_buffer: GPUBuffer | null = null
  private env_texture: GPUTexture | null = null
  private env_sampler: GPUSampler | null = null
  private tlas_node_count = 0
  private has_scene = false

  // Wavefront state: one ray task + one accumulator slot per pixel, plus a
  // single atomic counter of finalized paths (read back to report progress).
  private task_buffer: GPUBuffer | null = null
  private accum_buffer: GPUBuffer | null = null
  private counter_buffer: GPUBuffer | null = null
  private counter_staging: GPUBuffer | null = null
  private readback_pending = false
  private completed_total = 0
  // Bumped on every reset so an in-flight readback issued for an older
  // accumulation generation is discarded instead of reviving a stale count.
  private accum_generation = 0

  private display: GPUTexture | null = null
  private width = 0
  private height = 0

  private trace_bind: GPUBindGroup | null = null
  private present_bind: GPUBindGroup | null = null
  private uniform_data = new Float32Array(UNIFORM_F32)

  /** Compute "runs" (single-bounce trace dispatches) issued per frame. */
  runs_per_frame = 4
  /** Restart the queue + accumulation on the next render. */
  private needs_clear = true
  /** Monotonic run index — seeds per-run RNG so successive runs decorrelate. */
  private run_counter = 0

  init(device: GPUDevice): void {
    if (this.device === device && this.trace_pipeline) return
    this.device = device
    const trace_module = device.createShaderModule({ label: 'webtix.trace_shader', code: TRACE_WGSL })
    const present_module = device.createShaderModule({ label: 'webtix.present_shader', code: PRESENT_WGSL })

    this.trace_layout = device.createBindGroupLayout({
      label: 'webtix.trace_layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 4, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 5, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'read-only-storage' } },
        { binding: 6, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },       // ray tasks
        { binding: 7, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },       // accumulator
        { binding: 8, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },       // finalized counter
        { binding: 9, visibility: GPUShaderStage.COMPUTE, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 10, visibility: GPUShaderStage.COMPUTE, sampler: { type: 'filtering' } },
      ],
    })
    this.present_layout = device.createBindGroupLayout({
      label: 'webtix.present_layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'read-only-storage' } },
      ],
    })

    const trace_pipeline_layout = device.createPipelineLayout({ bindGroupLayouts: [this.trace_layout] })
    this.trace_pipeline = device.createComputePipeline({
      label: 'webtix.trace_pipeline',
      layout: trace_pipeline_layout,
      compute: { module: trace_module, entryPoint: 'cs_trace' },
    })
    this.clear_pipeline = device.createComputePipeline({
      label: 'webtix.clear_pipeline',
      layout: trace_pipeline_layout,
      compute: { module: trace_module, entryPoint: 'cs_clear' },
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
    this.counter_buffer = device.createBuffer({
      label: 'webtix.counter',
      size: 4,
      usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC,
    })
    this.counter_staging = device.createBuffer({
      label: 'webtix.counter_staging',
      size: 4,
      usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST,
    })
    this.env_sampler = device.createSampler({
      label: 'webtix.env_sampler',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
    })
    this.ensure_environment_texture()
  }

  /** Upload a built BVH + geometry into storage buffers. Resets accumulation. */
  set_scene(bvh: webtix_bvh, positions: Float32Array, normals: Float32Array): void {
    this.set_tlas_scene(build_tlas_from_bvh(bvh, positions, normals))
  }

  /** Upload a TLAS scene containing analytic primitives and/or mesh BLAS instances. */
  set_tlas_scene(scene: webtix_tlas): void {
    const device = this.device
    if (!device) return
    this.tlas_buffer?.destroy()
    this.blas_buffer?.destroy()
    this.instance_buffer?.destroy()
    this.vertex_buffer?.destroy()
    this.index_buffer?.destroy()

    this.tlas_node_count = scene.tlas_node_count
    this.tlas_buffer = make_storage(device, 'webtix.tlas', scene.tlas_nodes, 32)
    this.blas_buffer = make_storage(device, 'webtix.blas', scene.blas_nodes, 32)
    this.instance_buffer = make_storage(device, 'webtix.instances', scene.instances, 192)
    this.vertex_buffer = make_storage(device, 'webtix.vertices', pack_vertices(scene.positions, scene.normals), 32)
    this.index_buffer = make_storage(device, 'webtix.indices', scene.indices, 4)
    this.has_scene = true
    this.trace_bind = null // geometry changed → rebind
    this.reset()
  }

  set_environment(hdr: webtix_hdr_image): void {
    const device = this.device
    if (!device) return
    this.env_texture?.destroy()
    this.env_texture = create_hdr_texture(device, hdr)
    this.trace_bind = null
    this.reset()
  }

  /** Restart the queue + accumulation (call on any camera/material/scene change). */
  reset(): void {
    this.needs_clear = true
    this.completed_total = 0
    this.accum_generation = (this.accum_generation + 1) >>> 0
  }

  private ensure_targets(w: number, h: number): void {
    const device = this.device!
    if (this.display && this.width === w && this.height === h) return
    this.task_buffer?.destroy()
    this.accum_buffer?.destroy()
    this.display?.destroy()
    this.width = w
    this.height = h
    const pixels = w * h
    this.task_buffer = device.createBuffer({
      label: 'webtix.tasks', size: pixels * TASK_F32 * 4, usage: GPUBufferUsage.STORAGE,
    })
    this.accum_buffer = device.createBuffer({
      label: 'webtix.accum', size: pixels * 16, usage: GPUBufferUsage.STORAGE,
    })
    this.display = device.createTexture({
      label: 'webtix.display', size: [w, h, 1], format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    this.trace_bind = null
    this.present_bind = null
    this.needs_clear = true
  }

  private ensure_bind_groups(): void {
    const device = this.device!
    if (!this.trace_layout || !this.present_layout) return
    if (this.trace_bind && this.present_bind) return
    this.ensure_environment_texture()
    this.trace_bind = device.createBindGroup({
      label: 'webtix.trace_bind',
      layout: this.trace_layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform! } },
        { binding: 1, resource: { buffer: this.tlas_buffer! } },
        { binding: 2, resource: { buffer: this.blas_buffer! } },
        { binding: 3, resource: { buffer: this.instance_buffer! } },
        { binding: 4, resource: { buffer: this.vertex_buffer! } },
        { binding: 5, resource: { buffer: this.index_buffer! } },
        { binding: 6, resource: { buffer: this.task_buffer! } },
        { binding: 7, resource: { buffer: this.accum_buffer! } },
        { binding: 8, resource: { buffer: this.counter_buffer! } },
        { binding: 9, resource: this.env_texture!.createView() },
        { binding: 10, resource: this.env_sampler! },
      ],
    })
    this.present_bind = device.createBindGroup({
      label: 'webtix.present_bind',
      layout: this.present_layout,
      entries: [
        { binding: 0, resource: { buffer: this.uniform! } },
        { binding: 1, resource: { buffer: this.accum_buffer! } },
      ],
    })
  }

  /** Approximate number of fully-accumulated samples per pixel (averaged). */
  get samples(): number {
    if (this.width === 0 || this.height === 0) return 0
    return Math.floor(this.completed_total / (this.width * this.height))
  }

  /**
   * Advance the wavefront by `runs_per_frame` trace runs, present the current
   * accumulation, and return the rgba8unorm display texture (or null until
   * init/scene/targets are ready).
   */
  render_sample(w: number, h: number, params: webtix_render_params): GPUTexture | null {
    const device = this.device
    if (!device || !this.trace_pipeline || !this.clear_pipeline || !this.present_pipeline || !this.has_scene) return null
    const { w: pw, h: ph } = fit_render_size(device, w, h)
    this.ensure_targets(pw, ph)
    this.ensure_bind_groups()
    if (!this.display || !this.trace_bind || !this.present_bind) return null

    const gx = Math.ceil(pw / WORKGROUP)
    const gy = Math.ceil(ph / WORKGROUP)

    // Each run uses a fresh seed, so it needs its own uniform write + submit.
    for (let run = 0; run < this.runs_per_frame; run++) {
      this.write_uniforms(pw, ph, params)
      this.run_counter = (this.run_counter + 1) >>> 0
      const encoder = device.createCommandEncoder({ label: 'webtix.run' })
      const pass = encoder.beginComputePass({ label: 'webtix.trace_pass' })
      // Clear the queue + accumulator once, immediately before the first trace.
      if (run === 0 && this.needs_clear) {
        pass.setPipeline(this.clear_pipeline)
        pass.setBindGroup(0, this.trace_bind)
        pass.dispatchWorkgroups(gx, gy, 1)
        this.needs_clear = false
      }
      pass.setPipeline(this.trace_pipeline)
      pass.setBindGroup(0, this.trace_bind)
      pass.dispatchWorkgroups(gx, gy, 1)
      pass.end()
      device.queue.submit([encoder.finish()])
    }

    // Tonemap the accumulator → display, and snapshot the finalized counter.
    const encoder = device.createCommandEncoder({ label: 'webtix.present' })
    const present_pass = encoder.beginRenderPass({
      label: 'webtix.present_pass',
      colorAttachments: [{ view: this.display.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
    })
    present_pass.setPipeline(this.present_pipeline)
    present_pass.setBindGroup(0, this.present_bind)
    present_pass.draw(3)
    present_pass.end()
    if (!this.readback_pending && this.counter_buffer && this.counter_staging) {
      encoder.copyBufferToBuffer(this.counter_buffer, 0, this.counter_staging, 0, 4)
    }
    device.queue.submit([encoder.finish()])
    this.read_counter()
    return this.display
  }

  /** Throttled async readback of the finalized-path counter for progress UI. */
  private read_counter(): void {
    const staging = this.counter_staging
    if (this.readback_pending || !staging) return
    this.readback_pending = true
    const gen = this.accum_generation
    staging.mapAsync(GPUMapMode.READ).then(() => {
      const value = new Uint32Array(staging.getMappedRange())[0] ?? 0
      staging.unmap()
      this.readback_pending = false
      // Drop the result if accumulation was reset while this was in flight.
      if (gen === this.accum_generation) this.completed_total = value
    }).catch(() => { this.readback_pending = false })
  }

  private write_uniforms(w: number, h: number, p: webtix_render_params): void {
    const u = this.uniform_data
    const m = p.material
    const fwd = normalize(sub(p.target, p.eye))
    u[0] = p.eye[0]; u[1] = p.eye[1]; u[2] = p.eye[2]; u[3] = 0
    u[4] = fwd[0]; u[5] = fwd[1]; u[6] = fwd[2]; u[7] = 0
    u[8] = 0; u[9] = 1; u[10] = 0; u[11] = 0 // world up
    u[12] = this.run_counter; u[13] = 0; u[14] = Math.random(); u[15] = this.tlas_node_count
    u[16] = m.emission[0]; u[17] = m.emission[1]; u[18] = m.emission[2]; u[19] = m.eta
    u[20] = m.color[0]; u[21] = m.color[1]; u[22] = m.color[2]; u[23] = m.metallic
    u[24] = m.absorption[0]; u[25] = m.absorption[1]; u[26] = m.absorption[2]; u[27] = m.subsurface
    u[28] = m.specular; u[29] = m.roughness; u[30] = m.specular_tint; u[31] = m.anisotropic
    u[32] = m.sheen; u[33] = m.sheen_tint; u[34] = m.clearcoat; u[35] = m.clearcoat_glossiness
    u[36] = m.transmission; u[37] = Math.min(MAX_DEPTH, Math.max(1, p.bounces | 0)); u[38] = p.fov; u[39] = p.env_intensity
    u[40] = p.env_top[0]; u[41] = p.env_top[1]; u[42] = p.env_top[2]; u[43] = 0
    u[44] = p.env_bottom[0]; u[45] = p.env_bottom[1]; u[46] = p.env_bottom[2]; u[47] = 0
    u[48] = w; u[49] = h; u[50] = p.render_mode === 'lighting' ? 1 : 0; u[51] = 0
    this.device!.queue.writeBuffer(this.uniform!, 0, u)
  }

  private ensure_environment_texture(): void {
    const device = this.device
    if (!device || this.env_texture) return
    this.env_texture = create_hdr_texture(device, { width: 1, height: 1, data: new Float32Array([0.8, 0.85, 1.0]) })
    this.env_sampler ??= device.createSampler({
      label: 'webtix.env_sampler',
      addressModeU: 'repeat',
      addressModeV: 'clamp-to-edge',
      magFilter: 'linear',
      minFilter: 'linear',
    })
  }

  dispose(): void {
    this.tlas_buffer?.destroy()
    this.blas_buffer?.destroy()
    this.instance_buffer?.destroy()
    this.vertex_buffer?.destroy()
    this.index_buffer?.destroy()
    this.env_texture?.destroy()
    this.uniform?.destroy()
    this.task_buffer?.destroy()
    this.accum_buffer?.destroy()
    this.counter_buffer?.destroy()
    this.counter_staging?.destroy()
    this.display?.destroy()
    this.task_buffer = null
    this.accum_buffer = null
    this.display = null
    this.env_texture = null
    this.env_sampler = null
    this.has_scene = false
  }
}

function make_storage(device: GPUDevice, label: string, data: Float32Array | Uint32Array, minimum_size = 4): GPUBuffer {
  const buffer = device.createBuffer({ label, size: Math.max(minimum_size, data.byteLength), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(buffer, 0, data as unknown as GPUAllowSharedBufferSource)
  return buffer
}

function pack_vertices(positions: Float32Array, normals: Float32Array): Float32Array {
  const vertex_count = Math.floor(positions.length / 3)
  const out = new Float32Array(vertex_count * 8)
  for (let i = 0; i < vertex_count; i += 1) {
    const si = i * 3
    const di = i * 8
    out[di] = positions[si] ?? 0
    out[di + 1] = positions[si + 1] ?? 0
    out[di + 2] = positions[si + 2] ?? 0
    out[di + 3] = 0
    out[di + 4] = normals[si] ?? 0
    out[di + 5] = normals[si + 1] ?? 1
    out[di + 6] = normals[si + 2] ?? 0
    out[di + 7] = 0
  }
  return out
}

function create_hdr_texture(device: GPUDevice, hdr: webtix_hdr_image): GPUTexture {
  const width = Math.max(1, hdr.width | 0)
  const height = Math.max(1, hdr.height | 0)
  const texture = device.createTexture({
    label: 'webtix.env_texture',
    size: [width, height, 1],
    format: 'rgba16float',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  })
  const row_bytes = width * 8
  const padded_row_bytes = align(row_bytes, 256)
  const half = new Uint16Array((padded_row_bytes / 2) * height)
  for (let y = 0; y < height; y++) {
    const row = (padded_row_bytes / 2) * y
    for (let x = 0; x < width; x++) {
      const si = (y * width + x) * 3
      const di = row + x * 4
      half[di] = float_to_half(hdr.data[si] ?? 0)
      half[di + 1] = float_to_half(hdr.data[si + 1] ?? 0)
      half[di + 2] = float_to_half(hdr.data[si + 2] ?? 0)
      half[di + 3] = float_to_half(1)
    }
  }
  device.queue.writeTexture(
    { texture },
    new Uint8Array(half.buffer),
    { bytesPerRow: padded_row_bytes, rowsPerImage: height },
    { width, height, depthOrArrayLayers: 1 },
  )
  return texture
}

function align(value: number, alignment: number): number {
  return Math.ceil(value / alignment) * alignment
}

function float_to_half(value: number): number {
  if (!Number.isFinite(value)) return value < 0 ? 0xfc00 : 0x7c00
  const f32 = new Float32Array(1)
  const u32 = new Uint32Array(f32.buffer)
  f32[0] = value
  const x = u32[0]!
  const sign = (x >>> 16) & 0x8000
  let mantissa = x & 0x7fffff
  let exp = (x >>> 23) & 0xff

  if (exp === 0xff) return sign | (mantissa ? 0x7e00 : 0x7c00)
  exp = exp - 127 + 15
  if (exp >= 0x1f) return sign | 0x7c00
  if (exp <= 0) {
    if (exp < -10) return sign
    mantissa = (mantissa | 0x800000) >>> (1 - exp)
    return sign | ((mantissa + 0x1000) >>> 13)
  }
  return sign | (exp << 10) | ((mantissa + 0x1000) >>> 13)
}

function fit_render_size(device: GPUDevice, w: number, h: number): { w: number; h: number } {
  let rw = Math.max(1, Math.floor(w))
  let rh = Math.max(1, Math.floor(h))

  const maxDimension = Math.max(1, device.limits.maxTextureDimension2D)
  if (rw > maxDimension || rh > maxDimension) {
    const scale = Math.min(maxDimension / rw, maxDimension / rh)
    rw = Math.max(1, Math.floor(rw * scale))
    rh = Math.max(1, Math.floor(rh * scale))
  }

  const maxStorageBytes = Math.max(1, Math.min(
    device.limits.maxBufferSize,
    device.limits.maxStorageBufferBindingSize,
  ))
  const maxPixels = Math.max(1, Math.floor(maxStorageBytes / TASK_BYTES))
  if (rw * rh > maxPixels) {
    const scale = Math.sqrt(maxPixels / (rw * rh))
    rw = Math.max(1, Math.floor(rw * scale))
    rh = Math.max(1, Math.floor(rh * scale))
    while (rw * rh > maxPixels) {
      if (rw >= rh) rw--
      else rh--
    }
  }

  return { w: rw, h: rh }
}

function sub(a: [number, number, number], b: [number, number, number]): [number, number, number] {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
}

function normalize(a: [number, number, number]): [number, number, number] {
  const l = Math.hypot(a[0], a[1], a[2]) || 1
  return [a[0] / l, a[1] / l, a[2] / l]
}

// ============================================================================
// WGSL — wavefront path tracer (one bounce per run over a per-pixel ray queue).
// ============================================================================

const TRACE_WGSL = /* wgsl */ `
const PI: f32 = 3.141592653589793;
const PI2: f32 = 6.283185307179586;
const PI_INV: f32 = 0.3183098861837907;
const EPS: f32 = 1e-4;
const MAX_T: f32 = 1e10;

struct Uniforms {
  cam_pos: vec4f,
  cam_fwd: vec4f,
  cam_up: vec4f,
  frame: vec4f,     // run_counter, _, seed, tlas_node_count
  emission: vec4f,  // rgb, w = eta
  color: vec4f,     // rgb, w = metallic
  absorption: vec4f,// rgb, w = subsurface
  p0: vec4f,        // specular, roughness, specular_tint, anisotropic
  p1: vec4f,        // sheen, sheen_tint, clearcoat, clearcoat_gloss
  p2: vec4f,        // transmission, depth, fov, env_intensity
  env_top: vec4f,
  env_bot: vec4f,
  res: vec4f,       // width, height, render_mode (0 = ao, 1 = lighting)
}

struct bvh_node {
  bmin: vec3f,
  count: f32,
  bmax: vec3f,
  prim: f32,
}

struct Instance {
  wf0: vec4f,
  wf1: vec4f,
  wf2: vec4f,
  wf3: vec4f,
  lf0: vec4f,
  lf1: vec4f,
  lf2: vec4f,
  lf3: vec4f,
  nf0: vec4f,
  nf1: vec4f,
  nf2: vec4f,
  info: vec4f, // kind, blas_start, blas_count, _
}

// One ray "task" per pixel. Packed into four vec4 for 16-byte alignment:
//   o = origin.xyz,      o.w = bounce (as f32)
//   d = direction.xyz,   d.w = alive flag (0 = needs a fresh primary)
//   t = throughput.xyz
//   r = radiance.xyz (accumulated along the current path)
struct RayTask {
  o: vec4f,
  d: vec4f,
  t: vec4f,
  r: vec4f,
}

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var<storage, read> tlas: array<bvh_node>;
@group(0) @binding(2) var<storage, read> blas: array<bvh_node>;
@group(0) @binding(3) var<storage, read> instances: array<Instance>;
@group(0) @binding(4) var<storage, read> vertices: array<vec4f>;
@group(0) @binding(5) var<storage, read> indices: array<u32>;
@group(0) @binding(6) var<storage, read_write> tasks: array<RayTask>;
@group(0) @binding(7) var<storage, read_write> accum: array<vec4f>;
@group(0) @binding(8) var<storage, read_write> counter: atomic<u32>;
@group(0) @binding(9) var env_tex: texture_2d<f32>;
@group(0) @binding(10) var env_samp: sampler;

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
  return vertices[i * 2u].xyz;
}
fn fetch_nrm(i: u32) -> vec3f {
  return vertices[i * 2u + 1u].xyz;
}

fn row_point(r: vec4f, p: vec3f) -> f32 {
  return dot(r, vec4f(p, 1.0));
}

fn row_vec(r: vec4f, v: vec3f) -> f32 {
  return dot(r.xyz, v);
}

fn world_to_local_point(inst: Instance, p: vec3f) -> vec3f {
  return vec3f(row_point(inst.lf0, p), row_point(inst.lf1, p), row_point(inst.lf2, p));
}

fn world_to_local_vec(inst: Instance, v: vec3f) -> vec3f {
  return vec3f(row_vec(inst.lf0, v), row_vec(inst.lf1, v), row_vec(inst.lf2, v));
}

fn local_to_world_point(inst: Instance, p: vec3f) -> vec3f {
  return vec3f(row_point(inst.wf0, p), row_point(inst.wf1, p), row_point(inst.wf2, p));
}

fn local_to_world_normal(inst: Instance, n: vec3f) -> vec3f {
  return normalize(vec3f(row_vec(inst.nf0, n), row_vec(inst.nf1, n), row_vec(inst.nf2, n)));
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

struct LocalHit {
  t: f32,
  position: vec3f,
  normal: vec3f,
  hit: bool,
}

fn miss_local() -> LocalHit {
  var h: LocalHit;
  h.hit = false;
  h.t = MAX_T;
  h.position = vec3f(0.0);
  h.normal = vec3f(0.0, 1.0, 0.0);
  return h;
}

fn local_to_world_hit(inst: Instance, h: LocalHit) -> Hit {
  var out: Hit;
  out.hit = h.hit;
  out.t = h.t;
  out.position = local_to_world_point(inst, h.position);
  out.normal = local_to_world_normal(inst, h.normal);
  return out;
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

fn sphere_intersect(ro: vec3f, rd: vec3f, best: f32) -> LocalHit {
  var result = miss_local();
  let a = dot(rd, rd);
  let b = dot(ro, rd);
  let c = dot(ro, ro) - 1.0;
  let disc = b * b - a * c;
  if (disc < 0.0 || a <= 0.0) { return result; }
  let s = sqrt(disc);
  var t = (-b - s) / a;
  if (t <= EPS) { t = (-b + s) / a; }
  if (t > EPS && t < best) {
    result.hit = true;
    result.t = t;
    result.position = ro + rd * t;
    result.normal = normalize(result.position);
  }
  return result;
}

fn local_box_normal(tn: vec3f, tf: vec3f, rd: vec3f, use_far: bool) -> vec3f {
  if (!use_far) {
    if (tn.x >= tn.y && tn.x >= tn.z) { return vec3f(select(1.0, -1.0, rd.x > 0.0), 0.0, 0.0); }
    if (tn.y >= tn.z) { return vec3f(0.0, select(1.0, -1.0, rd.y > 0.0), 0.0); }
    return vec3f(0.0, 0.0, select(1.0, -1.0, rd.z > 0.0));
  }
  if (tf.x <= tf.y && tf.x <= tf.z) { return vec3f(select(-1.0, 1.0, rd.x > 0.0), 0.0, 0.0); }
  if (tf.y <= tf.z) { return vec3f(0.0, select(-1.0, 1.0, rd.y > 0.0), 0.0); }
  return vec3f(0.0, 0.0, select(-1.0, 1.0, rd.z > 0.0));
}

fn box_primitive_intersect(ro: vec3f, rd: vec3f, best: f32) -> LocalHit {
  var result = miss_local();
  let inv_dir = 1.0 / rd;
  let t0 = (vec3f(-1.0) - ro) * inv_dir;
  let t1 = (vec3f(1.0) - ro) * inv_dir;
  let tn = min(t0, t1);
  let tf = max(t0, t1);
  let t_near = max(tn.x, max(tn.y, tn.z));
  let t_far = min(tf.x, min(tf.y, tf.z));
  if (t_far <= EPS || t_near > t_far) { return result; }
  let use_far = t_near <= EPS;
  let t = select(t_near, t_far, use_far);
  if (t > EPS && t < best) {
    result.hit = true;
    result.t = t;
    result.position = ro + rd * t;
    result.normal = local_box_normal(tn, tf, rd, use_far);
  }
  return result;
}

fn plane_intersect(ro: vec3f, rd: vec3f, best: f32) -> LocalHit {
  var result = miss_local();
  if (abs(rd.y) < 1e-8) { return result; }
  let t = -ro.y / rd.y;
  let p = ro + rd * t;
  if (t > EPS && t < best && abs(p.x) <= 1.0 && abs(p.z) <= 1.0) {
    result.hit = true;
    result.t = t;
    result.position = p;
    result.normal = vec3f(0.0, 1.0, 0.0);
  }
  return result;
}

// Stackless BLAS walk for a single mesh instance.
fn trace_mesh_blas(inst: Instance, ro: vec3f, rd: vec3f, best_in: f32) -> LocalHit {
  var result = miss_local();
  let inv_dir = 1.0 / rd;
  let start = i32(inst.info.y);
  let n = start + i32(inst.info.z);
  var best = best_in;
  var found = false;
  var best_n0 = vec3f(0.0);
  var best_n1 = vec3f(0.0);
  var best_n2 = vec3f(0.0);
  var best_u = 0.0;
  var best_v = 0.0;
  var i = start;
  loop {
    if (i >= n) { break; }
    let node = blas[i];
    let t = box_intersect(node.bmin, node.bmax, ro, inv_dir);
    if (t >= 0.0 && t < best) {
      if (node.count < 0.5) {
        // leaf — intersect its triangle
        let pi = u32(node.prim) * 3u;
        let i0 = indices[pi]; let i1 = indices[pi + 1u]; let i2 = indices[pi + 2u];
        let hit = tri_intersect(fetch_pos(i0), fetch_pos(i1), fetch_pos(i2), ro, rd);
        if (hit.x > 0.0 && hit.x < best) {
          best = hit.x;
          found = true;
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
  if (found) {
    result.hit = true;
    result.t = best;
    result.position = ro + rd * best;
    result.normal = normalize(best_n0 * (1.0 - best_u - best_v) + best_n1 * best_u + best_n2 * best_v);
  }
  return result;
}

fn trace_instance(inst: Instance, ro: vec3f, rd: vec3f, best: f32) -> Hit {
  let ro_l = world_to_local_point(inst, ro);
  let rd_l = world_to_local_vec(inst, rd);
  var local = miss_local();
  let kind = i32(inst.info.x);
  if (kind == 0) {
    local = sphere_intersect(ro_l, rd_l, best);
  } else if (kind == 1) {
    local = box_primitive_intersect(ro_l, rd_l, best);
  } else if (kind == 2) {
    local = plane_intersect(ro_l, rd_l, best);
  } else {
    local = trace_mesh_blas(inst, ro_l, rd_l, best);
  }
  return local_to_world_hit(inst, local);
}

// Stackless TLAS walk: descend on a box hit, then intersect the leaf instance.
fn trace(ro: vec3f, rd: vec3f) -> Hit {
  var result: Hit;
  result.hit = false;
  result.t = MAX_T;
  result.position = vec3f(0.0);
  result.normal = vec3f(0.0, 1.0, 0.0);
  let inv_dir = 1.0 / rd;
  let n = i32(U.frame.w);
  var best = MAX_T;
  var i = 0;
  loop {
    if (i >= n) { break; }
    let node = tlas[i];
    let t = box_intersect(node.bmin, node.bmax, ro, inv_dir);
    if (t >= 0.0 && t < best) {
      if (node.count < 0.5) {
        let hit = trace_instance(instances[u32(node.prim)], ro, rd, best);
        if (hit.hit && hit.t < best) {
          best = hit.t;
          result = hit;
        }
      }
      i = i + 1;
    } else {
      if (node.count >= 0.5) { i = i + i32(node.count) + 1; } else { i = i + 1; }
    }
  }
  return result;
}

// --- environment -------------------------------------------------------------
fn sample_procedural_environment(dir: vec3f) -> vec3f {
  let t = clamp(dir.y * 0.5 + 0.5, 0.0, 1.0);
  let sky = mix(U.env_bot.xyz, U.env_top.xyz, t);
  // soft sun towards (0.4, 0.8, 0.3)
  let sun = normalize(vec3f(0.4, 0.8, 0.3));
  let s = pow(max(dot(dir, sun), 0.0), 64.0);
  return (sky + vec3f(1.0, 0.9, 0.7) * s * 1.5) * U.p2.w;
}

fn sample_hdr_environment(dir: vec3f) -> vec3f {
  let d = normalize(dir);
  let u = fract(atan2(d.z, d.x) / PI2 + 0.5);
  let v = acos(clamp(d.y, -1.0, 1.0)) * PI_INV;
  return textureSampleLevel(env_tex, env_samp, vec2f(u, v), 0.0).rgb * U.p2.w;
}

fn sample_environment(dir: vec3f) -> vec3f {
  if (U.res.z > 0.5) {
    return sample_hdr_environment(dir);
  }
  return sample_procedural_environment(dir);
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
      let fl = fresnel_schlick(n_dot_l);
      let fv = fresnel_schlick(n_dot_v);
      let f0 = 0.5 + 2.0 * l_dot_h * l_dot_h * m.roughness;
      let fd = mix(1.0, f0, fl) * mix(1.0, f0, fv);
      let gs = ggx_smith(n_dot_v, a) * ggx_smith(n_dot_l, a);
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

// Build the jittered primary ray for a pixel (the start of a new sample).
fn primary_ray(px: vec2f, w: f32, h: f32) -> RayTask {
  let fwd = U.cam_fwd.xyz;
  let x_axis = normalize(cross(fwd, U.cam_up.xyz));
  let y_axis = normalize(cross(x_axis, fwd));
  let aspect = w / max(1.0, h);
  let ndc = (px + vec2f(rand(), rand())) / vec2f(w, h) * 2.0 - vec2f(1.0);
  let scale = tan(U.p2.z * 0.5);
  let dir = normalize(fwd + x_axis * ndc.x * scale * aspect - y_axis * ndc.y * scale);
  var task: RayTask;
  task.o = vec4f(U.cam_pos.xyz, 0.0);  // bounce 0
  task.d = vec4f(dir, 1.0);            // alive
  task.t = vec4f(1.0, 1.0, 1.0, 0.0);  // throughput = 1
  task.r = vec4f(0.0);                 // radiance = 0
  return task;
}

// Reset the queue + accumulator (one invocation per pixel).
@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}, 1)
fn cs_clear(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(U.res.x);
  let h = u32(U.res.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let pixel = gid.x + gid.y * w;
  accum[pixel] = vec4f(0.0);
  var task: RayTask;       // alive = 0 → a fresh primary is spawned on first trace
  task.o = vec4f(0.0);
  task.d = vec4f(0.0);
  task.t = vec4f(0.0);
  task.r = vec4f(0.0);
  tasks[pixel] = task;
  if (pixel == 0u) { atomicStore(&counter, 0u); }
}

// Trace each live ray exactly once: shade it, then write the continuation back
// into the same slot or finalize the path into the accumulator.
@compute @workgroup_size(${WORKGROUP}, ${WORKGROUP}, 1)
fn cs_trace(@builtin(global_invocation_id) gid: vec3u) {
  let w = u32(U.res.x);
  let h = u32(U.res.y);
  if (gid.x >= w || gid.y >= h) { return; }
  let pixel = gid.x + gid.y * w;
  // Seed per pixel + run so every trace draws fresh, decorrelated randoms.
  rng_state = pcg(pixel * 9781u + u32(U.frame.x) * 26699u + u32(U.frame.z * 4294967295.0));

  var task = tasks[pixel];
  // A dead slot starts a new sample with a fresh jittered primary ray.
  if (task.d.w < 0.5) {
    task = primary_ray(vec2f(f32(gid.x), f32(gid.y)), f32(w), f32(h));
  }

  var origin = task.o.xyz;
  var dir = task.d.xyz;
  var bounce = u32(task.o.w);
  var throughput = task.t.xyz;
  var radiance = task.r.xyz;

  let m = get_material();
  let depth = u32(U.p2.y);
  var alive = true;

  let hit = trace(origin, dir);
  if (!hit.hit) {
    radiance = radiance + throughput * sample_environment(dir);
    alive = false;
  } else {
    let normal = hit.normal;
    let view = -dir;
    radiance = radiance + throughput * m.emission;
    let samp = disney_sample(m, normal, view);
    if (samp.pdf <= 0.0) {
      alive = false;
    } else {
      let f = disney_eval(m, normal, view, samp.light);
      throughput = clamp(throughput * f * abs(dot(normal, samp.light)) / samp.pdf, vec3f(0.0), vec3f(1.0));
      bounce = bounce + 1u;
      if (bounce >= depth) {
        alive = false;
      } else if (bounce > 3u) {
        // Russian roulette after a few bounces keeps deep paths cheap.
        let q = max(throughput.x, max(throughput.y, throughput.z));
        if (rand() > q) {
          alive = false;
        } else {
          throughput = throughput / max(EPS, q);
        }
      }
      if (alive) {
        origin = hit.position + face_normal(normal, samp.light) * EPS;
        dir = samp.light;
      }
    }
  }

  if (alive) {
    // Park the continuation ray for a later run/frame.
    task.o = vec4f(origin, f32(bounce));
    task.d = vec4f(dir, 1.0);
    task.t = vec4f(throughput, 0.0);
    task.r = vec4f(radiance, 0.0);
    tasks[pixel] = task;
  } else {
    // Path complete — fold its radiance into the running per-pixel average.
    let c = min(radiance, vec3f(1e3));
    accum[pixel] = accum[pixel] + vec4f(c, 1.0);
    task.d.w = 0.0; // mark dead → respawn a primary next visit
    tasks[pixel] = task;
    atomicAdd(&counter, 1u);
  }
}
`

const PRESENT_WGSL = /* wgsl */ `
struct Uniforms {
  cam_pos: vec4f,
  cam_fwd: vec4f,
  cam_up: vec4f,
  frame: vec4f,
  emission: vec4f,
  color: vec4f,
  absorption: vec4f,
  p0: vec4f,
  p1: vec4f,
  p2: vec4f,
  env_top: vec4f,
  env_bot: vec4f,
  res: vec4f,
}

@group(0) @binding(0) var<uniform> U: Uniforms;
@group(0) @binding(1) var<storage, read> accum: array<vec4f>;

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
  let w = u32(U.res.x);
  let px = vec2u(u32(in.pos.x), u32(in.pos.y));
  let pixel = px.x + px.y * w;
  let a = accum[pixel];
  let hdr = a.xyz / max(1.0, a.w);
  return vec4f(linear_to_srgb(aces(hdr)), 1.0);
}
`
