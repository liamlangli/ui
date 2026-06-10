// profiler_view — a Chrome-performance-style CPU profiler panel plugin.
//
// Renders a `ui_profiler` capture (see core `ui_profiler.ts`) as:
//
//   ┌ toolbar ──────────────────────────────────────────────┐  pause / resume,
//   │ ⏸ Pause · Clear · live status            window info  │  clear
//   ├ timeline ─────────────────────────────────────────────┤  the moving
//   │ ▁▂▁▃▂▇▂▁▂▁▂▃▂▁▇▁▂▃▂▁▂▁▃▂▁▂▃▂▁ [ selected ]▂▁▂▃▂▁▂▁▂▃ │  window: one bar
//   ├ flame chart ──────────────────────────────────────────┤  per frame
//   │ 0 ms      4 ms      8 ms      12 ms      16 ms        │  drag-select a
//   │ █windows███████████████████████ █flush██              │  slice above,
//   │   █panel:editor████ █panel:chat█                      │  inspect nested
//   │     █text███                                          │  zones below
//   ├ detail ───────────────────────────────────────────────┤
//   │ panel:editor — 3.42 ms · 21.4% of range · depth 1     │
//   └────────────────────────────────────────────────────────┘
//
// Interactions: drag on the timeline selects a frame range (collection pauses
// automatically so the slice holds still); wheel zooms the flame chart at the
// cursor and drag pans it; hover shows a tooltip, click pins a zone to the
// detail bar; Escape clears selection and pin.
//
// Usage (once per frame, inside begin_frame()/flush()):
//
//   profiler_panel(ui, theme, input, x, y, w, h, profiler, state)

import { theme_color, pack_color } from '../ui_theme'
import type { theme_definition, theme_slot } from '../ui_types'
import { ui_renderer, FONT_MONO } from '../ui_renderer'
import type { ui_input_snapshot } from '../ui_widgets'
import type { ui_profiler, profiler_frame, profiler_span } from '../ui_profiler'

export interface profiler_panel_options {
  /** Frame budget used to color the timeline bars (green ≤ budget ≤ amber ≤ 2× ≤ red). Defaults to 16.7 ms. */
  frame_budget_ms?: number
}

type timeline_drag = { anchor: number }
type flame_pan = { last_x: number; moved: boolean }

export interface profiler_panel_state {
  /** Selected frame-id range (inclusive), or null when following the live frame. */
  sel_lo: number | null
  sel_hi: number | null
  /** Flame chart's visible time range, absolute ms. */
  view_t0: number
  view_t1: number
  /** Zone pinned to the detail bar by clicking it. */
  pinned: profiler_span | null
  /** Internal transient interaction state. */
  _view_sig: string
  _tl_drag: timeline_drag | null
  _pan: flame_pan | null
}

export function create_profiler_panel_state(): profiler_panel_state {
  return {
    sel_lo: null,
    sel_hi: null,
    view_t0: 0,
    view_t1: 0,
    pinned: null,
    _view_sig: '',
    _tl_drag: null,
    _pan: null,
  }
}

const MIN_VIEW_SPAN_MS = 0.01

