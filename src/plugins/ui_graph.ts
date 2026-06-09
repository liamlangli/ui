// graph — a generic, immediate-mode node-graph canvas plugin.
//
// A reusable node editor surface: it draws a pannable / zoomable grid, nodes
// with typed input/output pins, bezier wires between them, a marquee selection
// box and a floating link draft, and it owns all of the interaction (pan, zoom,
// node drag, marquee select, wire drag-to-connect). It is deliberately
// *content-agnostic*: the host owns the node and link arrays and describes each
// node through a `graph_node_view` (title + pins), so the same canvas drives a
// shader graph, a render graph, a material graph, a logic graph, …
//
// Usage (once per frame, inside begin_frame()/flush()):
//
//   const ev = graph_canvas(ui, theme, input, x, y, w, h, nodes, links, gstate,
//     (node) => shader_node_view(node),            // describe pins/title
//     {
//       compatible: (a, b) => slots_compatible(a, b),
//       render_body: (node, view, body) => draw_inline_editor(node, body),
//     })
//   if (ev.link_created) recompile()
//   if (ev.menu_requested) open_create_menu(ev.menu_requested)
//
// The host mutates `nodes`/`links` directly (the plugin moves `node.x/.y` while
// dragging and pushes to `links` on connect); events are returned so the host
// can react (recompile, open a create menu, remove a node on Delete, …).

import { theme_color } from '../ui_theme'
import type { theme_definition, theme_slot } from '../ui_types'
import { ui_renderer } from '../ui_renderer'
import type { ui_input_snapshot } from '../ui_widgets'

/** Node identity. Stable across frames; used for selection + link endpoints. */
export type graph_id = number | string

/** A single typed connector on a node. `kind` is an opaque host string used for
 * wire coloring and link-compatibility checks. */
export interface graph_pin {
  label: string
  kind: string
  /** Packed `0xAABBGGRR` color override for this pin + its wires. */
  color?: number
}

/** The minimum a host node object must expose: identity + graph-space position.
 * Hosts attach whatever else they like (type, value, …). */
export interface graph_node_base {
  id: graph_id
  /** Position in graph units (zoom-independent); the plugin mutates these on drag. */
  x: number
  y: number
}

/** How a node should be drawn this frame — supplied by the host's spec callback. */
export interface graph_node_view {
  title: string
  inputs: graph_pin[]
  outputs: graph_pin[]
  /** Packed `0xAABBGGRR` header color override. */
  header_color?: number
  /** Extra body rows (each `slot_row_h` tall) reserved below the pins for
   * host-drawn inline content via {@link graph_options.render_body}. */
  body_rows?: number
}

/** A directed wire from an output pin to an input pin. */
export interface graph_link {
  src_node: graph_id
  src_pin: number
  dst_node: graph_id
  dst_pin: number
  color?: number
}

/** Screen-space layout of a node body, handed to {@link graph_options.render_body}. */
export interface graph_body_rect {
  /** Node box, physical px. */
  node_x: number
  node_y: number
  node_w: number
  node_h: number
  /** Content area below the pin rows, physical px. */
  x: number
  y: number
  w: number
  h: number
  /** Combined device-pixel-ratio × zoom scale, for sizing inline content. */
  gs: number
}

export interface graph_options<N extends graph_node_base = graph_node_base> {
  /** Logical node width (graph units before zoom). Defaults to 120. */
  node_w?: number
  /** Logical title font size. Defaults to 7. */
  title_font_px?: number
  /** Logical pin label font size. Defaults to 5.6. */
  pin_font_px?: number
  /** Return false to forbid a wire between two pin kinds. Defaults to always-allow. */
  compatible?: (output_kind: string, input_kind: string) => boolean
  /** Packed color for a pin of `kind`. Defaults to a hashed hue per kind. */
  pin_color?: (kind: string, is_input: boolean) => number
  /** Packed color for a wire between two kinds. Defaults to a blended hue. */
  link_color?: (output_kind: string, input_kind: string) => number
  /** Packed header color for a node. Defaults to a hashed hue per title. */
  header_color?: (node: N, view: graph_node_view) => number
  /** Draw inline content inside a node body (after the node chrome, clipped). */
  render_body?: (node: N, view: graph_node_view, body: graph_body_rect) => void
}

type drag_state = { node_ids: graph_id[]; last_x: number; last_y: number }
type pan_state = { last_x: number; last_y: number }
type marquee_state = { start_x: number; start_y: number; cur_x: number; cur_y: number; base: graph_id[] }
type link_draft = { node: graph_id; pin: number; is_output: boolean }

