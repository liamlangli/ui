// Asset audit — binary FBX importer. Dependency-free: walks the FBX node-record
// tree (zlib-deflated arrays inflate through the browser's DecompressionStream,
// which is why parsing is async), extracts Geometry control points / polygons /
// normals / UVs and a basic Model transform chain (Lcl Translation/Rotation/
// Scaling — pivots and pre/post rotation are ignored, noted as a warning).
// Geometry arrives un-indexed (one vertex per polygon corner, matching FBX's
// per-polygon-vertex layers); the audit panel's "weld vertices" pass re-indexes.

import type { audit_asset, audit_mesh } from './ui_asset_audit_data'
import { recompute_mesh_normals } from './ui_asset_audit_data'

type fbx_property = number | boolean | string | Uint8Array | Float32Array | Float64Array | Int32Array | BigInt64Array

interface fbx_node {
  name: string
  props: fbx_property[]
  children: fbx_node[]
}

async function inflate_zlib(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate'))
  return new Uint8Array(await new Response(stream).arrayBuffer())
}

class fbx_cursor {
  offset = 0
  constructor(public dv: DataView, public bytes: Uint8Array) {}
  u8(): number { const v = this.dv.getUint8(this.offset); this.offset += 1; return v }
  i16(): number { const v = this.dv.getInt16(this.offset, true); this.offset += 2; return v }
  u32(): number { const v = this.dv.getUint32(this.offset, true); this.offset += 4; return v }
  i32(): number { const v = this.dv.getInt32(this.offset, true); this.offset += 4; return v }
  f32(): number { const v = this.dv.getFloat32(this.offset, true); this.offset += 4; return v }
  f64(): number { const v = this.dv.getFloat64(this.offset, true); this.offset += 8; return v }
  i64(): number { const v = this.dv.getBigInt64(this.offset, true); this.offset += 8; return Number(v) }
  u64(): number { const v = this.dv.getBigUint64(this.offset, true); this.offset += 8; return Number(v) }
  slice(length: number): Uint8Array {
    const v = this.bytes.subarray(this.offset, this.offset + length)
    this.offset += length
    return v
  }
}

async function read_array<T extends Float32Array | Float64Array | Int32Array | BigInt64Array>(
  cur: fbx_cursor,
  ctor: new (b: ArrayBuffer) => T,
  element_bytes: number,
): Promise<T> {
  const length = cur.u32()
  const encoding = cur.u32()
  const compressed = cur.u32()
  let raw: Uint8Array
  if (encoding === 1) raw = await inflate_zlib(cur.slice(compressed))
  else raw = cur.slice(length * element_bytes)
  // Copy to an aligned standalone buffer (subarray offsets may be unaligned).
  const aligned = new Uint8Array(length * element_bytes)
  aligned.set(raw.subarray(0, aligned.length))
  return new ctor(aligned.buffer)
}

async function read_property(cur: fbx_cursor): Promise<fbx_property> {
  const kind = String.fromCharCode(cur.u8())
  switch (kind) {
    case 'Y': return cur.i16()
    case 'C': return cur.u8() !== 0
    case 'I': return cur.i32()
    case 'F': return cur.f32()
    case 'D': return cur.f64()
    case 'L': return cur.i64()
    case 'f': return read_array(cur, Float32Array, 4)
    case 'd': return read_array(cur, Float64Array, 8)
    case 'i': return read_array(cur, Int32Array, 4)
    case 'l': return read_array(cur, BigInt64Array, 8)
    case 'b': {
      const length = cur.u32()
      const encoding = cur.u32()
      const compressed = cur.u32()
      return encoding === 1 ? await inflate_zlib(cur.slice(compressed)) : cur.slice(length).slice()
    }
    case 'S': {
      const length = cur.u32()
      return new TextDecoder().decode(cur.slice(length))
    }
    case 'R': {
      const length = cur.u32()
      return cur.slice(length).slice()
    }
    default:
      throw new Error(`unknown FBX property type '${kind}'`)
  }
}

