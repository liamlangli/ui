// file_browser — an immediate-mode tree view plugin.
//
// Renders a scrollable, expandable file/folder tree through `ui_renderer` and
// reports selection / activation / expand-toggle back to the host. The host
// owns the data (a `file_node[]` forest) and the persistent
// `file_browser_state`; everything else (scroll, hit-testing, drawing) lives
// here.

import { theme_color } from '../theme'
import type { theme_definition } from '../types'
import { ui_renderer } from '../ui_renderer'
import type { ui_input_snapshot, ui_scroll_state } from '../ui_widgets'

export interface file_node {
  /** Stable id; if omitted a path-derived key is used. */
  id?: string
  name: string
  /** `'dir'` shows a disclosure triangle; inferred from `children` when omitted. */
  kind?: 'file' | 'dir'
  children?: file_node[]
  /** Optional glyph/emoji drawn before the name (e.g. a file-type icon). */
  icon?: string
}

export interface file_browser_state {
  expanded: Set<string>
  selected_id: string | null
  scroll: ui_scroll_state
  last_click_id: string | null
  last_click_ms: number
}

export interface file_browser_options {
  /** Logical font size. Defaults to 13. */
  font_px?: number
  /** Logical row height. Defaults to 22. */
  row_h?: number
  /** Logical per-depth indent. Defaults to 14. */
  indent?: number
  /** Auto-expand directories on first render. Defaults to false. */
  default_expanded?: boolean
}

export interface file_browser_event {
  /** A node was clicked / focused this frame. */
  selected?: file_node
  /** A file was double-clicked or Enter-activated. */
  activated?: file_node
  /** A directory's expanded state was toggled. */
  toggled?: file_node
}

export function create_file_browser_state(): file_browser_state {
  return {
    expanded: new Set<string>(),
    selected_id: null,
    scroll: { offset_y: 0 },
    last_click_id: null,
    last_click_ms: 0,
  }
}

function node_id(node: file_node, path: string): string {
  return node.id ?? path
}

function is_dir(node: file_node): boolean {
  return node.kind === 'dir' || (node.kind === undefined && Array.isArray(node.children))
}

type flat_row = { node: file_node; id: string; depth: number; dir: boolean }

function flatten(
  nodes: file_node[],
  state: file_browser_state,
  default_expanded: boolean,
  depth: number,
  parent_path: string,
  out: flat_row[],
): void {
  for (const node of nodes) {
    const path = parent_path ? `${parent_path}/${node.name}` : node.name
    const id = node_id(node, path)
    const dir = is_dir(node)
    out.push({ node, id, depth, dir })
    if (dir && node.children && node.children.length > 0) {
      const expanded = state.expanded.has(id) || (default_expanded && !state.expanded.has(`!${id}`))
      if (expanded) flatten(node.children, state, default_expanded, depth + 1, path, out)
    }
  }
}

function pack(hex: string): number {
  const raw = hex.trim().replace('#', '')
  const p = (s: number) => Number.parseInt(raw.slice(s, s + 2), 16)
  if (raw.length === 6) return (((255 << 24) | (p(4) << 16) | (p(2) << 8) | p(0)) >>> 0)
  if (raw.length === 8) return (((p(6) << 24) | (p(4) << 16) | (p(2) << 8) | p(0)) >>> 0)
  return 0xffffffff
}

function point_in(input: ui_input_snapshot, x: number, y: number, w: number, h: number): boolean {
  return input.mouse_x >= x && input.mouse_y >= y && input.mouse_x < x + w && input.mouse_y < y + h
}

