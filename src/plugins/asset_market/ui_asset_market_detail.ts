// asset_market — Asset Detail: an immediate-mode 3D viewer for one scene.
//
// Where the storefront (ui_asset_market) sells whole scenes, this panel opens
// one of them for inspection: an interactive viewport (orbit or free-fly
// camera) next to a sidebar listing the scene's named parts and the mesh
// statistics of whatever is selected. View modes cover the raster set drawn by
// ui_asset_market_detail_view (shaded / wireframe / normal / uv) plus a
// progressive raytrace mode served by the webtix path tracer. Clicking the
// viewport CPU-raycasts the parts to select one — the statistics follow the
// selection; clicking empty space (or Escape) returns to whole-scene numbers.

import { pack_color } from '../../core/ui_theme'
import type { theme_definition } from '../../core/ui_types'
import { FONT_MONO, type ui_renderer } from '../../core/ui_renderer'
import type { ui_input_snapshot, ui_scroll_state, ui_widgets } from '../../core/ui_widgets'
import {
  create_orbit_camera,
  frame_orbit_camera,
  orbit_camera_eye,
  orbit_camera_step_damping,
  orbit_camera_zoom,
  type orbit_camera,
} from '../asset_audit/ui_asset_audit_view'
import { build_tlas } from '../webtix/ui_webtix_bvh'
import { default_material, webtix_tracer, type webtix_material } from '../webtix/ui_webtix_tracer'
import type { scene_market_item } from './ui_asset_market_scene'
import {
  asset_detail_gpu_view,
  asset_detail_part_color,
  asset_detail_pick,
  compute_asset_detail_stats,
  compute_geometry_bounds,
  create_asset_detail_free_camera,
  ensure_geometry_normals,
  free_camera_basis,
  sum_asset_detail_stats,
  union_bounds,
  type asset_detail_bounds,
  type asset_detail_camera_frame,
  type asset_detail_free_camera,
  type asset_detail_part,
  type asset_detail_part_input,
  type asset_detail_raster_mode,
  type asset_detail_ray,
  type asset_detail_stats,
  type asset_detail_vec3,
} from './ui_asset_market_detail_view'

export type asset_detail_view_mode = asset_detail_raster_mode | 'raytrace'
export type asset_detail_camera_mode = 'orbit' | 'free'

const VIEW_MODES: asset_detail_view_mode[] = ['shaded', 'wireframe', 'normal', 'uv', 'raytrace']
const VIEW_MODE_LABELS = ['Shaded', 'Wireframe', 'Normal', 'UV', 'Raytrace']
const CAMERA_MODES: asset_detail_camera_mode[] = ['orbit', 'free']
const CAMERA_MODE_LABELS = ['Orbit', 'Free']

const RAYTRACE_SAMPLES = 128
const RAYTRACE_BOUNCES = 4

export interface asset_detail_state {
  /** The scene being inspected; null renders an empty hint. */
  item: scene_market_item | null
  parts: asset_detail_part[]
  scene_stats: asset_detail_stats | null
  bounds: asset_detail_bounds | null
  bounds_radius: number
  /** Selected part index, or -1 for the whole scene. */
  selected_part: number
  view_mode: asset_detail_view_mode
  camera_mode: asset_detail_camera_mode
  orbit: orbit_camera
  free: asset_detail_free_camera
  view: asset_detail_gpu_view
  /** Bumped by set_scene so GPU uploads / TLAS builds resync lazily. */
  scene_version: number
  raster_synced_version: number
  texture_id: number | null
  // raytrace
  tracer: webtix_tracer | null
  tracer_synced_version: number
  tracer_camera_signature: string
  tracer_material: webtix_material
  // viewport interaction
  orbiting: boolean
  panning: boolean
  looking: boolean
  last_mx: number
  last_my: number
  press_x: number
  press_y: number
  press_in_viewport: boolean
  last_frame_ms: number
  sidebar_scroll: ui_scroll_state
  sidebar_content_h: number
}

export interface asset_detail_event {
  /** Selection moved; `part_index` is -1 (whole scene) or a parts index. */
  selection_changed?: { part_index: number; part_name: string | null }
  view_mode_changed?: asset_detail_view_mode
  camera_mode_changed?: asset_detail_camera_mode
}

