import type { theme_definition } from './ui_types'
import type {
  ui_widgets,
  ui_color_rgba,
  ui_input_snapshot,
  ui_input_text_state,
  ui_number_input_state,
  ui_scroll_state,
  ui_text_view_line,
  ui_text_view_options,
  ui_text_view_state,
} from './ui_widgets'

export const STACK_ALIGN_TOP = 1 << 0
export const STACK_ALIGN_BOTTOM = 1 << 1
export const STACK_ALIGN_LEFT = 1 << 2
export const STACK_ALIGN_RIGHT = 1 << 3
export const STACK_ALIGN_CENTER_VERT = 1 << 4
export const STACK_ALIGN_CENTER_HORI = 1 << 5

export const STACK_ALIGN_TOP_LEFT = STACK_ALIGN_TOP | STACK_ALIGN_LEFT
export const STACK_ALIGN_TOP_RIGHT = STACK_ALIGN_TOP | STACK_ALIGN_RIGHT
export const STACK_ALIGN_BOTTOM_LEFT = STACK_ALIGN_BOTTOM | STACK_ALIGN_LEFT
export const STACK_ALIGN_BOTTOM_RIGHT = STACK_ALIGN_BOTTOM | STACK_ALIGN_RIGHT
export const STACK_ALIGN_CENTER = STACK_ALIGN_CENTER_VERT | STACK_ALIGN_CENTER_HORI

/**
 * Sentinel size meaning "fill the available space along this dimension". On the
 * cross axis it fills the padded content extent; on the main axis it grows to
 * absorb the leftover space after padding, gaps, and fixed-size siblings, split
 * evenly between all filling siblings.
 */
export const STACK_FILL = -1

export const stack_layout_debug = {
  wireframe_hovered_stack: false,
}

export function set_stack_layout_debug_wireframe(enabled: boolean): void {
  stack_layout_debug.wireframe_hovered_stack = enabled
}

type stack_layout_debug_sink = (x: number, y: number, w: number, h: number) => void

let stack_layout_debug_pointer: Pick<ui_input_snapshot, 'mouse_x' | 'mouse_y'> | null = null
let stack_layout_debug_sink: stack_layout_debug_sink | null = null

export function set_stack_layout_debug_context(input: Pick<ui_input_snapshot, 'mouse_x' | 'mouse_y'> | null, sink: stack_layout_debug_sink | null): void {
  stack_layout_debug_pointer = input
  stack_layout_debug_sink = sink
}

function queue_stack_layout_debug_wireframe(x: number, y: number, w: number, h: number): void {
  const pointer = stack_layout_debug_pointer
  const sink = stack_layout_debug_sink
  if (!sink || !pointer || !stack_layout_debug.wireframe_hovered_stack || w <= 0 || h <= 0) return
  if (pointer.mouse_x < x || pointer.mouse_y < y || pointer.mouse_x >= x + w || pointer.mouse_y >= y + h) return
  sink(x, y, w, h)
}

export type stack_kind = 'vstack' | 'hstack' | 'zstack'

export interface stack_rect {
  x: number
  y: number
  w: number
  h: number
}

export interface stack_size {
  w: number
  h: number
}

export interface stack_layout_options {
  kind: stack_kind
  x: number
  y: number
  w: number
  h: number
  count: number
  alignment?: number
  reverse?: boolean
  gap?: number
  padding?: number
}

export type stack_widget_size = number | stack_size

export interface stack_widget_begin_options extends stack_layout_options {
  sizes?: ArrayLike<number>
  rects?: { [index: number]: number }
  size_stride?: number
  rect_stride?: number
}

export interface stack_widget_axis_options {
  alignment?: number
  reverse?: boolean
  gap?: number
  padding?: number
  sizes?: ArrayLike<number>
  rects?: { [index: number]: number }
  size_stride?: number
  rect_stride?: number
}

function align_hori(mask: number, x: number, w: number, item_w: number): number {
  if (mask & STACK_ALIGN_CENTER_HORI) return x + (w - item_w) * 0.5
  if (mask & STACK_ALIGN_RIGHT) return x + w - item_w
  return x
}

