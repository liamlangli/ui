// node_graph — an immediate-mode node editor with a dotted-grid backdrop.
//
// A self-contained node-graph canvas: it paints a pannable / zoomable field of
// dots, draws nodes that carry typed input/output *slots*, links them with
// bezier wires, and gates every connection on slot-type compatibility so only
// matching slots can be wired together. It owns the interaction — drag a node
// to move it, drag from one slot to a compatible slot to connect, middle-drag
// to pan, wheel to zoom, right-click for a built-in "add node" menu, Delete to
// remove the selection.
//
// Unlike the sibling `graph` plugin (which keeps node shape in a host `spec`
// callback over a line grid), `node_graph` stores slots directly on the node
// model, so adding a node or a slot is a plain data mutation — see
// `add_node` / `add_slot`. The host owns the `nodes` / `connections` arrays and
// reacts to the returned events.
//
// Usage (once per frame, inside begin_frame()/flush()):
//
//   const state = create_node_graph_state()
//   const nodes = [ add_node('UV', 20, 30, { outputs: [{ label: 'UV', type: 'uv' }] }) ]
//   const connections: node_graph_connection[] = []
//
//   const ev = node_graph(ui, theme, input, x, y, w, h, nodes, connections, state, {
//     compatible: (a, b) => a === b,                 // gate wire creation by type
//     node_types: [                                  // populate the right-click menu
//       { type: 'Texture', title: 'Texture',
//         inputs: [{ label: 'UV', type: 'uv' }], outputs: [{ label: 'RGBA', type: 'color' }] },
//     ],
//   })
//   if (ev.connection_created) recompile()
//   if (ev.delete_requested) remove_selected(state.selected)

import { theme_color } from '../ui_theme'
import type { theme_definition, theme_slot } from '../ui_types'
import { ui_renderer } from '../ui_renderer'
import type { ui_input_snapshot } from '../ui_widgets'

/** Node identity. Stable across frames; used for selection + wire endpoints. */
export type node_graph_id = number | string

/** A single typed connector on a node. `type` is an opaque host string used for
 * wire coloring and connection-compatibility checks. */
export interface node_graph_slot {
  label: string
  /** Slot type tag; only compatible types can be wired together. */
  type: string
  /** Packed `0xAABBGGRR` color override for this slot + its wires. */
  color?: number
}

/** A node on the canvas: identity, graph-space position, title and typed slots. */
export interface node_graph_node {
  id: node_graph_id
  /** Position in graph units (zoom-independent); the plugin mutates these on drag. */
  x: number
  y: number
  title: string
  inputs: node_graph_slot[]
  outputs: node_graph_slot[]
  /** Packed `0xAABBGGRR` header color override. */
  header_color?: number
}

/** A directed wire from an output slot to an input slot. */
export interface node_graph_connection {
  from_node: node_graph_id
  from_slot: number
  to_node: node_graph_id
  to_slot: number
  color?: number
}

/** A node template surfaced in the built-in right-click "add node" menu. */
export interface node_graph_template {
  /** Stable type key (also the default title). */
  type: string
  title?: string
  inputs?: node_graph_slot[]
  outputs?: node_graph_slot[]
  header_color?: number
}

export interface node_graph_options {
  /** Logical node width (graph units before zoom). Defaults to 124. */
  node_w?: number
  /** Logical title font size. Defaults to 7. */
  title_font_px?: number
  /** Logical slot label font size. Defaults to 5.6. */
  slot_font_px?: number
  /** Return false to forbid a wire between two slot types. Defaults to exact match. */
  compatible?: (output_type: string, input_type: string) => boolean
  /** Packed color for a slot of `type`. Defaults to a hashed hue per type. */
  slot_color?: (type: string, is_input: boolean) => number
  /** Packed color for a wire between two types. Defaults to a blended hue. */
  wire_color?: (output_type: string, input_type: string) => number
  /** Packed header color for a node. Defaults to a hashed hue per title. */
  header_color?: (node: node_graph_node) => number
  /** Templates offered by the built-in right-click menu. Omit to disable the menu. */
  node_types?: node_graph_template[]
}

