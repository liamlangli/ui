// webtix — immediate-mode path-tracer panel.
//
// The WebGL2 `webtix` engine, migrated into the toolkit as a self-contained
// plugin and reimplemented on WebGPU (see `ui_webtix_tracer.ts`) with a packed
// storage-buffer BVH instead of the original RGB-texture buffer
// (`ui_webtix_bvh.ts`). It owns an orbit viewport, a Disney-material sidebar and
// progressive accumulation: the tracer is a wavefront integrator that traces
// each pixel's ray a bounded number of times per frame and spills deeper bounces
// into later frames, so the converging image (composited with `draw_texture`)
// refines smoothly. The panel asks the adaptive renderer to keep ticking until
// the average sample budget is reached — then it idles.

import { pack_color } from '../ui_theme'
import type { theme_definition } from '../ui_types'
import { FONT_MONO, type ui_renderer } from '../ui_renderer'
import type { ui_input_snapshot, ui_widgets } from '../ui_widgets'
import {
  create_orbit_camera,
  frame_orbit_camera,
  orbit_camera_eye,
  orbit_camera_step_damping,
  orbit_camera_zoom,
  type orbit_camera,
} from './ui_asset_audit_view'
import { build_bvh, build_scene, WEBTIX_SCENES, type webtix_scene_id } from './ui_webtix_bvh'
import { default_material, webtix_tracer, type webtix_material } from './ui_webtix_tracer'

export interface webtix_state {
  tracer: webtix_tracer
  camera: orbit_camera
  scene: webtix_scene_id
  synced_scene: webtix_scene_id | null
  material: webtix_material
  bounces: number
  sample_count: number
  /** Bounds radius of the current scene (for zoom limits / camera framing). */
  bounds_radius: number
  texture_id: number | null
  // viewport interaction
  orbiting: boolean
  panning: boolean
  last_mx: number
  last_my: number
  /** Forces a fresh build/upload + accumulation restart on the next frame. */
  dirty: boolean
}

export function create_webtix_state(scene: webtix_scene_id = 'sphere'): webtix_state {
  return {
    tracer: new webtix_tracer(),
    camera: create_orbit_camera(),
    scene,
    synced_scene: null,
    material: default_material(),
    bounces: 5,
    sample_count: 256,
    bounds_radius: 2,
    texture_id: null,
    orbiting: false,
    panning: false,
    last_mx: 0,
    last_my: 0,
    dirty: true,
  }
}

export interface webtix_options {
  scale?: number
}

export interface webtix_event {
  scene_changed?: webtix_scene_id
}

function point_in(px: number, py: number, x: number, y: number, w: number, h: number): boolean {
  return px >= x && py >= y && px <= x + w && py <= y + h
}

