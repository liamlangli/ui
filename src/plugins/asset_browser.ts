// asset_browser — a generic, immediate-mode asset/file browser plugin.
//
// A two-pane project browser: a collapsible folder tree on the left, a wrapped
// grid of asset cards on the right, a breadcrumb + host toolbar buttons across
// the top, and a draggable splitter between the panes. It owns all of its
// drawing, scrolling, hit-testing and selection, and reports navigation /
// activation / toolbar / context-menu intents back through an event object.
//
// Unlike {@link file_browser} (a single-column tree view), this is the richer
// "content browser" pattern (folders on one side, the selected folder's entries
// as preview cards on the other) lifted out of an editor so other projects can
// reuse it. It is content-agnostic: the host owns the folder forest and the
// entry list for the selected folder, and draws each card's thumbnail via a
// `render_preview` callback.
//
// Usage (once per frame, inside begin_frame()/flush()):
//
//   const ev = asset_browser(ui, theme, input, x, y, w, h, folders, entries, st, {
//     toolbar: [{ id: 'create', label: 'Create Asset' }, { id: 'import', label: 'Import' }],
//     render_preview: (entry, r) => draw_thumb(entry, r),
//   })
//   if (ev.folder_selected) load_folder(ev.folder_selected)
//   if (ev.entry_activated) open(ev.entry_activated)
//   if (ev.toolbar_clicked === 'create') open_create_menu()

import { theme_color } from '../theme'
import type { theme_definition, theme_slot } from '../types'
import { ui_renderer } from '../ui_renderer'
import type { ui_input_snapshot, ui_scroll_state } from '../ui_widgets'

/** A folder in the left-hand tree. `children` makes it collapsible. */
export interface asset_folder_node {
  /** Stable, full path (e.g. `Project/Textures`). Used as identity + breadcrumb. */
  path: string
  name: string
  children?: asset_folder_node[]
}

/** An item shown as a card in the right-hand grid for the selected folder. */
export interface asset_entry {
  path: string
  name: string
  kind: 'folder' | 'file'
  /** Short label drawn bottom-right (e.g. `SHADER`, `Folder`). Defaults from kind. */
  type_label?: string
  /** When true, a small accent marker is drawn (e.g. unsaved/dirty). */
  marked?: boolean
}

export interface asset_toolbar_button {
  id: string
  label: string
  /** Draw in the pressed/active state (e.g. while its menu is open). */
  active?: boolean
}

export interface asset_browser_state {
  selected_folder: string
  selected_paths: string[]
  collapsed: Set<string>
  /** Tree-pane width as a fraction of the body. */
  split_ratio: number
  grid_scroll: ui_scroll_state
  tree_scroll: ui_scroll_state
  /** Internal: splitter drag + double-click detection. */
  _dragging_split: boolean
  last_click_path: string | null
  last_click_ms: number
}

export interface asset_browser_options {
  toolbar?: asset_toolbar_button[]
  /** Logical font size for tree/card labels. Defaults to 13. */
  font_px?: number
  /** Logical grid card width / height. Default 64 × 92. */
  card_w?: number
  card_h?: number
  /** Draw a card thumbnail; return true if it drew (else a fallback label shows). */
  render_preview?: (entry: asset_entry, x: number, y: number, w: number, h: number) => boolean
}

export interface asset_browser_event {
  /** A folder was clicked in the tree, breadcrumb, or grid. */
  folder_selected?: string
  /** A card was single-clicked / focused. */
  entry_selected?: asset_entry
  /** A file card was double-clicked (folders emit {@link folder_selected}). */
  entry_activated?: asset_entry
  /** A toolbar button was pressed; value is its id. */
  toolbar_clicked?: string
  /** Right-click; `path` is the entry under the cursor or null for empty space. */
  context_requested?: { x: number; y: number; path: string | null }
}

export function create_asset_browser_state(initial_folder = 'Project'): asset_browser_state {
  return {
    selected_folder: initial_folder,
    selected_paths: [],
    collapsed: new Set<string>(),
    split_ratio: 0.32,
    grid_scroll: { offset_y: 0 },
    tree_scroll: { offset_y: 0 },
    _dragging_split: false,
    last_click_path: null,
    last_click_ms: 0,
  }
}

type tree_row = { path: string; name: string; depth: number; has_children: boolean; collapsed: boolean }

