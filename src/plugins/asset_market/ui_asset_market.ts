// asset_market — an immediate-mode audited asset marketplace.
//
// Renders a scrollable thumbnail grid of host-owned assets next to a cart. The
// host owns the asset list and checkout handling; this plugin owns selection,
// scrolling, quantities and hit-testing, then reports cart / checkout intents.

import { theme_color } from '../../core/ui_theme'
import type { theme_definition, theme_slot } from '../../core/ui_types'
import { FONT_MONO, ui_renderer } from '../../core/ui_renderer'
import type { ui_input_snapshot, ui_scroll_state } from '../../core/ui_widgets'

export type asset_audit_status = 'passed' | 'warning' | 'failed' | 'pending'

export interface asset_market_item {
  id: string
  name: string
  /** Short label drawn on the card, e.g. `HDRI`, `MESH`, `MAT`. */
  type_label: string
  /** Secondary text such as author, source, or audit batch. */
  subtitle?: string
  audit_status?: asset_audit_status
  /** Optional price in cents. Omit or set to 0 for free assets. */
  price_cents?: number
  /** Optional packed `0xAABBGGRR` thumbnail seed color for fallback art. */
  thumbnail_color?: number
}

export interface asset_market_cart_line {
  asset: asset_market_item
  quantity: number
}

export interface asset_market_state {
  selected_asset_id: string | null
  cart: Map<string, number>
  grid_scroll: ui_scroll_state
  cart_scroll: ui_scroll_state
  /** Internal: prevents one pointer press from activating multiple cart actions. */
  _press_consumed: boolean
}

export interface asset_market_options {
  font_px?: number
  card_w?: number
  card_h?: number
  cart_w?: number
  checkout_label?: string
  empty_label?: string
  /** Draw a thumbnail; return true if it drew, otherwise fallback art is used. */
  render_thumbnail?: (asset: asset_market_item, x: number, y: number, w: number, h: number) => boolean
}

export interface asset_market_event {
  selected?: asset_market_item
  added?: asset_market_item
  removed?: asset_market_item
  quantity_changed?: { asset: asset_market_item; quantity: number }
  checkout?: { lines: asset_market_cart_line[]; total_cents: number }
}

export function create_asset_market_state(): asset_market_state {
  return {
    selected_asset_id: null,
    cart: new Map<string, number>(),
    grid_scroll: { offset_y: 0 },
    cart_scroll: { offset_y: 0 },
    _press_consumed: false,
  }
}

export function asset_market_cart_lines(items: asset_market_item[], state: asset_market_state): asset_market_cart_line[] {
  const by_id = new Map(items.map((item) => [item.id, item]))
  const lines: asset_market_cart_line[] = []
  for (const [id, quantity] of state.cart) {
    const asset = by_id.get(id)
    if (asset && quantity > 0) lines.push({ asset, quantity })
  }
  return lines
}

export function asset_market_cart_total(lines: asset_market_cart_line[]): number {
  let total = 0
  for (const line of lines) total += (line.asset.price_cents ?? 0) * line.quantity
  return total
}

export function asset_market(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  items: asset_market_item[],
  state: asset_market_state,
  options?: asset_market_options,
): asset_market_event {
  const scale = window.devicePixelRatio || 1
  const font_px = (options?.font_px ?? 12.5) * scale
  const col = (slot: theme_slot) => pack(theme_color(theme, slot))
  const event: asset_market_event = {}
  const pad = 10 * scale
  const header_h = 36 * scale
  const gap = 8 * scale
  const side_by_side = w >= 620 * scale
  const cart_w = side_by_side ? Math.min((options?.cart_w ?? 270) * scale, Math.max(210 * scale, w * 0.36)) : w
  const cart_h = side_by_side ? h - header_h - pad * 2 : Math.min(178 * scale, Math.max(130 * scale, h * 0.38))
  const grid_rect = side_by_side
    ? { x: x + pad, y: y + header_h, w: Math.max(0, w - cart_w - pad * 3), h: Math.max(0, h - header_h - pad) }
    : { x: x + pad, y: y + header_h, w: Math.max(0, w - pad * 2), h: Math.max(0, h - header_h - cart_h - gap - pad) }
  const cart_rect = side_by_side
    ? { x: x + w - cart_w - pad, y: y + header_h, w: cart_w, h: cart_h }
    : { x: x + pad, y: y + h - cart_h - pad, w: Math.max(0, w - pad * 2), h: cart_h }

  if (!input.mouse_down) state._press_consumed = false
  prune_cart(items, state)
  ui.fill_rect(x, y, w, h, col('panel'))
  draw_grid(ui, input, grid_rect, items, state, font_px, scale, col, options, event)
  const lines = asset_market_cart_lines(items, state)
  const total_cents = asset_market_cart_total(lines)
  draw_header(ui, x + pad, y, Math.max(0, w - pad * 2), header_h, items.length, lines, total_cents, font_px, scale, col)
  draw_cart(ui, input, cart_rect, lines, state, font_px, scale, col, options, event)

  if (event.added || event.removed || event.quantity_changed) {
    event.checkout = undefined
  }
  return event
}