export interface asset_detail_options {
  scale?: number
}

export function create_asset_detail_state(): asset_detail_state {
  const material = default_material()
  material.roughness = 0.32
  material.specular = 0.6
  return {
    item: null,
    parts: [],
    scene_stats: null,
    bounds: null,
    bounds_radius: 1,
    selected_part: -1,
    view_mode: 'shaded',
    camera_mode: 'orbit',
    orbit: create_orbit_camera(),
    free: create_asset_detail_free_camera(),
    view: new asset_detail_gpu_view(),
    scene_version: 0,
    raster_synced_version: -1,
    texture_id: null,
    tracer: null,
    tracer_synced_version: -1,
    tracer_camera_signature: '',
    tracer_material: material,
    orbiting: false,
    panning: false,
    looking: false,
    last_mx: 0,
    last_my: 0,
    press_x: 0,
    press_y: 0,
    press_in_viewport: false,
    last_frame_ms: 0,
    sidebar_scroll: { offset_y: 0 },
    sidebar_content_h: 0,
  }
}

/** Load a scene into the detail view: ingest parts, frame cameras, reset picks. */
export function asset_detail_set_scene(state: asset_detail_state, item: scene_market_item, parts: asset_detail_part_input[]): void {
  state.item = item
  state.parts = parts.map((part) => ({
    name: part.name,
    geometry: part.geometry,
    stats: compute_asset_detail_stats(part.geometry, part.face_count),
    bounds: compute_geometry_bounds(part.geometry),
  }))
  state.scene_stats = sum_asset_detail_stats(state.parts)
  state.bounds = union_bounds(state.parts.map((part) => part.bounds))
  const dx = state.bounds.max[0] - state.bounds.min[0]
  const dy = state.bounds.max[1] - state.bounds.min[1]
  const dz = state.bounds.max[2] - state.bounds.min[2]
  state.bounds_radius = Math.max(1e-3, Math.hypot(dx, dy, dz) / 2)
  state.selected_part = -1
  state.scene_version += 1
  frame_cameras(state)
}

/** Stats for the current selection (whole scene when no part is picked). */
export function asset_detail_selection_stats(state: asset_detail_state): asset_detail_stats | null {
  if (state.selected_part >= 0) return state.parts[state.selected_part]?.stats ?? null
  return state.scene_stats
}

// --- free-camera key tracking -------------------------------------------------
// The shared ui_input_snapshot carries edge-triggered editing keys only, so the
// fly camera tracks WASD/QE itself with window-level listeners (installed once,
// on first use; ignored while a text field has focus).

const held_keys = new Set<string>()
let key_listener_installed = false

function ensure_key_listener(): void {
  if (key_listener_installed || typeof window === 'undefined') return
  key_listener_installed = true
  const in_text_field = (target: EventTarget | null): boolean =>
    target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)
  window.addEventListener('keydown', (event) => {
    if (!in_text_field(event.target)) held_keys.add(event.code)
  })
  window.addEventListener('keyup', (event) => held_keys.delete(event.code))
  window.addEventListener('blur', () => held_keys.clear())
}

// --- panel ---------------------------------------------------------------------

function point_in(px: number, py: number, x: number, y: number, w: number, h: number): boolean {
  return px >= x && py >= y && px <= x + w && py <= y + h
}

