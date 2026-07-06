import { theme_color } from './ui_theme'
import type { theme_definition } from './ui_types'
import { FONT_MONO, ui_renderer } from './ui_renderer'
import { set_stack_layout_debug_context } from './ui_stack_layout'

export interface ui_input_snapshot {
  mouse_x: number
  mouse_y: number
  mouse_down: boolean
  mouse_pressed: boolean
  mouse_released: boolean
  /** True when the most recent pointer contact came from a touch (vs mouse/pen). */
  pointer_is_touch?: boolean
  /** Middle mouse button held (level). Optional; used by the graph plugin to pan. */
  mouse_middle_down?: boolean
  /** Right mouse button pressed this frame (edge). Optional; used by the graph plugin to open a create menu. */
  mouse_right_pressed?: boolean
  /** Right mouse button held (level). Optional; used by the graph plugin to pan on right-drag. */
  mouse_right_down?: boolean
  /** Pan delta in physical pixels for this frame, e.g. from a two-finger touch drag. */
  pan_dx?: number
  pan_dy?: number
  /**
   * Multiplicative zoom factor for this frame from a pinch gesture (1 = no change),
   * anchored at the current `mouse_x`/`mouse_y` (the gesture centroid).
   */
  zoom_factor?: number
  wheel_y: number
  typed_text: string
  key_backspace: boolean
  key_delete: boolean
  key_enter: boolean
  key_escape: boolean
  key_left: boolean
  key_right: boolean
  key_home: boolean
  key_end: boolean
  shift: boolean
  gizmo_manipulating: boolean
  /** Ctrl modifier — used for Ctrl+C / Ctrl+A in the text view. Optional for back-compat. */
  ctrl?: boolean
  /** Cmd / Meta modifier (macOS) — used for Cmd+C / Cmd+A in the text view. */
  meta?: boolean
  /** Alt / Option modifier — used by the graph plugin to alt-click a wire to cut it. */
  alt?: boolean
  key_up?: boolean
  key_down?: boolean
  key_page_up?: boolean
  key_page_down?: boolean
  /** F12 key edge, used by host/debug integrations such as GPU capture. */
  key_f12?: boolean
  /** `a` key — combined with ctrl/meta for select-all in the text view. */
  key_a?: boolean
  /** `c` key — combined with ctrl/meta for copy in the text view. */
  key_c?: boolean
  /** Current native IME preedit text, supplied by the host input bridge. */
  ime_composition?: string
  /**
   * Set by text widgets while focused so the host input bridge can focus and
   * position a hidden native input/textarea for IME.
   */
  native_text_input?: ui_native_text_input | null
  /**
   * Text-capable hit regions from the previous render. Hosts can use this to
   * focus a hidden native input synchronously during pointerdown on mobile.
   */
  native_text_regions?: ui_native_text_region[]
}

export interface ui_native_text_region {
  id: string
  x: number
  y: number
  w: number
  h: number
  mode?: 'text' | 'numeric' | 'multiline'
}

export interface ui_native_text_input extends ui_native_text_region {
  value: string
  cursor: number
  selection_start: number
  selection_end: number
}

export interface ui_scroll_state {
  offset_y: number
}

export interface ui_input_text_state {
  cursor: number
  sel_anchor: number
  sel_head: number
}

export interface ui_number_input_state extends ui_input_text_state {
  draft: string
}

export interface ui_menu_item {
  label: string
  separator?: boolean
  disabled?: boolean
  submenu?: ui_menu_item[]
}

export interface ui_color_rgba {
  r: number
  g: number
  b: number
  a: number
}

/** A single line of content for {@link ui_widgets.text_view}. */
export interface ui_text_view_line {
  text: string
  /** Per-line color: a packed `0xAABBGGRR` number, a `#rrggbb`/`#rrggbbaa` string, or undefined for the theme text color. */
  color?: number | string
}

/** A caret / selection endpoint within a {@link ui_widgets.text_view}, as a logical `{ line, col }`. */
export interface ui_text_pos {
  line: number
  col: number
}

/** Persistent per-frame state for a {@link ui_widgets.text_view}. Create with {@link create_text_view_state}. */
export interface ui_text_view_state {
  /** Vertical scroll offset in pixels (readable + writable). */
  scroll_top: number
  /** Selection anchor (where the drag/selection began). */
  anchor: ui_text_pos
  /** Selection focus (the moving end / caret). */
  focus: ui_text_pos
  /** Whether the panel currently holds keyboard focus. */
  focused: boolean
  /** When set, the next frame scrolls to bring this logical line into view, then clears it. */
  scroll_to_line: number | null
  /** Internal: timestamp of the last click, for double/triple-click detection. */
  last_click_ms: number
  /** Internal: line of the last click. */
  last_click_line: number
  /** Internal: column of the last click. */
  last_click_col: number
  /** Internal: consecutive-click streak (1 = single, 2 = double/word, 3 = triple/line). */
  click_streak: number
}

export interface ui_text_view_options {
  /** Logical font size (multiplied by devicePixelRatio internally). Defaults to 13. */
  font_px?: number
  /** Soft-wrap long lines to the panel width (char-level, like `pre-wrap` + `break-word`). Defaults to false. */
  wrap?: boolean
  /** Draw a rounded panel background + border. Defaults to true. */
  background?: boolean
  /** Extra vertical padding added to each line, in logical px. Defaults to 2. */
  line_pad?: number
  /** Disable selection / clipboard / focus (pure read-only viewer). Defaults to false. */
  read_only?: boolean
}

export function create_text_view_state(): ui_text_view_state {
  return {
    scroll_top: 0,
    anchor: { line: 0, col: 0 },
    focus: { line: 0, col: 0 },
    focused: false,
    scroll_to_line: null,
    last_click_ms: 0,
    last_click_line: -1,
    last_click_col: -1,
    click_streak: 0,
  }
}

type text_view_vrow = { line: number; start: number; end: number }

function text_pos_le(a: ui_text_pos, b: ui_text_pos): boolean {
  return a.line < b.line || (a.line === b.line && a.col <= b.col)
}

function normalize_text_sel(a: ui_text_pos, b: ui_text_pos): [ui_text_pos, ui_text_pos] {
  return text_pos_le(a, b) ? [a, b] : [b, a]
}

function has_text_selection(state: ui_text_view_state): boolean {
  return state.anchor.line !== state.focus.line || state.anchor.col !== state.focus.col
}

function is_word_char(ch: string): boolean {
  return /[\w$]/.test(ch)
}

/** Extract the currently selected text from a {@link ui_widgets.text_view}, joined with `\n` (empty if no selection). */
export function text_view_selected_text(lines: ui_text_view_line[], state: ui_text_view_state): string {
  if (!has_text_selection(state)) return ''
  const [start, end] = normalize_text_sel(state.anchor, state.focus)
  const line_text = (i: number): string => lines[i]?.text ?? ''
  if (start.line === end.line) return line_text(start.line).slice(start.col, end.col)
  const parts: string[] = [line_text(start.line).slice(start.col)]
  for (let i = start.line + 1; i < end.line; i += 1) parts.push(line_text(i))
  parts.push(line_text(end.line).slice(0, end.col))
  return parts.join('\n')
}

const w_font_px = 12
const w_row_h = 28
const w_radius = 3
const w_scrollbar_w = 7
const w_scrollbar_min = 20
const w_toggle_h = 18
const w_slider_thumb = 11
const w_pad = 8
const w_popup_item_h = 22
const w_section_h = 22
const w_popup_safe_margin = 6

function clamp_01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function pack_rgba(r: number, g: number, b: number, a: number): number {
  const rr = Math.round(clamp_01(r) * 255)
  const gg = Math.round(clamp_01(g) * 255)
  const bb = Math.round(clamp_01(b) * 255)
  const aa = Math.round(clamp_01(a) * 255)
  return (((aa & 255) << 24) | ((bb & 255) << 16) | ((gg & 255) << 8) | (rr & 255)) >>> 0
}

export function create_empty_ui_input(): ui_input_snapshot {
  return {
    mouse_x: 0,
    mouse_y: 0,
    mouse_down: false,
    mouse_pressed: false,
    mouse_released: false,
    pointer_is_touch: false,
    mouse_middle_down: false,
    mouse_right_pressed: false,
    mouse_right_down: false,
    pan_dx: 0,
    pan_dy: 0,
    zoom_factor: 1,
    wheel_y: 0,
    typed_text: '',
    key_backspace: false,
    key_delete: false,
    key_enter: false,
    key_escape: false,
    key_left: false,
    key_right: false,
    key_home: false,
    key_end: false,
    shift: false,
    gizmo_manipulating: false,
    ctrl: false,
    meta: false,
    key_up: false,
    key_down: false,
    key_page_up: false,
    key_page_down: false,
    key_f12: false,
    key_a: false,
    key_c: false,
    ime_composition: '',
    native_text_input: null,
    native_text_regions: [],
  }
}

