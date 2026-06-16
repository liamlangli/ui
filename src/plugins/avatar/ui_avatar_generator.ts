// Avatar generator — an immediate-mode panel around a template character
// backend plus the older procedural SDF draft backend. The default path loads
// Universal Base Characters from public/avatar_base, then applies the existing
// body sliders as coarse proportions over stable character meshes.
//
// The 3D pass reuses the asset-audit viewer (`asset_audit_view`) and the GLB
// writer (`encode_asset_glb`) — the generator only produces `audit_mesh` data.

import { pack_color, hex_to_normalized_rgba } from '../../core/ui_theme'
import type { theme_definition } from '../../core/ui_types'
import { FONT_MONO, type ui_renderer } from '../../core/ui_renderer'
import type { ui_input_snapshot, ui_scroll_state, ui_widgets } from '../../core/ui_widgets'
import { encode_asset_glb, format_asset_bytes, type audit_asset } from '../asset_audit/ui_asset_audit_data'
import {
  asset_audit_view,
  create_orbit_camera,
  frame_orbit_camera,
  orbit_camera_step_damping,
  orbit_camera_zoom,
  orbit_camera_eye,
  type asset_audit_view_mode,
  type orbit_camera,
} from '../asset_audit/ui_asset_audit_view'
import {
  AVATAR_PRESETS,
  apply_avatar_preset,
  create_avatar_params,
  generate_avatar,
  type avatar_build_result,
  type avatar_joint_offsets,
  type avatar_params,
} from './ui_avatar_body'
import {
  choose_avatar_template,
  generate_template_avatar,
  load_avatar_template_library,
  type avatar_template_key,
  type avatar_template_library,
} from './ui_avatar_template'

/** Coarse grid used while a slider is held, so dragging stays interactive. */
const DRAFT_RESOLUTION = 32

export interface avatar_generator_state {
  params: avatar_params
  /** Latest pipeline output (null until the first frame generates one). */
  result: avatar_build_result | null
  /** True when `result` was built at the draft resolution and needs a refine. */
  draft: boolean
  /** Set by any slider change; consumed by the per-frame regeneration. */
  params_dirty: boolean
  /** Bumped per regeneration so the GPU mesh upload knows when to re-sync. */
  mesh_revision: number
  show_skeleton: boolean
  wireframe: boolean
  view_mode: asset_audit_view_mode
  preset_index: number
  /** Draw the joint/bone editing overlay on top of the viewport. */
  show_bones: boolean
  /** Interactive bone edits: world-space deltas per joint name, applied on top
   * of the parametric skeleton every regeneration. */
  joint_offsets: avatar_joint_offsets
  /** Active joint drag (screen-plane move of a joint + its subtree). */
  bone_drag: { joint: string; last_mx: number; last_my: number } | null
  camera: orbit_camera
  /** Camera gets framed once on the first generated mesh. */
  framed: boolean
  // 3D preview plumbing (same shape as the asset-audit panel).
  view: asset_audit_view
  texture_id: number | null
  texture: GPUTexture | null
  view_dirty: boolean
  synced_key: string
  // viewport interaction
  orbiting: boolean
  panning: boolean
  last_mx: number
  last_my: number
  sidebar_scroll: ui_scroll_state
  sidebar_content_h: number
  backend: 'template' | 'sdf'
  template_choice: 'auto' | avatar_template_key
  template_status: 'idle' | 'loading' | 'ready' | 'error'
  template_library: avatar_template_library | null
  template_promise: Promise<void> | null
  template_error: string | null
}

