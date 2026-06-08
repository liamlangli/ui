// file_browser — immediate-mode project/file browser plugin.
//
// The plugin keeps the original single-column tree API and also exposes the
// richer project-browser surface used by editor file tabs: folder tree,
// breadcrumb, search, list/grid modes, toolbar intents, and preview extension
// hooks. Hosts own file data and optional preview rendering.

import { theme_color } from '../theme'
import type { theme_definition, theme_slot } from '../types'
import { FONT_MAIN, ui_renderer } from '../ui_renderer'
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

export interface file_browser_folder_node {
  /** Stable, full path (e.g. `Project/Textures`). Used as identity + breadcrumb. */
  path: string
  name: string
  children?: file_browser_folder_node[]
}

export interface file_browser_entry {
  path: string
  name: string
  kind: 'folder' | 'file'
  /** Short label drawn in list/grid views (e.g. `SHADER`, `Folder`). */
  type_label?: string
  /** Draws a small accent marker, useful for dirty/changed assets. */
  marked?: boolean
}

export interface file_browser_toolbar_button {
  id: string
  label: string
  /** Draw in the pressed/active state (e.g. while its menu is open). */
  active?: boolean
}

export type file_browser_view_mode = 'list' | 'grid'

export interface file_browser_state {
  expanded: Set<string>
  selected_id: string | null
  scroll: ui_scroll_state
  last_click_id: string | null
  last_click_ms: number

  selected_folder?: string
  selected_paths?: string[]
  collapsed?: Set<string>
  /** Tree-pane width as a fraction of the content body. */
  split_ratio?: number
  tree_scroll?: ui_scroll_state
  grid_scroll?: ui_scroll_state
  list_scroll?: ui_scroll_state
  view_mode?: file_browser_view_mode
  search_text?: string
  search_focused?: boolean
  search_cursor?: number
  _dragging_split?: boolean
  last_click_path?: string | null
  last_entry_click_ms?: number
}

export interface file_browser_options {
  /** Logical font size. Defaults to 13. */
  font_px?: number
  /** Logical row height for tree/list rows. Defaults to 22. */
  row_h?: number
  /** Logical per-depth indent. Defaults to 14. */
  indent?: number
  /** Auto-expand directories in legacy tree mode on first render. Defaults to false. */
  default_expanded?: boolean

  toolbar?: file_browser_toolbar_button[]
  /** Controlled view mode. Omit to let state.view_mode own it. */
  view_mode?: file_browser_view_mode
  /** Show the built-in list/grid segmented control. Defaults to true. */
  view_toggle?: boolean
  /** Show the folder tree pane. Defaults to true. */
  show_tree?: boolean
  /** Show the search field. Defaults to true. */
  search?: boolean
  /** Logical grid card width / height. Defaults to 64 x 92. */
  card_w?: number
  card_h?: number
  /** Entries used while searching; omit to search the current folder entries. */
  search_entries?: file_browser_entry[]
  /** Folder forest for the rich browser when using the legacy call shape. */
  folders?: file_browser_folder_node[]
  /** Current folder entries for the rich browser when using the legacy call shape. */
  entries?: file_browser_entry[]
  /** Draw a list/grid thumbnail; return true if it drew, otherwise fallback art is shown. */
  render_preview?: (entry: file_browser_entry, x: number, y: number, w: number, h: number) => boolean
}

export interface file_browser_event {
  /** Legacy tree mode: a node was clicked / focused this frame. */
  selected?: file_node
  /** Legacy tree mode: a file was double-clicked or Enter-activated. */
  activated?: file_node
  /** Legacy tree mode: a directory's expanded state was toggled. */
  toggled?: file_node

  /** Rich browser: a folder was clicked in the tree, breadcrumb, list, or grid. */
  folder_selected?: string
  /** Rich browser: an entry was single-clicked / focused. */
  entry_selected?: file_browser_entry
  /** Rich browser: a file entry was double-clicked. */
  entry_activated?: file_browser_entry
  /** Rich browser: a toolbar button was pressed. */
  toolbar_clicked?: string
  /** Rich browser: list/grid mode changed. */
  view_mode_changed?: file_browser_view_mode
  /** Rich browser: search text changed. */
  search_changed?: string
  /** Rich browser: right-click; path is the entry under the cursor or null for empty space. */
  context_requested?: { x: number; y: number; path: string | null }
}

