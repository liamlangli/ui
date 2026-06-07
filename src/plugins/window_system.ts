// window_system — a ready-to-use "window mode" workspace plugin.
//
// The sibling of `dock_system`: instead of tiling views in a split tree, it
// floats each view in its own desktop-style frame — a header bar carrying the
// title plus minimize / maximize / close buttons, drag-to-move, drag-to-resize
// from any edge or corner, and click-to-focus z-ordering. A rounded taskbar
// pinned to the bottom lists the currently running views and shows a live
// clock; clicking a taskbar chip focuses, restores or minimizes its window.
//
// The render-body callback hands back the same {@link dock_panel} shape the
// dock system uses, so a host can drive both modes from one render switch and
// let the user flip between dock mode and window mode.
//
// Usage (once per frame, inside begin_frame()/flush()):
//
//   windows.frame(ui, theme, input, x, y, w, h, (panel) => {
//     if (panel.tab.id === 'files') file_browser(ui, widgets, ...)
//   })

import { theme_color } from '../theme'
import type { theme_definition } from '../types'
import { ui_renderer } from '../ui_renderer'
import type { ui_input_snapshot } from '../ui_widgets'
import {
  create_default_window_layout,
  focus_window,
  close_window,
  minimize_window,
  restore_window,
  toggle_maximize_window,
  move_window,
  resize_window,
  spawn_window,
  window_title_h,
  window_taskbar_h,
  window_resize_band,
  window_drag_start_d,
  type window_layout,
  type window_view,
  type window_new_options,
} from '../window'
import type { dock_panel, dock_render_body } from './dock_system'

export interface window_system_options {
  /** Logical title / taskbar font size (scaled by devicePixelRatio). Defaults to 12.5. */
  font_px?: number
  /** Show the bottom taskbar with running views + clock. Defaults to true. */
  taskbar?: boolean
}

type resize_edges = { left: boolean; right: boolean; top: boolean; bottom: boolean }

type window_action =
  | { kind: 'none' }
  | { kind: 'move'; id: string; grab_dx: number; grab_dy: number; armed: boolean; start_x: number; start_y: number }
  | { kind: 'resize'; id: string; edges: resize_edges; start_x: number; start_y: number; ox: number; oy: number; ow: number; oh: number }

/** A physical-px rect a window occupies this frame (after maximize resolution). */
interface window_rect {
  win: window_view
  x: number
  y: number
  w: number
  h: number
}

/**
 * Stateful free-floating window workspace. Owns a {@link window_layout} plus
 * the transient move/resize state, so the host only calls {@link frame}.
 */
export class window_system {
  layout: window_layout
  private action: window_action = { kind: 'none' }
  // Window content area origin (physical px), captured each frame so the
  // move/resize maths can map cursor deltas back into area-local logical space.
  private area_x = 0
  private area_y = 0
  private area_w = 0
  private area_h = 0

  constructor(layout?: window_layout) {
    this.layout = layout ?? create_default_window_layout()
  }

  /** Spawn or focus a view as a floating window. */
  add_window(id: string, title: string, options?: window_new_options): window_view {
    return spawn_window(this.layout, id, title, options)
  }

