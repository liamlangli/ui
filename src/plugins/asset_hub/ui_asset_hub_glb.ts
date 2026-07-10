// asset_hub GLB preview — decode a binary glTF (.glb) into one flattened
// triangle soup and rasterize it on the CPU into an RGBA image the panel can
// upload as a renderer texture.
//
// Geometry may be Draco-compressed (KHR_draco_mesh_compression); the official
// Draco decoder (copied from the `li` repo into `public/lib/draco/`) is
// script-loaded lazily and only when a scene actually needs it, so the ~700 KB
// decoder never loads for plain GLBs. Everything runs in the browser: the file
// bytes come straight from the cloud storage provider and never leave the tab.

// --- glTF / GLB types (the minimal subset the preview reads) --------------------

interface gltf_primitive {
  attributes?: Record<string, number>
  indices?: number
  material?: number
  mode?: number
  extensions?: { KHR_draco_mesh_compression?: { bufferView: number; attributes: Record<string, number> } }
}

interface gltf_json {
  scene?: number
  scenes?: { nodes?: number[] }[]
  nodes?: {
    children?: number[]
    mesh?: number
    matrix?: number[]
    translation?: number[]
    rotation?: number[]
    scale?: number[]
  }[]
  meshes?: { primitives?: gltf_primitive[] }[]
  accessors?: {
    bufferView?: number
    byteOffset?: number
    componentType: number
    normalized?: boolean
    count: number
    type: string
  }[]
  bufferViews?: { buffer: number; byteOffset?: number; byteLength: number; byteStride?: number }[]
  materials?: {
    pbrMetallicRoughness?: { baseColorFactor?: number[] }
    emissiveFactor?: number[]
  }[]
  extensionsUsed?: string[]
  extensionsRequired?: string[]
}

/** Flattened world-space triangle soup, ready for the software rasterizer. */
export interface glb_preview_mesh {
  positions: Float32Array
  normals: Float32Array
  /** Linear-space rgb per vertex, from the primitive's material base color. */
  colors: Float32Array
  indices: Uint32Array
  bounds: { min: [number, number, number]; max: [number, number, number] }
  vertex_count: number
  triangle_count: number
  /** True when at least one primitive was Draco-compressed. */
  draco_used: boolean
}

const GLB_MAGIC = 0x46546c67
const GLB_CHUNK_JSON = 0x4e4f534a
const GLB_CHUNK_BIN = 0x004e4942
const COMPONENT_BYTES: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const TYPE_COMPONENTS: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }
/** Keep preview decodes bounded — beyond this the file is for download, not inline viewing. */
const MAX_PREVIEW_TRIANGLES = 1_500_000

// --- GLB container ---------------------------------------------------------------

function parse_glb(data: ArrayBuffer): { json: gltf_json; bin: ArrayBuffer | null } {
  const view = new DataView(data)
  if (data.byteLength < 12 || view.getUint32(0, true) !== GLB_MAGIC) throw new Error('Not a binary glTF (.glb) file.')
  const version = view.getUint32(4, true)
  if (version !== 2) throw new Error(`Unsupported GLB version ${version} — only glTF 2.0 is supported.`)
  const total = Math.min(view.getUint32(8, true), data.byteLength)
  let offset = 12
  let json: gltf_json | null = null
  let bin: ArrayBuffer | null = null
  while (offset + 8 <= total) {
    const chunk_length = view.getUint32(offset, true)
    const chunk_type = view.getUint32(offset + 4, true)
    const start = offset + 8
    if (start + chunk_length > data.byteLength) break
    if (chunk_type === GLB_CHUNK_JSON) {
      json = JSON.parse(new TextDecoder().decode(new Uint8Array(data, start, chunk_length))) as gltf_json
    } else if (chunk_type === GLB_CHUNK_BIN) {
      bin = data.slice(start, start + chunk_length)
    }
    offset = start + chunk_length + ((4 - (chunk_length % 4)) % 4)
  }
  if (!json) throw new Error('GLB file has no JSON chunk.')
  return { json, bin }
}

// --- accessor reading ---------------------------------------------------------------

class gltf_reader {
  constructor(private json: gltf_json, private bin: ArrayBuffer | null) {}

