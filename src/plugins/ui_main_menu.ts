// ui_main_menu — a top, multi-level (cascading) menu-bar plugin.
//
// `ui_multi_drop_menu` is the reusable immediate-mode widget: a horizontal menu
// bar whose top items drop down into columns that can nest arbitrarily deep —
// sub-menus fly out to the right, classic desktop-app style. It draws through
// `ui_renderer`, drives open/close + activation from an `ui_input_snapshot`, and
// reports the activated leaf back to the host.
//
// `ui_main_menu` is the thin stateful wrapper the host instantiates once and
// drives each frame (it owns the menu tree + the open-state), mirroring how
// `dock_system` packages the pure dock engine.

import { theme_color } from '../theme'
import type { theme_definition } from '../types'
import { ui_renderer } from '../ui_renderer'
import type { ui_input_snapshot } from '../ui_widgets'

/** A node in the menu tree. A node with `children` is a sub-menu, otherwise a leaf. */
export interface ui_menu_node {
  /** Stable id reported on activation. Leaves usually carry one; containers may omit it. */
  id?: string
  /** Text shown in the bar / dropdown row. */
  label: string
  /** Optional leading glyph/emoji drawn before the label. */
  icon?: string
  /** Render a thin divider instead of a clickable row (dropdowns only). */
  separator?: boolean
  /** Grey the row out and block activation / sub-menu opening. */
  disabled?: boolean
  /** Draw a ✓ in the gutter (for toggle-style items). */
  checked?: boolean
  /** Nested sub-menu; its presence turns the row into a fly-out parent. */
  children?: ui_menu_node[]
}

export interface ui_menu_rect {
  x: number
  y: number
  w: number
  h: number
}

export interface ui_multi_drop_menu_state {
  /** Indices describing the currently-open chain (`[]` when closed). `open_path[0]` is the bar item. */
  open_path: number[]
  /** Bar + open-dropdown rects from this frame; hosts use them to mask input drawn underneath. */
  hit_rects: ui_menu_rect[]
}

export function create_ui_multi_drop_menu_state(): ui_multi_drop_menu_state {
  return { open_path: [], hit_rects: [] }
}

export interface ui_multi_drop_menu_options {
  /** Logical font size (scaled by devicePixelRatio). Defaults to 13. */
  font_px?: number
  /** Logical dropdown row height. Defaults to 24. */
  item_h?: number
  /** Logical minimum dropdown column width. Defaults to 168. */
  min_menu_w?: number
  /** Logical gap between bar items. Defaults to 2. */
  bar_gap?: number
}

