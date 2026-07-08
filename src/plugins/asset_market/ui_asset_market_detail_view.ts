// asset_market — detail-view GPU rasterizer, cameras, picking and statistics.
//
// The Asset Detail panel (ui_asset_market_detail) inspects one purchased scene
// as a set of named parts. This module owns everything below the widgets:
// a small WebGPU renderer that draws every part into an offscreen texture in
// one of four raster modes (shaded / wireframe / normal / uv — the fifth mode,
// raytrace, is served by the webtix tracer), the free-fly camera type that
// complements the shared orbit camera, a CPU ray picker used to select parts
// by clicking the viewport, and the per-part mesh statistics (vertex / index /
// triangle / face / edge counts) the sidebar reports.

import type { scene_geometry } from './ui_asset_market_draco'

export type asset_detail_vec3 = [number, number, number]

export interface asset_detail_bounds {
  min: asset_detail_vec3
  max: asset_detail_vec3
}

/** What the host hands the detail view for each named piece of the scene. */
export interface asset_detail_part_input {
  name: string
  geometry: scene_geometry
  /**
   * Authored polygon face count (e.g. the quad count of a parametric surface).
   * When omitted, faces are counted by merging coplanar edge-adjacent
   * triangles — exact for flat geometry, and equal to the triangle count for
   * smooth surfaces where every triangle really is its own face.
   */
  face_count?: number
}

export interface asset_detail_stats {
  vertex_count: number
  index_count: number
  triangle_count: number
  face_count: number
  edge_count: number
}

/** A part after ingestion: geometry plus everything derived from it once. */
export interface asset_detail_part {
  name: string
  geometry: scene_geometry
  stats: asset_detail_stats
  bounds: asset_detail_bounds
}

// --- statistics ---------------------------------------------------------------

/** Union-find over triangles; used to merge coplanar neighbours into faces. */
function find_root(parent: Int32Array, i: number): number {
  let root = i
  while (parent[root]! !== root) root = parent[root]!
  while (parent[i]! !== root) {
    const next = parent[i]!
    parent[i] = root
    i = next
  }
  return root
}

function triangle_normal(positions: Float32Array, indices: Uint32Array, tri: number): asset_detail_vec3 {
  const a = indices[tri * 3]! * 3, b = indices[tri * 3 + 1]! * 3, c = indices[tri * 3 + 2]! * 3
  const abx = positions[b]! - positions[a]!, aby = positions[b + 1]! - positions[a + 1]!, abz = positions[b + 2]! - positions[a + 2]!
  const acx = positions[c]! - positions[a]!, acy = positions[c + 1]! - positions[a + 1]!, acz = positions[c + 2]! - positions[a + 2]!
  const nx = aby * acz - abz * acy
  const ny = abz * acx - abx * acz
  const nz = abx * acy - aby * acx
  const len = Math.hypot(nx, ny, nz) || 1
  return [nx / len, ny / len, nz / len]
}

/**
 * Count unique undirected edges and polygon faces. Faces merge edge-adjacent
 * triangles whose normals agree to within a tight tolerance, so a triangulated
 * quad grid reports its quads while a curved shell keeps one face per triangle.
 */
function count_edges_and_faces(geo: scene_geometry): { edges: number; faces: number } {
  const triangle_count = (geo.indices.length / 3) | 0
  const edge_first_tri = new Map<number, number>()
  const parent = new Int32Array(triangle_count)
  for (let t = 0; t < triangle_count; t += 1) parent[t] = t
  const normals: asset_detail_vec3[] = new Array(triangle_count)
  for (let t = 0; t < triangle_count; t += 1) normals[t] = triangle_normal(geo.positions, geo.indices, t)

  const COPLANAR = 0.99995
  let edge_count = 0
  for (let t = 0; t < triangle_count; t += 1) {
    for (let e = 0; e < 3; e += 1) {
      const i0 = geo.indices[t * 3 + e]!
      const i1 = geo.indices[t * 3 + ((e + 1) % 3)]!
      const key = i0 < i1 ? i0 * 0x100000000 + i1 : i1 * 0x100000000 + i0
      const other = edge_first_tri.get(key)
      if (other === undefined) {
        edge_first_tri.set(key, t)
        edge_count += 1
        continue
      }
      const na = normals[t]!, nb = normals[other]!
      if (na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2] >= COPLANAR) {
        const ra = find_root(parent, t)
        const rb = find_root(parent, other)
        if (ra !== rb) parent[ra] = rb
      }
    }
  }
  let faces = 0
  for (let t = 0; t < triangle_count; t += 1) if (find_root(parent, t) === t) faces += 1
  return { edges: edge_count, faces }
}