export function create_file_browser_state(initial_folder = 'Project'): file_browser_state {
  return {
    expanded: new Set<string>(),
    selected_id: null,
    scroll: { offset_y: 0 },
    last_click_id: null,
    last_click_ms: 0,

    selected_folder: initial_folder,
    selected_paths: [],
    collapsed: new Set<string>(),
    split_ratio: 0.32,
    tree_scroll: { offset_y: 0 },
    grid_scroll: { offset_y: 0 },
    list_scroll: { offset_y: 0 },
    view_mode: 'grid',
    search_text: '',
    search_focused: false,
    search_cursor: 0,
    _dragging_split: false,
    last_click_path: null,
    last_entry_click_ms: 0,
  }
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
): file_browser_event
export function file_browser(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  folders: file_browser_folder_node[],
  entries: file_browser_entry[],
  state: file_browser_state,
  options?: file_browser_options,
): file_browser_event
export function file_browser(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  nodes_or_folders: file_node[] | file_browser_folder_node[],
  state_or_entries: file_browser_state | file_browser_entry[],
  options_or_state?: file_browser_options | file_browser_state,
  maybe_options?: file_browser_options,
): file_browser_event {
  if (Array.isArray(state_or_entries)) {
    return rich_file_browser(
      ui,
      theme,
      input,
      x,
      y,
      w,
      h,
      nodes_or_folders as file_browser_folder_node[],
      state_or_entries,
      options_or_state as file_browser_state,
      maybe_options,
    )
  }

  const state = state_or_entries
  const options = options_or_state as file_browser_options | undefined
  if (options?.entries || options?.folders || options?.view_mode || options?.search_entries) {
    return rich_file_browser(
      ui,
      theme,
      input,
      x,
      y,
      w,
      h,
      options.folders ?? node_tree_to_folders(nodes_or_folders as file_node[]),
      options.entries ?? node_tree_to_entries(nodes_or_folders as file_node[], state.selected_folder ?? 'Project'),
      state,
      options,
    )
  }

  return tree_file_browser(ui, theme, input, x, y, w, h, nodes_or_folders as file_node[], state, options)
}

// --- rich browser ---------------------------------------------------------

type rich_tree_row = { path: string; name: string; depth: number; has_children: boolean; collapsed: boolean }