export function profiler_panel(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  prof: ui_profiler,
  state: profiler_panel_state,
  options?: profiler_panel_options,
): void {
  const scale = window.devicePixelRatio || 1
  const col = (slot: theme_slot) => pack_color(theme_color(theme, slot))
  const budget = options?.frame_budget_ms ?? 16.7
  const pad = 8 * scale
  const font = 10.5 * scale
  const mono = 9.5 * scale

  // --- Layout --------------------------------------------------------------
  const toolbar_h = 30 * scale
  const timeline_h = 52 * scale
  const detail_h = 20 * scale
  const tb = { x: x + pad, y: y + pad * 0.75, w: w - pad * 2, h: toolbar_h }
  const tl = { x: x + pad, y: tb.y + tb.h + pad * 0.5, w: w - pad * 2, h: timeline_h }
  const dt = { x: x + pad, y: y + h - detail_h - pad * 0.5, w: w - pad * 2, h: detail_h }
  const fl = { x: x + pad, y: tl.y + tl.h + pad * 0.75, w: w - pad * 2, h: Math.max(0, dt.y - (tl.y + tl.h + pad * 0.75) - pad * 0.5) }
  const ruler_h = 16 * scale
  const row_h = 17 * scale

  ui.push_clip(x, y, w, h)
  ui.fill_rect(x, y, w, h, col('panel'))

  // --- Keep the selection inside the moving window --------------------------
  const first = prof.frames[0]
  const last = prof.frames[prof.frames.length - 1]
  if (state.sel_lo !== null && state.sel_hi !== null) {
    if (!first || state.sel_hi < first.index) {
      state.sel_lo = state.sel_hi = null // slice scrolled out of the window
    } else {
      state.sel_lo = Math.max(state.sel_lo, first.index)
    }
  }

  const inside = (r: { x: number; y: number; w: number; h: number }) =>
    input.mouse_x >= r.x && input.mouse_x < r.x + r.w && input.mouse_y >= r.y && input.mouse_y < r.y + r.h

  // --- Toolbar ---------------------------------------------------------------
  let bx = tb.x
  const btn = (label: string, active = false): boolean => {
    const bw = ui.text_width(label, font) + 18 * scale
    const r = { x: bx, y: tb.y + (tb.h - 22 * scale) * 0.5, w: bw, h: 22 * scale }
    bx += bw + 6 * scale
    const hover = inside(r)
    ui.fill_round_rect(r.x, r.y, r.w, r.h, 4 * scale, active ? col('active') : hover ? col('hover') : col('panel_alt'))
    ui.stroke_round_rect(r.x, r.y, r.w, r.h, 4 * scale, 1, active ? col('accent') : col('border'))
    ui.draw_text(r.x + 9 * scale, ui.text_v_center_y(r.y, r.h, font), label, font, active ? col('text') : hover ? col('text') : col('text_dim'))
    if (hover) ui.set_cursor('pointer')
    return hover && input.mouse_pressed
  }
  if (btn(prof.paused ? '▶ Resume' : '⏸ Pause', prof.paused)) {
    prof.toggle()
    if (!prof.paused) {
      state.sel_lo = state.sel_hi = null // back to following the live frame
      state.pinned = null
    }
  }
  if (btn('Clear')) {
    prof.clear()
    state.sel_lo = state.sel_hi = null
    state.pinned = null
  }
  // Live indicator + status.
  const dot_x = bx + 6 * scale
  const dot_cy = tb.y + tb.h * 0.5
  ui.fill_circle(dot_x, dot_cy, 3.5 * scale, prof.paused ? col('text_dim') : pack_color('#e0565f'))
  const status = prof.paused ? 'paused' : 'recording'
  ui.draw_text(dot_x + 8 * scale, ui.text_v_center_y(tb.y, tb.h, font), status, font, col('text_dim'))
  // Right side: window occupancy.
  const info = `${prof.frames.length}/${prof.max_frames} frames`
  const info_w = ui.text_width(info, mono, FONT_MONO)
  ui.draw_text(tb.x + tb.w - info_w, ui.text_v_center_y(tb.y, tb.h, mono), info, mono, col('text_dim'), FONT_MONO)

  // --- Timeline: the moving window, one bar per frame -------------------------
  const slot_w = tl.w / prof.max_frames
  const frame_left = (pos: number) => tl.x + tl.w - (prof.frames.length - pos) * slot_w
  const frame_at = (mx: number): number | null => {
    if (!first) return null
    const pos = prof.frames.length - 1 - Math.floor((tl.x + tl.w - mx) / slot_w)
    return first.index + Math.max(0, Math.min(prof.frames.length - 1, pos))
  }

  ui.fill_round_rect(tl.x, tl.y, tl.w, tl.h, 4 * scale, col('track'))
  ui.stroke_round_rect(tl.x, tl.y, tl.w, tl.h, 4 * scale, 1, col('border'))
  // Budget line.
  let bar_max = budget * 2
  for (const f of prof.frames) bar_max = Math.max(bar_max, f.cpu_ms)
  const budget_y = tl.y + tl.h - (budget / bar_max) * (tl.h - 4 * scale)
  ui.stroke_line(tl.x, budget_y, tl.x + tl.w, budget_y, 1, with_alpha(col('text_dim'), 70))

  ui.push_clip(tl.x, tl.y, tl.w, tl.h)
  const ok_col = pack_color('#5fb878')
  const warn_col = pack_color('#d8a24a')
  const bad_col = pack_color('#e06c75')
  for (let p = 0; p < prof.frames.length; p += 1) {
    const f = prof.frames[p]
    const bh = Math.max(1.5 * scale, (f.cpu_ms / bar_max) * (tl.h - 4 * scale))
    const color = f.cpu_ms <= budget ? ok_col : f.cpu_ms <= budget * 2 ? warn_col : bad_col
    ui.fill_rect(frame_left(p), tl.y + tl.h - bh - 1 * scale, Math.max(1, slot_w - Math.min(1, slot_w * 0.2)), bh, color)
  }
  // Selection overlay.
  if (state.sel_lo !== null && state.sel_hi !== null && first) {
    const sx = frame_left(state.sel_lo - first.index)
    const ex = frame_left(state.sel_hi - first.index) + slot_w
    ui.fill_rect(sx, tl.y, ex - sx, tl.h, with_alpha(col('accent'), 50))
    ui.stroke_rect(sx, tl.y, ex - sx, tl.h, 1.5 * scale, col('accent'))
  }
  ui.pop_clip()

  // Timeline interaction: drag to select a slice (collection pauses so it holds still).
  if (inside(tl) && prof.frames.length > 0) ui.set_cursor('crosshair')
  if (input.mouse_pressed && inside(tl)) {
    const idx = frame_at(input.mouse_x)
    if (idx !== null) {
      prof.pause()
      state._tl_drag = { anchor: idx }
      state.sel_lo = state.sel_hi = idx
      state.pinned = null
    }
  }
  if (state._tl_drag) {
    if (input.mouse_down) {
      const idx = frame_at(input.mouse_x)
      if (idx !== null) {
        state.sel_lo = Math.min(state._tl_drag.anchor, idx)
        state.sel_hi = Math.max(state._tl_drag.anchor, idx)
      }
    } else {
      state._tl_drag = null
    }
  }
  if (input.key_escape) {
    state.sel_lo = state.sel_hi = null
    state.pinned = null
  }

  // --- Resolve the inspected range: the selection, or the latest frame --------
  let range_frames: profiler_frame[] = []
  if (state.sel_lo !== null && state.sel_hi !== null) range_frames = prof.frames_in_range(state.sel_lo, state.sel_hi)
  else if (last) range_frames = [last]

  const range_first = range_frames[0]
  const range_last = range_frames[range_frames.length - 1]
  if (range_first && range_last) {
    const t0 = range_first.start_ms
    const t1 = Math.max(range_last.end_ms, t0 + MIN_VIEW_SPAN_MS)
    // Re-fit the view whenever the inspected range changes (new selection, or
    // the live frame advancing); zoom/pan persist while the range holds still.
    const sig = `${range_first.index}:${range_last.index}`
    if (sig !== state._view_sig) {
      state._view_sig = sig
      state.view_t0 = t0
      state.view_t1 = t1
    }
    // Clamp a stale view into the range.
    state.view_t0 = Math.max(t0, Math.min(state.view_t0, t1 - MIN_VIEW_SPAN_MS))
    state.view_t1 = Math.max(state.view_t0 + MIN_VIEW_SPAN_MS, Math.min(state.view_t1, t1))

    draw_flame_chart(ui, theme, input, fl, ruler_h, row_h, scale, t0, t1, range_frames, state, dt, col)
  } else {
    ui.fill_round_rect(fl.x, fl.y, fl.w, fl.h, 4 * scale, col('panel_alt'))
    ui.stroke_round_rect(fl.x, fl.y, fl.w, fl.h, 4 * scale, 1, col('border'))
    const msg = prof.frames.length === 0 ? 'No frames captured — wrap your frame with profiler.begin_frame() / end_frame().' : 'Select a slice on the timeline above.'
    ui.draw_text(fl.x + 10 * scale, fl.y + 10 * scale, msg, font, col('text_dim'))
    draw_detail_text(ui, dt, mono, col('text_dim'), '')
  }

  // While recording, keep the (adaptive) renderer awake so the window streams.
  if (!prof.paused) ui.request_render()
  ui.pop_clip()
}

