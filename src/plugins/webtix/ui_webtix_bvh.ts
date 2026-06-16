// webtix — BVH builder + procedural geometry.
//
// This is the "better data structure" half of the WebGL2→WebGPU migration: the
// original engine packed the BVH into an RGB float texture and walked it in the
// fragment shader with fract()/floor() address math (see webtix's
// `texture-buffer.ts`). Here the tree is built into a flat, 32-byte-per-node
// array that uploads straight into a WGSL `var<storage, read> array<bvh_node>`
// and is indexed in O(1) — no texel addressing, no RGB stride juggling.
//
// Node layout (8 × f32 = 32 bytes, two vec4 lanes, matches the WGSL struct):
//   [0..2] bmin.xyz
//   [3]    count    inner: descendant node count (subtree size, self excluded)
//                   leaf : 0
//   [4..6] bmax.xyz
//   [7]    prim     leaf : reordered triangle index; inner: unused
//
// The tree is a depth-first linearization with a skip count on inner nodes, so
// the GPU walk is a single forward scan: descend on a box hit, jump past the
// whole subtree on a miss. No stack, no recursion on the GPU.

export interface webtix_mesh {
  /** Flat xyz vertex positions. */
  positions: Float32Array
  /** Flat xyz vertex normals (same vertex count as positions). */
  normals: Float32Array
  /** Flat triangle vertex indices (3 per triangle). */
  indices: Uint32Array
}

export interface webtix_bvh {
  /** 8 f32 per node — uploads directly as the BVH storage buffer. */
  nodes: Float32Array
  node_count: number
  /** Triangle indices reordered to match leaf `prim` references. */
  indices: Uint32Array
  bounds_min: [number, number, number]
  bounds_max: [number, number, number]
}

export type webtix_vec3 = [number, number, number]

export interface webtix_transform {
  /** Row-major 4x4 local-to-world matrix. Takes precedence when provided. */
  matrix?: ArrayLike<number>
  translate?: webtix_vec3
  position?: webtix_vec3
  scale?: number | webtix_vec3
  rotation_y?: number
}

export type webtix_scene_primitive =
  | { kind: 'sphere'; center?: webtix_vec3; radius?: number; transform?: webtix_transform }
  | { kind: 'box'; center?: webtix_vec3; size?: number | webtix_vec3; transform?: webtix_transform }
  | { kind: 'plane'; center?: webtix_vec3; size?: number | [number, number]; transform?: webtix_transform }
  | { kind: 'mesh'; mesh: webtix_mesh; transform?: webtix_transform }

export interface webtix_tlas {
  /** TLAS nodes; leaf `prim` indexes the packed instance array. */
  tlas_nodes: Float32Array
  tlas_node_count: number
  /** Mesh BLAS nodes for mesh instances only. Empty for all-analytic scenes. */
  blas_nodes: Float32Array
  blas_node_count: number
  /** 48 f32 per instance; matches WGSL `Instance`. */
  instances: Float32Array
  instance_count: number
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  bounds_min: webtix_vec3
  bounds_max: webtix_vec3
}

const NODE_STRIDE = 8 // f32 per BVH node
const BOX_STRIDE = 9 // [minx,miny,minz, maxx,maxy,maxz, cx,cy,cz] per triangle
export const WEBTIX_INSTANCE_STRIDE = 48 // 12 vec4 rows per instance

const PRIM_SPHERE = 0
const PRIM_BOX = 1
const PRIM_PLANE = 2
const PRIM_MESH = 3

// Build scratch — module-level so the recursion doesn't thread a context object
// (mirrors the original engine's structure, just retargeted to the packed layout).
let s_boxes: Float32Array
let s_order: Uint32Array
let s_nodes: Float32Array
let s_node_count = 0
let s_axis = 0