  frame(
    ui: ui_renderer,
    theme: theme_definition,
    input: ui_input_snapshot,
    x: number,
    y: number,
    w: number,
    h: number,
    render_body: dock_render_body,
    options?: window_system_options,
  ): void {
    const scale = window.devicePixelRatio || 1
    const font_px = (options?.font_px ?? 12.5) * scale
    const show_taskbar = options?.taskbar ?? true
    const col = (slot: Parameters<typeof theme_color>[1]) => pack(theme_color(theme, slot))

    const taskbar_h = show_taskbar ? window_taskbar_h * scale : 0
    const title_h = window_title_h * scale
    // Window content area sits above the taskbar.
    this.area_x = x
    this.area_y = y
    this.area_w = Math.max(0, w)
    this.area_h = Math.max(0, h - taskbar_h)

    // Live clock keeps redrawing so the displayed time stays current.
    if (show_taskbar) ui.request_render()

    const rect_of = (win: window_view): window_rect => {
      if (win.maximized) return { win, x: this.area_x, y: this.area_y, w: this.area_w, h: this.area_h }
      return { win, x: this.area_x + win.x * scale, y: this.area_y + win.y * scale, w: win.w * scale, h: win.h * scale }
    }

    // --- Drive any in-flight move / resize ---------------------------------
    this.update_action(input, scale)

    // --- Topmost window under the cursor (input only goes to it) -----------
    const visible = this.layout.windows.filter((win) => !win.minimized)
    let hot: window_view | null = null
    if (this.action.kind === 'none') {
      for (const win of [...visible].sort((a, b) => b.z - a.z)) {
        const r = rect_of(win)
        if (point_in(input, r.x, r.y, r.w, r.h)) {
          hot = win
          break
        }
      }
    }

    // Begin a fresh interaction on press against the hot window.
    if (hot && input.mouse_pressed && this.action.kind === 'none') {
      const r = rect_of(hot)
      focus_window(this.layout, hot.id)
      const btn = title_button_hit(input, r, title_h, scale)
      const edges = resize_hit(input, r, scale, hot.maximized)
      if (btn) {
        if (btn === 'close') close_window(this.layout, hot.id)
        else if (btn === 'min') minimize_window(this.layout, hot.id)
        else toggle_maximize_window(this.layout, hot.id)
      } else if (edges.left || edges.right || edges.top || edges.bottom) {
        this.action = { kind: 'resize', id: hot.id, edges, start_x: input.mouse_x, start_y: input.mouse_y, ox: hot.x, oy: hot.y, ow: hot.w, oh: hot.h }
      } else if (input.mouse_y < r.y + title_h) {
        this.action = { kind: 'move', id: hot.id, grab_dx: input.mouse_x - r.x, grab_dy: input.mouse_y - r.y, armed: true, start_x: input.mouse_x, start_y: input.mouse_y }
      }
    }

    // --- Cursor feedback ---------------------------------------------------
    let cursor: string | null = null
    if (this.action.kind === 'resize') cursor = resize_cursor(this.action.edges)
    else if (this.action.kind === 'move' && !this.action.armed) cursor = 'grabbing'
    else if (hot && this.action.kind === 'none') cursor = resize_cursor(resize_hit(input, rect_of(hot), scale, hot.maximized))

    // --- Draw windows back-to-front ----------------------------------------
    for (const win of [...visible].sort((a, b) => a.z - b.z)) {
      const r = rect_of(win)
      const focused = this.layout.focused_id === win.id
      // Background windows get neutered input so a click doesn't fall through
      // to the panel under the top-most window.
      const interactive = hot === win && this.action.kind === 'none'
      this.draw_window(ui, interactive ? input : block_input(input), r, title_h, font_px, scale, focused, interactive, col, render_body)
    }

    // --- Taskbar ------------------------------------------------------------
    if (show_taskbar) this.draw_taskbar(ui, input, x, this.area_y + this.area_h, w, taskbar_h, font_px, scale, col)

    ui.set_cursor(cursor)
  }

  private update_action(input: ui_input_snapshot, scale: number): void {
    const action = this.action
    if (action.kind === 'none') return
    if (!input.mouse_down) {
      this.action = { kind: 'none' }
      return
    }
    const win = this.layout.windows.find((w) => w.id === action.id)
    if (!win) {
      this.action = { kind: 'none' }
      return
    }
    if (action.kind === 'move') {
      // Promote to a live drag only after a small threshold (avoids jitter).
      if (action.armed) {
        if (Math.hypot(input.mouse_x - action.start_x, input.mouse_y - action.start_y) < window_drag_start_d * scale) return
        action.armed = false
      }
      const new_phys_x = input.mouse_x - action.grab_dx
      const new_phys_y = input.mouse_y - action.grab_dy
      move_window(win, (new_phys_x - this.area_x) / scale, (new_phys_y - this.area_y) / scale, this.area_w / scale, this.area_h / scale)
    } else {
      const dx = (input.mouse_x - action.start_x) / scale
      const dy = (input.mouse_y - action.start_y) / scale
      const e = action.edges
      // Compute the desired size, resize (which applies minimums), then anchor
      // the moving edge so a left/top drag doesn't overshoot past the minimum.
      const want_w = e.left ? action.ow - dx : e.right ? action.ow + dx : action.ow
      const want_h = e.top ? action.oh - dy : e.bottom ? action.oh + dy : action.oh
      resize_window(win, want_w, want_h)
      win.x = e.left ? action.ox + (action.ow - win.w) : action.ox
      win.y = e.top ? action.oy + (action.oh - win.h) : action.oy
    }
  }