export function asset_browser(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  folders: asset_folder_node[],
  entries: asset_entry[],
  state: asset_browser_state,
  options?: asset_browser_options,
): asset_browser_event {
  const scale = window.devicePixelRatio || 1
  const font_px = (options?.font_px ?? 13) * scale
  const col = (slot: theme_slot) => pack(theme_color(theme, slot))
  const event: asset_browser_event = {}

  const gap = 3 * scale
  const splitter_w = 6 * scale
  const btn_h = 24 * scale

  // --- Toolbar -----------------------------------------------------------
  let bx = x
  const toolbar_y = y + gap
  for (const btn of options?.toolbar ?? []) {
    const bw = ui.text_width(btn.label, 7.5 * scale) + 6 * scale
    const hover = point_in(input, bx, toolbar_y, bw, btn_h)
    ui.fill_round_rect(bx, toolbar_y, bw, btn_h, 3 * scale, btn.active || (hover && input.mouse_down) ? col('active') : hover ? col('hover') : col('panel_alt'))
    ui.stroke_round_rect(bx, toolbar_y, bw, btn_h, 3 * scale, 1, col('border'))
    ui.draw_text(bx + 3 * scale, ui.text_v_center_y(toolbar_y, btn_h, 7.5 * scale), btn.label, 7.5 * scale, col('text'))
    if (hover && input.mouse_pressed) event.toolbar_clicked = btn.id
    bx += bw + 6 * scale
  }

  const body_y = toolbar_y + btn_h + gap
  const body_h = y + h - body_y
  const avail_w = Math.max(0, w - splitter_w)
  const min_left = 140 * scale
  const min_right = 160 * scale
  const left_w = clamp(avail_w * state.split_ratio, min_left, Math.max(min_left, avail_w - min_right))
  const tree_rect = { x, y: body_y, w: left_w, h: body_h }
  const splitter_rect = { x: x + left_w, y: body_y, w: splitter_w, h: body_h }
  const grid_rect = { x: x + left_w + splitter_w, y: body_y, w: w - left_w - splitter_w, h: body_h }

  // Breadcrumb (sits in the toolbar lane, above the grid).
  draw_breadcrumb(ui, grid_rect.x + 4 * scale, toolbar_y, btn_h, state.selected_folder, input, scale, (p) => { state.selected_folder = p; event.folder_selected = p }, col)

  // --- Splitter ----------------------------------------------------------
  const split_hover = point_in(input, splitter_rect.x - 2 * scale, splitter_rect.y, splitter_rect.w + 4 * scale, splitter_rect.h)
  if (split_hover || state._dragging_split) ui.set_cursor('col-resize')
  if (split_hover && input.mouse_pressed) state._dragging_split = true
  if (!input.mouse_down) state._dragging_split = false
  if (state._dragging_split) state.split_ratio = clamp((input.mouse_x - x) / Math.max(1, avail_w), 0.12, 0.8)
  ui.fill_rect(splitter_rect.x, splitter_rect.y, splitter_rect.w, splitter_rect.h, split_hover || state._dragging_split ? col('hover') : col('track'))

  // --- Tree pane ---------------------------------------------------------
  ui.fill_rect(tree_rect.x, tree_rect.y, tree_rect.w, tree_rect.h, col('panel'))
  ui.stroke_rect(tree_rect.x, tree_rect.y, tree_rect.w, tree_rect.h, 1, col('border'))
  draw_tree(ui, input, tree_rect, flatten_tree(folders, state.collapsed), state, font_px, scale, col, event)

  // --- Grid pane ---------------------------------------------------------
  ui.fill_rect(grid_rect.x, grid_rect.y, grid_rect.w, grid_rect.h, col('panel'))
  ui.stroke_rect(grid_rect.x, grid_rect.y, grid_rect.w, grid_rect.h, 1, col('border'))
  draw_grid(ui, input, grid_rect, entries, state, font_px, scale, col, options, event)

  return event
}

// --- tree ----------------------------------------------------------------

function flatten_tree(folders: asset_folder_node[], collapsed: Set<string>): tree_row[] {
  const rows: tree_row[] = []
  const visit = (nodes: asset_folder_node[], depth: number) => {
    for (const node of nodes) {
      const has_children = !!node.children && node.children.length > 0
      const is_collapsed = collapsed.has(node.path)
      rows.push({ path: node.path, name: node.name, depth, has_children, collapsed: is_collapsed })
      if (has_children && !is_collapsed) visit(node.children!, depth + 1)
    }
  }
  visit(folders, 0)
  return rows
}