/** Build a binary BVH over an indexed triangle mesh. */
export function build_bvh(positions: Float32Array, indices: Uint32Array): webtix_bvh {
  const triangle_count = (indices.length / 3) | 0
  s_order = new Uint32Array(triangle_count)
  s_boxes = new Float32Array(triangle_count * BOX_STRIDE)
  // A binary tree over N leaves has at most 2N-1 nodes.
  s_nodes = new Float32Array(Math.max(1, triangle_count * 2 - 1) * NODE_STRIDE)

  const scene_min: [number, number, number] = [Infinity, Infinity, Infinity]
  const scene_max: [number, number, number] = [-Infinity, -Infinity, -Infinity]

  // Per-triangle bounding boxes + centroids.
  for (let t = 0; t < triangle_count; t += 1) {
    s_order[t] = t
    let minx = Infinity, miny = Infinity, minz = Infinity
    let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
    for (let k = 0; k < 3; k += 1) {
      const vi = indices[t * 3 + k]! * 3
      const px = positions[vi]!, py = positions[vi + 1]!, pz = positions[vi + 2]!
      if (px < minx) minx = px; if (py < miny) miny = py; if (pz < minz) minz = pz
      if (px > maxx) maxx = px; if (py > maxy) maxy = py; if (pz > maxz) maxz = pz
    }
    const b = t * BOX_STRIDE
    s_boxes[b] = minx; s_boxes[b + 1] = miny; s_boxes[b + 2] = minz
    s_boxes[b + 3] = maxx; s_boxes[b + 4] = maxy; s_boxes[b + 5] = maxz
    s_boxes[b + 6] = (minx + maxx) * 0.5
    s_boxes[b + 7] = (miny + maxy) * 0.5
    s_boxes[b + 8] = (minz + maxz) * 0.5
    if (minx < scene_min[0]) scene_min[0] = minx
    if (miny < scene_min[1]) scene_min[1] = miny
    if (minz < scene_min[2]) scene_min[2] = minz
    if (maxx > scene_max[0]) scene_max[0] = maxx
    if (maxy > scene_max[1]) scene_max[1] = maxy
    if (maxz > scene_max[2]) scene_max[2] = maxz
  }

  s_node_count = 0
  if (triangle_count > 0) split_balanced(0, triangle_count)

  const nodes = s_nodes.slice(0, s_node_count * NODE_STRIDE)

  // Reorder the index buffer so leaf `prim` (the sorted slot) reads its triangle.
  const reordered = new Uint32Array(indices.length)
  for (let i = 0; i < triangle_count; i += 1) {
    const src = s_order[i]! * 3
    reordered[i * 3] = indices[src]!
    reordered[i * 3 + 1] = indices[src + 1]!
    reordered[i * 3 + 2] = indices[src + 2]!
  }

  const result: webtix_bvh = {
    nodes,
    node_count: s_node_count,
    indices: reordered,
    bounds_min: triangle_count > 0 ? scene_min : [0, 0, 0],
    bounds_max: triangle_count > 0 ? scene_max : [0, 0, 0],
  }
  // Release scratch.
  s_boxes = s_order = s_nodes = undefined as unknown as Float32Array & Uint32Array
  return result
}

interface prepared_instance {
  kind: number
  world_from_local: Float32Array
  local_from_world: Float32Array
  normal_from_local: Float32Array
  bounds_min: webtix_vec3
  bounds_max: webtix_vec3
  blas_start: number
  blas_count: number
}

