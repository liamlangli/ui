// dock_system — a ready-to-use docking workspace plugin.
//
// The core `dock` module (../dock) is intentionally pure: it owns the layout
// tree, frame geometry and drop resolution, but draws nothing and listens to no
// input. This plugin is the missing glue: it renders the tab bars, splitters,
// drag ghost and drop overlay through `ui_renderer`, drives tab activation /
// drag-to-move / drag-to-split / splitter-resize from an `ui_input_snapshot`,
// and hands each visible panel body back to the host to fill.
//
// Usage (once per frame, inside begin_frame()/flush()):
//
//   dock.frame(ui, input, x, y, w, h, (panel) => {
//     // panel.{x,y,w,h} is the clipped body rect (physical px)
//     if (panel.tab.id === 'files') file_browser(ui, widgets, ...)
//   })

import { theme_color } from '../theme'
import type { theme_definition, dock_layout, dock_tab } from '../types'
import { ui_renderer } from '../ui_renderer'
import type { ui_input_snapshot } from '../ui_widgets'
import {
  compute_dock_frame,
  create_default_dock_layout,
  dock_drag_start_d,
  resolve_dock_drop,
  set_dock_split_ratio,
  activate_dock_tab,
  move_dock_tab,
  split_dock_tab,
  close_dock_tab,
  spawn_dock_tab,
  tab_width,
  type dock_drag_state,
  type dock_frame_leaf,
} from '../dock'

export interface dock_system_options {
  /** Logical tab-label font size (scaled by devicePixelRatio). Defaults to 12.5. */
  font_px?: number
  /** Show a × close affordance on the active tab. Defaults to true. */
  closable?: boolean
}

/** A visible panel body the host is expected to render into, in physical px. */
export interface dock_panel {
  leaf_id: string
  tab: dock_tab
  x: number
  y: number
  w: number
  h: number
}

export type dock_render_body = (panel: dock_panel) => void

function fresh_drag(): dock_drag_state {
  return {
    armed: false,
    active: false,
    source_leaf_id: null,
    source_tab_id: null,
    source_tab_index: -1,
    source_tab_width: 0,
    start_x: 0,
    start_y: 0,
    grab_dx: 0,
    target_leaf_id: null,
    target_tab_index: -1,
    drop_kind: 'none',
  }
}

export function create_dock_drag_state(): dock_drag_state {
  return fresh_drag()
}

/**
 * Stateful docking workspace. Owns a `dock_layout` plus the transient
 * drag/resize state, so the host only needs to call {@link frame} each frame.
 */
export class dock_system {
  layout: dock_layout
  readonly drag: dock_drag_state = fresh_drag()
  private dragging_split_id: string | null = null
  private split_grab_offset = 0

  constructor(layout?: dock_layout) {
    this.layout = layout ?? create_default_dock_layout()
  }

  /** Spawn or focus a tab in the most-recently-active leaf. */
  add_tab(tab: dock_tab): boolean {
    return spawn_dock_tab(this.layout, tab)
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
    options?: dock_system_options,
  ): void {
    const scale = window.devicePixelRatio || 1
    const font_px = (options?.font_px ?? 12.5) * scale
    const closable = options?.closable ?? true
    const measure = (title: string) => ui.text_width(title, font_px)

    const frame = compute_dock_frame(this.layout.root, x, y, w, h, scale)
    const col = (slot: Parameters<typeof theme_color>[1]) => pack(theme_color(theme, slot))
    let cursor_split_axis: 'horizontal' | 'vertical' | null = null

    // --- Splitter resize ---------------------------------------------------
    if (!input.mouse_down) {
      this.dragging_split_id = null
    }
    if (this.dragging_split_id) {
      const split = frame.splits.find((s) => s.split_id === this.dragging_split_id)
      if (split) {
        cursor_split_axis = split.axis
        const ratio =
          split.axis === 'horizontal'
            ? (input.mouse_x - split.parent_x - this.split_grab_offset) / Math.max(1, split.parent_w)
            : (input.mouse_y - split.parent_y - this.split_grab_offset) / Math.max(1, split.parent_h)
        set_dock_split_ratio(this.layout, this.dragging_split_id, ratio)
      }
    } else if (input.mouse_pressed && !this.drag.active) {
      for (const split of frame.splits) {
        if (point_in(input, split.x, split.y, split.w, split.h)) {
          this.dragging_split_id = split.split_id
          cursor_split_axis = split.axis
          this.split_grab_offset =
            split.axis === 'horizontal' ? input.mouse_x - split.x : input.mouse_y - split.y
          break
        }
      }
    }
    if (!cursor_split_axis && !this.drag.active) {
      cursor_split_axis = frame.splits.find((split) => point_in(input, split.x, split.y, split.w, split.h))?.axis ?? null
    }
    ui.set_cursor(cursor_split_axis === 'horizontal' ? 'col-resize' : cursor_split_axis === 'vertical' ? 'row-resize' : null)

    // --- Panels ------------------------------------------------------------
    for (const leaf of frame.leaves) {
      this.draw_leaf(ui, input, leaf, font_px, scale, closable, col, render_body, measure)
    }

    // --- Splitter chrome (drawn above panels) ------------------------------
    for (const split of frame.splits) {
      const hot =
        this.dragging_split_id === split.split_id ||
        (!this.drag.active && point_in(input, split.x, split.y, split.w, split.h))
      const t = Math.max(1 * scale, Math.min(split.w, split.h) * 0.18)
      if (split.axis === 'horizontal') {
        ui.fill_rect(split.x + split.w * 0.5 - t * 0.5, split.y, t, split.h, hot ? col('accent') : col('border'))
      } else {
        ui.fill_rect(split.x, split.y + split.h * 0.5 - t * 0.5, split.w, t, hot ? col('accent') : col('border'))
      }
    }

    // --- Tab drag / drop ---------------------------------------------------
    this.update_tab_drag(ui, input, frame, scale, font_px, col, measure)
  }

