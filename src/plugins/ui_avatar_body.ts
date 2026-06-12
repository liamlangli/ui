// Avatar body — procedural human mesh generation from a parametric skeleton.
//
// No template mesh anywhere: the body is built bones-first, exactly the
// "true procedural" pipeline —
//
//   body parameters
//        ↓
//   parametric skeleton (joint positions + hierarchy from height/proportions)
//        ↓
//   anatomical SDF volumes attached to the bones (rounded cones for limbs,
//   ellipsoids for head/torso/muscle masses, smooth-union blended)
//        ↓
//   surface-nets polygonization of the combined field
//        ↓
//   triangle mesh with SDF-gradient normals
//
// A skeleton alone does not uniquely define a body (a sprinter and a
// powerlifter can share bone lengths), so the volume layer is driven by extra
// parameters — muscle, fat, build (feminine ↔ masculine), shoulder/hip span,
// limb girth — that scale each part's radii independently of the bones.
//
// The output is an `audit_mesh`, so the asset-audit 3D viewer renders it and
// `encode_asset_glb` exports it without any conversion.

import { type audit_bounds, type audit_mesh, recompute_mesh_normals } from './ui_asset_audit_data'

// --- parameters --------------------------------------------------------------

/** Everything the generator needs. All 0..1 sliders are 0.5-neutral. */
export interface avatar_params {
  /** Overall stature in meters (feet at y=0, +y up). */
  height: number
  /** 0 = feminine frame (narrow shoulders, wide hips), 1 = masculine. */
  build: number
  /** Muscle mass: bulks deltoids, arms, thighs, calves, chest. */
  muscle: number
  /** Body fat: widens waist/belly/hips and softens every limb. */
  fat: number
  /** Shoulder span. */
  shoulder_width: number
  /** Pelvis span. */
  hip_width: number
  /** Torso length (hips → neck) relative to height. */
  torso_length: number
  /** Arm length (shoulder → wrist) relative to height. */
  arm_length: number
  /** Leg length (hips → floor) relative to height. */
  leg_length: number
  /** Global limb girth multiplier. */
  limb_thickness: number
  /** Skull scale. */
  head_size: number
  /** How softly adjacent volumes fuse (smooth-union radius). */
  blend: number
  /** Surface-nets grid cells along the tallest axis. */
  resolution: number
}

export function create_avatar_params(): avatar_params {
  return {
    height: 1.75,
    build: 0.5,
    muscle: 0.35,
    fat: 0.3,
    shoulder_width: 0.5,
    hip_width: 0.5,
    torso_length: 0.5,
    arm_length: 0.5,
    leg_length: 0.5,
    limb_thickness: 0.5,
    head_size: 0.5,
    blend: 0.45,
    resolution: 72,
  }
}

export type avatar_preset_name = 'Average' | 'Female' | 'Male' | 'Athlete' | 'Heavy' | 'Slim' | 'Child'

export const AVATAR_PRESETS: { name: avatar_preset_name; params: Partial<avatar_params> }[] = [
  { name: 'Average', params: {} },
  { name: 'Female', params: { height: 1.66, build: 0.12, muscle: 0.3, fat: 0.34, shoulder_width: 0.36, hip_width: 0.68, limb_thickness: 0.42 } },
  { name: 'Male', params: { height: 1.8, build: 0.88, muscle: 0.45, fat: 0.32, shoulder_width: 0.66, hip_width: 0.38, limb_thickness: 0.55 } },
  { name: 'Athlete', params: { height: 1.83, build: 0.78, muscle: 0.85, fat: 0.12, shoulder_width: 0.74, hip_width: 0.4, limb_thickness: 0.6 } },
  { name: 'Heavy', params: { height: 1.76, build: 0.6, muscle: 0.4, fat: 0.92, shoulder_width: 0.6, hip_width: 0.66, limb_thickness: 0.72 } },
  { name: 'Slim', params: { height: 1.74, build: 0.42, muscle: 0.15, fat: 0.08, shoulder_width: 0.42, hip_width: 0.42, limb_thickness: 0.28 } },
  { name: 'Child', params: { height: 1.2, build: 0.4, muscle: 0.2, fat: 0.45, shoulder_width: 0.4, hip_width: 0.45, torso_length: 0.62, leg_length: 0.38, limb_thickness: 0.45, head_size: 0.85 } },
]