  private draw_window(
    ui: ui_renderer,
    input: ui_input_snapshot,
    r: window_rect,
    title_h: number,
    font_px: number,
    scale: number,
    focused: boolean,
    interactive: boolean,
    col: (slot: Parameters<typeof theme_color>[1]) => number,
    render_body: dock_render_body,
  ): void {
    const radius = 6 * scale
    // Soft drop shadow behind the focused window for depth.
    if (focused) {
      const s = 7 * scale
      ui.fill_round_rect(r.x - s, r.y - s + 3 * scale, r.w + s * 2, r.h + s * 2, radius + s, with_alpha(0x000000, 55), s)
    }
    // Frame + header.
    ui.fill_round_rect(r.x, r.y, r.w, r.h, radius, col('panel'))
    ui.fill_round_rect_per_corner(r.x, r.y, r.w, title_h, radius, radius, 0, 0, focused ? col('panel_alt') : col('panel'))
    ui.fill_rect(r.x, r.y + title_h - 1 * scale, r.w, 1 * scale, col('border'))
    ui.stroke_round_rect(r.x, r.y, r.w, r.h, radius, 1 * scale, focused ? col('border_strong') : col('border'))

    // Title text, clipped to leave room for the window buttons.
    const label_color = focused ? col('text') : col('text_dim')
    ui.push_clip(r.x + 12 * scale, r.y, Math.max(0, r.w - 12 * scale - 96 * scale), title_h)
    ui.draw_text(r.x + 12 * scale, ui.text_v_center_y(r.y, title_h, font_px) + 1 * scale, r.win.title, font_px, label_color)
    if (r.win.dirty) ui.fill_circle(r.x + 12 * scale + ui.text_width(r.win.title, font_px) + 7 * scale, r.y + title_h * 0.5, 2.5 * scale, col('accent'))
    ui.pop_clip()

    // Window buttons: minimize, maximize, close (left → right).
    const cy = r.y + title_h * 0.5
    const br = 7 * scale
    const gap = 26 * scale
    const close_cx = r.x + r.w - 20 * scale
    const max_cx = close_cx - gap
    const min_cx = max_cx - gap
    const glyph = focused ? col('text') : col('text_dim')
    const hit = (cx: number) => interactive && Math.abs(input.mouse_x - cx) <= 11 * scale && Math.abs(input.mouse_y - cy) <= 11 * scale

    // minimize
    if (hit(min_cx)) ui.fill_circle(min_cx, cy, br + 1.5 * scale, col('hover'))
    ui.stroke_line(min_cx - 4 * scale, cy + 3 * scale, min_cx + 4 * scale, cy + 3 * scale, 1.4 * scale, glyph)
    // maximize / restore
    if (hit(max_cx)) ui.fill_circle(max_cx, cy, br + 1.5 * scale, col('hover'))
    if (r.win.maximized) {
      const o = 3 * scale
      ui.stroke_rect(max_cx - o + 1.5 * scale, cy - o - 1.5 * scale, o * 2, o * 2, 1.3 * scale, glyph)
      ui.stroke_rect(max_cx - o - 1.5 * scale, cy - o + 1.5 * scale, o * 2, o * 2, 1.3 * scale, glyph)
    } else {
      ui.stroke_rect(max_cx - 3.5 * scale, cy - 3.5 * scale, 7 * scale, 7 * scale, 1.3 * scale, glyph)
    }
    // close
    const close_hot = hit(close_cx)
    if (close_hot) ui.fill_circle(close_cx, cy, br + 1.5 * scale, pack('#e0564b'))
    const x_c = close_hot ? pack('#ffffff') : glyph
    const cr = 3.4 * scale
    ui.stroke_line(close_cx - cr, cy - cr, close_cx + cr, cy + cr, 1.4 * scale, x_c)
    ui.stroke_line(close_cx - cr, cy + cr, close_cx + cr, cy - cr, 1.4 * scale, x_c)

    // Body.
    const body_y = r.y + title_h
    const body_h = r.h - title_h
    if (body_h > 0) {
      ui.push_clip(r.x, body_y, r.w, body_h)
      const panel: dock_panel = { leaf_id: r.win.id, tab: { id: r.win.id, title: r.win.title, dirty: r.win.dirty }, x: r.x, y: body_y, w: r.w, h: body_h }
      render_body(panel)
      ui.pop_clip()
    }
  }

