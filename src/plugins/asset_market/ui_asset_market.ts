// asset_market — an immediate-mode storefront for whole 3D scenes.
//
// The marketplace sells complete scenes only, each shipped as a single binary
// glTF (.glb) whose geometry is Draco-compressed (see ui_asset_market_draco /
// ui_asset_market_worker). It renders a scrollable card grid next to an order
// panel: every card shows the scene's triangle budget and the Draco saving
// (raw glb → compressed). The host owns the catalogue and checkout; this plugin
// owns selection, scrolling and hit-testing, then reports intents as events.

import { theme_color } from '../../core/ui_theme'
import type { theme_definition, theme_slot } from '../../core/ui_types'
import { FONT_MONO, ui_renderer } from '../../core/ui_renderer'
import type { ui_input_snapshot, ui_scroll_state } from '../../core/ui_widgets'
import { scene_draco_saving } from './ui_asset_market_scene'
import type { scene_market_item } from './ui_asset_market_scene'

export interface asset_market_state {
  selected_scene_id: string | null
  /** Set of scene ids in the order. Scenes are whole units — no quantities. */
  cart: Set<string>
  grid_scroll: ui_scroll_state
  cart_scroll: ui_scroll_state
  /** Internal: prevents one pointer press from firing multiple actions. */
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
  render_thumbnail?: (scene: scene_market_item, x: number, y: number, w: number, h: number) => boolean
}

export interface asset_market_event {
  /** A card was clicked (host may decompress + preview its geometry). */
  selected?: scene_market_item
  /** A scene was added to the order. */
  added?: scene_market_item
  /** A scene was removed from the order. */
  removed?: scene_market_item
  /** The order was checked out. */
  checkout?: { scenes: scene_market_item[]; total_cents: number }
}

export function create_asset_market_state(): asset_market_state {
  return {
    selected_scene_id: null,
    cart: new Set<string>(),
    grid_scroll: { offset_y: 0 },
    cart_scroll: { offset_y: 0 },
    _press_consumed: false,
  }
}

/** Scenes currently in the order, in catalogue order. */
export function asset_market_cart_scenes(scenes: scene_market_item[], state: asset_market_state): scene_market_item[] {
  return scenes.filter((scene) => state.cart.has(scene.id))
}

export function asset_market_cart_total(scenes: scene_market_item[]): number {
  let total = 0
  for (const scene of scenes) total += scene.price_cents ?? 0
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
  scenes: scene_market_item[],
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
  const cart_w = side_by_side ? Math.min((options?.cart_w ?? 280) * scale, Math.max(220 * scale, w * 0.38)) : w
  const cart_h = side_by_side ? h - header_h - pad * 2 : Math.min(178 * scale, Math.max(130 * scale, h * 0.38))
  const grid_rect = side_by_side
    ? { x: x + pad, y: y + header_h, w: Math.max(0, w - cart_w - pad * 3), h: Math.max(0, h - header_h - pad) }
    : { x: x + pad, y: y + header_h, w: Math.max(0, w - pad * 2), h: Math.max(0, h - header_h - cart_h - gap - pad) }
  const cart_rect = side_by_side
    ? { x: x + w - cart_w - pad, y: y + header_h, w: cart_w, h: cart_h }
    : { x: x + pad, y: y + h - cart_h - pad, w: Math.max(0, w - pad * 2), h: cart_h }

  if (!input.mouse_down) state._press_consumed = false
  prune_cart(scenes, state)
  ui.fill_rect(x, y, w, h, col('panel'))
  draw_grid(ui, input, grid_rect, scenes, state, font_px, scale, col, options, event)
  const order = asset_market_cart_scenes(scenes, state)
  const total_cents = asset_market_cart_total(order)
  draw_header(ui, x + pad, y, Math.max(0, w - pad * 2), header_h, scenes, order, total_cents, font_px, scale, col)
  draw_cart(ui, input, cart_rect, order, state, font_px, scale, col, options, event)
  return event
}