function align_vert(mask: number, y: number, h: number, item_h: number): number {
  if (mask & STACK_ALIGN_CENTER_VERT) return y + (h - item_h) * 0.5
  if (mask & STACK_ALIGN_BOTTOM) return y + h - item_h
  return y
}

function align_main_start(mask: number, origin: number, available: number, used: number, start_bit: number, end_bit: number, center_bit: number): number {
  if (mask & center_bit) return origin + (available - used) * 0.5
  if (mask & end_bit) return origin + available - used
  if (mask & start_bit) return origin
  return origin
}

function fill_size(size: number, fill: number): number {
  return size === STACK_FILL ? fill : size
}

function read_size_w(sizes: ArrayLike<number>, index: number, size_stride: number): number {
  return sizes[index * size_stride]
}

function read_size_h(sizes: ArrayLike<number>, index: number, size_stride: number): number {
  return sizes[index * size_stride + 1]
}

function write_rect(out: { [index: number]: number }, out_index: number, out_stride: number, x: number, y: number, w: number, h: number): void {
  const offset = out_index * out_stride
  out[offset] = x
  out[offset + 1] = y
  out[offset + 2] = w
  out[offset + 3] = h
}

/**
 * Computes VStack, HStack, or ZStack child target rects into a caller-owned
 * numeric buffer. `sizes` is `[w, h, w, h, ...]` by default and `out` receives
 * `[x, y, w, h, x, y, w, h, ...]`.
 *
 * This function performs no heap allocation in the layout path. Preallocate
 * `sizes` and `out` once, then reuse them each frame.
 */
export function layout_stack_into(
  options: stack_layout_options,
  sizes: ArrayLike<number>,
  out: { [index: number]: number },
  size_stride = 2,
  out_stride = 4,
): void {
  layout_stack_params_into(
    options.kind,
    options.x,
    options.y,
    options.w,
    options.h,
    sizes,
    options.count,
    out,
    options.alignment ?? STACK_ALIGN_TOP_LEFT,
    options.reverse === true,
    options.gap ?? 0,
    size_stride,
    out_stride,
    options.padding ?? 0,
  )
}

export function layout_stack_params_into(
  kind: stack_kind,
  x: number,
  y: number,
  w: number,
  h: number,
  sizes: ArrayLike<number>,
  count: number,
  out: { [index: number]: number },
  alignment = STACK_ALIGN_TOP_LEFT,
  reverse = false,
  gap = 0,
  size_stride = 2,
  out_stride = 4,
  padding = 0,
): void {
  count = Math.max(0, count | 0)
  queue_stack_layout_debug_wireframe(x, y, w, h)

  const px = x + padding
  const py = y + padding
  const pw = Math.max(0, w - padding * 2)
  const ph = Math.max(0, h - padding * 2)

  if (kind === 'zstack') {
    for (let i = 0; i < count; i += 1) {
      const child = reverse ? count - 1 - i : i
      const cw = fill_size(read_size_w(sizes, child, size_stride), pw)
      const ch = fill_size(read_size_h(sizes, child, size_stride), ph)
      write_rect(out, child, out_stride, align_hori(alignment, px, pw, cw), align_vert(alignment, py, ph, ch), cw, ch)
    }
    return
  }

  const main_content = kind === 'vstack' ? ph : pw
  let fixed = 0
  let flex = 0
  for (let i = 0; i < count; i += 1) {
    const m = kind === 'vstack' ? read_size_h(sizes, i, size_stride) : read_size_w(sizes, i, size_stride)
    if (m === STACK_FILL) flex += 1
    else fixed += m
  }
  const total_gap = count > 1 ? gap * (count - 1) : 0
  const flex_each = flex > 0 ? Math.max(0, main_content - fixed - total_gap) / flex : 0
  const used = flex > 0 ? Math.max(main_content, fixed + total_gap) : fixed + total_gap

  if (kind === 'vstack') {
    let cursor = align_main_start(alignment, py, ph, used, STACK_ALIGN_TOP, STACK_ALIGN_BOTTOM, STACK_ALIGN_CENTER_VERT)
    for (let i = 0; i < count; i += 1) {
      const child = reverse ? count - 1 - i : i
      const cw = fill_size(read_size_w(sizes, child, size_stride), pw)
      const ch = fill_size(read_size_h(sizes, child, size_stride), flex_each)
      write_rect(out, child, out_stride, align_hori(alignment, px, pw, cw), cursor, cw, ch)
      cursor += ch + gap
    }
    return
  }

  let cursor = align_main_start(alignment, px, pw, used, STACK_ALIGN_LEFT, STACK_ALIGN_RIGHT, STACK_ALIGN_CENTER_HORI)
  for (let i = 0; i < count; i += 1) {
    const child = reverse ? count - 1 - i : i
    const cw = fill_size(read_size_w(sizes, child, size_stride), flex_each)
    const ch = fill_size(read_size_h(sizes, child, size_stride), ph)
    write_rect(out, child, out_stride, cursor, align_vert(alignment, py, ph, ch), cw, ch)
    cursor += cw + gap
  }
}