type dropdown_popup = {
  id: string
  x: number
  y: number
  w: number
  h: number
  items: string[]
  selected_ref: { value: number }
}

type color_picker_popup = {
  id: string
  x: number
  y: number
  w: number
  h: number
  color_ref: ui_color_rgba
  popup_w?: number
}

type popup_placement = {
  x: number
  y: number
  w: number
  h: number
}

export class ui_widgets {
  private theme!: theme_definition
  private input: ui_input_snapshot = create_empty_ui_input()
  private active_id: string | null = null
  private focused_input_id: string | null = null
  private pending_focused_input_id: string | null = null
  private open_dropdown_id: string | null = null
  private pending_dropdown: dropdown_popup | null = null
  private open_dropdown_popup_rect: { id: string; x: number; y: number; w: number; h: number } | null = null
  private dropdown_selections = new Map<string, number>()
  private focused_number_id: string | null = null
  private open_color_picker_id: string | null = null
  private pending_color_picker: color_picker_popup | null = null
  private open_color_picker_popup_rect: { id: string; x: number; y: number; w: number; h: number } | null = null
  private readonly color_picker_values = new Map<string, ui_color_rgba>()
  private readonly color_picker_number_inputs = new Map<string, ui_number_input_state>()
  private is_inside_popup_rendering = false
  private readonly pending_stack_debug_wireframes: Array<{ x: number; y: number; w: number; h: number }> = []

  constructor(private readonly ui: ui_renderer) {}

  begin_frame(theme: theme_definition, input: ui_input_snapshot): void {
    this.theme = theme
    this.input = input
    this.pending_dropdown = null
    this.pending_color_picker = null
    this.pending_stack_debug_wireframes.length = 0
    set_stack_layout_debug_context(input, (x, y, w, h) => this.queue_stack_debug_wireframe(x, y, w, h))
    if (this.open_dropdown_id == null) this.open_dropdown_popup_rect = null
    if (this.open_color_picker_id == null) this.open_color_picker_popup_rect = null
    if (!input.mouse_down && this.active_id) this.active_id = null
    input.native_text_input = null
    input.native_text_regions = []
  }

  end_frame(): void {
    this.is_inside_popup_rendering = true
    if (this.pending_dropdown) this.render_dropdown_popup(this.pending_dropdown)
    if (this.pending_color_picker) this.render_color_picker_popup(this.pending_color_picker)
    this.is_inside_popup_rendering = false
    this.render_stack_debug_wireframes()
    set_stack_layout_debug_context(null, null)
  }

  queue_stack_debug_wireframe(x: number, y: number, w: number, h: number): void {
    this.pending_stack_debug_wireframes.push({ x, y, w, h })
  }

  section(x: number, y: number, w: number, label: string): number {
    const scale = window.devicePixelRatio || 1
    const section_h = w_section_h * scale
    // Still advance layout by the section height even when culled, so callers
    // stacking widgets below keep their positions.
    if (this.ui.rect_clipped(x, y, w, section_h)) return y + section_h
    const pad = w_pad * scale
    this.ui.draw_text(x + pad, this.ui.text_v_center_y(y, section_h, w_font_px * scale), label, w_font_px * scale, this.color('text_dim'))
    const lw = this.ui.text_width(label, w_font_px * scale) + pad * 2
    this.ui.fill_rect(x + lw, y + section_h * 0.5, Math.max(0, w - lw - 4 * scale), 1, this.color('border'))
    return y + section_h
  }

  button(id: string, x: number, y: number, w: number, h: number, label: string, options?: { active?: boolean }): boolean {
    if (this.ui.rect_clipped(x, y, w, h)) return false
    const scale = window.devicePixelRatio || 1
    const hover = this.point_in(x, y, w, h)
    const active = options?.active === true
    if (hover && this.input.mouse_pressed) this.active_id = id
    const pressed = this.active_id === id && this.input.mouse_down && hover
    const bg = pressed || active ? this.color('active') : hover ? this.color('hover') : this.color('selected')
    const border = active ? this.color('accent') : this.color('border_strong')
    const r = w_radius * scale
    this.ui.fill_round_rect(x, y, w, h, r, bg)
    this.ui.stroke_round_rect(x, y, w, h, r, 1, border)
    const font_px = w_font_px * scale
    const text_w = this.ui.text_width(label, font_px)
    this.ui.draw_text(x + Math.max(0, (w - text_w) * 0.5), this.ui.text_v_center_y(y, h, font_px), label, font_px, this.color('text'))
    return hover && this.input.mouse_pressed
  }

  toggle(_id: string, x: number, y: number, value: boolean, label?: string): boolean {
    const scale = window.devicePixelRatio || 1
    const box_size = Math.max(8 * scale, (w_toggle_h - 3) * scale)
    const label_gap = label ? 7 * scale : 0
    const label_w = label ? this.ui.text_width(label, w_font_px * scale) : 0
    const hit_w = box_size + label_gap + label_w
    if (this.ui.rect_clipped(x, y, hit_w, box_size)) return value
    const hover = this.point_in(x, y, hit_w, box_size)
    if (hover && this.input.mouse_pressed) value = !value
    const box_r = 2 * scale
    this.ui.fill_round_rect(x, y, box_size, box_size, box_r, hover ? this.color('panel_alt') : this.color('track'))
    this.ui.stroke_round_rect(x, y, box_size, box_size, box_r, 1, value ? this.color('accent') : this.color('border_strong'))
    if (value) {
      const inner_pad = 4 * scale
      const inner_r = Math.max(0, box_r - 1 * scale)
      this.ui.fill_round_rect(x + inner_pad, y + inner_pad, Math.max(0, box_size - inner_pad * 2), Math.max(0, box_size - inner_pad * 2), inner_r, this.color('accent'))
    }
    if (label) this.ui.draw_text(x + box_size + label_gap, this.ui.text_v_center_y(y, box_size, w_font_px * scale), label, w_font_px * scale, this.color('text'))
    return value
  }

  slider(id: string, x: number, y: number, w: number, h: number, value: number, min: number, max: number, show_value = false): number {
    if (this.ui.rect_clipped(x, y, w, h)) return Math.max(min, Math.min(max, value))
    const scale = window.devicePixelRatio || 1
    const hover = this.point_in(x, y, w, h)
    if (this.input.mouse_pressed && hover) this.active_id = id
    if (this.active_id === id && this.input.mouse_down) {
      const t = Math.max(0, Math.min(1, (this.input.mouse_x - x) / Math.max(w, 1)))
      value = min + (max - min) * t
    }
    value = Math.max(min, Math.min(max, value))
    const t = max > min ? (value - min) / (max - min) : 0
    const track_h = 4 * scale
    const track_y = y + (h - track_h) * 0.5
    const track_r = track_h * 0.5
    this.ui.fill_round_rect(x, track_y, w, track_h, track_r, this.color('track'))
    if (t > 0) this.ui.fill_round_rect(x, track_y, t * w, track_h, track_r, this.color('accent_dim'))
    const th = w_slider_thumb * scale
    const tx = x + t * w - th * 0.5
    const ty = y + (h - th) * 0.5
    this.ui.fill_round_rect(tx, ty, th, th, th * 0.5, this.active_id === id ? this.color('accent') : this.color('selected'))
    if (show_value) this.ui.draw_text(x + w + 8 * scale, this.ui.text_v_center_y(y, h, (w_font_px - 1) * scale), value.toFixed(2), (w_font_px - 1) * scale, this.color('text_dim'))
    return value
  }

  list(_id: string, x: number, y: number, w: number, h: number, items: string[], selected: number, scroll: ui_scroll_state): number {
    if (this.ui.rect_clipped(x, y, w, h)) return selected
    const scale = window.devicePixelRatio || 1
    const row_h = w_row_h * scale
    const scrollbar_w = w_scrollbar_w * scale
    const content_h = items.length * row_h
    const max_off = Math.max(0, content_h - h)
    if (this.point_in(x, y, w, h)) {
      scroll.offset_y = Math.max(0, Math.min(max_off, scroll.offset_y - this.input.wheel_y * 20 * scale))
    }
    this.ui.push_clip(x, y, w, h)
    let next_selected = selected
    for (let i = 0; i < items.length; i += 1) {
      const ry = y + i * row_h - scroll.offset_y
      if (ry + row_h < y || ry > y + h) continue
      const hover = this.point_in(x, ry, w - scrollbar_w, row_h)
      const bg = i === selected ? this.color('selected') : hover ? this.color('hover') : 0
      if (bg) this.ui.fill_round_rect(x + 2 * scale, ry + 1 * scale, Math.max(0, w - scrollbar_w - 4 * scale), Math.max(0, row_h - 2 * scale), w_radius * scale, bg)
      this.ui.draw_text(x + w_pad * scale, this.ui.text_v_center_y(ry, row_h, w_font_px * scale), items[i], w_font_px * scale, i === selected ? this.color('text') : this.color('text_dim'))
      if (hover && this.input.mouse_pressed) next_selected = i
    }
    this.ui.pop_clip()
    if (content_h > h) {
      const thumb_h = Math.max(w_scrollbar_min * scale, h * (h / content_h))
      const travel = Math.max(1, h - thumb_h)
      const t = max_off > 0 ? scroll.offset_y / max_off : 0
      const thumb_y = y + t * travel
      this.ui.fill_round_rect(x + w - scrollbar_w, y + 2 * scale, scrollbar_w, h - 4 * scale, scrollbar_w * 0.5, this.color('panel_alt'))
      this.ui.fill_round_rect(x + w - scrollbar_w + 1, thumb_y + 1, scrollbar_w - 2, thumb_h - 2, (scrollbar_w - 2) * 0.5, this.color('selected'))
    }
    return next_selected
  }

