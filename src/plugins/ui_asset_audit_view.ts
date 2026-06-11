// Asset audit — WebGPU 3D preview. A tiny self-contained mesh renderer that
// shares the ui_renderer's GPUDevice: meshes upload once into vertex/index
// buffers and render (lambert shading + optional wireframe overlay) into an
// offscreen rgba8 texture, which the panel then composites with
// `register_external_texture` / `draw_texture`. Re-renders only when the
// camera, asset or viewport size changes — the adaptive UI renderer stays idle
// otherwise.

import type { audit_bounds, audit_mesh } from './ui_asset_audit_data'

export interface orbit_camera {
  yaw: number
  pitch: number
  distance: number
  target: [number, number, number]
  fov: number
}

export function create_orbit_camera(): orbit_camera {
  return { yaw: 0.7, pitch: 0.45, distance: 6, target: [0, 0, 0], fov: Math.PI / 4 }
}

/** Point the orbit camera at the asset's bounds, fully in frame. */
export function frame_orbit_camera(camera: orbit_camera, bounds: audit_bounds | null): void {
  if (!bounds) return
  const cx = (bounds.min[0] + bounds.max[0]) / 2
  const cy = (bounds.min[1] + bounds.max[1]) / 2
  const cz = (bounds.min[2] + bounds.max[2]) / 2
  const dx = bounds.max[0] - bounds.min[0]
  const dy = bounds.max[1] - bounds.min[1]
  const dz = bounds.max[2] - bounds.min[2]
  const radius = Math.max(1e-5, Math.hypot(dx, dy, dz) / 2)
  camera.target = [cx, cy, cz]
  camera.distance = (radius / Math.tan(camera.fov / 2)) * 1.35
  camera.yaw = 0.7
  camera.pitch = 0.45
}

// --- column-major mat4 (WGSL layout) ----------------------------------------

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