  /** Read an accessor as floats (dequantizing normalized integer data). */
  read_float(accessor_index: number): { data: Float32Array; components: number } | null {
    const accessor = this.json.accessors?.[accessor_index]
    if (!accessor || accessor.bufferView === undefined || !this.bin) return null
    const view = this.json.bufferViews?.[accessor.bufferView]
    if (!view) return null
    const components = TYPE_COMPONENTS[accessor.type] ?? 0
    const component_bytes = COMPONENT_BYTES[accessor.componentType] ?? 0
    if (components === 0 || component_bytes === 0) return null
    const stride = view.byteStride ?? components * component_bytes
    const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
    if (base + (accessor.count - 1) * stride + components * component_bytes > this.bin.byteLength) return null
    const bytes = new DataView(this.bin)
    const out = new Float32Array(accessor.count * components)
    for (let i = 0; i < accessor.count; i += 1) {
      const row = base + i * stride
      for (let c = 0; c < components; c += 1) {
        out[i * components + c] = read_component(bytes, row + c * component_bytes, accessor.componentType, accessor.normalized ?? false)
      }
    }
    return { data: out, components }
  }

  read_indices(accessor_index: number): Uint32Array | null {
    const accessor = this.json.accessors?.[accessor_index]
    if (!accessor || accessor.bufferView === undefined || !this.bin || accessor.type !== 'SCALAR') return null
    const view = this.json.bufferViews?.[accessor.bufferView]
    if (!view) return null
    const component_bytes = COMPONENT_BYTES[accessor.componentType] ?? 0
    if (component_bytes === 0) return null
    const stride = view.byteStride ?? component_bytes
    const base = (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0)
    if (base + (accessor.count - 1) * stride + component_bytes > this.bin.byteLength) return null
    const bytes = new DataView(this.bin)
    const out = new Uint32Array(accessor.count)
    for (let i = 0; i < accessor.count; i += 1) {
      const at = base + i * stride
      out[i] = accessor.componentType === 5125 ? bytes.getUint32(at, true)
        : accessor.componentType === 5123 ? bytes.getUint16(at, true)
        : bytes.getUint8(at)
    }
    return out
  }
}

function read_component(bytes: DataView, at: number, component_type: number, normalized: boolean): number {
  switch (component_type) {
    case 5126: return bytes.getFloat32(at, true)
    case 5125: return bytes.getUint32(at, true)
    case 5123: { const v = bytes.getUint16(at, true); return normalized ? v / 65535 : v }
    case 5121: { const v = bytes.getUint8(at); return normalized ? v / 255 : v }
    case 5122: { const v = bytes.getInt16(at, true); return normalized ? Math.max(v / 32767, -1) : v }
    case 5120: { const v = bytes.getInt8(at); return normalized ? Math.max(v / 127, -1) : v }
    default: return 0
  }
}

// --- Draco decoder (official lib served from public/lib/draco/) ---------------------

interface draco_array {
  ptr?: number
  GetValue(index: number): number
  size(): number
}

interface draco_point_attribute {
  ptr?: number
  num_components(): number
}

interface draco_status {
  ptr?: number
  ok(): boolean
  error_msg(): string
}

interface draco_mesh {
  ptr?: number
  num_points(): number
  num_faces(): number
}

interface draco_decoder {
  ptr?: number
  DecodeBufferToMesh(buffer: draco_buffer, mesh: draco_mesh): draco_status
  GetAttributeByUniqueId(mesh: draco_mesh, unique_id: number): draco_point_attribute
  GetAttributeFloatForAllPoints(mesh: draco_mesh, attribute: draco_point_attribute, out: draco_array): boolean
  GetFaceFromMesh(mesh: draco_mesh, face_id: number, out: draco_array): boolean
}

interface draco_buffer {
  ptr?: number
  Init(data: Int8Array, length: number): void
}

interface draco_module {
  Decoder: new () => draco_decoder
  DecoderBuffer: new () => draco_buffer
  Mesh: new () => draco_mesh
  DracoFloat32Array: new () => draco_array
  DracoInt32Array: new () => draco_array
  destroy(object: { ptr?: number }): void
}

type draco_module_factory = (options: { locateFile(file: string): string }) => Promise<draco_module>

declare global {
  interface Window {
    DracoDecoderModule?: draco_module_factory
  }
}

const DRACO_LIB_BASE = `${import.meta.env.BASE_URL}lib/draco/`

let draco_module_promise: Promise<draco_module> | null = null

