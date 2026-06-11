// Asset audit — shared data model, statistics, geometry optimizations and the
// GLB exporter. Parsers (ui_asset_audit_gltf / ui_asset_audit_fbx) produce an
// `audit_asset`; the panel (ui_asset_audit) inspects, optimizes and re-exports
// it. All geometry is kept in flat typed arrays with world transforms baked in
// so the viewer and the optimizer never need to walk a scene graph.

/** One renderable triangle mesh. Positions/normals are world-space (baked). */
export interface audit_mesh {
  name: string
  /** xyz per vertex. */
  positions: Float32Array
  /** xyz per vertex — always present (generated when the source had none). */
  normals: Float32Array
  /** uv per vertex, or null when the source had no texcoords. */
  uvs: Float32Array | null
  /** Triangle list indices into the vertex arrays. */
  indices: Uint32Array
  /** Linear-space base color used for preview shading and re-export. */
  base_color: [number, number, number, number]
  material_name: string | null
  /** True when normals were synthesized by the importer/optimizer. */
  normals_generated: boolean
  /** Encoded base-color texture bytes (PNG/JPEG/…) captured at parse time, or null. */
  albedo_bytes: Uint8Array | null
  albedo_mime: string | null
  /** Decoded base-color image — filled by {@link decode_asset_textures}. */
  albedo: ImageBitmap | null
}

/** Source-file structure counts, captured at parse time for the info panel. */
export interface audit_source_info {
  node_count: number
  mesh_count: number
  material_count: number
  texture_count: number
  animation_count: number
  skin_count: number
}

export interface audit_asset {
  file_name: string
  format: 'glb' | 'gltf' | 'fbx'
  file_bytes: number
  meshes: audit_mesh[]
  source: audit_source_info
  /** Importer notes: unsupported features, skipped primitives, fixups. */
  warnings: string[]
  /** Bumped by every optimization pass so the viewer re-uploads GPU buffers. */
  geometry_version: number
}

export interface audit_bounds {
  min: [number, number, number]
  max: [number, number, number]
}

export interface audit_stats {
  mesh_count: number
  vertex_count: number
  triangle_count: number
  geometry_bytes: number
  bounds: audit_bounds | null
}

export function compute_asset_stats(asset: audit_asset): audit_stats {
  let vertices = 0
  let triangles = 0
  let bytes = 0
  let bounds: audit_bounds | null = null
  for (const mesh of asset.meshes) {
    vertices += mesh.positions.length / 3
    triangles += mesh.indices.length / 3
    bytes += mesh.positions.byteLength + mesh.normals.byteLength + (mesh.uvs?.byteLength ?? 0) + mesh.indices.byteLength
    const p = mesh.positions
    for (let i = 0; i + 2 < p.length; i += 3) {
      const x = p[i]!, y = p[i + 1]!, z = p[i + 2]!
      if (!bounds) bounds = { min: [x, y, z], max: [x, y, z] }
      else {
        if (x < bounds.min[0]) bounds.min[0] = x
        if (y < bounds.min[1]) bounds.min[1] = y
        if (z < bounds.min[2]) bounds.min[2] = z
        if (x > bounds.max[0]) bounds.max[0] = x
        if (y > bounds.max[1]) bounds.max[1] = y
        if (z > bounds.max[2]) bounds.max[2] = z
      }
    }
  }
  return { mesh_count: asset.meshes.length, vertex_count: vertices, triangle_count: triangles, geometry_bytes: bytes, bounds }
}

/**
 * Decode every mesh's captured base-color texture bytes into an ImageBitmap
 * (shared byte blobs decode once). Returns the number of textures decoded;
 * failures degrade to an asset warning. Run after parse, before first render,
 * so the viewer's Texture mode has its images ready.
 */