export interface graph_state {
  pan_x: number
  pan_y: number
  zoom: number
  selected: Set<graph_id>
  /** Internal transient interaction state. */
  _drag: drag_state | null
  _pan: pan_state | null
  _marquee: marquee_state | null
  _link: link_draft | null
}

export interface graph_event {
  /** The selection set changed this frame (click, marquee, or clear). */
  selection_changed?: boolean
  /** A node body was pressed (after selection update). */
  node_pressed?: graph_id
  /** A wire was created and pushed onto the `links` array. */
  link_created?: graph_link
  /** One or more nodes finished a move this frame. */
  nodes_moved?: boolean
  /** Right-click on empty canvas: the host should open a create menu here. */
  menu_requested?: { screen_x: number; screen_y: number; graph_x: number; graph_y: number }
  /** Delete/Backspace pressed with a non-empty selection. */
  delete_requested?: boolean
}

const UNIT = 0.52 // graph-units → px before zoom (position scale)
const HEADER_H = 18
const BODY_PAD = 8
const SLOT_ROW_H = 14

export function create_graph_state(): graph_state {
  return {
    pan_x: 0,
    pan_y: 0,
    zoom: 1,
    selected: new Set<graph_id>(),
    _drag: null,
    _pan: null,
    _marquee: null,
    _link: null,
  }
}