function draw_tree(
  ui: ui_renderer,
  input: ui_input_snapshot,
  rect: { x: number; y: number; w: number; h: number },
  rows: tree_row[],
  state: asset_browser_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  event: asset_browser_event,
): void {
  const row_h = 22 * scale
  const content_h = rows.length * row_h + 12 * scale
  const max_off = Math.max(0, content_h - rect.h)
  if (point_in(input, rect.x, rect.y, rect.w, rect.h) && input.wheel_y) {
    state.tree_scroll.offset_y = clamp(state.tree_scroll.offset_y - input.wheel_y * 20 * scale, 0, max_off)
  }
  state.tree_scroll.offset_y = clamp(state.tree_scroll.offset_y, 0, max_off)

  ui.push_clip(rect.x, rect.y, rect.w, rect.h)
  let ry = rect.y + 6 * scale - state.tree_scroll.offset_y
  for (const row of rows) {
    if (ry + row_h >= rect.y && ry <= rect.y + rect.h) {
      const active = row.path === state.selected_folder
      if (active) ui.fill_rect(rect.x + 4 * scale, ry, rect.w - 8 * scale, row_h, col('active'))
      const indent_x = rect.x + 8 * scale + row.depth * 14 * scale
      const toggle_size = 10 * scale
      const toggle_x = indent_x
      const label_x = indent_x + 14 * scale
      if (row.has_children) {
        const expanded = !row.collapsed
        const tri = 3.2 * scale
        const tcx = toggle_x + tri
        const tcy = ry + row_h * 0.5
        if (expanded) ui.fill_triangle(tcx - tri, tcy - tri * 0.6, tcx + tri, tcy - tri * 0.6, tcx, tcy + tri * 0.8, col('text_dim'))
        else ui.fill_triangle(tcx - tri * 0.6, tcy - tri, tcx - tri * 0.6, tcy + tri, tcx + tri * 0.8, tcy, col('text_dim'))
        if (point_in(input, toggle_x - 2 * scale, ry, toggle_size + 6 * scale, row_h) && input.mouse_pressed) {
          if (row.collapsed) state.collapsed.delete(row.path)
          else state.collapsed.add(row.path)
        }
      }
      ui.draw_text(label_x, ui.text_v_center_y(ry, row_h, font_px), row.name, font_px, col(active ? 'text' : 'text_dim'))
      if (point_in(input, label_x - 2 * scale, ry, rect.x + rect.w - label_x, row_h) && input.mouse_pressed) {
        state.selected_folder = row.path
        event.folder_selected = row.path
      }
    }
    ry += row_h
  }
  ui.pop_clip()
}

// --- grid ----------------------------------------------------------------