/** Build a TLAS over analytic primitives and mesh BLAS instances. */
export function build_tlas(scene: webtix_scene_primitive[] | { primitives: webtix_scene_primitive[] }): webtix_tlas {
  const primitives = Array.isArray(scene) ? scene : scene.primitives
  const prepared: prepared_instance[] = []
  const mesh_positions: Float32Array[] = []
  const mesh_normals: Float32Array[] = []
  const mesh_indices: Uint32Array[] = []
  const mesh_blas_nodes: Float32Array[] = []
  let vertex_base = 0
  let triangle_base = 0
  let blas_node_base = 0

  for (const primitive of primitives) {
    let kind = PRIM_SPHERE
    let local_min: webtix_vec3 = [-1, -1, -1]
    let local_max: webtix_vec3 = [1, 1, 1]
    let world_from_local = identity_mat4()
    let blas_start = 0
    let blas_count = 0

    if (primitive.kind === 'sphere') {
      kind = PRIM_SPHERE
      const c = primitive.center ?? [0, 0, 0]
      const r = Math.max(1e-6, primitive.radius ?? 1)
      world_from_local = mul_mat4(transform_mat4(primitive.transform), mul_mat4(translate_mat4(c), scale_mat4([r, r, r])))
    } else if (primitive.kind === 'box') {
      kind = PRIM_BOX
      const c = primitive.center ?? [0, 0, 0]
      const s = vec3_from_size(primitive.size ?? 1)
      world_from_local = mul_mat4(transform_mat4(primitive.transform), mul_mat4(translate_mat4(c), scale_mat4([s[0] * 0.5, s[1] * 0.5, s[2] * 0.5])))
    } else if (primitive.kind === 'plane') {
      kind = PRIM_PLANE
      const c = primitive.center ?? [0, 0, 0]
      const size = primitive.size ?? 1
      const sx = typeof size === 'number' ? size : size[0]
      const sz = typeof size === 'number' ? size : size[1]
      local_min = [-1, -0.0001, -1]
      local_max = [1, 0.0001, 1]
      world_from_local = mul_mat4(transform_mat4(primitive.transform), mul_mat4(translate_mat4(c), scale_mat4([sx * 0.5, 1, sz * 0.5])))
    } else {
      kind = PRIM_MESH
      const mesh = primitive.mesh
      const bvh = build_bvh(mesh.positions, mesh.indices)
      blas_start = blas_node_base
      blas_count = bvh.node_count
      const nodes = new Float32Array(bvh.nodes)
      for (let n = 0; n < bvh.node_count; n += 1) {
        const o = n * NODE_STRIDE
        if ((nodes[o + 3] ?? 0) < 0.5) nodes[o + 7] = (nodes[o + 7] ?? 0) + triangle_base
      }
      mesh_blas_nodes.push(nodes)
      const idx = new Uint32Array(bvh.indices.length)
      for (let i = 0; i < idx.length; i += 1) idx[i] = bvh.indices[i]! + vertex_base
      mesh_positions.push(mesh.positions)
      mesh_normals.push(mesh.normals)
      mesh_indices.push(idx)
      vertex_base += mesh.positions.length / 3
      triangle_base += bvh.indices.length / 3
      blas_node_base += bvh.node_count
      local_min = bvh.bounds_min
      local_max = bvh.bounds_max
      world_from_local = transform_mat4(primitive.transform)
    }

    const local_from_world = invert_mat4(world_from_local)
    const normal_from_local = transpose_mat4(local_from_world)
    const bounds = transform_bounds(local_min, local_max, world_from_local)
    prepared.push({ kind, world_from_local, local_from_world, normal_from_local, bounds_min: bounds.min, bounds_max: bounds.max, blas_start, blas_count })
  }

  const boxes = new Float32Array(prepared.length * BOX_STRIDE)
  let scene_min: webtix_vec3 = [Infinity, Infinity, Infinity]
  let scene_max: webtix_vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < prepared.length; i += 1) {
    const inst = prepared[i]!
    const o = i * BOX_STRIDE
    boxes[o] = inst.bounds_min[0]; boxes[o + 1] = inst.bounds_min[1]; boxes[o + 2] = inst.bounds_min[2]
    boxes[o + 3] = inst.bounds_max[0]; boxes[o + 4] = inst.bounds_max[1]; boxes[o + 5] = inst.bounds_max[2]
    boxes[o + 6] = (inst.bounds_min[0] + inst.bounds_max[0]) * 0.5
    boxes[o + 7] = (inst.bounds_min[1] + inst.bounds_max[1]) * 0.5
    boxes[o + 8] = (inst.bounds_min[2] + inst.bounds_max[2]) * 0.5
    scene_min = min_vec3(scene_min, inst.bounds_min)
    scene_max = max_vec3(scene_max, inst.bounds_max)
  }

  const built = build_nodes_from_boxes(boxes, prepared.length)
  const instances = pack_instances(prepared, built.order)

  return {
    tlas_nodes: built.nodes,
    tlas_node_count: built.node_count,
    blas_nodes: concat_f32(mesh_blas_nodes),
    blas_node_count: blas_node_base,
    instances,
    instance_count: prepared.length,
    positions: concat_f32(mesh_positions),
    normals: concat_f32(mesh_normals),
    indices: concat_u32(mesh_indices),
    bounds_min: prepared.length > 0 ? scene_min : [0, 0, 0],
    bounds_max: prepared.length > 0 ? scene_max : [0, 0, 0],
  }
}