function rich_file_browser(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  folders: file_browser_folder_node[],
  entries: file_browser_entry[],
  state: file_browser_state,
  options?: file_browser_options,
): file_browser_event {
  ensure_rich_state(state)
  const scale = window.devicePixelRatio || 1
  const font_px = (options?.font_px ?? 13) * scale
  const col = (slot: theme_slot) => pack(theme_color(theme, slot))
  const event: file_browser_event = {}

  const gap = 3 * scale
  const splitter_w = options?.show_tree === false ? 0 : 6 * scale
  const btn_h = 24 * scale
  const toolbar_y = y + gap
  const toolbar_h = btn_h
  let bx = x

  for (const btn of options?.toolbar ?? []) {
    const bw = Math.ceil(ui.text_width(btn.label, 7.5 * scale) + 8 * scale)
    draw_toolbar_button(ui, input, bx, toolbar_y, bw, btn_h, btn.label, !!btn.active, scale, col)
    if (point_in(input, bx, toolbar_y, bw, btn_h) && input.mouse_pressed) event.toolbar_clicked = btn.id
    bx += bw + 6 * scale
  }

  if (options?.view_toggle !== false) {
    const modes: file_browser_view_mode[] = ['list', 'grid']
    for (const mode of modes) {
      const label = mode === 'list' ? 'List' : 'Grid'
      const bw = Math.ceil(ui.text_width(label, 7.5 * scale) + 10 * scale)
      const active = (options?.view_mode ?? state.view_mode) === mode
      draw_toolbar_button(ui, input, bx, toolbar_y, bw, btn_h, label, active, scale, col)
      if (point_in(input, bx, toolbar_y, bw, btn_h) && input.mouse_pressed) {
        state.view_mode = mode
        event.view_mode_changed = mode
      }
      bx += bw + 4 * scale
    }
  }

  const search_enabled = options?.search !== false
  const search_w = search_enabled ? Math.min(210 * scale, Math.max(130 * scale, w * 0.28)) : 0
  const search_x = search_enabled ? x + w - search_w : x + w
  if (search_enabled) draw_search_field(ui, input, search_x, toolbar_y, search_w, btn_h, state, event, scale, col)

  const body_y = toolbar_y + toolbar_h + gap
  const body_h = Math.max(0, y + h - body_y)
  const show_tree = options?.show_tree !== false
  const avail_w = Math.max(0, w - splitter_w)
  const min_left = 140 * scale
  const min_right = 160 * scale
  const left_w = show_tree ? clamp(avail_w * (state.split_ratio ?? 0.32), min_left, Math.max(min_left, avail_w - min_right)) : 0
  const tree_rect = { x, y: body_y, w: left_w, h: body_h }
  const splitter_rect = { x: x + left_w, y: body_y, w: splitter_w, h: body_h }
  const content_rect = { x: x + left_w + splitter_w, y: body_y, w: w - left_w - splitter_w, h: body_h }

  const breadcrumb_x = Math.max(bx + 4 * scale, content_rect.x + 4 * scale)
  const breadcrumb_w = Math.max(0, search_x - breadcrumb_x - 8 * scale)
  ui.push_clip(breadcrumb_x, toolbar_y, breadcrumb_w, btn_h)
  draw_breadcrumb(ui, breadcrumb_x, toolbar_y, btn_h, state.selected_folder ?? '', input, scale, (path) => {
    state.selected_folder = path
    state.selected_paths = []
    event.folder_selected = path
  }, col)
  ui.pop_clip()

  if (show_tree) {
    const split_hover = point_in(input, splitter_rect.x - 2 * scale, splitter_rect.y, splitter_rect.w + 4 * scale, splitter_rect.h)
    if (split_hover || state._dragging_split) ui.set_cursor('col-resize')
    if (split_hover && input.mouse_pressed) state._dragging_split = true
    if (!input.mouse_down) state._dragging_split = false
    if (state._dragging_split) state.split_ratio = clamp((input.mouse_x - x) / Math.max(1, avail_w), 0.12, 0.8)

    ui.fill_rect(tree_rect.x, tree_rect.y, tree_rect.w, tree_rect.h, col('panel'))
    ui.stroke_rect(tree_rect.x, tree_rect.y, tree_rect.w, tree_rect.h, 1, col('border'))
    draw_folder_tree(ui, input, tree_rect, flatten_folder_tree(folders, state.collapsed ?? new Set()), state, font_px, scale, col, event)
    ui.fill_rect(splitter_rect.x, splitter_rect.y, splitter_rect.w, splitter_rect.h, split_hover || state._dragging_split ? col('hover') : col('track'))
  }

  const search_text = (state.search_text ?? '').trim().toLowerCase()
  const visible_entries = search_text
    ? (options?.search_entries ?? entries).filter((entry) => entry.name.toLowerCase().includes(search_text) || entry.path.toLowerCase().includes(search_text))
    : entries

  ui.fill_rect(content_rect.x, content_rect.y, content_rect.w, content_rect.h, col('panel'))
  ui.stroke_rect(content_rect.x, content_rect.y, content_rect.w, content_rect.h, 1, col('border'))
  if ((options?.view_mode ?? state.view_mode) === 'list') {
    draw_entry_list(ui, input, content_rect, visible_entries, state, font_px, scale, col, event)
  } else {
    draw_entry_grid(ui, input, content_rect, visible_entries, state, font_px, scale, col, options, event)
  }

  return event
}

function ensure_rich_state(state: file_browser_state): void {
  state.selected_folder ??= 'Project'
  state.selected_paths ??= []
  state.collapsed ??= new Set<string>()
  state.split_ratio ??= 0.32
  state.tree_scroll ??= { offset_y: 0 }
  state.grid_scroll ??= { offset_y: 0 }
  state.list_scroll ??= { offset_y: 0 }
  state.view_mode ??= 'grid'
  state.search_text ??= ''
  state.search_focused ??= false
  state.search_cursor ??= state.search_text.length
  state._dragging_split ??= false
  state.last_click_path ??= null
  state.last_entry_click_ms ??= 0
}