export function asset_market_detail(
  ui: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  state: asset_detail_state,
  options?: asset_detail_options,
): asset_detail_event {
  const scale = options?.scale ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const event: asset_detail_event = {}
  const m = 8 * scale

  ui.fill_rect(x, y, w, h, slot('panel'))

  if (!state.item) {
    const hint = 'Open a scene from the Scene Market to inspect it here.'
    ui.draw_text(x + m + 4 * scale, y + m + 6 * scale, 'Asset Detail', 13 * scale, slot('text'))
    ui.draw_text(x + m + 4 * scale, y + m + 30 * scale, hint, 11 * scale, slot('text_dim'))
    return event
  }

  // --- toolbar ---------------------------------------------------------------
  const bar_h = 30 * scale
  const ctl_h = 24 * scale
  const bar_y = y + m
  let bx = x + m
  const ctl_y = bar_y + (bar_h - ctl_h) / 2
  ui.draw_text(bx, bar_y + (bar_h - 11 * scale) / 2, 'Camera', 11 * scale, slot('text_dim'))
  bx += 50 * scale
  const camera_index = Math.max(0, CAMERA_MODES.indexOf(state.camera_mode))
  const next_camera = widgets.dropdown('asset_detail_camera', bx, ctl_y, 78 * scale, ctl_h, CAMERA_MODE_LABELS, camera_index)
  if (next_camera !== camera_index) {
    set_camera_mode(state, CAMERA_MODES[next_camera]!)
    event.camera_mode_changed = state.camera_mode
  }
  bx += 78 * scale + 10 * scale

  ui.draw_text(bx, bar_y + (bar_h - 11 * scale) / 2, 'Mode', 11 * scale, slot('text_dim'))
  bx += 38 * scale
  const mode_index = Math.max(0, VIEW_MODES.indexOf(state.view_mode))
  const next_mode = widgets.dropdown('asset_detail_mode', bx, ctl_y, 100 * scale, ctl_h, VIEW_MODE_LABELS, mode_index)
  if (next_mode !== mode_index) {
    state.view_mode = VIEW_MODES[next_mode]!
    state.tracer_camera_signature = '' // restart accumulation when re-entering
    event.view_mode_changed = state.view_mode
  }
  bx += 100 * scale + 10 * scale

  if (widgets.button('asset_detail_frame', bx, ctl_y, 64 * scale, ctl_h, 'Frame')) {
    frame_cameras(state)
    state.tracer_camera_signature = ''
  }
  bx += 64 * scale + 10 * scale

  // Right side of the bar: scene name, plus spp progress while raytracing.
  let right_label = state.item.name
  let right_color = slot('text_dim')
  if (state.view_mode === 'raytrace' && state.tracer) {
    const done = Math.min(state.tracer.samples, RAYTRACE_SAMPLES)
    right_label = `${done} / ${RAYTRACE_SAMPLES} spp`
    if (done < RAYTRACE_SAMPLES) right_color = slot('accent')
  }
  const rf = 10 * scale
  const rw = ui.text_width(right_label, rf, FONT_MONO)
  if (x + w - m - rw > bx) ui.draw_text(x + w - m - rw, bar_y + (bar_h - rf) / 2, right_label, rf, right_color, FONT_MONO)

  // --- layout: viewport + sidebar ---------------------------------------------
  const body_y = bar_y + bar_h + m
  const body_h = Math.max(40 * scale, y + h - m - body_y)
  const sidebar_w = w >= 560 * scale ? Math.min(250 * scale, Math.floor(w * 0.34)) : 0
  const vp_x = x + m
  const vp_y = body_y
  const vp_w = Math.max(40 * scale, w - m * 2 - (sidebar_w > 0 ? sidebar_w + m : 0))
  const vp_h = body_h

  const camera_moved = handle_camera(state, input, ui, vp_x, vp_y, vp_w, vp_h)
  handle_pick(state, input, vp_x, vp_y, vp_w, vp_h, event)
  if (input.key_escape && state.selected_part >= 0) {
    state.selected_part = -1
    event.selection_changed = { part_index: -1, part_name: null }
  }

  const { device } = ui.gpu()
  if (device) {
    draw_viewport(ui, theme, vp_x, vp_y, vp_w, vp_h, state, scale, camera_moved, device)
  } else {
    ui.fill_round_rect(vp_x, vp_y, vp_w, vp_h, 6 * scale, slot('panel_alt'))
    ui.draw_text(vp_x + 12 * scale, vp_y + 12 * scale, 'WebGPU device not ready…', 11 * scale, slot('text_dim'))
  }

  if (sidebar_w > 0) draw_sidebar(ui, theme, input, x + m + vp_w + m, body_y, sidebar_w, body_h, state, scale, event)

  return event
}

// --- cameras --------------------------------------------------------------------

function frame_cameras(state: asset_detail_state): void {
  if (!state.bounds) return
  frame_orbit_camera(state.orbit, state.bounds)
  sync_free_from_orbit(state)
}

