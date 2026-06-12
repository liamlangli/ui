// pan_zoom — shared pan / pinch-zoom camera handling for 2D canvases.
//
// Several plugins (graph, node_graph, material_audit, …) present a pannable /
// zoomable surface; this core module owns the input math once instead of each
// plugin re-implementing it:
//
//   - wheel zoom, anchored at the cursor
//   - two-finger touch pan + pinch zoom, anchored at the gesture centroid
//     (delivered by `input_collector` as `pan_dx` / `pan_dy` / `zoom_factor`)
//   - pointer-drag panning (a mouse button or a single touch) via
//     {@link pan_zoom_drag}
//
// The camera maps a world point `w` to a physical pixel `p` as
//
//   p = base + pan * pan_scale + w * px_per_unit(zoom)
//
// so callers stay free to keep `pan` in whatever unit they like (the graph
// plugins keep logical px, so `pan_scale = devicePixelRatio`) and to scale
// world units arbitrarily with zoom (graphs use `UNIT * zoom`, the texture
// check viewer uses `zoom` px per texel).

import { clamp } from './ui_math'

/** The pan / zoom camera fields a host state object must expose. */
export interface pan_zoom_camera {
  pan_x: number
  pan_y: number
  zoom: number
}

/** Camera plus the transient pointer-drag tracking used by {@link pan_zoom_drag}. */
export interface pan_zoom_state extends pan_zoom_camera {
  /** Internal pointer-drag tracking. */
  _pz_drag: { last_x: number; last_y: number } | null
}

export function create_pan_zoom_state(zoom = 1): pan_zoom_state {
  return { pan_x: 0, pan_y: 0, zoom, _pz_drag: null }
}

/** The per-frame input fields consumed here — a structural subset of
 * `ui_input_snapshot`, so a snapshot can be passed directly. */
export interface pan_zoom_input {
  mouse_x: number
  mouse_y: number
  wheel_y: number
  /** Two-finger pan delta for the frame, physical px. */
  pan_dx?: number
  pan_dy?: number
  /** Multiplicative pinch factor for the frame (1 = no change), anchored at `mouse_x/y`. */
  zoom_factor?: number
}

export interface pan_zoom_params {
  /** Physical-px position of the world origin when pan is 0. */
  base_x: number
  base_y: number
  /** Pan units → physical px (`devicePixelRatio` when pan is kept in logical px). */
  pan_scale: number
  /** World units → physical px at a given zoom. */
  px_per_unit: (zoom: number) => number
  min_zoom: number
  max_zoom: number
  /** Multiplicative zoom step per wheel notch. Defaults to 1.06. */
  wheel_step?: number
}

/**
 * Apply this frame's wheel zoom (anchored at the cursor) and two-finger
 * pan + pinch zoom (anchored at the gesture centroid) to a camera.
 * Pass `inside = false` to ignore the frame (cursor outside the canvas, a
 * blocking popup open, …). Returns true when the camera changed.
 */
export function pan_zoom_apply(cam: pan_zoom_camera, input: pan_zoom_input, inside: boolean, p: pan_zoom_params): boolean {
  if (!inside) return false
  let changed = false

  // Re-anchored zoom: the world point that sat under (prev_x, prev_y) before
  // the change stays under (anchor_x, anchor_y) after it.
  const zoom_about = (next_zoom: number, anchor_x: number, anchor_y: number, prev_x: number, prev_y: number): void => {
    const cur = p.px_per_unit(cam.zoom)
    const wx = (prev_x - p.base_x - cam.pan_x * p.pan_scale) / cur
    const wy = (prev_y - p.base_y - cam.pan_y * p.pan_scale) / cur
    const next = p.px_per_unit(next_zoom)
    cam.pan_x = (anchor_x - wx * next - p.base_x) / p.pan_scale
    cam.pan_y = (anchor_y - wy * next - p.base_y) / p.pan_scale
    cam.zoom = next_zoom
    changed = true
  }

  if (input.wheel_y) {
    const step = p.wheel_step ?? 1.06
    const next = clamp(cam.zoom * (input.wheel_y > 0 ? step : 1 / step), p.min_zoom, p.max_zoom)
    zoom_about(next, input.mouse_x, input.mouse_y, input.mouse_x, input.mouse_y)
  }

  const pan_dx = input.pan_dx ?? 0
  const pan_dy = input.pan_dy ?? 0
  const pinch = input.zoom_factor ?? 1
  if (pan_dx || pan_dy || pinch !== 1) {
    // The centroid moved by (pan_dx, pan_dy) this frame: keep the world point
    // that was under its previous position under the new one, scaled by pinch.
    const next = clamp(cam.zoom * pinch, p.min_zoom, p.max_zoom)
    zoom_about(next, input.mouse_x, input.mouse_y, input.mouse_x - pan_dx, input.mouse_y - pan_dy)
  }

  return changed
}

/**
 * Pointer-drag panning. The caller decides which pointer drives the drag:
 * `start` begins it (e.g. `inside && input.mouse_pressed`) and `held` keeps it
 * alive (e.g. `input.mouse_down`), so the same call works for a left-drag, a
 * middle-drag or a single-finger touch drag. Returns true while the camera moved.
 */
export function pan_zoom_drag(
  state: pan_zoom_state,
  input: { mouse_x: number; mouse_y: number },
  start: boolean,
  held: boolean,
  pan_scale: number,
): boolean {
  if (start && !state._pz_drag) state._pz_drag = { last_x: input.mouse_x, last_y: input.mouse_y }
  if (!state._pz_drag) return false
  if (!held) {
    state._pz_drag = null
    return false
  }
  const dx = input.mouse_x - state._pz_drag.last_x
  const dy = input.mouse_y - state._pz_drag.last_y
  state._pz_drag.last_x = input.mouse_x
  state._pz_drag.last_y = input.mouse_y
  if (!dx && !dy) return false
  state.pan_x += dx / pan_scale
  state.pan_y += dy / pan_scale
  return true
}