function draw_header(
  ui: ui_renderer,
  x: number,
  y: number,
  w: number,
  h: number,
  scenes: scene_market_item[],
  order: scene_market_item[],
  total_cents: number,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
): void {
  const title = 'Scene Market'
  const summary = `${scenes.length} glb scenes   ${order.length} in order   ${format_money(total_cents)}`
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
  scenes: scene_market_item[],
  state: asset_market_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  options: asset_market_options | undefined,
  event: asset_market_event,
): void {
  const pad = 8 * scale
  const card_w = (options?.card_w ?? 150) * scale
  const card_h = (options?.card_h ?? 186) * scale
  const gap = 10 * scale
  const cols = Math.max(1, Math.floor((rect.w - pad * 2 + gap) / (card_w + gap)))
  const rows = Math.ceil(scenes.length / cols)
  const content_h = pad * 2 + rows * (card_h + gap) - gap
  const max_off = Math.max(0, content_h - rect.h)
  const over = point_in(input, rect.x, rect.y, rect.w, rect.h)

  if (over && input.wheel_y) state.grid_scroll.offset_y = clamp(state.grid_scroll.offset_y - input.wheel_y * 28 * scale, 0, max_off)
  if (over && input.pan_dy) state.grid_scroll.offset_y = clamp(state.grid_scroll.offset_y - input.pan_dy, 0, max_off)
  state.grid_scroll.offset_y = clamp(state.grid_scroll.offset_y, 0, max_off)

  ui.fill_rect(rect.x, rect.y, rect.w, rect.h, col('panel'))
  ui.stroke_rect(rect.x, rect.y, rect.w, rect.h, 1, col('border'))
  ui.push_clip(rect.x, rect.y, rect.w, rect.h)

  if (scenes.length === 0) {
    ui.draw_text(rect.x + pad, rect.y + pad, options?.empty_label ?? 'No scenes available', font_px, col('text_dim'))
  }

  for (let i = 0; i < scenes.length; i += 1) {
    const scene = scenes[i]!
    const cx = i % cols
    const cy = Math.floor(i / cols)
    const ax = rect.x + pad + cx * (card_w + gap)
    const ay = rect.y + pad + cy * (card_h + gap) - state.grid_scroll.offset_y
    if (ay + card_h < rect.y || ay > rect.y + rect.h) continue
    draw_scene_card(ui, input, ax, ay, card_w, card_h, scene, state, font_px, scale, col, options, event)
  }

  ui.pop_clip()
  draw_scrollbar(ui, rect, state.grid_scroll.offset_y, content_h, scale, col)
}