function draw_toolbar_button(
  ui: ui_renderer,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  active: boolean,
  scale: number,
  col: (slot: theme_slot) => number,
): void {
  const hover = point_in(input, x, y, w, h)
  ui.fill_round_rect(x, y, w, h, 3 * scale, active || (hover && input.mouse_down) ? col('active') : hover ? col('hover') : col('panel_alt'))
  ui.stroke_round_rect(x, y, w, h, 3 * scale, 1, col('border'))
  ui.draw_text(x + 4 * scale, ui.text_v_center_y(y, h, 7.5 * scale), label, 7.5 * scale, col('text'))
}

function draw_search_field(
  ui: ui_renderer,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  state: file_browser_state,
  event: file_browser_event,
  scale: number,
  col: (slot: theme_slot) => number,
): void {
  const inside = point_in(input, x, y, w, h)
  if (input.mouse_pressed) state.search_focused = inside
  if (inside) ui.set_cursor('text')

  const before = state.search_text ?? ''
  if (state.search_focused) {
    input.native_text_regions = [...(input.native_text_regions ?? []), { id: 'file-browser-search', x, y, w, h, mode: 'text' }]
    input.native_text_input = {
      id: 'file-browser-search',
      x,
      y,
      w,
      h,
      mode: 'text',
      value: state.search_text ?? '',
      cursor: state.search_cursor ?? 0,
      selection_start: state.search_cursor ?? 0,
      selection_end: state.search_cursor ?? 0,
    }
    if (input.typed_text) {
      const cursor = clamp(state.search_cursor ?? before.length, 0, before.length)
      state.search_text = before.slice(0, cursor) + input.typed_text + before.slice(cursor)
      state.search_cursor = cursor + input.typed_text.length
    }
    if (input.key_backspace && (state.search_cursor ?? 0) > 0) {
      const cursor = clamp(state.search_cursor ?? 0, 0, (state.search_text ?? '').length)
      const text = state.search_text ?? ''
      state.search_text = text.slice(0, cursor - 1) + text.slice(cursor)
      state.search_cursor = cursor - 1
    }
    if (input.key_delete && (state.search_cursor ?? 0) < (state.search_text ?? '').length) {
      const cursor = clamp(state.search_cursor ?? 0, 0, (state.search_text ?? '').length)
      const text = state.search_text ?? ''
      state.search_text = text.slice(0, cursor) + text.slice(cursor + 1)
    }
    if (input.key_left) state.search_cursor = clamp((state.search_cursor ?? 0) - 1, 0, (state.search_text ?? '').length)
    if (input.key_right) state.search_cursor = clamp((state.search_cursor ?? 0) + 1, 0, (state.search_text ?? '').length)
    if (input.key_home) state.search_cursor = 0
    if (input.key_end) state.search_cursor = (state.search_text ?? '').length
    if (input.key_escape) {
      if (state.search_text) {
        state.search_text = ''
        state.search_cursor = 0
      } else {
        state.search_focused = false
      }
    }
  }
  if ((state.search_text ?? '') !== before) event.search_changed = state.search_text ?? ''

  ui.fill_round_rect(x, y, w, h, 3 * scale, col('panel_alt'))
  ui.stroke_round_rect(x, y, w, h, 3 * scale, 1, state.search_focused ? col('scene_outline') : col('border'))
  const text = state.search_text || 'Search files'
  const color = state.search_text ? col('text') : col('text_dim')
  const font_px = 7.5 * scale
  const tx = x + 8 * scale
  ui.push_clip(tx, y, w - 16 * scale, h)
  ui.draw_text(tx, ui.text_v_center_y(y, h, font_px), text, font_px, color)
  if (state.search_focused) {
    const cursor = clamp(state.search_cursor ?? 0, 0, (state.search_text ?? '').length)
    const cx = tx + ui.text_width((state.search_text ?? '').slice(0, cursor), font_px)
    ui.fill_rect(cx, y + 5 * scale, Math.max(1, scale), h - 10 * scale, col('text'))
  }
  ui.pop_clip()
}