export async function decode_asset_textures(asset: audit_asset): Promise<number> {
  const decoded = new Map<Uint8Array, ImageBitmap | null>()
  let count = 0
  for (const mesh of asset.meshes) {
    if (!mesh.albedo_bytes || mesh.albedo) continue
    let bitmap = decoded.get(mesh.albedo_bytes)
    if (bitmap === undefined) {
      try {
        const blob = new Blob([mesh.albedo_bytes as BlobPart], { type: mesh.albedo_mime ?? 'image/png' })
        bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
        count += 1
      } catch {
        bitmap = null
        asset.warnings.push(`${mesh.name}: base color texture failed to decode`)
      }
      decoded.set(mesh.albedo_bytes, bitmap)
    }
    mesh.albedo = bitmap
  }
  return count
}

/** Accumulate area-weighted face normals and normalize — smooth shading. */
export function recompute_mesh_normals(mesh: audit_mesh): void {
  const p = mesh.positions
  const idx = mesh.indices
  const n = new Float32Array(p.length)
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const a = idx[t]! * 3, b = idx[t + 1]! * 3, c = idx[t + 2]! * 3
    const abx = p[b]! - p[a]!, aby = p[b + 1]! - p[a + 1]!, abz = p[b + 2]! - p[a + 2]!
    const acx = p[c]! - p[a]!, acy = p[c + 1]! - p[a + 1]!, acz = p[c + 2]! - p[a + 2]!
    const fx = aby * acz - abz * acy
    const fy = abz * acx - abx * acz
    const fz = abx * acy - aby * acx
    n[a] += fx; n[a + 1] += fy; n[a + 2] += fz
    n[b] += fx; n[b + 1] += fy; n[b + 2] += fz
    n[c] += fx; n[c + 1] += fy; n[c + 2] += fz
  }
  for (let i = 0; i + 2 < n.length; i += 3) {
    const len = Math.hypot(n[i]!, n[i + 1]!, n[i + 2]!)
    if (len > 1e-12) {
      n[i] /= len; n[i + 1] /= len; n[i + 2] /= len
    } else {
      n[i] = 0; n[i + 1] = 1; n[i + 2] = 0
    }
  }
  mesh.normals = n
  mesh.normals_generated = true
}

/**
 * Merge vertices whose position/normal/uv match exactly and re-point the
 * indices. Returns the number of vertices removed. FBX imports (which arrive
 * fully un-indexed) and badly exported GLBs both benefit heavily.
 */
export function weld_mesh_vertices(mesh: audit_mesh): number {
  const count = mesh.positions.length / 3
  const p = mesh.positions
  const n = mesh.normals
  const uv = mesh.uvs
  const remap = new Uint32Array(count)
  const seen = new Map<string, number>()
  let next = 0
  for (let v = 0; v < count; v += 1) {
    const key =
      `${p[v * 3]},${p[v * 3 + 1]},${p[v * 3 + 2]}|` +
      `${n[v * 3]},${n[v * 3 + 1]},${n[v * 3 + 2]}|` +
      (uv ? `${uv[v * 2]},${uv[v * 2 + 1]}` : '')
    const existing = seen.get(key)
    if (existing !== undefined) {
      remap[v] = existing
    } else {
      seen.set(key, next)
      remap[v] = next
      next += 1
    }
  }
  const removed = count - next
  if (removed === 0) return 0
  const new_p = new Float32Array(next * 3)
  const new_n = new Float32Array(next * 3)
  const new_uv = uv ? new Float32Array(next * 2) : null
  const written = new Uint8Array(next)
  for (let v = 0; v < count; v += 1) {
    const dst = remap[v]!
    if (written[dst]) continue
    written[dst] = 1
    new_p[dst * 3] = p[v * 3]!; new_p[dst * 3 + 1] = p[v * 3 + 1]!; new_p[dst * 3 + 2] = p[v * 3 + 2]!
    new_n[dst * 3] = n[v * 3]!; new_n[dst * 3 + 1] = n[v * 3 + 1]!; new_n[dst * 3 + 2] = n[v * 3 + 2]!
    if (uv && new_uv) {
      new_uv[dst * 2] = uv[v * 2]!; new_uv[dst * 2 + 1] = uv[v * 2 + 1]!
    }
  }
  const idx = mesh.indices
  for (let i = 0; i < idx.length; i += 1) idx[i] = remap[idx[i]!]!
  mesh.positions = new_p
  mesh.normals = new_n
  mesh.uvs = new_uv
  return removed
}