function load_draco_decoder(): Promise<draco_module> {
  draco_module_promise ??= new Promise<draco_module>((resolve, reject) => {
    const start = () => {
      const factory = window.DracoDecoderModule
      if (!factory) {
        reject(new Error('DracoDecoderModule was not registered by the decoder script.'))
        return
      }
      factory({ locateFile: (file) => `${DRACO_LIB_BASE}${file}` }).then(resolve, reject)
    }
    if (window.DracoDecoderModule) {
      start()
      return
    }
    const script = document.createElement('script')
    script.async = true
    script.src = `${DRACO_LIB_BASE}draco_decoder_gltf.js`
    script.onload = start
    script.onerror = () => reject(new Error(`Could not load ${script.src}`))
    document.head.appendChild(script)
  })
  return draco_module_promise
}

function destroy_draco(draco: draco_module, object: { ptr?: number } | null): void {
  if (object?.ptr) draco.destroy(object)
}

interface decoded_primitive {
  positions: Float32Array
  normals: Float32Array | null
  indices: Uint32Array
}

function decode_draco_primitive(
  draco: draco_module,
  json: gltf_json,
  bin: ArrayBuffer,
  primitive: gltf_primitive,
): decoded_primitive {
  const extension = primitive.extensions?.KHR_draco_mesh_compression
  const view = extension ? json.bufferViews?.[extension.bufferView] : undefined
  if (!extension || !view) throw new Error('Draco primitive is missing its compressed bufferView.')

  const decoder = new draco.Decoder()
  const buffer = new draco.DecoderBuffer()
  const mesh = new draco.Mesh()
  let status: draco_status | null = null
  let positions: draco_array | null = null
  let normals: draco_array | null = null
  let face: draco_array | null = null

  try {
    const compressed = new Int8Array(bin, view.byteOffset ?? 0, view.byteLength)
    buffer.Init(compressed, compressed.length)
    status = decoder.DecodeBufferToMesh(buffer, mesh)
    if (!status.ok() || !mesh.ptr) throw new Error(status.error_msg() || 'Draco mesh decode failed.')

    // Attribute handles from GetAttributeByUniqueId are owned by the decoded
    // mesh; destroying them double-frees and corrupts the decoder heap.
    const position_attribute = decoder.GetAttributeByUniqueId(mesh, extension.attributes.POSITION ?? -1)
    if (!position_attribute?.ptr || position_attribute.num_components() < 3) {
      throw new Error('Draco primitive has no decodable POSITION attribute.')
    }
    positions = new draco.DracoFloat32Array()
    if (!decoder.GetAttributeFloatForAllPoints(mesh, position_attribute, positions)) {
      throw new Error('Could not read Draco POSITION data.')
    }
    const position_components = position_attribute.num_components()

    let normal_components = 0
    if (extension.attributes.NORMAL !== undefined) {
      const normal_attribute = decoder.GetAttributeByUniqueId(mesh, extension.attributes.NORMAL)
      if (normal_attribute?.ptr && normal_attribute.num_components() >= 3) {
        normals = new draco.DracoFloat32Array()
        if (decoder.GetAttributeFloatForAllPoints(mesh, normal_attribute, normals)) {
          normal_components = normal_attribute.num_components()
        } else {
          destroy_draco(draco, normals)
          normals = null
        }
      }
    }

    const vertex_count = mesh.num_points()
    const out_positions = new Float32Array(vertex_count * 3)
    const out_normals = normal_components >= 3 && normals ? new Float32Array(vertex_count * 3) : null
    for (let i = 0; i < vertex_count; i += 1) {
      out_positions[i * 3] = positions.GetValue(i * position_components)
      out_positions[i * 3 + 1] = positions.GetValue(i * position_components + 1)
      out_positions[i * 3 + 2] = positions.GetValue(i * position_components + 2)
      if (out_normals && normals) {
        out_normals[i * 3] = normals.GetValue(i * normal_components)
        out_normals[i * 3 + 1] = normals.GetValue(i * normal_components + 1)
        out_normals[i * 3 + 2] = normals.GetValue(i * normal_components + 2)
      }
    }

    const face_count = mesh.num_faces()
    const out_indices = new Uint32Array(face_count * 3)
    face = new draco.DracoInt32Array()
    for (let f = 0; f < face_count; f += 1) {
      if (!decoder.GetFaceFromMesh(mesh, f, face)) throw new Error('Could not read Draco face data.')
      out_indices[f * 3] = face.GetValue(0)
      out_indices[f * 3 + 1] = face.GetValue(1)
      out_indices[f * 3 + 2] = face.GetValue(2)
    }
    return { positions: out_positions, normals: out_normals, indices: out_indices }
  } finally {
    destroy_draco(draco, face)
    destroy_draco(draco, normals)
    destroy_draco(draco, positions)
    destroy_draco(draco, status)
    destroy_draco(draco, mesh)
    destroy_draco(draco, buffer)
    destroy_draco(draco, decoder)
  }
}

