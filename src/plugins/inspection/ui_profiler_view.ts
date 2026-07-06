// profiler_view — a Chrome-performance-style profiler panel plugin.
//
// Two tabs share one panel. The CPU tab renders a `ui_profiler` capture (see
// core `ui_profiler.ts`) as:
//
//   ┌ toolbar ──────────────────────────────────────────────┐  pause / resume,
//   │ ⏸ Pause · Clear · live status            window info  │  clear
//   ├ frame chart ──────────────────────────────────────────┤  polylines: frame
//   │ ─ interval · ─ cpu      ╱╲__╱╲___ ← interval          │  interval vs CPU
//   │ _________________________________ ← cpu               │  time; the gap is
//   ├ timeline ─────────────────────────────────────────────┤  GPU/vsync wait
//   │ ▁▂▁▃▂▇▂▁▂▁▂▃▂▁▇▁▂▃▂▁▂▁▃▂▁▂▃▂▁ [ selected ]▂▁▂▃▂▁▂▁▂▃ │  the moving window:
//   ├ flame chart ──────────────────────────────────────────┤  one bar per frame
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
// The Memory tab renders a `ui_memory` registry (see core `ui_memory.ts`) —
// every tracked CPU/GPU resource — as:
//
//   ┌ toolbar ──────────────────────────────────────────────┐  search box
//   │ [CPU][Memory] 🔍 filter…       18 resources · 24.3 MB │  filters by name
//   ├ treemap ──────────────────────────────────────────────┤  area ∝ bytes,
//   │ ┌texture───────────────┐┌font────────┐┌geometry┐      │  grouped by
//   │ │ ███████  ████  ██    ││ ████  ██   ││ ██  █  │      │  resource type;
//   │ └──────────────────────┘└────────────┘└────────┘      │  click selects
//   ├ table ────────────────────────────────────────────────┤
//   │ Name              Type        Dev       Size ▼        │  sortable columns,
//   │ ▾ texture — 6 · 12.4 MB                                │  type groups
//   │   ui.icon_atlas   texture     gpu       1.0 MB        │  collapse
//   └────────────────────────────────────────────────────────┘
//
// Usage (once per frame, inside begin_frame()/flush()):
//
//   profiler_panel(ui, theme, input, x, y, w, h, profiler, state)

import { theme_color, pack_color } from '../../core/ui_theme'
import type { theme_definition, theme_slot } from '../../core/ui_types'
import { ui_renderer, FONT_MONO } from '../../core/ui_renderer'
import { draw_icon } from '../../core/ui_icon'
import type { ui_input_snapshot } from '../../core/ui_widgets'
import type { ui_profiler, profiler_frame, profiler_span } from '../../core/ui_profiler'
import { memory as shared_memory, format_bytes } from '../../core/ui_memory'
import type { ui_memory, memory_resource } from '../../core/ui_memory'

export interface profiler_panel_options {
  /** Frame budget used to color the timeline bars (green ≤ budget ≤ amber ≤ 2× ≤ red). Defaults to 16.7 ms. */
  frame_budget_ms?: number
  /** Resource registry shown by the Memory tab. Defaults to the shared `memory` instance. */
  memory?: ui_memory
}

type timeline_drag = { anchor: number }
type flame_pan = { last_x: number; moved: boolean }

export type memory_sort_key = 'name' | 'kind' | 'size'

export interface profiler_panel_state {
  /** Active inspector tab. */
  tab: 'cpu' | 'memory'
  /** Selected frame-id range (inclusive), or null when following the live frame. */
  sel_lo: number | null
  sel_hi: number | null
  /** Flame chart's visible time range, absolute ms. */
  view_t0: number
  view_t1: number
  /** Zone pinned to the detail bar by clicking it. */
  pinned: profiler_span | null
  /** Memory tab: name filter typed into the search box. */
  mem_search: string
  mem_search_focused: boolean
  /** Memory tab: table sort column and direction. */
  mem_sort_key: memory_sort_key
  mem_sort_asc: boolean
  mem_scroll_y: number
  /** Memory tab: name of the resource selected in the treemap / table. */
  mem_selected: string | null
  /** Memory tab: resource types whose table group is collapsed. */
  mem_collapsed: string[]
  /** Internal transient interaction state. */
  _view_sig: string
  _tl_drag: timeline_drag | null
  _pan: flame_pan | null
  _mem_scroll_to: string | null
  _mem_generation: number
}

