import type { audit_asset, audit_bounds, audit_mesh } from './ui_asset_audit_data'
import { compute_asset_stats, decode_asset_textures, recompute_mesh_normals } from './ui_asset_audit_data'
import { parse_gltf_asset } from './ui_asset_audit_gltf'
import { build_avatar_skeleton_mesh, type avatar_build_result, type avatar_joint_offsets, type avatar_params, type avatar_skeleton } from './ui_avatar_body'

export type avatar_template_key = 'male' | 'female'

export interface avatar_template_asset {
  asset: audit_asset
  skeleton: avatar_skeleton
}

export interface avatar_template_library {
  male: avatar_template_asset
  female: avatar_template_asset
}

interface template_gltf_json {
  scene?: number
  scenes?: { nodes?: number[] }[]
  nodes?: template_gltf_node[]
  skins?: { name?: string; joints?: number[]; skeleton?: number }[]
}

interface template_gltf_node {
  name?: string
  children?: number[]
  matrix?: number[]
  translation?: number[]
  rotation?: number[]
  scale?: number[]
}

type mat4 = Float64Array

const TEMPLATE_BASE_URL = `${import.meta.env.BASE_URL}avatar_base/`

const TEMPLATE_FILES: Record<avatar_template_key, { gltf: string; externals: string[]; label: string }> = {
  male: {
    gltf: 'Superhero_Male_FullBody.gltf',
    externals: [
      'Superhero_Male_FullBody.bin',
      'T_Hair_1_BaseColor.png',
      'T_Eye_Brown.png',
      'T_Superhero_Male_Dark.png',
    ],
    label: 'Superhero Male',
  },
  female: {
    gltf: 'Superhero_Female_FullBody.gltf',
    externals: [
      'Superhero_Female_FullBody.bin',
      'T_Hair_2_BaseColor.png',
      'T_Eye_Brown.png',
      'T_Superhero_Female_Dark_BaseColor.png',
    ],
    label: 'Superhero Female',
  },
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

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

function node_local_matrix(node: template_gltf_node): mat4 {
  return node.matrix ? Float64Array.from(node.matrix) : mat4_from_trs(node.translation ?? [0, 0, 0], node.rotation ?? [0, 0, 0, 1], node.scale ?? [1, 1, 1])
}

function extract_template_skeleton(gltf: ArrayBuffer): avatar_skeleton {
  const json = JSON.parse(new TextDecoder().decode(gltf)) as template_gltf_json
  const skin = json.skins?.[0]
  const joint_indices = skin?.joints ?? []
  const joint_set = new Set(joint_indices)
  const world = new Map<number, mat4>()
  const visit = (index: number, parent: mat4, depth: number): void => {
    if (depth > 256) return
    const node = json.nodes?.[index]
    if (!node) return
    const matrix = mat4_multiply(parent, node_local_matrix(node))
    world.set(index, matrix)
    for (const child of node.children ?? []) visit(child, matrix, depth + 1)
  }
  const scene = json.scenes?.[json.scene ?? 0] ?? json.scenes?.[0]
  const roots = scene?.nodes ?? (json.nodes ?? []).map((_, i) => i)
  for (const root of roots) visit(root, mat4_identity(), 0)

  const to_local = new Map<number, number>()
  const joints = joint_indices.map((node_index, i) => {
    to_local.set(node_index, i)
    const node = json.nodes?.[node_index]
    const matrix = world.get(node_index) ?? mat4_identity()
    return {
      name: node?.name ?? `joint_${node_index}`,
      parent: -1,
      x: matrix[12] ?? 0,
      y: matrix[13] ?? 0,
      z: matrix[14] ?? 0,
    }
  })

  const find_joint_parent = (node_index: number): number => {
    for (let i = 0; i < (json.nodes?.length ?? 0); i += 1) {
      const children = json.nodes?.[i]?.children ?? []
      if (!children.includes(node_index)) continue
      const local_parent = to_local.get(i)
      if (local_parent !== undefined) return local_parent
      return find_joint_parent(i)
    }
    return -1
  }
  for (const node_index of joint_indices) {
    const local = to_local.get(node_index)!
    joints[local]!.parent = find_joint_parent(node_index)
  }

  const bones: [number, number][] = []
  for (let i = 0; i < joints.length; i += 1) {
    if (joints[i]!.parent >= 0) bones.push([joints[i]!.parent, i])
  }
  return { joints, bones }
}

async function fetch_bytes(name: string): Promise<ArrayBuffer> {
  const res = await fetch(`${TEMPLATE_BASE_URL}${name}`)
  if (!res.ok) throw new Error(`${name}: ${res.status} ${res.statusText}`)
  return res.arrayBuffer()
}

async function load_one_template(key: avatar_template_key): Promise<avatar_template_asset> {
  const spec = TEMPLATE_FILES[key]
  const [gltf, ...external_bytes] = await Promise.all([spec.gltf, ...spec.externals].map(fetch_bytes))
  const external_files = new Map<string, ArrayBuffer>()
  for (let i = 0; i < spec.externals.length; i += 1) external_files.set(spec.externals[i]!.toLowerCase(), external_bytes[i]!)
  const asset = parse_gltf_asset(gltf, spec.gltf, { external_files })
  await decode_asset_textures(asset)
  return { asset, skeleton: extract_template_skeleton(gltf) }
}

export async function load_avatar_template_library(): Promise<avatar_template_library> {
  const [male, female] = await Promise.all([load_one_template('male'), load_one_template('female')])
  return { male, female }
}

function clone_scaled_mesh(mesh: audit_mesh, bounds: audit_bounds, params: avatar_params, key: avatar_template_key): audit_mesh {
  const t = template_scale(bounds, params, key)
  const positions = new Float32Array(mesh.positions.length)
  for (let i = 0; i + 2 < mesh.positions.length; i += 3) {
    positions[i] = (mesh.positions[i]! - t.cx) * t.sx
    positions[i + 1] = (mesh.positions[i + 1]! - t.min_y) * t.sy
    positions[i + 2] = (mesh.positions[i + 2]! - t.cz) * t.sz
  }
  const normals = new Float32Array(mesh.normals.length)
  if (mesh.normals.length === mesh.positions.length) {
    for (let i = 0; i + 2 < mesh.normals.length; i += 3) {
      let nx = mesh.normals[i]! / t.sx
      let ny = mesh.normals[i + 1]! / t.sy
      let nz = mesh.normals[i + 2]! / t.sz
      const len = Math.hypot(nx, ny, nz)
      if (len > 1e-12) {
        nx /= len
        ny /= len
        nz /= len
      } else {
        nx = 0
        ny = 1
        nz = 0
      }
      normals[i] = nx
      normals[i + 1] = ny
      normals[i + 2] = nz
    }
  }
  const out: audit_mesh = {
    name: mesh.name,
    positions,
    normals,
    uvs: mesh.uvs ? new Float32Array(mesh.uvs) : null,
    indices: new Uint32Array(mesh.indices),
    base_color: [...mesh.base_color],
    material_name: mesh.material_name,
    normals_generated: mesh.normals.length !== mesh.positions.length,
    albedo_bytes: mesh.albedo_bytes,
    albedo_mime: mesh.albedo_mime,
    albedo: mesh.albedo,
  }
  if (out.normals_generated) recompute_mesh_normals(out)
  return out
}

function template_scale(bounds: audit_bounds, params: avatar_params, key: avatar_template_key): { cx: number; min_y: number; cz: number; sx: number; sy: number; sz: number } {
  const source_h = Math.max(1e-6, bounds.max[1] - bounds.min[1])
  const base = params.height / source_h
  const build_bias = key === 'male' ? params.build : 1 - params.build
  const shoulder = lerp(0.9, 1.12, params.shoulder_width)
  const hip = lerp(0.9, 1.12, params.hip_width)
  const girth = lerp(0.88, 1.18, params.limb_thickness)
  const mass = 1 + params.muscle * 0.08 + params.fat * 0.14
  return {
    cx: (bounds.min[0] + bounds.max[0]) * 0.5,
    min_y: bounds.min[1],
    cz: (bounds.min[2] + bounds.max[2]) * 0.5,
    sx: base * lerp(hip, shoulder, build_bias) * girth * mass,
    sy: base,
    sz: base * lerp(0.92, 1.16, params.fat) * lerp(0.94, 1.08, params.muscle),
  }
}

function transform_template_skeleton(source: avatar_skeleton, bounds: audit_bounds, params: avatar_params, key: avatar_template_key, joint_offsets?: avatar_joint_offsets): avatar_skeleton {
  const t = template_scale(bounds, params, key)
  const joints = source.joints.map((joint) => {
    const offset = joint_offsets?.[joint.name]
    return {
      name: joint.name,
      parent: joint.parent,
      x: (joint.x - t.cx) * t.sx + (offset?.[0] ?? 0),
      y: (joint.y - t.min_y) * t.sy + (offset?.[1] ?? 0),
      z: (joint.z - t.cz) * t.sz + (offset?.[2] ?? 0),
    }
  })
  return { joints, bones: source.bones.map((bone) => [bone[0], bone[1]]) }
}

function merge_meshes(meshes: audit_mesh[]): audit_mesh {
  let vertex_count = 0
  let index_count = 0
  for (const mesh of meshes) {
    vertex_count += mesh.positions.length / 3
    index_count += mesh.indices.length
  }
  const positions = new Float32Array(vertex_count * 3)
  const normals = new Float32Array(vertex_count * 3)
  const indices = new Uint32Array(index_count)
  let vo = 0
  let io = 0
  for (const mesh of meshes) {
    positions.set(mesh.positions, vo * 3)
    normals.set(mesh.normals, vo * 3)
    for (let i = 0; i < mesh.indices.length; i += 1) indices[io + i] = mesh.indices[i]! + vo
    vo += mesh.positions.length / 3
    io += mesh.indices.length
  }
  return {
    name: 'avatar_template',
    positions,
    normals,
    uvs: null,
    indices,
    base_color: [0.8, 0.8, 0.8, 1],
    material_name: 'avatar_template',
    normals_generated: true,
    albedo_bytes: null,
    albedo_mime: null,
    albedo: null,
  }
}

export function choose_avatar_template(params: avatar_params): avatar_template_key {
  return params.build >= 0.5 ? 'male' : 'female'
}

export function avatar_template_label(key: avatar_template_key): string {
  return TEMPLATE_FILES[key].label
}

export function generate_template_avatar(
  params: avatar_params,
  library: avatar_template_library,
  template: avatar_template_key = choose_avatar_template(params),
  joint_offsets?: avatar_joint_offsets,
): avatar_build_result {
  const started = performance.now()
  const template_asset = library[template]
  const asset = template_asset.asset
  const stats = compute_asset_stats(asset)
  const bounds = stats.bounds ?? { min: [-0.5, 0, -0.5], max: [0.5, 1, 0.5] }
  const meshes = asset.meshes.map((mesh) => clone_scaled_mesh(mesh, bounds, params, template))
  const merged = merge_meshes(meshes)
  const out_stats = compute_asset_stats({
    file_name: 'avatar_template',
    format: 'gltf',
    file_bytes: 0,
    meshes,
    source: asset.source,
    warnings: [],
    geometry_version: 0,
  })
  const skeleton = transform_template_skeleton(template_asset.skeleton, bounds, params, template, joint_offsets)
  return {
    mesh: merged,
    meshes,
    bounds: out_stats.bounds ?? { min: [-0.5, 0, -0.5], max: [0.5, params.height, 0.5] },
    cells: [0, 0, 0],
    generation_ms: performance.now() - started,
    skeleton,
    skeleton_mesh: build_avatar_skeleton_mesh(skeleton, params.height),
    source: 'template',
    template_name: avatar_template_label(template),
  }
}