/** Drop triangles with repeated indices or (near-)zero area. Returns count removed. */
export function remove_degenerate_triangles(mesh: audit_mesh): number {
  const p = mesh.positions
  const idx = mesh.indices
  // Area epsilon scaled to the mesh extent so tiny-but-valid meshes survive.
  let ext = 0
  for (let i = 0; i < p.length; i += 1) ext = Math.max(ext, Math.abs(p[i]!))
  const eps2 = Math.max(1e-30, (ext * 1e-9) ** 2)
  const kept: number[] = []
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const i0 = idx[t]!, i1 = idx[t + 1]!, i2 = idx[t + 2]!
    if (i0 === i1 || i1 === i2 || i0 === i2) continue
    const a = i0 * 3, b = i1 * 3, c = i2 * 3
    const abx = p[b]! - p[a]!, aby = p[b + 1]! - p[a + 1]!, abz = p[b + 2]! - p[a + 2]!
    const acx = p[c]! - p[a]!, acy = p[c + 1]! - p[a + 1]!, acz = p[c + 2]! - p[a + 2]!
    const fx = aby * acz - abz * acy
    const fy = abz * acx - abx * acz
    const fz = abx * acy - aby * acx
    if (fx * fx + fy * fy + fz * fz <= eps2) continue
    kept.push(i0, i1, i2)
  }
  const removed = (idx.length - kept.length) / 3
  if (removed > 0) mesh.indices = Uint32Array.from(kept)
  return removed
}

/** Drop vertices not referenced by any triangle. Returns count removed. */
export function remove_unused_vertices(mesh: audit_mesh): number {
  const count = mesh.positions.length / 3
  const used = new Uint8Array(count)
  for (let i = 0; i < mesh.indices.length; i += 1) used[mesh.indices[i]!] = 1
  let next = 0
  const remap = new Uint32Array(count)
  for (let v = 0; v < count; v += 1) {
    if (used[v]) {
      remap[v] = next
      next += 1
    }
  }
  const removed = count - next
  if (removed === 0) return 0
  const new_p = new Float32Array(next * 3)
  const new_n = new Float32Array(next * 3)
  const new_uv = mesh.uvs ? new Float32Array(next * 2) : null
  for (let v = 0; v < count; v += 1) {
    if (!used[v]) continue
    const dst = remap[v]!
    new_p.set(mesh.positions.subarray(v * 3, v * 3 + 3), dst * 3)
    new_n.set(mesh.normals.subarray(v * 3, v * 3 + 3), dst * 3)
    if (mesh.uvs && new_uv) new_uv.set(mesh.uvs.subarray(v * 2, v * 2 + 2), dst * 2)
  }
  for (let i = 0; i < mesh.indices.length; i += 1) mesh.indices[i] = remap[mesh.indices[i]!]!
  mesh.positions = new_p
  mesh.normals = new_n
  mesh.uvs = new_uv
  return removed
}

// --- GLB export --------------------------------------------------------------

interface glb_buffer_view { buffer: 0; byteOffset: number; byteLength: number; target?: number }
interface glb_accessor {
  bufferView: number
  componentType: number
  count: number
  type: string
  min?: number[]
  max?: number[]
}

