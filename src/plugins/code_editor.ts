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
import { FONT_MONO, ui_renderer } from '../ui_renderer'
import type { ui_input_snapshot, ui_scroll_state } from '../ui_widgets'

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
}

/** A description of what changed in the editor this frame. */
export interface code_editor_event {
  /** The buffer text changed (insert / delete). */
  changed?: boolean
  /** The cursor or selection moved (without necessarily editing). */
  cursor_moved?: boolean
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
  const scale = window.devicePixelRatio || 1
  const fpx = (options?.font_px ?? 13) * scale
  const line_pad = (options?.line_pad ?? 2) * scale
  const read_only = options?.read_only === true
  const handle_keyboard = options?.handle_keyboard !== false
  const tab_size = options?.tab_size ?? 4
  const show_gutter = options?.show_line_numbers !== false
  const tokenize = options?.tokenize
  const start_version = buffer.version

  const col = (slot: Parameters<typeof theme_color>[1]) => pack_color(theme_color(theme, slot))
  const token_color = (kind: editor_token_kind): number => {
    const override = options?.token_colors?.[kind]
    return override != null ? to_packed(override) : pack_color(DEFAULT_TOKEN_COLORS[kind])
  }

  const char_w = Math.max(1, ui.mono_char_width(fpx, FONT_MONO))
  const line_h = ui.text_line_height(fpx, FONT_MONO) + line_pad
  const line_count = buffer.line_count()

  const gutter_digits = Math.max(2, String(line_count).length)
  const gutter_pad = 6 * scale
  const gutter_w = show_gutter ? gutter_digits * char_w + gutter_pad * 2 : 0
  const code_x = x + gutter_w
  const code_w = Math.max(char_w, w - gutter_w)
  const scrollbar_w = 8 * scale

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
  if (show_gutter) ui.fill_rect(x, y, gutter_w, h, col('panel'))

  // ── Mouse hit-testing → logical {line, col} ───────────────────────────────
  const hit_test = (mx: number, my: number): cursor_pos => {
    const line = Math.max(0, Math.min(line_count - 1, Math.floor((my - y + state.scroll.offset_y) / line_h)))
    const rel_x = mx - code_x + state.scroll_left
    const c = Math.max(0, Math.min(buffer.line_at(line).length, Math.round(rel_x / char_w)))
    return { line, col: c }
  }

  // ── Wheel scrolling ───────────────────────────────────────────────────────
  if (point_in(input, x, y, w, h) && input.wheel_y) {
    state.scroll.offset_y = Math.max(0, Math.min(max_scroll, state.scroll.offset_y - input.wheel_y * 3 * line_h * 0.33))
  }

  // ── Focus + mouse selection ───────────────────────────────────────────────
  const over_code = point_in(input, code_x, y, code_w - scrollbar_w, h)
  if (input.mouse_pressed) {
    if (point_in(input, x, y, w, h)) {
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
    } else {
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
  ui.push_clip(x, y, w, h)

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
      ui.draw_text(x + gutter_pad, text_y, num, fpx, gutter_color, FONT_MONO)
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
    if (cy + line_h >= y && cy <= y + h) ui.fill_rect(cx, cy, Math.max(1, scale), line_h, col('text'))
  }

  ui.pop_clip()

  // ── Vertical scrollbar ─────────────────────────────────────────────────────
  if (content_h > h) {
    const track_x = x + w - scrollbar_w
    ui.fill_rect(track_x, y, scrollbar_w, h, col('track'))
    const thumb_h = Math.max(20 * scale, (h / content_h) * h)
    const thumb_y = y + (state.scroll.offset_y / max_scroll) * (h - thumb_h)
    ui.fill_round_rect(track_x + 1 * scale, thumb_y, scrollbar_w - 2 * scale, thumb_h, 3 * scale, col('border_strong'))
  }

  const changed = buffer.version !== start_version
  return { changed, cursor_moved: changed }
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