export function file_browser(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  nodes: file_node[],
  state: file_browser_state,
  options?: file_browser_options,
): file_browser_event {
  const scale = window.devicePixelRatio || 1
  const font_px = (options?.font_px ?? 13) * scale
  const row_h = (options?.row_h ?? 22) * scale
  const indent = (options?.indent ?? 14) * scale
  const default_expanded = options?.default_expanded ?? false
  const col = (slot: Parameters<typeof theme_color>[1]) => pack(theme_color(theme, slot))

  const rows: flat_row[] = []
  flatten(nodes, state, default_expanded, 0, '', rows)

  const content_h = rows.length * row_h
  const max_off = Math.max(0, content_h - h)
  if (point_in(input, x, y, w, h) && input.wheel_y) {
    state.scroll.offset_y = Math.max(0, Math.min(max_off, state.scroll.offset_y - input.wheel_y * 20 * scale))
  }
  state.scroll.offset_y = Math.max(0, Math.min(max_off, state.scroll.offset_y))

  const event: file_browser_event = {}
  const scrollbar_w = content_h > h ? 7 * scale : 0
  const pad_x = 6 * scale

  ui.push_clip(x, y, w, h)
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    const ry = y + i * row_h - state.scroll.offset_y
    if (ry + row_h < y || ry > y + h) continue
    const selected = state.selected_id === row.id
    const hover = point_in(input, x, ry, w - scrollbar_w, row_h)
    if (selected) ui.fill_rect(x, ry, w - scrollbar_w, row_h, col('selected'))
    else if (hover) ui.fill_rect(x, ry, w - scrollbar_w, row_h, col('hover'))

    const tx = x + pad_x + row.depth * indent
    const cy = ry + row_h * 0.5

    // Disclosure triangle for directories.
    if (row.dir) {
      const expanded = state.expanded.has(row.id) || (default_expanded && !state.expanded.has(`!${row.id}`))
      const tri = 3.4 * scale
      const tcx = tx + tri
      const tc = col('text_dim')
      if (expanded) {
        ui.fill_triangle(tcx - tri, cy - tri * 0.6, tcx + tri, cy - tri * 0.6, tcx, cy + tri * 0.8, tc)
      } else {
        ui.fill_triangle(tcx - tri * 0.6, cy - tri, tcx - tri * 0.6, cy + tri, tcx + tri * 0.8, cy, tc)
      }
    }

    const icon = row.node.icon ?? (row.dir ? '📁' : '📄')
    const label_x = tx + 16 * scale
    ui.draw_text(label_x, ui.text_v_center_y(ry, row_h, font_px), `${icon}  ${row.node.name}`, font_px, selected ? col('text') : col('text_dim'))

    if (hover && input.mouse_pressed) {
      const now = performance.now()
      const double = state.last_click_id === row.id && now - state.last_click_ms < 320
      state.last_click_id = row.id
      state.last_click_ms = now
      state.selected_id = row.id
      event.selected = row.node
      if (row.dir) {
        toggle_expanded(state, row.id, default_expanded)
        event.toggled = row.node
      } else if (double) {
        event.activated = row.node
      }
    }
  }
  ui.pop_clip()

  // Scrollbar.
  if (scrollbar_w > 0) {
    const track_x = x + w - scrollbar_w
    ui.fill_rect(track_x, y, scrollbar_w, h, col('track'))
    const thumb_h = Math.max(20 * scale, (h / content_h) * h)
    const thumb_y = y + (state.scroll.offset_y / max_off) * (h - thumb_h)
    ui.fill_round_rect(track_x + 1 * scale, thumb_y, scrollbar_w - 2 * scale, thumb_h, 3 * scale, col('border_strong'))
  }

  // Keyboard activation of the current selection.
  if (input.key_enter && state.selected_id) {
    const sel = rows.find((r) => r.id === state.selected_id)
    if (sel && !sel.dir) event.activated = sel.node
    else if (sel) {
      toggle_expanded(state, sel.id, default_expanded)
      event.toggled = sel.node
    }
  }

  return event
}

function toggle_expanded(state: file_browser_state, id: string, default_expanded: boolean): void {
  if (default_expanded) {
    // With default-open, we track explicit collapses via a `!id` marker.
    const collapsed_key = `!${id}`
    if (state.expanded.has(collapsed_key)) state.expanded.delete(collapsed_key)
    else if (state.expanded.has(id)) state.expanded.delete(id)
    else state.expanded.add(collapsed_key)
  } else {
    if (state.expanded.has(id)) state.expanded.delete(id)
    else state.expanded.add(id)
  }
}