/** Place the fly camera at the orbit eye, looking at the orbit target. */
function sync_free_from_orbit(state: asset_detail_state): void {
  const eye = orbit_camera_eye(state.orbit)
  state.free.position = [eye[0], eye[1], eye[2]]
  state.free.yaw = state.orbit.yaw + Math.PI
  state.free.pitch = -state.orbit.pitch
  state.free.fov = state.orbit.fov
}

/** Re-target the orbit camera at what the fly camera is looking at. */
function sync_orbit_from_free(state: asset_detail_state): void {
  const { forward } = free_camera_basis(state.free)
  const distance = Math.max(state.bounds_radius * 0.1, state.orbit.distance)
  state.orbit.target = [
    state.free.position[0] + forward[0] * distance,
    state.free.position[1] + forward[1] * distance,
    state.free.position[2] + forward[2] * distance,
  ]
  state.orbit.yaw = state.free.yaw - Math.PI
  state.orbit.pitch = Math.min(1.55, Math.max(-1.55, -state.free.pitch))
  state.orbit.distance = distance
  state.orbit.target_distance = distance
}

function set_camera_mode(state: asset_detail_state, mode: asset_detail_camera_mode): void {
  if (mode === state.camera_mode) return
  if (mode === 'free') sync_free_from_orbit(state)
  else sync_orbit_from_free(state)
  state.camera_mode = mode
  state.tracer_camera_signature = ''
}

function current_camera_frame(state: asset_detail_state): asset_detail_camera_frame {
  const radius = state.bounds_radius
  if (state.camera_mode === 'free') {
    const cam = state.free
    const { forward } = free_camera_basis(cam)
    const target: asset_detail_vec3 = [
      cam.position[0] + forward[0],
      cam.position[1] + forward[1],
      cam.position[2] + forward[2],
    ]
    return {
      eye: [cam.position[0], cam.position[1], cam.position[2]],
      target,
      up: [0, 1, 0],
      fov: cam.fov,
      near: Math.max(1e-4, radius * 1e-3),
      far: distance_to_bounds_center(state, cam.position) + radius * 6,
    }
  }
  const cam = state.orbit
  const eye = orbit_camera_eye(cam)
  return {
    eye,
    target: [cam.target[0], cam.target[1], cam.target[2]],
    up: [0, 1, 0],
    fov: cam.fov,
    near: Math.max(radius * 1e-3, cam.distance * 1e-3),
    far: cam.distance + radius * 4,
  }
}

function distance_to_bounds_center(state: asset_detail_state, position: asset_detail_vec3): number {
  if (!state.bounds) return state.bounds_radius
  const cx = (state.bounds.min[0] + state.bounds.max[0]) / 2
  const cy = (state.bounds.min[1] + state.bounds.max[1]) / 2
  const cz = (state.bounds.min[2] + state.bounds.max[2]) / 2
  return Math.hypot(position[0] - cx, position[1] - cy, position[2] - cz)
}