function flatten_folder_tree(folders: file_browser_folder_node[], collapsed: Set<string>): rich_tree_row[] {
  const rows: rich_tree_row[] = []
  const visit = (nodes: file_browser_folder_node[], depth: number) => {
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

function draw_folder_tree(
  ui: ui_renderer,
  input: ui_input_snapshot,
  rect: { x: number; y: number; w: number; h: number },
  rows: rich_tree_row[],
  state: file_browser_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  event: file_browser_event,
): void {
  const row_h = 22 * scale
  const scroll = state.tree_scroll ?? { offset_y: 0 }
  const content_h = rows.length * row_h + 12 * scale
  const max_off = Math.max(0, content_h - rect.h)
  if (point_in(input, rect.x, rect.y, rect.w, rect.h) && input.wheel_y) {
    scroll.offset_y = clamp(scroll.offset_y - input.wheel_y * 20 * scale, 0, max_off)
  }
  scroll.offset_y = clamp(scroll.offset_y, 0, max_off)
  state.tree_scroll = scroll

  ui.push_clip(rect.x, rect.y, rect.w, rect.h)
  let ry = rect.y + 6 * scale - scroll.offset_y
  for (const row of rows) {
    if (ry + row_h >= rect.y && ry <= rect.y + rect.h) {
      const active = row.path === state.selected_folder
      const hover = point_in(input, rect.x + 4 * scale, ry, rect.w - 8 * scale, row_h)
      if (active) ui.fill_rect(rect.x + 4 * scale, ry, rect.w - 8 * scale, row_h, col('active'))
      else if (hover) ui.fill_rect(rect.x + 4 * scale, ry, rect.w - 8 * scale, row_h, col('hover'))

      const indent_x = rect.x + 8 * scale + row.depth * 14 * scale
      const toggle_x = indent_x
      const label_x = indent_x + 14 * scale
      if (row.has_children) {
        const tri = 3.2 * scale
        const tcx = toggle_x + tri
        const tcy = ry + row_h * 0.5
        if (!row.collapsed) ui.fill_triangle(tcx - tri, tcy - tri * 0.6, tcx + tri, tcy - tri * 0.6, tcx, tcy + tri * 0.8, col('text_dim'))
        else ui.fill_triangle(tcx - tri * 0.6, tcy - tri, tcx - tri * 0.6, tcy + tri, tcx + tri * 0.8, tcy, col('text_dim'))
        if (point_in(input, toggle_x - 2 * scale, ry, 16 * scale, row_h) && input.mouse_pressed) {
          const collapsed = state.collapsed ?? new Set<string>()
          if (row.collapsed) collapsed.delete(row.path)
          else collapsed.add(row.path)
          state.collapsed = collapsed
        }
      }
      ui.draw_text(label_x, ui.text_v_center_y(ry, row_h, font_px), row.name, font_px, col(active ? 'text' : 'text_dim'))
      if (point_in(input, label_x - 2 * scale, ry, rect.x + rect.w - label_x, row_h) && input.mouse_pressed) {
        state.selected_folder = row.path
        state.selected_paths = []
        event.folder_selected = row.path
      }
    }
    ry += row_h
  }
  ui.pop_clip()
}

function draw_entry_grid(
  ui: ui_renderer,
  input: ui_input_snapshot,
  rect: { x: number; y: number; w: number; h: number },
  entries: file_browser_entry[],
  state: file_browser_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  options: file_browser_options | undefined,
  event: file_browser_event,
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
  const scroll = state.grid_scroll ?? { offset_y: 0 }
  if (over_grid && input.wheel_y) scroll.offset_y = clamp(scroll.offset_y - input.wheel_y * 24 * scale, 0, max_off)
  scroll.offset_y = clamp(scroll.offset_y, 0, max_off)
  state.grid_scroll = scroll

  if (over_grid && input.mouse_pressed) { state.selected_paths = []; event.entry_selected = undefined }
  if (over_grid && input.mouse_right_pressed) event.context_requested = { x: input.mouse_x, y: input.mouse_y, path: null }

  ui.push_clip(rect.x, rect.y, rect.w, rect.h)
  if (entries.length === 0) {
    ui.draw_text(rect.x + pad, rect.y + 24 * scale, state.search_text ? 'No files match' : 'Folder is empty', font_px, col('text_dim'))
  }
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!
    const cx = i % cols
    const cy = Math.floor(i / cols)
    const ex = rect.x + pad + cx * (card_w + card_gap)
    const ey = rect.y + pad + cy * (card_h + card_gap) - scroll.offset_y
    if (ey + card_h < rect.y || ey > rect.y + rect.h) continue
    const active = (state.selected_paths ?? []).includes(entry.path)
    const hover = point_in(input, ex, ey, card_w, card_h)
    ui.fill_rect(ex, ey, card_w, card_h, hover ? col('hover') : col('panel_alt'))
    const drew = options?.render_preview?.(entry, ex, ey, card_w, preview_h) ?? false
    if (!drew) {
      ui.fill_rect(ex, ey, card_w, preview_h, col('panel'))
      ui.draw_text(ex + 8 * scale, ui.text_v_center_y(ey + 12 * scale, 20 * scale, 6 * scale), entry.kind === 'folder' ? 'DIR' : 'FILE', 6 * scale, col('text_dim'))
    }
    ui.push_clip(ex + 4 * scale, ey + preview_h, card_w - 8 * scale, card_h - preview_h - 12 * scale)
    ui.draw_text(ex + 4 * scale, ey + preview_h + 2 * scale, base_name(entry.name), 6 * scale, col('text'))
    ui.pop_clip()
    const type_label = entry.type_label ?? (entry.kind === 'folder' ? 'Folder' : file_type_label(entry.name))
    const tw = ui.text_width(type_label, 5 * scale)
    ui.draw_text(ex + card_w - 4 * scale - tw, ey + card_h - 12 * scale, type_label, 5 * scale, col('text_dim'))
    if (entry.marked) ui.fill_circle(ex + card_w - 7 * scale, ey + 8 * scale, 2.5 * scale, col('accent'))
    ui.stroke_rect(ex, ey, card_w, card_h, 1, col('border'))
    if (active) ui.stroke_rect(ex - 2 * scale, ey - 2 * scale, card_w + 4 * scale, card_h + 4 * scale, 1, col('scene_outline'))

    handle_entry_click(input, hover, entry, state, event)
  }
  ui.pop_clip()
}

function draw_entry_list(
  ui: ui_renderer,
  input: ui_input_snapshot,
  rect: { x: number; y: number; w: number; h: number },
  entries: file_browser_entry[],
  state: file_browser_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  event: file_browser_event,
): void {
  const row_h = 24 * scale
  const header_h = 22 * scale
  const pad = 8 * scale
  const content_h = header_h + entries.length * row_h + pad
  const max_off = Math.max(0, content_h - rect.h)
  const over_list = point_in(input, rect.x, rect.y, rect.w, rect.h)
  const scroll = state.list_scroll ?? { offset_y: 0 }
  if (over_list && input.wheel_y) scroll.offset_y = clamp(scroll.offset_y - input.wheel_y * 22 * scale, 0, max_off)
  scroll.offset_y = clamp(scroll.offset_y, 0, max_off)
  state.list_scroll = scroll

  if (over_list && input.mouse_pressed) { state.selected_paths = []; event.entry_selected = undefined }
  if (over_list && input.mouse_right_pressed) event.context_requested = { x: input.mouse_x, y: input.mouse_y, path: null }

  const type_x = rect.x + Math.max(150 * scale, rect.w * 0.46)
  const path_x = rect.x + Math.max(230 * scale, rect.w * 0.64)
  ui.push_clip(rect.x, rect.y, rect.w, rect.h)
  ui.fill_rect(rect.x, rect.y, rect.w, header_h, col('panel_alt'))
  ui.draw_text(rect.x + pad, ui.text_v_center_y(rect.y, header_h, 6.5 * scale), 'Name', 6.5 * scale, col('text_dim'))
  ui.draw_text(type_x, ui.text_v_center_y(rect.y, header_h, 6.5 * scale), 'Type', 6.5 * scale, col('text_dim'))
  ui.draw_text(path_x, ui.text_v_center_y(rect.y, header_h, 6.5 * scale), 'Path', 6.5 * scale, col('text_dim'))

  if (entries.length === 0) {
    ui.draw_text(rect.x + pad, rect.y + header_h + 22 * scale, state.search_text ? 'No files match' : 'Folder is empty', font_px, col('text_dim'))
  }
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!
    const ry = rect.y + header_h + i * row_h - scroll.offset_y
    if (ry + row_h < rect.y + header_h || ry > rect.y + rect.h) continue
    const active = (state.selected_paths ?? []).includes(entry.path)
    const hover = point_in(input, rect.x, ry, rect.w, row_h)
    if (active) ui.fill_rect(rect.x + 3 * scale, ry, rect.w - 6 * scale, row_h, col('active'))
    else if (hover) ui.fill_rect(rect.x + 3 * scale, ry, rect.w - 6 * scale, row_h, col('hover'))

    const label = `${entry.kind === 'folder' ? '▸' : ' '} ${entry.name}`
    ui.push_clip(rect.x + pad, ry, Math.max(0, type_x - rect.x - pad * 2), row_h)
    ui.draw_text(rect.x + pad, ui.text_v_center_y(ry, row_h, font_px), label, font_px, col(active ? 'text' : 'text_dim'))
    ui.pop_clip()

    const type_label = entry.type_label ?? (entry.kind === 'folder' ? 'Folder' : file_type_label(entry.name))
    ui.push_clip(type_x, ry, Math.max(0, path_x - type_x - pad), row_h)
    ui.draw_text(type_x, ui.text_v_center_y(ry, row_h, font_px), type_label, font_px, col('text_dim'))
    ui.pop_clip()

    ui.push_clip(path_x, ry, Math.max(0, rect.x + rect.w - path_x - pad), row_h)
    ui.draw_text(path_x, ui.text_v_center_y(ry, row_h, font_px), entry.path, font_px, col('text_dim'))
    ui.pop_clip()

    if (entry.marked) ui.fill_circle(rect.x + rect.w - 12 * scale, ry + row_h * 0.5, 2.5 * scale, col('accent'))
    if (hover && input.mouse_right_pressed) event.context_requested = { x: input.mouse_x, y: input.mouse_y, path: entry.path }
    handle_entry_click(input, hover, entry, state, event)
  }
  ui.pop_clip()
}

