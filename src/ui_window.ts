// window — pure layout state for the "window mode" workspace.
//
// Where `dock` arranges views in a binary split tree, `window` lets each view
// float in its own free-positioned frame (à la a classic desktop): a title
// bar with minimize / maximize / close affordances, drag-to-move,
// drag-to-resize, z-order focus and minimize-to-taskbar. Like `dock`, this
// module is intentionally pure — it owns the data and the geometry maths but
// draws nothing and listens to no input. The core `window_system` module is
// the glue that renders it and drives it from an input snapshot.

import { clamp } from './ui_math'

/** A single floating view frame. Positions/sizes are logical px, relative to
 * the top-left of the window area handed to {@link window_system.frame}. */
export interface window_view {
  /** View id — matches a `dock_tab.id` so hosts can reuse one render switch. */
  id: string
  title: string
  x: number
  y: number
  w: number
  h: number
  /** Paint order; the largest z is the focused, top-most frame. */
  z: number
  minimized: boolean
  maximized: boolean
  /** Rect to fall back to when un-maximizing / un-minimizing (logical px). */
  restore_x: number
  restore_y: number
  restore_w: number
  restore_h: number
  /** Optional unsaved-changes marker, rendered as a dot like dock tabs. */
  dirty?: boolean
}

export interface window_layout {
  windows: window_view[]
  /** Monotonic z allocator; bumped on every focus. */
  next_z: number
  focused_id: string | null
}

export const window_title_h = 30
export const window_min_w = 160
export const window_min_h = 96
export const window_taskbar_h = 46
/** Grab band (logical px) around a frame edge that begins a resize. */
export const window_resize_band = 6
/** Pixels the cursor must travel before a press promotes to a move/resize. */
export const window_drag_start_d = 3

export interface window_new_options {
  x?: number
  y?: number
  w?: number
  h?: number
  dirty?: boolean
}

let cascade_seed = 0

export function create_window_view(id: string, title: string, z: number, options?: window_new_options): window_view {
  // Cascade fresh windows so a burst of spawns doesn't stack perfectly.
  const offset = (cascade_seed++ % 6) * 26
  const x = options?.x ?? 60 + offset
  const y = options?.y ?? 50 + offset
  const w = options?.w ?? 360
  const h = options?.h ?? 260
  return {
    id,
    title,
    x,
    y,
    w,
    h,
    z,
    minimized: false,
    maximized: false,
    restore_x: x,
    restore_y: y,
    restore_w: w,
    restore_h: h,
    dirty: options?.dirty,
  }
}

export function create_default_window_layout(): window_layout {
  const layout: window_layout = { windows: [], next_z: 1, focused_id: null }
  spawn_window(layout, 'files', 'Explorer', { x: 40, y: 40, w: 240, h: 360 })
  spawn_window(layout, 'editor', 'Editor', { x: 300, y: 60, w: 460, h: 320 })
  spawn_window(layout, 'console', 'Console', { x: 360, y: 300, w: 420, h: 200 })
  return layout
}

export function clone_window_layout(layout: window_layout): window_layout {
  return JSON.parse(JSON.stringify(layout)) as window_layout
}

export function serialize_window_layout(layout: window_layout): string {
  return JSON.stringify(layout)
}

export function restore_window_layout(raw: unknown): window_layout | null {
  if (!raw || typeof raw !== 'object') return null
  const layout = raw as window_layout
  if (!Array.isArray(layout.windows) || typeof layout.next_z !== 'number' || !Number.isFinite(layout.next_z)) return null
  // Validate every window entry — the raw value typically comes from persisted
  // storage, so a stale / corrupt blob must not crash the desktop.
  const num = (v: unknown) => typeof v === 'number' && Number.isFinite(v)
  for (const win of layout.windows) {
    if (!win || typeof win !== 'object') return null
    if (typeof win.id !== 'string' || typeof win.title !== 'string') return null
    if (!num(win.x) || !num(win.y) || !num(win.w) || !num(win.h) || !num(win.z)) return null
    if (!num(win.restore_x) || !num(win.restore_y) || !num(win.restore_w) || !num(win.restore_h)) return null
    if (typeof win.minimized !== 'boolean' || typeof win.maximized !== 'boolean') return null
    win.w = Math.max(window_min_w, win.w)
    win.h = Math.max(window_min_h, win.h)
  }
  if (layout.focused_id !== null && (typeof layout.focused_id !== 'string' || !layout.windows.some((w) => w.id === layout.focused_id))) {
    layout.focused_id = null
  }
  return layout
}

export function find_window(layout: window_layout, id: string): window_view | null {
  return layout.windows.find((w) => w.id === id) ?? null
}

/** Bring a window to the front and mark it focused. */
export function focus_window(layout: window_layout, id: string): void {
  const win = find_window(layout, id)
  if (!win) return
  win.z = layout.next_z++
  layout.focused_id = id
}

/** Spawn a view as a new window, or focus + un-minimize it if it already exists. */
export function spawn_window(layout: window_layout, id: string, title: string, options?: window_new_options): window_view {
  const existing = find_window(layout, id)
  if (existing) {
    existing.minimized = false
    focus_window(layout, id)
    return existing
  }
  const win = create_window_view(id, title, layout.next_z++, options)
  layout.windows.push(win)
  layout.focused_id = id
  return win
}

export function close_window(layout: window_layout, id: string): void {
  const index = layout.windows.findIndex((w) => w.id === id)
  if (index < 0) return
  layout.windows.splice(index, 1)
  if (layout.focused_id === id) {
    // Hand focus to the next-highest remaining (non-minimized) window.
    let best: window_view | null = null
    for (const w of layout.windows) {
      if (w.minimized) continue
      if (!best || w.z > best.z) best = w
    }
    layout.focused_id = best ? best.id : null
  }
}

export function minimize_window(layout: window_layout, id: string): void {
  const win = find_window(layout, id)
  if (!win) return
  win.minimized = true
  if (layout.focused_id === id) {
    let best: window_view | null = null
    for (const w of layout.windows) {
      if (w.minimized) continue
      if (!best || w.z > best.z) best = w
    }
    layout.focused_id = best ? best.id : null
  }
}

export function restore_window(layout: window_layout, id: string): void {
  const win = find_window(layout, id)
  if (!win) return
  win.minimized = false
  focus_window(layout, id)
}

export function toggle_maximize_window(layout: window_layout, id: string): void {
  const win = find_window(layout, id)
  if (!win) return
  if (win.maximized) {
    win.maximized = false
    win.x = win.restore_x
    win.y = win.restore_y
    win.w = win.restore_w
    win.h = win.restore_h
  } else {
    win.restore_x = win.x
    win.restore_y = win.y
    win.restore_w = win.w
    win.restore_h = win.h
    win.maximized = true
  }
  focus_window(layout, id)
}

/** Move a window (logical px), keeping the title bar reachable inside the area. */
export function move_window(win: window_view, x: number, y: number, area_w: number, area_h: number): void {
  if (win.maximized) return
  const max_x = Math.max(0, area_w - 48)
  const max_y = Math.max(0, area_h - window_title_h)
  win.x = clamp(x, 48 - win.w, max_x)
  win.y = clamp(y, 0, max_y)
}

/** Resize a window (logical px), clamped to the configured minimums. */
export function resize_window(win: window_view, w: number, h: number): void {
  if (win.maximized) return
  win.w = Math.max(window_min_w, w)
  win.h = Math.max(window_min_h, h)
}
