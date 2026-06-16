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

const NODE_STRIDE = 8 // f32 per BVH node
const BOX_STRIDE = 9 // [minx,miny,minz, maxx,maxy,maxz, cx,cy,cz] per triangle

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