function draw_header(
  ui: ui_renderer,
  x: number,
  y: number,
  w: number,
  h: number,
  item_count: number,
  lines: asset_market_cart_line[],
  total_cents: number,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
): void {
  const title = 'Asset Market'
  const qty = lines.reduce((sum, line) => sum + line.quantity, 0)
  const summary = `${item_count} audited assets   ${qty} in cart   ${format_money(total_cents)}`
  ui.draw_text(x, ui.text_v_center_y(y, h, font_px + 2 * scale), title, font_px + 2 * scale, col('text'))
  const sw = ui.text_width(summary, 10.5 * scale, FONT_MONO)
  ui.push_clip(x + Math.min(w, 132 * scale), y, Math.max(0, w - 132 * scale), h)
  ui.draw_text(x + Math.max(0, w - sw), ui.text_v_center_y(y, h, 10.5 * scale), summary, 10.5 * scale, col('text_dim'), FONT_MONO)
  ui.pop_clip()
}

function draw_grid(
  ui: ui_renderer,
  input: ui_input_snapshot,
  rect: { x: number; y: number; w: number; h: number },
  items: asset_market_item[],
  state: asset_market_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  options: asset_market_options | undefined,
  event: asset_market_event,
): void {
  const pad = 8 * scale
  const card_w = (options?.card_w ?? 128) * scale
  const card_h = (options?.card_h ?? 166) * scale
  const gap = 10 * scale
  const cols = Math.max(1, Math.floor((rect.w - pad * 2 + gap) / (card_w + gap)))
  const rows = Math.ceil(items.length / cols)
  const content_h = pad * 2 + rows * (card_h + gap) - gap
  const max_off = Math.max(0, content_h - rect.h)
  const over = point_in(input, rect.x, rect.y, rect.w, rect.h)

  if (over && input.wheel_y) state.grid_scroll.offset_y = clamp(state.grid_scroll.offset_y - input.wheel_y * 28 * scale, 0, max_off)
  if (over && input.pan_dy) state.grid_scroll.offset_y = clamp(state.grid_scroll.offset_y - input.pan_dy, 0, max_off)
  state.grid_scroll.offset_y = clamp(state.grid_scroll.offset_y, 0, max_off)

  ui.fill_rect(rect.x, rect.y, rect.w, rect.h, col('panel'))
  ui.stroke_rect(rect.x, rect.y, rect.w, rect.h, 1, col('border'))
  ui.push_clip(rect.x, rect.y, rect.w, rect.h)

  if (items.length === 0) {
    ui.draw_text(rect.x + pad, rect.y + pad, options?.empty_label ?? 'No audited assets', font_px, col('text_dim'))
  }

  for (let i = 0; i < items.length; i += 1) {
    const asset = items[i]
    const cx = i % cols
    const cy = Math.floor(i / cols)
    const ax = rect.x + pad + cx * (card_w + gap)
    const ay = rect.y + pad + cy * (card_h + gap) - state.grid_scroll.offset_y
    if (ay + card_h < rect.y || ay > rect.y + rect.h) continue
    draw_asset_card(ui, input, ax, ay, card_w, card_h, asset, state, font_px, scale, col, options, event)
  }

  ui.pop_clip()
  draw_scrollbar(ui, rect, state.grid_scroll.offset_y, content_h, scale, col)
}