export function create_profiler_panel_state(): profiler_panel_state {
  return {
    tab: 'cpu',
    sel_lo: null,
    sel_hi: null,
    view_t0: 0,
    view_t1: 0,
    pinned: null,
    mem_search: '',
    mem_search_focused: false,
    mem_sort_key: 'kind',
    mem_sort_asc: false,
    mem_scroll_y: 0,
    mem_selected: null,
    mem_collapsed: [],
    _view_sig: '',
    _tl_drag: null,
    _pan: null,
    _mem_scroll_to: null,
    _mem_generation: -1,
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
  const chart_h = 54 * scale
  const timeline_h = 52 * scale
  const detail_h = 20 * scale
  const tb = { x: x + pad, y: y + pad * 0.75, w: w - pad * 2, h: toolbar_h }
  const ch = { x: x + pad, y: tb.y + tb.h + pad * 0.5, w: w - pad * 2, h: chart_h }
  const tl = { x: x + pad, y: ch.y + ch.h + pad * 0.5, w: w - pad * 2, h: timeline_h }
  const dt = { x: x + pad, y: y + h - detail_h - pad * 0.5, w: w - pad * 2, h: detail_h }
  const fl = { x: x + pad, y: tl.y + tl.h + pad * 0.75, w: w - pad * 2, h: Math.max(0, dt.y - (tl.y + tl.h + pad * 0.75) - pad * 0.5) }
  const ruler_h = 16 * scale
  const row_h = 17 * scale

  ui.push_clip(x, y, w, h)
  ui.fill_rect(x, y, w, h, col('panel'))

  const inside = (r: { x: number; y: number; w: number; h: number }) =>
    input.mouse_x >= r.x && input.mouse_x < r.x + r.w && input.mouse_y >= r.y && input.mouse_y < r.y + r.h

  // --- Toolbar: inspector tabs, then the active tab's own controls ------------
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
  if (btn('CPU', state.tab === 'cpu')) state.tab = 'cpu'
  if (btn('Memory', state.tab === 'memory')) state.tab = 'memory'
  ui.stroke_line(bx, tb.y + tb.h * 0.5 - 8 * scale, bx, tb.y + tb.h * 0.5 + 8 * scale, 1, col('border'))
  bx += 8 * scale

  if (state.tab === 'memory') {
    draw_memory_tab(ui, input, { x, y, w, h }, tb, bx, options?.memory ?? shared_memory, state, scale, col, inside)
    ui.pop_clip()
    return
  }

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

  // --- Frame chart: interval vs CPU polylines over the moving window ----------
  draw_frame_chart(ui, input, ch, scale, budget, prof, col)

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

// --- frame chart -------------------------------------------------------------
//
// Two polylines over the same moving window as the bar timeline below (columns
// align): the frame interval (start-to-start delta between recorded frames —
// what the user actually sees as frame rate) and the CPU time spent inside the
// frame callback. JS that finishes in 4 ms but presents at 30 FPS shows up here
// as a wide gap between the two lines: time spent in GPU work, compositing or
// waiting for vsync, which begin/end instrumentation cannot see.

function draw_frame_chart(
  ui: ui_renderer,
  input: ui_input_snapshot,
  ch: { x: number; y: number; w: number; h: number },
  scale: number,
  budget: number,
  prof: ui_profiler,
  col: (slot: theme_slot) => number,
): void {
  const mono = 9.5 * scale
  const frames = prof.frames
  const interval_col = pack_color('#4c8bf5')
  const cpu_col = pack_color('#5fb878')

  ui.fill_round_rect(ch.x, ch.y, ch.w, ch.h, 4 * scale, col('track'))
  ui.stroke_round_rect(ch.x, ch.y, ch.w, ch.h, 4 * scale, 1, col('border'))
  ui.push_clip(ch.x, ch.y, ch.w, ch.h)

  // Vertical scale: at least 2.5× budget so 30 FPS-on-60 Hz sits mid-chart, but
  // capped so one multi-hundred-ms hitch doesn't flatten everything for the
  // 10 s it takes to scroll out of the window. Values are clamped to the cap.
  const interval_at = (p: number) => (p > 0 ? frames[p].start_ms - frames[p - 1].start_ms : 0)
  let y_max = budget * 2.5
  for (let p = 0; p < frames.length; p += 1) y_max = Math.max(y_max, frames[p].cpu_ms, interval_at(p))
  y_max = Math.min(y_max, budget * 6)

  const legend_h = 15 * scale
  const top = ch.y + legend_h + 2 * scale
  const bottom = ch.y + ch.h - 4 * scale
  const value_y = (v: number) => bottom - (Math.min(v, y_max) / y_max) * (bottom - top)

  // Same right-aligned slot mapping as the timeline bars below, so the chart's
  // columns line up with them.
  const slot_w = ch.w / prof.max_frames
  const slot_x = (p: number) => ch.x + ch.w - (frames.length - p) * slot_w + slot_w * 0.5

  // Reference lines at the budget (16.7 ms ≈ 60 FPS) and twice it (30 FPS).
  for (const ref of [budget, budget * 2]) {
    if (ref >= y_max) continue
    const ry = value_y(ref)
    ui.stroke_line(ch.x, ry, ch.x + ch.w, ry, 1, with_alpha(col('text_dim'), 60))
    const label = `${format_ms(ref)} · ${Math.round(1000 / ref)} FPS`
    const lw = ui.text_width(label, mono, FONT_MONO)
    ui.draw_text(ch.x + ch.w - lw - 4 * scale, ry - 11 * scale, label, mono, with_alpha(col('text_dim'), 150), FONT_MONO)
  }

  if (frames.length >= 2) {
    const pts = new Float32Array(frames.length * 2)
    let n = 0
    for (let p = 1; p < frames.length; p += 1) {
      pts[n * 2] = slot_x(p)
      pts[n * 2 + 1] = value_y(interval_at(p))
      n += 1
    }
    ui.stroke_polyline(pts, n, 1.5 * scale, interval_col, 0.75)
    n = 0
    for (let p = 0; p < frames.length; p += 1) {
      pts[n * 2] = slot_x(p)
      pts[n * 2 + 1] = value_y(frames[p].cpu_ms)
      n += 1
    }
    ui.stroke_polyline(pts, n, 1.5 * scale, cpu_col, 0.75)
  }

  // Hover probes a frame (vertical guide); otherwise the legend tracks the
  // latest one.
  const inside_ch = input.mouse_x >= ch.x && input.mouse_x < ch.x + ch.w && input.mouse_y >= ch.y && input.mouse_y < ch.y + ch.h
  let probe = frames.length - 1
  if (inside_ch && frames.length > 0) {
    const pos = frames.length - 1 - Math.floor((ch.x + ch.w - input.mouse_x) / slot_w)
    probe = Math.max(0, Math.min(frames.length - 1, pos))
    ui.stroke_line(slot_x(probe), top, slot_x(probe), bottom, 1, with_alpha(col('text'), 80))
  }

  // Legend: colored swatches + the probed frame's numbers. `gap` is the part
  // of the interval the CPU instrumentation can't see (GPU / compositor / vsync).
  let lx = ch.x + 6 * scale
  const ly = ch.y + 4 * scale
  const swatch = (color: number, label: string) => {
    ui.fill_rect(lx, ly + 4 * scale, 9 * scale, 2.5 * scale, color)
    lx += 12 * scale
    ui.draw_text(lx, ly, label, mono, col('text_dim'), FONT_MONO)
    lx += ui.text_width(label, mono, FONT_MONO) + 12 * scale
  }
  const f = frames[probe]
  if (f) {
    const interval = interval_at(probe)
    const fps = interval > 0 ? ` · ${(1000 / interval).toFixed(1)} FPS` : ''
    swatch(interval_col, `interval ${probe > 0 ? format_ms(interval) : '—'}${fps}`)
    swatch(cpu_col, `cpu ${format_ms(f.cpu_ms)}`)
    if (probe > 0) ui.draw_text(lx, ly, `gap ${format_ms(Math.max(0, interval - f.cpu_ms))}`, mono, with_alpha(col('text_dim'), 170), FONT_MONO)
  } else {
    swatch(interval_col, 'interval')
    swatch(cpu_col, 'cpu')
  }

  ui.pop_clip()
}

// --- flame chart -----------------------------------------------------------

function draw_flame_chart(
  ui: ui_renderer,
  _theme: theme_definition,
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
  draw_tooltip_box(ui, fl, scale, font, col, mx, my, lines)
}

/** A multi-line overlay tooltip near the cursor, clamped inside `bounds`. First line is the title. */
function draw_tooltip_box(
  ui: ui_renderer,
  bounds: { x: number; y: number; w: number; h: number },
  scale: number,
  font: number,
  col: (slot: theme_slot) => number,
  mx: number,
  my: number,
  lines: string[],
): void {
  const pad = 7 * scale
  const line_h = 13 * scale
  let tw = 0
  for (const line of lines) tw = Math.max(tw, ui.text_width(line, font, FONT_MONO))
  const bw = tw + pad * 2
  const bh = lines.length * line_h + pad * 2 - 3 * scale
  const bx = Math.min(mx + 14 * scale, bounds.x + bounds.w - bw - 2 * scale)
  const by = Math.min(my + 16 * scale, bounds.y + bounds.h - bh - 2 * scale)
  ui.fill_round_rect(bx, by, bw, bh, 4 * scale, with_alpha(col('overlay'), 240))
  ui.stroke_round_rect(bx, by, bw, bh, 4 * scale, 1, col('border_strong'))
  for (let i = 0; i < lines.length; i += 1) {
    ui.draw_text(bx + pad, by + pad * 0.75 + i * line_h, lines[i], font, i === 0 ? col('text') : col('text_dim'), FONT_MONO)
  }
}

// --- memory tab --------------------------------------------------------------
//
// Treemap (area ∝ bytes, grouped by resource type) over a sortable, searchable
// table of every resource in the `ui_memory` registry. The search box filters
// by name; clicking a treemap cell selects the resource and scrolls the table
// to it; clicking a column header sorts (Type keeps the type groups and orders
// them by total bytes; Name / Size flatten the list).

type mem_rect = { x: number; y: number; w: number; h: number }
type mem_group = { kind: string; bytes: number; items: memory_resource[] }
type mem_row = { header: mem_group | null; res: memory_resource | null }
type mem_hover = { res: memory_resource }

function draw_memory_tab(
  ui: ui_renderer,
  input: ui_input_snapshot,
  panel: mem_rect,
  tb: mem_rect,
  toolbar_x: number,
  mem: ui_memory,
  state: profiler_panel_state,
  scale: number,
  col: (slot: theme_slot) => number,
  inside: (r: mem_rect) => boolean,
): void {
  const pad = 8 * scale
  const font = 10.5 * scale
  const mono = 9.5 * scale

  const all = mem.list()
  const total_bytes = mem.total_bytes()
  const gpu_bytes = mem.total_bytes('gpu')

  // Repaint whenever the registry mutates so live sizes stream like the CPU tab.
  if (mem.generation !== state._mem_generation) {
    state._mem_generation = mem.generation
    ui.request_render()
  }

  // --- Toolbar: search box (filters by name) + registry totals ---------------
  const sb = { x: toolbar_x, y: tb.y + (tb.h - 22 * scale) * 0.5, w: Math.max(90 * scale, Math.min(230 * scale, tb.x + tb.w - toolbar_x)), h: 22 * scale }
  draw_memory_search(ui, input, sb, scale, font, col, state, inside)
  const info_full = `${all.length} resources · ${format_bytes(total_bytes)} (gpu ${format_bytes(gpu_bytes)} · cpu ${format_bytes(total_bytes - gpu_bytes)})`
  const info = ui.text_width(info_full, mono, FONT_MONO) <= tb.x + tb.w - (sb.x + sb.w) - 10 * scale ? info_full : format_bytes(total_bytes)
  const info_w = ui.text_width(info, mono, FONT_MONO)
  if (info_w <= tb.x + tb.w - (sb.x + sb.w) - 10 * scale) {
    ui.draw_text(tb.x + tb.w - info_w, ui.text_v_center_y(tb.y, tb.h, mono), info, mono, col('text_dim'), FONT_MONO)
  }

  // --- Filter + group by resource type ---------------------------------------
  const query = state.mem_search.trim().toLowerCase()
  const items = query ? all.filter((r) => r.name.toLowerCase().includes(query)) : [...all]
  if (state.mem_selected && !items.some((r) => r.name === state.mem_selected)) state.mem_selected = null
  const group_map = new Map<string, mem_group>()
  for (const res of items) {
    let group = group_map.get(res.kind)
    if (!group) group_map.set(res.kind, (group = { kind: res.kind, bytes: 0, items: [] }))
    group.bytes += res.size_bytes
    group.items.push(res)
  }
  const groups = [...group_map.values()].sort((a, b) => b.bytes - a.bytes || a.kind.localeCompare(b.kind))

  // --- Layout: treemap over table ---------------------------------------------
  const content_top = tb.y + tb.h + pad * 0.5
  const content_h = panel.y + panel.h - pad * 0.5 - content_top
  let tm_h = clamp(content_h * 0.46, 80 * scale, 340 * scale)
  if (content_h - tm_h < 70 * scale) tm_h = Math.max(0, content_h - 70 * scale)
  const tm = { x: panel.x + pad, y: content_top, w: panel.w - pad * 2, h: tm_h }
  const tbl_y = tm.h > 0 ? tm.y + tm.h + pad * 0.5 : content_top
  const tbl = { x: tm.x, y: tbl_y, w: tm.w, h: panel.y + panel.h - pad * 0.5 - tbl_y }

  let hovered: mem_hover | null = null
  if (tm.h > 0) hovered = draw_memory_treemap(ui, input, tm, scale, col, state, groups, query, inside)
  if (tbl.h > 24 * scale) draw_memory_table(ui, input, tbl, scale, col, state, groups, items, query, inside)

  if (hovered) {
    const res = hovered.res
    const pct = total_bytes > 0 ? ((res.size_bytes / total_bytes) * 100).toFixed(1) : '0.0'
    const lines = [res.name, `${format_bytes(res.size_bytes)} · ${pct}% of tracked`, `${res.kind} · ${res.device}${res.detail ? ` · ${res.detail}` : ''}`]
    draw_tooltip_box(ui, panel, scale, mono, col, input.mouse_x, input.mouse_y, lines)
  }
}

function draw_memory_search(
  ui: ui_renderer,
  input: ui_input_snapshot,
  r: mem_rect,
  scale: number,
  font: number,
  col: (slot: theme_slot) => number,
  state: profiler_panel_state,
  inside: (r: mem_rect) => boolean,
): void {
  ui.fill_round_rect(r.x, r.y, r.w, r.h, 4 * scale, col('panel_alt'))
  ui.stroke_round_rect(r.x, r.y, r.w, r.h, 4 * scale, 1, state.mem_search_focused ? col('accent') : col('border'))
  const icon = 12 * scale
  draw_icon(ui, 'search', r.x + 6 * scale, r.y + (r.h - icon) * 0.5, icon, col('text_dim'))
  const tx = r.x + 6 * scale + icon + 5 * scale
  const clear_r = { x: r.x + r.w - 19 * scale, y: r.y + (r.h - 14 * scale) * 0.5, w: 14 * scale, h: 14 * scale }
  const has_text = state.mem_search.length > 0
  const over_clear = has_text && inside(clear_r)

  if (input.mouse_pressed) {
    if (over_clear) {
      state.mem_search = ''
      state.mem_scroll_y = 0
    } else {
      state.mem_search_focused = inside(r)
    }
  }
  if (state.mem_search_focused) {
    if (input.typed_text) {
      state.mem_search += input.typed_text
      state.mem_scroll_y = 0
    }
    if (input.key_backspace && state.mem_search) {
      state.mem_search = state.mem_search.slice(0, -1)
      state.mem_scroll_y = 0
    }
    if (input.key_escape) {
      if (state.mem_search) state.mem_search = ''
      else state.mem_search_focused = false
      state.mem_scroll_y = 0
    }
    ui.request_render() // keep the caret blinking
  }

  const text_w_max = (has_text ? clear_r.x : r.x + r.w) - tx - 4 * scale
  ui.push_clip(tx, r.y, Math.max(0, text_w_max), r.h)
  if (has_text) {
    ui.draw_text(tx, ui.text_v_center_y(r.y, r.h, font), state.mem_search, font, col('text'))
  } else if (!state.mem_search_focused) {
    ui.draw_text(tx, ui.text_v_center_y(r.y, r.h, font), 'Search by name…', font, with_alpha(col('text_dim'), 170))
  }
  if (state.mem_search_focused && performance.now() % 1060 < 530) {
    const caret_x = Math.min(tx + ui.text_width(state.mem_search, font), tx + text_w_max - 1)
    ui.fill_rect(caret_x, r.y + 4.5 * scale, 1.2 * scale, r.h - 9 * scale, col('accent'))
  }
  ui.pop_clip()
  if (has_text) {
    draw_icon(ui, 'close', clear_r.x + 2 * scale, clear_r.y + 2 * scale, 10 * scale, over_clear ? col('text') : col('text_dim'))
    if (over_clear) ui.set_cursor('pointer')
  }
  if (inside(r) && !over_clear) ui.set_cursor('text')
}

function draw_memory_treemap(
  ui: ui_renderer,
  input: ui_input_snapshot,
  tm: mem_rect,
  scale: number,
  col: (slot: theme_slot) => number,
  state: profiler_panel_state,
  groups: mem_group[],
  query: string,
  inside: (r: mem_rect) => boolean,
): mem_hover | null {
  const mono = 9.5 * scale
  ui.fill_round_rect(tm.x, tm.y, tm.w, tm.h, 4 * scale, col('panel_alt'))
  ui.stroke_round_rect(tm.x, tm.y, tm.w, tm.h, 4 * scale, 1, col('border'))
  if (groups.length === 0) {
    const msg = query ? `No resources match “${state.mem_search.trim()}”.` : 'Nothing tracked — report allocations via memory.track().'
    ui.draw_text(tm.x + 10 * scale, tm.y + 10 * scale, msg, 10.5 * scale, col('text_dim'))
    return null
  }

  let hovered: mem_hover | null = null
  const gap = 2 * scale
  const group_cells = squarify(groups.map((g) => ({ value: Math.max(g.bytes, 1), data: g })), tm.x + gap, tm.y + gap, tm.w - gap * 2, tm.h - gap * 2)
  ui.push_clip(tm.x, tm.y, tm.w, tm.h)
  for (const cell of group_cells) {
    const group = cell.data
    const hue = str_hash(group.kind) % 360
    const gx = cell.x + 1 * scale
    const gy = cell.y + 1 * scale
    const gw = cell.w - 2 * scale
    const gh = cell.h - 2 * scale
    if (gw < 2 || gh < 2) continue
    ui.fill_round_rect(gx, gy, gw, gh, 3 * scale, with_alpha(hsv_color(hue, 0.45, 0.6), 40))
    ui.stroke_round_rect(gx, gy, gw, gh, 3 * scale, 1, with_alpha(hsv_color(hue, 0.5, 0.8), 140))
    const header_h = gh >= 34 * scale && gw >= 46 * scale ? 13 * scale : 0
    if (header_h > 0) {
      ui.push_clip(gx + 4 * scale, gy, Math.max(0, gw - 8 * scale), header_h + 2 * scale)
      ui.draw_text(gx + 4 * scale, gy + 2.5 * scale, `${group.kind} · ${format_bytes(group.bytes)}`, mono, col('text_dim'), FONT_MONO)
      ui.pop_clip()
    }
    const inner = {
      x: gx + 2 * scale,
      y: gy + (header_h > 0 ? header_h + 2 * scale : 2 * scale),
      w: gw - 4 * scale,
      h: gh - (header_h > 0 ? header_h + 4 * scale : 4 * scale),
    }
    if (inner.w < 2 || inner.h < 2) continue
    const members = [...group.items].sort((a, b) => b.size_bytes - a.size_bytes || a.name.localeCompare(b.name))
    const member_cells = squarify(members.map((r) => ({ value: Math.max(r.size_bytes, 1), data: r })), inner.x, inner.y, inner.w, inner.h)
    for (const mc of member_cells) {
      const res = mc.data
      const cw = Math.max(mc.w - 0.75 * scale, 0.75)
      const ch = Math.max(mc.h - 0.75 * scale, 0.75)
      const rect = { x: mc.x, y: mc.y, w: cw, h: ch }
      const hover = inside(rect)
      const selected = state.mem_selected === res.name
      // CPU-resident cells get a hollower fill so residency reads at a glance.
      const value = hover || selected ? 0.95 : 0.7 + (str_hash(res.name) % 4) * 0.05
      const fill = hsv_color(hue, res.device === 'cpu' ? 0.24 : 0.42, value)
      ui.fill_round_rect(rect.x, rect.y, rect.w, rect.h, 2 * scale, fill)
      if (selected) ui.stroke_round_rect(rect.x, rect.y, rect.w, rect.h, 2 * scale, 1.5 * scale, col('accent'))
      if (cw > 44 * scale && ch > 13 * scale) {
        const label = `${short_name(res.name)} ${format_bytes(res.size_bytes)}`
        ui.push_clip(rect.x + 3 * scale, rect.y, Math.max(0, cw - 6 * scale), ch)
        ui.draw_text(rect.x + 3 * scale, ui.text_v_center_y(rect.y, Math.min(ch, 16 * scale), mono), label, mono, pack_color('#0e1116'), FONT_MONO)
        ui.pop_clip()
      }
      if (hover) {
        hovered = { res }
        ui.set_cursor('pointer')
        if (input.mouse_pressed) {
          state.mem_selected = selected ? null : res.name
          if (!selected) state._mem_scroll_to = res.name
        }
      }
    }
  }
  ui.pop_clip()
  return hovered
}

function draw_memory_table(
  ui: ui_renderer,
  input: ui_input_snapshot,
  tbl: mem_rect,
  scale: number,
  col: (slot: theme_slot) => number,
  state: profiler_panel_state,
  groups: mem_group[],
  items: memory_resource[],
  query: string,
  inside: (r: mem_rect) => boolean,
): void {
  const font = 10.5 * scale
  const mono = 9.5 * scale
  const header_h = 21 * scale
  const row_h = 20 * scale
  ui.fill_round_rect(tbl.x, tbl.y, tbl.w, tbl.h, 4 * scale, col('panel_alt'))
  ui.stroke_round_rect(tbl.x, tbl.y, tbl.w, tbl.h, 4 * scale, 1, col('border'))

  // --- Columns, laid out from the right edge ----------------------------------
  const size_x = tbl.x + tbl.w - 92 * scale
  const dev_x = tbl.w >= 320 * scale ? size_x - 44 * scale : size_x
  const kind_x = tbl.w >= 250 * scale ? dev_x - 92 * scale : dev_x
  const name_x = tbl.x + 8 * scale

  // --- Header: click a column to sort, click again to flip --------------------
  const grouped = state.mem_sort_key === 'kind'
  const sort_header = (label: string, key: memory_sort_key | null, hx: number, hw: number, align_right: boolean): void => {
    if (hw <= 0) return
    const r = { x: hx, y: tbl.y, w: hw, h: header_h }
    const hover = key !== null && inside(r)
    if (hover) ui.set_cursor('pointer')
    const active = key !== null && state.mem_sort_key === key
    const color = active || hover ? col('text') : col('text_dim')
    const tw = ui.text_width(label, font)
    const text_x = align_right ? hx + hw - tw - (active ? 13 * scale : 0) - 8 * scale : hx
    ui.draw_text(text_x, ui.text_v_center_y(tbl.y, header_h, font), label, font, color)
    if (active) draw_icon(ui, state.mem_sort_asc ? 'chevron_up' : 'chevron_down', text_x + tw + 2 * scale, tbl.y + (header_h - 11 * scale) * 0.5, 11 * scale, color)
    if (hover && input.mouse_pressed && key !== null) {
      if (state.mem_sort_key === key) {
        state.mem_sort_asc = !state.mem_sort_asc
      } else {
        state.mem_sort_key = key
        state.mem_sort_asc = key === 'name' // size and type default to big-first
      }
    }
  }
  sort_header('Name', 'name', name_x, kind_x - name_x - 6 * scale, false)
  if (kind_x < dev_x) sort_header('Type', 'kind', kind_x, dev_x - kind_x - 6 * scale, false)
  if (dev_x < size_x) ui.draw_text(dev_x, ui.text_v_center_y(tbl.y, header_h, font), 'Dev', font, col('text_dim'))
  sort_header('Size', 'size', size_x, tbl.x + tbl.w - size_x, true)
  ui.stroke_line(tbl.x, tbl.y + header_h, tbl.x + tbl.w, tbl.y + header_h, 1, col('border'))

  // --- Rows: type groups (collapsible) or a flat sorted list ------------------
  const dir = state.mem_sort_asc ? 1 : -1
  if (state._mem_scroll_to && grouped) {
    const target = items.find((r) => r.name === state._mem_scroll_to)
    if (target) state.mem_collapsed = state.mem_collapsed.filter((k) => k !== target.kind)
  }
  const rows: mem_row[] = []
  if (grouped) {
    const ordered = [...groups].sort((a, b) => (a.bytes - b.bytes) * dir || a.kind.localeCompare(b.kind))
    for (const group of ordered) {
      rows.push({ header: group, res: null })
      if (state.mem_collapsed.includes(group.kind)) continue
      const members = [...group.items].sort((a, b) => b.size_bytes - a.size_bytes || a.name.localeCompare(b.name))
      for (const res of members) rows.push({ header: null, res })
    }
  } else {
    const sorted = [...items].sort((a, b) =>
      state.mem_sort_key === 'name' ? a.name.localeCompare(b.name) * dir : (a.size_bytes - b.size_bytes) * dir || a.name.localeCompare(b.name),
    )
    for (const res of sorted) rows.push({ header: null, res })
  }

  const view = { x: tbl.x, y: tbl.y + header_h + 1, w: tbl.w, h: tbl.h - header_h - 2 }
  const total_h = rows.length * row_h
  if (state._mem_scroll_to) {
    const idx = rows.findIndex((r) => r.res?.name === state._mem_scroll_to)
    if (idx >= 0) {
      const top = idx * row_h
      if (top < state.mem_scroll_y) state.mem_scroll_y = top
      else if (top + row_h > state.mem_scroll_y + view.h) state.mem_scroll_y = top + row_h - view.h
    }
    state._mem_scroll_to = null
  }
  if (inside(view) && input.wheel_y) state.mem_scroll_y -= input.wheel_y * 20 * scale
  state.mem_scroll_y = clamp(state.mem_scroll_y, 0, Math.max(0, total_h - view.h))

  ui.push_clip(view.x, view.y, view.w, view.h)
  if (rows.length === 0) {
    const msg = query ? `No resources match “${state.mem_search.trim()}”.` : 'Nothing tracked yet.'
    ui.draw_text(view.x + 8 * scale, view.y + 8 * scale, msg, font, col('text_dim'))
  }
  const first_row = Math.max(0, Math.floor(state.mem_scroll_y / row_h))
  for (let i = first_row; i < rows.length; i += 1) {
    const ry = view.y + i * row_h - state.mem_scroll_y
    if (ry >= view.y + view.h) break
    const row = rows[i]
    const row_rect = { x: view.x, y: ry, w: view.w, h: row_h }
    const hover = inside(row_rect)
    if (row.header) {
      const group = row.header
      const collapsed = state.mem_collapsed.includes(group.kind)
      ui.fill_rect(row_rect.x, row_rect.y, row_rect.w, row_rect.h, hover ? col('hover') : col('track'))
      draw_icon(ui, collapsed ? 'chevron_right' : 'chevron_down', view.x + 4 * scale, ry + (row_h - 12 * scale) * 0.5, 12 * scale, col('text_dim'))
      const hue = str_hash(group.kind) % 360
      ui.fill_round_rect(view.x + 19 * scale, ry + (row_h - 8 * scale) * 0.5, 8 * scale, 8 * scale, 2 * scale, hsv_color(hue, 0.42, 0.78))
      ui.draw_text(view.x + 31 * scale, ui.text_v_center_y(ry, row_h, font), group.kind, font, col('text'))
      const sub = `${group.items.length} · ${format_bytes(group.bytes)}`
      ui.draw_text(view.x + 31 * scale + ui.text_width(group.kind, font) + 8 * scale, ui.text_v_center_y(ry, row_h, mono), sub, mono, col('text_dim'), FONT_MONO)
      if (hover) {
        ui.set_cursor('pointer')
        if (input.mouse_pressed) {
          state.mem_collapsed = collapsed ? state.mem_collapsed.filter((k) => k !== group.kind) : [...state.mem_collapsed, group.kind]
        }
      }
      continue
    }
    const res = row.res
    if (!res) continue
    const selected = state.mem_selected === res.name
    if (selected) {
      ui.fill_rect(row_rect.x, row_rect.y, row_rect.w, row_rect.h, with_alpha(col('accent'), 52))
      ui.fill_rect(row_rect.x, row_rect.y, 2 * scale, row_rect.h, col('accent'))
    } else if (hover) {
      ui.fill_rect(row_rect.x, row_rect.y, row_rect.w, row_rect.h, col('hover'))
    }
    const nx = name_x + (grouped ? 16 * scale : 0)
    ui.push_clip(nx, ry, Math.max(0, kind_x - nx - 8 * scale), row_h)
    ui.draw_text(nx, ui.text_v_center_y(ry, row_h, font), res.name, font, col('text'))
    if (res.detail) {
      const name_w = ui.text_width(res.name, font)
      ui.draw_text(nx + name_w + 7 * scale, ui.text_v_center_y(ry, row_h, mono), res.detail, mono, with_alpha(col('text_dim'), 180), FONT_MONO)
    }
    ui.pop_clip()
    if (kind_x < dev_x) {
      ui.push_clip(kind_x, ry, dev_x - kind_x - 6 * scale, row_h)
      ui.draw_text(kind_x, ui.text_v_center_y(ry, row_h, font), res.kind, font, col('text_dim'))
      ui.pop_clip()
    }
    if (dev_x < size_x) ui.draw_text(dev_x, ui.text_v_center_y(ry, row_h, mono), res.device, mono, col('text_dim'), FONT_MONO)
    const size_label = format_bytes(res.size_bytes)
    const size_w = ui.text_width(size_label, mono, FONT_MONO)
    ui.draw_text(tbl.x + tbl.w - size_w - 8 * scale, ui.text_v_center_y(ry, row_h, mono), size_label, mono, col('text'), FONT_MONO)
    if (hover) {
      ui.set_cursor('pointer')
      if (input.mouse_pressed) state.mem_selected = selected ? null : res.name
    }
  }
  ui.pop_clip()

  // --- Scrollbar ---------------------------------------------------------------
  if (total_h > view.h) {
    const track_x = tbl.x + tbl.w - 5 * scale
    const knob_h = Math.max(18 * scale, (view.h / total_h) * view.h)
    const knob_y = view.y + (state.mem_scroll_y / (total_h - view.h)) * (view.h - knob_h)
    ui.fill_round_rect(track_x, knob_y, 3 * scale, knob_h, 1.5 * scale, with_alpha(col('text_dim'), 110))
  }
}

/** `ui.font_texture.cjk` → `font_texture.cjk` — drop the common `ui.` prefix for compact treemap labels. */
function short_name(name: string): string {
  return name.startsWith('ui.') ? name.slice(3) : name
}

// --- squarified treemap layout ------------------------------------------------

type tm_cell<T> = { x: number; y: number; w: number; h: number; data: T }

/**
 * Squarified treemap: split `rect` into one cell per entry with area ∝ value,
 * laying rows along the shorter edge while that keeps cells closest to square.
 * Entries must be sorted by descending value.
 */
function squarify<T>(entries: { value: number; data: T }[], x: number, y: number, w: number, h: number): tm_cell<T>[] {
  const out: tm_cell<T>[] = []
  let total = 0
  for (const e of entries) total += e.value
  if (total <= 0 || w <= 1 || h <= 1) return out
  const area_scale = (w * h) / total
  let i = 0
  while (i < entries.length) {
    const side = Math.min(w, h)
    let count = 1
    let worst = squarify_row_worst(entries, i, 1, area_scale, side)
    while (i + count < entries.length) {
      const next = squarify_row_worst(entries, i, count + 1, area_scale, side)
      if (next > worst) break
      worst = next
      count += 1
    }
    let row_area = 0
    for (let k = i; k < i + count; k += 1) row_area += entries[k].value * area_scale
    const thickness = side > 0 ? row_area / side : 0
    let off = 0
    for (let k = i; k < i + count; k += 1) {
      const len = thickness > 0 ? (entries[k].value * area_scale) / thickness : 0
      if (w >= h) out.push({ x, y: y + off, w: thickness, h: len, data: entries[k].data })
      else out.push({ x: x + off, y, w: len, h: thickness, data: entries[k].data })
      off += len
    }
    if (w >= h) {
      x += thickness
      w -= thickness
    } else {
      y += thickness
      h -= thickness
    }
    i += count
  }
  return out
}

/** Worst (most stretched) aspect ratio in the row `entries[start, start+count)` laid along `side`. */
function squarify_row_worst<T>(entries: { value: number; data: T }[], start: number, count: number, area_scale: number, side: number): number {
  let sum = 0
  let lo = Infinity
  let hi = 0
  for (let k = start; k < start + count; k += 1) {
    const area = Math.max(1e-6, entries[k].value * area_scale)
    sum += area
    lo = Math.min(lo, area)
    hi = Math.max(hi, area)
  }
  const s2 = side * side
  return Math.max((sum * sum) / (s2 * lo), (s2 * hi) / (sum * sum))
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

function str_hash(text: string): number {
  let hash = 0
  for (let i = 0; i < text.length; i += 1) hash = (hash * 31 + text.charCodeAt(i)) >>> 0
  return hash
}

/** Stable pastel color per zone name (hashed hue), brighter when highlighted. */
function name_color(name: string, highlight: boolean): number {
  return hsv_color(str_hash(name) % 360, 0.42, highlight ? 0.95 : 0.78)
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