// --- scene flattening --------------------------------------------------------------

type mat4 = Float32Array

function mat4_identity(): mat4 {
  const m = new Float32Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

/** Column-major (glTF convention) 4×4 multiply: `out = a * b`. */
function mat4_multiply(a: mat4, b: mat4): mat4 {
  const out = new Float32Array(16)
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      out[col * 4 + row] =
        a[row]! * b[col * 4]! + a[4 + row]! * b[col * 4 + 1]! + a[8 + row]! * b[col * 4 + 2]! + a[12 + row]! * b[col * 4 + 3]!
    }
  }
  return out
}

function node_matrix(node: NonNullable<gltf_json['nodes']>[number]): mat4 {
  if (node.matrix && node.matrix.length === 16) return Float32Array.from(node.matrix)
  const [tx, ty, tz] = [node.translation?.[0] ?? 0, node.translation?.[1] ?? 0, node.translation?.[2] ?? 0]
  const [qx, qy, qz, qw] = [node.rotation?.[0] ?? 0, node.rotation?.[1] ?? 0, node.rotation?.[2] ?? 0, node.rotation?.[3] ?? 1]
  const [sx, sy, sz] = [node.scale?.[0] ?? 1, node.scale?.[1] ?? 1, node.scale?.[2] ?? 1]
  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz
  const xx = qx * x2, xy = qx * y2, xz = qx * z2
  const yy = qy * y2, yz = qy * z2, zz = qz * z2
  const wx = qw * x2, wy = qw * y2, wz = qw * z2
  return Float32Array.from([
    (1 - (yy + zz)) * sx, (xy + wz) * sx, (xz - wy) * sx, 0,
    (xy - wz) * sy, (1 - (xx + zz)) * sy, (yz + wx) * sy, 0,
    (xz + wy) * sz, (yz - wx) * sz, (1 - (xx + yy)) * sz, 0,
    tx, ty, tz, 1,
  ])
}

function transform_point(m: mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z + m[12]!,
    m[1]! * x + m[5]! * y + m[9]! * z + m[13]!,
    m[2]! * x + m[6]! * y + m[10]! * z + m[14]!,
  ]
}

function transform_vector(m: mat4, x: number, y: number, z: number): [number, number, number] {
  return [
    m[0]! * x + m[4]! * y + m[8]! * z,
    m[1]! * x + m[5]! * y + m[9]! * z,
    m[2]! * x + m[6]! * y + m[10]! * z,
  ]
}

function material_color(material: NonNullable<gltf_json['materials']>[number] | undefined): [number, number, number] {
  const base = material?.pbrMetallicRoughness?.baseColorFactor
  if (base && base.length >= 3) return [base[0]!, base[1]!, base[2]!]
  const emissive = material?.emissiveFactor
  if (emissive && emissive.length >= 3 && (emissive[0]! + emissive[1]! + emissive[2]!) > 0.05) {
    return [emissive[0]!, emissive[1]!, emissive[2]!]
  }
  return [0.72, 0.74, 0.78]
}

function needs_draco(json: gltf_json): boolean {
  if (json.extensionsRequired?.includes('KHR_draco_mesh_compression')) return true
  if (json.extensionsUsed?.includes('KHR_draco_mesh_compression')) return true
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      if (primitive.extensions?.KHR_draco_mesh_compression) return true
    }
  }
  return false
}

/**
 * Decode a `.glb` into a single flattened world-space mesh. Loads the Draco
 * decoder on demand when the scene uses `KHR_draco_mesh_compression`.
 */