export function apply_avatar_preset(params: avatar_params, name: avatar_preset_name): void {
  const preset = AVATAR_PRESETS.find((p) => p.name === name)
  if (!preset) return
  Object.assign(params, create_avatar_params(), preset.params)
}

// --- skeleton ------------------------------------------------------------------

export interface avatar_joint {
  name: string
  /** Index into the joint array, or -1 for the root. */
  parent: number
  x: number
  y: number
  z: number
}

export interface avatar_skeleton {
  joints: avatar_joint[]
  /** Pairs of joint indices (parent, child) — every bone segment to draw. */
  bones: [number, number][]
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

/**
 * Place the humanoid joints from the proportion parameters. Classic ~7.5-head
 * figure as the base, then leg/torso/arm length and span sliders move the
 * joints. Everything downstream (volumes, mesh) hangs off these positions.
 */
export function build_avatar_skeleton(p: avatar_params): avatar_skeleton {
  const H = p.height
  const leg = lerp(0.88, 1.12, p.leg_length)
  const torso = lerp(0.88, 1.12, p.torso_length)
  const arm = lerp(0.86, 1.14, p.arm_length)

  const hips_y = 0.52 * H * leg
  const chest_y = hips_y + 0.185 * H * torso
  const neck_y = hips_y + 0.27 * H * torso
  // Places the cranium crown at ≈ the height parameter for a neutral head size.
  const head_y = neck_y + 0.12 * H * lerp(0.9, 1.1, p.head_size)
  const shoulder_y = neck_y - 0.012 * H
  const shoulder_x = (0.095 + 0.055 * p.shoulder_width + 0.02 * p.build + 0.012 * p.muscle) * H
  const hip_x = (0.045 + 0.03 * p.hip_width + 0.015 * (1 - p.build)) * H

  const upper_arm = 0.155 * H * arm
  const fore_arm = 0.135 * H * arm
  const elbow_y = shoulder_y - upper_arm
  const wrist_y = elbow_y - fore_arm
  const arm_out = 0.012 * H // arms hang with a slight outward lean

  const knee_y = hips_y * 0.5
  const ankle_y = 0.045 * H

  const joints: avatar_joint[] = []
  const j = (name: string, parent: number, x: number, y: number, z: number): number => {
    joints.push({ name, parent, x, y, z })
    return joints.length - 1
  }

  const hips = j('hips', -1, 0, hips_y, 0)
  const spine = j('spine', hips, 0, (hips_y + chest_y) / 2, 0)
  const chest = j('chest', spine, 0, chest_y, 0)
  const neck = j('neck', chest, 0, neck_y, 0)
  j('head', neck, 0, head_y, 0)

  for (const side of [-1, 1] as const) {
    const tag = side < 0 ? 'l' : 'r'
    const clavicle = j(`clavicle_${tag}`, chest, side * shoulder_x * 0.35, shoulder_y, 0)
    const shoulder = j(`shoulder_${tag}`, clavicle, side * shoulder_x, shoulder_y, 0)
    const elbow = j(`elbow_${tag}`, shoulder, side * (shoulder_x + arm_out), elbow_y, 0)
    const wrist = j(`wrist_${tag}`, elbow, side * (shoulder_x + arm_out * 1.6), wrist_y, 0.01 * H)
    j(`hand_${tag}`, wrist, side * (shoulder_x + arm_out * 1.8), wrist_y - 0.075 * H, 0.015 * H)

    const thigh = j(`thigh_${tag}`, hips, side * hip_x, hips_y - 0.02 * H, 0)
    const knee = j(`knee_${tag}`, thigh, side * hip_x * 0.92, knee_y, 0.004 * H)
    const ankle = j(`ankle_${tag}`, knee, side * hip_x * 0.88, ankle_y, -0.01 * H)
    j(`foot_${tag}`, ankle, side * hip_x * 0.9, 0.02 * H, 0.085 * H)
  }

  const bones: [number, number][] = []
  for (let i = 0; i < joints.length; i += 1) {
    if (joints[i]!.parent >= 0) bones.push([joints[i]!.parent, i])
  }
  return { joints, bones }
}

// --- SDF volume layer ------------------------------------------------------------

// Two primitive kinds cover the whole body: rounded cones (tapered capsules)
// sweep the bones, ellipsoids model the head and the soft masses the skeleton
// alone can't describe (chest, belly, glutes, deltoids, calves, bust).
const KIND_CONE = 0
const KIND_ELLIPSOID = 1

interface body_part {
  kind: number
  // cone: a/b endpoints + end radii · ellipsoid: a = center, (ra=rx, bx=ry, by=rz)
  ax: number
  ay: number
  az: number
  bx: number
  by: number
  bz: number
  ra: number
  rb: number
  /** Per-part smooth-union radius — joints fuse softly, the skull stays crisp. */
  blend: number
}

/** IQ's exact rounded cone: a capsule whose radius tapers from ra at a to rb at b. */
function sd_round_cone(px: number, py: number, pz: number, part: body_part): number {
  const bax = part.bx - part.ax
  const bay = part.by - part.ay
  const baz = part.bz - part.az
  const l2 = bax * bax + bay * bay + baz * baz
  const rr = part.ra - part.rb
  const a2 = l2 - rr * rr
  const il2 = 1 / l2
  const pax = px - part.ax
  const pay = py - part.ay
  const paz = pz - part.az
  const y = pax * bax + pay * bay + paz * baz
  const z = y - l2
  const qx = pax * l2 - bax * y
  const qy = pay * l2 - bay * y
  const qz = paz * l2 - baz * y
  const x2 = qx * qx + qy * qy + qz * qz
  const y2 = y * y * l2
  const z2 = z * z * l2
  const k = Math.sign(rr) * rr * rr * x2
  if (Math.sign(z) * a2 * z2 > k) return Math.sqrt(x2 + z2) * il2 - part.rb
  if (Math.sign(y) * a2 * y2 < k) return Math.sqrt(x2 + y2) * il2 - part.ra
  return (Math.sqrt(x2 * a2 * il2) + y * rr) * il2 - part.ra
}

/** IQ's ellipsoid distance bound — exact enough for blended organic volumes. */
function sd_ellipsoid(px: number, py: number, pz: number, part: body_part): number {
  const dx = (px - part.ax) / part.ra
  const dy = (py - part.ay) / part.bx
  const dz = (pz - part.az) / part.by
  const k0 = Math.sqrt(dx * dx + dy * dy + dz * dz)
  const k1x = dx / part.ra
  const k1y = dy / part.bx
  const k1z = dz / part.by
  const k1 = Math.sqrt(k1x * k1x + k1y * k1y + k1z * k1z)
  return k1 > 1e-12 ? (k0 * (k0 - 1)) / k1 : k0 - 1
}

/** Polynomial smooth-min: blends two distances over radius k. */
function smin(a: number, b: number, k: number): number {
  if (k <= 1e-6) return Math.min(a, b)
  const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (b - a)) / k))
  return b + (a - b) * h - k * h * (1 - h)
}