export function graph_canvas<N extends graph_node_base>(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  nodes: N[],
  links: graph_link[],
  state: graph_state,
  spec: (node: N) => graph_node_view,
  options?: graph_options<N>,
): graph_event {
  const scale = window.devicePixelRatio || 1
  const zoom = clamp(state.zoom || 1, 0.45, 2.4)
  state.zoom = zoom
  const node_w = options?.node_w ?? 120
  const title_font = (options?.title_font_px ?? 7) * scale * zoom
  const pin_font = (options?.pin_font_px ?? 5.6) * scale * zoom
  const compatible = options?.compatible ?? (() => true)
  const col = (slot: theme_slot) => pack(theme_color(theme, slot))

  const pos_scale = UNIT * zoom
  const gs = scale * zoom
  const origin_x = x + 24 * scale + state.pan_x * scale
  const origin_y = y + 18 * scale + state.pan_y * scale
  const event: graph_event = {}

  // --- Layout helpers ----------------------------------------------------
  const view_of = new Map<graph_id, graph_node_view>()
  const get_view = (node: N): graph_node_view => {
    let v = view_of.get(node.id)
    if (!v) {
      v = spec(node)
      view_of.set(node.id, v)
    }
    return v
  }
  const node_screen = (node: N) => ({ nx: origin_x + node.x * pos_scale, ny: origin_y + node.y * pos_scale })
  const node_h_px = (view: graph_node_view): number => {
    const rows = Math.max(view.inputs.length, view.outputs.length, 1)
    const body = (view.body_rows ?? 0) * SLOT_ROW_H
    return (HEADER_H + BODY_PAD + rows * SLOT_ROW_H + BODY_PAD + body) * gs
  }
  const slot_cy = (ny: number, i: number) => ny + (HEADER_H + BODY_PAD + SLOT_ROW_H * (i + 0.5)) * gs
  const inside = input.mouse_x >= x && input.mouse_x < x + w && input.mouse_y >= y && input.mouse_y < y + h

  // --- Hit testing (topmost wins) ----------------------------------------
  const pin_r = Math.max(5, 8 * gs)
  let hit_node: N | null = null
  let hit_pin: { node: N; pin: number; is_output: boolean } | null = null
  for (const node of nodes) {
    const view = get_view(node)
    const { nx, ny } = node_screen(node)
    const nw = node_w * gs
    const nh = node_h_px(view)
    if (input.mouse_x >= nx && input.mouse_x < nx + nw && input.mouse_y >= ny && input.mouse_y < ny + nh) hit_node = node
    for (let i = 0; i < view.inputs.length; i += 1) {
      if (Math.hypot(input.mouse_x - nx, input.mouse_y - slot_cy(ny, i)) <= pin_r) hit_pin = { node, pin: i, is_output: false }
    }
    for (let i = 0; i < view.outputs.length; i += 1) {
      if (Math.hypot(input.mouse_x - (nx + nw), input.mouse_y - slot_cy(ny, i)) <= pin_r) hit_pin = { node, pin: i, is_output: true }
    }
  }

  // --- Wheel zoom (anchored at cursor) -----------------------------------
  if (inside && input.wheel_y) {
    const gx = (input.mouse_x - origin_x) / pos_scale
    const gy = (input.mouse_y - origin_y) / pos_scale
    const next_zoom = clamp(zoom * (input.wheel_y > 0 ? 1.06 : 0.94), 0.45, 2.4)
    const next_pos = UNIT * next_zoom
    state.pan_x = (input.mouse_x - gx * next_pos - x - 24 * scale) / scale
    state.pan_y = (input.mouse_y - gy * next_pos - y - 18 * scale) / scale
    state.zoom = next_zoom
  }

  // --- Press: start an interaction ---------------------------------------
  if (inside && input.mouse_right_pressed && !state._link && !state._drag && !state._marquee) {
    event.menu_requested = {
      screen_x: input.mouse_x,
      screen_y: input.mouse_y,
      graph_x: (input.mouse_x - origin_x) / pos_scale,
      graph_y: (input.mouse_y - origin_y) / pos_scale,
    }
  }
  if (inside && input.mouse_pressed && !state._pan) {
    if (hit_pin) {
      state._link = { node: hit_pin.node.id, pin: hit_pin.pin, is_output: hit_pin.is_output }
    } else if (hit_node) {
      const id = hit_node.id
      if (input.shift) {
        if (state.selected.has(id)) state.selected.delete(id)
        else state.selected.add(id)
      } else if (!state.selected.has(id)) {
        state.selected.clear()
        state.selected.add(id)
      }
      event.selection_changed = true
      event.node_pressed = id
      state._drag = { node_ids: [...state.selected], last_x: input.mouse_x, last_y: input.mouse_y }
    } else {
      const base = input.shift ? [...state.selected] : []
      if (!input.shift) state.selected.clear()
      state._marquee = { start_x: input.mouse_x, start_y: input.mouse_y, cur_x: input.mouse_x, cur_y: input.mouse_y, base }
      event.selection_changed = true
    }
  }
  // Middle-drag pan (level-triggered).
  if (inside && input.mouse_middle_down && !state._pan && !state._drag && !state._marquee && !state._link) {
    state._pan = { last_x: input.mouse_x, last_y: input.mouse_y }
  }

  // --- Update active interactions ----------------------------------------
  if (state._pan) {
    if (input.mouse_middle_down) {
      state.pan_x += (input.mouse_x - state._pan.last_x) / scale
      state.pan_y += (input.mouse_y - state._pan.last_y) / scale
      state._pan.last_x = input.mouse_x
      state._pan.last_y = input.mouse_y
    } else {
      state._pan = null
    }
  }
  if (state._drag) {
    if (input.mouse_down) {
      const dx = (input.mouse_x - state._drag.last_x) / pos_scale
      const dy = (input.mouse_y - state._drag.last_y) / pos_scale
      if (dx || dy) {
        const moving = new Set(state._drag.node_ids)
        for (const node of nodes) if (moving.has(node.id)) {
          node.x += dx
          node.y += dy
        }
        event.nodes_moved = true
      }
      state._drag.last_x = input.mouse_x
      state._drag.last_y = input.mouse_y
    } else {
      state._drag = null
    }
  }
  if (state._marquee) {
    if (input.mouse_down) {
      state._marquee.cur_x = input.mouse_x
      state._marquee.cur_y = input.mouse_y
      const r = norm_rect(state._marquee.start_x, state._marquee.start_y, state._marquee.cur_x, state._marquee.cur_y)
      state.selected = new Set(state._marquee.base)
      for (const node of nodes) {
        const view = get_view(node)
        const { nx, ny } = node_screen(node)
        const nw = node_w * gs
        const nh = node_h_px(view)
        if (nx < r.x + r.w && nx + nw > r.x && ny < r.y + r.h && ny + nh > r.y) state.selected.add(node.id)
      }
      event.selection_changed = true
    } else {
      state._marquee = null
    }
  }

  // --- Release: commit link draft ----------------------------------------
  if (state._link && !input.mouse_down) {
    const draft = state._link
    if (hit_pin && hit_pin.is_output !== draft.is_output) {
      const out = draft.is_output ? draft : { node: hit_pin.node.id, pin: hit_pin.pin }
      const inp = draft.is_output ? { node: hit_pin.node.id, pin: hit_pin.pin } : draft
      const out_node = nodes.find((n) => n.id === out.node)
      const in_node = nodes.find((n) => n.id === inp.node)
      if (out_node && in_node && out.node !== inp.node) {
        const ok = compatible(get_view(out_node).outputs[out.pin]?.kind ?? '', get_view(in_node).inputs[inp.pin]?.kind ?? '')
        if (ok) {
          // One wire per input pin: drop any existing link into this input.
          for (let i = links.length - 1; i >= 0; i -= 1) {
            if (links[i].dst_node === inp.node && links[i].dst_pin === inp.pin) links.splice(i, 1)
          }
          const link: graph_link = { src_node: out.node, src_pin: out.pin, dst_node: inp.node, dst_pin: inp.pin }
          links.push(link)
          event.link_created = link
        }
      }
    }
    state._link = null
  }

  // --- Keyboard: delete selection ----------------------------------------
  if (inside && (input.key_delete || input.key_backspace) && state.selected.size > 0) {
    event.delete_requested = true
  }

  // --- Cursor ------------------------------------------------------------
  if (state._pan) ui.set_cursor('grabbing')
  else if (state._link || hit_pin) ui.set_cursor('crosshair')
  else if (state._drag) ui.set_cursor('move')

  // === Draw ==============================================================
  ui.push_clip(x, y, w, h)
  ui.fill_rect(x, y, w, h, col('panel_alt'))
  draw_grid(ui, theme, x, y, w, h, origin_x, origin_y, scale, zoom)

  // Committed wires (under the nodes).
  for (const link of links) {
    const src = nodes.find((n) => n.id === link.src_node)
    const dst = nodes.find((n) => n.id === link.dst_node)
    if (!src || !dst) continue
    const sv = get_view(src)
    const dv = get_view(dst)
    const so = sv.outputs[link.src_pin]
    const di = dv.inputs[link.dst_pin]
    if (!so || !di) continue
    const s = node_screen(src)
    const d = node_screen(dst)
    const color = link.color ?? options?.link_color?.(so.kind, di.kind) ?? blended_link_color(so.kind, di.kind)
    draw_bezier(ui, s.nx + node_w * gs, slot_cy(s.ny, link.src_pin), d.nx, slot_cy(d.ny, link.dst_pin), Math.max(2, 2 * gs), color, gs)
  }

  // Link draft following the cursor.
  if (state._link) {
    const src = nodes.find((n) => n.id === state._link!.node)
    if (src) {
      const v = get_view(src)
      const pin = state._link.is_output ? v.outputs[state._link.pin] : v.inputs[state._link.pin]
      if (pin) {
        const s = node_screen(src)
        const px = state._link.is_output ? s.nx + node_w * gs : s.nx
        const py = slot_cy(s.ny, state._link.pin)
        const color = pin.color ?? options?.pin_color?.(pin.kind, !state._link.is_output) ?? pin_hue_color(pin.kind, !state._link.is_output)
        if (state._link.is_output) draw_bezier(ui, px, py, input.mouse_x, input.mouse_y, Math.max(2, 2 * gs), color, gs)
        else draw_bezier(ui, input.mouse_x, input.mouse_y, px, py, Math.max(2, 2 * gs), color, gs)
      }
    }
  }

  // Nodes.
  for (const node of nodes) {
    const view = get_view(node)
    const { nx, ny } = node_screen(node)
    const nw = node_w * gs
    const nh = node_h_px(view)
    const selected = state.selected.has(node.id)
    if (selected) ui.stroke_round_rect(nx - 3 * scale, ny - 3 * scale, nw + 6 * scale, nh + 6 * scale, 4 * scale, 2 * scale, col('accent'))
    ui.fill_round_rect(nx, ny, nw, nh, 4 * scale, col('panel'))
    ui.fill_round_rect_per_corner(nx, ny, nw, HEADER_H * gs, 4 * scale, 4 * scale, 0, 0, view.header_color ?? options?.header_color?.(node, view) ?? title_hue_color(view.title))
    ui.stroke_round_rect(nx, ny, nw, nh, 4 * scale, 1, col('border'))
    ui.push_clip(nx, ny, nw, HEADER_H * gs)
    ui.draw_text(nx + 8 * gs, ui.text_v_center_y(ny + 2 * gs, HEADER_H * gs - 3 * gs, title_font), view.title, title_font, col('text'))
    ui.pop_clip()

    const pin_size = Math.max(3, 6 * gs)
    for (let i = 0; i < view.inputs.length; i += 1) {
      const pin = view.inputs[i]
      const cy = slot_cy(ny, i)
      ui.fill_rect(nx - pin_size * 0.5, cy - pin_size * 0.5, pin_size, pin_size, pin.color ?? options?.pin_color?.(pin.kind, true) ?? pin_hue_color(pin.kind, true))
      ui.draw_text(nx + 9 * gs, ui.text_v_center_y(cy - 6 * gs, 12 * gs, pin_font), pin.label, pin_font, col('text_dim'))
    }
    for (let i = 0; i < view.outputs.length; i += 1) {
      const pin = view.outputs[i]
      const cy = slot_cy(ny, i)
      const lw = ui.text_width(pin.label, pin_font)
      ui.draw_text(nx + nw - lw - 10 * gs, ui.text_v_center_y(cy - 6 * gs, 12 * gs, pin_font), pin.label, pin_font, col('text_dim'))
      ui.fill_rect(nx + nw - pin_size * 0.5, cy - pin_size * 0.5, pin_size, pin_size, pin.color ?? options?.pin_color?.(pin.kind, false) ?? pin_hue_color(pin.kind, false))
    }

    if (options?.render_body) {
      const rows = Math.max(view.inputs.length, view.outputs.length, 1)
      const body_top = ny + (HEADER_H + BODY_PAD + rows * SLOT_ROW_H) * gs
      ui.push_clip(nx, ny, nw, nh)
      options.render_body(node, view, { node_x: nx, node_y: ny, node_w: nw, node_h: nh, x: nx, y: body_top, w: nw, h: ny + nh - body_top, gs })
      ui.pop_clip()
    }
  }

  // Marquee box.
  if (state._marquee) {
    const r = norm_rect(state._marquee.start_x, state._marquee.start_y, state._marquee.cur_x, state._marquee.cur_y)
    ui.fill_rect(r.x, r.y, r.w, r.h, with_alpha(col('accent'), 40))
    ui.stroke_rect(r.x, r.y, r.w, r.h, 1.5 * scale, col('accent'))
  }
  ui.pop_clip()

  return event
}