export function layout_vstack_into(
  x: number,
  y: number,
  w: number,
  h: number,
  sizes: ArrayLike<number>,
  count: number,
  out: { [index: number]: number },
  alignment = STACK_ALIGN_TOP_LEFT,
  reverse = false,
  gap = 0,
  padding = 0,
): void {
  layout_stack_params_into('vstack', x, y, w, h, sizes, count, out, alignment, reverse, gap, 2, 4, padding)
}

export function layout_hstack_into(
  x: number,
  y: number,
  w: number,
  h: number,
  sizes: ArrayLike<number>,
  count: number,
  out: { [index: number]: number },
  alignment = STACK_ALIGN_TOP_LEFT,
  reverse = false,
  gap = 0,
  padding = 0,
): void {
  layout_stack_params_into('hstack', x, y, w, h, sizes, count, out, alignment, reverse, gap, 2, 4, padding)
}

export function layout_zstack_into(
  x: number,
  y: number,
  w: number,
  h: number,
  sizes: ArrayLike<number>,
  count: number,
  out: { [index: number]: number },
  alignment = STACK_ALIGN_CENTER,
  reverse = false,
  padding = 0,
): void {
  layout_stack_params_into('zstack', x, y, w, h, sizes, count, out, alignment, reverse, 0, 2, 4, padding)
}

/**
 * Object-rect variant for callers that already keep persistent rect objects.
 * `out.length` must be at least `count`; no rects are created here.
 */