/**
 * Attach the anatomical volumes to the skeleton. Radii are fractions of body
 * height scaled by girth/muscle/fat/build, so the same skeleton can carry a
 * sprinter or a powerlifter.
 */
export function build_avatar_volumes(p: avatar_params, skeleton: avatar_skeleton): body_part[] {
  const H = p.height
  const joint = new Map<string, avatar_joint>()
  for (const item of skeleton.joints) joint.set(item.name, item)
  const at = (name: string): avatar_joint => joint.get(name)!

  const girth = lerp(0.78, 1.28, p.limb_thickness)
  const bulk = 1 + p.muscle * 0.22 + p.fat * 0.3
  const soft = 1 + p.fat * 0.45
  const base_blend = lerp(0.012, 0.045, p.blend) * H

  const parts: body_part[] = []
  const cone = (a: { x: number; y: number; z: number }, b: { x: number; y: number; z: number }, ra: number, rb: number, blend = base_blend): void => {
    parts.push({ kind: KIND_CONE, ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, ra, rb, blend })
  }
  const ellipsoid = (cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, blend = base_blend): void => {
    parts.push({ kind: KIND_ELLIPSOID, ax: cx, ay: cy, az: cz, bx: ry, by: rz, bz: 0, ra: rx, rb: 0, blend })
  }

  const hips = at('hips')
  const chest = at('chest')
  const neck = at('neck')
  const head = at('head')

  // -- axial body ------------------------------------------------------------
  const hip_half = Math.abs(at('thigh_r').x)
  const shoulder_half = Math.abs(at('shoulder_r').x)
  const waist_y = lerp(hips.y, chest.y, 0.45)
  // Waist pinches on the feminine side and balloons with fat.
  const waist_r = (0.062 + p.fat * 0.05 - (1 - p.build) * 0.014 + p.muscle * 0.008) * H
  const chest_w = shoulder_half * 0.86 + p.fat * 0.012 * H
  const chest_d = (0.052 + p.muscle * 0.016 + p.fat * 0.02) * H

  // Pelvis block + spine column + ribcage, fused into one trunk.
  ellipsoid(hips.x, hips.y - 0.01 * H, hips.z, hip_half + 0.045 * H * soft, 0.062 * H, (0.05 + p.fat * 0.02) * H)
  cone({ x: 0, y: hips.y, z: 0 }, { x: 0, y: chest.y, z: 0 }, waist_r, waist_r * 0.96)
  ellipsoid(0, chest.y + 0.01 * H, -0.004 * H, chest_w, 0.085 * H, chest_d)
  // Belly: sits low and forward, almost entirely fat-driven.
  ellipsoid(0, waist_y - 0.012 * H, (0.012 + p.fat * 0.035) * H, waist_r * 0.9, 0.06 * H * soft, (0.03 + p.fat * 0.045) * H)
  // Glutes.
  for (const side of [-1, 1]) {
    ellipsoid(side * hip_half * 0.55, hips.y - 0.025 * H, -(0.035 + p.fat * 0.02 + (1 - p.build) * 0.012) * H, hip_half * 0.62, 0.055 * H * soft, 0.045 * H * soft)
  }
  // Bust on the feminine side of the build axis.
  const bust = Math.max(0, 0.5 - p.build) * 2
  if (bust > 0.01) {
    const bust_r = (0.016 + 0.022 * bust + p.fat * 0.012) * H
    for (const side of [-1, 1]) {
      ellipsoid(side * chest_w * 0.42, chest.y + 0.005 * H, chest_d * 0.78, bust_r, bust_r * 0.92, bust_r, base_blend * 1.4)
    }
  }

  // -- neck + head -------------------------------------------------------------
  const neck_r = (0.024 + p.muscle * 0.012 + p.fat * 0.006) * H
  cone(neck, { x: head.x, y: head.y - 0.045 * H, z: head.z }, neck_r, neck_r * 0.9)
  const hs = lerp(0.86, 1.14, p.head_size)
  // Cranium + jaw, blended tighter than the body so the skull keeps its shape.
  ellipsoid(head.x, head.y + 0.01 * H, head.z, 0.062 * H * hs, 0.075 * H * hs, 0.068 * H * hs, base_blend * 0.5)
  ellipsoid(head.x, head.y - 0.035 * H * hs, head.z + 0.012 * H * hs, 0.045 * H * hs, 0.045 * H * hs, 0.05 * H * hs, base_blend * 0.5)

  // -- limbs (mirrored) ---------------------------------------------------------
  const muscle_arm = 1 + p.muscle * 0.45
  const muscle_leg = 1 + p.muscle * 0.32
  for (const side of ['l', 'r'] as const) {
    const shoulder = at(`shoulder_${side}`)
    const elbow = at(`elbow_${side}`)
    const wrist = at(`wrist_${side}`)
    const hand = at(`hand_${side}`)
    const thigh = at(`thigh_${side}`)
    const knee = at(`knee_${side}`)
    const ankle = at(`ankle_${side}`)
    const foot = at(`foot_${side}`)

    // Deltoid cap, then tapered sweeps down the arm bones.
    ellipsoid(shoulder.x, shoulder.y + 0.005 * H, shoulder.z, 0.03 * H * girth * muscle_arm, 0.032 * H * girth * muscle_arm, 0.03 * H * girth * muscle_arm)
    cone(shoulder, elbow, 0.03 * H * girth * muscle_arm * soft, 0.022 * H * girth)
    cone(elbow, wrist, 0.024 * H * girth * (1 + p.muscle * 0.3), 0.015 * H * girth)
    // Hand: a flattened ellipsoid past the wrist.
    ellipsoid(hand.x, hand.y, hand.z, 0.018 * H, 0.042 * H, 0.012 * H, base_blend * 0.7)

    // Thigh / calf sweeps with a posterior calf belly.
    cone(thigh, knee, (0.048 + p.fat * 0.018 + (1 - p.build) * 0.006) * H * girth * muscle_leg, 0.028 * H * girth)
    cone(knee, ankle, 0.03 * H * girth, 0.017 * H * girth)
    const calf = lerp(knee.y, ankle.y, 0.3)
    ellipsoid(knee.x, calf, knee.z - 0.012 * H, 0.026 * H * girth * muscle_leg, 0.05 * H, 0.026 * H * girth * muscle_leg)
    // Foot: heel-to-toe wedge.
    cone({ x: ankle.x, y: 0.032 * H, z: ankle.z - 0.02 * H }, { x: foot.x, y: foot.y, z: foot.z }, 0.027 * H, 0.018 * H, base_blend * 0.7)
  }

  return parts
}