  dropdown(
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    items: string[],
    selected: number,
    options?: { chrome?: 'rounded' | 'rect' | 'none'; display_label?: string; show_arrow?: boolean },
  ): number {
    const scale = window.devicePixelRatio || 1
    const popup_occluded =
      this.open_dropdown_popup_rect != null &&
      this.open_dropdown_popup_rect.id !== id &&
      this.point_in_rect(
        this.input.mouse_x,
        this.input.mouse_y,
        this.open_dropdown_popup_rect.x,
        this.open_dropdown_popup_rect.y,
        this.open_dropdown_popup_rect.w,
        this.open_dropdown_popup_rect.h,
      )
    const hover = !popup_occluded && this.point_in(x, y, w, h)
    const open = this.open_dropdown_id === id
    if (hover && this.input.mouse_pressed) this.open_dropdown_id = open ? null : id
    const chrome = options?.chrome ?? 'rounded'
    const bg = open ? this.color('active') : hover ? this.color('hover') : this.color('panel')
    if (chrome === 'rounded') {
      this.ui.fill_round_rect(x, y, w, h, w_radius * scale, bg)
      this.ui.stroke_round_rect(x, y, w, h, w_radius * scale, 1, open ? this.color('accent') : this.color('border'))
    } else if (chrome === 'rect') {
      this.ui.fill_rect(x, y, w, h, bg)
      this.ui.stroke_rect(x, y, w, h, 1, open ? this.color('accent') : this.color('border'))
    }
    const effective_selected = this.dropdown_selections.get(id) ?? selected
    const label = options?.display_label ?? items[effective_selected] ?? 'Select...'
    const arrow_reserve = options?.show_arrow === false ? 0 : 18 * scale
    this.ui.push_clip(x + 1, y + 1, Math.max(0, w - 2 - arrow_reserve), Math.max(0, h - 2))
    this.ui.draw_text(x + w_pad * scale, this.ui.text_v_center_y(y, h, w_font_px * scale), label, w_font_px * scale, items[selected] ? this.color('text') : this.color('text_dim'))
    this.ui.pop_clip()
    if (options?.show_arrow !== false) {
      this.ui.draw_text(x + w - 14 * scale, this.ui.text_v_center_y(y, h, w_font_px * scale), 'v', w_font_px * scale, this.color('text_dim'))
    }
    const ref = { value: effective_selected }
    if (this.open_dropdown_id === id) {
      this.pending_dropdown = { id, x, y, w, h, items, selected_ref: ref }
      const placement = this.dropdown_popup_placement(x, y, w, h, items)
      this.open_dropdown_popup_rect = { id, ...placement }
    }
    return this.dropdown_selections.get(id) ?? ref.value
  }

  set_dropdown_value(id: string, value: number): void {
    this.dropdown_selections.set(id, value)
  }

  scrollbar(id: string, x: number, y: number, w: number, h: number, scroll: ui_scroll_state, content_h: number): void {
    if (content_h <= h) return
    if (this.ui.rect_clipped(x, y, w, h)) return
    const scale = window.devicePixelRatio || 1
    const min_thumb = 20 * scale
    const max_off = Math.max(0, content_h - h)
    const thumb_h = Math.max(min_thumb, h * (h / content_h))
    const travel = Math.max(1, h - thumb_h)
    const t = max_off > 0 ? scroll.offset_y / max_off : 0
    const thumb_y = y + t * travel

    // Drag activation
    const on_thumb = this.point_in(x, thumb_y, w, thumb_h)
    const on_track = this.point_in(x, y, w, h)
    if (this.input.mouse_pressed) {
      if (on_thumb) {
        this.active_id = id
      } else if (on_track) {
        // Click on track: jump to position
        const click_t = Math.max(0, Math.min(1, (this.input.mouse_y - y - thumb_h * 0.5) / travel))
        scroll.offset_y = Math.round(click_t * max_off)
        this.active_id = id
      }
    }
    if (this.active_id === id && this.input.mouse_down) {
      const drag_t = Math.max(0, Math.min(1, (this.input.mouse_y - y - thumb_h * 0.5) / travel))
      scroll.offset_y = Math.round(drag_t * max_off)
    }

    // Recompute thumb position after potential drag update
    const t2 = max_off > 0 ? scroll.offset_y / max_off : 0
    const thumb_y2 = y + t2 * travel
    const thumb_hovered = this.active_id === id || this.point_in(x, thumb_y2, w, thumb_h)

    const sb_r = Math.max(1, w * 0.5)
    this.ui.fill_round_rect(x, y, w, h, sb_r, this.color('panel_alt'))
    this.ui.fill_round_rect(x + 1, thumb_y2 + 1, Math.max(0, w - 2), Math.max(0, thumb_h - 2), Math.max(0, sb_r - 1), thumb_hovered ? this.color('text_dim') : this.color('selected'))
  }

  hit_region(x: number, y: number, w: number, h: number): { hovered: boolean; pressed: boolean } {
    const hovered = this.point_in(x, y, w, h)
    return { hovered, pressed: hovered && this.input.mouse_pressed }
  }

  handle_scroll_area(x: number, y: number, w: number, h: number, scroll: ui_scroll_state, content_h: number): void {
    if (!this.point_in(x, y, w, h)) return
    const scale = window.devicePixelRatio || 1
    const max_off = Math.max(0, content_h - h)
    scroll.offset_y = Math.max(0, Math.min(max_off, scroll.offset_y - this.input.wheel_y * 20 * scale))
  }

  is_escape_pressed(): boolean {
    return this.input.key_escape
  }

  is_enter_pressed(): boolean {
    return this.input.key_enter
  }

  is_mouse_down(): boolean {
    return this.input.mouse_down
  }

  is_mouse_pressed(): boolean {
    return this.input.mouse_pressed
  }

  has_keyboard_focus(): boolean {
    return this.focused_input_id != null || this.focused_number_id != null
  }

  focus_text_input(id: string, state: ui_input_text_state, cursor = state.cursor): void {
    const next_cursor = Math.max(0, cursor)
    this.focused_input_id = id
    this.pending_focused_input_id = id
    this.focused_number_id = null
    this.active_id = null
    state.cursor = next_cursor
    state.sel_anchor = next_cursor
    state.sel_head = next_cursor
  }

  mouse_x(): number {
    return this.input.mouse_x
  }

  mouse_y(): number {
    return this.input.mouse_y
  }

  input_text(id: string, x: number, y: number, w: number, h: number, buf: string, placeholder: string, state: ui_input_text_state): string {
    return this.input_field(id, x, y, w, h, buf, placeholder, state)
  }