type drag_state = { node_ids: node_graph_id[]; last_x: number; last_y: number }
type pan_state = { last_x: number; last_y: number; button: 'middle' | 'right'; moved: boolean }
type marquee_state = { start_x: number; start_y: number; cur_x: number; cur_y: number; base: node_graph_id[] }
type wire_draft = { node: node_graph_id; slot: number; is_output: boolean }
type menu_state = { screen_x: number; screen_y: number; graph_x: number; graph_y: number }

export interface node_graph_state {
  pan_x: number
  pan_y: number
  zoom: number
  selected: Set<node_graph_id>
  /** Auto-increment counter backing `add_node`'s default ids. */
  _next_id: number
  /** Internal transient interaction state. */
  _drag: drag_state | null
  _pan: pan_state | null
  _marquee: marquee_state | null
  _wire: wire_draft | null
  _menu: menu_state | null
}

export interface node_graph_event {
  /** The selection set changed this frame (click, marquee, or clear). */
  selection_changed?: boolean
  /** A node body was pressed (after the selection update). */
  node_pressed?: node_graph_id
  /** A wire was created and pushed onto the `connections` array. */
  connection_created?: node_graph_connection
  /** A wire creation was rejected because the slot types were incompatible. */
  connection_rejected?: { output_type: string; input_type: string }
  /** One or more nodes finished a move this frame. */
  nodes_moved?: boolean
  /** A node was spawned from the built-in create menu and pushed onto `nodes`. */
  node_created?: node_graph_node
  /** Delete/Backspace pressed with a non-empty selection. */
  delete_requested?: boolean
}

const UNIT = 0.52 // graph-units → px before zoom (position scale)
const HEADER_H = 18
const BODY_PAD = 8
const SLOT_ROW_H = 14
const DOT_STEP = 26 // logical px between dots before zoom
const MIN_ZOOM = 0.45
const MAX_ZOOM = 2.4
const MENU_ROW_H = 22
const MENU_W = 150

export function create_node_graph_state(): node_graph_state {
  return {
    pan_x: 0,
    pan_y: 0,
    zoom: 1,
    selected: new Set<node_graph_id>(),
    _next_id: 1,
    _drag: null,
    _pan: null,
    _marquee: null,
    _wire: null,
    _menu: null,
  }
}

/** Build a node with typed slots. Pass an explicit `id` or let the caller assign one. */
export function add_node(
  title: string,
  x: number,
  y: number,
  slots?: { id?: node_graph_id; inputs?: node_graph_slot[]; outputs?: node_graph_slot[]; header_color?: number },
): node_graph_node {
  return {
    id: slots?.id ?? title + ':' + Math.random().toString(36).slice(2, 8),
    x,
    y,
    title,
    inputs: slots?.inputs ? slots.inputs.slice() : [],
    outputs: slots?.outputs ? slots.outputs.slice() : [],
    header_color: slots?.header_color,
  }
}

/** Append a typed slot to a node, in place. Returns the node for chaining. */
export function add_slot(node: node_graph_node, is_input: boolean, slot: node_graph_slot): node_graph_node {
  ;(is_input ? node.inputs : node.outputs).push(slot)
  return node
}