/** Signed distance of the whole body at a point: smooth union over every part. */
export function eval_avatar_field(parts: body_part[], x: number, y: number, z: number): number {
  let d = 1e9
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!
    const pd = part.kind === KIND_CONE ? sd_round_cone(x, y, z, part) : sd_ellipsoid(x, y, z, part)
    d = smin(d, pd, part.blend)
  }
  return d
}

// --- polygonization (naive surface nets) ----------------------------------------

// 8 cell corners as (dx, dy, dz) and the 12 edges as corner-index pairs.
const CORNERS: [number, number, number][] = [
  [0, 0, 0], [1, 0, 0], [0, 1, 0], [1, 1, 0],
  [0, 0, 1], [1, 0, 1], [0, 1, 1], [1, 1, 1],
]
const EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7], // x
  [0, 2], [1, 3], [4, 6], [5, 7], // y
  [0, 4], [1, 5], [2, 6], [3, 7], // z
]

export interface avatar_mesh_result {
  mesh: audit_mesh
  bounds: audit_bounds
  /** Grid cells actually used per axis. */
  cells: [number, number, number]
  generation_ms: number
}

/**
 * Polygonize the body field with naive surface nets: one vertex per
 * sign-changing cell (at the mean of its edge crossings), one quad per
 * sign-changing grid edge. Compared to marching cubes it needs no case tables
 * and yields evenly sized, mostly-quad topology — the "topology cleanup" step
 * comes for free. Normals are the analytic SDF gradient, so shading is smooth
 * regardless of grid resolution.
 */