export function compute_asset_detail_stats(geo: scene_geometry, authored_face_count?: number): asset_detail_stats {
  const { edges, faces } = count_edges_and_faces(geo)
  return {
    vertex_count: (geo.positions.length / 3) | 0,
    index_count: geo.indices.length,
    triangle_count: (geo.indices.length / 3) | 0,
    face_count: authored_face_count ?? faces,
    edge_count: edges,
  }
}

export function sum_asset_detail_stats(parts: asset_detail_part[]): asset_detail_stats {
  const total: asset_detail_stats = { vertex_count: 0, index_count: 0, triangle_count: 0, face_count: 0, edge_count: 0 }
  for (const part of parts) {
    total.vertex_count += part.stats.vertex_count
    total.index_count += part.stats.index_count
    total.triangle_count += part.stats.triangle_count
    total.face_count += part.stats.face_count
    total.edge_count += part.stats.edge_count
  }
  return total
}

export function compute_geometry_bounds(geo: scene_geometry): asset_detail_bounds {
  const min: asset_detail_vec3 = [Infinity, Infinity, Infinity]
  const max: asset_detail_vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < geo.positions.length; i += 3) {
    for (let c = 0; c < 3; c += 1) {
      const v = geo.positions[i + c]!
      if (v < min[c]!) min[c] = v
      if (v > max[c]!) max[c] = v
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] }
  return { min, max }
}

export function union_bounds(all: asset_detail_bounds[]): asset_detail_bounds {
  const min: asset_detail_vec3 = [Infinity, Infinity, Infinity]
  const max: asset_detail_vec3 = [-Infinity, -Infinity, -Infinity]
  for (const b of all) {
    for (let c = 0; c < 3; c += 1) {
      if (b.min[c]! < min[c]!) min[c] = b.min[c]!
      if (b.max[c]! > max[c]!) max[c] = b.max[c]!
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] }
  return { min, max }
}

/** Smooth per-vertex normals for geometry that shipped without any. */
export function ensure_geometry_normals(geo: scene_geometry): Float32Array {
  if (geo.normals && geo.normals.length === geo.positions.length) return geo.normals
  const normals = new Float32Array(geo.positions.length)
  const triangle_count = (geo.indices.length / 3) | 0
  for (let t = 0; t < triangle_count; t += 1) {
    const n = triangle_normal(geo.positions, geo.indices, t)
    for (let e = 0; e < 3; e += 1) {
      const v = geo.indices[t * 3 + e]! * 3
      normals[v] += n[0]
      normals[v + 1] += n[1]
      normals[v + 2] += n[2]
    }
  }
  for (let i = 0; i < normals.length; i += 3) {
    const len = Math.hypot(normals[i]!, normals[i + 1]!, normals[i + 2]!) || 1
    normals[i] /= len
    normals[i + 1] /= len
    normals[i + 2] /= len
  }
  return normals
}

// --- free-fly camera ----------------------------------------------------------

export interface asset_detail_free_camera {
  position: asset_detail_vec3
  yaw: number
  pitch: number
  fov: number
}

export function create_asset_detail_free_camera(): asset_detail_free_camera {
  return { position: [0, 0, 5], yaw: Math.PI, pitch: 0, fov: Math.PI / 4 }
}

export function free_camera_forward(camera: asset_detail_free_camera): asset_detail_vec3 {
  const cp = Math.cos(camera.pitch)
  return [cp * Math.sin(camera.yaw), Math.sin(camera.pitch), cp * Math.cos(camera.yaw)]
}

export function free_camera_basis(camera: asset_detail_free_camera): { forward: asset_detail_vec3; right: asset_detail_vec3; up: asset_detail_vec3 } {
  const forward = free_camera_forward(camera)
  let rx = forward[2], ry = 0, rz = -forward[0]
  const rl = Math.hypot(rx, ry, rz) || 1
  rx /= rl; rz /= rl
  const right: asset_detail_vec3 = [rx, ry, rz]
  const up: asset_detail_vec3 = [
    right[1] * forward[2] - right[2] * forward[1],
    right[2] * forward[0] - right[0] * forward[2],
    right[0] * forward[1] - right[1] * forward[0],
  ]
  return { forward, right, up }
}