/** Adapt the legacy single-mesh API into a one-instance TLAS without rebuilding the BLAS. */
export function build_tlas_from_bvh(bvh: webtix_bvh, positions: Float32Array, normals: Float32Array): webtix_tlas {
  const world_from_local = identity_mat4()
  const inst: prepared_instance = {
    kind: PRIM_MESH,
    world_from_local,
    local_from_world: identity_mat4(),
    normal_from_local: identity_mat4(),
    bounds_min: bvh.bounds_min,
    bounds_max: bvh.bounds_max,
    blas_start: 0,
    blas_count: bvh.node_count,
  }
  const tlas_nodes = new Float32Array(NODE_STRIDE)
  tlas_nodes[0] = bvh.bounds_min[0]; tlas_nodes[1] = bvh.bounds_min[1]; tlas_nodes[2] = bvh.bounds_min[2]
  tlas_nodes[3] = 0
  tlas_nodes[4] = bvh.bounds_max[0]; tlas_nodes[5] = bvh.bounds_max[1]; tlas_nodes[6] = bvh.bounds_max[2]
  tlas_nodes[7] = 0
  return {
    tlas_nodes,
    tlas_node_count: bvh.node_count > 0 ? 1 : 0,
    blas_nodes: bvh.nodes,
    blas_node_count: bvh.node_count,
    instances: pack_instances([inst], new Uint32Array([0])),
    instance_count: 1,
    positions,
    normals,
    indices: bvh.indices,
    bounds_min: bvh.bounds_min,
    bounds_max: bvh.bounds_max,
  }
}

function build_nodes_from_boxes(boxes: Float32Array, count: number): { nodes: Float32Array; node_count: number; order: Uint32Array } {
  s_order = new Uint32Array(count)
  for (let i = 0; i < count; i += 1) s_order[i] = i
  s_boxes = boxes
  s_nodes = new Float32Array(Math.max(1, count * 2 - 1) * NODE_STRIDE)
  s_node_count = 0
  if (count > 0) split_balanced(0, count)
  const nodes = s_nodes.slice(0, s_node_count * NODE_STRIDE)
  const order = s_order.slice(0, count)
  s_boxes = s_order = s_nodes = undefined as unknown as Float32Array & Uint32Array
  return { nodes, node_count: s_node_count, order }
}

function pack_instances(prepared: prepared_instance[], order: Uint32Array): Float32Array {
  const out = new Float32Array(Math.max(1, prepared.length) * WEBTIX_INSTANCE_STRIDE)
  for (let slot = 0; slot < prepared.length; slot += 1) {
    const inst = prepared[order[slot]!]!
    const o = slot * WEBTIX_INSTANCE_STRIDE
    out.set(inst.world_from_local.subarray(0, 16), o)
    out.set(inst.local_from_world.subarray(0, 16), o + 16)
    out.set(inst.normal_from_local.subarray(0, 12), o + 32)
    out[o + 44] = inst.kind
    out[o + 45] = inst.blas_start
    out[o + 46] = inst.blas_count
    out[o + 47] = 0
  }
  return out
}

function write_leaf(at: number, sorted_slot: number): void {
  const t = s_order[sorted_slot]! * BOX_STRIDE
  const o = at * NODE_STRIDE
  s_nodes[o] = s_boxes[t]!; s_nodes[o + 1] = s_boxes[t + 1]!; s_nodes[o + 2] = s_boxes[t + 2]!
  s_nodes[o + 3] = 0 // count 0 → leaf
  s_nodes[o + 4] = s_boxes[t + 3]!; s_nodes[o + 5] = s_boxes[t + 4]!; s_nodes[o + 6] = s_boxes[t + 5]!
  s_nodes[o + 7] = sorted_slot
}