function handle_camera(
  state: asset_detail_state,
  input: ui_input_snapshot,
  ui: ui_renderer,
  vx: number,
  vy: number,
  vw: number,
  vh: number,
): boolean {
  const inside = point_in(input.mouse_x, input.mouse_y, vx, vy, vw, vh)
  let moved = false

  if (input.mouse_pressed && inside) {
    state.press_x = input.mouse_x
    state.press_y = input.mouse_y
    state.press_in_viewport = true
    if (state.camera_mode === 'orbit') {
      state.orbiting = !input.shift
      state.panning = input.shift
    } else {
      state.looking = true
    }
    state.last_mx = input.mouse_x
    state.last_my = input.mouse_y
  }
  if (state.camera_mode === 'orbit' && (input.mouse_right_down || input.mouse_middle_down) && inside && !state.panning && !state.orbiting) {
    state.panning = true
    state.last_mx = input.mouse_x
    state.last_my = input.mouse_y
  }

  const orbit_dragging = (state.orbiting && input.mouse_down) || (state.panning && (input.mouse_down || input.mouse_right_down || input.mouse_middle_down))
  const free_dragging = state.looking && input.mouse_down
  if (orbit_dragging || free_dragging) {
    const dx = input.mouse_x - state.last_mx
    const dy = input.mouse_y - state.last_my
    if (dx !== 0 || dy !== 0) {
      if (free_dragging) {
        state.free.yaw -= dx * 0.0042
        state.free.pitch = Math.min(1.55, Math.max(-1.55, state.free.pitch - dy * 0.0042))
      } else if (state.orbiting) {
        state.orbit.yaw -= dx * 0.0085
        state.orbit.pitch = Math.min(1.55, Math.max(-1.55, state.orbit.pitch + dy * 0.0085))
      } else {
        const cam = state.orbit
        const per_px = (2 * cam.distance * Math.tan(cam.fov / 2)) / Math.max(1, vh)
        const right: asset_detail_vec3 = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)]
        const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch)
        const up: asset_detail_vec3 = [-Math.sin(cam.yaw) * sp, cp, -Math.cos(cam.yaw) * sp]
        cam.target[0] += (-dx * right[0] + dy * up[0]) * per_px
        cam.target[1] += (-dx * right[1] + dy * up[1]) * per_px
        cam.target[2] += (-dx * right[2] + dy * up[2]) * per_px
      }
      state.last_mx = input.mouse_x
      state.last_my = input.mouse_y
      moved = true
    }
  } else {
    state.orbiting = false
    state.panning = false
    state.looking = false
  }

  if (inside && input.wheel_y !== 0) {
    if (state.camera_mode === 'orbit') {
      orbit_camera_zoom(state.orbit, Math.exp(-input.wheel_y * 0.16), state.bounds_radius)
    } else {
      const { forward } = free_camera_basis(state.free)
      const step = input.wheel_y * state.bounds_radius * 0.08
      state.free.position[0] += forward[0] * step
      state.free.position[1] += forward[1] * step
      state.free.position[2] += forward[2] * step
      moved = true
    }
  }
  if (inside && input.zoom_factor && input.zoom_factor !== 1 && state.camera_mode === 'orbit') {
    orbit_camera_zoom(state.orbit, 1 / input.zoom_factor, state.bounds_radius)
  }
  if (state.camera_mode === 'orbit' && orbit_camera_step_damping(state.orbit)) moved = true

  // Free-fly movement: WASD strafes, Q/E descends/ascends, Shift sprints.
  const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
  const dt = state.last_frame_ms ? Math.min(0.1, (now - state.last_frame_ms) / 1000) : 0
  state.last_frame_ms = now
  if (state.camera_mode === 'free') {
    ensure_key_listener()
    const active = inside || state.looking
    if (active && dt > 0) {
      const { forward, right } = free_camera_basis(state.free)
      let mx = 0, mz = 0, my = 0
      if (held_keys.has('KeyW')) mz += 1
      if (held_keys.has('KeyS')) mz -= 1
      if (held_keys.has('KeyD')) mx += 1
      if (held_keys.has('KeyA')) mx -= 1
      if (held_keys.has('KeyE')) my += 1
      if (held_keys.has('KeyQ')) my -= 1
      if (mx !== 0 || my !== 0 || mz !== 0) {
        const speed = state.bounds_radius * 1.4 * (input.shift ? 3 : 1) * dt
        state.free.position[0] += (forward[0] * mz + right[0] * mx) * speed
        state.free.position[1] += (forward[1] * mz + right[1] * mx + my) * speed
        state.free.position[2] += (forward[2] * mz + right[2] * mx) * speed
        moved = true
        ui.request_render() // keep flying while the keys stay held
      }
    }
  }
  return moved
}

// --- picking ---------------------------------------------------------------------

function viewport_ray(state: asset_detail_state, mx: number, my: number, vx: number, vy: number, vw: number, vh: number): asset_detail_ray {
  const frame = current_camera_frame(state)
  let fx = frame.target[0] - frame.eye[0]
  let fy = frame.target[1] - frame.eye[1]
  let fz = frame.target[2] - frame.eye[2]
  const flen = Math.hypot(fx, fy, fz) || 1
  fx /= flen; fy /= flen; fz /= flen
  let rx = fy * frame.up[2] - fz * frame.up[1]
  let ry = fz * frame.up[0] - fx * frame.up[2]
  let rz = fx * frame.up[1] - fy * frame.up[0]
  const rlen = Math.hypot(rx, ry, rz) || 1
  rx /= rlen; ry /= rlen; rz /= rlen
  const ux = ry * fz - rz * fy
  const uy = rz * fx - rx * fz
  const uz = rx * fy - ry * fx
  const ndc_x = ((mx - vx) / Math.max(1, vw)) * 2 - 1
  const ndc_y = 1 - ((my - vy) / Math.max(1, vh)) * 2
  const tan_half = Math.tan(frame.fov / 2)
  const aspect = vw / Math.max(1, vh)
  const dx = fx + ndc_x * aspect * tan_half * rx + ndc_y * tan_half * ux
  const dy = fy + ndc_x * aspect * tan_half * ry + ndc_y * tan_half * uy
  const dz = fz + ndc_x * aspect * tan_half * rz + ndc_y * tan_half * uz
  const dlen = Math.hypot(dx, dy, dz) || 1
  return { origin: frame.eye, dir: [dx / dlen, dy / dlen, dz / dlen] }
}