function handle_entry_click(
  input: ui_input_snapshot,
  hover: boolean,
  entry: file_browser_entry,
  state: file_browser_state,
  event: file_browser_event,
): void {
  if (!hover || !input.mouse_pressed) return
  const now = performance.now()
  const dbl = state.last_click_path === entry.path && now - (state.last_entry_click_ms ?? 0) < 320
  state.last_click_path = entry.path
  state.last_entry_click_ms = now
  state.selected_paths = [entry.path]
  event.entry_selected = entry
  if (entry.kind === 'folder') {
    if (dbl) {
      state.selected_folder = entry.path
      state.selected_paths = []
      event.folder_selected = entry.path
    }
  } else if (dbl) {
    event.entry_activated = entry
  }
}

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
    const part = parts[i]!
    current = current ? `${current}/${part}` : part
    const tw = ui.text_width(part, font_px)
    const hover = point_in(input, cursor_x - 2 * scale, y, tw + 4 * scale, h)
    if (hover) ui.fill_rect(cursor_x - 2 * scale, y + 2 * scale, tw + 4 * scale, h - 4 * scale, col('hover'))
    ui.draw_text(cursor_x, text_y, part, font_px, col('text'))
    const captured = current
    if (hover && input.mouse_pressed) on_select(captured)
    cursor_x += tw
    if (i < parts.length - 1) {
      ui.draw_text(cursor_x + 4 * scale, text_y, '/', font_px, col('text_dim'))
      cursor_x += ui.text_width('/', font_px) + 8 * scale
    }
  }
}

