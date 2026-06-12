// Avatar body — procedural human mesh generation from a parametric skeleton.
//
// No template mesh anywhere: the body is built bones-first, exactly the
// "true procedural" pipeline —
//
//   body parameters
//        ↓
//   parametric skeleton (joint positions + hierarchy from height/proportions,
//   down to per-finger and per-toe chains and breast anchor bones)
//        ↓
//   bone frame volumes (lean anatomical SDF volumes swept along every bone:
//   rounded cones for limbs and digits, ellipsoids for head/torso)
//        ↓
//   muscle layer (deltoids, traps, pecs, biceps, quads, glutes, calves…
//   grown over the frame by the muscle parameter)
//        ↓
//   fat layer (belly, love handles, glute pads, bust, chin + a subcutaneous
//   swell of every soft part by the fat parameter)
//        ↓
//   surface-nets polygonization of the combined field
//        ↓
//   triangle mesh with SDF-gradient normals
//
// A skeleton alone does not uniquely define a body (a sprinter and a
// powerlifter can share bone lengths), so muscle and fat are explicit passes
// over the volume list: the frame annotates how strongly each part responds
// (`muscle_gain` / `fat_gain`) and the two layers grow the radii and add the
// soft masses the skeleton can't describe.
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
    // High enough that finger/toe cross-sections stay above one grid cell.
    blend: 0.45,
    resolution: 112,
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

/** Finger chains hung off each palm: knuckle forward-offset and total length
 * as fractions of body height. The thumb roots separately near the wrist. */
const FINGERS = [
  { name: 'index', z: 0.031, length: 0.044 },
  { name: 'middle', z: 0.018, length: 0.048 },
  { name: 'ring', z: 0.005, length: 0.044 },
  { name: 'pinky', z: -0.008, length: 0.034 },
] as const

/** Toe chains hung off each foot ball, big toe (toe1, innermost) → pinky toe
 * (toe5): sideways offset from the foot center and length, fractions of height. */
const TOES = [
  { name: 'toe1', dx: -0.014, length: 0.03 },
  { name: 'toe2', dx: -0.005, length: 0.024 },
  { name: 'toe3', dx: 0.003, length: 0.02 },
  { name: 'toe4', dx: 0.01, length: 0.017 },
  { name: 'toe5', dx: 0.016, length: 0.014 },
] as const

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
    // Breast anchor on the chest front: bone editing can place the bust and the
    // fat layer grows the volume attached to it.
    j(`breast_${tag}`, chest, side * shoulder_x * 0.42, chest_y + 0.004 * H, 0.052 * H)

    const clavicle = j(`clavicle_${tag}`, chest, side * shoulder_x * 0.35, shoulder_y, 0)
    const shoulder = j(`shoulder_${tag}`, clavicle, side * shoulder_x, shoulder_y, 0)
    const elbow = j(`elbow_${tag}`, shoulder, side * (shoulder_x + arm_out), elbow_y, 0)
    const wrist = j(`wrist_${tag}`, elbow, side * (shoulder_x + arm_out * 1.6), wrist_y, 0.01 * H)

    // Palm center, then a knuckle → mid → tip chain per finger. The arms hang,
    // so fingers continue downward with a slight forward drift.
    const hand_x = shoulder_x + arm_out * 1.8
    const hand = j(`hand_${tag}`, wrist, side * hand_x, wrist_y - 0.03 * H, 0.012 * H)
    const knuckle_y = wrist_y - 0.055 * H
    for (const f of FINGERS) {
      const base = j(`${f.name}_1_${tag}`, hand, side * hand_x, knuckle_y, f.z * H)
      const mid = j(`${f.name}_2_${tag}`, base, side * hand_x, knuckle_y - f.length * 0.55 * H, (f.z + 0.004) * H)
      j(`${f.name}_3_${tag}`, mid, side * hand_x, knuckle_y - f.length * H, (f.z + 0.007) * H)
    }
    // Thumb: rooted on the palmar side near the wrist, angled down-forward.
    const thumb_base = j(`thumb_1_${tag}`, hand, side * (hand_x - 0.008 * H), wrist_y - 0.02 * H, 0.03 * H)
    const thumb_mid = j(`thumb_2_${tag}`, thumb_base, side * (hand_x - 0.004 * H), wrist_y - 0.038 * H, 0.046 * H)
    j(`thumb_3_${tag}`, thumb_mid, side * hand_x, wrist_y - 0.05 * H, 0.058 * H)

    const thigh = j(`thigh_${tag}`, hips, side * hip_x, hips_y - 0.02 * H, 0)
    const knee = j(`knee_${tag}`, thigh, side * hip_x * 0.92, knee_y, 0.004 * H)
    const ankle = j(`ankle_${tag}`, knee, side * hip_x * 0.88, ankle_y, -0.01 * H)
    // Ball of the foot, then a base → tip chain per toe fanning inner → outer.
    const foot = j(`foot_${tag}`, ankle, side * hip_x * 0.9, 0.02 * H, 0.085 * H)
    for (const t of TOES) {
      const tx = side * (hip_x * 0.9 + t.dx * H)
      const base = j(`${t.name}_1_${tag}`, foot, tx, 0.016 * H, 0.095 * H)
      j(`${t.name}_2_${tag}`, base, tx, 0.011 * H, (0.095 + t.length) * H)
    }
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
  /** Fractional radius growth at 100% muscle, consumed by the muscle pass. */
  muscle_gain: number
  /** Fractional radius growth at 100% fat, consumed by the fat pass. */
  fat_gain: number
  /** Conservative bounding sphere (refreshed once the layers settle) — lets the
   * field eval skip parts that cannot influence a sample point. */
  cx: number
  cy: number
  cz: number
  bound: number
}

