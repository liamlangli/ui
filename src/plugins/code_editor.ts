// code_editor — an immediate-mode, GPU-rendered code editor plugin.
//
// A self-contained editable text surface drawn through `ui_renderer`: a line
// number gutter, selection highlight, optional syntax highlighting, a blinking
// caret, mouse selection (click / drag / double-click word / triple-click
// line) and full keyboard editing (typing, Backspace/Delete, Enter with
// auto-indent, Tab, arrows, Home/End, PageUp/PageDown, Ctrl/Cmd+A, Ctrl/Cmd+C).
//
// The host owns the text model (a `text_buffer`) and the persistent view state
// (`code_editor_state`); everything else (scrolling, hit-testing, drawing,
// clipboard) lives here. Syntax highlighting is fully pluggable: pass a
// per-line `tokenize` function (e.g. backed by a language tokenizer / WASM) via
// the options — the toolkit stays language-agnostic and ships only a neutral
// default token palette.
//
//   const buf = new text_buffer('fn main() {}')
//   const state = create_code_editor_state()
//   // each frame, inside renderer.begin_frame()/flush():
//   code_editor(renderer, theme, input, x, y, w, h, buf, state, {
//     tokenize: (line) => my_tokenizer(line), // optional
//   })

import { pack_color, theme_color } from '../theme'
import type { theme_definition } from '../types'
import { draw_icon } from '../ui_icon'
import { FONT_MONO, ui_renderer } from '../ui_renderer'
import type { ui_input_snapshot, ui_scroll_state } from '../ui_widgets'
import { hori_split_view, type hori_split_view_state } from './hori_split_view'

// ── Text model ──────────────────────────────────────────────────────────────

export interface cursor_pos {
  line: number
  col: number
}

export interface selection {
  anchor: cursor_pos
  focus: cursor_pos
}

export interface selection_range {
  start: cursor_pos
  end: cursor_pos
}

/**
 * A line-based text buffer with a single cursor and optional selection. Pure
 * data + edit operations — it does no rendering and has no view state. Wire a
 * change listener with {@link text_buffer.on_change} (e.g. to re-run a parser
 * or mark a tab dirty).
 */
export class text_buffer {
  lines: string[]
  cursor: cursor_pos
  selection: selection | null

  private _on_change: (() => void) | null = null
  private _version = 0

  constructor(initial_text = '') {
    this.lines = initial_text ? initial_text.split('\n') : ['']
    this.cursor = { line: 0, col: 0 }
    this.selection = null
  }

  get version(): number {
    return this._version
  }

  on_change(fn: (() => void) | null): void {
    this._on_change = fn
  }

  private _dirty(): void {
    this._version++
    this._on_change?.()
  }

  get_text(): string {
    return this.lines.join('\n')
  }

  set_text(text: string): void {
    this.lines = text.split('\n')
    this.cursor = { line: 0, col: 0 }
    this.selection = null
    this._dirty()
  }

  line_count(): number {
    return this.lines.length
  }

  line_at(i: number): string {
    return i >= 0 && i < this.lines.length ? this.lines[i]! : ''
  }

  clamp_cursor(c: cursor_pos): cursor_pos {
    const line = Math.max(0, Math.min(c.line, this.lines.length - 1))
    const col = Math.max(0, Math.min(c.col, this.lines[line]!.length))
    return { line, col }
  }

  move_cursor(line: number, col: number, select = false): void {
    const next = this.clamp_cursor({ line, col })
    if (select) {
      if (!this.selection) this.selection = { anchor: { ...this.cursor }, focus: next }
      else this.selection.focus = next
    } else {
      this.selection = null
    }
    this.cursor = next
    this._dirty()
  }

  get_selection_range(): selection_range | null {
    if (!this.selection) return null
    const a = this.selection.anchor
    const b = this.selection.focus
    const a_less = a.line < b.line || (a.line === b.line && a.col <= b.col)
    return a_less ? { start: a, end: b } : { start: b, end: a }
  }

  selected_text(): string {
    const sel = this.get_selection_range()
    if (!sel) return ''
    const { start, end } = sel
    if (start.line === end.line) return this.lines[start.line]!.slice(start.col, end.col)
    const out: string[] = [this.lines[start.line]!.slice(start.col)]
    for (let l = start.line + 1; l < end.line; l++) out.push(this.lines[l]!)
    out.push(this.lines[end.line]!.slice(0, end.col))
    return out.join('\n')
  }

