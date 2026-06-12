// Avatar generator — an immediate-mode panel around the procedural human-body
// pipeline in ui_avatar_body: tune skeleton + volume parameters with sliders,
// watch the mesh regenerate live in a WebGPU orbit viewport (drafted at a
// coarse grid while a slider is held, refined on release), toggle the armature
// overlay, and export the result as a self-contained GLB.
//
// The 3D pass reuses the asset-audit viewer (`asset_audit_view`) and the GLB
// writer (`encode_asset_glb`) — the generator only produces `audit_mesh` data.

import { pack_color, hex_to_normalized_rgba } from '../ui_theme'
import type { theme_definition } from '../ui_types'
import { FONT_MONO, type ui_renderer } from '../ui_renderer'
import type { ui_input_snapshot, ui_scroll_state, ui_widgets } from '../ui_widgets'
import { encode_asset_glb, format_asset_bytes, type audit_asset } from './ui_asset_audit_data'
import {
  asset_audit_view,
  create_orbit_camera,
  frame_orbit_camera,
  type asset_audit_view_mode,
  type orbit_camera,
} from './ui_asset_audit_view'
import {
  AVATAR_PRESETS,
  apply_avatar_preset,
  create_avatar_params,
  generate_avatar,
  type avatar_build_result,
  type avatar_params,
} from './ui_avatar_body'

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
  }
}

function regenerate(state: avatar_generator_state, draft: boolean): void {
  state.result = generate_avatar(state.params, draft ? Math.min(DRAFT_RESOLUTION, state.params.resolution) : undefined)
  state.draft = draft && state.params.resolution > DRAFT_RESOLUTION
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
  const meshes = state.show_skeleton ? [result.mesh, result.skeleton_mesh] : [result.mesh]
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
  if (!state.result || state.params_dirty) regenerate(state, input.mouse_down)
  else if (state.draft && !input.mouse_down) regenerate(state, false)

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
    state.params_dirty = true
  }
  bx += 96 * scale + 10 * scale

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

  const mode_button = (id: string, label: string, width: number, mode: asset_audit_view_mode): void => {
    if (button(id, label, width, { active: state.view_mode === mode }) && state.view_mode !== mode) {
      state.view_mode = mode
      state.view_dirty = true
    }
  }
  mode_button('ag_mode_shaded', 'Shaded', 62 * scale, 'shaded')
  mode_button('ag_mode_normal', 'Normal', 60 * scale, 'normal')
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

  // Orbit / pan / zoom — identical feel to the asset-audit viewport.
  if (input.mouse_pressed && inside) {
    state.orbiting = !input.shift
    state.panning = input.shift
    state.last_mx = input.mouse_x
    state.last_my = input.mouse_y
  }
  if ((input.mouse_right_down || input.mouse_middle_down) && inside && !state.panning && !state.orbiting) {
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
    cam.distance = Math.max(1e-4, cam.distance * Math.exp(input.wheel_y * 0.0012))
    state.view_dirty = true
  }
  if (inside && input.zoom_factor && input.zoom_factor !== 1) {
    cam.distance = Math.max(1e-4, cam.distance / input.zoom_factor)
    state.view_dirty = true
  }

  // --- offscreen 3D pass --------------------------------------------------------
  const result = state.result
  const { device } = ui.gpu()
  if (result && device) {
    state.view.init(device)
    const key = `${state.mesh_revision}:${state.show_skeleton ? 1 : 0}`
    if (state.synced_key !== key) {
      state.view.set_meshes(state.show_skeleton ? [result.mesh, result.skeleton_mesh] : [result.mesh])
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
    ui.draw_text(vx + 12 * scale, vy + 12 * scale, 'WebGPU device not ready…', 11 * scale, slot('text_dim'))
  }
  const hint = 'drag orbit · shift-drag / right-drag pan · wheel zoom'
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
  param_slider('blend', 'Blend softness', 0, 1, pct)
  param_slider('resolution', 'Grid resolution', 24, 128, (v) => `${Math.round(v)}`)
  cy += 6 * scale

  const result = state.result
  if (result) {
    section('MESH')
    row('Vertices', `${result.mesh.positions.length / 3}`)
    row('Triangles', `${result.mesh.indices.length / 3}`)
    row('Grid', `${result.cells[0]}×${result.cells[1]}×${result.cells[2]}`)
    row('Generated in', `${result.generation_ms.toFixed(1)} ms`)
    row('Geometry', format_asset_bytes(result.mesh.positions.byteLength + result.mesh.normals.byteLength + result.mesh.indices.byteLength))
    cy += 6 * scale
    section('SKELETON')
    row('Joints', `${result.skeleton.joints.length}`)
    row('Bones', `${result.skeleton.bones.length}`)
    const b = result.bounds
    row('Span', `${(b.max[0] - b.min[0]).toFixed(2)} × ${(b.max[1] - b.min[1]).toFixed(2)} × ${(b.max[2] - b.min[2]).toFixed(2)} m`)
    cy += 6 * scale
  }

  section('PIPELINE')
  cy += ui.draw_text_wrapped(
    sx + pad,
    cy,
    inner_w,
    'skeleton → SDF volumes per bone → smooth union → surface nets → mesh. No template geometry: every vertex derives from the parameters above.',
    9.5 * scale,
    slot('text_dim'),
  ) + 8 * scale

  state.sidebar_content_h = cy + state.sidebar_scroll.offset_y - sy + pad
  ui.pop_clip()
  if (state.sidebar_content_h > sh) {
    const sb_w = 6 * scale
    widgets.scrollbar('ag_sidebar_sb', sx + sw - sb_w - 2 * scale, sy + 2 * scale, sb_w, sh - 4 * scale, state.sidebar_scroll, state.sidebar_content_h)
  }
}