// --- ray picking ----------------------------------------------------------------

export interface asset_detail_ray {
  origin: asset_detail_vec3
  dir: asset_detail_vec3
}

function ray_hits_bounds(ray: asset_detail_ray, bounds: asset_detail_bounds): boolean {
  let t_min = -Infinity
  let t_max = Infinity
  for (let c = 0; c < 3; c += 1) {
    const o = ray.origin[c]!, d = ray.dir[c]!
    if (Math.abs(d) < 1e-12) {
      if (o < bounds.min[c]! || o > bounds.max[c]!) return false
      continue
    }
    const inv = 1 / d
    let t0 = (bounds.min[c]! - o) * inv
    let t1 = (bounds.max[c]! - o) * inv
    if (t0 > t1) { const tmp = t0; t0 = t1; t1 = tmp }
    if (t0 > t_min) t_min = t0
    if (t1 < t_max) t_max = t1
    if (t_min > t_max) return false
  }
  return t_max >= Math.max(0, t_min)
}

/** Möller–Trumbore over one part; returns nearest hit distance or Infinity. */
function ray_part_distance(ray: asset_detail_ray, geo: scene_geometry): number {
  const [ox, oy, oz] = ray.origin
  const [dx, dy, dz] = ray.dir
  let nearest = Infinity
  const pos = geo.positions, idx = geo.indices
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3
    const e1x = pos[b]! - pos[a]!, e1y = pos[b + 1]! - pos[a + 1]!, e1z = pos[b + 2]! - pos[a + 2]!
    const e2x = pos[c]! - pos[a]!, e2y = pos[c + 1]! - pos[a + 1]!, e2z = pos[c + 2]! - pos[a + 2]!
    const px = dy * e2z - dz * e2y
    const py = dz * e2x - dx * e2z
    const pz = dx * e2y - dy * e2x
    const det = e1x * px + e1y * py + e1z * pz
    if (Math.abs(det) < 1e-12) continue
    const inv = 1 / det
    const tx = ox - pos[a]!, ty = oy - pos[a + 1]!, tz = oz - pos[a + 2]!
    const u = (tx * px + ty * py + tz * pz) * inv
    if (u < 0 || u > 1) continue
    const qx = ty * e1z - tz * e1y
    const qy = tz * e1x - tx * e1z
    const qz = tx * e1y - ty * e1x
    const v = (dx * qx + dy * qy + dz * qz) * inv
    if (v < 0 || u + v > 1) continue
    const dist = (e2x * qx + e2y * qy + e2z * qz) * inv
    if (dist > 1e-6 && dist < nearest) nearest = dist
  }
  return nearest
}

/** Nearest part hit by the ray, or -1 when the ray misses every part. */
export function asset_detail_pick(parts: asset_detail_part[], ray: asset_detail_ray): number {
  let best = -1
  let best_t = Infinity
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!
    if (!ray_hits_bounds(ray, part.bounds)) continue
    const t = ray_part_distance(ray, part.geometry)
    if (t < best_t) {
      best_t = t
      best = i
    }
  }
  return best
}

// --- column-major mat4 helpers --------------------------------------------------

function mat4_perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fov / 2)
  const out = new Float32Array(16)
  out[0] = f / Math.max(1e-6, aspect)
  out[5] = f
  out[10] = far / (near - far)
  out[11] = -1
  out[14] = (near * far) / (near - far)
  return out
}

function mat4_look_at(eye: asset_detail_vec3, target: asset_detail_vec3, up: asset_detail_vec3): Float32Array {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2]
  let len = Math.hypot(zx, zy, zz) || 1
  zx /= len; zy /= len; zz /= len
  let xx = up[1] * zz - up[2] * zy
  let xy = up[2] * zx - up[0] * zz
  let xz = up[0] * zy - up[1] * zx
  len = Math.hypot(xx, xy, xz) || 1
  xx /= len; xy /= len; xz /= len
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  const out = new Float32Array(16)
  out[0] = xx; out[1] = yx; out[2] = zx
  out[4] = xy; out[5] = yy; out[6] = zy
  out[8] = xz; out[9] = yz; out[10] = zz
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2])
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2])
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2])
  out[15] = 1
  return out
}

function mat4_multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16)
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[col * 4 + k]!
      out[col * 4 + row] = sum
    }
  }
  return out
}

// --- GPU rasterizer --------------------------------------------------------------