  delete_selection(): void {
    const sel = this.get_selection_range()
    if (!sel) return
    const { start, end } = sel
    const before = this.lines[start.line]!.slice(0, start.col)
    const after = this.lines[end.line]!.slice(end.col)
    this.lines.splice(start.line, end.line - start.line + 1, before + after)
    this.cursor = { ...start }
    this.selection = null
  }

  insert_text(text: string): void {
    if (this.selection) this.delete_selection()
    const parts = text.split('\n')
    const { line, col } = this.cursor
    const line_text = this.lines[line] ?? ''
    const before = line_text.slice(0, col)
    const after = line_text.slice(col)
    if (parts.length === 1) {
      this.lines[line] = before + parts[0]! + after
      this.cursor = { line, col: col + parts[0]!.length }
    } else {
      const new_lines: string[] = []
      new_lines.push(before + parts[0]!)
      for (let i = 1; i < parts.length - 1; i++) new_lines.push(parts[i]!)
      new_lines.push(parts[parts.length - 1]! + after)
      this.lines.splice(line, 1, ...new_lines)
      this.cursor = { line: line + parts.length - 1, col: parts[parts.length - 1]!.length }
    }
    this._dirty()
  }

  backspace(): void {
    if (this.selection) {
      this.delete_selection()
      this._dirty()
      return
    }
    const { line, col } = this.cursor
    if (col > 0) {
      this.lines[line] = this.lines[line]!.slice(0, col - 1) + this.lines[line]!.slice(col)
      this.cursor.col--
    } else if (line > 0) {
      const prev = this.lines[line - 1]!
      this.lines.splice(line - 1, 2, prev + this.lines[line]!)
      this.cursor = { line: line - 1, col: prev.length }
    }
    this._dirty()
  }

  delete_forward(): void {
    if (this.selection) {
      this.delete_selection()
      this._dirty()
      return
    }
    const { line, col } = this.cursor
    const line_text = this.lines[line]!
    if (col < line_text.length) {
      this.lines[line] = line_text.slice(0, col) + line_text.slice(col + 1)
    } else if (line < this.lines.length - 1) {
      this.lines.splice(line, 2, line_text + this.lines[line + 1]!)
    }
    this._dirty()
  }

  move_left(select = false): void {
    let { line, col } = this.cursor
    if (!select && this.selection) {
      const sel = this.get_selection_range()!
      this.move_cursor(sel.start.line, sel.start.col, false)
      return
    }
    if (col > 0) col--
    else if (line > 0) {
      line--
      col = this.lines[line]!.length
    }
    this.move_cursor(line, col, select)
  }

  move_right(select = false): void {
    let { line, col } = this.cursor
    if (!select && this.selection) {
      const sel = this.get_selection_range()!
      this.move_cursor(sel.end.line, sel.end.col, false)
      return
    }
    if (col < this.lines[line]!.length) col++
    else if (line < this.lines.length - 1) {
      line++
      col = 0
    }
    this.move_cursor(line, col, select)
  }

  move_up(select = false): void {
    const { line, col } = this.cursor
    this.move_cursor(line > 0 ? line - 1 : 0, col, select)
  }

  move_down(select = false): void {
    const { line, col } = this.cursor
    if (line < this.lines.length - 1) this.move_cursor(line + 1, col, select)
    else this.move_cursor(line, this.lines[line]!.length, select)
  }

  move_line_start(select = false): void {
    this.move_cursor(this.cursor.line, 0, select)
  }

  move_line_end(select = false): void {
    const { line } = this.cursor
    this.move_cursor(line, this.lines[line]!.length, select)
  }

  select_all(): void {
    const last = this.lines.length - 1
    this.selection = {
      anchor: { line: 0, col: 0 },
      focus: { line: last, col: this.lines[last]!.length },
    }
    this.cursor = this.selection.focus
    this._dirty()
  }

  /** Force a change notification without editing (e.g. after direct `lines` mutation). */
  mark_dirty(): void {
    this._dirty()
  }

  /** Leading whitespace of the previous line — used for Enter auto-indent. */
  auto_indent(): string {
    const { line } = this.cursor
    if (line === 0) return ''
    const prev = this.lines[line - 1]!
    const match = prev.match(/^(\s*)/)
    return match ? match[1]! : ''
  }
}

// ── Syntax highlighting ───────────────────────────────────────────────────────