export function polygonize_avatar(parts: body_part[], p: avatar_params, resolution_override?: number): avatar_mesh_result {
  const started = performance.now()

  // Field bounds: union of part AABBs padded by the blend radius + one cell.
  let min_x = 1e9, min_y = 1e9, min_z = 1e9
  let max_x = -1e9, max_y = -1e9, max_z = -1e9
  for (const part of parts) {
    const r = part.kind === KIND_CONE ? Math.max(part.ra, part.rb) : Math.max(part.ra, part.bx, part.by)
    const pad = r + part.blend
    const xs = part.kind === KIND_CONE ? [part.ax, part.bx] : [part.ax]
    const ys = part.kind === KIND_CONE ? [part.ay, part.by] : [part.ay]
    const zs = part.kind === KIND_CONE ? [part.az, part.bz] : [part.az]
    for (let i = 0; i < xs.length; i += 1) {
      min_x = Math.min(min_x, xs[i]! - pad); max_x = Math.max(max_x, xs[i]! + pad)
      min_y = Math.min(min_y, ys[i]! - pad); max_y = Math.max(max_y, ys[i]! + pad)
      min_z = Math.min(min_z, zs[i]! - pad); max_z = Math.max(max_z, zs[i]! + pad)
    }
  }

  const res = Math.max(12, Math.min(160, Math.round(resolution_override ?? p.resolution)))
  const extent = Math.max(max_x - min_x, max_y - min_y, max_z - min_z, 1e-3)
  const cell = extent / res
  const nx = Math.max(2, Math.ceil((max_x - min_x) / cell))
  const ny = Math.max(2, Math.ceil((max_y - min_y) / cell))
  const nz = Math.max(2, Math.ceil((max_z - min_z) / cell))
  const sx = nx + 1, sy = ny + 1, sz = nz + 1

  // Sample the field at every grid corner.
  const field = new Float32Array(sx * sy * sz)
  for (let k = 0; k < sz; k += 1) {
    const z = min_z + k * cell
    for (let j = 0; j < sy; j += 1) {
      const y = min_y + j * cell
      const row = (k * sy + j) * sx
      for (let i = 0; i < sx; i += 1) {
        field[row + i] = eval_avatar_field(parts, min_x + i * cell, y, z)
      }
    }
  }
  const sample = (i: number, j: number, k: number): number => field[(k * sy + j) * sx + i]!

  // One vertex per cell that straddles the surface.
  const cell_vertex = new Int32Array(nx * ny * nz).fill(-1)
  const positions: number[] = []
  for (let k = 0; k < nz; k += 1) {
    for (let j = 0; j < ny; j += 1) {
      for (let i = 0; i < nx; i += 1) {
        let inside_mask = 0
        for (let c = 0; c < 8; c += 1) {
          const [dx, dy, dz] = CORNERS[c]!
          if (sample(i + dx, j + dy, k + dz) < 0) inside_mask |= 1 << c
        }
        if (inside_mask === 0 || inside_mask === 0xff) continue
        let px = 0, py = 0, pz = 0, crossings = 0
        for (const [c0, c1] of EDGES) {
          const a_in = (inside_mask >> c0) & 1
          const b_in = (inside_mask >> c1) & 1
          if (a_in === b_in) continue
          const [ax, ay, az] = CORNERS[c0]!
          const [bx, by, bz] = CORNERS[c1]!
          const d0 = sample(i + ax, j + ay, k + az)
          const d1 = sample(i + bx, j + by, k + bz)
          const t = d0 / (d0 - d1)
          px += ax + (bx - ax) * t
          py += ay + (by - ay) * t
          pz += az + (bz - az) * t
          crossings += 1
        }
        cell_vertex[(k * ny + j) * nx + i] = positions.length / 3
        positions.push(
          min_x + (i + px / crossings) * cell,
          min_y + (j + py / crossings) * cell,
          min_z + (k + pz / crossings) * cell,
        )
      }
    }
  }

  // Normals: analytic gradient of the field at each vertex.
  const vertex_count = positions.length / 3
  const normals = new Float32Array(vertex_count * 3)
  const eps = cell * 0.5
  for (let v = 0; v < vertex_count; v += 1) {
    const x = positions[v * 3]!, y = positions[v * 3 + 1]!, z = positions[v * 3 + 2]!
    let gx = eval_avatar_field(parts, x + eps, y, z) - eval_avatar_field(parts, x - eps, y, z)
    let gy = eval_avatar_field(parts, x, y + eps, z) - eval_avatar_field(parts, x, y - eps, z)
    let gz = eval_avatar_field(parts, x, y, z + eps) - eval_avatar_field(parts, x, y, z - eps)
    const len = Math.hypot(gx, gy, gz)
    if (len > 1e-12) { gx /= len; gy /= len; gz /= len } else { gy = 1; gx = 0; gz = 0 }
    normals[v * 3] = gx
    normals[v * 3 + 1] = gy
    normals[v * 3 + 2] = gz
  }

  // One quad per sign-changing grid edge, connecting the 4 cells that share it.
  // Winding is settled against the SDF gradient so exported faces point outward.
  const indices: number[] = []
  const cv = (i: number, j: number, k: number): number => cell_vertex[(k * ny + j) * nx + i]!
  const emit_quad = (v0: number, v1: number, v2: number, v3: number): void => {
    if (v0 < 0 || v1 < 0 || v2 < 0 || v3 < 0) return
    // Face normal of the (v0,v1,v2) triangle vs the averaged vertex gradient.
    const ax = positions[v1 * 3]! - positions[v0 * 3]!
    const ay = positions[v1 * 3 + 1]! - positions[v0 * 3 + 1]!
    const az = positions[v1 * 3 + 2]! - positions[v0 * 3 + 2]!
    const bx = positions[v2 * 3]! - positions[v0 * 3]!
    const by = positions[v2 * 3 + 1]! - positions[v0 * 3 + 1]!
    const bz = positions[v2 * 3 + 2]! - positions[v0 * 3 + 2]!
    const fx = ay * bz - az * by
    const fy = az * bx - ax * bz
    const fz = ax * by - ay * bx
    const gx = normals[v0 * 3]! + normals[v1 * 3]! + normals[v2 * 3]! + normals[v3 * 3]!
    const gy = normals[v0 * 3 + 1]! + normals[v1 * 3 + 1]! + normals[v2 * 3 + 1]! + normals[v3 * 3 + 1]!
    const gz = normals[v0 * 3 + 2]! + normals[v1 * 3 + 2]! + normals[v2 * 3 + 2]! + normals[v3 * 3 + 2]!
    if (fx * gx + fy * gy + fz * gz >= 0) indices.push(v0, v1, v2, v0, v2, v3)
    else indices.push(v0, v2, v1, v0, v3, v2)
  }
  for (let k = 0; k < sz; k += 1) {
    for (let j = 0; j < sy; j += 1) {
      for (let i = 0; i < sx; i += 1) {
        const d0 = sample(i, j, k)
        // x-edge: shared by the 4 cells around it in the y/z plane.
        if (i < nx && j > 0 && j < ny && k > 0 && k < nz && d0 < 0 !== sample(i + 1, j, k) < 0) {
          emit_quad(cv(i, j - 1, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i, j - 1, k))
        }
        // y-edge.
        if (j < ny && i > 0 && i < nx && k > 0 && k < nz && d0 < 0 !== sample(i, j + 1, k) < 0) {
          emit_quad(cv(i - 1, j, k - 1), cv(i, j, k - 1), cv(i, j, k), cv(i - 1, j, k))
        }
        // z-edge.
        if (k < nz && i > 0 && i < nx && j > 0 && j < ny && d0 < 0 !== sample(i, j, k + 1) < 0) {
          emit_quad(cv(i - 1, j - 1, k), cv(i, j - 1, k), cv(i, j, k), cv(i - 1, j, k))
        }
      }
    }
  }

  const mesh: audit_mesh = {
    name: 'avatar_body',
    positions: Float32Array.from(positions),
    normals,
    uvs: null,
    indices: Uint32Array.from(indices),
    base_color: [0.76, 0.62, 0.52, 1],
    material_name: 'avatar_skin',
    normals_generated: true,
    albedo_bytes: null,
    albedo_mime: null,
    albedo: null,
  }
  const bounds: audit_bounds = { min: [min_x, min_y, min_z], max: [max_x, max_y, max_z] }
  return { mesh, bounds, cells: [nx, ny, nz], generation_ms: performance.now() - started }
}