function draw_asset_card(
  ui: ui_renderer,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  asset: asset_market_item,
  state: asset_market_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  options: asset_market_options | undefined,
  event: asset_market_event,
): void {
  const selected = state.selected_asset_id === asset.id
  const hover = point_in(input, x, y, w, h)
  const thumb_h = 82 * scale
  const button_h = 24 * scale
  const button_y = y + h - button_h - 7 * scale
  const in_cart = (state.cart.get(asset.id) ?? 0) > 0
  const bg = selected ? col('selected') : hover ? col('hover') : col('panel_alt')

  ui.fill_round_rect(x, y, w, h, 4 * scale, bg)
  ui.stroke_round_rect(x, y, w, h, 4 * scale, 1, selected ? col('scene_outline') : col('border'))

  const thumb_x = x + 8 * scale
  const thumb_y = y + 8 * scale
  const thumb_w = w - 16 * scale
  const drew = options?.render_thumbnail?.(asset, thumb_x, thumb_y, thumb_w, thumb_h) ?? false
  if (!drew) draw_fallback_thumbnail(ui, asset, thumb_x, thumb_y, thumb_w, thumb_h, scale, col)

  const label_y = thumb_y + thumb_h + 7 * scale
  ui.push_clip(x + 8 * scale, label_y, w - 16 * scale, 18 * scale)
  ui.draw_text(x + 8 * scale, label_y, asset.name, font_px, col('text'))
  ui.pop_clip()

  const meta = `${asset.type_label} · ${format_money(asset.price_cents ?? 0)}`
  ui.push_clip(x + 8 * scale, label_y + 19 * scale, w - 16 * scale, 15 * scale)
  ui.draw_text(x + 8 * scale, label_y + 19 * scale, meta, 10.5 * scale, col('text_dim'), FONT_MONO)
  ui.pop_clip()

  if (asset.subtitle) {
    ui.push_clip(x + 8 * scale, label_y + 35 * scale, w - 16 * scale, 13 * scale)
    ui.draw_text(x + 8 * scale, label_y + 35 * scale, asset.subtitle, 9.5 * scale, col('text_dim'))
    ui.pop_clip()
  }

  const add_pressed = button(ui, input, x + 8 * scale, button_y, w - 16 * scale, button_h, in_cart ? 'Add another' : 'Add to cart', in_cart, font_px, scale, col)
  if (add_pressed && !state._press_consumed) {
    state._press_consumed = true
    state.cart.set(asset.id, (state.cart.get(asset.id) ?? 0) + 1)
    event.added = asset
    event.quantity_changed = { asset, quantity: state.cart.get(asset.id) ?? 0 }
  } else if (!add_pressed && hover && input.mouse_pressed) {
    state.selected_asset_id = asset.id
    event.selected = asset
  }
}