  input_field(id: string, x: number, y: number, w: number, h: number, buf: string, placeholder: string, state: ui_input_text_state): string {
    const scale = window.devicePixelRatio || 1
    this.register_native_text_region(id, x, y, w, h, 'text')
    const hover = this.point_in(x, y, w, h)
    const auto_focused = this.pending_focused_input_id === id
    const focused = this.focused_input_id === id
    const text_x = x + w_pad * scale
    if (this.input.mouse_pressed && !auto_focused) {
      if (hover) {
        this.focused_input_id = id
        this.focused_number_id = null
        this.active_id = id
        const next_cursor = this.cursor_from_mouse(buf, text_x, this.input.mouse_x)
        state.cursor = next_cursor
        state.sel_anchor = next_cursor
        state.sel_head = next_cursor
      } else if (this.focused_input_id === id) {
        this.focused_input_id = null
      }
    } else if (this.active_id === id && this.input.mouse_down) {
      const next_cursor = this.cursor_from_mouse(buf, text_x, this.input.mouse_x)
      state.cursor = next_cursor
      state.sel_head = next_cursor
    }
    let value = buf
    if (focused) {
      this.request_native_text_input(id, x, y, w, h, value, state, 'text')
      if (this.input.typed_text) {
        value = this.replace_selection(value, state, this.input.typed_text)
      }
      if (this.input.key_backspace) {
        if (this.has_selection(state)) {
          value = this.replace_selection(value, state, '')
        } else if (state.cursor > 0) {
          value = value.slice(0, state.cursor - 1) + value.slice(state.cursor)
          state.cursor -= 1
          state.sel_anchor = state.cursor
          state.sel_head = state.cursor
        }
      }
      if (this.input.key_delete) {
        if (this.has_selection(state)) {
          value = this.replace_selection(value, state, '')
        } else if (state.cursor < value.length) {
          value = value.slice(0, state.cursor) + value.slice(state.cursor + 1)
        }
      }
      if (this.input.typed_text) {
        state.sel_anchor = state.cursor
        state.sel_head = state.cursor
      }
      if (this.input.key_left) this.move_cursor(state, Math.max(0, this.selection_start(state, true) - 1))
      if (this.input.key_right) this.move_cursor(state, Math.min(value.length, this.selection_end(state, true) + 1))
      if (this.input.key_home) this.move_cursor(state, 0)
      if (this.input.key_end) this.move_cursor(state, value.length)
      if (this.input.key_escape) this.focused_input_id = null
    }
    if (auto_focused) this.pending_focused_input_id = null

    this.ui.fill_round_rect(x, y, w, h, w_radius * scale, this.color('panel_alt'))
    this.ui.stroke_round_rect(x, y, w, h, w_radius * scale, 1, focused ? this.color('accent') : this.color('border'))
    this.ui.push_clip(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2))
    const draw_text = value || (focused ? '' : placeholder)
    const draw_color = value ? this.color('text') : this.color('text_dim')
    const composition = focused ? this.input.ime_composition ?? '' : ''
    if (focused && value && this.has_selection(state)) {
      const start = this.selection_start(state)
      const end = this.selection_end(state)
      const sx = text_x + this.ui.text_width(value.slice(0, start), w_font_px * scale)
      const ex = text_x + this.ui.text_width(value.slice(0, end), w_font_px * scale)
      this.ui.fill_rect(sx, y + 5 * scale, Math.max(1, ex - sx), Math.max(10 * scale, h - 10 * scale), this.color('selected'))
    }
    this.ui.draw_text(text_x, this.ui.text_v_center_y(y, h, w_font_px * scale), draw_text, w_font_px * scale, draw_color)
    if (focused) {
      const cursor_x = text_x + this.ui.text_width(value.slice(0, state.cursor), w_font_px * scale)
      if (composition) {
        const comp_w = this.ui.text_width(composition, w_font_px * scale)
        const comp_y = this.ui.text_v_center_y(y, h, w_font_px * scale)
        this.ui.draw_text(cursor_x, comp_y, composition, w_font_px * scale, this.color('text_dim'))
        this.ui.fill_rect(cursor_x, y + h - 6 * scale, Math.max(1, comp_w), 1 * scale, this.color('accent'))
      }
      this.ui.fill_rect(cursor_x, y + 6 * scale, 1.5 * scale, Math.max(10 * scale, h - 12 * scale), this.color('accent'))
    }
    this.ui.pop_clip()
    return value
  }

  number_input(
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    value: number,
    state: ui_number_input_state,
    options?: { min?: number; max?: number; step?: number; decimals?: number },
  ): number {
    if (!Number.isFinite(value)) value = 0
    const decimals = options?.decimals ?? 2
    const scale = window.devicePixelRatio || 1
    this.register_native_text_region(id, x, y, w, h, 'numeric')
    const hover = this.point_in(x, y, w, h)
    const focused = this.focused_number_id === id
    const text_x = x + w_pad * scale
    if (!focused && !state.draft) {
      state.draft = value.toFixed(decimals)
      state.cursor = state.draft.length
      state.sel_anchor = state.cursor
      state.sel_head = state.cursor
    }
    if (this.input.mouse_pressed) {
      if (hover) {
        this.focused_number_id = id
        this.focused_input_id = null
        this.active_id = id
        const next_cursor = this.cursor_from_mouse(state.draft || value.toFixed(decimals), text_x, this.input.mouse_x)
        state.cursor = next_cursor
        state.sel_anchor = next_cursor
        state.sel_head = next_cursor
      } else if (this.focused_number_id === id) {
        this.focused_number_id = null
      }
    } else if (this.active_id === id && this.input.mouse_down) {
      const next_cursor = this.cursor_from_mouse(state.draft || value.toFixed(decimals), text_x, this.input.mouse_x)
      state.cursor = next_cursor
      state.sel_head = next_cursor
    }

    let next_value = value
    let draft = focused ? state.draft : value.toFixed(decimals)
    if (focused) {
      this.request_native_text_input(id, x, y, w, h, draft, state, 'numeric')
      if (this.input.typed_text) {
        const filtered = [...this.input.typed_text].filter((ch) => /[0-9.\-]/.test(ch)).join('')
        if (filtered) {
          draft = this.replace_selection(draft, state, filtered)
        }
      }
      if (this.input.key_backspace) {
        if (this.has_selection(state)) {
          draft = this.replace_selection(draft, state, '')
        } else if (state.cursor > 0) {
          draft = draft.slice(0, state.cursor - 1) + draft.slice(state.cursor)
          state.cursor -= 1
          state.sel_anchor = state.cursor
          state.sel_head = state.cursor
        }
      }
      if (this.input.key_delete) {
        if (this.has_selection(state)) {
          draft = this.replace_selection(draft, state, '')
        } else if (state.cursor < draft.length) {
          draft = draft.slice(0, state.cursor) + draft.slice(state.cursor + 1)
        }
      }
      if (this.input.key_left) this.move_cursor(state, Math.max(0, this.selection_start(state, true) - 1))
      if (this.input.key_right) this.move_cursor(state, Math.min(draft.length, this.selection_end(state, true) + 1))
      if (this.input.key_home) this.move_cursor(state, 0)
      if (this.input.key_end) this.move_cursor(state, draft.length)
      if (this.input.wheel_y !== 0 && hover) {
        const step = options?.step ?? 0.1
        next_value += (this.input.wheel_y > 0 ? 1 : -1) * step
        draft = next_value.toFixed(decimals)
        state.cursor = draft.length
        state.sel_anchor = state.cursor
        state.sel_head = state.cursor
      }
      const parsed = Number.parseFloat(draft)
      if (Number.isFinite(parsed)) {
        next_value = parsed
      }
      if (this.input.key_enter || this.input.key_escape) {
        if (Number.isFinite(next_value)) {
          if (typeof options?.min === 'number') next_value = Math.max(options.min, next_value)
          if (typeof options?.max === 'number') next_value = Math.min(options.max, next_value)
          draft = next_value.toFixed(decimals)
        } else {
          next_value = value
          draft = value.toFixed(decimals)
        }
        state.cursor = draft.length
        this.focused_number_id = null
      }
    }

    if (typeof options?.min === 'number') next_value = Math.max(options.min, next_value)
    if (typeof options?.max === 'number') next_value = Math.min(options.max, next_value)
    state.draft = focused ? draft : next_value.toFixed(decimals)

    this.ui.fill_round_rect(x, y, w, h, w_radius * scale, this.color('panel_alt'))
    this.ui.stroke_round_rect(x, y, w, h, w_radius * scale, 1, focused ? this.color('accent') : this.color('border'))
    const text = state.draft || next_value.toFixed(decimals)
    const composition = focused ? this.input.ime_composition ?? '' : ''
    this.ui.push_clip(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2))
    if (focused && text && this.has_selection(state)) {
      const start = this.selection_start(state)
      const end = this.selection_end(state)
      const sx = text_x + this.ui.text_width(text.slice(0, start), w_font_px * scale)
      const ex = text_x + this.ui.text_width(text.slice(0, end), w_font_px * scale)
      this.ui.fill_rect(sx, y + 5 * scale, Math.max(1, ex - sx), Math.max(10 * scale, h - 10 * scale), this.color('selected'))
    }
    this.ui.draw_text(text_x, this.ui.text_v_center_y(y, h, w_font_px * scale), text, w_font_px * scale, this.color('text'))
    if (focused) {
      const cursor_x = text_x + this.ui.text_width(text.slice(0, state.cursor), w_font_px * scale)
      if (composition) {
        const comp_w = this.ui.text_width(composition, w_font_px * scale)
        const comp_y = this.ui.text_v_center_y(y, h, w_font_px * scale)
        this.ui.draw_text(cursor_x, comp_y, composition, w_font_px * scale, this.color('text_dim'))
        this.ui.fill_rect(cursor_x, y + h - 6 * scale, Math.max(1, comp_w), 1 * scale, this.color('accent'))
      }
      this.ui.fill_rect(cursor_x, y + 6 * scale, 1.5 * scale, Math.max(10 * scale, h - 12 * scale), this.color('accent'))
    }
    this.ui.pop_clip()
    return next_value
  }

  ui_color_picker(
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    value: ui_color_rgba,
    options?: { label?: string; popup_w?: number },
  ): ui_color_rgba {
    const scale = window.devicePixelRatio || 1
    const popup_occluded =
      this.open_color_picker_popup_rect != null &&
      this.open_color_picker_popup_rect.id !== id &&
      this.point_in_rect(
        this.input.mouse_x,
        this.input.mouse_y,
        this.open_color_picker_popup_rect.x,
        this.open_color_picker_popup_rect.y,
        this.open_color_picker_popup_rect.w,
        this.open_color_picker_popup_rect.h,
      )
    const hover = !popup_occluded && this.point_in(x, y, w, h)
    const open = this.open_color_picker_id === id
    if (hover && this.input.mouse_pressed) this.open_color_picker_id = open ? null : id

    let current = this.color_picker_values.get(id)
    if (!current || !open && !this.same_color(current, value)) {
      current = this.normalize_color(value)
      this.color_picker_values.set(id, current)
    }
    if (!current) {
      current = this.normalize_color(value)
      this.color_picker_values.set(id, current)
    }

    const bg = open ? this.color('active') : hover ? this.color('hover') : this.color('panel')
    this.ui.fill_round_rect(x, y, w, h, w_radius * scale, bg)
    this.ui.stroke_round_rect(x, y, w, h, w_radius * scale, 1, open ? this.color('accent') : this.color('border'))
    const label = options?.label ?? 'Color'
    this.draw_color_bar(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2), Math.max(0, w_radius * scale - 1), current, label, w_font_px * scale, scale)

    if (open) {
      this.pending_color_picker = {
        id,
        x,
        y,
        w,
        h,
        color_ref: current,
        popup_w: options?.popup_w,
      }
      const placement = this.color_picker_popup_placement(x, y, w, h, options?.popup_w)
      this.open_color_picker_popup_rect = { id, ...placement }
    }

    return this.color_picker_values.get(id) ?? this.normalize_color(value)
  }

  /**
   * Selectable, copyable, scrollable monospace text panel — the WebGPU
   * replacement for a DOM `<pre>` used as an output/console view.
   *
   * Supports mouse-drag selection, Shift+click extend, double-click word and
   * triple-click line selection, wheel + scrollbar scrolling, keyboard
   * scrolling (arrows / PageUp / PageDown) while focused, Ctrl/Cmd+A
   * select-all and Ctrl/Cmd+C copy (via `navigator.clipboard`). Selection is
   * tracked in `state` as logical `{ line, col }` endpoints; read the selected
   * string with {@link text_view_selected_text}.
   */
  text_view(
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    lines: ui_text_view_line[],
    state: ui_text_view_state,
    options?: ui_text_view_options,
  ): void {
    const scale = window.devicePixelRatio || 1
    const read_only = options?.read_only === true
    const fpx = (options?.font_px ?? 13) * scale
    const wrap = options?.wrap === true
    const pad = w_pad * scale
    const line_pad = (options?.line_pad ?? 2) * scale
    const scrollbar_w = w_scrollbar_w * scale
    const char_w = Math.max(1, this.ui.mono_char_width(fpx, FONT_MONO))
    const line_h = this.ui.text_line_height(fpx, FONT_MONO) + line_pad

    if (options?.background !== false) {
      this.ui.fill_round_rect(x, y, w, h, w_radius * scale, this.color('panel'))
      this.ui.stroke_round_rect(x, y, w, h, w_radius * scale, 1, this.color('border'))
    }

    const text_x = x + pad
    const text_top = y + line_pad * 0.5
    const view_h = Math.max(0, h - line_pad)
    // Always reserve the scrollbar gutter so wrapping/clipping doesn't reflow when it appears.
    const content_w = Math.max(char_w, w - pad - scrollbar_w - pad)
    const max_cols = wrap ? Math.max(1, Math.floor(content_w / char_w)) : Number.POSITIVE_INFINITY

    // Build the visual-row model (one entry per rendered row).
    const vrows: text_view_vrow[] = []
    for (let li = 0; li < lines.length; li += 1) {
      const len = lines[li]?.text.length ?? 0
      if (!wrap || len <= max_cols) {
        vrows.push({ line: li, start: 0, end: len })
        continue
      }
      for (let s = 0; s < len; s += max_cols) vrows.push({ line: li, start: s, end: Math.min(len, s + max_cols) })
    }
    if (vrows.length === 0) vrows.push({ line: 0, start: 0, end: 0 })

    const content_h = vrows.length * line_h
    const max_scroll = Math.max(0, content_h - view_h)

    // Map a logical {line, col} to the visual-row index it lands on.
    const vrow_for_pos = (line: number, col: number): number => {
      let last_on_line = 0
      for (let i = 0; i < vrows.length; i += 1) {
        const vr = vrows[i]!
        if (vr.line !== line) continue
        if (col >= vr.start && col <= vr.end) return i
        last_on_line = i
      }
      return last_on_line
    }

    // Apply a requested scroll-to-line before computing visibility.
    if (state.scroll_to_line != null) {
      const target = Math.max(0, Math.min(lines.length - 1, state.scroll_to_line))
      const vi = vrow_for_pos(target, 0)
      state.scroll_top = Math.max(0, Math.min(max_scroll, vi * line_h))
      state.scroll_to_line = null
    }

    const text_area = { x, y, w: w - scrollbar_w, h }
    const hover_area = this.point_in(text_area.x, text_area.y, text_area.w, text_area.h)
    const hover_panel = this.point_in(x, y, w, h)

    // Hit-test the mouse to a logical {line, col}.
    const hit_test = (mx: number, my: number): ui_text_pos => {
      const rel_y = my - text_top + state.scroll_top
      const vi = Math.max(0, Math.min(vrows.length - 1, Math.floor(rel_y / line_h)))
      const vr = vrows[vi]!
      const rel_x = mx - text_x
      const span = vr.end - vr.start
      const col_in_row = Math.max(0, Math.min(span, Math.round(rel_x / char_w)))
      return { line: vr.line, col: vr.start + col_in_row }
    }

    if (!read_only) {
      // Mouse: focus, click streaks, drag selection.
      if (this.input.mouse_pressed) {
        if (hover_area) {
          this.focused_input_id = id
          this.focused_number_id = null
          this.active_id = id
          state.focused = true
          const pos = hit_test(this.input.mouse_x, this.input.mouse_y)
          const now = (typeof performance !== 'undefined' ? performance.now() : Date.now())
          const same_spot = state.last_click_line === pos.line && Math.abs(state.last_click_col - pos.col) <= 1
          const streak = now - state.last_click_ms < 400 && same_spot ? state.click_streak + 1 : 1
          state.click_streak = streak
          state.last_click_ms = now
          state.last_click_line = pos.line
          state.last_click_col = pos.col
          if (streak >= 3) {
            const len = lines[pos.line]?.text.length ?? 0
            state.anchor = { line: pos.line, col: 0 }
            state.focus = { line: pos.line, col: len }
          } else if (streak === 2) {
            const [ws, we] = this.word_bounds(lines[pos.line]?.text ?? '', pos.col)
            state.anchor = { line: pos.line, col: ws }
            state.focus = { line: pos.line, col: we }
          } else if (this.input.shift) {
            state.focus = pos
          } else {
            state.anchor = pos
            state.focus = pos
          }
        } else if (state.focused) {
          state.focused = false
          this.focused_input_id = this.focused_input_id === id ? null : this.focused_input_id
        }
      } else if (this.active_id === id && this.input.mouse_down) {
        state.focus = hit_test(this.input.mouse_x, this.input.mouse_y)
      }
      state.focused = this.focused_input_id === id
    }

    // Wheel scroll while hovering the panel.
    if (hover_panel && this.input.wheel_y !== 0) {
      state.scroll_top = Math.max(0, Math.min(max_scroll, state.scroll_top - this.input.wheel_y * 20 * scale))
    }

    // Keyboard while focused: scrolling + select-all + copy.
    if (state.focused && !read_only) {
      if (this.input.key_up) state.scroll_top -= line_h
      if (this.input.key_down) state.scroll_top += line_h
      if (this.input.key_page_up) state.scroll_top -= view_h
      if (this.input.key_page_down) state.scroll_top += view_h
      if (this.input.key_home && (this.input.ctrl || this.input.meta)) state.scroll_top = 0
      if (this.input.key_end && (this.input.ctrl || this.input.meta)) state.scroll_top = max_scroll
      state.scroll_top = Math.max(0, Math.min(max_scroll, state.scroll_top))
      if ((this.input.ctrl || this.input.meta) && this.input.key_a) {
        const last = Math.max(0, lines.length - 1)
        state.anchor = { line: 0, col: 0 }
        state.focus = { line: last, col: lines[last]?.text.length ?? 0 }
      }
      if ((this.input.ctrl || this.input.meta) && this.input.key_c && has_text_selection(state)) {
        const text = text_view_selected_text(lines, state)
        if (text && typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(text)
      }
    }
    state.scroll_top = Math.max(0, Math.min(max_scroll, state.scroll_top))

    // Render text + selection.
    this.ui.push_clip(text_area.x, y, text_area.w, h)
    const selecting = has_text_selection(state)
    const [sel_start, sel_end] = selecting ? normalize_text_sel(state.anchor, state.focus) : [state.focus, state.focus]
    const text_color = this.color('text')
    const sel_color = this.color('selected')
    const first_vi = Math.max(0, Math.floor(state.scroll_top / line_h) - 1)
    const last_vi = Math.min(vrows.length - 1, Math.ceil((state.scroll_top + view_h) / line_h))
    for (let vi = first_vi; vi <= last_vi; vi += 1) {
      const vr = vrows[vi]!
      const row_y = text_top + vi * line_h - state.scroll_top
      const line = lines[vr.line]
      if (selecting && vr.line >= sel_start.line && vr.line <= sel_end.line) {
        const line_sel_start = vr.line === sel_start.line ? sel_start.col : 0
        const line_len = line?.text.length ?? 0
        const line_sel_end = vr.line === sel_end.line ? sel_end.col : line_len
        let c0 = Math.max(vr.start, line_sel_start)
        let c1 = Math.min(vr.end, line_sel_end)
        if (c1 >= c0) {
          let sw = (c1 - c0) * char_w
          // Show the trailing newline as selected on fully-covered intermediate rows.
          const is_line_last_row = vr.end >= line_len
          if (vr.line < sel_end.line && is_line_last_row) sw += char_w * 0.5
          this.ui.fill_rect(text_x + (c0 - vr.start) * char_w, row_y, Math.max(1, sw), line_h, sel_color)
        }
      }
      if (line && vr.end > vr.start) {
        const slice = line.text.slice(vr.start, vr.end)
        const col = this.resolve_text_view_color(line.color, text_color)
        this.ui.draw_text(text_x, this.ui.text_v_center_y(row_y, line_h, fpx, FONT_MONO), slice, fpx, col, FONT_MONO)
      }
    }

    // Caret (when focused with an empty selection).
    if (state.focused && !selecting && !read_only) {
      const vi = vrow_for_pos(state.focus.line, state.focus.col)
      const vr = vrows[vi]
      if (vr) {
        const caret_x = text_x + (state.focus.col - vr.start) * char_w
        const caret_y = text_top + vi * line_h - state.scroll_top
        const blink = (typeof performance !== 'undefined' ? performance.now() : Date.now()) % 1000 < 600
        if (blink) this.ui.fill_rect(caret_x, caret_y + 2 * scale, Math.max(1, 1.5 * scale), line_h - 4 * scale, this.color('accent'))
      }
    }
    this.ui.pop_clip()

    // Scrollbar.
    if (content_h > view_h) {
      const sb_x = x + w - scrollbar_w - 2 * scale
      const sb_y = y + 2 * scale
      const sb_h = h - 4 * scale
      const thumb_h = Math.max(w_scrollbar_min * scale, sb_h * (view_h / content_h))
      const travel = Math.max(1, sb_h - thumb_h)
      const sb_id = `${id}.sb`
      const t_now = max_scroll > 0 ? state.scroll_top / max_scroll : 0
      const thumb_y = sb_y + t_now * travel
      if (this.input.mouse_pressed) {
        if (this.point_in(sb_x, thumb_y, scrollbar_w, thumb_h)) {
          this.active_id = sb_id
        } else if (this.point_in(sb_x, sb_y, scrollbar_w, sb_h)) {
          const click_t = Math.max(0, Math.min(1, (this.input.mouse_y - sb_y - thumb_h * 0.5) / travel))
          state.scroll_top = Math.round(click_t * max_scroll)
          this.active_id = sb_id
        }
      }
      if (this.active_id === sb_id && this.input.mouse_down) {
        const drag_t = Math.max(0, Math.min(1, (this.input.mouse_y - sb_y - thumb_h * 0.5) / travel))
        state.scroll_top = Math.round(drag_t * max_scroll)
      }
      const t2 = max_scroll > 0 ? state.scroll_top / max_scroll : 0
      const thumb_y2 = sb_y + t2 * travel
      const thumb_hot = this.active_id === sb_id || this.point_in(sb_x, thumb_y2, scrollbar_w, thumb_h)
      this.ui.fill_round_rect(sb_x, sb_y, scrollbar_w, sb_h, scrollbar_w * 0.5, this.color('panel_alt'))
      this.ui.fill_round_rect(sb_x + 1, thumb_y2 + 1, scrollbar_w - 2, thumb_h - 2, (scrollbar_w - 2) * 0.5, thumb_hot ? this.color('text_dim') : this.color('selected'))
    }
  }

  /** Read the current selection of a {@link text_view}, joined with `\n`. */
  get_text_view_selected_text(lines: ui_text_view_line[], state: ui_text_view_state): string {
    return text_view_selected_text(lines, state)
  }

  private resolve_text_view_color(color: number | string | undefined, fallback: number): number {
    if (typeof color === 'number') return color >>> 0
    if (typeof color === 'string') return pack_color(color)
    return fallback
  }

  private word_bounds(text: string, col: number): [number, number] {
    const len = text.length
    if (len === 0) return [0, 0]
    const i = Math.min(col, len - 1)
    const seed = text[i] ?? ''
    // Select a run of the same class as the seed: word chars, whitespace, or punctuation.
    const test = /\s/.test(seed)
      ? (ch: string) => /\s/.test(ch)
      : is_word_char(seed)
        ? is_word_char
        : (ch: string) => !is_word_char(ch) && !/\s/.test(ch)
    let start = i
    let end = i + 1
    while (start > 0 && test(text[start - 1] ?? '')) start -= 1
    while (end < len && test(text[end] ?? '')) end += 1
    return [start, end]
  }

  private render_dropdown_popup(popup: dropdown_popup): void {
    const scale = window.devicePixelRatio || 1
    const popup_pad = 4 * scale
    const placement = this.dropdown_popup_placement(popup.x, popup.y, popup.w, popup.h, popup.items)
    const px = placement.x
    const py = placement.y
    const ph = placement.h
    const safe_margin = w_popup_safe_margin * scale
    const in_btn = this.point_in(popup.x, popup.y, popup.w, popup.h)
    const in_pop = this.point_in(px, py, placement.w, ph)
    const union_x = Math.min(popup.x, px) - safe_margin
    const union_y = Math.min(popup.y, py) - safe_margin
    const union_w = Math.max(popup.x + popup.w, px + placement.w) - Math.min(popup.x, px) + safe_margin * 2
    const union_h = Math.max(popup.y + popup.h, py + ph) - Math.min(popup.y, py) + safe_margin * 2
    const in_safe_zone = this.point_in_rect(this.input.mouse_x, this.input.mouse_y, union_x, union_y, union_w, union_h)
    if (!in_safe_zone && !this.input.mouse_down) this.open_dropdown_id = null
    if (this.input.mouse_pressed && !in_btn && !in_pop) this.open_dropdown_id = null
    const popup_r = w_radius * scale
    this.ui.fill_round_rect(px, py, placement.w, ph, popup_r, this.color('panel'))
    this.ui.stroke_round_rect(px, py, placement.w, ph, popup_r, 1, this.color('border'))
    let row_y = py + popup_pad
    for (let i = 0; i < popup.items.length; i += 1) {
      const hover = this.point_in(px + popup_pad, row_y, placement.w - popup_pad * 2, w_popup_item_h * scale)
      const sel = popup.selected_ref.value === i
      const bg = sel ? this.color('selected') : hover ? this.color('hover') : 0
      if (bg) this.ui.fill_round_rect(px + popup_pad, row_y, placement.w - popup_pad * 2, w_popup_item_h * scale, Math.max(0, popup_r - 1), bg)
      this.ui.draw_text(px + w_pad * scale, this.ui.text_v_center_y(row_y, w_popup_item_h * scale, w_font_px * scale), popup.items[i], w_font_px * scale, sel ? this.color('text') : this.color('text_dim'))
      if (hover && this.input.mouse_released) {
        popup.selected_ref.value = i
        this.dropdown_selections.set(popup.id, i)
        this.open_dropdown_id = null
      }
      row_y += w_popup_item_h * scale
    }
  }

  private render_color_picker_popup(popup: color_picker_popup): void {
    const scale = window.devicePixelRatio || 1
    const pad = 8 * scale
    const preview_h = 22 * scale
    const square_size = 154 * scale
    const bar_w = 18 * scale
    const input_h = 24 * scale
    const input_gap = 6 * scale
    const popup_w = popup.popup_w ?? Math.max(260 * scale, square_size + bar_w + pad * 3)
    const title_h = 14 * scale
    const channel_label_h = 11 * scale
    const popup_h = pad * 2 + title_h + preview_h + 8 * scale + square_size + 10 * scale + channel_label_h + input_h + input_gap
    const placement = this.color_picker_popup_placement(popup.x, popup.y, popup.w, popup.h, popup_w, popup_h)
    const px = placement.x
    const py = placement.y
    const in_btn = this.point_in(popup.x, popup.y, popup.w, popup.h)
    const in_pop = this.point_in(px, py, placement.w, placement.h)
    const union_x = Math.min(popup.x, px) - w_popup_safe_margin * scale
    const union_y = Math.min(popup.y, py) - w_popup_safe_margin * scale
    const union_w = Math.max(popup.x + popup.w, px + placement.w) - Math.min(popup.x, px) + w_popup_safe_margin * scale * 2
    const union_h = Math.max(popup.y + popup.h, py + placement.h) - Math.min(popup.y, py) + w_popup_safe_margin * scale * 2
    const in_safe_zone = this.point_in_rect(this.input.mouse_x, this.input.mouse_y, union_x, union_y, union_w, union_h)
    if (!in_safe_zone && !this.input.mouse_down) this.open_color_picker_id = null
    if (this.input.mouse_pressed && !in_btn && !in_pop) this.open_color_picker_id = null

    const theme_panel = this.color('panel')
    const cp_r = w_radius * scale
    this.ui.fill_round_rect(px, py, placement.w, placement.h, cp_r, theme_panel)
    this.ui.stroke_round_rect(px, py, placement.w, placement.h, cp_r, 1, this.color('border'))

    const title_y = py + pad
    this.ui.draw_text(px + pad, this.ui.text_v_center_y(title_y, 12 * scale, 7 * scale), 'Color Picker', 7 * scale, this.color('text_dim'))

    const preview_y = title_y + 14 * scale
    const preview_x = px + pad
    const preview_w = placement.w - pad * 2
    const preview_r = Math.min(w_radius * scale, preview_h * 0.5)
    this.draw_color_bar(preview_x, preview_y, preview_w, preview_h, preview_r, popup.color_ref, this.color_hex_label(popup.color_ref), 9 * scale, scale)
    this.ui.stroke_round_rect(preview_x, preview_y, preview_w, preview_h, preview_r, 1, this.color('border_strong'))

    const square_x = px + pad
    const square_y = preview_y + preview_h + 8 * scale
    const square_w = square_size
    const square_h = square_size
    const value = this.rgb_to_hsv(popup.color_ref.r, popup.color_ref.g, popup.color_ref.b)
    this.draw_hue_saturation_square(square_x, square_y, square_w, square_h, value.v)
    this.draw_value_bar(square_x + square_w + 8 * scale, square_y, bar_w, square_h, value.h, value.s, popup.color_ref.a)

    const hs_hover = this.point_in(square_x, square_y, square_w, square_h)
    const v_x = square_x + square_w + 8 * scale
    const v_hover = this.point_in(v_x, square_y, bar_w, square_h)
    if (this.input.mouse_pressed && hs_hover) this.active_id = `${popup.id}.hs`
    if (this.input.mouse_pressed && v_hover) this.active_id = `${popup.id}.v`

    if (this.active_id === `${popup.id}.hs` && this.input.mouse_down) {
      const next_h = Math.max(0, Math.min(360, ((this.input.mouse_x - square_x) / Math.max(1, square_w)) * 360))
      const next_s = 1 - Math.max(0, Math.min(1, (this.input.mouse_y - square_y) / Math.max(1, square_h)))
      const rgb = this.hsv_to_rgb(next_h, next_s, value.v)
      popup.color_ref.r = rgb.r
      popup.color_ref.g = rgb.g
      popup.color_ref.b = rgb.b
    }
    if (this.active_id === `${popup.id}.v` && this.input.mouse_down) {
      const next_v = 1 - Math.max(0, Math.min(1, (this.input.mouse_y - square_y) / Math.max(1, square_h)))
      const rgb = this.hsv_to_rgb(value.h, value.s, next_v)
      popup.color_ref.r = rgb.r
      popup.color_ref.g = rgb.g
      popup.color_ref.b = rgb.b
    }

    const marker_x = square_x + (value.h / 360) * square_w
    const marker_y = square_y + (1 - value.s) * square_h
    this.ui.stroke_rect(marker_x - 3 * scale, marker_y - 3 * scale, 6 * scale, 6 * scale, 1, this.color('accent'))
    const value_y = square_y + (1 - value.v) * square_h
    this.ui.stroke_rect(v_x - 1 * scale, value_y - 2 * scale, bar_w + 2 * scale, 4 * scale, 1, this.color('accent'))

    const input_y = square_y + square_h + 10 * scale
    const col_gap = 6 * scale
    const field_w = Math.max(0, (placement.w - pad * 2 - col_gap * 3) / 4)
    const field_ids = [`${popup.id}.r`, `${popup.id}.g`, `${popup.id}.b`, `${popup.id}.a`]
    const values = [popup.color_ref.r, popup.color_ref.g, popup.color_ref.b, popup.color_ref.a]
    const labels = ['R', 'G', 'B', 'A']
    for (let i = 0; i < 4; i += 1) {
      const fx = px + pad + (field_w + col_gap) * i
      this.ui.draw_text(fx, this.ui.text_v_center_y(input_y - 11 * scale, 10 * scale, 5.5 * scale), labels[i]!, 5.5 * scale, this.color('text_dim'))
      values[i] = this.number_input(field_ids[i]!, fx, input_y, field_w, input_h, values[i]!, this.color_picker_number_state(field_ids[i]!), {
        min: 0,
        max: 1,
        step: 0.01,
        decimals: 3,
      })
    }
    popup.color_ref.r = values[0]!
    popup.color_ref.g = values[1]!
    popup.color_ref.b = values[2]!
    popup.color_ref.a = values[3]!
  }

  private point_in(x: number, y: number, w: number, h: number): boolean {
    if (!this.is_inside_popup_rendering && this.mouse_blocked_by_popup()) return false
    return this.input.mouse_x >= x && this.input.mouse_y >= y && this.input.mouse_x < x + w && this.input.mouse_y < y + h
  }

  private point_in_rect(px: number, py: number, x: number, y: number, w: number, h: number): boolean {
    return px >= x && py >= y && px < x + w && py < y + h
  }

  private mouse_blocked_by_popup(): boolean {
    const dr = this.open_dropdown_popup_rect
    if (dr && this.open_dropdown_id != null &&
      this.point_in_rect(this.input.mouse_x, this.input.mouse_y, dr.x, dr.y, dr.w, dr.h)) return true
    const cr = this.open_color_picker_popup_rect
    if (cr && this.open_color_picker_id != null &&
      this.point_in_rect(this.input.mouse_x, this.input.mouse_y, cr.x, cr.y, cr.w, cr.h)) return true
    return false
  }

  private color_picker_number_state(id: string): ui_number_input_state {
    let state = this.color_picker_number_inputs.get(id)
    if (!state) {
      state = { cursor: 0, sel_anchor: 0, sel_head: 0, draft: '' }
      this.color_picker_number_inputs.set(id, state)
    }
    return state
  }

  private dropdown_popup_placement(x: number, y: number, w: number, h: number, items: string[]): popup_placement {
    const scale = window.devicePixelRatio || 1
    const popup_pad = 4 * scale
    const popup_w = this.dropdown_popup_width(w, items)
    const popup_h = items.length * w_popup_item_h * scale + popup_pad * 2
    const gap = 2 * scale
    const { width: canvas_w, height: canvas_h } = this.ui.canvas_size()

    const bottom_y = y + h + gap
    const top_y = y - popup_h - gap
    let popup_y = bottom_y
    if (bottom_y + popup_h > canvas_h && top_y >= 0) popup_y = top_y
    popup_y = Math.max(0, Math.min(canvas_h - popup_h, popup_y))

    const right_space = canvas_w - x
    const left_space = x + w
    let popup_x = x
    if (right_space < popup_w && left_space >= popup_w) popup_x = x + w - popup_w
    popup_x = Math.max(0, Math.min(canvas_w - popup_w, popup_x))

    return { x: popup_x, y: popup_y, w: popup_w, h: popup_h }
  }

  private dropdown_popup_width(min_width: number, items: string[]): number {
    const scale = window.devicePixelRatio || 1
    let max_text_w = 0
    for (const item of items) {
      max_text_w = Math.max(max_text_w, this.ui.text_width(item, w_font_px * scale))
    }
    const horizontal_pad = w_pad * scale * 2
    const arrow_pad = 18 * scale
    return Math.max(min_width, Math.ceil(max_text_w + horizontal_pad + arrow_pad))
  }

  private color_picker_popup_placement(x: number, y: number, w: number, h: number, popup_w?: number, popup_h?: number): popup_placement {
    const scale = window.devicePixelRatio || 1
    const width = popup_w ?? Math.max(260 * scale, 154 * scale + 18 * scale + 8 * scale * 3)
    const height = popup_h ?? (8 * scale * 2 + 22 * scale + 8 * scale + 154 * scale + 10 * scale + 24 * scale)
    const gap = 2 * scale
    const { width: canvas_w, height: canvas_h } = this.ui.canvas_size()

    const bottom_y = y + h + gap
    const top_y = y - height - gap
    let popup_y = bottom_y
    if (bottom_y + height > canvas_h && top_y >= 0) popup_y = top_y
    popup_y = Math.max(0, Math.min(canvas_h - height, popup_y))

    const right_space = canvas_w - x
    const left_space = x + w
    let popup_x = x
    if (right_space < width && left_space >= width) popup_x = x + w - width
    popup_x = Math.max(0, Math.min(canvas_w - width, popup_x))

    return { x: popup_x, y: popup_y, w: width, h: height }
  }

  private cursor_from_mouse(text: string, text_x: number, mouse_x: number): number {
    const scale = window.devicePixelRatio || 1
    if (!text.length) return 0
    let prev_w = 0
    for (let index = 0; index < text.length; index += 1) {
      const next_w = this.ui.text_width(text.slice(0, index + 1), w_font_px * scale)
      const mid_x = text_x + (prev_w + next_w) * 0.5
      if (mouse_x < mid_x) return index
      prev_w = next_w
    }
    return text.length
  }

  private normalize_color(value: Partial<ui_color_rgba>): ui_color_rgba {
    return {
      r: Number.isFinite(value.r) ? value.r! : 0,
      g: Number.isFinite(value.g) ? value.g! : 0,
      b: Number.isFinite(value.b) ? value.b! : 0,
      a: Number.isFinite(value.a) ? value.a! : 1,
    }
  }

  private render_stack_debug_wireframes(): void {
    if (this.pending_stack_debug_wireframes.length === 0) return
    const scale = window.devicePixelRatio || 1
    const color = pack_rgba(1, 0.95, 0.45, 0.92)
    const thickness = Math.max(1, Math.round(scale * 0.5))
    for (const r of this.pending_stack_debug_wireframes) {
      this.ui.stroke_rect(r.x, r.y, r.w, r.h, thickness, color)
    }
  }

  private same_color(a: ui_color_rgba, b: ui_color_rgba): boolean {
    const next = this.normalize_color(b)
    return a.r === next.r && a.g === next.g && a.b === next.b && a.a === next.a
  }

  private draw_color_bar(x: number, y: number, w: number, h: number, radius: number, color: ui_color_rgba, label: string, font_px: number, scale: number): void {
    if (w <= 0 || h <= 0) return
    const normalized = this.normalize_color(color)
    const main = pack_rgba(normalized.r, normalized.g, normalized.b, normalized.a)
    this.ui.fill_round_rect(x, y, w, h, radius, main)

    const text = label || this.color_hex_label(normalized)
    const pad_x = 6 * scale
    const text_x = x + pad_x
    const text_y = this.ui.text_v_center_y(y, h, font_px)
    const shadow_offset = Math.max(0.5, 0.75 * scale)
    this.ui.push_clip(x + pad_x, y, Math.max(0, w - pad_x * 2), h)
    this.ui.draw_text_msdf(text_x, text_y, text, font_px, pack_rgba(normalized.r, normalized.g, normalized.b, 1), {
      weight: 0.1 * scale,
      shadow: {
        dx: shadow_offset,
        dy: shadow_offset,
        color: this.inverse_color(normalized),
        weight: 0.15 * scale,
      },
    })
    this.ui.pop_clip()
  }

  private inverse_color(color: ui_color_rgba): number {
    return pack_rgba(1 - color.r, 1 - color.g, 1 - color.b, 1)
  }

  private color_hex_label(color: ui_color_rgba): string {
    const normalized = this.normalize_color(color)
    const channel = (value: number) => Math.round(clamp_01(value) * 255).toString(16).padStart(2, '0').toUpperCase()
    const rgb = `#${channel(normalized.r)}${channel(normalized.g)}${channel(normalized.b)}`
    return normalized.a < 0.995 ? `${rgb}${channel(normalized.a)}` : rgb
  }

  private draw_hue_saturation_square(x: number, y: number, w: number, h: number, value: number): void {
    this.ui.draw_hsv_saturation_square(x, y, w, h, value)
    this.ui.stroke_rect(x, y, w, h, 1, this.color('border_strong'))
  }

  private draw_value_bar(x: number, y: number, w: number, h: number, hue: number, saturation: number, alpha: number): void {
    this.ui.draw_hsv_value_bar(x, y, w, h, hue, saturation, alpha)
    this.ui.stroke_rect(x, y, w, h, 1, this.color('border_strong'))
  }

  private hsv_to_rgb(hue: number, saturation: number, value: number): ui_color_rgba {
    const h = ((hue % 360) + 360) % 360
    const s = Math.max(0, Math.min(1, saturation))
    const v = Math.max(0, Math.min(1, value))
    const c = v * s
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
    const m = v - c
    let r = 0
    let g = 0
    let b = 0
    if (h < 60) {
      r = c
      g = x
    } else if (h < 120) {
      r = x
      g = c
    } else if (h < 180) {
      g = c
      b = x
    } else if (h < 240) {
      g = x
      b = c
    } else if (h < 300) {
      r = x
      b = c
    } else {
      r = c
      b = x
    }
    return { r: r + m, g: g + m, b: b + m, a: 1 }
  }

  private rgb_to_hsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const delta = max - min
    let h = 0
    if (delta > 0) {
      if (max === r) h = 60 * (((g - b) / delta) % 6)
      else if (max === g) h = 60 * ((b - r) / delta + 2)
      else h = 60 * ((r - g) / delta + 4)
    }
    if (h < 0) h += 360
    const s = max <= 0 ? 0 : delta / max
    return { h, s, v: max }
  }

  private selection_start(state: ui_input_text_state, collapse_to_cursor = false): number {
    if (collapse_to_cursor && this.has_selection(state)) return Math.min(state.sel_anchor, state.sel_head)
    return Math.min(state.sel_anchor, state.sel_head)
  }

  private selection_end(state: ui_input_text_state, collapse_to_cursor = false): number {
    if (collapse_to_cursor && this.has_selection(state)) return Math.max(state.sel_anchor, state.sel_head)
    return Math.max(state.sel_anchor, state.sel_head)
  }

  private has_selection(state: ui_input_text_state): boolean {
    return state.sel_anchor !== state.sel_head
  }

  private move_cursor(state: ui_input_text_state, next: number): void {
    state.cursor = next
    state.sel_anchor = next
    state.sel_head = next
  }

  private request_native_text_input(
    id: string,
    x: number,
    y: number,
    w: number,
    h: number,
    value: string,
    state: ui_input_text_state,
    mode: ui_native_text_input['mode'],
  ): void {
    this.input.native_text_input = {
      id,
      x,
      y,
      w,
      h,
      value,
      cursor: state.cursor,
      selection_start: this.selection_start(state),
      selection_end: this.selection_end(state),
      mode,
    }
  }

  private register_native_text_region(id: string, x: number, y: number, w: number, h: number, mode: ui_native_text_region['mode']): void {
    const regions = this.input.native_text_regions ?? []
    regions.push({ id, x, y, w, h, mode })
    this.input.native_text_regions = regions
  }

  private replace_selection(text: string, state: ui_input_text_state, insert: string): string {
    const start = this.selection_start(state)
    const end = this.selection_end(state)
    const next = text.slice(0, start) + insert + text.slice(end)
    const cursor = start + insert.length
    state.cursor = cursor
    state.sel_anchor = cursor
    state.sel_head = cursor
    return next
  }

  private color(slot: Parameters<typeof theme_color>[1]): number {
    return pack_color(theme_color(this.theme, slot))
  }
}

function pack_color(hex: string): number {
  const raw = hex.trim().replace('#', '')
  const parse = (start: number) => Number.parseInt(raw.slice(start, start + 2), 16)
  if (raw.length === 6) {
    const r = parse(0)
    const g = parse(2)
    const b = parse(4)
    return (((255 & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0
  }
  if (raw.length === 8) {
    const r = parse(0)
    const g = parse(2)
    const b = parse(4)
    const a = parse(6)
    return (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0
  }
  return 0xffffffff
}