/** Semantic class of a {@link editor_token}; maps to a colour. */
export type editor_token_kind =
  | 'keyword'
  | 'type'
  | 'number'
  | 'string'
  | 'comment'
  | 'operator'
  | 'identifier'
  | 'punctuation'
  | 'function'
  | 'whitespace'
  | 'plain'

export interface editor_token {
  kind: editor_token_kind
  text: string
}

/** An extra range highlight drawn behind the text (e.g. find-in-file matches). */
export interface editor_highlight {
  line: number
  col: number
  len: number
  /** Packed `0xAABBGGRR` colour or a `#rrggbb`/`#rrggbbaa` hex string. */
  color?: number | string
}

export interface code_editor_file_node {
  /** Stable id; if omitted a path-derived key is used. */
  id?: string
  name: string
  /** `'folder'`/`'dir'` shows a disclosure triangle; inferred from `children` when omitted. */
  kind?: 'file' | 'folder' | 'dir'
  children?: code_editor_file_node[]
}

/** Neutral default syntax palette (works on dark themes). Override per kind via options. */
const DEFAULT_TOKEN_COLORS: Record<editor_token_kind, string> = {
  keyword: '#7ab4ff',
  type: '#87e1b3',
  number: '#b8e292',
  string: '#e9bc84',
  comment: '#6b7a6b',
  operator: '#ef9a9a',
  identifier: '#e0e0ec',
  punctuation: '#c8c8d6',
  function: '#dbdbab',
  whitespace: '#00000000',
  plain: '#e0e0ec',
}

// ── View state + options ──────────────────────────────────────────────────────

export interface code_editor_state {
  /** Vertical scroll offset in physical px. */
  scroll: ui_scroll_state
  /** Horizontal scroll offset in physical px. */
  scroll_left: number
  /** Whether the editor currently holds keyboard focus. */
  focused: boolean
  /** When set, the next frame scrolls to bring this logical line into view, then clears it. */
  scroll_to_line: number | null
  /** Internal: last observed caret line, to follow the caret only when it moves (not while wheel-scrolling). */
  last_cursor_line: number
  /** Internal: last observed caret column. */
  last_cursor_col: number
  /** Internal: caret-blink phase origin (ms), reset on activity. */
  blink_start_ms: number
  /** Internal: timestamp of the last click, for double/triple-click detection. */
  last_click_ms: number
  /** Internal: consecutive-click streak (1 single, 2 word, 3 line). */
  click_streak: number
  /** Expanded folder ids for the optional file tree. */
  tree_expanded: Set<string>
  /** Selected node id in the optional file tree. */
  tree_selected_id: string | null
  /** Vertical scroll offset for the optional file tree, in physical px. */
  tree_scroll: ui_scroll_state
  /** Width and drag state for the optional file tree split. */
  tree_split?: hori_split_view_state
  /** Internal: last file-tree click target, for double-click activation. */
  tree_last_click_id: string | null
  /** Internal: timestamp of the last file-tree click. */
  tree_last_click_ms: number
}

export interface code_editor_options {
  /** Logical font size (multiplied by devicePixelRatio internally). Defaults to 13. */
  font_px?: number
  /** Extra vertical padding added to each line, in logical px. Defaults to 2. */
  line_pad?: number
  /** Disable all editing (cursor + selection + copy still work). Defaults to false. */
  read_only?: boolean
  /**
   * Let the plugin process keyboard from the input snapshot. Defaults to true.
   * Set false when the host owns the keyboard (drives the `text_buffer` itself)
   * — the plugin then only renders, scrolls, and handles mouse selection.
   */
  handle_keyboard?: boolean
  /**
   * Override caret visibility. When omitted the caret blinks while the editor
   * holds focus; pass a boolean to drive blink/visibility from the host.
   */
  caret_visible?: boolean
  /** Spaces inserted for a Tab key / used for auto-indent rounding. Defaults to 4. */
  tab_size?: number
  /** Draw the line-number gutter. Defaults to true. */
  show_line_numbers?: boolean
  /** Per-line tokenizer for syntax highlighting. Omit for plain (unhighlighted) text. */
  tokenize?: (line: string) => editor_token[]
  /** Override colours per token kind (packed number or hex string). */
  token_colors?: Partial<Record<editor_token_kind, number | string>>
  /** Extra range highlights drawn behind the text (e.g. find matches). */
  highlights?: editor_highlight[]
  /** Optional lightweight folder/file tree drawn to the left of the code surface. */
  file_tree?: code_editor_file_node[]
  /** Logical width of the optional file tree. Defaults to 180. */
  tree_width?: number
  /** Logical row height for the optional file tree. Defaults to 22. */
  tree_row_h?: number
  /** Logical per-depth indent for the optional file tree. Defaults to 14. */
  tree_indent?: number
  /** Auto-expand folders in the optional file tree on first render. Defaults to true. */
  tree_default_expanded?: boolean
}

