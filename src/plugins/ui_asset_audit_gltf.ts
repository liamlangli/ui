// Asset audit — GLB / glTF 2.0 importer. Dependency-free: parses the GLB
// container (or a bare .gltf JSON), walks the scene graph baking node
// transforms into world-space vertex data, and flattens every triangle
// primitive into an `audit_mesh`. External buffers/images resolve through the
// optional `external_files` map (filled by a folder upload); data: URIs are
// decoded inline. Unsupported features degrade to warnings, never throws for
// individual primitives.

import type { audit_asset, audit_mesh } from './ui_asset_audit_data'
import { recompute_mesh_normals } from './ui_asset_audit_data'

interface gltf_json {
  asset?: { version?: string }
  scene?: number
  scenes?: { nodes?: number[] }[]
  nodes?: gltf_node[]
  meshes?: { name?: string; primitives?: gltf_primitive[] }[]
  materials?: gltf_material[]
  accessors?: gltf_accessor[]
  bufferViews?: gltf_buffer_view[]
  buffers?: { uri?: string; byteLength: number }[]
  textures?: unknown[]
  images?: unknown[]
  animations?: unknown[]
  skins?: unknown[]
}

interface gltf_node {
  name?: string
  children?: number[]
  mesh?: number
  matrix?: number[]
  translation?: number[]
  rotation?: number[]
  scale?: number[]
}

interface gltf_primitive {
  attributes?: Record<string, number>
  indices?: number
  material?: number
  mode?: number
}

interface gltf_material {
  name?: string
  pbrMetallicRoughness?: { baseColorFactor?: number[]; baseColorTexture?: unknown }
}

interface gltf_accessor {
  bufferView?: number
  byteOffset?: number
  componentType: number
  normalized?: boolean
  count: number
  type: string
  sparse?: unknown
}

interface gltf_buffer_view {
  buffer: number
  byteOffset?: number
  byteLength: number
  byteStride?: number
}

const component_bytes: Record<number, number> = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }
const type_components: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }

function decode_data_uri(uri: string): ArrayBuffer | null {
  const comma = uri.indexOf(',')
  if (comma < 0) return null
  const meta = uri.slice(0, comma)
  const payload = uri.slice(comma + 1)
  if (/;base64$/i.test(meta)) {
    const bin = atob(payload)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
    return out.buffer
  }
  return new TextEncoder().encode(decodeURIComponent(payload)).buffer as ArrayBuffer
}

// --- minimal column-major mat4 helpers (only what baking needs) -------------

type mat4 = Float64Array

function mat4_identity(): mat4 {
  const m = new Float64Array(16)
  m[0] = m[5] = m[10] = m[15] = 1
  return m
}

function mat4_multiply(a: mat4, b: mat4): mat4 {
  const out = new Float64Array(16)
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[col * 4 + k]!
      out[col * 4 + row] = sum
    }
  }
  return out
}

function mat4_from_trs(t: number[], r: number[], s: number[]): mat4 {
  const [x, y, z, w] = [r[0] ?? 0, r[1] ?? 0, r[2] ?? 0, r[3] ?? 1]
  const [sx, sy, sz] = [s[0] ?? 1, s[1] ?? 1, s[2] ?? 1]
  const m = new Float64Array(16)
  const x2 = x + x, y2 = y + y, z2 = z + z
  const xx = x * x2, xy = x * y2, xz = x * z2
  const yy = y * y2, yz = y * z2, zz = z * z2
  const wx = w * x2, wy = w * y2, wz = w * z2
  m[0] = (1 - (yy + zz)) * sx; m[1] = (xy + wz) * sx; m[2] = (xz - wy) * sx
  m[4] = (xy - wz) * sy; m[5] = (1 - (xx + zz)) * sy; m[6] = (yz + wx) * sy
  m[8] = (xz + wy) * sz; m[9] = (yz - wx) * sz; m[10] = (1 - (xx + yy)) * sz
  m[12] = t[0] ?? 0; m[13] = t[1] ?? 0; m[14] = t[2] ?? 0
  m[15] = 1
  return m
}