/** Click (press + release without dragging) selects the part under the cursor. */
function handle_pick(
  state: asset_detail_state,
  input: ui_input_snapshot,
  vx: number,
  vy: number,
  vw: number,
  vh: number,
  event: asset_detail_event,
): void {
  if (!input.mouse_released || !state.press_in_viewport) return
  state.press_in_viewport = false
  const drag = Math.hypot(input.mouse_x - state.press_x, input.mouse_y - state.press_y)
  if (drag > 4) return
  if (!point_in(input.mouse_x, input.mouse_y, vx, vy, vw, vh)) return
  const ray = viewport_ray(state, input.mouse_x, input.mouse_y, vx, vy, vw, vh)
  const hit = asset_detail_pick(state.parts, ray)
  if (hit === state.selected_part) return
  state.selected_part = hit
  event.selection_changed = { part_index: hit, part_name: hit >= 0 ? state.parts[hit]!.name : null }
}

// --- viewport ---------------------------------------------------------------------

function theme_rgb(theme: theme_definition, name: keyof theme_definition['palette']): asset_detail_vec3 {
  const raw = theme.palette[name].trim().replace('#', '')
  const p = (s: number) => Number.parseInt(raw.slice(s, s + 2), 16) / 255
  if (raw.length >= 6) return [p(0), p(2), p(4)]
  return [0.5, 0.5, 0.5]
}

function draw_viewport(
  ui: ui_renderer,
  theme: theme_definition,
  vx: number,
  vy: number,
  vw: number,
  vh: number,
  state: asset_detail_state,
  scale: number,
  camera_moved: boolean,
  device: GPUDevice,
): void {
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const radius = 6 * scale
  ui.fill_round_rect(vx, vy, vw, vh, radius, slot('panel_alt'))

  const px_w = Math.max(1, Math.floor(vw))
  const px_h = Math.max(1, Math.floor(vh))
  const frame = current_camera_frame(state)
  let texture: GPUTexture | null = null

  if (state.view_mode === 'raytrace') {
    if (!state.tracer) state.tracer = new webtix_tracer()
    state.tracer.init(device)
    if (state.tracer_synced_version !== state.scene_version) {
      state.tracer.set_tlas_scene(build_tlas(state.parts.map((part) => ({
        kind: 'mesh' as const,
        mesh: {
          positions: part.geometry.positions,
          normals: ensure_geometry_normals(part.geometry),
          indices: part.geometry.indices,
        },
      }))))
      state.tracer_synced_version = state.scene_version
      state.tracer_camera_signature = ''
    }
    const signature = frame.eye.map((v) => v.toFixed(4)).join(',') + '|' + frame.target.map((v) => v.toFixed(4)).join(',')
    if (camera_moved || signature !== state.tracer_camera_signature) {
      state.tracer_camera_signature = signature
      state.tracer.reset()
    }
    if (state.tracer.samples < RAYTRACE_SAMPLES) {
      texture = state.tracer.render_sample(px_w, px_h, {
        eye: frame.eye,
        target: frame.target,
        fov: frame.fov,
        bounces: RAYTRACE_BOUNCES,
        material: state.tracer_material,
        env_top: [0.58, 0.7, 0.95],
        env_bottom: [0.84, 0.85, 0.88],
        env_intensity: 1.0,
        render_mode: 'lighting',
      })
      ui.request_render() // keep accumulating until the sample budget is hit
    }
  } else {
    state.view.init(device)
    if (state.raster_synced_version !== state.scene_version) {
      state.view.set_parts(state.parts)
      state.raster_synced_version = state.scene_version
    }
    const bg = theme_rgb(theme, 'panel_alt')
    texture = state.view.render(px_w, px_h, frame, {
      mode: state.view_mode,
      selected: state.selected_part,
      clear: { r: bg[0], g: bg[1], b: bg[2], a: 1 },
      accent: theme_rgb(theme, 'accent'),
    })
  }

  if (texture) {
    if (state.texture_id === null) state.texture_id = ui.register_external_texture(texture)
    else ui.update_external_texture(state.texture_id, texture)
  }
  if (state.texture_id !== null) {
    ui.draw_texture_round_rect(state.texture_id, vx, vy, vw, vh, radius)
  }

  const hint = state.camera_mode === 'orbit'
    ? 'drag orbit · shift / right-drag pan · wheel zoom · click part to inspect'
    : 'drag look · WASD move · Q/E down/up · shift fast · click part to inspect'
  ui.draw_text(vx + 10 * scale, vy + vh - 18 * scale, hint, 9 * scale, slot('text_dim'), FONT_MONO)

  // Selection banner so the current pick reads even without the sidebar.
  if (state.selected_part >= 0) {
    const part = state.parts[state.selected_part]
    if (part) {
      const label = `▸ ${part.name}`
      const lf = 10 * scale
      ui.fill_round_rect(vx + 8 * scale, vy + 8 * scale, ui.text_width(label, lf, FONT_MONO) + 14 * scale, 20 * scale, 4 * scale, slot('panel'))
      ui.draw_text(vx + 15 * scale, vy + 8 * scale + 5 * scale, label, lf, slot('accent'), FONT_MONO)
    }
  }
  ui.stroke_round_rect(vx, vy, vw, vh, radius, 1, slot('border'))
}