/** A description of what changed in the editor this frame. */
export interface code_editor_event {
  /** The buffer text changed (insert / delete). */
  changed?: boolean
  /** The cursor or selection moved (without necessarily editing). */
  cursor_moved?: boolean
  /** Optional file tree: a node was clicked / focused this frame. */
  tree_selected?: code_editor_file_node
  /** Optional file tree: a file was double-clicked. */
  tree_activated?: code_editor_file_node
  /** Optional file tree: a folder's expanded state was toggled. */
  tree_toggled?: code_editor_file_node
}

export function create_code_editor_state(): code_editor_state {
  return {
    scroll: { offset_y: 0 },
    scroll_left: 0,
    focused: false,
    scroll_to_line: null,
    last_cursor_line: -1,
    last_cursor_col: -1,
    blink_start_ms: 0,
    last_click_ms: 0,
    click_streak: 1,
    tree_expanded: new Set<string>(),
    tree_selected_id: null,
    tree_scroll: { offset_y: 0 },
    tree_split: {},
    tree_last_click_id: null,
    tree_last_click_ms: 0,
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function point_in(input: ui_input_snapshot, x: number, y: number, w: number, h: number): boolean {
  return input.mouse_x >= x && input.mouse_y >= y && input.mouse_x < x + w && input.mouse_y < y + h
}

function to_packed(c: number | string): number {
  return typeof c === 'number' ? c : pack_color(c)
}

function is_word_char(ch: string): boolean {
  return /[\w$]/.test(ch)
}

function ensure_code_editor_state(state: code_editor_state): void {
  state.tree_expanded ??= new Set<string>()
  state.tree_selected_id ??= null
  state.tree_scroll ??= { offset_y: 0 }
  state.tree_split ??= {}
  state.tree_last_click_id ??= null
  state.tree_last_click_ms ??= 0
}

function toggle_tree_expanded(state: code_editor_state, id: string, default_expanded: boolean): void {
  if (default_expanded) {
    const collapsed_id = `!${id}`
    if (state.tree_expanded.has(collapsed_id)) state.tree_expanded.delete(collapsed_id)
    else state.tree_expanded.add(collapsed_id)
    return
  }
  if (state.tree_expanded.has(id)) state.tree_expanded.delete(id)
  else state.tree_expanded.add(id)
}

function is_tree_expanded(state: code_editor_state, id: string, default_expanded: boolean): boolean {
  return default_expanded ? !state.tree_expanded.has(`!${id}`) : state.tree_expanded.has(id)
}

type code_editor_tree_row = { node: code_editor_file_node; id: string; depth: number; folder: boolean }

function flatten_code_editor_tree(
  nodes: code_editor_file_node[],
  state: code_editor_state,
  default_expanded: boolean,
  depth: number,
  parent_path: string,
  out: code_editor_tree_row[],
): void {
  for (const node of nodes) {
    const id = node.id ?? (parent_path ? `${parent_path}/${node.name}` : node.name)
    const folder = node.kind === 'folder' || node.kind === 'dir' || !!node.children?.length
    out.push({ node, id, depth, folder })
    if (folder && is_tree_expanded(state, id, default_expanded)) {
      flatten_code_editor_tree(node.children ?? [], state, default_expanded, depth + 1, id, out)
    }
  }
}

// ── The widget ────────────────────────────────────────────────────────────────

export function code_editor(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  buffer: text_buffer,
  state: code_editor_state,
  options?: code_editor_options,
): code_editor_event {
  ensure_code_editor_state(state)
  const scale = window.devicePixelRatio || 1
  const fpx = (options?.font_px ?? 13) * scale
  const line_pad = (options?.line_pad ?? 2) * scale
  const read_only = options?.read_only === true
  const handle_keyboard = options?.handle_keyboard !== false
  const tab_size = options?.tab_size ?? 4
  const show_gutter = options?.show_line_numbers !== false
  const tokenize = options?.tokenize
  const start_version = buffer.version
  const event: code_editor_event = {}

  const col = (slot: Parameters<typeof theme_color>[1]) => pack_color(theme_color(theme, slot))
  const token_color = (kind: editor_token_kind): number => {
    const override = options?.token_colors?.[kind]
    return override != null ? to_packed(override) : pack_color(DEFAULT_TOKEN_COLORS[kind])
  }

  const char_w = Math.max(1, ui.mono_char_width(fpx, FONT_MONO))
  const line_h = ui.text_line_height(fpx, FONT_MONO) + line_pad
  const line_count = buffer.line_count()
  const tree_nodes = options?.file_tree ?? []
  const show_tree = tree_nodes.length > 0
  if (show_tree) state.tree_split ??= { left_w: (options?.tree_width ?? 180) * scale }
  const split = hori_split_view(ui, input, x, y, w, h, state.tree_split ?? {}, {
    show_left: show_tree,
    min_left: 72 * scale,
    min_right: char_w * 8,
    initial_left_w: (options?.tree_width ?? 180) * scale,
    separator_w: Math.max(1, scale),
    hit_pad: 2 * scale,
  })
  const tree_w = split.left.w
  const editor_x = split.right.x
  const editor_w = Math.max(char_w, split.right.w)

  const gutter_digits = Math.max(2, String(line_count).length)
  const gutter_pad = 6 * scale
  const gutter_w = show_gutter ? gutter_digits * char_w + gutter_pad * 2 : 0
  const code_x = editor_x + gutter_w
  const code_w = Math.max(char_w, editor_w - gutter_w)
  const scrollbar_w = 8 * scale
  if (!read_only) {
    const regions = input.native_text_regions ?? []
    regions.push({ id: 'code_editor', x: code_x, y, w: code_w, h, mode: 'multiline' })
    input.native_text_regions = regions
  }

  const visible_rows = Math.max(1, Math.floor(h / line_h))
  const content_h = line_count * line_h
  const max_scroll = Math.max(0, content_h - h)

  // Honour a host-requested scroll-to-line before computing visibility.
  if (state.scroll_to_line != null) {
    const target = Math.max(0, Math.min(line_count - 1, state.scroll_to_line))
    state.scroll.offset_y = Math.max(0, Math.min(max_scroll, target * line_h))
    state.scroll_to_line = null
  }

  // ── Background + gutter ───────────────────────────────────────────────────
  ui.fill_rect(x, y, w, h, col('bg'))
  if (show_gutter) ui.fill_rect(editor_x, y, gutter_w, h, col('bg'))

  // ── Optional folder/file tree ─────────────────────────────────────────────
  if (show_tree) {
    const tree_event = draw_file_tree(
      ui,
      theme,
      input,
      x,
      y,
      tree_w,
      h,
      tree_nodes,
      state,
      options?.font_px ?? 13,
      options?.tree_row_h ?? 22,
      options?.tree_indent ?? 14,
      options?.tree_default_expanded ?? true,
    )
    if (tree_event.tree_selected) event.tree_selected = tree_event.tree_selected
    if (tree_event.tree_activated) event.tree_activated = tree_event.tree_activated
    if (tree_event.tree_toggled) event.tree_toggled = tree_event.tree_toggled
    ui.fill_rect(split.separator.x, split.separator.y, Math.max(1, split.separator.w), split.separator.h, col('border'))
  }

  // ── Mouse hit-testing → logical {line, col} ───────────────────────────────
  const hit_test = (mx: number, my: number): cursor_pos => {
    const line = Math.max(0, Math.min(line_count - 1, Math.floor((my - y + state.scroll.offset_y) / line_h)))
    const rel_x = mx - code_x + state.scroll_left
    const c = Math.max(0, Math.min(buffer.line_at(line).length, Math.round(rel_x / char_w)))
    return { line, col: c }
  }

  // ── Wheel scrolling ───────────────────────────────────────────────────────
  if (point_in(input, editor_x, y, editor_w, h) && input.wheel_y) {
    state.scroll.offset_y = Math.max(0, Math.min(max_scroll, state.scroll.offset_y - input.wheel_y * 3 * line_h * 0.33))
  }

  // ── Focus + mouse selection ───────────────────────────────────────────────
  const over_code = point_in(input, code_x, y, code_w - scrollbar_w, h)
  const over_editor = point_in(input, editor_x, y, editor_w, h)
  if (input.mouse_pressed) {
    if (over_editor) {
      state.focused = true
      state.blink_start_ms = performance.now()
      if (over_code) {
        const now = performance.now()
        const pos = hit_test(input.mouse_x, input.mouse_y)
        if (now - state.last_click_ms < 320) state.click_streak = Math.min(3, state.click_streak + 1)
        else state.click_streak = 1
        state.last_click_ms = now

        if (state.click_streak === 2) {
          select_word(buffer, pos)
        } else if (state.click_streak >= 3) {
          buffer.move_cursor(pos.line, 0, false)
          buffer.move_cursor(pos.line, buffer.line_at(pos.line).length, true)
        } else {
          buffer.move_cursor(pos.line, pos.col, input.shift)
        }
      }
    } else if (!point_in(input, x, y, w, h)) {
      state.focused = false
    }
  } else if (input.mouse_down && state.focused && over_code && state.click_streak < 2) {
    // Drag-extend selection.
    const pos = hit_test(input.mouse_x, input.mouse_y)
    buffer.move_cursor(pos.line, pos.col, true)
  }

  if (over_code) ui.set_cursor('text')

  // ── Keyboard ──────────────────────────────────────────────────────────────
  if (handle_keyboard && state.focused) handle_keys(buffer, input, read_only, tab_size)
  if (state.focused && !read_only) {
    input.native_text_input = {
      id: 'code_editor',
      x: code_x,
      y,
      w: code_w,
      h,
      value: buffer.get_text(),
      cursor: buffer.cursor.col,
      selection_start: buffer.cursor.col,
      selection_end: buffer.cursor.col,
      mode: 'multiline',
    }
  }

  // Reset the blink whenever the buffer changed (typing / cursor move).
  if (buffer.version !== start_version) state.blink_start_ms = performance.now()

  // ── Keep the caret in view — only when it actually moved, so free
  // wheel-scrolling away from the caret isn't immediately snapped back. ───────
  const caret_moved = buffer.cursor.line !== state.last_cursor_line || buffer.cursor.col !== state.last_cursor_col
  state.last_cursor_line = buffer.cursor.line
  state.last_cursor_col = buffer.cursor.col
  if (caret_moved) {
    const caret_top = buffer.cursor.line * line_h
    if (caret_top < state.scroll.offset_y) state.scroll.offset_y = caret_top
    else if (caret_top + line_h > state.scroll.offset_y + h) state.scroll.offset_y = caret_top + line_h - h

    const caret_x_px = buffer.cursor.col * char_w
    if (caret_x_px < state.scroll_left) state.scroll_left = caret_x_px
    else if (caret_x_px + char_w > state.scroll_left + (code_w - scrollbar_w)) {
      state.scroll_left = caret_x_px + char_w - (code_w - scrollbar_w)
    }
  }
  state.scroll.offset_y = Math.max(0, Math.min(max_scroll, state.scroll.offset_y))
  state.scroll_left = Math.max(0, state.scroll_left)

  const scroll_t = state.scroll.offset_y
  const first_line = Math.max(0, Math.floor(scroll_t / line_h))

  // ── Clip the code area and paint ──────────────────────────────────────────
  ui.push_clip(editor_x, y, editor_w, h)

  // Selection highlight.
  const sel = buffer.get_selection_range()
  if (sel) {
    const sel_color = col('selected')
    for (let l = sel.start.line; l <= sel.end.line; l++) {
      const ry = y + l * line_h - scroll_t
      if (ry + line_h < y || ry > y + h) continue
      const len = buffer.line_at(l).length
      const sc = l === sel.start.line ? sel.start.col : 0
      const ec = l === sel.end.line ? sel.end.col : len
      const sx = code_x + sc * char_w - state.scroll_left
      const sw = Math.max(l < sel.end.line ? char_w * 0.4 : 0, (ec - sc) * char_w)
      if (sw > 0) ui.fill_rect(sx, ry, sw, line_h, sel_color)
    }
  }

  // Extra range highlights (e.g. find matches).
  if (options?.highlights?.length) {
    const default_hl = (col('accent') & 0x00ffffff) | (0x55 << 24)
    for (const m of options.highlights) {
      const ry = y + m.line * line_h - scroll_t
      if (ry + line_h < y || ry > y + h) continue
      const mx = code_x + m.col * char_w - state.scroll_left
      ui.fill_rect(mx, ry, m.len * char_w, line_h, m.color != null ? to_packed(m.color) : default_hl)
    }
  }

  // Text lines + line numbers.
  const gutter_color = col('text_dim')
  const plain_color = token_color('plain')
  for (let vi = 0; vi <= visible_rows; vi++) {
    const li = first_line + vi
    if (li >= line_count) break
    const row_y = y + li * line_h - scroll_t
    const text_y = ui.text_v_center_y(row_y, line_h, fpx, FONT_MONO)

    if (show_gutter) {
      const num = String(li + 1).padStart(gutter_digits, ' ')
      ui.draw_text(editor_x + gutter_pad, text_y, num, fpx, gutter_color, FONT_MONO)
    }

    const line_str = buffer.line_at(li)
    const base_x = code_x - state.scroll_left
    if (tokenize) {
      let cx = base_x
      for (const tok of tokenize(line_str)) {
        if (tok.kind !== 'whitespace' && tok.text.trim().length > 0) {
          ui.draw_text(cx, text_y, tok.text, fpx, token_color(tok.kind), FONT_MONO)
        }
        cx += tok.text.length * char_w
      }
    } else if (line_str.length > 0) {
      ui.draw_text(base_x, text_y, line_str, fpx, plain_color, FONT_MONO)
    }
  }

  // Caret. The host can override visibility (e.g. drive its own blink);
  // otherwise it blinks while the editor holds focus.
  const caret_on =
    options?.caret_visible != null
      ? options.caret_visible
      : state.focused && (performance.now() - state.blink_start_ms) % 1060 < 600
  if (caret_on) {
    const cy = y + buffer.cursor.line * line_h - scroll_t
    const cx = code_x + buffer.cursor.col * char_w - state.scroll_left
    if (cy + line_h >= y && cy <= y + h) {
      const composition = input.ime_composition ?? ''
      if (composition) {
        const comp_w = ui.text_width(composition, fpx, FONT_MONO)
        ui.draw_text(cx, ui.text_v_center_y(cy, line_h, fpx, FONT_MONO), composition, fpx, col('text_dim'), FONT_MONO)
        ui.fill_rect(cx, cy + line_h - 3 * scale, Math.max(1, comp_w), Math.max(1, scale), col('accent'))
      }
      ui.fill_rect(cx, cy, Math.max(1, scale), line_h, col('text'))
    }
  }

  ui.pop_clip()

  // ── Vertical scrollbar ─────────────────────────────────────────────────────
  if (content_h > h) {
    const track_x = editor_x + editor_w - scrollbar_w
    ui.fill_rect(track_x, y, scrollbar_w, h, col('track'))
    const thumb_h = Math.max(20 * scale, (h / content_h) * h)
    const thumb_y = y + (state.scroll.offset_y / max_scroll) * (h - thumb_h)
    ui.fill_round_rect(track_x + 1 * scale, thumb_y, scrollbar_w - 2 * scale, thumb_h, 3 * scale, col('border_strong'))
  }

  const changed = buffer.version !== start_version
  event.changed = changed
  event.cursor_moved = changed
  return event
}

function draw_file_tree(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  nodes: code_editor_file_node[],
  state: code_editor_state,
  font_px_logical: number,
  row_h_logical: number,
  indent_logical: number,
  default_expanded: boolean,
): code_editor_event {
  const scale = window.devicePixelRatio || 1
  const font_px = font_px_logical * scale
  const row_h = row_h_logical * scale
  const indent = indent_logical * scale
  const col = (slot: Parameters<typeof theme_color>[1]) => pack_color(theme_color(theme, slot))
  const rows: code_editor_tree_row[] = []
  flatten_code_editor_tree(nodes, state, default_expanded, 0, '', rows)

  const content_h = rows.length * row_h
  const scrollbar_w = content_h > h ? 7 * scale : 0
  const max_scroll = Math.max(0, content_h - h)
  if (point_in(input, x, y, w, h) && input.wheel_y) {
    state.tree_scroll.offset_y = Math.max(0, Math.min(max_scroll, state.tree_scroll.offset_y - input.wheel_y * 20 * scale))
  }
  state.tree_scroll.offset_y = Math.max(0, Math.min(max_scroll, state.tree_scroll.offset_y))

  const event: code_editor_event = {}
  const pad_x = 7 * scale
  const icon_w = 14 * scale

  ui.fill_rect(x, y, w, h, col('panel'))
  ui.push_clip(x, y, w, h)

  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]!
    const ry = y + i * row_h - state.tree_scroll.offset_y
    if (ry + row_h < y || ry > y + h) continue
    const hot = point_in(input, x, ry, w - scrollbar_w, row_h)
    const selected = state.tree_selected_id === row.id
    if (selected) ui.fill_rect(x + 3 * scale, ry, w - scrollbar_w - 6 * scale, row_h, col('selected'))
    else if (hot) ui.fill_rect(x + 3 * scale, ry, w - scrollbar_w - 6 * scale, row_h, col('hover'))

    const tx = x + pad_x + row.depth * indent
    const cy = ry + row_h * 0.5
    const glyph_color = selected ? col('text') : col('text_dim')
    const icon_size = 15 * scale
    const icon_name = row.folder
      ? is_tree_expanded(state, row.id, default_expanded)
        ? 'chevron_down'
        : 'chevron_right'
      : 'file'
    draw_icon(ui, icon_name, tx + 0.5 * scale, cy - icon_size * 0.5, icon_size, glyph_color)

    const label_x = tx + icon_w + 2 * scale
    ui.push_clip(label_x, ry, Math.max(0, x + w - scrollbar_w - label_x - 4 * scale), row_h)
    ui.draw_text(label_x, ui.text_v_center_y(ry, row_h, font_px, FONT_MONO), row.node.name, font_px, selected ? col('text') : col('text_dim'), FONT_MONO)
    ui.pop_clip()

    if (hot && input.mouse_pressed) {
      const now = performance.now()
      const double = state.tree_last_click_id === row.id && now - state.tree_last_click_ms < 320
      state.tree_selected_id = row.id
      state.tree_last_click_id = row.id
      state.tree_last_click_ms = now
      event.tree_selected = row.node
      if (row.folder) {
        toggle_tree_expanded(state, row.id, default_expanded)
        event.tree_toggled = row.node
      } else if (double) {
        event.tree_activated = row.node
      }
    }
  }

  ui.pop_clip()

  if (scrollbar_w > 0) {
    const track_x = x + w - scrollbar_w
    ui.fill_rect(track_x, y, scrollbar_w, h, col('track'))
    const thumb_h = Math.max(20 * scale, (h / content_h) * h)
    const thumb_y = y + (state.tree_scroll.offset_y / max_scroll) * (h - thumb_h)
    ui.fill_round_rect(track_x + 1 * scale, thumb_y, scrollbar_w - 2 * scale, thumb_h, 3 * scale, col('border_strong'))
  }

  return event
}