function draw_scene_card(
  ui: ui_renderer,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  scene: scene_market_item,
  state: asset_market_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  options: asset_market_options | undefined,
  event: asset_market_event,
): void {
  const selected = state.selected_scene_id === scene.id
  const hover = point_in(input, x, y, w, h)
  const thumb_h = 82 * scale
  const button_h = 24 * scale
  const button_y = y + h - button_h - 7 * scale
  const in_cart = state.cart.has(scene.id)
  const bg = selected ? col('selected') : hover ? col('hover') : col('panel_alt')

  ui.fill_round_rect(x, y, w, h, 4 * scale, bg)
  ui.stroke_round_rect(x, y, w, h, 4 * scale, 1, selected ? col('scene_outline') : col('border'))

  const thumb_x = x + 8 * scale
  const thumb_y = y + 8 * scale
  const thumb_w = w - 16 * scale
  const drew = options?.render_thumbnail?.(scene, thumb_x, thumb_y, thumb_w, thumb_h) ?? false
  if (!drew) draw_fallback_thumbnail(ui, scene, thumb_x, thumb_y, thumb_w, thumb_h, scale, col)
  draw_glb_badge(ui, thumb_x + thumb_w - 34 * scale, thumb_y + 6 * scale, scale, col)

  const label_y = thumb_y + thumb_h + 7 * scale
  ui.push_clip(x + 8 * scale, label_y, w - 16 * scale, 18 * scale)
  ui.draw_text(x + 8 * scale, label_y, scene.name, font_px, col('text'))
  ui.pop_clip()

  const meta = `${format_count(scene.triangle_count)} tris · ${format_money(scene.price_cents ?? 0)}`
  ui.push_clip(x + 8 * scale, label_y + 19 * scale, w - 16 * scale, 15 * scale)
  ui.draw_text(x + 8 * scale, label_y + 19 * scale, meta, 10.5 * scale, col('text_dim'), FONT_MONO)
  ui.pop_clip()

  // Draco saving line: raw glb → compressed geometry.
  const saving = scene_draco_saving(scene)
  const size_line = `${format_bytes(scene.raw_bytes)} → ${format_bytes(scene.draco_bytes)}`
  ui.push_clip(x + 8 * scale, label_y + 35 * scale, w - 16 * scale, 14 * scale)
  ui.draw_text(x + 8 * scale, label_y + 35 * scale, size_line, 9.5 * scale, col('text_dim'), FONT_MONO)
  if (saving > 0) {
    const badge = `-${Math.round(saving * 100)}%`
    const bw = ui.text_width(badge, 9.5 * scale, FONT_MONO)
    ui.draw_text(x + w - 8 * scale - bw, label_y + 35 * scale, badge, 9.5 * scale, col('accent'), FONT_MONO)
  }
  ui.pop_clip()

  const add_pressed = button(ui, input, x + 8 * scale, button_y, w - 16 * scale, button_h, in_cart ? 'Remove' : 'Add scene', in_cart, font_px, scale, col)
  if (add_pressed && !state._press_consumed) {
    state._press_consumed = true
    if (in_cart) {
      state.cart.delete(scene.id)
      event.removed = scene
    } else {
      state.cart.add(scene.id)
      event.added = scene
    }
  } else if (!add_pressed && hover && input.mouse_pressed) {
    state.selected_scene_id = scene.id
    event.selected = scene
  }
}