function centroid_cmp(a: number, b: number): number {
  return s_boxes[a * BOX_STRIDE + 6 + s_axis]! - s_boxes[b * BOX_STRIDE + 6 + s_axis]!
}

// In-place median split on the longest axis (object-median BVH). Returns the
// number of nodes emitted for this subtree.
function split_balanced(from: number, to: number): number {
  const span = to - from
  if (span === 1) {
    write_leaf(s_node_count, from)
    s_node_count += 1
    return 1
  }
  if (span === 2) {
    write_leaf(s_node_count, from); s_node_count += 1
    write_leaf(s_node_count, to - 1); s_node_count += 1
    return 2
  }

  // Combined bounds of this range to pick the split axis.
  let minx = Infinity, miny = Infinity, minz = Infinity
  let maxx = -Infinity, maxy = -Infinity, maxz = -Infinity
  for (let i = from; i < to; i += 1) {
    const b = s_order[i]! * BOX_STRIDE
    if (s_boxes[b]! < minx) minx = s_boxes[b]!
    if (s_boxes[b + 1]! < miny) miny = s_boxes[b + 1]!
    if (s_boxes[b + 2]! < minz) minz = s_boxes[b + 2]!
    if (s_boxes[b + 3]! > maxx) maxx = s_boxes[b + 3]!
    if (s_boxes[b + 4]! > maxy) maxy = s_boxes[b + 4]!
    if (s_boxes[b + 5]! > maxz) maxz = s_boxes[b + 5]!
  }
  const ex = maxx - minx, ey = maxy - miny, ez = maxz - minz
  s_axis = ex >= ey && ex >= ez ? 0 : ey >= ez ? 1 : 2
  sort_range(from, to)

  const node_index = s_node_count
  const o = node_index * NODE_STRIDE
  s_nodes[o] = minx; s_nodes[o + 1] = miny; s_nodes[o + 2] = minz
  s_nodes[o + 4] = maxx; s_nodes[o + 5] = maxy; s_nodes[o + 6] = maxz
  s_nodes[o + 7] = 0
  s_node_count += 1

  const pivot = (from + span * 0.5) | 0
  const left = split_balanced(from, pivot)
  const right = split_balanced(pivot, to)
  s_nodes[o + 3] = left + right // descendant count (self excluded)
  return left + right + 1
}

// Insertion sort over the small-ish ranges produced by median splitting keeps the
// builder allocation-free; ranges shrink geometrically so this stays cheap.
function sort_range(from: number, to: number): void {
  for (let i = from + 1; i < to; i += 1) {
    const v = s_order[i]!
    let j = i - 1
    while (j >= from && centroid_cmp(s_order[j]!, v) > 0) {
      s_order[j + 1] = s_order[j]!
      j -= 1
    }
    s_order[j + 1] = v
  }
}

function concat_f32(parts: Float32Array[]): Float32Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Float32Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function concat_u32(parts: Uint32Array[]): Uint32Array {
  let total = 0
  for (const part of parts) total += part.length
  const out = new Uint32Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.length
  }
  return out
}

function min_vec3(a: webtix_vec3, b: webtix_vec3): webtix_vec3 {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.min(a[2], b[2])]
}

function max_vec3(a: webtix_vec3, b: webtix_vec3): webtix_vec3 {
  return [Math.max(a[0], b[0]), Math.max(a[1], b[1]), Math.max(a[2], b[2])]
}

function vec3_from_size(size: number | webtix_vec3): webtix_vec3 {
  return typeof size === 'number' ? [size, size, size] : size
}

function identity_mat4(): Float32Array {
  return Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
}

function translate_mat4(t: webtix_vec3): Float32Array {
  return Float32Array.from([1, 0, 0, t[0], 0, 1, 0, t[1], 0, 0, 1, t[2], 0, 0, 0, 1])
}

function scale_mat4(s: webtix_vec3): Float32Array {
  return Float32Array.from([s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0, 0, 0, 0, 1])
}