export function layout_stack_rects_into(options: stack_layout_options, sizes: ArrayLike<stack_size>, out: stack_rect[]): void {
  const count = Math.max(0, options.count | 0)
  const kind = options.kind
  const x = options.x
  const y = options.y
  const w = options.w
  const h = options.h
  queue_stack_layout_debug_wireframe(x, y, w, h)
  const alignment = options.alignment ?? STACK_ALIGN_TOP_LEFT
  const reverse = options.reverse === true
  const gap = options.gap ?? 0
  const padding = options.padding ?? 0

  const px = x + padding
  const py = y + padding
  const pw = Math.max(0, w - padding * 2)
  const ph = Math.max(0, h - padding * 2)

  if (kind === 'zstack') {
    for (let i = 0; i < count; i += 1) {
      const child = reverse ? count - 1 - i : i
      const size = sizes[child]
      const rect = out[child]
      const cw = fill_size(size.w, pw)
      const ch = fill_size(size.h, ph)
      rect.x = align_hori(alignment, px, pw, cw)
      rect.y = align_vert(alignment, py, ph, ch)
      rect.w = cw
      rect.h = ch
    }
    return
  }

  const main_content = kind === 'vstack' ? ph : pw
  let fixed = 0
  let flex = 0
  for (let i = 0; i < count; i += 1) {
    const m = kind === 'vstack' ? sizes[i].h : sizes[i].w
    if (m === STACK_FILL) flex += 1
    else fixed += m
  }
  const total_gap = count > 1 ? gap * (count - 1) : 0
  const flex_each = flex > 0 ? Math.max(0, main_content - fixed - total_gap) / flex : 0
  const used = flex > 0 ? Math.max(main_content, fixed + total_gap) : fixed + total_gap

  if (kind === 'vstack') {
    let cursor = align_main_start(alignment, py, ph, used, STACK_ALIGN_TOP, STACK_ALIGN_BOTTOM, STACK_ALIGN_CENTER_VERT)
    for (let i = 0; i < count; i += 1) {
      const child = reverse ? count - 1 - i : i
      const size = sizes[child]
      const rect = out[child]
      const cw = fill_size(size.w, pw)
      const ch = fill_size(size.h, flex_each)
      rect.x = align_hori(alignment, px, pw, cw)
      rect.y = cursor
      rect.w = cw
      rect.h = ch
      cursor += ch + gap
    }
    return
  }

  let cursor = align_main_start(alignment, px, pw, used, STACK_ALIGN_LEFT, STACK_ALIGN_RIGHT, STACK_ALIGN_CENTER_HORI)
  for (let i = 0; i < count; i += 1) {
    const child = reverse ? count - 1 - i : i
    const size = sizes[child]
    const rect = out[child]
    const cw = fill_size(size.w, flex_each)
    const ch = fill_size(size.h, ph)
    rect.x = cursor
    rect.y = align_vert(alignment, py, ph, ch)
    rect.w = cw
    rect.h = ch
    cursor += cw + gap
  }
}

/**
 * Stack-bound facade over {@link ui_widgets}. Each rect-taking widget consumes
 * one stack slot, computes that slot's target rect, and forwards to the
 * underlying widget.
 *
 * For centered/end-aligned or reversed VStack/HStack usage, pass premeasured
 * `sizes` to {@link begin}. For the fastest no-GC path, also pass a caller-owned
 * `rects` buffer; the stack computes all child rects once and widget calls only
 * read from that buffer.
 */
export class stack_ui_layout {
  private kind: stack_kind = 'vstack'
  private x = 0
  private y = 0
  private w = 0
  private h = 0
  private px = 0
  private py = 0
  private pw = 0
  private ph = 0
  private count = 0
  private alignment = STACK_ALIGN_TOP_LEFT
  private reverse = false
  private gap = 0
  private padding = 0
  private index = 0
  private cursor = 0
  private sizes: ArrayLike<number> | null = null
  private rects: { [index: number]: number } | null = null
  private size_stride = 2
  private rect_stride = 4
  private main_used = 0
  private flex_each = 0
  private readonly rect: stack_rect = { x: 0, y: 0, w: 0, h: 0 }

  constructor(private readonly widgets: ui_widgets) {}

  begin(options: stack_widget_begin_options): void {
    this.begin_params(
      options.kind,
      options.x,
      options.y,
      options.w,
      options.h,
      options.count,
      options.alignment ?? STACK_ALIGN_TOP_LEFT,
      options.reverse === true,
      options.gap ?? 0,
      options.sizes,
      options.rects,
      options.size_stride ?? 2,
      options.rect_stride ?? 4,
      options.padding ?? 0,
    )
  }