export function create_avatar_generator_state(): avatar_generator_state {
  return {
    params: create_avatar_params(),
    result: null,
    draft: false,
    params_dirty: false,
    mesh_revision: 0,
    show_skeleton: false,
    wireframe: false,
    view_mode: 'shaded',
    preset_index: 0,
    show_bones: true,
    joint_offsets: {},
    bone_drag: null,
    camera: create_orbit_camera(),
    framed: false,
    view: new asset_audit_view(),
    texture_id: null,
    texture: null,
    view_dirty: true,
    synced_key: '',
    orbiting: false,
    panning: false,
    last_mx: 0,
    last_my: 0,
    sidebar_scroll: { offset_y: 0 },
    sidebar_content_h: 0,
    backend: 'template',
    template_choice: 'auto',
    template_status: 'idle',
    template_library: null,
    template_promise: null,
    template_error: null,
  }
}

function result_meshes(result: avatar_build_result, show_skeleton: boolean): audit_asset['meshes'] {
  const meshes = result.meshes ?? [result.mesh]
  return show_skeleton ? [...meshes, result.skeleton_mesh] : meshes
}

function ensure_template_loading(state: avatar_generator_state): void {
  if (state.template_status !== 'idle') return
  state.template_status = 'loading'
  state.template_promise = load_avatar_template_library()
    .then((library) => {
      state.template_library = library
      state.template_status = 'ready'
      state.template_error = null
      state.params_dirty = true
    })
    .catch((err) => {
      state.template_status = 'error'
      state.template_error = err instanceof Error ? err.message : String(err)
    })
}

function regenerate_sdf(state: avatar_generator_state, draft: boolean): void {
  state.result = generate_avatar(state.params, draft ? Math.min(DRAFT_RESOLUTION, state.params.resolution) : undefined, state.joint_offsets)
  state.draft = draft && state.params.resolution > DRAFT_RESOLUTION
  state.params_dirty = false
  state.mesh_revision += 1
  state.view_dirty = true
  if (!state.framed) {
    frame_orbit_camera(state.camera, state.result.bounds)
    state.framed = true
  }
}

function regenerate_template(state: avatar_generator_state): void {
  if (!state.template_library || state.template_status !== 'ready') return
  const template = state.template_choice === 'auto' ? choose_avatar_template(state.params) : state.template_choice
  state.result = generate_template_avatar(state.params, state.template_library, template, state.joint_offsets)
  state.draft = false
  state.params_dirty = false
  state.mesh_revision += 1
  state.view_dirty = true
  if (!state.framed) {
    frame_orbit_camera(state.camera, state.result.bounds)
    state.framed = true
  }
}

/** Wrap the generated body (and optionally the armature) in a GLB download. */
export function avatar_generator_export_glb(state: avatar_generator_state): number {
  const result = state.result
  if (!result || typeof document === 'undefined') return 0
  const meshes = result_meshes(result, state.show_skeleton)
  const asset: audit_asset = {
    file_name: 'avatar.glb',
    format: 'glb',
    file_bytes: 0,
    meshes,
    source: {
      node_count: meshes.length,
      mesh_count: meshes.length,
      material_count: meshes.length,
      texture_count: 0,
      animation_count: 0,
      skin_count: 0,
    },
    warnings: [],
    geometry_version: state.mesh_revision,
  }
  const glb = encode_asset_glb(asset)
  const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = 'avatar.glb'
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
  return glb.byteLength
}

export interface avatar_generator_options {
  /** Device-pixel scale; defaults to `window.devicePixelRatio`. */
  scale?: number
}

export interface avatar_generator_event {
  /** Set to the GLB byte size when the Export button wrote a file this frame. */
  exported_bytes?: number
}

function point_in(x: number, y: number, rx: number, ry: number, rw: number, rh: number): boolean {
  return x >= rx && x < rx + rw && y >= ry && y < ry + rh
}