function rotate_y_mat4(radians: number): Float32Array {
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return Float32Array.from([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1])
}

function transform_mat4(transform?: webtix_transform): Float32Array {
  if (!transform) return identity_mat4()
  if (transform.matrix) {
    const out = identity_mat4()
    const src = Array.from(transform.matrix)
    for (let i = 0; i < Math.min(16, src.length); i += 1) out[i] = Number.isFinite(src[i]) ? src[i]! : out[i]!
    return out
  }
  const t = transform.position ?? transform.translate ?? [0, 0, 0]
  const s = typeof transform.scale === 'number' ? [transform.scale, transform.scale, transform.scale] as webtix_vec3 : transform.scale ?? [1, 1, 1]
  return mul_mat4(translate_mat4(t), mul_mat4(rotate_y_mat4(transform.rotation_y ?? 0), scale_mat4(s)))
}

function mul_mat4(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16)
  for (let r = 0; r < 4; r += 1) {
    for (let c = 0; c < 4; c += 1) {
      out[r * 4 + c] =
        a[r * 4]! * b[c]! +
        a[r * 4 + 1]! * b[4 + c]! +
        a[r * 4 + 2]! * b[8 + c]! +
        a[r * 4 + 3]! * b[12 + c]!
    }
  }
  return out
}

function transpose_mat4(m: Float32Array): Float32Array {
  return Float32Array.from([
    m[0]!, m[4]!, m[8]!, m[12]!,
    m[1]!, m[5]!, m[9]!, m[13]!,
    m[2]!, m[6]!, m[10]!, m[14]!,
    m[3]!, m[7]!, m[11]!, m[15]!,
  ])
}

function invert_mat4(m: Float32Array): Float32Array {
  const a00 = m[0]!, a01 = m[1]!, a02 = m[2]!, a03 = m[3]!
  const a10 = m[4]!, a11 = m[5]!, a12 = m[6]!, a13 = m[7]!
  const a20 = m[8]!, a21 = m[9]!, a22 = m[10]!, a23 = m[11]!
  const a30 = m[12]!, a31 = m[13]!, a32 = m[14]!, a33 = m[15]!
  const b00 = a00 * a11 - a01 * a10
  const b01 = a00 * a12 - a02 * a10
  const b02 = a00 * a13 - a03 * a10
  const b03 = a01 * a12 - a02 * a11
  const b04 = a01 * a13 - a03 * a11
  const b05 = a02 * a13 - a03 * a12
  const b06 = a20 * a31 - a21 * a30
  const b07 = a20 * a32 - a22 * a30
  const b08 = a20 * a33 - a23 * a30
  const b09 = a21 * a32 - a22 * a31
  const b10 = a21 * a33 - a23 * a31
  const b11 = a22 * a33 - a23 * a32
  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
  if (Math.abs(det) < 1e-12) return identity_mat4()
  det = 1.0 / det
  return Float32Array.from([
    (a11 * b11 - a12 * b10 + a13 * b09) * det,
    (a02 * b10 - a01 * b11 - a03 * b09) * det,
    (a31 * b05 - a32 * b04 + a33 * b03) * det,
    (a22 * b04 - a21 * b05 - a23 * b03) * det,
    (a12 * b08 - a10 * b11 - a13 * b07) * det,
    (a00 * b11 - a02 * b08 + a03 * b07) * det,
    (a32 * b02 - a30 * b05 - a33 * b01) * det,
    (a20 * b05 - a22 * b02 + a23 * b01) * det,
    (a10 * b10 - a11 * b08 + a13 * b06) * det,
    (a01 * b08 - a00 * b10 - a03 * b06) * det,
    (a30 * b04 - a31 * b02 + a33 * b00) * det,
    (a21 * b02 - a20 * b04 - a23 * b00) * det,
    (a11 * b07 - a10 * b09 - a12 * b06) * det,
    (a00 * b09 - a01 * b07 + a02 * b06) * det,
    (a31 * b01 - a30 * b03 - a32 * b00) * det,
    (a20 * b03 - a21 * b01 + a22 * b00) * det,
  ])
}