// --- flame chart -----------------------------------------------------------

function draw_flame_chart(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  fl: { x: number; y: number; w: number; h: number },
  ruler_h: number,
  row_h: number,
  scale: number,
  t0: number,
  t1: number,
  frames: profiler_frame[],
  state: profiler_panel_state,
  dt: { x: number; y: number; w: number; h: number },
  col: (slot: theme_slot) => number,
): void {
  const mono = 9.5 * scale
  const inside_fl = input.mouse_x >= fl.x && input.mouse_x < fl.x + fl.w && input.mouse_y >= fl.y && input.mouse_y < fl.y + fl.h

  // --- Zoom (wheel, anchored at the cursor) and pan (drag) ------------------
  let span = state.view_t1 - state.view_t0
  if (inside_fl && input.wheel_y) {
    const anchor = state.view_t0 + ((input.mouse_x - fl.x) / Math.max(1, fl.w)) * span
    const next = clamp(span * (input.wheel_y > 0 ? 0.8 : 1.25), MIN_VIEW_SPAN_MS, t1 - t0)
    state.view_t0 = clamp(anchor - ((anchor - state.view_t0) / span) * next, t0, t1 - next)
    state.view_t1 = state.view_t0 + next
    span = next
  }
  if (input.mouse_pressed && inside_fl) state._pan = { last_x: input.mouse_x, moved: false }
  if (state._pan) {
    if (input.mouse_down) {
      const dx = input.mouse_x - state._pan.last_x
      if (dx) {
        state._pan.moved = true
        const dt_ms = (-dx / Math.max(1, fl.w)) * span
        state.view_t0 = clamp(state.view_t0 + dt_ms, t0, t1 - span)
        state.view_t1 = state.view_t0 + span
        state._pan.last_x = input.mouse_x
        ui.set_cursor('grabbing')
      }
    }
    // Release handled below — a no-move release is a click (pin / unpin).
  }
  const px_per_ms = fl.w / span
  const time_x = (t: number) => fl.x + (t - state.view_t0) * px_per_ms

  // --- Frame ---------------------------------------------------------------
  ui.fill_round_rect(fl.x, fl.y, fl.w, fl.h, 4 * scale, col('panel_alt'))
  ui.stroke_round_rect(fl.x, fl.y, fl.w, fl.h, 4 * scale, 1, col('border'))
  ui.push_clip(fl.x, fl.y, fl.w, fl.h)

  // --- Time ruler (relative ms) + frame boundaries ---------------------------
  const step = nice_step((span * 70 * scale) / Math.max(1, fl.w))
  const grid = with_alpha(col('border'), 110)
  const start_rel = Math.ceil((state.view_t0 - t0) / step) * step
  for (let rel = start_rel; rel <= state.view_t1 - t0 + 1e-6; rel += step) {
    const gx = time_x(t0 + rel)
    ui.stroke_line(gx, fl.y + ruler_h, gx, fl.y + fl.h, 1, grid)
    ui.draw_text(gx + 3 * scale, fl.y + 3 * scale, format_ms(rel), mono, col('text_dim'), FONT_MONO)
  }
  if (frames.length > 1) {
    const tick = with_alpha(col('accent'), 90)
    for (let i = 1; i < frames.length; i += 1) {
      const gx = time_x(frames[i].start_ms)
      if (gx >= fl.x && gx <= fl.x + fl.w) ui.stroke_line(gx, fl.y, gx, fl.y + fl.h, 1, tick)
    }
  }
  ui.stroke_line(fl.x, fl.y + ruler_h, fl.x + fl.w, fl.y + ruler_h, 1, col('border'))

  // --- Spans ------------------------------------------------------------------
  const rows_y = fl.y + ruler_h + 3 * scale
  let hovered: { frame: profiler_frame; span: profiler_span } | null = null
  for (const frame of frames) {
    for (const span_rec of frame.spans) {
      const sx = time_x(span_rec.start_ms)
      const ex = time_x(span_rec.end_ms)
      if (ex < fl.x || sx > fl.x + fl.w) continue
      const sw = Math.max(ex - sx, 1)
      const sy = rows_y + span_rec.depth * row_h
      if (sy > fl.y + fl.h) continue
      const hover = inside_fl && input.mouse_x >= sx && input.mouse_x < sx + sw && input.mouse_y >= sy && input.mouse_y < sy + row_h - 2 * scale
      if (hover) hovered = { frame, span: span_rec }
      const pinned = state.pinned === span_rec
      ui.fill_round_rect(sx, sy, sw, row_h - 2 * scale, 2 * scale, name_color(span_rec.name, hover || pinned))
      if (pinned) ui.stroke_round_rect(sx, sy, sw, row_h - 2 * scale, 2 * scale, 1.5 * scale, col('accent'))
      if (sw > 26 * scale) {
        const label = `${span_rec.name} ${format_ms(span_rec.end_ms - span_rec.start_ms)}`
        ui.push_clip(Math.max(sx + 4 * scale, fl.x), sy, Math.min(sx + sw, fl.x + fl.w) - Math.max(sx + 4 * scale, fl.x) - 2 * scale, row_h)
        ui.draw_text(Math.max(sx + 4 * scale, fl.x + 2 * scale), ui.text_v_center_y(sy, row_h - 2 * scale, mono), label, mono, pack_color('#0e1116'), FONT_MONO)
        ui.pop_clip()
      }
    }
  }

  // Click (press + release without panning) pins / unpins a zone.
  if (state._pan && !input.mouse_down) {
    if (!state._pan.moved) state.pinned = hovered ? hovered.span : null
    state._pan = null
  }

  // --- Tooltip ------------------------------------------------------------------
  if (hovered) {
    ui.set_cursor('pointer')
    draw_tooltip(ui, fl, scale, mono, col, input.mouse_x, input.mouse_y, hovered.frame, hovered.span, t1 - t0)
  }
  ui.pop_clip()

  // --- Detail bar -----------------------------------------------------------------
  const subject = hovered?.span ?? state.pinned
  let detail: string
  if (subject) {
    const dur = subject.end_ms - subject.start_ms
    const pct = ((dur / (t1 - t0)) * 100).toFixed(1)
    detail = `${subject.name} — ${format_ms(dur)} · ${pct}% of range · starts +${format_ms(subject.start_ms - t0)} · depth ${subject.depth}`
  } else {
    const total = t1 - t0
    const avg = total / frames.length
    detail = frames.length > 1
      ? `${frames.length} frames · ${format_ms(total)} · avg ${format_ms(avg)} (${(1000 / Math.max(avg, 1e-6)).toFixed(1)} FPS)`
      : `frame #${frames[0].index} · ${format_ms(frames[0].cpu_ms)} CPU · ${frames[0].spans.length} zones`
  }
  draw_detail_text(ui, dt, mono, col('text_dim'), detail)
}