/** Serialize the (possibly optimized) asset as a self-contained binary glTF. */
export function encode_asset_glb(asset: audit_asset): ArrayBuffer {
  const chunks: Uint8Array[] = []
  const views: glb_buffer_view[] = []
  const accessors: glb_accessor[] = []
  let bin_length = 0

  const push_view = (data: Uint8Array, target?: number): number => {
    // glTF requires accessor offsets aligned to the component size; 4 covers all.
    const pad = (4 - (bin_length % 4)) % 4
    if (pad > 0) {
      chunks.push(new Uint8Array(pad))
      bin_length += pad
    }
    views.push({ buffer: 0, byteOffset: bin_length, byteLength: data.byteLength, ...(target ? { target } : {}) })
    chunks.push(data)
    bin_length += data.byteLength
    return views.length - 1
  }

  const push_f32_accessor = (data: Float32Array, components: 2 | 3, with_bounds: boolean): number => {
    const view = push_view(new Uint8Array(data.buffer, data.byteOffset, data.byteLength), 34962)
    const count = data.length / components
    const acc: glb_accessor = { bufferView: view, componentType: 5126, count, type: components === 3 ? 'VEC3' : 'VEC2' }
    if (with_bounds && count > 0) {
      const min = Array.from(data.subarray(0, components))
      const max = min.slice()
      for (let i = 0; i < count; i += 1) {
        for (let c = 0; c < components; c += 1) {
          const value = data[i * components + c]!
          if (value < min[c]!) min[c] = value
          if (value > max[c]!) max[c] = value
        }
      }
      acc.min = min
      acc.max = max
    }
    accessors.push(acc)
    return accessors.length - 1
  }

  const materials: object[] = []
  const meshes: object[] = []
  const nodes: object[] = []
  for (const mesh of asset.meshes) {
    const position = push_f32_accessor(mesh.positions, 3, true)
    const normal = push_f32_accessor(mesh.normals, 3, false)
    const uv = mesh.uvs ? push_f32_accessor(mesh.uvs, 2, false) : -1
    const index_view = push_view(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength), 34963)
    accessors.push({ bufferView: index_view, componentType: 5125, count: mesh.indices.length, type: 'SCALAR' })
    const indices = accessors.length - 1
    materials.push({
      name: mesh.material_name ?? `${mesh.name}_material`,
      pbrMetallicRoughness: { baseColorFactor: mesh.base_color, metallicFactor: 0, roughnessFactor: 0.9 },
      doubleSided: true,
    })
    const attributes: Record<string, number> = { POSITION: position, NORMAL: normal }
    if (uv >= 0) attributes.TEXCOORD_0 = uv
    meshes.push({ name: mesh.name, primitives: [{ attributes, indices, material: materials.length - 1, mode: 4 }] })
    nodes.push({ name: mesh.name, mesh: meshes.length - 1 })
  }

  const json = {
    asset: { version: '2.0', generator: '@liamlangli/ui asset_audit' },
    scene: 0,
    scenes: [{ name: asset.file_name, nodes: nodes.map((_, i) => i) }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews: views,
    buffers: [{ byteLength: bin_length }],
  }

  const encoder = new TextEncoder()
  let json_bytes = encoder.encode(JSON.stringify(json))
  const json_pad = (4 - (json_bytes.byteLength % 4)) % 4
  if (json_pad > 0) {
    const padded = new Uint8Array(json_bytes.byteLength + json_pad)
    padded.set(json_bytes)
    padded.fill(0x20, json_bytes.byteLength) // JSON chunks pad with spaces
    json_bytes = padded
  }
  const bin_pad = (4 - (bin_length % 4)) % 4

  const total = 12 + 8 + json_bytes.byteLength + 8 + bin_length + bin_pad
  const out = new ArrayBuffer(total)
  const dv = new DataView(out)
  const bytes = new Uint8Array(out)
  dv.setUint32(0, 0x46546c67, true) // 'glTF'
  dv.setUint32(4, 2, true)
  dv.setUint32(8, total, true)
  dv.setUint32(12, json_bytes.byteLength, true)
  dv.setUint32(16, 0x4e4f534a, true) // 'JSON'
  bytes.set(json_bytes, 20)
  let offset = 20 + json_bytes.byteLength
  dv.setUint32(offset, bin_length + bin_pad, true)
  dv.setUint32(offset + 4, 0x004e4942, true) // 'BIN\0'
  offset += 8
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return out
}

export function format_asset_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}