// --- sidebar ---------------------------------------------------------------------

function format_int(n: number): string {
  return n.toLocaleString('en-US')
}

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

function draw_sidebar(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  state: asset_detail_state,
  scale: number,
  event: asset_detail_event,
): void {
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const radius = 6 * scale
  ui.fill_round_rect(sx, sy, sw, sh, radius, slot('panel_alt'))
  ui.stroke_round_rect(sx, sy, sw, sh, radius, 1, slot('border'))

  const pad = 12 * scale
  handle_sidebar_scroll(input, sx, sy, sw, sh, state, scale)
  const max_off = Math.max(0, state.sidebar_content_h - sh)
  state.sidebar_scroll.offset_y = Math.max(0, Math.min(max_off, state.sidebar_scroll.offset_y))

  ui.push_clip(sx, sy, sw, sh)
  let cy = sy + pad - state.sidebar_scroll.offset_y
  const cx = sx + pad
  const cw = sw - pad * 2

  const section = (label: string): void => {
    ui.draw_text(cx, cy, label, 10 * scale, slot('text_dim'))
    cy += 17 * scale
  }
  const stat_row = (label: string, value: string): void => {
    ui.draw_text(cx, cy, label, 11 * scale, slot('text'))
    const vw = ui.text_width(value, 10.5 * scale, FONT_MONO)
    ui.draw_text(cx + cw - vw, cy, value, 10.5 * scale, slot('text_dim'), FONT_MONO)
    cy += 17 * scale
  }

  const item = state.item!
  section('SCENE')
  ui.draw_text(cx, cy, item.name, 12.5 * scale, slot('text'))
  cy += 18 * scale
  if (item.author) {
    ui.draw_text(cx, cy, `by ${item.author}`, 10.5 * scale, slot('text_dim'))
    cy += 15 * scale
  }
  ui.draw_text(cx, cy, `${format_bytes(item.raw_bytes)} glb → ${format_bytes(item.draco_bytes)} draco`, 9.5 * scale, slot('text_dim'), FONT_MONO)
  cy += 20 * scale

  section(`PARTS (${state.parts.length})`)
  const row_h = 21 * scale
  const part_row = (index: number, label: string, tris: number | null): void => {
    const selected = state.selected_part === index
    const hover = point_in(input.mouse_x, input.mouse_y, cx - 4 * scale, cy - 2 * scale, cw + 8 * scale, row_h)
    if (selected || hover) {
      ui.fill_round_rect(cx - 4 * scale, cy - 2 * scale, cw + 8 * scale, row_h, 3 * scale, selected ? slot('selected') : slot('hover'))
    }
    if (index >= 0) {
      const c = asset_detail_part_color(index)
      const dot = ((255 << 24) | (Math.round(c[2] * 255) << 16) | (Math.round(c[1] * 255) << 8) | Math.round(c[0] * 255)) >>> 0
      ui.fill_round_rect(cx, cy + 4 * scale, 8 * scale, 8 * scale, 2 * scale, dot)
    }
    const label_x = cx + (index >= 0 ? 14 * scale : 0)
    const count = tris === null ? '' : `${format_int(tris)}▲`
    const count_w = count ? ui.text_width(count, 9.5 * scale, FONT_MONO) : 0
    ui.push_clip(label_x, cy, Math.max(0, cw - (label_x - cx) - count_w - 6 * scale), row_h)
    ui.draw_text(label_x, cy + 2 * scale, label, 11 * scale, selected ? slot('text') : slot('text_dim'))
    ui.pop_clip()
    if (count) ui.draw_text(cx + cw - count_w, cy + 3 * scale, count, 9.5 * scale, slot('text_dim'), FONT_MONO)
    if (hover && input.mouse_pressed && state.selected_part !== index) {
      state.selected_part = index
      event.selection_changed = { part_index: index, part_name: index >= 0 ? state.parts[index]!.name : null }
    }
    cy += row_h
  }
  part_row(-1, 'Whole scene', state.scene_stats?.triangle_count ?? null)
  for (let i = 0; i < state.parts.length; i += 1) part_row(i, state.parts[i]!.name, state.parts[i]!.stats.triangle_count)
  cy += 8 * scale

  const stats = asset_detail_selection_stats(state)
  const focus = state.selected_part >= 0 ? state.parts[state.selected_part]?.name ?? 'part' : 'whole scene'
  section(`STATISTICS — ${focus.toUpperCase()}`)
  if (stats) {
    stat_row('Vertices', format_int(stats.vertex_count))
    stat_row('Indices', format_int(stats.index_count))
    stat_row('Triangles', format_int(stats.triangle_count))
    stat_row('Faces', format_int(stats.face_count))
    stat_row('Edges', format_int(stats.edge_count))
    if (state.selected_part < 0) stat_row('Parts', format_int(state.parts.length))
  } else {
    ui.draw_text(cx, cy, 'No geometry loaded', 11 * scale, slot('text_dim'))
    cy += 17 * scale
  }

  state.sidebar_content_h = cy + state.sidebar_scroll.offset_y - sy + pad
  ui.pop_clip()
  draw_sidebar_scrollbar(ui, theme, sx, sy, sw, sh, state, scale)
}