function draw_cart(
  ui: ui_renderer,
  input: ui_input_snapshot,
  rect: { x: number; y: number; w: number; h: number },
  lines: asset_market_cart_line[],
  state: asset_market_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  options: asset_market_options | undefined,
  event: asset_market_event,
): void {
  const pad = 10 * scale
  const footer_h = 62 * scale
  const title_h = 30 * scale
  const row_h = 46 * scale
  const list_y = rect.y + title_h
  const list_h = Math.max(0, rect.h - title_h - footer_h)
  const content_h = lines.length * row_h
  const max_off = Math.max(0, content_h - list_h)
  const over_list = point_in(input, rect.x, list_y, rect.w, list_h)
  const total_cents = asset_market_cart_total(lines)

  if (over_list && input.wheel_y) state.cart_scroll.offset_y = clamp(state.cart_scroll.offset_y - input.wheel_y * 26 * scale, 0, max_off)
  if (over_list && input.pan_dy) state.cart_scroll.offset_y = clamp(state.cart_scroll.offset_y - input.pan_dy, 0, max_off)
  state.cart_scroll.offset_y = clamp(state.cart_scroll.offset_y, 0, max_off)

  ui.fill_rect(rect.x, rect.y, rect.w, rect.h, col('panel_alt'))
  ui.stroke_rect(rect.x, rect.y, rect.w, rect.h, 1, col('border'))
  ui.draw_text(rect.x + pad, ui.text_v_center_y(rect.y, title_h, font_px), 'Cart', font_px, col('text'))

  const qty = lines.reduce((sum, line) => sum + line.quantity, 0)
  const qty_label = `${qty} item${qty === 1 ? '' : 's'}`
  const qty_w = ui.text_width(qty_label, 10.5 * scale, FONT_MONO)
  ui.draw_text(rect.x + rect.w - pad - qty_w, ui.text_v_center_y(rect.y, title_h, 10.5 * scale), qty_label, 10.5 * scale, col('text_dim'), FONT_MONO)

  ui.push_clip(rect.x, list_y, rect.w, list_h)
  if (lines.length === 0) {
    ui.draw_text(rect.x + pad, list_y + pad, 'Cart is empty', font_px, col('text_dim'))
  }
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const ry = list_y + i * row_h - state.cart_scroll.offset_y
    if (ry + row_h < list_y || ry > list_y + list_h) continue
    draw_cart_line(ui, input, rect.x + pad, ry, rect.w - pad * 2, row_h, line, state, font_px, scale, col, event)
  }
  ui.pop_clip()
  draw_scrollbar(ui, { x: rect.x, y: list_y, w: rect.w, h: list_h }, state.cart_scroll.offset_y, content_h, scale, col)

  const footer_y = rect.y + rect.h - footer_h
  ui.fill_rect(rect.x, footer_y, rect.w, footer_h, col('panel'))
  ui.stroke_rect(rect.x, footer_y, rect.w, 1, 1, col('border'))
  ui.draw_text(rect.x + pad, footer_y + 10 * scale, 'Total', 11 * scale, col('text_dim'))
  ui.draw_text(rect.x + pad, footer_y + 27 * scale, format_money(total_cents), font_px + 1 * scale, col('text'), FONT_MONO)
  const checkout_w = Math.min(138 * scale, Math.max(92 * scale, rect.w * 0.42))
  const checkout_x = rect.x + rect.w - pad - checkout_w
  const checkout_pressed = button(ui, input, checkout_x, footer_y + 17 * scale, checkout_w, 30 * scale, options?.checkout_label ?? 'Checkout', false, font_px, scale, col, lines.length === 0)
  if (checkout_pressed && !state._press_consumed) {
    state._press_consumed = true
    event.checkout = { lines, total_cents }
  }
}

function draw_cart_line(
  ui: ui_renderer,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  line: asset_market_cart_line,
  state: asset_market_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  event: asset_market_event,
): void {
  const qty_w = 62 * scale
  const price = format_money((line.asset.price_cents ?? 0) * line.quantity)
  ui.stroke_rect(x, y + h - 1, w, 1, 1, col('border'))
  ui.push_clip(x, y + 6 * scale, Math.max(0, w - qty_w - 66 * scale), 18 * scale)
  ui.draw_text(x, y + 6 * scale, line.asset.name, font_px, col('text'))
  ui.pop_clip()
  ui.draw_text(x, y + 25 * scale, price, 10.5 * scale, col('text_dim'), FONT_MONO)

  const minus_x = x + w - qty_w
  const plus_x = minus_x + 42 * scale
  const minus_pressed = icon_button(ui, input, minus_x, y + 12 * scale, 20 * scale, 20 * scale, '-', scale, col)
  if (minus_pressed && !state._press_consumed) {
    state._press_consumed = true
    const next = Math.max(0, line.quantity - 1)
    if (next === 0) state.cart.delete(line.asset.id)
    else state.cart.set(line.asset.id, next)
    event.removed = line.asset
    event.quantity_changed = { asset: line.asset, quantity: next }
  }
  const qty = `${line.quantity}`
  const qty_text_w = ui.text_width(qty, 10.5 * scale, FONT_MONO)
  ui.draw_text(minus_x + 27 * scale - qty_text_w * 0.5, y + 17 * scale, qty, 10.5 * scale, col('text'), FONT_MONO)
  const plus_pressed = icon_button(ui, input, plus_x, y + 12 * scale, 20 * scale, 20 * scale, '+', scale, col)
  if (plus_pressed && !state._press_consumed) {
    state._press_consumed = true
    const next = line.quantity + 1
    state.cart.set(line.asset.id, next)
    event.added = line.asset
    event.quantity_changed = { asset: line.asset, quantity: next }
  }
}