function transform_point(m: Float32Array, p: webtix_vec3): webtix_vec3 {
  return [
    m[0]! * p[0] + m[1]! * p[1] + m[2]! * p[2] + m[3]!,
    m[4]! * p[0] + m[5]! * p[1] + m[6]! * p[2] + m[7]!,
    m[8]! * p[0] + m[9]! * p[1] + m[10]! * p[2] + m[11]!,
  ]
}

function transform_bounds(min: webtix_vec3, max: webtix_vec3, m: Float32Array): { min: webtix_vec3; max: webtix_vec3 } {
  let out_min: webtix_vec3 = [Infinity, Infinity, Infinity]
  let out_max: webtix_vec3 = [-Infinity, -Infinity, -Infinity]
  for (let x = 0; x < 2; x += 1) {
    for (let y = 0; y < 2; y += 1) {
      for (let z = 0; z < 2; z += 1) {
        const p = transform_point(m, [x ? max[0] : min[0], y ? max[1] : min[1], z ? max[2] : min[2]])
        out_min = min_vec3(out_min, p)
        out_max = max_vec3(out_max, p)
      }
    }
  }
  return { min: out_min, max: out_max }
}

// --- procedural geometry ------------------------------------------------------
// Built-in scenes so the plugin renders out of the box with no asset pipeline.

function merge_meshes(meshes: webtix_mesh[]): webtix_mesh {
  let vtx = 0, idx = 0
  for (const m of meshes) { vtx += m.positions.length; idx += m.indices.length }
  const positions = new Float32Array(vtx)
  const normals = new Float32Array(vtx)
  const indices = new Uint32Array(idx)
  let vo = 0, io = 0, base = 0
  for (const m of meshes) {
    positions.set(m.positions, vo)
    normals.set(m.normals, vo)
    for (let i = 0; i < m.indices.length; i += 1) indices[io + i] = m.indices[i]! + base
    base += m.positions.length / 3
    vo += m.positions.length
    io += m.indices.length
  }
  return { positions, normals, indices }
}

export function make_sphere(cx: number, cy: number, cz: number, radius: number, rings = 32, sectors = 48): webtix_mesh {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  for (let r = 0; r <= rings; r += 1) {
    const phi = (r / rings) * Math.PI
    const sp = Math.sin(phi), cp = Math.cos(phi)
    for (let s = 0; s <= sectors; s += 1) {
      const theta = (s / sectors) * Math.PI * 2
      const nx = sp * Math.cos(theta), ny = cp, nz = sp * Math.sin(theta)
      positions.push(cx + nx * radius, cy + ny * radius, cz + nz * radius)
      normals.push(nx, ny, nz)
    }
  }
  const stride = sectors + 1
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < sectors; s += 1) {
      const a = r * stride + s, b = a + stride
      indices.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) }
}

export function make_box(cx: number, cy: number, cz: number, sx: number, sy: number, sz: number): webtix_mesh {
  const hx = sx / 2, hy = sy / 2, hz = sz / 2
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  // Each face: outward normal n, plus in-plane edge vectors a, b. The four
  // corners are face_center ± a ± b, where face_center = center + n·half.
  const add_face = (
    nx: number, ny: number, nz: number,
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
  ): void => {
    const fcx = cx + nx * hx, fcy = cy + ny * hy, fcz = cz + nz * hz
    const base = positions.length / 3
    const corners: [number, number, number][] = [
      [fcx - ax - bx, fcy - ay - by, fcz - az - bz],
      [fcx + ax - bx, fcy + ay - by, fcz + az - bz],
      [fcx + ax + bx, fcy + ay + by, fcz + az + bz],
      [fcx - ax + bx, fcy - ay + by, fcz - az + bz],
    ]
    for (const c of corners) { positions.push(c[0], c[1], c[2]); normals.push(nx, ny, nz) }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
  }
  add_face(0, 0, 1, hx, 0, 0, 0, hy, 0) // +z
  add_face(0, 0, -1, -hx, 0, 0, 0, hy, 0) // -z
  add_face(1, 0, 0, 0, 0, -hz, 0, hy, 0) // +x
  add_face(-1, 0, 0, 0, 0, hz, 0, hy, 0) // -x
  add_face(0, 1, 0, hx, 0, 0, 0, 0, hz) // +y
  add_face(0, -1, 0, hx, 0, 0, 0, 0, -hz) // -y
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) }
}