export function node_graph(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  nodes: node_graph_node[],
  connections: node_graph_connection[],
  state: node_graph_state,
  options?: node_graph_options,
): node_graph_event {
  const scale = window.devicePixelRatio || 1
  const zoom = clamp(state.zoom || 1, MIN_ZOOM, MAX_ZOOM)
  state.zoom = zoom
  const node_w = options?.node_w ?? 124
  const title_font = (options?.title_font_px ?? 7) * scale * zoom
  const slot_font = (options?.slot_font_px ?? 5.6) * scale * zoom
  const compatible = options?.compatible ?? ((a: string, b: string) => a === b)
  const col = (slot: theme_slot) => pack(theme_color(theme, slot))

  const pos_scale = UNIT * zoom
  const gs = scale * zoom
  const origin_x = x + 24 * scale + state.pan_x * scale
  const origin_y = y + 18 * scale + state.pan_y * scale
  const event: node_graph_event = {}

  const by_id = new Map<node_graph_id, node_graph_node>()
  for (const node of nodes) by_id.set(node.id, node)

  // --- Layout helpers ----------------------------------------------------
  const node_screen = (node: node_graph_node) => ({ nx: origin_x + node.x * pos_scale, ny: origin_y + node.y * pos_scale })
  const node_h_px = (node: node_graph_node): number => {
    const rows = Math.max(node.inputs.length, node.outputs.length, 1)
    return (HEADER_H + BODY_PAD + rows * SLOT_ROW_H + BODY_PAD) * gs
  }
  const slot_cy = (ny: number, i: number) => ny + (HEADER_H + BODY_PAD + SLOT_ROW_H * (i + 0.5)) * gs
  const inside = input.mouse_x >= x && input.mouse_x < x + w && input.mouse_y >= y && input.mouse_y < y + h

  // --- Built-in create menu: it consumes input before the canvas ---------
  const menu_templates = options?.node_types ?? []
  let menu_consumed_press = false
  if (state._menu && menu_templates.length === 0) state._menu = null
  if (state._menu) {
    const mx = state._menu.screen_x
    const my = state._menu.screen_y
    const mw = MENU_W * scale
    const mh = menu_templates.length * MENU_ROW_H * scale
    const over = input.mouse_x >= mx && input.mouse_x < mx + mw && input.mouse_y >= my && input.mouse_y < my + mh
    if (input.mouse_pressed) {
      menu_consumed_press = true
      if (over) {
        const idx = Math.floor((input.mouse_y - my) / (MENU_ROW_H * scale))
        const tpl = menu_templates[idx]
        if (tpl) {
          const node = add_node(tpl.title ?? tpl.type, state._menu.graph_x, state._menu.graph_y, {
            id: state._next_id++,
            inputs: tpl.inputs,
            outputs: tpl.outputs,
            header_color: tpl.header_color,
          })
          nodes.push(node)
          by_id.set(node.id, node)
          event.node_created = node
        }
      }
      state._menu = null
    }
  }

  // --- Hit testing (topmost wins) ----------------------------------------
  const slot_r = Math.max(5, 8 * gs)
  let hit_node: node_graph_node | null = null
  let hit_slot: { node: node_graph_node; slot: number; is_output: boolean } | null = null
  if (!state._menu) {
    for (const node of nodes) {
      const { nx, ny } = node_screen(node)
      const nw = node_w * gs
      const nh = node_h_px(node)
      if (input.mouse_x >= nx && input.mouse_x < nx + nw && input.mouse_y >= ny && input.mouse_y < ny + nh) hit_node = node
      for (let i = 0; i < node.inputs.length; i += 1) {
        if (Math.hypot(input.mouse_x - nx, input.mouse_y - slot_cy(ny, i)) <= slot_r) hit_slot = { node, slot: i, is_output: false }
      }
      for (let i = 0; i < node.outputs.length; i += 1) {
        if (Math.hypot(input.mouse_x - (nx + nw), input.mouse_y - slot_cy(ny, i)) <= slot_r) hit_slot = { node, slot: i, is_output: true }
      }
    }
  }

  // --- Wheel zoom (anchored at cursor) -----------------------------------
  if (inside && !state._menu && input.wheel_y) {
    const gx = (input.mouse_x - origin_x) / pos_scale
    const gy = (input.mouse_y - origin_y) / pos_scale
    const next_zoom = clamp(zoom * (input.wheel_y > 0 ? 1.06 : 0.94), MIN_ZOOM, MAX_ZOOM)
    const next_pos = UNIT * next_zoom
    state.pan_x = (input.mouse_x - gx * next_pos - x - 24 * scale) / scale
    state.pan_y = (input.mouse_y - gy * next_pos - y - 18 * scale) / scale
    state.zoom = next_zoom
  }

  // --- Two-finger touch: pan + pinch zoom (anchored at the centroid) ------
  const pan_dx = input.pan_dx ?? 0
  const pan_dy = input.pan_dy ?? 0
  const pinch = input.zoom_factor ?? 1
  if (inside && !state._menu && (pan_dx || pan_dy || pinch !== 1)) {
    // Graph point under the centroid's previous position; keep it under the new one.
    const gx = (input.mouse_x - pan_dx - origin_x) / pos_scale
    const gy = (input.mouse_y - pan_dy - origin_y) / pos_scale
    const next_zoom = clamp(zoom * pinch, MIN_ZOOM, MAX_ZOOM)
    const next_pos = UNIT * next_zoom
    state.pan_x = (input.mouse_x - gx * next_pos - x - 24 * scale) / scale
    state.pan_y = (input.mouse_y - gy * next_pos - y - 18 * scale) / scale
    state.zoom = next_zoom
  }

  // --- Press: start an interaction ---------------------------------------
  // Right-drag pans; a right-click without a drag opens the create menu (below).
  if (inside && input.mouse_right_pressed && !state._pan && !state._wire && !state._drag && !state._marquee && !state._menu) {
    state._pan = { last_x: input.mouse_x, last_y: input.mouse_y, button: 'right', moved: false }
  }
  if (inside && input.mouse_pressed && !menu_consumed_press && !state._pan) {
    if (hit_slot) {
      state._wire = { node: hit_slot.node.id, slot: hit_slot.slot, is_output: hit_slot.is_output }
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
  if (inside && input.mouse_middle_down && !state._pan && !state._drag && !state._marquee && !state._wire) {
    state._pan = { last_x: input.mouse_x, last_y: input.mouse_y, button: 'middle', moved: false }
  }

  // --- Update active interactions ----------------------------------------
  if (state._pan) {
    const held = state._pan.button === 'right' ? !!input.mouse_right_down : !!input.mouse_middle_down
    if (held) {
      const dx = input.mouse_x - state._pan.last_x
      const dy = input.mouse_y - state._pan.last_y
      if (dx || dy) state._pan.moved = true
      state.pan_x += dx / scale
      state.pan_y += dy / scale
      state._pan.last_x = input.mouse_x
      state._pan.last_y = input.mouse_y
    } else {
      // A right-click that never dragged opens the create menu at the press point.
      if (state._pan.button === 'right' && !state._pan.moved && menu_templates.length > 0) {
        state._menu = {
          screen_x: Math.min(state._pan.last_x, x + w - MENU_W * scale),
          screen_y: Math.min(state._pan.last_y, y + h - menu_templates.length * MENU_ROW_H * scale),
          graph_x: (state._pan.last_x - origin_x) / pos_scale,
          graph_y: (state._pan.last_y - origin_y) / pos_scale,
        }
      }
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
        const { nx, ny } = node_screen(node)
        const nw = node_w * gs
        const nh = node_h_px(node)
        if (nx < r.x + r.w && nx + nw > r.x && ny < r.y + r.h && ny + nh > r.y) state.selected.add(node.id)
      }
      event.selection_changed = true
    } else {
      state._marquee = null
    }
  }

  // --- Release: commit the wire draft, type-gated -------------------------
  if (state._wire && !input.mouse_down) {
    const draft = state._wire
    if (hit_slot && hit_slot.is_output !== draft.is_output) {
      const out = draft.is_output ? draft : { node: hit_slot.node.id, slot: hit_slot.slot }
      const inp = draft.is_output ? { node: hit_slot.node.id, slot: hit_slot.slot } : draft
      const out_node = by_id.get(out.node)
      const in_node = by_id.get(inp.node)
      if (out_node && in_node && out.node !== inp.node) {
        const out_type = out_node.outputs[out.slot]?.type ?? ''
        const in_type = in_node.inputs[inp.slot]?.type ?? ''
        if (compatible(out_type, in_type)) {
          // One wire per input slot: drop any existing wire into this input.
          for (let i = connections.length - 1; i >= 0; i -= 1) {
            if (connections[i].to_node === inp.node && connections[i].to_slot === inp.slot) connections.splice(i, 1)
          }
          const conn: node_graph_connection = { from_node: out.node, from_slot: out.slot, to_node: inp.node, to_slot: inp.slot }
          connections.push(conn)
          event.connection_created = conn
        } else {
          event.connection_rejected = { output_type: out_type, input_type: in_type }
        }
      }
    }
    state._wire = null
  }

  // --- Keyboard: delete selection ----------------------------------------
  if (inside && !state._menu && (input.key_delete || input.key_backspace) && state.selected.size > 0) {
    event.delete_requested = true
  }

  // --- Cursor ------------------------------------------------------------
  if (state._pan) ui.set_cursor('grabbing')
  else if (state._wire || hit_slot) ui.set_cursor('crosshair')
  else if (state._drag) ui.set_cursor('move')

  // === Draw ==============================================================
  ui.push_clip(x, y, w, h)
  ui.fill_rect(x, y, w, h, col('panel_alt'))
  draw_dots(ui, theme, x, y, w, h, origin_x, origin_y, scale, zoom)

  // Committed wires (under the nodes).
  for (const conn of connections) {
    const src = by_id.get(conn.from_node)
    const dst = by_id.get(conn.to_node)
    if (!src || !dst) continue
    const so = src.outputs[conn.from_slot]
    const di = dst.inputs[conn.to_slot]
    if (!so || !di) continue
    const s = node_screen(src)
    const d = node_screen(dst)
    const color = conn.color ?? options?.wire_color?.(so.type, di.type) ?? blended_wire_color(so.type, di.type)
    draw_bezier(ui, s.nx + node_w * gs, slot_cy(s.ny, conn.from_slot), d.nx, slot_cy(d.ny, conn.to_slot), Math.max(2, 2 * gs), color, gs)
  }

  // Wire draft following the cursor.
  if (state._wire) {
    const src = by_id.get(state._wire.node)
    if (src) {
      const slot = state._wire.is_output ? src.outputs[state._wire.slot] : src.inputs[state._wire.slot]
      if (slot) {
        const s = node_screen(src)
        const sx = state._wire.is_output ? s.nx + node_w * gs : s.nx
        const sy = slot_cy(s.ny, state._wire.slot)
        const color = slot.color ?? options?.slot_color?.(slot.type, !state._wire.is_output) ?? slot_hue_color(slot.type, !state._wire.is_output)
        if (state._wire.is_output) draw_bezier(ui, sx, sy, input.mouse_x, input.mouse_y, Math.max(2, 2 * gs), color, gs)
        else draw_bezier(ui, input.mouse_x, input.mouse_y, sx, sy, Math.max(2, 2 * gs), color, gs)
      }
    }
  }

  // Nodes.
  for (const node of nodes) {
    const { nx, ny } = node_screen(node)
    const nw = node_w * gs
    const nh = node_h_px(node)
    const selected = state.selected.has(node.id)
    if (selected) ui.stroke_round_rect(nx - 3 * scale, ny - 3 * scale, nw + 6 * scale, nh + 6 * scale, 4 * scale, 2 * scale, col('accent'))
    ui.fill_round_rect(nx, ny, nw, nh, 4 * scale, col('panel'))
    ui.fill_round_rect_per_corner(nx, ny, nw, HEADER_H * gs, 4 * scale, 4 * scale, 0, 0, node.header_color ?? options?.header_color?.(node) ?? title_hue_color(node.title))
    ui.stroke_round_rect(nx, ny, nw, nh, 4 * scale, 1, col('border'))
    ui.push_clip(nx, ny, nw, HEADER_H * gs)
    ui.draw_text(nx + 8 * gs, ui.text_v_center_y(ny + 2 * gs, HEADER_H * gs - 3 * gs, title_font), node.title, title_font, col('text'))
    ui.pop_clip()

    const slot_size = Math.max(3, 6 * gs)
    for (let i = 0; i < node.inputs.length; i += 1) {
      const slot = node.inputs[i]
      const cy = slot_cy(ny, i)
      ui.fill_circle(nx, cy, slot_size * 0.5, slot.color ?? options?.slot_color?.(slot.type, true) ?? slot_hue_color(slot.type, true))
      ui.draw_text(nx + 9 * gs, ui.text_v_center_y(cy - 6 * gs, 12 * gs, slot_font), slot.label, slot_font, col('text_dim'))
    }
    for (let i = 0; i < node.outputs.length; i += 1) {
      const slot = node.outputs[i]
      const cy = slot_cy(ny, i)
      const lw = ui.text_width(slot.label, slot_font)
      ui.draw_text(nx + nw - lw - 10 * gs, ui.text_v_center_y(cy - 6 * gs, 12 * gs, slot_font), slot.label, slot_font, col('text_dim'))
      ui.fill_circle(nx + nw, cy, slot_size * 0.5, slot.color ?? options?.slot_color?.(slot.type, false) ?? slot_hue_color(slot.type, false))
    }
  }

  // Marquee box.
  if (state._marquee) {
    const r = norm_rect(state._marquee.start_x, state._marquee.start_y, state._marquee.cur_x, state._marquee.cur_y)
    ui.fill_rect(r.x, r.y, r.w, r.h, with_alpha(col('accent'), 40))
    ui.stroke_rect(r.x, r.y, r.w, r.h, 1.5 * scale, col('accent'))
  }

  // Create menu on top of everything.
  if (state._menu) {
    const mx = state._menu.screen_x
    const my = state._menu.screen_y
    const mw = MENU_W * scale
    const mh = menu_templates.length * MENU_ROW_H * scale
    const row_h = MENU_ROW_H * scale
    const font = 6.4 * scale
    ui.fill_round_rect(mx, my, mw, mh, 4 * scale, col('panel'))
    ui.stroke_round_rect(mx, my, mw, mh, 4 * scale, 1, col('border'))
    for (let i = 0; i < menu_templates.length; i += 1) {
      const ry = my + i * row_h
      const hovered = input.mouse_x >= mx && input.mouse_x < mx + mw && input.mouse_y >= ry && input.mouse_y < ry + row_h
      if (hovered) ui.fill_rect(mx + 1 * scale, ry, mw - 2 * scale, row_h, with_alpha(col('accent'), 48))
      ui.draw_text(mx + 10 * scale, ui.text_v_center_y(ry, row_h, font), menu_templates[i].title ?? menu_templates[i].type, font, col('text'))
    }
  }

  ui.pop_clip()

  return event
}

// --- internals -----------------------------------------------------------

function draw_dots(
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
  const step = DOT_STEP * scale * zoom
  if (step < 6) return // too dense to be legible — skip the field when far out
  const dot = pack(theme_color(theme, 'track'))
  const dot_major = pack(theme_color(theme, 'border'))
  const r = Math.max(1, 1.1 * scale * zoom)
  // First dot column/row at or after the visible edge, in phase with the origin.
  const start_x = gx + (((origin_x - gx) % step) + step) % step
  const start_y = gy + (((origin_y - gy) % step) + step) % step
  // Integer grid index of the first dot, so every 4th line gets a brighter dot.
  let col_i = Math.round((start_x - origin_x) / step)
  for (let px = start_x; px < gx + gw; px += step, col_i += 1) {
    let row_i = Math.round((start_y - origin_y) / step)
    for (let py = start_y; py < gy + gh; py += step, row_i += 1) {
      const major = col_i % 4 === 0 && row_i % 4 === 0
      ui.fill_circle(px, py, major ? r + 0.4 * scale : r, major ? dot_major : dot)
    }
  }
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

function slot_hue_color(type: string, is_input: boolean): number {
  return hsv_color(hash_hue(type) + (is_input ? -10 : 10), 0.52, 0.84)
}

function blended_wire_color(src_type: string, dst_type: string): number {
  return hsv_color((hash_hue(src_type) * 0.7 + hash_hue(dst_type) * 0.3 + 360) % 360, 0.58, 0.9)
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