function draw_detail_text(ui: ui_renderer, dt: { x: number; y: number; w: number; h: number }, font: number, color: number, text: string): void {
  ui.push_clip(dt.x, dt.y, dt.w, dt.h)
  if (text) ui.draw_text(dt.x + 2, ui.text_v_center_y(dt.y, dt.h, font), text, font, color, FONT_MONO)
  ui.pop_clip()
}

function draw_tooltip(
  ui: ui_renderer,
  fl: { x: number; y: number; w: number; h: number },
  scale: number,
  font: number,
  col: (slot: theme_slot) => number,
  mx: number,
  my: number,
  frame: profiler_frame,
  span: profiler_span,
  range_ms: number,
): void {
  const dur = span.end_ms - span.start_ms
  // Self time = duration minus the immediate children nested inside this span.
  let child_ms = 0
  for (const other of frame.spans) {
    if (other.depth === span.depth + 1 && other.start_ms >= span.start_ms && other.end_ms <= span.end_ms) child_ms += other.end_ms - other.start_ms
  }
  const lines = [
    span.name,
    `total ${format_ms(dur)} · ${((dur / Math.max(range_ms, 1e-6)) * 100).toFixed(1)}% of range`,
    `self  ${format_ms(Math.max(0, dur - child_ms))} · frame #${frame.index}`,
  ]
  const pad = 7 * scale
  const line_h = 13 * scale
  let tw = 0
  for (const line of lines) tw = Math.max(tw, ui.text_width(line, font, FONT_MONO))
  const bw = tw + pad * 2
  const bh = lines.length * line_h + pad * 2 - 3 * scale
  const bx = Math.min(mx + 14 * scale, fl.x + fl.w - bw - 2 * scale)
  const by = Math.min(my + 16 * scale, fl.y + fl.h - bh - 2 * scale)
  ui.fill_round_rect(bx, by, bw, bh, 4 * scale, with_alpha(col('overlay'), 240))
  ui.stroke_round_rect(bx, by, bw, bh, 4 * scale, 1, col('border_strong'))
  for (let i = 0; i < lines.length; i += 1) {
    ui.draw_text(bx + pad, by + pad * 0.75 + i * line_h, lines[i], font, i === 0 ? col('text') : col('text_dim'), FONT_MONO)
  }
}