// --- legacy tree browser --------------------------------------------------

function tree_file_browser(
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
  const col = (slot: theme_slot) => pack(theme_color(theme, slot))

  const rows: flat_row[] = []
  flatten_legacy_tree(nodes, state, default_expanded, 0, '', rows)

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
    const row = rows[i]!
    const ry = y + i * row_h - state.scroll.offset_y
    if (ry + row_h < y || ry > y + h) continue
    const selected = state.selected_id === row.id
    const hover = point_in(input, x, ry, w - scrollbar_w, row_h)
    if (selected) ui.fill_rect(x, ry, w - scrollbar_w, row_h, col('selected'))
    else if (hover) ui.fill_rect(x, ry, w - scrollbar_w, row_h, col('hover'))

    const tx = x + pad_x + row.depth * indent
    const cy = ry + row_h * 0.5

    if (row.dir) {
      const expanded = state.expanded.has(row.id) || (default_expanded && !state.expanded.has(`!${row.id}`))
      const tri = 3.4 * scale
      const tcx = tx + tri
      if (expanded) {
        ui.fill_triangle(tcx - tri, cy - tri * 0.6, tcx + tri, cy - tri * 0.6, tcx, cy + tri * 0.8, col('text_dim'))
      } else {
        ui.fill_triangle(tcx - tri * 0.6, cy - tri, tcx - tri * 0.6, cy + tri, tcx + tri * 0.8, cy, col('text_dim'))
      }
    }

    const icon = row.node.icon ?? (row.dir ? '📁' : '📄')
    const label_x = tx + 16 * scale
    ui.draw_text(label_x, ui.text_v_center_y(ry, row_h, font_px), `${icon}  ${row.node.name}`, font_px, selected ? col('text') : col('text_dim'), FONT_MAIN)

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

  if (scrollbar_w > 0) {
    const track_x = x + w - scrollbar_w
    ui.fill_rect(track_x, y, scrollbar_w, h, col('track'))
    const thumb_h = Math.max(20 * scale, (h / content_h) * h)
    const thumb_y = y + (state.scroll.offset_y / max_off) * (h - thumb_h)
    ui.fill_round_rect(track_x + 1 * scale, thumb_y, scrollbar_w - 2 * scale, thumb_h, 3 * scale, col('border_strong'))
  }

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

type flat_row = { node: file_node; id: string; depth: number; dir: boolean }

function flatten_legacy_tree(
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
      if (expanded) flatten_legacy_tree(node.children, state, default_expanded, depth + 1, path, out)
    }
  }
}