// ── Internal: keyboard + selection ────────────────────────────────────────────

function select_word(buffer: text_buffer, pos: cursor_pos): void {
  const line = buffer.line_at(pos.line)
  if (pos.col >= line.length && line.length === 0) {
    buffer.move_cursor(pos.line, 0, false)
    return
  }
  const seed = line[Math.min(pos.col, line.length - 1)] ?? ''
  const matches = is_word_char(seed) ? is_word_char : (ch: string) => !is_word_char(ch) && !/\s/.test(ch)
  let s = Math.min(pos.col, line.length - 1)
  let e = s
  while (s > 0 && matches(line[s - 1]!)) s--
  while (e < line.length && matches(line[e]!)) e++
  buffer.move_cursor(pos.line, s, false)
  buffer.move_cursor(pos.line, e, true)
}

function handle_keys(buffer: text_buffer, input: ui_input_snapshot, read_only: boolean, tab_size: number): void {
  const mod = input.ctrl || input.meta
  const shift = input.shift

  // Navigation (always available, even read-only).
  if (input.key_left) buffer.move_left(shift)
  if (input.key_right) buffer.move_right(shift)
  if (input.key_up) buffer.move_up(shift)
  if (input.key_down) buffer.move_down(shift)
  if (input.key_home) buffer.move_line_start(shift)
  if (input.key_end) buffer.move_line_end(shift)

  if (mod && input.key_a) buffer.select_all()
  if (mod && input.key_c) copy_to_clipboard(buffer.selected_text())

  if (read_only) return

  // Editing.
  if (input.key_backspace) buffer.backspace()
  if (input.key_delete) buffer.delete_forward()
  if (input.key_enter) {
    const indent = buffer.auto_indent()
    buffer.insert_text('\n' + indent)
  }

  // Printable text (the host already strips text when ctrl/meta is held). A Tab
  // surfaced as a literal '\t' is expanded to spaces.
  if (!mod && input.typed_text) {
    buffer.insert_text(input.typed_text.replace(/\t/g, ' '.repeat(tab_size)))
  }
}

function copy_to_clipboard(text: string): void {
  if (!text) return
  try {
    navigator.clipboard?.writeText(text)
  } catch {
    /* clipboard unavailable (insecure context / permissions) — ignore */
  }
}