  begin_params(
    kind: stack_kind,
    x: number,
    y: number,
    w: number,
    h: number,
    count: number,
    alignment = STACK_ALIGN_TOP_LEFT,
    reverse = false,
    gap = 0,
    sizes?: ArrayLike<number>,
    rects?: { [index: number]: number },
    size_stride = 2,
    rect_stride = 4,
    padding = 0,
  ): void {
    this.kind = kind
    this.x = x
    this.y = y
    this.w = w
    this.h = h
    this.padding = padding
    this.px = x + padding
    this.py = y + padding
    this.pw = Math.max(0, w - padding * 2)
    this.ph = Math.max(0, h - padding * 2)
    this.count = Math.max(0, count | 0)
    this.alignment = alignment
    this.reverse = reverse
    this.gap = gap
    this.index = 0
    this.sizes = sizes ?? null
    this.rects = sizes ? rects ?? null : null
    this.size_stride = size_stride
    this.rect_stride = rect_stride
    this.compute_main_layout()

    if (this.rects && this.sizes) {
      layout_stack_params_into(this.kind, this.x, this.y, this.w, this.h, this.sizes, this.count, this.rects, this.alignment, this.reverse, this.gap, this.size_stride, this.rect_stride, this.padding)
    }

    if (this.kind === 'vstack') {
      this.cursor = align_main_start(this.alignment, this.py, this.ph, this.main_used, STACK_ALIGN_TOP, STACK_ALIGN_BOTTOM, STACK_ALIGN_CENTER_VERT)
    } else {
      this.cursor = align_main_start(this.alignment, this.px, this.pw, this.main_used, STACK_ALIGN_LEFT, STACK_ALIGN_RIGHT, STACK_ALIGN_CENTER_HORI)
    }

    if (!this.rects || !this.sizes) queue_stack_layout_debug_wireframe(this.x, this.y, this.w, this.h)
  }

  vstack(x: number, y: number, w: number, h: number, count: number, options?: stack_widget_axis_options): void {
    this.begin_params('vstack', x, y, w, h, count, options?.alignment ?? STACK_ALIGN_TOP_LEFT, options?.reverse === true, options?.gap ?? 0, options?.sizes, options?.rects, options?.size_stride ?? 2, options?.rect_stride ?? 4, options?.padding ?? 0)
  }

  hstack(x: number, y: number, w: number, h: number, count: number, options?: stack_widget_axis_options): void {
    this.begin_params('hstack', x, y, w, h, count, options?.alignment ?? STACK_ALIGN_TOP_LEFT, options?.reverse === true, options?.gap ?? 0, options?.sizes, options?.rects, options?.size_stride ?? 2, options?.rect_stride ?? 4, options?.padding ?? 0)
  }

  zstack(x: number, y: number, w: number, h: number, count: number, options?: stack_widget_axis_options): void {
    this.begin_params('zstack', x, y, w, h, count, options?.alignment ?? STACK_ALIGN_CENTER, options?.reverse === true, options?.gap ?? 0, options?.sizes, options?.rects, options?.size_stride ?? 2, options?.rect_stride ?? 4, options?.padding ?? 0)
  }

  end(): void {
    this.index = this.count
  }

  next_rect(size?: stack_widget_size): stack_rect {
    const child = this.index++
    const rects = this.rects
    if (rects) {
      const offset = child * this.rect_stride
      this.rect.x = rects[offset]
      this.rect.y = rects[offset + 1]
      this.rect.w = rects[offset + 2]
      this.rect.h = rects[offset + 3]
      return this.rect
    }

    const cw = this.child_w(child, size)
    const ch = this.child_h(child, size)
    if (this.kind === 'zstack') {
      this.rect.x = align_hori(this.alignment, this.px, this.pw, cw)
      this.rect.y = align_vert(this.alignment, this.py, this.ph, ch)
      this.rect.w = cw
      this.rect.h = ch
      return this.rect
    }

    if (this.sizes && this.reverse) {
      const main = this.reversed_child_main_offset(child)
      if (this.kind === 'vstack') {
        this.rect.x = align_hori(this.alignment, this.px, this.pw, cw)
        this.rect.y = this.cursor + main
      } else {
        this.rect.x = this.cursor + main
        this.rect.y = align_vert(this.alignment, this.py, this.ph, ch)
      }
    } else if (this.kind === 'vstack') {
      this.rect.x = align_hori(this.alignment, this.px, this.pw, cw)
      this.rect.y = this.cursor
      this.cursor += ch + this.gap
    } else {
      this.rect.x = this.cursor
      this.rect.y = align_vert(this.alignment, this.py, this.ph, ch)
      this.cursor += cw + this.gap
    }
    this.rect.w = cw
    this.rect.h = ch
    return this.rect
  }

