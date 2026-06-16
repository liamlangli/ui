// hori_split_view — shared left/right split-pane layout.
//
// Computes a horizontal split with a narrow visible separator and a wider
// invisible resize hit target. Callers draw their pane contents into the
// returned rects.

import type { ui_renderer } from '../../core/ui_renderer'
import type { ui_input_snapshot } from '../../core/ui_widgets'

export interface hori_split_view_state {
  left_w?: number
  ratio?: number
  dragging?: boolean
}

export interface hori_split_view_rect {
  x: number
  y: number
  w: number
  h: number
}

export interface hori_split_view_result {
  left: hori_split_view_rect
  separator: hori_split_view_rect
  right: hori_split_view_rect
}

export interface hori_split_view_options {
  show_left?: boolean
  min_left: number
  min_right: number
  initial_left_w?: number
  initial_ratio?: number
  sizing?: 'pixels' | 'ratio'
  separator_w?: number
  hit_pad?: number
  separator_color?: number
}

export function hori_split_view(
  ui: ui_renderer,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  state: hori_split_view_state,
  options: hori_split_view_options,
): hori_split_view_result {
  const show_left = options.show_left !== false
  if (!show_left) {
    return {
      left: { x, y, w: 0, h },
      separator: { x, y, w: 0, h },
      right: { x, y, w, h },
    }
  }

  const separator_w = options.separator_w ?? 1
  const hit_pad = options.hit_pad ?? 2
  const avail_w = Math.max(0, w - separator_w)
  const min_left = Math.max(0, Math.min(options.min_left, avail_w))
  const min_right = Math.max(0, Math.min(options.min_right, avail_w))
  const max_left = Math.max(min_left, avail_w - min_right)

  const sizing = options.sizing ?? 'pixels'
  let left_w = sizing === 'ratio' && Number.isFinite(state.ratio) ? avail_w * state.ratio! : state.left_w
  if (!Number.isFinite(left_w)) {
    left_w = Number.isFinite(state.ratio)
      ? avail_w * state.ratio!
      : options.initial_left_w ?? avail_w * (options.initial_ratio ?? 0.32)
  }
  left_w = clamp(left_w!, min_left, max_left)

  const sep_x = x + left_w
  const over_separator = point_in(input, sep_x - hit_pad, y, separator_w + hit_pad * 2, h)
  if (over_separator || state.dragging) ui.set_cursor('col-resize')
  if (over_separator && input.mouse_pressed) state.dragging = true
  if (!input.mouse_down) state.dragging = false
  if (state.dragging) left_w = clamp(input.mouse_x - x, min_left, max_left)

  state.left_w = sizing === 'ratio' ? undefined : left_w
  state.ratio = avail_w > 0 ? left_w / avail_w : 0

  const left = { x, y, w: left_w, h }
  const separator = { x: x + left_w, y, w: separator_w, h }
  const right = { x: separator.x + separator_w, y, w: Math.max(0, x + w - separator.x - separator_w), h }
  if (options.separator_color != null) ui.fill_rect(separator.x, separator.y, Math.max(1, separator.w), separator.h, options.separator_color)
  return { left, separator, right }
}

function point_in(input: ui_input_snapshot, x: number, y: number, w: number, h: number): boolean {
  return input.mouse_x >= x && input.mouse_y >= y && input.mouse_x < x + w && input.mouse_y < y + h
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