function draw_grid(
  ui: ui_renderer,
  input: ui_input_snapshot,
  rect: { x: number; y: number; w: number; h: number },
  entries: asset_entry[],
  state: asset_browser_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  options: asset_browser_options | undefined,
  event: asset_browser_event,
): void {
  const pad = 10 * scale
  const card_w = (options?.card_w ?? 64) * scale
  const card_h = (options?.card_h ?? 92) * scale
  const card_gap = 8 * scale
  const preview_h = card_h - 28 * scale
  const cols = Math.max(1, Math.floor((rect.w - pad * 2 + card_gap) / (card_w + card_gap)))
  const rows = Math.ceil(entries.length / cols)
  const content_h = pad * 2 + rows * (card_h + card_gap)
  const max_off = Math.max(0, content_h - rect.h)
  const over_grid = point_in(input, rect.x, rect.y, rect.w, rect.h)
  if (over_grid && input.wheel_y) state.grid_scroll.offset_y = clamp(state.grid_scroll.offset_y - input.wheel_y * 24 * scale, 0, max_off)
  state.grid_scroll.offset_y = clamp(state.grid_scroll.offset_y, 0, max_off)

  // Empty-space clicks (selection clear / context menu).
  if (over_grid && input.mouse_pressed) { state.selected_paths = []; event.entry_selected = undefined }
  if (over_grid && input.mouse_right_pressed) event.context_requested = { x: input.mouse_x, y: input.mouse_y, path: null }

  ui.push_clip(rect.x, rect.y, rect.w, rect.h)
  if (entries.length === 0) {
    ui.draw_text(rect.x + pad, rect.y + 24 * scale, 'Folder is empty', font_px, col('text_dim'))
  }
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]
    const cx = i % cols
    const cy = Math.floor(i / cols)
    const ex = rect.x + pad + cx * (card_w + card_gap)
    const ey = rect.y + pad + cy * (card_h + card_gap) - state.grid_scroll.offset_y
    if (ey + card_h < rect.y || ey > rect.y + rect.h) continue
    const active = state.selected_paths.includes(entry.path)
    ui.fill_rect(ex, ey, card_w, card_h, col('panel_alt'))
    const drew = options?.render_preview?.(entry, ex, ey, card_w, preview_h) ?? false
    if (!drew) {
      ui.fill_rect(ex, ey, card_w, preview_h, col('panel'))
      ui.draw_text(ex + 8 * scale, ui.text_v_center_y(ey + 12 * scale, 20 * scale, 6 * scale), entry.kind === 'folder' ? 'DIR' : 'FILE', 6 * scale, col('text_dim'))
    }
    ui.push_clip(ex + 4 * scale, ey + preview_h, card_w - 8 * scale, card_h - preview_h - 12 * scale)
    ui.draw_text(ex + 4 * scale, ey + preview_h + 2 * scale, base_name(entry.name), 6 * scale, col('text'))
    ui.pop_clip()
    const type_label = entry.type_label ?? (entry.kind === 'folder' ? 'Folder' : 'File')
    const tw = ui.text_width(type_label, 5 * scale)
    ui.draw_text(ex + card_w - 4 * scale - tw, ey + card_h - 12 * scale, type_label, 5 * scale, col('text_dim'))
    if (entry.marked) ui.fill_circle(ex + card_w - 7 * scale, ey + 8 * scale, 2.5 * scale, col('accent'))
    ui.stroke_rect(ex, ey, card_w, card_h, 1, col('border'))
    if (active) ui.stroke_rect(ex - 2 * scale, ey - 2 * scale, card_w + 4 * scale, card_h + 4 * scale, 1, col('scene_outline'))

    const hover = point_in(input, ex, ey, card_w, card_h)
    if (hover && input.mouse_pressed) {
      const now = performance.now()
      const dbl = state.last_click_path === entry.path && now - state.last_click_ms < 320
      state.last_click_path = entry.path
      state.last_click_ms = now
      state.selected_paths = [entry.path]
      event.entry_selected = entry
      if (entry.kind === 'folder') {
        if (dbl) { state.selected_folder = entry.path; event.folder_selected = entry.path }
      } else if (dbl) {
        event.entry_activated = entry
      }
    }
    if (hover && input.mouse_right_pressed) event.context_requested = { x: input.mouse_x, y: input.mouse_y, path: entry.path }
  }
  ui.pop_clip()
}

// --- breadcrumb ----------------------------------------------------------

function draw_breadcrumb(
  ui: ui_renderer,
  x: number,
  y: number,
  h: number,
  folder: string,
  input: ui_input_snapshot,
  scale: number,
  on_select: (path: string) => void,
  col: (slot: theme_slot) => number,
): void {
  const parts = folder.split('/').filter(Boolean)
  const font_px = 6.5 * scale
  const text_y = ui.text_v_center_y(y, h, font_px)
  let cursor_x = x
  let current = ''
  for (let i = 0; i < parts.length; i += 1) {
    current = current ? `${current}/${parts[i]}` : parts[i]
    const tw = ui.text_width(parts[i], font_px)
    const hover = point_in(input, cursor_x - 2 * scale, y, tw + 4 * scale, h)
    if (hover) ui.fill_rect(cursor_x - 2 * scale, y + 2 * scale, tw + 4 * scale, h - 4 * scale, col('hover'))
    ui.draw_text(cursor_x, text_y, parts[i], font_px, col('text'))
    const captured = current
    if (hover && input.mouse_pressed) on_select(captured)
    cursor_x += tw
    if (i < parts.length - 1) {
      ui.draw_text(cursor_x + 4 * scale, text_y, '/', font_px, col('text_dim'))
      cursor_x += ui.text_width('/', font_px) + 8 * scale
    }
  }
}

// --- helpers -------------------------------------------------------------

function base_name(name: string): string {
  const dot = name.indexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function point_in(input: ui_input_snapshot, x: number, y: number, w: number, h: number): boolean {
  return input.mouse_x >= x && input.mouse_y >= y && input.mouse_x < x + w && input.mouse_y < y + h
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function pack(hex: string): number {
  const raw = hex.trim().replace('#', '')
  const p = (s: number) => Number.parseInt(raw.slice(s, s + 2), 16)
  if (raw.length === 6) return (((255 << 24) | (p(4) << 16) | (p(2) << 8) | p(0)) >>> 0)
  if (raw.length === 8) return (((p(6) << 24) | (p(4) << 16) | (p(2) << 8) | p(0)) >>> 0)
  return 0xffffffff
}