function mat4_look_at(eye: [number, number, number], target: [number, number, number], up: [number, number, number]): Float32Array {
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

export function orbit_camera_eye(camera: orbit_camera): [number, number, number] {
  const cp = Math.cos(camera.pitch)
  return [
    camera.target[0] + camera.distance * cp * Math.sin(camera.yaw),
    camera.target[1] + camera.distance * Math.sin(camera.pitch),
    camera.target[2] + camera.distance * cp * Math.cos(camera.yaw),
  ]
}

const view_shader = /* wgsl */ `
struct view_uniforms {
  mvp: mat4x4f,
  color: vec4f,
  // xyz = light direction, w = shading mode (0 shaded, 1 texture, 2 normal).
  light_dir: vec4f,
}
@group(0) @binding(0) var<uniform> u: view_uniforms;
@group(0) @binding(1) var albedo_sampler: sampler;
@group(0) @binding(2) var albedo_texture: texture_2d<f32>;

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
  // Sampled unconditionally to keep textureSample in uniform control flow.
  let texel = textureSample(albedo_texture, albedo_sampler, in.uv);
  let n = normalize(in.normal);
  let mode = u.light_dir.w;
  if (mode > 1.5) {
    // Normal preview: world-space normals mapped to RGB.
    return vec4f(n * 0.5 + vec3f(0.5), 1.0);
  }
  let l = normalize(u.light_dir.xyz);
  let diffuse = max(dot(n, l), 0.0);
  let fill = max(dot(n, -l), 0.0) * 0.22;
  var base = u.color.rgb;
  if (mode > 0.5) {
    // Texture preview: lit base-color texture (white fallback when untextured).
    base = texel.rgb * u.color.rgb;
  }
  let lit = base * (0.24 + diffuse * 0.8 + fill);
  return vec4f(lit, 1.0);
}

@fragment
fn fs_line(in: v_out) -> @location(0) vec4f {
  return u.color;
}
`

export type asset_audit_view_mode = 'shaded' | 'texture' | 'normal'

const VIEW_MODE_INDEX: Record<asset_audit_view_mode, number> = { shaded: 0, texture: 1, normal: 2 }

const UNIFORM_BYTES = 96 // mat4 + 2×vec4

interface view_gpu_mesh {
  vertex_buffer: GPUBuffer
  index_buffer: GPUBuffer
  index_count: number
  edge_buffer: GPUBuffer | null
  edge_count: number
  fill_uniform: GPUBuffer
  fill_bind: GPUBindGroup
  line_uniform: GPUBuffer
  line_bind: GPUBindGroup
  color: [number, number, number, number]
}

export class asset_audit_view {
  private device: GPUDevice | null = null
  private fill_pipeline: GPURenderPipeline | null = null
  private line_pipeline: GPURenderPipeline | null = null
  private bind_layout: GPUBindGroupLayout | null = null
  private sampler: GPUSampler | null = null
  /** 1×1 white — untextured meshes sample this so one pipeline covers all modes. */
  private white_texture: GPUTexture | null = null
  private meshes: view_gpu_mesh[] = []
  private albedo_textures = new Map<ImageBitmap, GPUTexture>()
  private color_target: GPUTexture | null = null
  private depth_target: GPUTexture | null = null

  init(device: GPUDevice): void {
    if (this.device === device && this.fill_pipeline) return
    this.device = device
    const module = device.createShaderModule({ label: 'asset_audit.view_shader', code: view_shader })
    this.bind_layout = device.createBindGroupLayout({
      label: 'asset_audit.bind_layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    this.sampler = device.createSampler({
      label: 'asset_audit.albedo_sampler',
      magFilter: 'linear',
      minFilter: 'linear',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
    })
    this.white_texture = device.createTexture({
      label: 'asset_audit.white_texture',
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    device.queue.writeTexture({ texture: this.white_texture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, [1, 1, 1])
    const layout = device.createPipelineLayout({ label: 'asset_audit.pipeline_layout', bindGroupLayouts: [this.bind_layout] })
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
      label: 'asset_audit.fill_pipeline',
      layout,
      vertex,
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    })
    this.line_pipeline = device.createRenderPipeline({
      label: 'asset_audit.line_pipeline',
      layout,
      vertex,
      fragment: { module, entryPoint: 'fs_line', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'line-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: false, depthCompare: 'less-equal' },
    })
  }

  /** Upload an albedo bitmap once and share the GPU texture between meshes. */
  private albedo_texture_for(mesh: audit_mesh): GPUTexture {
    const device = this.device!
    if (!mesh.albedo) return this.white_texture!
    let texture = this.albedo_textures.get(mesh.albedo)
    if (!texture) {
      texture = device.createTexture({
        label: 'asset_audit.albedo',
        size: [mesh.albedo.width, mesh.albedo.height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      device.queue.copyExternalImageToTexture({ source: mesh.albedo }, { texture }, { width: mesh.albedo.width, height: mesh.albedo.height })
      this.albedo_textures.set(mesh.albedo, texture)
    }
    return texture
  }

  /** Upload meshes into GPU buffers, replacing any previous set. */
  set_meshes(meshes: audit_mesh[]): void {
    const device = this.device
    if (!device || !this.bind_layout) return
    this.release_meshes()
    for (const mesh of meshes) {
      const count = mesh.positions.length / 3
      if (count === 0 || mesh.indices.length === 0) continue
      const interleaved = new Float32Array(count * 8)
      for (let i = 0; i < count; i += 1) {
        interleaved[i * 8] = mesh.positions[i * 3]!
        interleaved[i * 8 + 1] = mesh.positions[i * 3 + 1]!
        interleaved[i * 8 + 2] = mesh.positions[i * 3 + 2]!
        interleaved[i * 8 + 3] = mesh.normals[i * 3]!
        interleaved[i * 8 + 4] = mesh.normals[i * 3 + 1]!
        interleaved[i * 8 + 5] = mesh.normals[i * 3 + 2]!
        if (mesh.uvs) {
          interleaved[i * 8 + 6] = mesh.uvs[i * 2]!
          interleaved[i * 8 + 7] = mesh.uvs[i * 2 + 1]!
        }
      }
      const vertex_buffer = device.createBuffer({
        label: 'asset_audit.vertices',
        size: interleaved.byteLength,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(vertex_buffer, 0, interleaved)
      const index_buffer = device.createBuffer({
        label: 'asset_audit.indices',
        size: mesh.indices.byteLength,
        usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
      })
      device.queue.writeBuffer(index_buffer, 0, mesh.indices as unknown as GPUAllowSharedBufferSource)

      // Wireframe edges: 3 lines per triangle (shared edges drawn twice — fine
      // for an inspection overlay). Capped so a dense mesh can't allocate GBs.
      let edge_buffer: GPUBuffer | null = null
      let edge_count = 0
      const triangle_count = mesh.indices.length / 3
      if (triangle_count <= 2_000_000) {
        const edges = new Uint32Array(triangle_count * 6)
        for (let t = 0; t < triangle_count; t += 1) {
          const a = mesh.indices[t * 3]!, b = mesh.indices[t * 3 + 1]!, c = mesh.indices[t * 3 + 2]!
          edges.set([a, b, b, c, c, a], t * 6)
        }
        edge_buffer = device.createBuffer({
          label: 'asset_audit.edges',
          size: edges.byteLength,
          usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
        })
        device.queue.writeBuffer(edge_buffer, 0, edges)
        edge_count = edges.length
      }

      const albedo_view = this.albedo_texture_for(mesh).createView()
      const make_uniform = () => {
        const buffer = device.createBuffer({
          label: 'asset_audit.uniform',
          size: UNIFORM_BYTES,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        })
        const bind = device.createBindGroup({
          label: 'asset_audit.bind_group',
          layout: this.bind_layout!,
          entries: [
            { binding: 0, resource: { buffer } },
            { binding: 1, resource: this.sampler! },
            { binding: 2, resource: albedo_view },
          ],
        })
        return { buffer, bind }
      }
      const fill = make_uniform()
      const line = make_uniform()
      this.meshes.push({
        vertex_buffer,
        index_buffer,
        index_count: mesh.indices.length,
        edge_buffer,
        edge_count,
        fill_uniform: fill.buffer,
        fill_bind: fill.bind,
        line_uniform: line.buffer,
        line_bind: line.bind,
        color: mesh.base_color,
      })
    }
  }

  /**
   * Render the current meshes with the given camera into an offscreen texture
   * (recreated on resize) and return it. Returns null until init/set_meshes.
   */
  render(
    width: number,
    height: number,
    camera: orbit_camera,
    options: { wireframe?: boolean; mode?: asset_audit_view_mode; clear: { r: number; g: number; b: number; a: number }; bounds_radius?: number },
  ): GPUTexture | null {
    const device = this.device
    if (!device || !this.fill_pipeline || !this.line_pipeline) return null
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    if (!this.color_target || this.color_target.width !== w || this.color_target.height !== h) {
      this.color_target?.destroy()
      this.depth_target?.destroy()
      this.color_target = device.createTexture({
        label: 'asset_audit.color_target',
        size: [w, h, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
      this.depth_target = device.createTexture({
        label: 'asset_audit.depth_target',
        size: [w, h, 1],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
    }

    const radius = Math.max(1e-4, options.bounds_radius ?? camera.distance)
    const near = Math.max(radius * 1e-3, camera.distance * 1e-3)
    const far = camera.distance + radius * 4
    const projection = mat4_perspective(camera.fov, w / h, near, far)
    const eye = orbit_camera_eye(camera)
    const view = mat4_look_at(eye, camera.target, [0, 1, 0])
    const mvp = mat4_multiply(projection, view)
    // Headlight slightly off the eye axis so curvature reads.
    const lx = eye[0] - camera.target[0], ly = eye[1] - camera.target[1], lz = eye[2] - camera.target[2]
    const llen = Math.hypot(lx, ly, lz) || 1
    const light = [lx / llen + 0.35, ly / llen + 0.55, lz / llen + 0.15, VIEW_MODE_INDEX[options.mode ?? 'shaded']]

    const uniform_data = new Float32Array(UNIFORM_BYTES / 4)
    uniform_data.set(mvp, 0)
    uniform_data.set(light, 20)
    for (const mesh of this.meshes) {
      uniform_data.set(mesh.color, 16)
      device.queue.writeBuffer(mesh.fill_uniform, 0, uniform_data)
      uniform_data.set([0.1, 0.9, 0.55, 1], 16) // wireframe accent
      device.queue.writeBuffer(mesh.line_uniform, 0, uniform_data)
    }

    const encoder = device.createCommandEncoder({ label: 'asset_audit.encoder' })
    const pass = encoder.beginRenderPass({
      label: 'asset_audit.pass',
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
    for (const mesh of this.meshes) {
      pass.setBindGroup(0, mesh.fill_bind)
      pass.setVertexBuffer(0, mesh.vertex_buffer)
      pass.setIndexBuffer(mesh.index_buffer, 'uint32')
      pass.drawIndexed(mesh.index_count)
    }
    if (options.wireframe) {
      pass.setPipeline(this.line_pipeline)
      for (const mesh of this.meshes) {
        if (!mesh.edge_buffer) continue
        pass.setBindGroup(0, mesh.line_bind)
        pass.setVertexBuffer(0, mesh.vertex_buffer)
        pass.setIndexBuffer(mesh.edge_buffer, 'uint32')
        pass.drawIndexed(mesh.edge_count)
      }
    }
    pass.end()
    device.queue.submit([encoder.finish()])
    return this.color_target
  }

  private release_meshes(): void {
    for (const mesh of this.meshes) {
      mesh.vertex_buffer.destroy()
      mesh.index_buffer.destroy()
      mesh.edge_buffer?.destroy()
      mesh.fill_uniform.destroy()
      mesh.line_uniform.destroy()
    }
    this.meshes = []
    for (const texture of this.albedo_textures.values()) texture.destroy()
    this.albedo_textures.clear()
  }

  dispose(): void {
    this.release_meshes()
    this.color_target?.destroy()
    this.depth_target?.destroy()
    this.white_texture?.destroy()
    this.color_target = null
    this.depth_target = null
    this.white_texture = null
  }
}