export function avatar_generator(
  ui: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  state: avatar_generator_state,
  options?: avatar_generator_options,
): avatar_generator_event {
  const scale = options?.scale ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const event: avatar_generator_event = {}
  const m = 8 * scale

  ui.fill_rect(x, y, w, h, slot('panel'))

  // --- regenerate when needed --------------------------------------------------
  // While the mouse is held (a slider drag) changed params rebuild at a coarse
  // draft grid every frame; the full-resolution pass runs once on release.
  if (state.backend === 'template') {
    ensure_template_loading(state)
    if (state.template_status === 'ready' && (!state.result || state.params_dirty || state.result.source !== 'template')) regenerate_template(state)
  } else if (!state.result || state.params_dirty || state.result.source !== 'sdf') regenerate_sdf(state, input.mouse_down)
  else if (state.draft && !input.mouse_down) regenerate_sdf(state, false)

  // --- toolbar ------------------------------------------------------------------
  const bar_h = 30 * scale
  const btn_h = 26 * scale
  const bar_y = y + m
  let bx = x + m
  const button = (id: string, label: string, width: number, opts?: { active?: boolean }): boolean => {
    const hit = widgets.button(id, bx, bar_y + (bar_h - btn_h) / 2, width, btn_h, label, opts)
    bx += width + 6 * scale
    return hit
  }

  const preset_names = AVATAR_PRESETS.map((p) => p.name as string)
  const next_preset = widgets.dropdown('ag_preset', bx, bar_y + (bar_h - btn_h) / 2, 96 * scale, btn_h, preset_names, state.preset_index)
  if (next_preset !== state.preset_index) {
    state.preset_index = next_preset
    apply_avatar_preset(state.params, AVATAR_PRESETS[next_preset]!.name)
    state.joint_offsets = {} // a preset describes a whole body — drop manual bone edits
    state.params_dirty = true
  }
  bx += 96 * scale + 10 * scale

  const backend_names = ['Template', 'SDF Draft']
  const next_backend = widgets.dropdown('ag_backend', bx, bar_y + (bar_h - btn_h) / 2, 94 * scale, btn_h, backend_names, state.backend === 'template' ? 0 : 1)
  const backend = next_backend === 0 ? 'template' : 'sdf'
  if (backend !== state.backend) {
    state.backend = backend
    state.params_dirty = true
    state.framed = false
    state.synced_key = ''
  }
  bx += 104 * scale

  if (state.backend === 'template') {
    const choices = ['Auto', 'Male', 'Female']
    const current = state.template_choice === 'auto' ? 0 : state.template_choice === 'male' ? 1 : 2
    const next = widgets.dropdown('ag_template_choice', bx, bar_y + (bar_h - btn_h) / 2, 76 * scale, btn_h, choices, current)
    const choice: avatar_generator_state['template_choice'] = next === 0 ? 'auto' : next === 1 ? 'male' : 'female'
    if (choice !== state.template_choice) {
      state.template_choice = choice
      state.params_dirty = true
      state.framed = false
      state.synced_key = ''
    }
    bx += 86 * scale
  }

  const next_wire = widgets.toggle('ag_wire', bx, bar_y + (bar_h - 18 * scale) / 2, state.wireframe, 'Wireframe')
  if (next_wire !== state.wireframe) {
    state.wireframe = next_wire
    state.view_dirty = true
  }
  bx += 100 * scale
  const next_skel = widgets.toggle('ag_skel', bx, bar_y + (bar_h - 18 * scale) / 2, state.show_skeleton, 'Skeleton')
  if (next_skel !== state.show_skeleton) {
    state.show_skeleton = next_skel
    state.view_dirty = true
  }
  bx += 96 * scale
  state.show_bones = widgets.toggle('ag_bones', bx, bar_y + (bar_h - 18 * scale) / 2, state.show_bones, 'Bones')
  bx += 76 * scale

  const view_modes: asset_audit_view_mode[] = ['shaded', 'texture', 'normal']
  const view_labels = ['Shaded', 'Base Color', 'Normal']
  const view_index = Math.max(0, view_modes.indexOf(state.view_mode))
  const next_view = widgets.dropdown('ag_view_mode', bx, bar_y + (bar_h - btn_h) / 2, 98 * scale, btn_h, view_labels, view_index)
  if (next_view !== view_index) {
    state.view_mode = view_modes[next_view]!
    state.view_dirty = true
  }
  bx += 108 * scale

  if (button('ag_reset_view', 'Reset View', 88 * scale)) {
    if (state.result) frame_orbit_camera(state.camera, state.result.bounds)
    state.view_dirty = true
  }
  const export_w = 110 * scale
  if (widgets.button('ag_export', x + w - m - export_w, bar_y + (bar_h - btn_h) / 2, export_w, btn_h, 'Export GLB', { active: true })) {
    event.exported_bytes = avatar_generator_export_glb(state)
  }

  // --- layout: viewport + parameter sidebar ---------------------------------------
  const body_y = bar_y + bar_h + m
  const body_h = Math.max(40 * scale, y + h - m - body_y)
  const sidebar_w = w >= 460 * scale ? Math.min(280 * scale, Math.floor(w * 0.42)) : 0
  const vp_x = x + m
  const vp_w = Math.max(40 * scale, w - m * 2 - (sidebar_w > 0 ? sidebar_w + m : 0))

  draw_viewport(ui, theme, input, vp_x, body_y, vp_w, body_h, state, scale)
  if (sidebar_w > 0) draw_sidebar(ui, widgets, theme, x + m + vp_w + m, body_y, sidebar_w, body_h, state, scale)

  return event
}