// --- internals -----------------------------------------------------------

function draw_grid(
  ui: ui_renderer,
  theme: theme_definition,
  gx: number,
  gy: number,
  gw: number,
  gh: number,
  origin_x: number,
  origin_y: number,
  scale: number,
  zoom: number,
): void {
  const minor = 28 * scale * zoom
  const major = minor * 4
  const track = pack(theme_color(theme, 'track'))
  const border = pack(theme_color(theme, 'border'))
  const v = (step: number, color: number) => {
    const start = gx + (((origin_x - gx) % step) + step) % step
    for (let x = start; x < gx + gw; x += step) ui.stroke_line(x, gy, x, gy + gh, 1, color)
  }
  const hz = (step: number, color: number) => {
    const start = gy + (((origin_y - gy) % step) + step) % step
    for (let y = start; y < gy + gh; y += step) ui.stroke_line(gx, y, gx + gw, y, 1, color)
  }
  v(minor, track)
  hz(minor, track)
  v(major, border)
  hz(major, border)
}

function draw_bezier(ui: ui_renderer, x0: number, y0: number, x1: number, y1: number, line_w: number, rgba: number, gs: number): void {
  const bend = Math.max(24 * gs, Math.abs(x1 - x0) * 0.35)
  const cx0 = x0 + bend
  const cx1 = x1 - bend
  const steps = Math.max(12, Math.ceil(Math.abs(x1 - x0) / Math.max(14 * gs, 1)))
  // Sample the curve into a flat point list and stroke it as one continuous
  // ribbon so the segments share mitered joins and a single feathered outline,
  // instead of a chain of overlapping per-segment quads.
  const pts = new Float32Array((steps + 1) * 2)
  pts[0] = x0
  pts[1] = y0
  for (let i = 1; i <= steps; i += 1) {
    const t = i / steps
    const mt = 1 - t
    pts[i * 2 + 0] = mt * mt * mt * x0 + 3 * mt * mt * t * cx0 + 3 * mt * t * t * cx1 + t * t * t * x1
    pts[i * 2 + 1] = mt * mt * mt * y0 + 3 * mt * mt * t * y0 + 3 * mt * t * t * y1 + t * t * t * y1
  }
  ui.stroke_polyline(pts, steps + 1, line_w, rgba, gs)
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function norm_rect(x0: number, y0: number, x1: number, y1: number): { x: number; y: number; w: number; h: number } {
  return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) }
}

function hash_hue(s: string): number {
  let hash = 0
  for (let i = 0; i < s.length; i += 1) hash = (hash * 31 + s.charCodeAt(i)) >>> 0
  return hash % 360
}

function pin_hue_color(kind: string, is_input: boolean): number {
  return hsv_color(hash_hue(kind) + (is_input ? -10 : 10), 0.52, 0.84)
}

function blended_link_color(src_kind: string, dst_kind: string): number {
  return hsv_color((hash_hue(src_kind) * 0.7 + hash_hue(dst_kind) * 0.3 + 360) % 360, 0.58, 0.9)
}

function title_hue_color(title: string): number {
  return hsv_color(hash_hue(title), 0.46, 0.66)
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
  return (((255 & 255) << 24) | ((bb & 255) << 16) | ((gg & 255) << 8) | (rr & 255)) >>> 0
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