// --- helpers ----------------------------------------------------------------

function format_ms(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)} s`
  if (ms >= 10) return `${ms.toFixed(1)} ms`
  if (ms >= 1) return `${ms.toFixed(2)} ms`
  return `${(ms * 1000).toFixed(0)} µs`
}

/** Round a raw step up to a 1/2/5 × 10^k "nice" ruler step. */
function nice_step(raw: number): number {
  if (raw <= 0) return 1
  const exp = 10 ** Math.floor(Math.log10(raw))
  const n = raw / exp
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return nice * exp
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/** Stable pastel color per zone name (hashed hue), brighter when highlighted. */
function name_color(name: string, highlight: boolean): number {
  let hash = 0
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0
  return hsv_color(hash % 360, 0.42, highlight ? 0.95 : 0.78)
}

function hsv_color(hue_deg: number, saturation: number, value: number): number {
  const hdeg = ((hue_deg % 360) + 360) % 360
  const c = value * saturation
  const xx = c * (1 - Math.abs(((hdeg / 60) % 2) - 1))
  const m = value - c
  let r = 0
  let g = 0
  let b = 0
  if (hdeg < 60) { r = c; g = xx } else if (hdeg < 120) { r = xx; g = c } else if (hdeg < 180) { g = c; b = xx } else if (hdeg < 240) { g = xx; b = c } else if (hdeg < 300) { r = xx; b = c } else { r = c; b = xx }
  const rr = Math.round((r + m) * 255)
  const gg = Math.round((g + m) * 255)
  const bb = Math.round((b + m) * 255)
  return ((255 << 24) | ((bb & 255) << 16) | ((gg & 255) << 8) | (rr & 255)) >>> 0
}

function with_alpha(packed: number, alpha: number): number {
  return (((alpha & 255) << 24) | (packed & 0x00ffffff)) >>> 0
}