  begin_frame(theme: theme_definition, input: ui_input_snapshot): void {
    this.widgets.begin_frame(theme, input)
  }

  end_frame(): void {
    this.widgets.end_frame()
  }

  section(size: stack_widget_size, label: string): number {
    const r = this.next_rect(size)
    return this.widgets.section(r.x, r.y, r.w, label)
  }

  button(id: string, size: stack_widget_size, label: string, options?: { active?: boolean }): boolean {
    const r = this.next_rect(size)
    return this.widgets.button(id, r.x, r.y, r.w, r.h, label, options)
  }

  toggle(id: string, size: stack_widget_size, value: boolean, label?: string): boolean {
    const r = this.next_rect(size)
    return this.widgets.toggle(id, r.x, r.y, value, label)
  }

  slider(id: string, size: stack_widget_size, value: number, min: number, max: number, show_value = false): number {
    const r = this.next_rect(size)
    return this.widgets.slider(id, r.x, r.y, r.w, r.h, value, min, max, show_value)
  }

  list(id: string, size: stack_widget_size, items: string[], selected: number, scroll: ui_scroll_state): number {
    const r = this.next_rect(size)
    return this.widgets.list(id, r.x, r.y, r.w, r.h, items, selected, scroll)
  }

  dropdown(
    id: string,
    size: stack_widget_size,
    items: string[],
    selected: number,
    options?: { chrome?: 'rounded' | 'rect' | 'none'; display_label?: string; show_arrow?: boolean },
  ): number {
    const r = this.next_rect(size)
    return this.widgets.dropdown(id, r.x, r.y, r.w, r.h, items, selected, options)
  }

  set_dropdown_value(id: string, value: number): void {
    this.widgets.set_dropdown_value(id, value)
  }

  scrollbar(id: string, size: stack_widget_size, scroll: ui_scroll_state, content_h: number): void {
    const r = this.next_rect(size)
    this.widgets.scrollbar(id, r.x, r.y, r.w, r.h, scroll, content_h)
  }

  hit_region(size: stack_widget_size): { hovered: boolean; pressed: boolean } {
    const r = this.next_rect(size)
    return this.widgets.hit_region(r.x, r.y, r.w, r.h)
  }

  handle_scroll_area(size: stack_widget_size, scroll: ui_scroll_state, content_h: number): void {
    const r = this.next_rect(size)
    this.widgets.handle_scroll_area(r.x, r.y, r.w, r.h, scroll, content_h)
  }

  is_escape_pressed(): boolean {
    return this.widgets.is_escape_pressed()
  }

  is_enter_pressed(): boolean {
    return this.widgets.is_enter_pressed()
  }

  is_mouse_down(): boolean {
    return this.widgets.is_mouse_down()
  }

  is_mouse_pressed(): boolean {
    return this.widgets.is_mouse_pressed()
  }

  has_keyboard_focus(): boolean {
    return this.widgets.has_keyboard_focus()
  }

  focus_text_input(id: string, state: ui_input_text_state, cursor = state.cursor): void {
    this.widgets.focus_text_input(id, state, cursor)
  }

  mouse_x(): number {
    return this.widgets.mouse_x()
  }

  mouse_y(): number {
    return this.widgets.mouse_y()
  }

  input_text(id: string, size: stack_widget_size, buf: string, placeholder: string, state: ui_input_text_state): string {
    const r = this.next_rect(size)
    return this.widgets.input_text(id, r.x, r.y, r.w, r.h, buf, placeholder, state)
  }

  input_field(id: string, size: stack_widget_size, buf: string, placeholder: string, state: ui_input_text_state): string {
    const r = this.next_rect(size)
    return this.widgets.input_field(id, r.x, r.y, r.w, r.h, buf, placeholder, state)
  }