async function read_node(cur: fbx_cursor, wide: boolean): Promise<fbx_node | null> {
  const end_offset = wide ? cur.u64() : cur.u32()
  const prop_count = wide ? cur.u64() : cur.u32()
  /* prop list bytes */ wide ? cur.u64() : cur.u32()
  const name_length = cur.u8()
  const name = new TextDecoder().decode(cur.slice(name_length))
  if (end_offset === 0) return null // null record terminates a child list
  const props: fbx_property[] = []
  for (let i = 0; i < prop_count; i += 1) props.push(await read_property(cur))
  const children: fbx_node[] = []
  while (cur.offset < end_offset) {
    const child = await read_node(cur, wide)
    if (!child) break
    children.push(child)
  }
  cur.offset = end_offset
  return { name, props, children }
}

const FBX_BINARY_MAGIC = 'Kaydara FBX Binary  '

async function parse_fbx_tree(buffer: ArrayBuffer): Promise<{ nodes: fbx_node[]; version: number }> {
  const bytes = new Uint8Array(buffer)
  const magic = new TextDecoder().decode(bytes.subarray(0, 20))
  if (magic !== FBX_BINARY_MAGIC) {
    const head = new TextDecoder().decode(bytes.subarray(0, Math.min(512, bytes.length)))
    if (head.includes('FBXHeaderExtension') || head.startsWith('; FBX')) {
      throw new Error('ASCII FBX is not supported — re-export as binary FBX (or glTF)')
    }
    throw new Error('not an FBX file')
  }
  const cur = new fbx_cursor(new DataView(buffer), bytes)
  cur.offset = 23
  const version = cur.u32()
  const wide = version >= 7500 // 7.5+ widened node-record headers to 64-bit
  const nodes: fbx_node[] = []
  while (cur.offset < buffer.byteLength) {
    const node = await read_node(cur, wide)
    if (!node) break
    nodes.push(node)
  }
  return { nodes, version }
}

// --- tree helpers ------------------------------------------------------------

function find_child(node: fbx_node | undefined, name: string): fbx_node | undefined {
  return node?.children.find((c) => c.name === name)
}

function find_children(node: fbx_node | undefined, name: string): fbx_node[] {
  return node?.children.filter((c) => c.name === name) ?? []
}

function prop_number_array(node: fbx_node | undefined): Float64Array | Int32Array | null {
  const p = node?.props[0]
  if (p instanceof Float64Array || p instanceof Int32Array) return p
  if (p instanceof Float32Array) return Float64Array.from(p)
  if (p instanceof BigInt64Array) return Float64Array.from(p, (v) => Number(v))
  return null
}

function prop_string(node: fbx_node | undefined, index = 0): string | null {
  const p = node?.props[index]
  return typeof p === 'string' ? p : null
}

/** FBX object names arrive as "Name\x00\x01Model" — keep the human half. */
function object_name(raw: string | null): string {
  if (!raw) return ''
  const cut = raw.indexOf('\x00')
  return cut >= 0 ? raw.slice(0, cut) : raw
}

/** Read a `P: "Lcl Translation", ..., x, y, z` entry from a Properties70 block. */
function find_p_vec3(node: fbx_node | undefined, key: string): [number, number, number] | null {
  const props70 = find_child(node, 'Properties70')
  for (const p of find_children(props70, 'P')) {
    if (p.props[0] === key) {
      const x = p.props[4], y = p.props[5], z = p.props[6]
      if (typeof x === 'number' && typeof y === 'number' && typeof z === 'number') return [x, y, z]
    }
  }
  return null
}

// --- transform chain ---------------------------------------------------------

interface fbx_model {
  id: number
  name: string
  translation: [number, number, number]
  rotation: [number, number, number] // degrees, applied X then Y then Z
  scale: [number, number, number]
  parent: number | null
}

type vec3 = [number, number, number]

function apply_model_chain(models: Map<number, fbx_model>, id: number, p: vec3, is_normal: boolean): vec3 {
  let out: vec3 = [p[0], p[1], p[2]]
  let current: fbx_model | undefined = models.get(id)
  let guard = 0
  while (current && guard < 64) {
    const [sx, sy, sz] = current.scale
    if (!is_normal) out = [out[0] * sx, out[1] * sy, out[2] * sz]
    const [rx, ry, rz] = current.rotation.map((d) => (d * Math.PI) / 180) as vec3
    // Rotation order XYZ: v' = Rz · Ry · Rx · v
    let [x, y, z] = out
    let c = Math.cos(rx), s = Math.sin(rx)
    ;[y, z] = [y * c - z * s, y * s + z * c]
    c = Math.cos(ry); s = Math.sin(ry)
    ;[x, z] = [x * c + z * s, -x * s + z * c]
    c = Math.cos(rz); s = Math.sin(rz)
    ;[x, y] = [x * c - y * s, x * s + y * c]
    out = [x, y, z]
    if (!is_normal) {
      out[0] += current.translation[0]
      out[1] += current.translation[1]
      out[2] += current.translation[2]
    }
    current = current.parent !== null ? models.get(current.parent) : undefined
    guard += 1
  }
  return out
}