/** Raster modes drawn by this class; 'raytrace' lives in the webtix tracer. */
export type asset_detail_raster_mode = 'shaded' | 'wireframe' | 'normal' | 'uv'

const RASTER_MODE_INDEX: Record<asset_detail_raster_mode, number> = { shaded: 0, wireframe: 1, normal: 2, uv: 3 }

const detail_shader = /* wgsl */ `
struct detail_uniforms {
  mvp: mat4x4f,
  color: vec4f,
  // xyz = light direction, w = raster mode (0 shaded, 1 flat, 2 normal, 3 uv).
  light_dir: vec4f,
}
@group(0) @binding(0) var<uniform> u: detail_uniforms;

struct v_out {
  @builtin(position) position: vec4f,
  @location(0) normal: vec3f,
  @location(1) uv: vec2f,
}

@vertex
fn vs_main(@location(0) pos: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f) -> v_out {
  var out: v_out;
  out.position = u.mvp * vec4f(pos, 1.0);
  out.normal = normal;
  out.uv = uv;
  return out;
}

@fragment
fn fs_main(in: v_out) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let mode = u.light_dir.w;
  if (mode > 2.5) {
    // UV debug: checker over a red/green uv gradient, faintly lit.
    let cells = 16.0;
    let checker = abs((floor(in.uv.x * cells) + floor(in.uv.y * cells)) % 2.0);
    let grad = vec3f(fract(in.uv), 0.25);
    let base = mix(grad * 0.55, grad, checker);
    let l = normalize(u.light_dir.xyz);
    let lit = base * (0.55 + max(dot(n, l), 0.0) * 0.45);
    return vec4f(lit, 1.0);
  }
  if (mode > 1.5) {
    // Normal preview: world-space normals mapped to RGB.
    return vec4f(n * 0.5 + vec3f(0.5), 1.0);
  }
  let l = normalize(u.light_dir.xyz);
  let diffuse = max(dot(n, l), 0.0);
  if (mode > 0.5) {
    // Wireframe backdrop: dark occluding fill so hidden lines stay hidden.
    let dim = u.color.rgb * (0.10 + diffuse * 0.14);
    return vec4f(dim, 1.0);
  }
  let fill = max(dot(n, -l), 0.0) * 0.22;
  let lit = u.color.rgb * (0.24 + diffuse * 0.8 + fill);
  return vec4f(lit, 1.0);
}

@fragment
fn fs_line(in: v_out) -> @location(0) vec4f {
  return u.color;
}
`

const UNIFORM_BYTES = 96 // mat4 + 2×vec4

interface detail_gpu_part {
  vertex_buffer: GPUBuffer
  index_buffer: GPUBuffer
  index_count: number
  edge_buffer: GPUBuffer | null
  edge_count: number
  fill_uniform: GPUBuffer
  fill_bind: GPUBindGroup
  line_uniform: GPUBuffer
  line_bind: GPUBindGroup
}

export interface asset_detail_camera_frame {
  eye: asset_detail_vec3
  target: asset_detail_vec3
  up: asset_detail_vec3
  fov: number
  near: number
  far: number
}

/** Distinct base colors so neighbouring parts read apart in the viewport. */
const PART_PALETTE: asset_detail_vec3[] = [
  [0.62, 0.66, 0.72],
  [0.42, 0.60, 0.82],
  [0.44, 0.72, 0.52],
  [0.82, 0.64, 0.36],
  [0.78, 0.46, 0.58],
  [0.58, 0.50, 0.80],
  [0.36, 0.68, 0.68],
  [0.72, 0.70, 0.44],
]

export function asset_detail_part_color(index: number): asset_detail_vec3 {
  return PART_PALETTE[index % PART_PALETTE.length]!
}

/**
 * Per-part scene rasterizer sharing the ui_renderer's GPUDevice. Parts upload
 * once; each render writes an offscreen rgba8 texture the panel composites via
 * `register_external_texture` / `draw_texture_round_rect`.
 */
export class asset_detail_gpu_view {
  private device: GPUDevice | null = null
  private fill_pipeline: GPURenderPipeline | null = null
  private line_pipeline: GPURenderPipeline | null = null
  private bind_layout: GPUBindGroupLayout | null = null
  private parts: detail_gpu_part[] = []
  private color_target: GPUTexture | null = null
  private depth_target: GPUTexture | null = null