export function webtix(
  ui: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  state: webtix_state,
  options?: webtix_options,
): webtix_event {
  const scale = options?.scale ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const event: webtix_event = {}
  const m = 8 * scale

  ui.fill_rect(x, y, w, h, slot('panel'))

  // --- toolbar ---------------------------------------------------------------
  const bar_h = 30 * scale
  const ctl_h = 26 * scale
  const bar_y = y + m
  let bx = x + m
  ui.draw_text(bx, bar_y + (bar_h - 12 * scale) / 2, 'Scene', 11 * scale, slot('text_dim'))
  bx += 44 * scale
  const scene_index = WEBTIX_SCENES.findIndex((s) => s.id === state.scene)
  const next_scene = widgets.dropdown('webtix_scene', bx, bar_y + (bar_h - ctl_h) / 2, 120 * scale, ctl_h, WEBTIX_SCENES.map((s) => s.label), scene_index < 0 ? 0 : scene_index)
  if (next_scene !== scene_index) {
    state.scene = WEBTIX_SCENES[next_scene]!.id
    state.dirty = true
    event.scene_changed = state.scene
  }
  bx += 120 * scale + 8 * scale

  if (widgets.button('webtix_reset', bx, bar_y + (bar_h - ctl_h) / 2, 84 * scale, ctl_h, 'Reset View')) {
    frame_camera(state)
    state.tracer.reset()
  }

  // sample progress on the right
  const done = state.tracer.samples
  const progress = `${Math.min(done, state.sample_count)} / ${state.sample_count} spp`
  const pf = 10 * scale
  ui.draw_text(x + w - m - ui.text_width(progress, pf, FONT_MONO), bar_y + (bar_h - pf) / 2, progress, pf, done >= state.sample_count ? slot('text_dim') : slot('accent'), FONT_MONO)

  // --- layout: viewport + sidebar --------------------------------------------
  const body_y = bar_y + bar_h + m
  const body_h = Math.max(40 * scale, y + h - m - body_y)
  const sidebar_w = w >= 520 * scale ? Math.min(240 * scale, Math.floor(w * 0.34)) : 0
  const vp_x = x + m
  const vp_y = body_y
  const vp_w = Math.max(40 * scale, w - m * 2 - (sidebar_w > 0 ? sidebar_w + m : 0))
  const vp_h = body_h

  const camera_moved = handle_camera(state, input, vp_x, vp_y, vp_w, vp_h)

  // (Re)build scene + upload BVH when the selection changes.
  const { device } = ui.gpu()
  if (device) {
    state.tracer.init(device)
    if (state.synced_scene !== state.scene || state.dirty) {
      const mesh = build_scene(state.scene)
      const bvh = build_bvh(mesh.positions, mesh.indices)
      state.tracer.set_scene(bvh, mesh.positions, mesh.normals)
      const r = bvh.bounds_max
      const l = bvh.bounds_min
      state.bounds_radius = Math.max(1e-3, Math.hypot(r[0] - l[0], r[1] - l[1], r[2] - l[2]) / 2)
      frame_camera(state)
      state.synced_scene = state.scene
      state.dirty = false
    }
    if (camera_moved) state.tracer.reset()

    draw_viewport(ui, theme, input, vp_x, vp_y, vp_w, vp_h, state, scale)
  } else {
    ui.fill_round_rect(vp_x, vp_y, vp_w, vp_h, 6 * scale, slot('panel_alt'))
    ui.draw_text(vp_x + 12 * scale, vp_y + 12 * scale, 'WebGPU device not ready…', 11 * scale, slot('text_dim'))
  }

  if (sidebar_w > 0) draw_sidebar(ui, widgets, theme, input, x + m + vp_w + m, body_y, sidebar_w, body_h, state, scale)

  return event
}

function frame_camera(state: webtix_state): void {
  frame_orbit_camera(state.camera, { min: [-state.bounds_radius, -state.bounds_radius, -state.bounds_radius], max: [state.bounds_radius, state.bounds_radius, state.bounds_radius] })
}

function handle_camera(state: webtix_state, input: ui_input_snapshot, vx: number, vy: number, vw: number, vh: number): boolean {
  const cam = state.camera
  const inside = point_in(input.mouse_x, input.mouse_y, vx, vy, vw, vh)
  let moved = false

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
      moved = true
    }
  } else {
    state.orbiting = false
    state.panning = false
  }
  if (inside && input.wheel_y !== 0) {
    orbit_camera_zoom(cam, Math.exp(-input.wheel_y * 0.16), state.bounds_radius)
    moved = true
  }
  if (inside && input.zoom_factor && input.zoom_factor !== 1) {
    orbit_camera_zoom(cam, 1 / input.zoom_factor, state.bounds_radius)
    moved = true
  }
  if (orbit_camera_step_damping(cam)) moved = true
  return moved
}