export function make_plane(cx: number, cy: number, cz: number, size: number): webtix_mesh {
  const h = size / 2
  const positions = new Float32Array([
    cx - h, cy, cz - h, cx + h, cy, cz - h, cx + h, cy, cz + h, cx - h, cy, cz + h,
  ])
  const normals = new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0])
  const indices = new Uint32Array([0, 1, 2, 0, 2, 3])
  return { positions, normals, indices }
}

export function make_torus(cx: number, cy: number, cz: number, radius: number, tube: number, rings = 48, sides = 32): webtix_mesh {
  const positions: number[] = []
  const normals: number[] = []
  const indices: number[] = []
  for (let r = 0; r <= rings; r += 1) {
    const u = (r / rings) * Math.PI * 2
    const cu = Math.cos(u), su = Math.sin(u)
    for (let s = 0; s <= sides; s += 1) {
      const v = (s / sides) * Math.PI * 2
      const cv = Math.cos(v), sv = Math.sin(v)
      const nx = cv * cu, ny = sv, nz = cv * su
      positions.push(cx + (radius + tube * cv) * cu, cy + tube * sv, cz + (radius + tube * cv) * su)
      normals.push(nx, ny, nz)
    }
  }
  const stride = sides + 1
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < sides; s += 1) {
      const a = r * stride + s, b = a + stride
      indices.push(a, b, a + 1, a + 1, b, b + 1)
    }
  }
  return { positions: new Float32Array(positions), normals: new Float32Array(normals), indices: new Uint32Array(indices) }
}

export type webtix_scene_id = 'sphere' | 'torus' | 'box' | 'spheres'

export const WEBTIX_SCENES: { id: webtix_scene_id; label: string }[] = [
  { id: 'sphere', label: 'Sphere' },
  { id: 'torus', label: 'Torus' },
  { id: 'box', label: 'Box' },
  { id: 'spheres', label: 'Spheres' },
]

export function build_scene(id: webtix_scene_id): webtix_mesh {
  const ground = make_plane(0, -1, 0, 12)
  switch (id) {
    case 'box':
      return merge_meshes([make_box(0, -0.1, 0, 1.6, 1.6, 1.6), ground])
    case 'torus':
      return merge_meshes([make_torus(0, 0, 0, 0.85, 0.32), ground])
    case 'spheres': {
      const meshes: webtix_mesh[] = [ground]
      for (let i = -1; i <= 1; i += 1) {
        for (let j = -1; j <= 1; j += 1) {
          meshes.push(make_sphere(i * 1.5, -0.4, j * 1.5, 0.55, 20, 28))
        }
      }
      return merge_meshes(meshes)
    }
    case 'sphere':
    default:
      return merge_meshes([make_sphere(0, -0.1, 0, 0.9), ground])
  }
}

export function build_tlas_scene(id: webtix_scene_id): webtix_scene_primitive[] {
  const ground: webtix_scene_primitive = { kind: 'plane', center: [0, -1, 0], size: 12 }
  switch (id) {
    case 'box':
      return [{ kind: 'box', center: [0, -0.1, 0], size: [1.6, 1.6, 1.6] }, ground]
    case 'torus':
      return [{ kind: 'mesh', mesh: make_torus(0, 0, 0, 0.85, 0.32) }, ground]
    case 'spheres': {
      const primitives: webtix_scene_primitive[] = [ground]
      for (let i = -1; i <= 1; i += 1) {
        for (let j = -1; j <= 1; j += 1) {
          primitives.push({ kind: 'sphere', center: [i * 1.5, -0.4, j * 1.5], radius: 0.55 })
        }
      }
      return primitives
    }
    case 'sphere':
    default:
      return [{ kind: 'sphere', center: [0, -0.1, 0], radius: 0.9 }, ground]
  }
}