function draw_fallback_thumbnail(
  ui: ui_renderer,
  asset: asset_market_item,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  col: (slot: theme_slot) => number,
): void {
  const seed = hash(asset.id)
  const color = asset.thumbnail_color ?? palette_color(seed)
  ui.fill_round_rect(x, y, w, h, 3 * scale, col('track'))
  ui.fill_rect(x, y, w, h, color)
  const stripe = with_alpha(col('panel'), 0.32)
  const count = 3 + (seed % 3)
  for (let i = 0; i < count; i += 1) {
    const px = x + ((seed >> (i * 3)) % 80) / 100 * w
    ui.fill_round_rect(px - 8 * scale, y - 12 * scale, 18 * scale, h + 24 * scale, 9 * scale, stripe)
  }
  const label = asset.type_label.slice(0, 4).toUpperCase()
  const label_w = ui.text_width(label, 15 * scale, FONT_MONO)
  ui.draw_text(x + (w - label_w) * 0.5, ui.text_v_center_y(y, h, 15 * scale), label, 15 * scale, 0xffffffff, FONT_MONO)
}

function button(
  ui: ui_renderer,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  active: boolean,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  disabled = false,
): boolean {
  const hover = !disabled && point_in(input, x, y, w, h)
  const bg = disabled ? col('ghost') : active ? col('active') : hover ? col('hover') : col('selected')
  ui.fill_round_rect(x, y, w, h, 3 * scale, bg)
  ui.stroke_round_rect(x, y, w, h, 3 * scale, 1, active ? col('accent') : col('border_strong'))
  const text_color = disabled ? col('text_dim') : col('text')
  const tw = ui.text_width(label, font_px)
  ui.push_clip(x + 3 * scale, y, Math.max(0, w - 6 * scale), h)
  ui.draw_text(x + Math.max(3 * scale, (w - tw) * 0.5), ui.text_v_center_y(y, h, font_px), label, font_px, text_color)
  ui.pop_clip()
  return hover && input.mouse_pressed
}

function icon_button(
  ui: ui_renderer,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  scale: number,
  col: (slot: theme_slot) => number,
): boolean {
  const hover = point_in(input, x, y, w, h)
  ui.fill_round_rect(x, y, w, h, 3 * scale, hover ? col('hover') : col('track'))
  ui.stroke_round_rect(x, y, w, h, 3 * scale, 1, col('border'))
  const tw = ui.text_width(label, 12 * scale, FONT_MONO)
  ui.draw_text(x + (w - tw) * 0.5, ui.text_v_center_y(y, h, 12 * scale), label, 12 * scale, col('text'), FONT_MONO)
  return hover && input.mouse_pressed
}

function draw_scrollbar(
  ui: ui_renderer,
  rect: { x: number; y: number; w: number; h: number },
  offset_y: number,
  content_h: number,
  scale: number,
  col: (slot: theme_slot) => number,
): void {
  if (content_h <= rect.h) return
  const scrollbar_w = 6 * scale
  const max_off = Math.max(1, content_h - rect.h)
  const thumb_h = Math.max(20 * scale, rect.h * (rect.h / content_h))
  const thumb_y = rect.y + (offset_y / max_off) * Math.max(1, rect.h - thumb_h)
  ui.fill_rect(rect.x + rect.w - scrollbar_w, rect.y, scrollbar_w, rect.h, col('track'))
  ui.fill_round_rect(rect.x + rect.w - scrollbar_w + 1, thumb_y, scrollbar_w - 2, thumb_h, 3 * scale, col('border_strong'))
}

function prune_cart(items: asset_market_item[], state: asset_market_state): void {
  const ids = new Set(items.map((item) => item.id))
  for (const id of [...state.cart.keys()]) {
    const quantity = state.cart.get(id) ?? 0
    if (!ids.has(id) || quantity <= 0) state.cart.delete(id)
  }
}

function format_money(cents: number): string {
  if (!cents) return 'Free'
  return `$${(cents / 100).toFixed(2)}`
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

function with_alpha(color: number, alpha: number): number {
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)))
  return ((color & 0x00ffffff) | (a << 24)) >>> 0
}

function hash(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i += 1) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function palette_color(seed: number): number {
  const colors = [0xff5b9bd5, 0xff5fb878, 0xffd8a24a, 0xffe0698b, 0xff8f72d8, 0xff49a6a6]
  return colors[seed % colors.length] ?? 0xff5b9bd5
}