/** Inverse-transpose of the upper 3×3 — correct normals under non-uniform scale. */
function normal_matrix(m: mat4): Float64Array {
  const a = m[0]!, b = m[4]!, c = m[8]!
  const d = m[1]!, e = m[5]!, f = m[9]!
  const g = m[2]!, h = m[6]!, i = m[10]!
  const ca = e * i - f * h, cb = f * g - d * i, cc = d * h - e * g
  let det = a * ca + b * cb + c * cc
  if (Math.abs(det) < 1e-20) det = 1
  const inv = 1 / det
  // rows of inverse(3x3) become columns of inverse-transpose
  return Float64Array.from([
    ca * inv, cb * inv, cc * inv,
    (c * h - b * i) * inv, (a * i - c * g) * inv, (b * g - a * h) * inv,
    (b * f - c * e) * inv, (c * d - a * f) * inv, (a * e - b * d) * inv,
  ])
}

// --- accessor decoding -------------------------------------------------------

class gltf_reader {
  constructor(
    private json: gltf_json,
    private buffers: (ArrayBuffer | null)[],
    public warnings: string[],
  ) {}

  /** Decode an accessor into floats (integer types de-normalized when flagged). */
  read_float(index: number): { data: Float32Array; components: number } | null {
    const acc = this.json.accessors?.[index]
    if (!acc) return null
    const components = type_components[acc.type] ?? 0
    const raw = this.read_raw(acc)
    if (!raw || components === 0) return null
    const out = new Float32Array(acc.count * components)
    const normalized = acc.normalized === true
    for (let i = 0; i < out.length; i += 1) {
      let v = raw[i] ?? 0
      if (normalized) {
        if (acc.componentType === 5121) v /= 255
        else if (acc.componentType === 5123) v /= 65535
        else if (acc.componentType === 5120) v = Math.max(v / 127, -1)
        else if (acc.componentType === 5122) v = Math.max(v / 32767, -1)
      }
      out[i] = v
    }
    return { data: out, components }
  }

  read_indices(index: number): Uint32Array | null {
    const acc = this.json.accessors?.[index]
    if (!acc) return null
    const raw = this.read_raw(acc)
    if (!raw) return null
    return raw instanceof Uint32Array ? raw : Uint32Array.from(raw as ArrayLike<number>)
  }

  private read_raw(acc: gltf_accessor): ArrayLike<number> & { [n: number]: number } | null {
    if (acc.sparse) this.warnings.push('sparse accessor: sparse displacements ignored')
    const components = type_components[acc.type] ?? 1
    const comp_bytes = component_bytes[acc.componentType] ?? 0
    if (comp_bytes === 0) {
      this.warnings.push(`unsupported accessor componentType ${acc.componentType}`)
      return null
    }
    if (acc.bufferView === undefined) return new Float32Array(acc.count * components) // spec: zero-filled
    const view = this.json.bufferViews?.[acc.bufferView]
    const buffer = view ? this.buffers[view.buffer] : null
    if (!view || !buffer) {
      this.warnings.push('accessor references a missing buffer (external .bin not provided?)')
      return null
    }
    const stride = view.byteStride ?? comp_bytes * components
    const base = (view.byteOffset ?? 0) + (acc.byteOffset ?? 0)
    const make = (ctor: new (b: ArrayBuffer, o: number, l: number) => ArrayLike<number> & { [n: number]: number }) => {
      if (stride === comp_bytes * components) return new ctor(buffer, base, acc.count * components)
      // De-interleave strided attributes into a tight copy.
      const dv = new DataView(buffer)
      const out = new Float64Array(acc.count * components)
      for (let i = 0; i < acc.count; i += 1) {
        for (let c = 0; c < components; c += 1) {
          const at = base + i * stride + c * comp_bytes
          out[i * components + c] =
            acc.componentType === 5126 ? dv.getFloat32(at, true)
            : acc.componentType === 5125 ? dv.getUint32(at, true)
            : acc.componentType === 5123 ? dv.getUint16(at, true)
            : acc.componentType === 5122 ? dv.getInt16(at, true)
            : acc.componentType === 5121 ? dv.getUint8(at)
            : dv.getInt8(at)
        }
      }
      return out
    }
    try {
      switch (acc.componentType) {
        case 5126: return make(Float32Array)
        case 5125: return make(Uint32Array)
        case 5123: return make(Uint16Array)
        case 5122: return make(Int16Array)
        case 5121: return make(Uint8Array)
        case 5120: return make(Int8Array)
        default: return null
      }
    } catch {
      this.warnings.push('accessor out of buffer bounds — data skipped')
      return null
    }
  }
}