  init(device: GPUDevice): void {
    if (this.device === device && this.fill_pipeline) return
    this.device = device
    const module = device.createShaderModule({ label: 'asset_detail.shader', code: detail_shader })
    this.bind_layout = device.createBindGroupLayout({
      label: 'asset_detail.bind_layout',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    })
    const layout = device.createPipelineLayout({ label: 'asset_detail.pipeline_layout', bindGroupLayouts: [this.bind_layout] })
    const vertex: GPUVertexState = {
      module,
      entryPoint: 'vs_main',
      buffers: [{
        arrayStride: 32,
        attributes: [
          { shaderLocation: 0, offset: 0, format: 'float32x3' },
          { shaderLocation: 1, offset: 12, format: 'float32x3' },
          { shaderLocation: 2, offset: 24, format: 'float32x2' },
        ],
      }],
    }
    this.fill_pipeline = device.createRenderPipeline({
      label: 'asset_detail.fill_pipeline',
      layout,
      vertex,
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    })
    this.line_pipeline = device.createRenderPipeline({
      label: 'asset_detail.line_pipeline',
      layout,
      vertex,
      fragment: { module, entryPoint: 'fs_line', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'line-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
    })
  }

  /** Upload the scene's parts into GPU buffers, replacing any previous set. */
  set_parts(parts: asset_detail_part[]): void {
    const device = this.device
    if (!device || !this.bind_layout) return
    this.release_parts()
    for (const part of parts) {
      const geo = part.geometry
      const count = (geo.positions.length / 3) | 0
      if (count === 0 || geo.indices.length === 0) continue
      const normals = ensure_geometry_normals(geo)
      const interleaved = new Float32Array(count * 8)
      for (let i = 0; i < count; i += 1) {
        interleaved[i * 8] = geo.positions[i * 3]!
        interleaved[i * 8 + 1] = geo.positions[i * 3 + 1]!
        interleaved[i * 8 + 2] = geo.positions[i * 3 + 2]!
        interleaved[i * 8 + 3] = normals[i * 3]!
        interleaved[i * 8 + 4] = normals[i * 3 + 1]!
        interleaved[i * 8 + 5] = normals[i * 3 + 2]!
        if (geo.uvs) {
          interleaved[i * 8 + 6] = geo.uvs[i * 2]!
          interleaved[i * 8 + 7] = geo.uvs[i * 2 + 1]!
        }
      }
      const vertex_buffer = device.createBuffer({
        label: 'asset_detail.vertices',
        size: interleaved.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(vertex_buffer, 0, interleaved)
      const index_buffer = device.createBuffer({
        label: 'asset_detail.indices',
        size: geo.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(index_buffer, 0, geo.indices as unknown as GPUAllowSharedBufferSource)

      // Wireframe edges: 3 lines per triangle (shared edges drawn twice — fine
      // for an inspection overlay). Capped so a dense part can't allocate GBs.
      let edge_buffer: GPUBuffer | null = null
      let edge_count = 0
      const triangle_count = geo.indices.length / 3
      if (triangle_count <= 2_000_000) {
        const edges = new Uint32Array(triangle_count * 6)
        for (let t = 0; t < triangle_count; t += 1) {
          const a = geo.indices[t * 3]!, b = geo.indices[t * 3 + 1]!, c = geo.indices[t * 3 + 2]!
          edges.set([a, b, b, c, c, a], t * 6)
        }
        edge_buffer = device.createBuffer({
          label: 'asset_detail.edges',
          size: edges.byteLength,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(edge_buffer, 0, edges)
        edge_count = edges.length
      }

      const make_uniform = () => {
        const buffer = device.createBuffer({
          label: 'asset_detail.uniform',
          size: UNIFORM_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        const bind = device.createBindGroup({
          label: 'asset_detail.bind_group',
          layout: this.bind_layout!,
          entries: [{ binding: 0, resource: { buffer } }],
        })
        return { buffer, bind }
      }
      const fill = make_uniform()
      const line = make_uniform()
      this.parts.push({
        vertex_buffer,
        index_buffer,
        index_count: geo.indices.length,
        edge_buffer,
        edge_count,
        fill_uniform: fill.buffer,
        fill_bind: fill.bind,
        line_uniform: line.buffer,
        line_bind: line.bind,
      })
    }
  }

  /**
   * Render every part with the given camera into an offscreen texture
   * (recreated on resize) and return it. `selected` (-1 = whole scene) dims
   * the other parts and draws the selected part's wireframe in the accent
   * colour so the current pick reads in every mode.
   */
  render(
    width: number,
    height: number,
    camera: asset_detail_camera_frame,
    options: {
      mode: asset_detail_raster_mode
      selected: number
      clear: { r: number; g: number; b: number; a: number }
      accent: asset_detail_vec3
    },
  ): GPUTexture | null {
    const device = this.device
    if (!device || !this.fill_pipeline || !this.line_pipeline) return null
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    if (!this.color_target || this.color_target.width !== w || this.color_target.height !== h) {
      this.color_target?.destroy()
      this.depth_target?.destroy()
      this.color_target = device.createTexture({
        label: 'asset_detail.color_target',
        size: [w, h, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
      this.depth_target = device.createTexture({
        label: 'asset_detail.depth_target',
        size: [w, h, 1],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
    }

    const projection = mat4_perspective(camera.fov, w / h, camera.near, camera.far)
    const view = mat4_look_at(camera.eye, camera.target, camera.up)
    const mvp = mat4_multiply(projection, view)
    // Headlight slightly off the eye axis so curvature reads.
    const lx = camera.eye[0] - camera.target[0], ly = camera.eye[1] - camera.target[1], lz = camera.eye[2] - camera.target[2]
    const llen = Math.hypot(lx, ly, lz) || 1
    const mode_index = RASTER_MODE_INDEX[options.mode]
    const light = [lx / llen + 0.35, ly / llen + 0.55, lz / llen + 0.15, mode_index]

    const uniform_data = new Float32Array(UNIFORM_BYTES / 4)
    uniform_data.set(mvp, 0)
    uniform_data.set(light, 20)
    const has_selection = options.selected >= 0
    for (let i = 0; i < this.parts.length; i += 1) {
      const part = this.parts[i]!
      const base = asset_detail_part_color(i)
      const dim = has_selection && i !== options.selected ? 0.4 : 1
      uniform_data.set([base[0] * dim, base[1] * dim, base[2] * dim, 1], 16)
      device.queue.writeBuffer(part.fill_uniform, 0, uniform_data)
      const line_color: asset_detail_vec3 = has_selection && i === options.selected
        ? options.accent
        : [0.1, 0.9, 0.55]
      const line_dim = has_selection && i !== options.selected ? 0.35 : 1
      uniform_data.set([line_color[0] * line_dim, line_color[1] * line_dim, line_color[2] * line_dim, 1], 16)
      device.queue.writeBuffer(part.line_uniform, 0, uniform_data)
    }

    const encoder = device.createCommandEncoder({ label: 'asset_detail.encoder' })
    const pass = encoder.beginRenderPass({
      label: 'asset_detail.pass',
      colorAttachments: [{
        view: this.color_target.createView(),
        clearValue: options.clear,
        loadOp: 'clear',
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depth_target!.createView(),
        depthClearValue: 1,
        depthLoadOp: 'clear',
        depthStoreOp: 'store',
      },
    })
    pass.setPipeline(this.fill_pipeline)
    for (const part of this.parts) {
      pass.setBindGroup(0, part.fill_bind)
      pass.setVertexBuffer(0, part.vertex_buffer)
      pass.setIndexBuffer(part.index_buffer, 'uint32')
      pass.drawIndexed(part.index_count)
    }
    // Wireframe mode draws every part's edges; other modes outline the pick.
    pass.setPipeline(this.line_pipeline)
    for (let i = 0; i < this.parts.length; i += 1) {
      const part = this.parts[i]!
      if (!part.edge_buffer) continue
      if (options.mode !== 'wireframe' && i !== options.selected) continue
      pass.setBindGroup(0, part.line_bind)
      pass.setVertexBuffer(0, part.vertex_buffer)
      pass.setIndexBuffer(part.edge_buffer, 'uint32')
      pass.drawIndexed(part.edge_count)
    }
    pass.end()
    device.queue.submit([encoder.finish()])
    return this.color_target
  }

  private release_parts(): void {
    for (const part of this.parts) {
      part.vertex_buffer.destroy()
      part.index_buffer.destroy()
      part.edge_buffer?.destroy()
      part.fill_uniform.destroy()
      part.line_uniform.destroy()
    }
    this.parts = []
  }

  dispose(): void {
    this.release_parts()
    this.color_target?.destroy()
    this.depth_target?.destroy()
    this.color_target = null
    this.depth_target = null
  }
}