interface vec3_like {
  x: number
  y: number
  z: number
}

function add_cone(parts: body_part[], a: vec3_like, b: vec3_like, ra: number, rb: number, blend: number, muscle_gain = 0, fat_gain = 0): void {
  parts.push({ kind: KIND_CONE, ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, ra, rb, blend, muscle_gain, fat_gain, cx: 0, cy: 0, cz: 0, bound: 0 })
}

function add_ellipsoid(parts: body_part[], cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, blend: number, muscle_gain = 0, fat_gain = 0): void {
  parts.push({ kind: KIND_ELLIPSOID, ax: cx, ay: cy, az: cz, bx: ry, by: rz, bz: 0, ra: rx, rb: 0, blend, muscle_gain, fat_gain, cx: 0, cy: 0, cz: 0, bound: 0 })
}

/** Swell a part's radii by fraction `f` — endpoints/centers stay on the bones. */
function grow_part(part: body_part, f: number): void {
  if (f <= 0) return
  const s = 1 + f
  part.ra *= s
  if (part.kind === KIND_CONE) part.rb *= s
  else {
    part.bx *= s
    part.by *= s
  }
}

/** Refresh every part's conservative bounding sphere for field-eval culling. */
function update_part_bounds(parts: body_part[]): void {
  for (const part of parts) {
    if (part.kind === KIND_CONE) {
      part.cx = (part.ax + part.bx) * 0.5
      part.cy = (part.ay + part.by) * 0.5
      part.cz = (part.az + part.bz) * 0.5
      part.bound = Math.hypot(part.bx - part.ax, part.by - part.ay, part.bz - part.az) * 0.5 + Math.max(part.ra, part.rb)
    } else {
      part.cx = part.ax
      part.cy = part.ay
      part.cz = part.az
      part.bound = Math.max(part.ra, part.bx, part.by)
    }
  }
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
 * Layer 1 — the bone frame: lean anatomical volumes attached to the skeleton,
 * one sweep per bone down to fingers and toes. Radii are fractions of body
 * height at zero muscle/fat; every part annotates how strongly the muscle and
 * fat passes may grow it, so the same frame can carry a sprinter or a
 * powerlifter once the layers run.
 */
export function build_avatar_volumes(p: avatar_params, skeleton: avatar_skeleton): body_part[] {
  const H = p.height
  const joint = new Map<string, avatar_joint>()
  for (const item of skeleton.joints) joint.set(item.name, item)
  const at = (name: string): avatar_joint => joint.get(name)!

  const girth = lerp(0.78, 1.28, p.limb_thickness)
  const base_blend = lerp(0.012, 0.045, p.blend) * H

  const parts: body_part[] = []
  const cone = (a: vec3_like, b: vec3_like, ra: number, rb: number, blend = base_blend, muscle = 0, fat = 0): void =>
    add_cone(parts, a, b, ra, rb, blend, muscle, fat)
  const ellipsoid = (cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, blend = base_blend, muscle = 0, fat = 0): void =>
    add_ellipsoid(parts, cx, cy, cz, rx, ry, rz, blend, muscle, fat)

  const hips = at('hips')
  const chest = at('chest')
  const neck = at('neck')
  const head = at('head')

  // -- axial body: lean trunk — waist pinches on the feminine side; the belly,
  // handles and softness arrive with the fat pass.
  const hip_half = Math.abs(at('thigh_r').x)
  const shoulder_half = Math.abs(at('shoulder_r').x)
  const waist_r = (0.058 - (1 - p.build) * 0.013) * H
  const chest_w = shoulder_half * 0.85
  const chest_d = 0.05 * H

  // Pelvis block + spine column + ribcage, fused into one trunk.
  ellipsoid(hips.x, hips.y - 0.01 * H, hips.z, hip_half + 0.042 * H, 0.062 * H, 0.048 * H, base_blend, 0.06, 0.3)
  cone({ x: 0, y: hips.y, z: 0 }, { x: 0, y: chest.y, z: 0 }, waist_r, waist_r * 0.96, base_blend, 0.12, 0.6)
  ellipsoid(0, chest.y + 0.01 * H, -0.004 * H, chest_w, 0.085 * H, chest_d, base_blend, 0.16, 0.2)
  // Bust: anchored to the breast bones. Build sets the lean size (vanishing on
  // the masculine side), the fat pass grows it further.
  const bust = Math.max(0, 0.5 - p.build) * 2
  const bust_r = (0.012 + 0.028 * bust) * H
  for (const side of ['l', 'r'] as const) {
    const anchor = at(`breast_${side}`)
    ellipsoid(anchor.x, anchor.y, anchor.z, bust_r, bust_r * 0.92, bust_r * 0.9, base_blend * 1.4, 0, 0.5)
  }

  // -- neck + head -------------------------------------------------------------
  const neck_r = 0.023 * H
  cone(neck, { x: head.x, y: head.y - 0.045 * H, z: head.z }, neck_r, neck_r * 0.9, base_blend, 0.45, 0.25)
  const hs = lerp(0.86, 1.14, p.head_size)
  // Cranium + jaw, blended tighter than the body so the skull keeps its shape.
  // The skull takes no muscle/fat; a chin pad arrives with the fat pass.
  ellipsoid(head.x, head.y + 0.01 * H, head.z, 0.062 * H * hs, 0.075 * H * hs, 0.068 * H * hs, base_blend * 0.5)
  ellipsoid(head.x, head.y - 0.035 * H * hs, head.z + 0.012 * H * hs, 0.045 * H * hs, 0.045 * H * hs, 0.05 * H * hs, base_blend * 0.5, 0, 0.08)

  // -- limbs (mirrored): lean sweeps along every bone, digits included ------------
  for (const side of ['l', 'r'] as const) {
    const shoulder = at(`shoulder_${side}`)
    const elbow = at(`elbow_${side}`)
    const wrist = at(`wrist_${side}`)
    const hand = at(`hand_${side}`)
    const thigh = at(`thigh_${side}`)
    const knee = at(`knee_${side}`)
    const ankle = at(`ankle_${side}`)
    const foot = at(`foot_${side}`)

    cone(shoulder, elbow, 0.028 * H * girth, 0.021 * H * girth, base_blend, 0.42, 0.32)
    cone(elbow, wrist, 0.021 * H * girth, 0.014 * H * girth, base_blend, 0.32, 0.22)

    // Palm slab, then a tapered cone pair down every finger chain. Digit radii
    // stay under half the knuckle spacing and blend tight (capped in absolute
    // terms, not just relative to the body blend) so fingers read as separate
    // digits instead of webbing into a mitten.
    ellipsoid(hand.x, hand.y, hand.z, 0.016 * H, 0.032 * H, 0.011 * H, base_blend * 0.5, 0, 0.12)
    const digit_blend = Math.min(base_blend * 0.28, 0.0035 * H)
    for (const f of FINGERS) {
      const base = at(`${f.name}_1_${side}`)
      const mid = at(`${f.name}_2_${side}`)
      const tip = at(`${f.name}_3_${side}`)
      cone(base, mid, 0.0062 * H, 0.0055 * H, digit_blend, 0, 0.1)
      cone(mid, tip, 0.0055 * H, 0.0048 * H, digit_blend, 0, 0.1)
    }
    // Thumb: thicker, and its root blends softer so it fuses into the palm.
    cone(at(`thumb_1_${side}`), at(`thumb_2_${side}`), 0.008 * H, 0.0065 * H, base_blend * 0.45, 0, 0.1)
    cone(at(`thumb_2_${side}`), at(`thumb_3_${side}`), 0.0065 * H, 0.005 * H, digit_blend, 0, 0.1)

    cone(thigh, knee, (0.044 + (1 - p.build) * 0.006) * H * girth, 0.027 * H * girth, base_blend, 0.3, 0.42)
    cone(knee, ankle, 0.028 * H * girth, 0.016 * H * girth, base_blend, 0.18, 0.2)
    // Foot: heel-to-ball wedge, then a short cone per toe chain.
    cone({ x: ankle.x, y: 0.032 * H, z: ankle.z - 0.02 * H }, foot, 0.026 * H, 0.017 * H, base_blend * 0.7, 0, 0.12)
    for (const t of TOES) {
      const r = t.name === 'toe1' ? 0.0075 * H : 0.0055 * H
      cone(at(`${t.name}_1_${side}`), at(`${t.name}_2_${side}`), r, r * 0.8, digit_blend, 0, 0.1)
    }
  }

  return parts
}

// --- muscle & fat layers ---------------------------------------------------------

/**
 * Layer 2 — musculature. Runs after the bone frame and before the fat layer:
 * first every frame part swells by its annotated `muscle_gain`, then the named
 * muscle bellies are laid over the frame. Belly sizes lerp with the muscle
 * parameter, so on a lean body they hide inside the frame and emerge with
 * training. The bellies carry their own `fat_gain` — fat covers muscle.
 */
export function apply_avatar_muscle_layer(parts: body_part[], p: avatar_params, skeleton: avatar_skeleton): void {
  const m = p.muscle
  for (const part of parts) grow_part(part, m * part.muscle_gain)

  const H = p.height
  const joint = new Map<string, avatar_joint>()
  for (const item of skeleton.joints) joint.set(item.name, item)
  const at = (name: string): avatar_joint => joint.get(name)!

  const girth = lerp(0.78, 1.28, p.limb_thickness)
  const base_blend = lerp(0.012, 0.045, p.blend) * H
  const neck = at('neck')
  const chest = at('chest')
  const hips = at('hips')
  const shoulder_half = Math.abs(at('shoulder_r').x)
  const hip_half = Math.abs(at('thigh_r').x)
  // Pecs read mostly on the masculine side; the feminine chest keeps the bust.
  const pec = m * (0.35 + 0.65 * p.build)

  for (const side of ['l', 'r'] as const) {
    const s = side === 'l' ? -1 : 1
    const shoulder = at(`shoulder_${side}`)
    const elbow = at(`elbow_${side}`)
    const wrist = at(`wrist_${side}`)
    const thigh = at(`thigh_${side}`)
    const knee = at(`knee_${side}`)
    const ankle = at(`ankle_${side}`)

    // Deltoid cap over the shoulder.
    const delt = (0.021 + 0.016 * m) * H * girth
    add_ellipsoid(parts, shoulder.x, shoulder.y + 0.005 * H, shoulder.z, delt, delt * 1.06, delt, base_blend, 0, 0.2)
    // Trapezius slab rising between neck and shoulder.
    add_ellipsoid(parts, (neck.x + shoulder.x) * 0.5, lerp(shoulder.y, neck.y, 0.6), -0.008 * H, shoulder_half * 0.42, (0.012 + 0.022 * m) * H, (0.016 + 0.012 * m) * H, base_blend, 0, 0.15)
    // Pectoral plate on the chest front.
    add_ellipsoid(parts, s * shoulder_half * 0.36, chest.y + 0.008 * H, 0.042 * H, (0.024 + 0.022 * pec) * H, (0.02 + 0.012 * pec) * H, (0.01 + 0.016 * pec) * H, base_blend, 0, 0.2)
    // Biceps + forearm bellies, slightly anterior.
    add_ellipsoid(parts, lerp(shoulder.x, elbow.x, 0.45), lerp(shoulder.y, elbow.y, 0.45), lerp(shoulder.z, elbow.z, 0.45) + 0.006 * H, (0.012 + 0.02 * m) * H * girth, Math.abs(shoulder.y - elbow.y) * 0.3, (0.012 + 0.018 * m) * H * girth, base_blend, 0, 0.15)
    add_ellipsoid(parts, lerp(elbow.x, wrist.x, 0.3), lerp(elbow.y, wrist.y, 0.3), lerp(elbow.z, wrist.z, 0.3), (0.011 + 0.014 * m) * H * girth, Math.abs(elbow.y - wrist.y) * 0.28, (0.011 + 0.012 * m) * H * girth, base_blend, 0, 0.12)
    // Quads on the front of the thigh, glutes behind the pelvis.
    add_ellipsoid(parts, lerp(thigh.x, knee.x, 0.42), lerp(thigh.y, knee.y, 0.42), lerp(thigh.z, knee.z, 0.42) + 0.014 * H, (0.02 + 0.015 * m) * H * girth, Math.abs(thigh.y - knee.y) * 0.34, (0.014 + 0.016 * m) * H, base_blend, 0, 0.2)
    add_ellipsoid(parts, s * hip_half * 0.55, hips.y - 0.025 * H, -(0.032 + 0.014 * m + (1 - p.build) * 0.012) * H, hip_half * 0.6, (0.045 + 0.012 * m) * H, (0.034 + 0.014 * m) * H, base_blend, 0, 0.35)
    // Calf belly, posterior.
    const calf_y = lerp(knee.y, ankle.y, 0.3)
    add_ellipsoid(parts, knee.x, calf_y, knee.z - 0.012 * H, (0.02 + 0.015 * m) * H * girth, 0.05 * H, (0.02 + 0.015 * m) * H * girth, base_blend, 0, 0.15)
  }
}

/**
 * Layer 3 — adipose. The last shaping pass before polygonization: every part
 * laid down so far swells by its `fat_gain` (subcutaneous fat over frame and
 * muscle alike), then the dedicated fat depots are added on top.
 */
export function apply_avatar_fat_layer(parts: body_part[], p: avatar_params, skeleton: avatar_skeleton): void {
  const f = p.fat
  for (const part of parts) grow_part(part, f * part.fat_gain)

  const H = p.height
  const joint = new Map<string, avatar_joint>()
  for (const item of skeleton.joints) joint.set(item.name, item)
  const at = (name: string): avatar_joint => joint.get(name)!

  const base_blend = lerp(0.012, 0.045, p.blend) * H
  const hips = at('hips')
  const chest = at('chest')
  const head = at('head')
  const hip_half = Math.abs(at('thigh_r').x)
  const waist_y = lerp(hips.y, chest.y, 0.45)

  // Belly: sits low and forward, almost entirely fat-driven.
  add_ellipsoid(parts, 0, waist_y - 0.012 * H, (0.008 + 0.04 * f) * H, (0.046 + 0.042 * f) * H, (0.05 + 0.028 * f) * H, (0.022 + 0.05 * f) * H, base_blend * 1.2)
  for (const s of [-1, 1]) {
    // Love handles at the waist sides.
    add_ellipsoid(parts, s * (0.05 + 0.028 * f) * H, waist_y + 0.005 * H, -0.006 * H, (0.012 + 0.03 * f) * H, (0.035 + 0.012 * f) * H, (0.018 + 0.028 * f) * H, base_blend * 1.3)
    // Glute pad: lower and wider than the muscle glute.
    add_ellipsoid(parts, s * hip_half * 0.5, hips.y - 0.035 * H, -(0.028 + 0.03 * f) * H, hip_half * 0.58, (0.04 + 0.022 * f) * H, (0.026 + 0.034 * f) * H, base_blend * 1.2)
  }
  // Chin pad under the jaw.
  add_ellipsoid(parts, head.x, head.y - 0.062 * H, head.z + 0.02 * H, (0.01 + 0.02 * f) * H, (0.008 + 0.014 * f) * H, (0.012 + 0.022 * f) * H, base_blend * 0.8)
}

/** Signed distance of the whole body at a point: smooth union over every part.
 * A part whose bounding sphere stays farther than `d + blend` cannot change
 * the running minimum (the smooth-min is exactly `d` there), so it is skipped
 * with one squared-distance test — with the finger/toe/muscle/fat parts the
 * list is ~90 long and mostly tiny, which makes this cull matter. */
export function eval_avatar_field(parts: body_part[], x: number, y: number, z: number): number {
  let d = 1e9
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!
    const dx = x - part.cx
    const dy = y - part.cy
    const dz = z - part.cz
    const reach = d + part.blend + part.bound
    if (reach < 0 || dx * dx + dy * dy + dz * dz > reach * reach) continue
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
  // The muscle/fat layers may have grown radii since the parts were created.
  update_part_bounds(parts)

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

  // Joint markers: tiny axis-aligned octahedra, shrunk where the incoming bone
  // is short (finger/toe chains) so markers don't swallow the bone.
  for (const j of skeleton.joints) {
    let jr = height * 0.008
    if (j.parent >= 0) {
      const parent = skeleton.joints[j.parent]!
      const bone_len = Math.hypot(j.x - parent.x, j.y - parent.y, j.z - parent.z)
      if (bone_len > 1e-6) jr = Math.min(jr, bone_len * 0.4)
    }
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

/** Per-joint world-space position deltas (by joint name), applied on top of the
 * parametric skeleton — this is how interactive bone editing persists across
 * regenerations. */
export type avatar_joint_offsets = Record<string, [number, number, number]>

export interface avatar_build_result extends avatar_mesh_result {
  skeleton: avatar_skeleton
  skeleton_mesh: audit_mesh
}

/** Run the whole pipeline: skeleton → bone frame → muscle layer → fat layer →
 * field → mesh (+ armature mesh). */
export function generate_avatar(params: avatar_params, resolution_override?: number, joint_offsets?: avatar_joint_offsets): avatar_build_result {
  const skeleton = build_avatar_skeleton(params)
  if (joint_offsets) {
    for (const joint of skeleton.joints) {
      const offset = joint_offsets[joint.name]
      if (offset) {
        joint.x += offset[0]
        joint.y += offset[1]
        joint.z += offset[2]
      }
    }
  }
  const parts = build_avatar_volumes(params, skeleton)
  apply_avatar_muscle_layer(parts, params, skeleton)
  apply_avatar_fat_layer(parts, params, skeleton)
  const result = polygonize_avatar(parts, params, resolution_override)
  return { ...result, skeleton, skeleton_mesh: build_avatar_skeleton_mesh(skeleton, params.height) }
}