  private draw_leaf(
    ui: ui_renderer,
    input: ui_input_snapshot,
    leaf: dock_frame_leaf,
    font_px: number,
    scale: number,
    closable: boolean,
    col: (slot: Parameters<typeof theme_color>[1]) => number,
    render_body: dock_render_body,
    measure: (title: string) => number,
  ): void {
    const bar_h = leaf.tab_bar_h
    const radius = 3 * scale
    // Panel background + tab strip.
    ui.fill_round_rect(leaf.x, leaf.y, leaf.w, leaf.h, radius, col('panel'))
    ui.fill_round_rect_per_corner(leaf.x, leaf.y, leaf.w, bar_h, radius, radius, 0, 0, col('panel_alt'))
    ui.fill_rect(leaf.x, leaf.y + bar_h - 1 * scale, leaf.w, 1 * scale, col('border'))

    let cursor = leaf.x + 4 * scale
    const gap = 4 * scale
    for (let i = 0; i < leaf.tabs.length; i += 1) {
      const tab = leaf.tabs[i]
      const tw = tab_width(tab.title, scale, measure(tab.title))
      const active = tab.id === leaf.active_tab_id
      const hover = point_in(input, cursor, leaf.y, tw, bar_h)
      if (active) {
        ui.fill_round_rect_per_corner(cursor, leaf.y, tw, bar_h, radius, radius, 0, 0, col('panel'))
        const ind_pad = 3 * scale
        const ind_h = 2 * scale
        ui.fill_round_rect(cursor + ind_pad, leaf.y + ind_pad, Math.max(0, tw - ind_pad * 2), ind_h, ind_h * 0.5, col('accent'))
      } else if (hover) {
        ui.fill_round_rect_per_corner(cursor, leaf.y, tw, bar_h, radius, radius, 0, 0, col('hover'))
      }
      const label_color = active ? col('text') : col('text_dim')
      const close_w = closable && active ? 16 * scale : 0
      const label_y = ui.text_v_center_y(leaf.y, bar_h, font_px) + 2 * scale
      ui.push_clip(cursor, leaf.y, tw - close_w, bar_h)
      ui.draw_text(cursor + 10 * scale, label_y, tab.title, font_px, label_color)
      const label_cy = leaf.y + bar_h * 0.5 + 2 * scale
      if (tab.dirty) ui.fill_circle(cursor + 10 * scale + measure(tab.title) + 6 * scale, label_cy, 2.5 * scale, col('accent'))
      ui.pop_clip()

      // Activate on press; arm a drag.
      if (hover && input.mouse_pressed && !this.drag.armed && !this.drag.active) {
        activate_dock_tab(this.layout, leaf.leaf_id, tab.id)
        this.drag.armed = true
        this.drag.source_leaf_id = leaf.leaf_id
        this.drag.source_tab_id = tab.id
        this.drag.source_tab_index = i
        this.drag.source_tab_width = tw
        this.drag.start_x = input.mouse_x
        this.drag.start_y = input.mouse_y
        this.drag.grab_dx = input.mouse_x - cursor
      }

      // Close affordance.
      if (close_w > 0) {
        const cx = cursor + tw - 13 * scale
        const cy = label_cy
        const close_hover = point_in(input, cx - 7 * scale, cy - 7 * scale, 14 * scale, 14 * scale)
        if (close_hover) ui.fill_circle(cx, cy, 8 * scale, col('hover'))
        const r = 3.2 * scale
        const cc = close_hover ? col('text') : col('text_dim')
        ui.stroke_line(cx - r, cy - r, cx + r, cy + r, 1.3 * scale, cc)
        ui.stroke_line(cx - r, cy + r, cx + r, cy - r, 1.3 * scale, cc)
        if (close_hover && input.mouse_pressed) {
          close_dock_tab(this.layout, leaf.leaf_id, tab.id)
          this.drag.armed = false
        }
      }
      cursor += tw + gap
    }

    // Body.
    const body_x = leaf.x
    const body_y = leaf.y + bar_h
    const body_w = leaf.w
    const body_h = leaf.h - bar_h
    const active_tab = leaf.tabs.find((t) => t.id === leaf.active_tab_id)
    if (active_tab && body_h > 0) {
      ui.push_clip(body_x, body_y, body_w, body_h)
      render_body({ leaf_id: leaf.leaf_id, tab: active_tab, x: body_x, y: body_y, w: body_w, h: body_h })
      ui.pop_clip()
    }
  }