  number_input(
    id: string,
    size: stack_widget_size,
    value: number,
    state: ui_number_input_state,
    options?: { min?: number; max?: number; step?: number; decimals?: number },
  ): number {
    const r = this.next_rect(size)
    return this.widgets.number_input(id, r.x, r.y, r.w, r.h, value, state, options)
  }

  ui_color_picker(id: string, size: stack_widget_size, value: ui_color_rgba, options?: { label?: string; popup_w?: number }): ui_color_rgba {
    const r = this.next_rect(size)
    return this.widgets.ui_color_picker(id, r.x, r.y, r.w, r.h, value, options)
  }

  text_view(id: string, size: stack_widget_size, lines: ui_text_view_line[], state: ui_text_view_state, options?: ui_text_view_options): void {
    const r = this.next_rect(size)
    this.widgets.text_view(id, r.x, r.y, r.w, r.h, lines, state, options)
  }

  get_text_view_selected_text(lines: ui_text_view_line[], state: ui_text_view_state): string {
    return this.widgets.get_text_view_selected_text(lines, state)
  }

  private compute_main_layout(): void {
    this.main_used = 0
    this.flex_each = 0
    if (!this.sizes || this.kind === 'zstack') return
    const main_content = this.kind === 'vstack' ? this.ph : this.pw
    let fixed = 0
    let flex = 0
    for (let i = 0; i < this.count; i += 1) {
      const m = this.kind === 'vstack' ? read_size_h(this.sizes, i, this.size_stride) : read_size_w(this.sizes, i, this.size_stride)
      if (m === STACK_FILL) flex += 1
      else fixed += m
    }
    const total_gap = this.count > 1 ? this.gap * (this.count - 1) : 0
    this.flex_each = flex > 0 ? Math.max(0, main_content - fixed - total_gap) / flex : 0
    this.main_used = flex > 0 ? Math.max(main_content, fixed + total_gap) : fixed + total_gap
  }

  private child_w(child: number, size?: stack_widget_size): number {
    if (this.sizes) {
      const v = read_size_w(this.sizes, child, this.size_stride)
      if (v !== STACK_FILL) return v
      return this.kind === 'hstack' ? this.flex_each : this.pw
    }
    if (typeof size === 'number') {
      if (this.kind === 'hstack') return size === STACK_FILL ? this.main_remaining() : size
      return this.pw
    }
    if (size) {
      if (this.kind === 'hstack') return size.w === STACK_FILL ? this.main_remaining() : size.w
      return size.w === STACK_FILL ? this.pw : size.w
    }
    return this.kind === 'hstack' ? 0 : this.pw
  }

  private child_h(child: number, size?: stack_widget_size): number {
    if (this.sizes) {
      const v = read_size_h(this.sizes, child, this.size_stride)
      if (v !== STACK_FILL) return v
      return this.kind === 'vstack' ? this.flex_each : this.ph
    }
    if (typeof size === 'number') {
      if (this.kind === 'vstack') return size === STACK_FILL ? this.main_remaining() : size
      return this.ph
    }
    if (size) {
      if (this.kind === 'vstack') return size.h === STACK_FILL ? this.main_remaining() : size.h
      return size.h === STACK_FILL ? this.ph : size.h
    }
    return this.kind === 'vstack' ? 0 : this.ph
  }

  private main_remaining(): number {
    if (this.kind === 'vstack') return Math.max(0, this.py + this.ph - this.cursor)
    if (this.kind === 'hstack') return Math.max(0, this.px + this.pw - this.cursor)
    return 0
  }

  private reversed_child_main_offset(child: number): number {
    if (!this.sizes) return 0
    let offset = 0
    for (let i = this.count - 1; i > child; i -= 1) {
      const m = this.kind === 'vstack' ? read_size_h(this.sizes, i, this.size_stride) : read_size_w(this.sizes, i, this.size_stride)
      offset += m === STACK_FILL ? this.flex_each : m
      offset += this.gap
    }
    return offset
  }
}

export function create_stack_ui_layout(widgets: ui_widgets): stack_ui_layout {
  return new stack_ui_layout(widgets)
}