// --- viewport ----------------------------------------------------------------------

function draw_viewport(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  vx: number,
  vy: number,
  vw: number,
  vh: number,
  state: avatar_generator_state,
  scale: number,
): void {
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const radius = 6 * scale
  ui.fill_round_rect(vx, vy, vw, vh, radius, slot('panel_alt'))

  const inside = point_in(input.mouse_x, input.mouse_y, vx, vy, vw, vh)
  const cam = state.camera
  const result = state.result

  // --- camera basis + world → screen projection for the bone overlay ----------
  const eye = orbit_camera_eye(cam)
  let fwd_x = cam.target[0] - eye[0], fwd_y = cam.target[1] - eye[1], fwd_z = cam.target[2] - eye[2]
  const fwd_len = Math.hypot(fwd_x, fwd_y, fwd_z) || 1
  fwd_x /= fwd_len; fwd_y /= fwd_len; fwd_z /= fwd_len
  // right = forward × world-up, up = right × forward (matches the render's look-at).
  let right_x = -fwd_z, right_y = 0, right_z = fwd_x
  const right_len = Math.hypot(right_x, right_y, right_z) || 1
  right_x /= right_len; right_z /= right_len
  const up_x = right_y * fwd_z - right_z * fwd_y
  const up_y = right_z * fwd_x - right_x * fwd_z
  const up_z = right_x * fwd_y - right_y * fwd_x
  const tan_half = Math.tan(cam.fov / 2)
  const aspect = Math.max(1e-6, vw / Math.max(1, vh))
  /** Project a world point into viewport px (+ camera depth), or null behind the eye. */
  const project = (px: number, py: number, pz: number): { sx: number; sy: number; depth: number } | null => {
    const dx = px - eye[0], dy = py - eye[1], dz = pz - eye[2]
    const depth = dx * fwd_x + dy * fwd_y + dz * fwd_z
    if (depth < 1e-4) return null
    const cx = dx * right_x + dy * right_y + dz * right_z
    const cy = dx * up_x + dy * up_y + dz * up_z
    return {
      sx: vx + vw / 2 + (cx / (depth * tan_half * aspect)) * (vw / 2),
      sy: vy + vh / 2 - (cy / (depth * tan_half)) * (vh / 2),
      depth,
    }
  }

  // --- bone overlay hit testing -------------------------------------------------
  // Joints project to screen circles; the nearest one under the cursor wins a
  // press over orbiting, so the body stays orbitable everywhere else.
  const joints = state.show_bones && result ? result.skeleton.joints : []
  const joint_screen: ({ sx: number; sy: number; depth: number } | null)[] = []
  let hover_joint = -1
  let hover_dist = Math.max(10, 9 * scale)
  for (let i = 0; i < joints.length; i += 1) {
    const p = project(joints[i]!.x, joints[i]!.y, joints[i]!.z)
    joint_screen.push(p)
    if (p && inside) {
      const d = Math.hypot(input.mouse_x - p.sx, input.mouse_y - p.sy)
      if (d < hover_dist) {
        hover_dist = d
        hover_joint = i
      }
    }
  }

  if (input.mouse_pressed && inside && hover_joint >= 0 && !state.bone_drag) {
    state.bone_drag = { joint: joints[hover_joint]!.name, last_mx: input.mouse_x, last_my: input.mouse_y }
  }
  if (state.bone_drag && input.mouse_down && result) {
    const drag = state.bone_drag
    const dx = input.mouse_x - drag.last_mx
    const dy = input.mouse_y - drag.last_my
    if (dx !== 0 || dy !== 0) {
      const skeleton = result.skeleton
      const index = skeleton.joints.findIndex((j) => j.name === drag.joint)
      if (index >= 0) {
        // Mouse delta → world delta in the camera plane at the joint's depth.
        const j = skeleton.joints[index]!
        const depth = (j.x - eye[0]) * fwd_x + (j.y - eye[1]) * fwd_y + (j.z - eye[2]) * fwd_z
        const per_px = (2 * Math.max(1e-4, depth) * tan_half) / Math.max(1, vh)
        const wx = right_x * dx * per_px - up_x * dy * per_px
        const wy = right_y * dx * per_px - up_y * dy * per_px
        const wz = right_z * dx * per_px - up_z * dy * per_px
        // The joint carries its whole subtree (forward kinematics feel), and the
        // mirrored side follows with x negated so the body stays symmetric.
        const moved = new Set<number>([index])
        for (let i = 0; i < skeleton.joints.length; i += 1) {
          if (moved.has(skeleton.joints[i]!.parent)) moved.add(i)
        }
        const add_offset = (name: string, ox: number, oy: number, oz: number): void => {
          const offset = state.joint_offsets[name] ?? [0, 0, 0]
          state.joint_offsets[name] = [offset[0] + ox, offset[1] + oy, offset[2] + oz]
        }
        const mirror_name = (name: string): string =>
          name.endsWith('_l') ? `${name.slice(0, -2)}_r` : name.endsWith('_r') ? `${name.slice(0, -2)}_l` : name
        const moved_names = new Set<string>()
        for (const i of moved) moved_names.add(skeleton.joints[i]!.name)
        for (const name of moved_names) {
          add_offset(name, wx, wy, wz)
          const twin = mirror_name(name)
          // Dragging a center joint already carries both sides in its subtree —
          // only echo to the twin when it isn't being moved directly.
          if (twin !== name && !moved_names.has(twin)) add_offset(twin, -wx, wy, wz)
        }
        state.params_dirty = true
      }
      drag.last_mx = input.mouse_x
      drag.last_my = input.mouse_y
    }
  } else if (state.bone_drag && !input.mouse_down) {
    state.bone_drag = null
  }
  if (state.bone_drag) ui.set_cursor('grabbing')
  else if (hover_joint >= 0) ui.set_cursor('grab')

  // Orbit / pan / zoom — identical feel to the asset-audit viewport. A press
  // that grabbed a joint never starts an orbit.
  if (input.mouse_pressed && inside && !state.bone_drag) {
    state.orbiting = !input.shift
    state.panning = input.shift
    state.last_mx = input.mouse_x
    state.last_my = input.mouse_y
  }
  if ((input.mouse_right_down || input.mouse_middle_down) && inside && !state.panning && !state.orbiting && !state.bone_drag) {
    state.panning = true
    state.last_mx = input.mouse_x
    state.last_my = input.mouse_y
  }
  const dragging = (state.orbiting && input.mouse_down) || (state.panning && (input.mouse_down || input.mouse_right_down || input.mouse_middle_down))
  if (dragging) {
    const dx = input.mouse_x - state.last_mx
    const dy = input.mouse_y - state.last_my
    if (dx !== 0 || dy !== 0) {
      if (state.orbiting) {
        cam.yaw -= dx * 0.0085
        cam.pitch = Math.min(1.55, Math.max(-1.55, cam.pitch + dy * 0.0085))
      } else {
        const per_px = (2 * cam.distance * Math.tan(cam.fov / 2)) / Math.max(1, vh)
        const right: [number, number, number] = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)]
        const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch)
        const up: [number, number, number] = [-Math.sin(cam.yaw) * sp, cp, -Math.cos(cam.yaw) * sp]
        cam.target[0] += (-dx * right[0] + dy * up[0]) * per_px
        cam.target[1] += (-dx * right[1] + dy * up[1]) * per_px
        cam.target[2] += (-dx * right[2] + dy * up[2]) * per_px
      }
      state.last_mx = input.mouse_x
      state.last_my = input.mouse_y
      state.view_dirty = true
    }
  } else {
    state.orbiting = false
    state.panning = false
  }
  if (inside && input.wheel_y !== 0) {
    const b = result?.bounds
    const bounds_radius = b ? Math.max(1e-4, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2) : cam.distance
    orbit_camera_zoom(cam, Math.exp(-input.wheel_y * 0.16), bounds_radius)
    state.view_dirty = true
  }
  if (inside && input.zoom_factor && input.zoom_factor !== 1) {
    const b = result?.bounds
    const bounds_radius = b ? Math.max(1e-4, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2) : cam.distance
    orbit_camera_zoom(cam, 1 / input.zoom_factor, bounds_radius)
    state.view_dirty = true
  }
  if (orbit_camera_step_damping(cam)) {
    state.view_dirty = true
  }

  // --- offscreen 3D pass --------------------------------------------------------
  const { device } = ui.gpu()
  if (result && device) {
    state.view.init(device)
    const key = `${state.mesh_revision}:${state.show_skeleton ? 1 : 0}:${result.meshes?.length ?? 1}`
    if (state.synced_key !== key) {
      state.view.set_meshes(result_meshes(result, state.show_skeleton))
      state.synced_key = key
      state.view_dirty = true
    }
    const px_w = Math.max(1, Math.floor(vw))
    const px_h = Math.max(1, Math.floor(vh))
    if (state.texture && (state.texture.width !== px_w || state.texture.height !== px_h)) state.view_dirty = true
    if (state.view_dirty) {
      const b = result.bounds
      const bounds_radius = Math.max(1e-4, Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) / 2)
      const clear = hex_to_normalized_rgba(theme.palette.panel_alt)
      const texture = state.view.render(px_w, px_h, cam, { wireframe: state.wireframe, mode: state.view_mode, clear, bounds_radius })
      if (texture) {
        if (state.texture_id === null) state.texture_id = ui.register_external_texture(texture)
        else if (texture !== state.texture) ui.update_external_texture(state.texture_id, texture)
        state.texture = texture
      }
      state.view_dirty = false
    }
    if (state.texture_id !== null) {
      ui.push_clip(vx, vy, vw, vh)
      ui.draw_texture(state.texture_id, vx, vy, vw, vh)
      ui.pop_clip()
    }
    if (state.draft) {
      ui.draw_text(vx + 10 * scale, vy + 10 * scale, 'draft preview — release to refine', 9.5 * scale, slot('accent'), FONT_MONO)
    }
  } else {
    const msg = state.backend === 'template' && state.template_status === 'loading'
      ? 'Loading base characters...'
      : state.backend === 'template' && state.template_status === 'error'
        ? `Template load failed: ${state.template_error ?? 'unknown error'}`
        : 'WebGPU device not ready...'
    ui.draw_text(vx + 12 * scale, vy + 12 * scale, msg, 11 * scale, slot('text_dim'))
  }

  // --- bone editing overlay (drawn x-ray style over the 3D image) ---------------
  if (state.show_bones && result) {
    ui.push_clip(vx, vy, vw, vh)
    const bone_color = slot('text_dim')
    for (const [pi, ci] of result.skeleton.bones) {
      const a = joint_screen[pi]
      const b = joint_screen[ci]
      if (a && b) ui.stroke_line(a.sx, a.sy, b.sx, b.sy, Math.max(1, 1.4 * scale), bone_color)
    }
    const dragged = state.bone_drag?.joint ?? null
    for (let i = 0; i < joints.length; i += 1) {
      const p = joint_screen[i]
      if (!p) continue
      const active = joints[i]!.name === dragged
      const hot = active || i === hover_joint
      const r = (hot ? 4.5 : 3.2) * scale
      ui.fill_circle(p.sx, p.sy, r, hot ? slot('accent') : slot('panel'))
      ui.stroke_circle(p.sx, p.sy, r, Math.max(1, 1.2 * scale), hot ? slot('text') : slot('accent'))
    }
    ui.pop_clip()
  }

  const hint = state.show_bones
    ? 'drag a circle to move that bone · drag orbit · shift-drag pan · wheel zoom'
    : 'drag orbit · shift-drag / right-drag pan · wheel zoom'
  ui.draw_text(vx + 10 * scale, vy + vh - 18 * scale, hint, 9 * scale, slot('text_dim'), FONT_MONO)
  ui.stroke_round_rect(vx, vy, vw, vh, radius, 1, slot('border'))
}