  private update_tab_drag(
    ui: ui_renderer,
    input: ui_input_snapshot,
    frame: ReturnType<typeof compute_dock_frame>,
    scale: number,
    font_px: number,
    col: (slot: Parameters<typeof theme_color>[1]) => number,
    measure: (title: string) => number,
  ): void {
    const drag = this.drag
    if (!drag.armed && !drag.active) return

    if (!input.mouse_down) {
      // Release: commit the drop.
      if (drag.active && drag.source_leaf_id && drag.source_tab_id && drag.target_leaf_id) {
        if (drag.drop_kind === 'tabbar') {
          move_dock_tab(this.layout, drag.source_leaf_id, drag.source_tab_id, drag.target_leaf_id, drag.target_tab_index)
        } else if (drag.drop_kind !== 'none') {
          split_dock_tab(this.layout, drag.source_leaf_id, drag.source_tab_id, drag.target_leaf_id, drag.drop_kind)
        }
      }
      Object.assign(drag, fresh_drag())
      return
    }

    // Promote armed → active once past the threshold.
    if (drag.armed && !drag.active) {
      const moved = Math.hypot(input.mouse_x - drag.start_x, input.mouse_y - drag.start_y)
      if (moved >= dock_drag_start_d * scale) drag.active = true
    }
    if (!drag.active) return

    const drop = resolve_dock_drop(frame, input.mouse_x, input.mouse_y, scale, measure)
    drag.target_leaf_id = drop.target_leaf_id
    drag.target_tab_index = drop.target_tab_index
    drag.drop_kind = drop.drop_kind

    // Drop overlay.
    const target = frame.leaves.find((l) => l.leaf_id === drop.target_leaf_id)
    if (target && drop.drop_kind !== 'none') {
      const bar_h = target.tab_bar_h
      const bx = target.x
      const by = target.y + bar_h
      const bw = target.w
      const bh = target.h - bar_h
      const overlay = col('accent')
      const a = with_alpha(overlay, 70)
      switch (drop.drop_kind) {
        case 'tabbar':
          ui.fill_rect(target.x, target.y, target.w, bar_h, a)
          break
        case 'split-left':
          ui.fill_rect(bx, by, bw * 0.5, bh, a)
          break
        case 'split-right':
          ui.fill_rect(bx + bw * 0.5, by, bw * 0.5, bh, a)
          break
        case 'split-top':
          ui.fill_rect(bx, by, bw, bh * 0.5, a)
          break
        case 'split-bottom':
          ui.fill_rect(bx, by + bh * 0.5, bw, bh * 0.5, a)
          break
      }
      ui.stroke_rect(bx, by, bw, bh, 1.5 * scale, overlay)
    }

    // Floating tab ghost following the cursor.
    if (drag.source_tab_id) {
      const title = find_tab_title(frame, drag.source_leaf_id, drag.source_tab_id) ?? drag.source_tab_id
      const gw = drag.source_tab_width || tab_width(title, scale, measure(title))
      const gh = (frame.leaves[0]?.tab_bar_h ?? 27 * scale)
      const gx = input.mouse_x - drag.grab_dx
      const gy = input.mouse_y - gh * 0.5
      ui.fill_round_rect(gx, gy, gw, gh, 4 * scale, with_alpha(col('selected'), 235))
      ui.stroke_round_rect(gx, gy, gw, gh, 4 * scale, 1, col('accent'))
      ui.draw_text(gx + 10 * scale, ui.text_v_center_y(gy, gh, font_px), title, font_px, col('text'))
    }
  }
}

function find_tab_title(
  frame: ReturnType<typeof compute_dock_frame>,
  leaf_id: string | null,
  tab_id: string,
): string | null {
  for (const leaf of frame.leaves) {
    if (leaf_id && leaf.leaf_id !== leaf_id) continue
    const tab = leaf.tabs.find((t) => t.id === tab_id)
    if (tab) return tab.title
  }
  return null
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