export interface gltf_parse_options {
  /** Sibling files (lower-cased basename → bytes) for external buffer URIs. */
  external_files?: Map<string, ArrayBuffer>
}

/** Parse a .glb container or bare .gltf JSON into a flattened `audit_asset`. */
export function parse_gltf_asset(buffer: ArrayBuffer, file_name: string, options?: gltf_parse_options): audit_asset {
  const dv = new DataView(buffer)
  let json: gltf_json
  let bin: ArrayBuffer | null = null
  let format: 'glb' | 'gltf' = 'gltf'

  if (buffer.byteLength >= 12 && dv.getUint32(0, true) === 0x46546c67) {
    format = 'glb'
    const version = dv.getUint32(4, true)
    if (version !== 2) throw new Error(`unsupported GLB version ${version}`)
    let offset = 12
    let json_text: string | null = null
    while (offset + 8 <= buffer.byteLength) {
      const length = dv.getUint32(offset, true)
      const kind = dv.getUint32(offset + 4, true)
      const body = buffer.slice(offset + 8, offset + 8 + length)
      if (kind === 0x4e4f534a) json_text = new TextDecoder().decode(body)
      else if (kind === 0x004e4942) bin = body
      offset += 8 + length + ((4 - (length % 4)) % 4)
    }
    if (!json_text) throw new Error('GLB has no JSON chunk')
    json = JSON.parse(json_text)
  } else {
    json = JSON.parse(new TextDecoder().decode(buffer))
    if (!json.asset) throw new Error('not a glTF file')
  }

  const warnings: string[] = []
  const buffers: (ArrayBuffer | null)[] = (json.buffers ?? []).map((b, i) => {
    if (b.uri === undefined) {
      if (format === 'glb' && i === 0 && bin) return bin
      warnings.push(`buffer ${i} has no uri and no GLB BIN chunk`)
      return null
    }
    if (b.uri.startsWith('data:')) return decode_data_uri(b.uri)
    const base = decodeURIComponent(b.uri.split('/').pop() ?? b.uri).toLowerCase()
    const external = options?.external_files?.get(base)
    if (external) return external
    warnings.push(`external buffer "${b.uri}" not found — upload the folder containing it`)
    return null
  })

  const reader = new gltf_reader(json, buffers, warnings)
  const meshes: audit_mesh[] = []

  const emit_primitive = (prim: gltf_primitive, mesh_name: string, world: mat4): void => {
    const mode = prim.mode ?? 4
    if (mode !== 4) {
      warnings.push(`${mesh_name}: primitive mode ${mode} skipped (only triangles render)`)
      return
    }
    const pos_index = prim.attributes?.POSITION
    if (pos_index === undefined) {
      warnings.push(`${mesh_name}: primitive has no POSITION`)
      return
    }
    const pos = reader.read_float(pos_index)
    if (!pos || pos.components !== 3) return
    const count = pos.data.length / 3
    const nm = normal_matrix(world)
    const positions = new Float32Array(count * 3)
    for (let i = 0; i < count; i += 1) {
      const x = pos.data[i * 3]!, y = pos.data[i * 3 + 1]!, z = pos.data[i * 3 + 2]!
      positions[i * 3] = world[0]! * x + world[4]! * y + world[8]! * z + world[12]!
      positions[i * 3 + 1] = world[1]! * x + world[5]! * y + world[9]! * z + world[13]!
      positions[i * 3 + 2] = world[2]! * x + world[6]! * y + world[10]! * z + world[14]!
    }

    let normals: Float32Array | null = null
    const norm_index = prim.attributes?.NORMAL
    if (norm_index !== undefined) {
      const src = reader.read_float(norm_index)
      if (src && src.components === 3 && src.data.length === count * 3) {
        normals = new Float32Array(count * 3)
        for (let i = 0; i < count; i += 1) {
          const x = src.data[i * 3]!, y = src.data[i * 3 + 1]!, z = src.data[i * 3 + 2]!
          let ox = nm[0]! * x + nm[3]! * y + nm[6]! * z
          let oy = nm[1]! * x + nm[4]! * y + nm[7]! * z
          let oz = nm[2]! * x + nm[5]! * y + nm[8]! * z
          const len = Math.hypot(ox, oy, oz)
          if (len > 1e-12) { ox /= len; oy /= len; oz /= len }
          normals[i * 3] = ox; normals[i * 3 + 1] = oy; normals[i * 3 + 2] = oz
        }
      }
    }

    let uvs: Float32Array | null = null
    const uv_index = prim.attributes?.TEXCOORD_0
    if (uv_index !== undefined) {
      const src = reader.read_float(uv_index)
      if (src && src.components === 2 && src.data.length === count * 2) uvs = src.data
    }

    let indices: Uint32Array
    if (prim.indices !== undefined) {
      const src = reader.read_indices(prim.indices)
      if (!src) return
      indices = src
    } else {
      indices = new Uint32Array(count)
      for (let i = 0; i < count; i += 1) indices[i] = i
    }

    const material = prim.material !== undefined ? json.materials?.[prim.material] : undefined
    const factor = material?.pbrMetallicRoughness?.baseColorFactor
    const base_color: [number, number, number, number] = [
      factor?.[0] ?? 0.8, factor?.[1] ?? 0.8, factor?.[2] ?? 0.8, factor?.[3] ?? 1,
    ]

    const mesh: audit_mesh = {
      name: mesh_name,
      positions,
      normals: normals ?? new Float32Array(count * 3),
      uvs,
      indices,
      base_color,
      material_name: material?.name ?? null,
      normals_generated: !normals,
    }
    if (!normals) {
      recompute_mesh_normals(mesh)
      warnings.push(`${mesh_name}: normals missing — generated smooth normals`)
    }
    meshes.push(mesh)
  }

  let node_count = 0
  const visit = (index: number, parent: mat4, depth: number): void => {
    if (depth > 256) return // cycle guard
    const node = json.nodes?.[index]
    if (!node) return
    node_count += 1
    const local = node.matrix
      ? Float64Array.from(node.matrix)
      : mat4_from_trs(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1])
    const world = mat4_multiply(parent, local)
    if (node.mesh !== undefined) {
      const mesh_def = json.meshes?.[node.mesh]
      const name = node.name ?? mesh_def?.name ?? `mesh_${node.mesh}`
      for (const prim of mesh_def?.primitives ?? []) emit_primitive(prim, name, world)
    }
    for (const child of node.children ?? []) visit(child, world, depth + 1)
  }

  const scene = json.scenes?.[json.scene ?? 0] ?? json.scenes?.[0]
  const roots = scene?.nodes ?? (json.nodes ?? []).map((_, i) => i)
  for (const root of roots) visit(root, mat4_identity(), 0)

  // Orphan meshes (referenced by no node) still get audited, untransformed.
  const used = new Set<number>()
  for (const node of json.nodes ?? []) if (node.mesh !== undefined) used.add(node.mesh)
  ;(json.meshes ?? []).forEach((mesh_def, i) => {
    if (used.has(i)) return
    for (const prim of mesh_def.primitives ?? []) emit_primitive(prim, mesh_def.name ?? `mesh_${i}`, mat4_identity())
  })

  if (meshes.length === 0) warnings.push('no triangle geometry found')
  if ((json.skins?.length ?? 0) > 0) warnings.push('skinned meshes preview in bind pose (skinning ignored)')

  return {
    file_name,
    format,
    file_bytes: buffer.byteLength,
    meshes,
    source: {
      node_count,
      mesh_count: json.meshes?.length ?? 0,
      material_count: json.materials?.length ?? 0,
      texture_count: json.textures?.length ?? 0,
      animation_count: json.animations?.length ?? 0,
      skin_count: json.skins?.length ?? 0,
    },
    warnings,
    geometry_version: 0,
  }
}