// --- geometry extraction -----------------------------------------------------

/** Parse a binary FBX file into a flattened, un-indexed `audit_asset`. */
export async function parse_fbx_asset(buffer: ArrayBuffer, file_name: string): Promise<audit_asset> {
  const { nodes } = await parse_fbx_tree(buffer)
  const warnings: string[] = []
  const objects = nodes.find((n) => n.name === 'Objects')
  const connections = nodes.find((n) => n.name === 'Connections')

  // Models (transform nodes) and the OO connection graph.
  const models = new Map<number, fbx_model>()
  for (const node of find_children(objects, 'Model')) {
    const id = typeof node.props[0] === 'number' ? node.props[0] : -1
    if (id < 0) continue
    models.set(id, {
      id,
      name: object_name(prop_string(node, 1)),
      translation: find_p_vec3(node, 'Lcl Translation') ?? [0, 0, 0],
      rotation: find_p_vec3(node, 'Lcl Rotation') ?? [0, 0, 0],
      scale: find_p_vec3(node, 'Lcl Scaling') ?? [1, 1, 1],
      parent: null,
    })
  }

  const geometry_to_model = new Map<number, number>()
  for (const c of find_children(connections, 'C')) {
    if (c.props[0] !== 'OO') continue
    const child = c.props[1], parent = c.props[2]
    if (typeof child !== 'number' || typeof parent !== 'number') continue
    if (models.has(child) && models.has(parent)) models.get(child)!.parent = parent
    else if (models.has(parent)) geometry_to_model.set(child, parent)
  }

  // Materials: without per-face material connections we only apply a color when
  // the file has exactly one material — otherwise meshes stay neutral.
  const material_nodes = find_children(objects, 'Material')
  let single_color: [number, number, number, number] | null = null
  let single_material_name: string | null = null
  if (material_nodes.length === 1) {
    const diffuse = find_p_vec3(material_nodes[0], 'DiffuseColor') ?? find_p_vec3(material_nodes[0], 'Diffuse')
    if (diffuse) single_color = [diffuse[0], diffuse[1], diffuse[2], 1]
    single_material_name = object_name(prop_string(material_nodes[0], 1)) || null
  }

  const meshes: audit_mesh[] = []
  const geometry_nodes = find_children(objects, 'Geometry').filter((g) => prop_string(g, 2) === 'Mesh' || !prop_string(g, 2))
  for (const geo of geometry_nodes) {
    const geo_id = typeof geo.props[0] === 'number' ? geo.props[0] : -1
    const control_points = prop_number_array(find_child(geo, 'Vertices'))
    const polygon_index = prop_number_array(find_child(geo, 'PolygonVertexIndex'))
    if (!control_points || !polygon_index || polygon_index.length < 3) continue

    const normal_layer = find_child(geo, 'LayerElementNormal')
    const normal_data = prop_number_array(find_child(normal_layer, 'Normals'))
    const normal_index = prop_number_array(find_child(normal_layer, 'NormalsIndex'))
    const normal_mapping = prop_string(find_child(normal_layer, 'MappingInformationType')) ?? ''
    const normal_ref = prop_string(find_child(normal_layer, 'ReferenceInformationType')) ?? 'Direct'

    const uv_layer = find_child(geo, 'LayerElementUV')
    const uv_data = prop_number_array(find_child(uv_layer, 'UV'))
    const uv_index = prop_number_array(find_child(uv_layer, 'UVIndex'))
    const uv_mapping = prop_string(find_child(uv_layer, 'MappingInformationType')) ?? ''
    const uv_ref = prop_string(find_child(uv_layer, 'ReferenceInformationType')) ?? 'Direct'

    // Triangulate polygons (fan) into corner triples; each triple keeps both the
    // control-point index (positions) and the global corner index (PV layers).
    const corners: { point: number; corner: number }[][] = []
    let polygon: { point: number; corner: number }[] = []
    for (let i = 0; i < polygon_index.length; i += 1) {
      let point = polygon_index[i]!
      const last = point < 0
      if (last) point = ~point
      polygon.push({ point, corner: i })
      if (last) {
        for (let t = 1; t + 1 < polygon.length; t += 1) corners.push([polygon[0]!, polygon[t]!, polygon[t + 1]!])
        polygon = []
      }
    }

    const triangle_count = corners.length
    const positions = new Float32Array(triangle_count * 9)
    const normals = new Float32Array(triangle_count * 9)
    const uvs = uv_data ? new Float32Array(triangle_count * 6) : null
    const indices = new Uint32Array(triangle_count * 3)
    let have_normals = !!normal_data
    const model_id = geometry_to_model.get(geo_id)

    let out = 0
    for (const tri of corners) {
      for (const { point, corner } of tri) {
        let px = control_points[point * 3] ?? 0
        let py = control_points[point * 3 + 1] ?? 0
        let pz = control_points[point * 3 + 2] ?? 0
        let nx = 0, ny = 1, nz = 0
        if (normal_data) {
          let ni = corner
          if (normal_mapping === 'ByVertice' || normal_mapping === 'ByVertex' || normal_mapping === 'ByControlPoint') ni = point
          else if (normal_mapping === 'AllSame') ni = 0
          if (normal_ref === 'IndexToDirect' && normal_index) ni = normal_index[ni] ?? 0
          nx = normal_data[ni * 3] ?? 0
          ny = normal_data[ni * 3 + 1] ?? 1
          nz = normal_data[ni * 3 + 2] ?? 0
        }
        if (model_id !== undefined) {
          ;[px, py, pz] = apply_model_chain(models, model_id, [px, py, pz], false)
          ;[nx, ny, nz] = apply_model_chain(models, model_id, [nx, ny, nz], true)
          const len = Math.hypot(nx, ny, nz)
          if (len > 1e-12) { nx /= len; ny /= len; nz /= len }
        }
        positions[out * 3] = px; positions[out * 3 + 1] = py; positions[out * 3 + 2] = pz
        normals[out * 3] = nx; normals[out * 3 + 1] = ny; normals[out * 3 + 2] = nz
        if (uvs && uv_data) {
          let ti = corner
          if (uv_mapping === 'ByControlPoint' || uv_mapping === 'ByVertice' || uv_mapping === 'ByVertex') ti = point
          else if (uv_mapping === 'AllSame') ti = 0
          if (uv_ref === 'IndexToDirect' && uv_index) ti = uv_index[ti] ?? 0
          uvs[out * 2] = uv_data[ti * 2] ?? 0
          uvs[out * 2 + 1] = 1 - (uv_data[ti * 2 + 1] ?? 0)
        }
        indices[out] = out
        out += 1
      }
    }

    const model_name = model_id !== undefined ? models.get(model_id)?.name : undefined
    const mesh: audit_mesh = {
      name: model_name || object_name(prop_string(geo, 1)) || `geometry_${meshes.length}`,
      positions,
      normals,
      uvs,
      indices,
      base_color: single_color ?? [0.72, 0.72, 0.75, 1],
      material_name: single_material_name,
      normals_generated: !have_normals,
      albedo_bytes: null,
      albedo_mime: null,
      albedo: null,
    }
    if (!have_normals) {
      recompute_mesh_normals(mesh)
      warnings.push(`${mesh.name}: normals missing — generated smooth normals`)
    }
    meshes.push(mesh)
  }

  if (meshes.length === 0) warnings.push('no polygon geometry found')
  else warnings.push('FBX geometry is fully un-indexed — run "Weld vertices" to re-index')
  if (models.size > 0) warnings.push('FBX pivots and pre/post rotations are ignored in the preview')
  if (material_nodes.length > 1) warnings.push('multiple FBX materials: per-face assignment not resolved')

  const animation_count = find_children(objects, 'AnimationStack').length
  const texture_count = find_children(objects, 'Texture').length
  const skin_count = find_children(objects, 'Deformer').filter((d) => prop_string(d, 2) === 'Skin').length
  if (skin_count > 0) warnings.push('skinned meshes preview in bind pose (skinning ignored)')

  return {
    file_name,
    format: 'fbx',
    file_bytes: buffer.byteLength,
    meshes,
    source: {
      node_count: models.size,
      mesh_count: geometry_nodes.length,
      material_count: material_nodes.length,
      texture_count,
      animation_count,
      skin_count,
    },
    warnings,
    geometry_version: 0,
  }
}