function toggle_expanded(state: file_browser_state, id: string, default_expanded: boolean): void {
  if (default_expanded) {
    const collapsed_key = `!${id}`
    if (state.expanded.has(collapsed_key)) state.expanded.delete(collapsed_key)
    else if (state.expanded.has(id)) state.expanded.delete(id)
    else state.expanded.add(collapsed_key)
  } else {
    if (state.expanded.has(id)) state.expanded.delete(id)
    else state.expanded.add(id)
  }
}

// --- conversion/helpers ---------------------------------------------------

function node_tree_to_folders(nodes: file_node[], root = 'Project'): file_browser_folder_node[] {
  const convert = (node: file_node, path: string): file_browser_folder_node | null => {
    if (!is_dir(node)) return null
    const children = (node.children ?? []).map((child) => convert(child, `${path}/${child.name}`)).filter((child): child is file_browser_folder_node => !!child)
    return { path, name: node.name, children }
  }
  const folders = nodes.map((node) => convert(node, node.name)).filter((node): node is file_browser_folder_node => !!node)
  return folders.length ? folders : [{ path: root, name: root }]
}

function node_tree_to_entries(nodes: file_node[], folder: string): file_browser_entry[] {
  const segments = folder.split('/').filter(Boolean)
  const folder_node = find_node_at_path(nodes, segments)
  const children = folder_node?.children ?? nodes
  return children.map((child) => {
    const path = [...segments, child.name].filter(Boolean).join('/')
    return {
      path,
      name: child.name,
      kind: is_dir(child) ? 'folder' as const : 'file' as const,
      type_label: is_dir(child) ? 'Folder' : file_type_label(child.name),
    }
  })
}

function find_node_at_path(nodes: file_node[], parts: string[]): file_node | null {
  if (parts.length === 0) return null
  let current = nodes.find((node) => node.name === parts[0])
  for (let i = 1; current && i < parts.length; i += 1) current = current.children?.find((node) => node.name === parts[i])
  return current ?? null
}

function node_id(node: file_node, path: string): string {
  return node.id ?? path
}

function is_dir(node: file_node): boolean {
  return node.kind === 'dir' || (node.kind === undefined && Array.isArray(node.children))
}

function base_name(name: string): string {
  const dot = name.indexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

function file_type_label(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith('.mesh.json')) return 'MESH'
  if (lower.endsWith('.texture.json')) return 'TEXTURE'
  if (lower.endsWith('.material.json')) return 'MATERIAL'
  if (lower.endsWith('.wgsl') || lower.endsWith('.glsl') || lower.endsWith('.frag') || lower.endsWith('.vert')) return 'SHADER'
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot >= name.length - 1) return 'FILE'
  return name.slice(dot + 1).toUpperCase()
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