export interface ui_multi_drop_menu_event {
  /** A leaf (childless, enabled) item was clicked this frame. */
  activated?: ui_menu_node
  /** Index path from the menu roots to the activated leaf. */
  path?: number[]
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

function node_label(node: ui_menu_node): string {
  return node.icon ? `${node.icon} ${node.label}` : node.label
}

function column_width(ui: ui_renderer, nodes: ui_menu_node[], font_px: number, row_pad: number, scale: number, min_w: number): number {
  let max_text = 0
  for (const node of nodes) {
    if (node.separator) continue
    max_text = Math.max(max_text, ui.text_width(node_label(node), font_px))
  }
  const check_w = 16 * scale
  const arrow_w = 18 * scale
  return Math.max(min_w, Math.ceil(max_text + row_pad * 2 + check_w + arrow_w))
}

/**
 * Top multi-level menu bar. Renders a horizontal bar of menus at `(x,y,w,h)`;
 * open menus cascade downward (and sub-menus fly out to the right), overlaying
 * whatever sits below. Call once per frame and dispatch the returned event.
 */
export function ui_multi_drop_menu(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  menus: ui_menu_node[],
  state: ui_multi_drop_menu_state,
  options?: ui_multi_drop_menu_options,
): ui_multi_drop_menu_event {
  const scale = window.devicePixelRatio || 1
  const font_px = (options?.font_px ?? 13) * scale
  const item_h = (options?.item_h ?? 24) * scale
  const min_menu_w = (options?.min_menu_w ?? 168) * scale
  const bar_gap = (options?.bar_gap ?? 2) * scale
  const pad = 10 * scale // bar item horizontal padding
  const row_pad = 10 * scale // dropdown row horizontal padding
  const sep_h = 7 * scale
  const pp = 4 * scale // dropdown panel inner padding
  const radius = 4 * scale
  const col = (slot: Parameters<typeof theme_color>[1]) => pack(theme_color(theme, slot))
  const { width: canvas_w, height: canvas_h } = ui.canvas_size()

  const event: ui_multi_drop_menu_event = {}
  const hit_rects: ui_menu_rect[] = [{ x, y, w, h }]
  let pressed_inside = false

  // --- Menu bar -----------------------------------------------------------
  ui.fill_round_rect(x, y, w, h, radius, col('panel_alt'))
  ui.stroke_round_rect(x, y, w, h, radius, 1, col('border'))

  const bar_x: number[] = []
  const bar_w: number[] = []
  let bx = x + 4 * scale
  for (let i = 0; i < menus.length; i += 1) {
    const node = menus[i]!
    const item_w = ui.text_width(node_label(node), font_px) + pad * 2
    bar_x[i] = bx
    bar_w[i] = item_w
    const hover = point_in(input, bx, y, item_w, h)
    const has_kids = !!node.children?.length
    if (hover && input.mouse_pressed) {
      pressed_inside = true
      if (node.disabled) {
        // ignore
      } else if (has_kids) {
        state.open_path = state.open_path[0] === i && state.open_path.length > 0 ? [] : [i]
      } else {
        event.activated = node
        event.path = [i]
        state.open_path = []
      }
    } else if (state.open_path.length > 0 && hover && state.open_path[0] !== i && has_kids && !node.disabled) {
      state.open_path = [i]
    }
    const is_open = state.open_path.length > 0 && state.open_path[0] === i
    if (is_open) {
      ui.fill_round_rect_per_corner(bx, y + 2 * scale, item_w, h - 2 * scale, 3 * scale, 3 * scale, 0, 0, col('active'))
    } else if (hover && !node.disabled) {
      ui.fill_round_rect_per_corner(bx, y + 2 * scale, item_w, h - 2 * scale, 3 * scale, 3 * scale, 0, 0, col('hover'))
    }
    ui.draw_text(bx + pad, ui.text_v_center_y(y, h, font_px), node_label(node), font_px, node.disabled ? col('text_dim') : col('text'))
    bx += item_w + bar_gap
  }

  // --- Cascading dropdown columns ----------------------------------------
  if (state.open_path.length > 0) {
    let chain = menus
    let parent_index = state.open_path[0]!
    let col_left = bar_x[parent_index] ?? x
    let col_top = y + h
    let level = 1

    while (true) {
      const parent = chain[parent_index]
      const nodes = parent?.children
      if (!nodes || nodes.length === 0) break

      // Geometry — size the column, then keep it on-screen.
      const cw = column_width(ui, nodes, font_px, row_pad, scale, min_menu_w)
      const ch = pp * 2 + nodes.reduce((acc, n) => acc + (n.separator ? sep_h : item_h), 0)
      let panel_x = col_left
      let panel_y = col_top
      if (panel_x + cw > canvas_w) {
        panel_x = level === 1 ? bar_x[parent_index]! + bar_w[parent_index]! - cw : col_left - cw
      }
      panel_x = Math.max(0, Math.min(canvas_w - cw, panel_x))
      if (panel_y + ch > canvas_h) panel_y = Math.max(0, canvas_h - ch)

      hit_rects.push({ x: panel_x, y: panel_y, w: cw, h: ch })
      if (input.mouse_pressed && point_in(input, panel_x, panel_y, cw, ch)) pressed_inside = true

      // Pass 1 — row geometry + hover + activation.
      const row_top: number[] = []
      let hover_index = -1
      let ry = panel_y + pp
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i]!
        row_top[i] = ry
        if (node.separator) {
          ry += sep_h
          continue
        }
        if (!node.disabled && point_in(input, panel_x + pp, ry, cw - pp * 2, item_h)) hover_index = i
        ry += item_h
      }

      const prev_open = state.open_path[level]
      let next_open: number | null = null
      if (hover_index >= 0) {
        const hn = nodes[hover_index]!
        if (hn.children?.length) next_open = hover_index
      } else if (prev_open != null && nodes[prev_open]?.children?.length) {
        next_open = prev_open
      }
      // Commit this column's open child to the path.
      state.open_path = state.open_path.slice(0, level)
      if (next_open != null) state.open_path[level] = next_open

      // Activate a hovered leaf on click.
      if (hover_index >= 0) {
        const hn = nodes[hover_index]!
        if (!hn.children?.length && !hn.disabled && (input.mouse_pressed || input.mouse_released)) {
          event.activated = hn
          event.path = [...state.open_path.slice(0, level), hover_index]
          state.open_path = []
          next_open = null
        }
      }

      // Pass 2 — draw the panel and its rows.
      ui.fill_round_rect(panel_x, panel_y, cw, ch, radius, col('panel'))
      ui.stroke_round_rect(panel_x, panel_y, cw, ch, radius, 1, col('border'))
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i]!
        const rty = row_top[i]!
        if (node.separator) {
          ui.fill_rect(panel_x + row_pad, rty + sep_h * 0.5, cw - row_pad * 2, 1 * scale, col('border'))
          continue
        }
        const hot = hover_index === i
        const open_hl = next_open === i
        if (hot || open_hl) {
          ui.fill_round_rect(panel_x + pp, rty, cw - pp * 2, item_h, Math.max(0, radius - 1), open_hl && !hot ? col('selected') : col('hover'))
        }
        const text_color = node.disabled ? col('text_dim') : col('text')
        if (node.checked) ui.draw_text(panel_x + row_pad, ui.text_v_center_y(rty, item_h, font_px), '✓', font_px, col('accent'))
        ui.draw_text(panel_x + row_pad + 16 * scale, ui.text_v_center_y(rty, item_h, font_px), node_label(node), font_px, text_color)
        if (node.children?.length) {
          const ax = panel_x + cw - 13 * scale
          const acy = rty + item_h * 0.5
          const a = 3.2 * scale
          ui.fill_triangle(ax, acy - a, ax, acy + a, ax + a, acy, text_color)
        }
      }

      // Descend into the open sub-menu, if any.
      if (next_open == null) break
      const open_child = nodes[next_open]
      if (!open_child?.children?.length) break
      chain = nodes
      parent_index = next_open
      col_left = panel_x + cw - 2 * scale
      col_top = row_top[next_open]! - pp
      level += 1
    }
  }

  if (input.key_escape && state.open_path.length > 0) state.open_path = []
  if (input.mouse_pressed && !pressed_inside) state.open_path = []
  state.hit_rects = hit_rects
  return event
}