// --- skeleton visualization mesh ----------------------------------------------

/**
 * Build a renderable mesh for the skeleton itself: an octahedral bone per
 * (parent → child) segment plus a small cube at each joint — the editor-style
 * armature view. Vertices are deliberately unshared so the recomputed normals
 * stay faceted.
 */
export function build_avatar_skeleton_mesh(skeleton: avatar_skeleton, height: number): audit_mesh {
  const positions: number[] = []
  const indices: number[] = []
  const tri = (ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number): void => {
    const base = positions.length / 3
    positions.push(ax, ay, az, bx, by, bz, cx, cy, cz)
    indices.push(base, base + 1, base + 2)
  }

  for (const [pi, ci] of skeleton.bones) {
    const a = skeleton.joints[pi]!
    const b = skeleton.joints[ci]!
    let dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z
    const len = Math.hypot(dx, dy, dz)
    if (len < 1e-6) continue
    dx /= len; dy /= len; dz /= len
    // Any perpendicular pair for the mid-ring.
    let ux = -dy, uy = dx, uz = 0
    let ul = Math.hypot(ux, uy, uz)
    if (ul < 1e-6) { ux = 0; uy = -dz; uz = dy; ul = Math.hypot(ux, uy, uz) }
    ux /= ul; uy /= ul; uz /= ul
    const vx = dy * uz - dz * uy
    const vy = dz * ux - dx * uz
    const vz = dx * uy - dy * ux
    const r = Math.min(len * 0.16, height * 0.012)
    const mx = a.x + dx * len * 0.22
    const my = a.y + dy * len * 0.22
    const mz = a.z + dz * len * 0.22
    const ring: [number, number, number][] = [
      [mx + ux * r, my + uy * r, mz + uz * r],
      [mx + vx * r, my + vy * r, mz + vz * r],
      [mx - ux * r, my - uy * r, mz - uz * r],
      [mx - vx * r, my - vy * r, mz - vz * r],
    ]
    for (let e = 0; e < 4; e += 1) {
      const p0 = ring[e]!
      const p1 = ring[(e + 1) % 4]!
      tri(a.x, a.y, a.z, p1[0], p1[1], p1[2], p0[0], p0[1], p0[2])
      tri(b.x, b.y, b.z, p0[0], p0[1], p0[2], p1[0], p1[1], p1[2])
    }
  }

  // Joint markers: tiny axis-aligned octahedra.
  const jr = height * 0.008
  for (const j of skeleton.joints) {
    const px = j.x, py = j.y, pz = j.z
    const top: [number, number, number] = [px, py + jr, pz]
    const bot: [number, number, number] = [px, py - jr, pz]
    const ring: [number, number, number][] = [
      [px + jr, py, pz], [px, py, pz + jr], [px - jr, py, pz], [px, py, pz - jr],
    ]
    for (let e = 0; e < 4; e += 1) {
      const p0 = ring[e]!
      const p1 = ring[(e + 1) % 4]!
      tri(top[0], top[1], top[2], p0[0], p0[1], p0[2], p1[0], p1[1], p1[2])
      tri(bot[0], bot[1], bot[2], p1[0], p1[1], p1[2], p0[0], p0[1], p0[2])
    }
  }

  const mesh: audit_mesh = {
    name: 'avatar_skeleton',
    positions: Float32Array.from(positions),
    normals: new Float32Array(positions.length),
    uvs: null,
    indices: Uint32Array.from(indices),
    base_color: [0.95, 0.62, 0.18, 1],
    material_name: 'avatar_bone',
    normals_generated: true,
    albedo_bytes: null,
    albedo_mime: null,
    albedo: null,
  }
  recompute_mesh_normals(mesh)
  return mesh
}

// --- one-call generation -------------------------------------------------------

export interface avatar_build_result extends avatar_mesh_result {
  skeleton: avatar_skeleton
  skeleton_mesh: audit_mesh
}

/** Run the whole pipeline: skeleton → volumes → field → mesh (+ armature mesh). */
export function generate_avatar(params: avatar_params, resolution_override?: number): avatar_build_result {
  const skeleton = build_avatar_skeleton(params)
  const parts = build_avatar_volumes(params, skeleton)
  const result = polygonize_avatar(parts, params, resolution_override)
  return { ...result, skeleton, skeleton_mesh: build_avatar_skeleton_mesh(skeleton, params.height) }
}