function draw_viewport(
  ui: ui_renderer,
  theme: theme_definition,
  _input: ui_input_snapshot,
  vx: number,
  vy: number,
  vw: number,
  vh: number,
  state: webtix_state,
  scale: number,
): void {
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const radius = 6 * scale
  ui.fill_round_rect(vx, vy, vw, vh, radius, slot('panel_alt'))

  const px_w = Math.max(1, Math.floor(vw))
  const px_h = Math.max(1, Math.floor(vh))
  const eye = orbit_camera_eye(state.camera)
  const converged = state.tracer.samples >= state.sample_count
  if (!converged) {
    const texture = state.tracer.render_sample(px_w, px_h, {
      eye,
      target: state.camera.target,
      fov: state.camera.fov,
      bounces: state.bounces,
      material: state.material,
      env_top: [0.55, 0.7, 1.0],
      env_bottom: [0.85, 0.86, 0.9],
      env_intensity: 1.0,
    })
    if (texture) {
      if (state.texture_id === null) state.texture_id = ui.register_external_texture(texture)
      else ui.update_external_texture(state.texture_id, texture)
    }
    // Keep the adaptive renderer awake until the image converges.
    ui.request_render()
  }

  if (state.texture_id !== null) {
    ui.push_clip(vx, vy, vw, vh)
    ui.draw_texture(state.texture_id, vx, vy, vw, vh)
    ui.pop_clip()
  }

  const hint = 'drag orbit · shift / right-drag pan · wheel zoom'
  ui.draw_text(vx + 10 * scale, vy + vh - 18 * scale, hint, 9 * scale, slot('text_dim'), FONT_MONO)
  ui.stroke_round_rect(vx, vy, vw, vh, radius, 1, slot('border'))
}

function draw_sidebar(
  ui: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  _input: ui_input_snapshot,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  state: webtix_state,
  scale: number,
): void {
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  ui.fill_round_rect(sx, sy, sw, sh, 6 * scale, slot('panel_alt'))
  const pad = 12 * scale
  let cy = sy + pad
  const cx = sx + pad
  const cw = sw - pad * 2

  const section = (label: string): void => {
    ui.draw_text(cx, cy, label, 10 * scale, slot('text_dim'))
    cy += 18 * scale
  }
  // A labelled slider that restarts accumulation when its value changes.
  const slider = (id: string, label: string, value: number, min: number, max: number, on: (v: number) => void): void => {
    ui.draw_text(cx, cy, label, 11 * scale, slot('text'))
    ui.draw_text(cx + cw - ui.text_width(value.toFixed(2), 10 * scale, FONT_MONO), cy, value.toFixed(2), 10 * scale, slot('text_dim'), FONT_MONO)
    cy += 16 * scale
    const next = widgets.slider(id, cx, cy, cw, 16 * scale, value, min, max)
    if (next !== value) { on(next); state.tracer.reset() }
    cy += 24 * scale
  }

  const mat = state.material
  section('RENDER')
  slider('webtix_bounces', 'Bounces', state.bounces, 1, 16, (v) => { state.bounces = Math.round(v) })
  slider('webtix_spp', 'Samples', state.sample_count, 16, 1024, (v) => { state.sample_count = Math.round(v) })

  cy += 6 * scale
  section('MATERIAL')
  slider('webtix_metallic', 'Metallic', mat.metallic, 0, 1, (v) => { mat.metallic = v })
  slider('webtix_roughness', 'Roughness', mat.roughness, 0, 1, (v) => { mat.roughness = v })
  slider('webtix_specular', 'Specular', mat.specular, 0, 1, (v) => { mat.specular = v })
  slider('webtix_transmission', 'Transmission', mat.transmission, 0, 1, (v) => { mat.transmission = v })
  slider('webtix_subsurface', 'Subsurface', mat.subsurface, 0, 1, (v) => { mat.subsurface = v })
  slider('webtix_clearcoat', 'Clearcoat', mat.clearcoat, 0, 1, (v) => { mat.clearcoat = v })
  slider('webtix_ior', 'IOR', mat.eta, 1, 2.5, (v) => { mat.eta = v })

  cy += 6 * scale
  section('BASE COLOR')
  slider('webtix_col_r', 'Red', mat.color[0], 0, 1, (v) => { mat.color[0] = v })
  slider('webtix_col_g', 'Green', mat.color[1], 0, 1, (v) => { mat.color[1] = v })
  slider('webtix_col_b', 'Blue', mat.color[2], 0, 1, (v) => { mat.color[2] = v })
}