/**
 * Stateful top menu-bar plugin. Owns the menu tree plus the open-state, so the
 * host only calls {@link frame} each frame and dispatches the returned event.
 */
export class ui_main_menu {
  menus: ui_menu_node[]
  readonly state: ui_multi_drop_menu_state = create_ui_multi_drop_menu_state()

  constructor(menus: ui_menu_node[] = []) {
    this.menus = menus
  }

  /** True while a dropdown is open. */
  get is_open(): boolean {
    return this.state.open_path.length > 0
  }

  /**
   * True if `(mx,my)` lands on the bar or an open dropdown. Hosts use this to
   * mask input from whatever is drawn beneath the menu (the menu renders on top,
   * so this reads the previous frame's geometry — the usual IM occlusion trick).
   */
  blocks_point(mx: number, my: number): boolean {
    for (const r of this.state.hit_rects) {
      if (mx >= r.x && my >= r.y && mx < r.x + r.w && my < r.y + r.h) return true
    }
    return false
  }

  frame(
    ui: ui_renderer,
    theme: theme_definition,
    input: ui_input_snapshot,
    x: number,
    y: number,
    w: number,
    h: number,
    options?: ui_multi_drop_menu_options,
  ): ui_multi_drop_menu_event {
    return ui_multi_drop_menu(ui, theme, input, x, y, w, h, this.menus, this.state, options)
  }
}