export async function decode_glb_preview_mesh(data: ArrayBuffer): Promise<glb_preview_mesh> {
  const { json, bin } = parse_glb(data)
  const draco = needs_draco(json) ? await load_draco_decoder() : null
  const reader = new gltf_reader(json, bin)

  const positions: number[] = []
  const normals: number[] = []
  const colors: number[] = []
  const indices: number[] = []
  const bounds: glb_preview_mesh['bounds'] = {
    min: [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY],
    max: [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY],
  }
  let draco_used = false

  const append_primitive = (decoded: decoded_primitive, world: mat4, color: [number, number, number]) => {
    if ((indices.length + decoded.indices.length) / 3 > MAX_PREVIEW_TRIANGLES) {
      throw new Error('Scene is too dense for an inline preview — download it instead.')
    }
    const vertex_start = positions.length / 3
    const vertex_count = decoded.positions.length / 3
    for (let i = 0; i < vertex_count; i += 1) {
      const p = transform_point(world, decoded.positions[i * 3]!, decoded.positions[i * 3 + 1]!, decoded.positions[i * 3 + 2]!)
      positions.push(p[0], p[1], p[2])
      if (p[0] < bounds.min[0]) bounds.min[0] = p[0]
      if (p[1] < bounds.min[1]) bounds.min[1] = p[1]
      if (p[2] < bounds.min[2]) bounds.min[2] = p[2]
      if (p[0] > bounds.max[0]) bounds.max[0] = p[0]
      if (p[1] > bounds.max[1]) bounds.max[1] = p[1]
      if (p[2] > bounds.max[2]) bounds.max[2] = p[2]
      if (decoded.normals) {
        const n = transform_vector(world, decoded.normals[i * 3]!, decoded.normals[i * 3 + 1]!, decoded.normals[i * 3 + 2]!)
        const len = Math.hypot(n[0], n[1], n[2]) || 1
        normals.push(n[0] / len, n[1] / len, n[2] / len)
      } else {
        normals.push(0, 0, 0) // filled from face normals below
      }
      colors.push(color[0], color[1], color[2])
    }
    for (const index of decoded.indices) indices.push(vertex_start + index)
    // Missing normals: accumulate area-weighted face normals for this range.
    if (!decoded.normals) {
      for (let t = 0; t < decoded.indices.length; t += 3) {
        const a = (vertex_start + decoded.indices[t]!) * 3
        const b = (vertex_start + decoded.indices[t + 1]!) * 3
        const c = (vertex_start + decoded.indices[t + 2]!) * 3
        const abx = positions[b]! - positions[a]!, aby = positions[b + 1]! - positions[a + 1]!, abz = positions[b + 2]! - positions[a + 2]!
        const acx = positions[c]! - positions[a]!, acy = positions[c + 1]! - positions[a + 1]!, acz = positions[c + 2]! - positions[a + 2]!
        const nx = aby * acz - abz * acy
        const ny = abz * acx - abx * acz
        const nz = abx * acy - aby * acx
        for (const at of [a, b, c]) {
          normals[at] = normals[at]! + nx
          normals[at + 1] = normals[at + 1]! + ny
          normals[at + 2] = normals[at + 2]! + nz
        }
      }
    }
  }

  const roots = json.scenes?.[json.scene ?? 0]?.nodes ?? json.scenes?.[0]?.nodes ?? []
  const visit = (node_index: number, parent: mat4) => {
    const node = json.nodes?.[node_index]
    if (!node) return
    const world = mat4_multiply(parent, node_matrix(node))
    if (node.mesh !== undefined) {
      for (const primitive of json.meshes?.[node.mesh]?.primitives ?? []) {
        if ((primitive.mode ?? 4) !== 4) continue // triangles only
        const color = material_color(json.materials?.[primitive.material ?? -1])
        if (primitive.extensions?.KHR_draco_mesh_compression) {
          if (!draco || !bin) continue
          append_primitive(decode_draco_primitive(draco, json, bin, primitive), world, color)
          draco_used = true
          continue
        }
        const position_index = primitive.attributes?.POSITION
        if (position_index === undefined) continue
        const read_positions = reader.read_float(position_index)
        if (!read_positions || read_positions.components !== 3) continue
        const read_normals = primitive.attributes?.NORMAL !== undefined ? reader.read_float(primitive.attributes.NORMAL) : null
        const vertex_count = read_positions.data.length / 3
        const source_indices = primitive.indices !== undefined ? reader.read_indices(primitive.indices) : null
        const decoded: decoded_primitive = {
          positions: read_positions.data,
          normals: read_normals?.components === 3 ? read_normals.data : null,
          indices: source_indices ?? sequential_indices(vertex_count),
        }
        append_primitive(decoded, world, color)
      }
    }
    for (const child of node.children ?? []) visit(child, world)
  }
  for (const root of roots) visit(root, mat4_identity())

  if (indices.length === 0) throw new Error('No triangles found in this GLB scene.')

  // Renormalize (accumulated face normals for primitives that shipped none).
  const normal_array = new Float32Array(normals)
  for (let i = 0; i < normal_array.length; i += 3) {
    const len = Math.hypot(normal_array[i]!, normal_array[i + 1]!, normal_array[i + 2]!)
    if (len > 1e-12) {
      normal_array[i] = normal_array[i]! / len
      normal_array[i + 1] = normal_array[i + 1]! / len
      normal_array[i + 2] = normal_array[i + 2]! / len
    } else {
      normal_array[i + 1] = 1
    }
  }

  return {
    positions: new Float32Array(positions),
    normals: normal_array,
    colors: new Float32Array(colors),
    indices: new Uint32Array(indices),
    bounds,
    vertex_count: positions.length / 3,
    triangle_count: indices.length / 3,
    draco_used,
  }
}