function draw_cart(
  ui: ui_renderer,
  input: ui_input_snapshot,
  rect: { x: number; y: number; w: number; h: number },
  order: scene_market_item[],
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
  const row_h = 44 * scale
  const list_y = rect.y + title_h
  const list_h = Math.max(0, rect.h - title_h - footer_h)
  const content_h = order.length * row_h
  const max_off = Math.max(0, content_h - list_h)
  const over_list = point_in(input, rect.x, list_y, rect.w, list_h)
  const total_cents = asset_market_cart_total(order)

  if (over_list && input.wheel_y) state.cart_scroll.offset_y = clamp(state.cart_scroll.offset_y - input.wheel_y * 26 * scale, 0, max_off)
  if (over_list && input.pan_dy) state.cart_scroll.offset_y = clamp(state.cart_scroll.offset_y - input.pan_dy, 0, max_off)
  state.cart_scroll.offset_y = clamp(state.cart_scroll.offset_y, 0, max_off)

  ui.fill_rect(rect.x, rect.y, rect.w, rect.h, col('panel_alt'))
  ui.stroke_rect(rect.x, rect.y, rect.w, rect.h, 1, col('border'))
  ui.draw_text(rect.x + pad, ui.text_v_center_y(rect.y, title_h, font_px), 'Order', font_px, col('text'))

  const count_label = `${order.length} scene${order.length === 1 ? '' : 's'}`
  const count_w = ui.text_width(count_label, 10.5 * scale, FONT_MONO)
  ui.draw_text(rect.x + rect.w - pad - count_w, ui.text_v_center_y(rect.y, title_h, 10.5 * scale), count_label, 10.5 * scale, col('text_dim'), FONT_MONO)

  ui.push_clip(rect.x, list_y, rect.w, list_h)
  if (order.length === 0) {
    ui.draw_text(rect.x + pad, list_y + pad, 'Order is empty', font_px, col('text_dim'))
  }
  for (let i = 0; i < order.length; i += 1) {
    const scene = order[i]!
    const ry = list_y + i * row_h - state.cart_scroll.offset_y
    if (ry + row_h < list_y || ry > list_y + list_h) continue
    draw_cart_line(ui, input, rect.x + pad, ry, rect.w - pad * 2, row_h, scene, state, font_px, scale, col, event)
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
  const checkout_pressed = button(ui, input, checkout_x, footer_y + 17 * scale, checkout_w, 30 * scale, options?.checkout_label ?? 'Checkout', false, font_px, scale, col, order.length === 0)
  if (checkout_pressed && !state._press_consumed) {
    state._press_consumed = true
    event.checkout = { scenes: order.slice(), total_cents }
  }
}

function draw_cart_line(
  ui: ui_renderer,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  scene: scene_market_item,
  state: asset_market_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  event: asset_market_event,
): void {
  const remove_w = 22 * scale
  const price = format_money(scene.price_cents ?? 0)
  ui.stroke_rect(x, y + h - 1, w, 1, 1, col('border'))
  ui.push_clip(x, y + 6 * scale, Math.max(0, w - remove_w - 10 * scale), 18 * scale)
  ui.draw_text(x, y + 6 * scale, scene.name, font_px, col('text'))
  ui.pop_clip()
  const info = `${format_bytes(scene.draco_bytes)} glb · ${price}`
  ui.draw_text(x, y + 24 * scale, info, 10.5 * scale, col('text_dim'), FONT_MONO)

  const remove_pressed = icon_button(ui, input, x + w - remove_w, y + 11 * scale, remove_w, 20 * scale, '×', scale, col)
  if (remove_pressed && !state._press_consumed) {
    state._press_consumed = true
    state.cart.delete(scene.id)
    event.removed = scene
  }
}

function draw_glb_badge(ui: ui_renderer, x: number, y: number, scale: number, col: (slot: theme_slot) => number): void {
  const w = 28 * scale
  const hgt = 14 * scale
  ui.fill_round_rect(x, y, w, hgt, 3 * scale, with_alpha(col('panel'), 0.72))
  const label = 'GLB'
  const tw = ui.text_width(label, 9 * scale, FONT_MONO)
  ui.draw_text(x + (w - tw) * 0.5, ui.text_v_center_y(y, hgt, 9 * scale), label, 9 * scale, 0xffffffff, FONT_MONO)
}

function draw_fallback_thumbnail(
  ui: ui_renderer,
  scene: scene_market_item,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  col: (slot: theme_slot) => number,
): void {
  const seed = hash(scene.id)
  const color = scene.thumbnail_color ?? palette_color(seed)
  ui.fill_round_rect(x, y, w, h, 3 * scale, col('track'))
  ui.fill_rect(x, y, w, h, color)
  const stripe = with_alpha(col('panel'), 0.32)
  const count = 3 + (seed % 3)
  for (let i = 0; i < count; i += 1) {
    const px = x + ((seed >> (i * 3)) % 80) / 100 * w
    ui.fill_round_rect(px - 8 * scale, y - 12 * scale, 18 * scale, h + 24 * scale, 9 * scale, stripe)
  }
  const label = 'SCENE'
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

function prune_cart(scenes: scene_market_item[], state: asset_market_state): void {
  const ids = new Set(scenes.map((scene) => scene.id))
  for (const id of [...state.cart]) if (!ids.has(id)) state.cart.delete(id)
}

function format_money(cents: number): string {
  if (!cents) return 'Free'
  return `$${(cents / 100).toFixed(2)}`
}

function format_count(n: number): string {
  if (n < 1000) return `${n}`
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`
  return `${(n / 1_000_000).toFixed(1)}M`
}

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
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
