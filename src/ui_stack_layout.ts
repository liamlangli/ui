import type { theme_definition } from './ui_types'
import {
  ui_widgets,
  type ui_color_rgba,
  type ui_input_snapshot,
  type ui_input_text_state,
  type ui_number_input_state,
  type ui_scroll_state,
  type ui_text_view_line,
  type ui_text_view_options,
  type ui_text_view_state,
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
): void {
  count = Math.max(0, count | 0)

  if (kind === 'zstack') {
    for (let i = 0; i < count; i += 1) {
      const child = reverse ? count - 1 - i : i
      const cw = read_size_w(sizes, child, size_stride)
      const ch = read_size_h(sizes, child, size_stride)
      write_rect(out, child, out_stride, align_hori(alignment, x, w, cw), align_vert(alignment, y, h, ch), cw, ch)
    }
    return
  }

  let used = count > 1 ? gap * (count - 1) : 0
  for (let i = 0; i < count; i += 1) {
    used += kind === 'vstack' ? read_size_h(sizes, i, size_stride) : read_size_w(sizes, i, size_stride)
  }

  if (kind === 'vstack') {
    let cursor = align_main_start(alignment, y, h, used, STACK_ALIGN_TOP, STACK_ALIGN_BOTTOM, STACK_ALIGN_CENTER_VERT)
    for (let i = 0; i < count; i += 1) {
      const child = reverse ? count - 1 - i : i
      const cw = read_size_w(sizes, child, size_stride)
      const ch = read_size_h(sizes, child, size_stride)
      write_rect(out, child, out_stride, align_hori(alignment, x, w, cw), cursor, cw, ch)
      cursor += ch + gap
    }
    return
  }

  let cursor = align_main_start(alignment, x, w, used, STACK_ALIGN_LEFT, STACK_ALIGN_RIGHT, STACK_ALIGN_CENTER_HORI)
  for (let i = 0; i < count; i += 1) {
    const child = reverse ? count - 1 - i : i
    const cw = read_size_w(sizes, child, size_stride)
    const ch = read_size_h(sizes, child, size_stride)
    write_rect(out, child, out_stride, cursor, align_vert(alignment, y, h, ch), cw, ch)
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
): void {
  layout_stack_params_into('vstack', x, y, w, h, sizes, count, out, alignment, reverse, gap)
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
): void {
  layout_stack_params_into('hstack', x, y, w, h, sizes, count, out, alignment, reverse, gap)
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
): void {
  layout_stack_params_into('zstack', x, y, w, h, sizes, count, out, alignment, reverse)
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
  const alignment = options.alignment ?? STACK_ALIGN_TOP_LEFT
  const reverse = options.reverse === true
  const gap = options.gap ?? 0

  if (kind === 'zstack') {
    for (let i = 0; i < count; i += 1) {
      const child = reverse ? count - 1 - i : i
      const size = sizes[child]
      const rect = out[child]
      rect.x = align_hori(alignment, x, w, size.w)
      rect.y = align_vert(alignment, y, h, size.h)
      rect.w = size.w
      rect.h = size.h
    }
    return
  }

  let used = count > 1 ? gap * (count - 1) : 0
  for (let i = 0; i < count; i += 1) {
    const size = sizes[i]
    used += kind === 'vstack' ? size.h : size.w
  }

  if (kind === 'vstack') {
    let cursor = align_main_start(alignment, y, h, used, STACK_ALIGN_TOP, STACK_ALIGN_BOTTOM, STACK_ALIGN_CENTER_VERT)
    for (let i = 0; i < count; i += 1) {
      const child = reverse ? count - 1 - i : i
      const size = sizes[child]
      const rect = out[child]
      rect.x = align_hori(alignment, x, w, size.w)
      rect.y = cursor
      rect.w = size.w
      rect.h = size.h
      cursor += size.h + gap
    }
    return
  }

  let cursor = align_main_start(alignment, x, w, used, STACK_ALIGN_LEFT, STACK_ALIGN_RIGHT, STACK_ALIGN_CENTER_HORI)
  for (let i = 0; i < count; i += 1) {
    const child = reverse ? count - 1 - i : i
    const size = sizes[child]
    const rect = out[child]
    rect.x = cursor
    rect.y = align_vert(alignment, y, h, size.h)
    rect.w = size.w
    rect.h = size.h
    cursor += size.w + gap
  }
}

function numeric_size_w(kind: stack_kind, container_w: number, container_h: number, size: stack_widget_size | undefined): number {
  if (typeof size === 'number') return kind === 'vstack' || kind === 'zstack' ? container_w : size
  if (size) return size.w
  return kind === 'hstack' ? 0 : container_w
}

function numeric_size_h(kind: stack_kind, container_w: number, container_h: number, size: stack_widget_size | undefined): number {
  if (typeof size === 'number') return kind === 'hstack' || kind === 'zstack' ? container_h : size
  if (size) return size.h
  return kind === 'vstack' ? 0 : container_h
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
  private count = 0
  private alignment = STACK_ALIGN_TOP_LEFT
  private reverse = false
  private gap = 0
  private index = 0
  private cursor = 0
  private sizes: ArrayLike<number> | null = null
  private rects: { [index: number]: number } | null = null
  private size_stride = 2
  private rect_stride = 4
  private main_used = 0
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
  ): void {
    this.kind = kind
    this.x = x
    this.y = y
    this.w = w
    this.h = h
    this.count = Math.max(0, count | 0)
    this.alignment = alignment
    this.reverse = reverse
    this.gap = gap
    this.index = 0
    this.sizes = sizes ?? null
    this.rects = sizes ? rects ?? null : null
    this.size_stride = size_stride
    this.rect_stride = rect_stride
    this.main_used = this.compute_main_used()

    if (this.rects && this.sizes) {
      layout_stack_params_into(this.kind, this.x, this.y, this.w, this.h, this.sizes, this.count, this.rects, this.alignment, this.reverse, this.gap, this.size_stride, this.rect_stride)
    }

    if (this.kind === 'vstack') {
      this.cursor = align_main_start(this.alignment, this.y, this.h, this.main_used, STACK_ALIGN_TOP, STACK_ALIGN_BOTTOM, STACK_ALIGN_CENTER_VERT)
    } else {
      this.cursor = align_main_start(this.alignment, this.x, this.w, this.main_used, STACK_ALIGN_LEFT, STACK_ALIGN_RIGHT, STACK_ALIGN_CENTER_HORI)
    }
  }

  vstack(x: number, y: number, w: number, h: number, count: number, options?: stack_widget_axis_options): void {
    this.begin_params('vstack', x, y, w, h, count, options?.alignment ?? STACK_ALIGN_TOP_LEFT, options?.reverse === true, options?.gap ?? 0, options?.sizes, options?.rects, options?.size_stride ?? 2, options?.rect_stride ?? 4)
  }

  hstack(x: number, y: number, w: number, h: number, count: number, options?: stack_widget_axis_options): void {
    this.begin_params('hstack', x, y, w, h, count, options?.alignment ?? STACK_ALIGN_TOP_LEFT, options?.reverse === true, options?.gap ?? 0, options?.sizes, options?.rects, options?.size_stride ?? 2, options?.rect_stride ?? 4)
  }

  zstack(x: number, y: number, w: number, h: number, count: number, options?: stack_widget_axis_options): void {
    this.begin_params('zstack', x, y, w, h, count, options?.alignment ?? STACK_ALIGN_CENTER, options?.reverse === true, options?.gap ?? 0, options?.sizes, options?.rects, options?.size_stride ?? 2, options?.rect_stride ?? 4)
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
      this.rect.x = align_hori(this.alignment, this.x, this.w, cw)
      this.rect.y = align_vert(this.alignment, this.y, this.h, ch)
      this.rect.w = cw
      this.rect.h = ch
      return this.rect
    }

    if (this.sizes && this.reverse) {
      const main = this.reversed_child_main_offset(child)
      if (this.kind === 'vstack') {
        this.rect.x = align_hori(this.alignment, this.x, this.w, cw)
        this.rect.y = this.cursor + main
      } else {
        this.rect.x = this.cursor + main
        this.rect.y = align_vert(this.alignment, this.y, this.h, ch)
      }
    } else if (this.kind === 'vstack') {
      this.rect.x = align_hori(this.alignment, this.x, this.w, cw)
      this.rect.y = this.cursor
      this.cursor += ch + this.gap
    } else {
      this.rect.x = this.cursor
      this.rect.y = align_vert(this.alignment, this.y, this.h, ch)
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

  private compute_main_used(): number {
    if (!this.sizes) return 0
    let used = this.count > 1 ? this.gap * (this.count - 1) : 0
    for (let i = 0; i < this.count; i += 1) {
      used += this.kind === 'vstack' ? read_size_h(this.sizes, i, this.size_stride) : this.kind === 'hstack' ? read_size_w(this.sizes, i, this.size_stride) : 0
    }
    return used
  }

  private child_w(child: number, size?: stack_widget_size): number {
    if (this.sizes) return read_size_w(this.sizes, child, this.size_stride)
    return numeric_size_w(this.kind, this.w, this.h, size)
  }

  private child_h(child: number, size?: stack_widget_size): number {
    if (this.sizes) return read_size_h(this.sizes, child, this.size_stride)
    return numeric_size_h(this.kind, this.w, this.h, size)
  }

  private reversed_child_main_offset(child: number): number {
    if (!this.sizes) return 0
    let offset = 0
    for (let i = this.count - 1; i > child; i -= 1) {
      offset += this.kind === 'vstack' ? read_size_h(this.sizes, i, this.size_stride) : read_size_w(this.sizes, i, this.size_stride)
      offset += this.gap
    }
    return offset
  }
}

export function create_stack_ui_layout(widgets: ui_widgets): stack_ui_layout {
  return new stack_ui_layout(widgets)
}