function sequential_indices(count: number): Uint32Array {
  const out = new Uint32Array(count)
  for (let i = 0; i < count; i += 1) out[i] = i
  return out
}

// --- software rasterizer -------------------------------------------------------------

/**
 * Render the mesh into a `width×height` RGBA buffer (transparent background)
 * with an orbit camera at `yaw`/`pitch` around the mesh bounds. Runs on the
 * CPU — cheap enough for on-demand preview renders (initial view + drags).
 */
export function render_glb_preview(mesh: glb_preview_mesh, width: number, height: number, yaw: number, pitch: number): Uint8ClampedArray {
  const w = Math.max(1, Math.floor(width))
  const h = Math.max(1, Math.floor(height))
  const pixels = new Uint8ClampedArray(w * h * 4)
  const depth = new Float32Array(w * h).fill(Number.POSITIVE_INFINITY)

  const cx = (mesh.bounds.min[0] + mesh.bounds.max[0]) * 0.5
  const cy = (mesh.bounds.min[1] + mesh.bounds.max[1]) * 0.5
  const cz = (mesh.bounds.min[2] + mesh.bounds.max[2]) * 0.5
  const radius = Math.max(
    1e-6,
    Math.hypot(mesh.bounds.max[0] - mesh.bounds.min[0], mesh.bounds.max[1] - mesh.bounds.min[1], mesh.bounds.max[2] - mesh.bounds.min[2]) * 0.5,
  )

  const clamped_pitch = Math.max(-1.45, Math.min(1.45, pitch))
  const cos_pitch = Math.cos(clamped_pitch)
  // Camera basis (right / up / forward), orbiting the bounds center.
  const fx = -cos_pitch * Math.sin(yaw)
  const fy = -Math.sin(clamped_pitch)
  const fz = -cos_pitch * Math.cos(yaw)
  const rx = Math.cos(yaw)
  const rz = -Math.sin(yaw)
  // up = right × forward (right.y is 0)
  const ux = -rz * fy
  const uy = rz * fx - rx * fz
  const uz = rx * fy
  const distance = radius * 2.9
  const ex = cx - fx * distance
  const ey = cy - fy * distance
  const ez = cz - fz * distance

  const fov = 0.55 // ~31.5°
  const focal = (Math.min(w, h) * 0.5) / Math.tan(fov * 0.5)
  const near = Math.max(distance - radius * 2, radius * 0.02)

  // Headlight-ish key from the camera's upper left, plus a soft sky ambient.
  let kx = -rx * 0.45 + ux * 0.6 - fx * 0.75
  let ky = uy * 0.6 - fy * 0.75
  let kz = -rz * 0.45 + uz * 0.6 - fz * 0.75
  const klen = Math.hypot(kx, ky, kz) || 1
  kx /= klen; ky /= klen; kz /= klen

  const { positions, normals, colors, indices } = mesh
  const vertex_count = mesh.vertex_count
  const screen = new Float32Array(vertex_count * 3) // sx, sy, view-space depth
  const shade = new Float32Array(vertex_count * 3)

  for (let i = 0; i < vertex_count; i += 1) {
    const px = positions[i * 3]! - ex
    const py = positions[i * 3 + 1]! - ey
    const pz = positions[i * 3 + 2]! - ez
    const vx = px * rx + py * 0 + pz * rz
    const vy = px * ux + py * uy + pz * uz
    const vz = px * fx + py * fy + pz * fz // positive in front of the camera
    screen[i * 3 + 2] = vz
    if (vz > near * 0.5) {
      screen[i * 3] = w * 0.5 + (vx / vz) * focal
      screen[i * 3 + 1] = h * 0.5 - (vy / vz) * focal
    } else {
      screen[i * 3] = Number.NaN
      screen[i * 3 + 1] = Number.NaN
    }

    const nx = normals[i * 3]!
    const ny = normals[i * 3 + 1]!
    const nz = normals[i * 3 + 2]!
    // Two-sided diffuse (previews shouldn't go black inside open meshes).
    const key = Math.abs(nx * kx + ny * ky + nz * kz)
    const sky = 0.5 + 0.5 * ny
    const light = 0.22 + 0.62 * key + 0.24 * sky
    shade[i * 3] = colors[i * 3]! * light
    shade[i * 3 + 1] = colors[i * 3 + 1]! * light
    shade[i * 3 + 2] = colors[i * 3 + 2]! * light
  }

  for (let t = 0; t < indices.length; t += 3) {
    const ia = indices[t]!, ib = indices[t + 1]!, ic = indices[t + 2]!
    const ax = screen[ia * 3]!, ay = screen[ia * 3 + 1]!, az = screen[ia * 3 + 2]!
    const bx = screen[ib * 3]!, by = screen[ib * 3 + 1]!, bz = screen[ib * 3 + 2]!
    const cxs = screen[ic * 3]!, cys = screen[ic * 3 + 1]!, czs = screen[ic * 3 + 2]!
    if (Number.isNaN(ax) || Number.isNaN(bx) || Number.isNaN(cxs)) continue

    const area = (bx - ax) * (cys - ay) - (by - ay) * (cxs - ax)
    if (Math.abs(area) < 1e-9) continue
    const inv_area = 1 / area

    const min_x = Math.max(0, Math.floor(Math.min(ax, bx, cxs)))
    const max_x = Math.min(w - 1, Math.ceil(Math.max(ax, bx, cxs)))
    const min_y = Math.max(0, Math.floor(Math.min(ay, by, cys)))
    const max_y = Math.min(h - 1, Math.ceil(Math.max(ay, by, cys)))
    if (min_x > max_x || min_y > max_y) continue

    for (let y = min_y; y <= max_y; y += 1) {
      const sy = y + 0.5
      const row = y * w
      for (let x = min_x; x <= max_x; x += 1) {
        const sx = x + 0.5
        let wa = ((bx - sx) * (cys - sy) - (by - sy) * (cxs - sx)) * inv_area
        let wb = ((cxs - sx) * (ay - sy) - (cys - sy) * (ax - sx)) * inv_area
        let wc = 1 - wa - wb
        if (wa < 0 || wb < 0 || wc < 0) continue
        // Perspective-correct interpolation via 1/z weights.
        const iza = wa / az, izb = wb / bz, izc = wc / czs
        const iz = iza + izb + izc
        const z = 1 / iz
        const at = row + x
        if (z >= depth[at]!) continue
        depth[at] = z
        wa = iza * z; wb = izb * z; wc = izc * z
        const r = wa * shade[ia * 3]! + wb * shade[ib * 3]! + wc * shade[ic * 3]!
        const g = wa * shade[ia * 3 + 1]! + wb * shade[ib * 3 + 1]! + wc * shade[ic * 3 + 1]!
        const b = wa * shade[ia * 3 + 2]! + wb * shade[ib * 3 + 2]! + wc * shade[ic * 3 + 2]!
        const p = at * 4
        // Linear → sRGB-ish gamma for the renderer's rgba8unorm texture.
        pixels[p] = Math.min(255, Math.pow(Math.max(r, 0), 1 / 2.2) * 255)
        pixels[p + 1] = Math.min(255, Math.pow(Math.max(g, 0), 1 / 2.2) * 255)
        pixels[p + 2] = Math.min(255, Math.pow(Math.max(b, 0), 1 / 2.2) * 255)
        pixels[p + 3] = 255
      }
    }
  }

  return pixels
}