  private draw_taskbar(
    ui: ui_renderer,
    input: ui_input_snapshot,
    x: number,
    y: number,
    w: number,
    h: number,
    font_px: number,
    scale: number,
    col: (slot: Parameters<typeof theme_color>[1]) => number,
  ): void {
    const pad = 6 * scale
    const bar_x = x + pad
    const bar_y = y + pad
    const bar_w = w - pad * 2
    const bar_h = h - pad * 2
    ui.fill_round_rect(bar_x, bar_y, bar_w, bar_h, 10 * scale, with_alpha(col('panel_alt'), 235))
    ui.stroke_round_rect(bar_x, bar_y, bar_w, bar_h, 10 * scale, 1 * scale, col('border'))

    // Live clock on the right: time over date.
    const now = new Date()
    const time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    const date = now.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })
    const date_font = font_px * 0.85
    const time_w = ui.text_width(time, font_px)
    const date_w = ui.text_width(date, date_font)
    const clock_w = Math.max(time_w, date_w)
    const clock_x = bar_x + bar_w - clock_w - 16 * scale
    ui.draw_text(clock_x + (clock_w - time_w) * 0.5, bar_y + bar_h * 0.5 - font_px + 2 * scale, time, font_px, col('text'))
    ui.draw_text(clock_x + (clock_w - date_w) * 0.5, bar_y + bar_h * 0.5 + 3 * scale, date, date_font, col('text_dim'))
    ui.stroke_line(clock_x - 12 * scale, bar_y + 8 * scale, clock_x - 12 * scale, bar_y + bar_h - 8 * scale, 1 * scale, col('border'))

    // Running-view chips on the left.
    let cx = bar_x + 8 * scale
    const chip_h = bar_h - 12 * scale
    const chip_y = bar_y + 6 * scale
    const limit = clock_x - 16 * scale
    for (const win of this.layout.windows) {
      const label_w = ui.text_width(win.title, font_px)
      const chip_w = Math.min(180 * scale, label_w + 24 * scale)
      if (cx + chip_w > limit) break
      const focused = this.layout.focused_id === win.id && !win.minimized
      const hover = point_in(input, cx, chip_y, chip_w, chip_h)
      const bg = focused ? col('selected') : hover ? col('hover') : win.minimized ? col('panel') : col('bg')
      ui.fill_round_rect(cx, chip_y, chip_w, chip_h, 7 * scale, bg)
      if (focused) ui.fill_round_rect(cx + 6 * scale, chip_y + chip_h - 3 * scale, chip_w - 12 * scale, 2 * scale, 1 * scale, col('accent'))
      ui.push_clip(cx + 8 * scale, chip_y, chip_w - 12 * scale, chip_h)
      ui.draw_text(cx + 9 * scale, ui.text_v_center_y(chip_y, chip_h, font_px) + 1 * scale, win.title, font_px, win.minimized ? col('text_dim') : col('text'))
      ui.pop_clip()
      if (hover && input.mouse_pressed) {
        if (win.minimized) restore_window(this.layout, win.id)
        else if (focused) minimize_window(this.layout, win.id)
        else focus_window(this.layout, win.id)
      }
      cx += chip_w + 6 * scale
    }
  }
}

function resize_hit(input: ui_input_snapshot, r: window_rect, scale: number, maximized: boolean): resize_edges {
  const none = { left: false, right: false, top: false, bottom: false }
  if (maximized) return none
  const band = window_resize_band * scale
  const inside = input.mouse_x >= r.x - band && input.mouse_x <= r.x + r.w + band && input.mouse_y >= r.y - band && input.mouse_y <= r.y + r.h + band
  if (!inside) return none
  return {
    left: Math.abs(input.mouse_x - r.x) <= band,
    right: Math.abs(input.mouse_x - (r.x + r.w)) <= band,
    top: Math.abs(input.mouse_y - r.y) <= band,
    bottom: Math.abs(input.mouse_y - (r.y + r.h)) <= band,
  }
}

function resize_cursor(edges: resize_edges): string | null {
  if ((edges.left && edges.top) || (edges.right && edges.bottom)) return 'nwse-resize'
  if ((edges.right && edges.top) || (edges.left && edges.bottom)) return 'nesw-resize'
  if (edges.left || edges.right) return 'ew-resize'
  if (edges.top || edges.bottom) return 'ns-resize'
  return null
}

type btn_kind = 'min' | 'max' | 'close'
function title_button_hit(input: ui_input_snapshot, r: window_rect, title_h: number, scale: number): btn_kind | null {
  const cy = r.y + title_h * 0.5
  if (input.mouse_y < r.y || input.mouse_y > r.y + title_h) return null
  const close_cx = r.x + r.w - 20 * scale
  const gap = 26 * scale
  const within = (cx: number) => Math.abs(input.mouse_x - cx) <= 11 * scale && Math.abs(input.mouse_y - cy) <= 11 * scale
  if (within(close_cx)) return 'close'
  if (within(close_cx - gap)) return 'max'
  if (within(close_cx - gap * 2)) return 'min'
  return null
}

function block_input(input: ui_input_snapshot): ui_input_snapshot {
  return { ...input, mouse_down: false, mouse_pressed: false, mouse_released: false, mouse_right_pressed: false, wheel_y: 0 }
}

function point_in(input: ui_input_snapshot, x: number, y: number, w: number, h: number): boolean {
  return input.mouse_x >= x && input.mouse_y >= y && input.mouse_x < x + w && input.mouse_y < y + h
}

function pack(hex: string): number {
  const raw = hex.trim().replace('#', '')
  const p = (s: number) => Number.parseInt(raw.slice(s, s + 2), 16)
  if (raw.length === 6) return (((255 << 24) | (p(4) << 16) | (p(2) << 8) | p(0)) >>> 0)
  if (raw.length === 8) return (((p(6) << 24) | (p(4) << 16) | (p(2) << 8) | p(0)) >>> 0)
  return 0xffffffff
}

function with_alpha(packed: number, alpha: number): number {
  return (((alpha & 255) << 24) | (packed & 0x00ffffff)) >>> 0
}