function handle_sidebar_scroll(
  input: ui_input_snapshot,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  state: asset_detail_state,
  scale: number,
): void {
  if (!point_in(input.mouse_x, input.mouse_y, sx, sy, sw, sh)) return
  const max_off = Math.max(0, state.sidebar_content_h - sh)
  if (input.wheel_y) state.sidebar_scroll.offset_y = Math.max(0, Math.min(max_off, state.sidebar_scroll.offset_y - input.wheel_y * 26 * scale))
  if (input.pan_dy) state.sidebar_scroll.offset_y = Math.max(0, Math.min(max_off, state.sidebar_scroll.offset_y - input.pan_dy))
}

function draw_sidebar_scrollbar(
  ui: ui_renderer,
  theme: theme_definition,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  state: asset_detail_state,
  scale: number,
): void {
  if (state.sidebar_content_h <= sh) return
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const sb_w = 6 * scale
  const max_off = Math.max(1, state.sidebar_content_h - sh)
  const thumb_h = Math.max(20 * scale, sh * (sh / state.sidebar_content_h))
  const thumb_y = sy + (state.sidebar_scroll.offset_y / max_off) * Math.max(1, sh - thumb_h)
  ui.fill_round_rect(sx + sw - sb_w - 2 * scale, thumb_y, sb_w, thumb_h, 3 * scale, slot('border_strong'))
}