// --- sidebar -------------------------------------------------------------------------

function draw_sidebar(
  ui: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  state: avatar_generator_state,
  scale: number,
): void {
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const radius = 6 * scale
  ui.fill_round_rect(sx, sy, sw, sh, radius, slot('panel_alt'))
  ui.stroke_round_rect(sx, sy, sw, sh, radius, 1, slot('border'))

  const pad = 10 * scale
  widgets.handle_scroll_area(sx, sy, sw, sh, state.sidebar_scroll, state.sidebar_content_h)
  const max_off = Math.max(0, state.sidebar_content_h - sh)
  state.sidebar_scroll.offset_y = Math.max(0, Math.min(max_off, state.sidebar_scroll.offset_y))

  ui.push_clip(sx, sy, sw, sh)
  const inner_w = sw - pad * 2
  let cy = sy + pad - state.sidebar_scroll.offset_y
  const section_font = 9.5 * scale
  const row_font = 10.5 * scale

  const section = (label: string): void => {
    ui.draw_text(sx + pad, cy, label, section_font, slot('accent'), FONT_MONO)
    cy += 16 * scale
  }
  const row = (label: string, value: string): void => {
    ui.draw_text(sx + pad, cy, label, row_font, slot('text_dim'))
    const vw = ui.text_width(value, row_font, FONT_MONO)
    ui.draw_text(sx + sw - pad - vw, cy, value, row_font, slot('text'), FONT_MONO)
    cy += 16 * scale
  }

  const p = state.params
  type numeric_param = { [K in keyof avatar_params]: avatar_params[K] extends number ? K : never }[keyof avatar_params]
  const param_slider = (key: numeric_param, label: string, min: number, max: number, fmt: (v: number) => string): void => {
    ui.draw_text(sx + pad, cy, label, row_font, slot('text_dim'))
    const value_text = fmt(p[key])
    const vw = ui.text_width(value_text, row_font, FONT_MONO)
    ui.draw_text(sx + sw - pad - vw, cy, value_text, row_font, slot('text'), FONT_MONO)
    cy += 13 * scale
    const next = widgets.slider(`ag_p_${key}`, sx + pad, cy, inner_w, 14 * scale, p[key], min, max)
    if (next !== p[key]) {
      p[key] = next
      state.params_dirty = true
    }
    cy += 18 * scale
  }
  const pct = (v: number) => `${Math.round(v * 100)}%`
  const result = state.result

  section('STATURE')
  param_slider('height', 'Height', 0.9, 2.2, (v) => `${v.toFixed(2)} m`)
  param_slider('head_size', 'Head size', 0, 1, pct)
  cy += 6 * scale

  section('BODY MASS')
  param_slider('build', 'Build · fem → masc', 0, 1, pct)
  param_slider('muscle', 'Muscle', 0, 1, pct)
  param_slider('fat', 'Fat', 0, 1, pct)
  param_slider('limb_thickness', 'Limb girth', 0, 1, pct)
  cy += 6 * scale

  section('PROPORTIONS')
  param_slider('shoulder_width', 'Shoulder span', 0, 1, pct)
  param_slider('hip_width', 'Hip span', 0, 1, pct)
  param_slider('torso_length', 'Torso length', 0, 1, pct)
  param_slider('arm_length', 'Arm length', 0, 1, pct)
  param_slider('leg_length', 'Leg length', 0, 1, pct)
  cy += 6 * scale

  section('SURFACE')
  if (state.backend === 'sdf') {
    param_slider('blend', 'Blend softness', 0, 1, pct)
    param_slider('resolution', 'Grid resolution', 24, 160, (v) => `${Math.round(v)}`)
  } else {
    row('Backend', result?.template_name ?? (state.template_status === 'ready' ? 'Template' : state.template_status))
    if (state.template_status === 'error') row('Error', state.template_error ?? 'unknown')
  }
  cy += 6 * scale

  if (result) {
    const meshes = result.meshes ?? [result.mesh]
    let vertices = 0
    let triangles = 0
    let geometry = 0
    for (const mesh of meshes) {
      vertices += mesh.positions.length / 3
      triangles += mesh.indices.length / 3
      geometry += mesh.positions.byteLength + mesh.normals.byteLength + (mesh.uvs?.byteLength ?? 0) + mesh.indices.byteLength
    }
    section('MESH')
    row('Meshes', `${meshes.length}`)
    row('Vertices', `${vertices}`)
    row('Triangles', `${triangles}`)
    if (state.backend === 'sdf') row('Grid', `${result.cells[0]}×${result.cells[1]}×${result.cells[2]}`)
    row('Generated in', `${result.generation_ms.toFixed(1)} ms`)
    row('Geometry', format_asset_bytes(geometry))
    cy += 6 * scale
    section('SKELETON')
    row('Joints', `${result.skeleton.joints.length}`)
    row('Bones', `${result.skeleton.bones.length}`)
    const b = result.bounds
    row('Span', `${(b.max[0] - b.min[0]).toFixed(2)} × ${(b.max[1] - b.min[1]).toFixed(2)} × ${(b.max[2] - b.min[2]).toFixed(2)} m`)
    const edited = Object.keys(state.joint_offsets).length
    if (edited > 0) {
      row('Edited joints', `${edited}`)
      const rb_h = 24 * scale
      if (widgets.button('ag_reset_bones', sx + pad, cy, inner_w, rb_h, 'Reset bone edits')) {
        state.joint_offsets = {}
        state.params_dirty = true
      }
      cy += rb_h + 5 * scale
    }
    cy += 6 * scale
  }

  section('PIPELINE')
  const pipeline_text = state.backend === 'template'
    ? 'Universal Base Characters template mesh → character selection → proportion scaling from sliders → stable material meshes → GLB export. SDF Draft remains available as an experimental fallback.'
    : 'skeleton (finger/toe chains, breast anchors) → bone frame volumes → muscle layer → fat layer → smooth union → surface nets → mesh.'
  cy += ui.draw_text_wrapped(sx + pad, cy, inner_w, pipeline_text, 9.5 * scale, slot('text_dim')) + 8 * scale

  state.sidebar_content_h = cy + state.sidebar_scroll.offset_y - sy + pad
  ui.pop_clip()
  if (state.sidebar_content_h > sh) {
    const sb_w = 6 * scale
    widgets.scrollbar('ag_sidebar_sb', sx + sw - sb_w - 2 * scale, sy + 2 * scale, sb_w, sh - 4 * scale, state.sidebar_scroll, state.sidebar_content_h)
  }
}
