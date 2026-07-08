// asset_hub - an immediate-mode scene asset browser and preview hub.
//
// Renders host-owned hub entries as preview-first cards next to a detail panel.
// The hub stores metadata such as author, license, source and storage URI; this
// plugin owns selection, scrolling and preview/share hit-testing.

import { theme_color } from '../../core/ui_theme'
import type { theme_definition, theme_slot } from '../../core/ui_types'
import { FONT_MONO, ui_renderer } from '../../core/ui_renderer'
import type { ui_input_snapshot, ui_scroll_state } from '../../core/ui_widgets'

export type asset_audit_status = 'passed' | 'warning' | 'failed' | 'pending'

export interface asset_hub_item {
  id: string
  name: string
  /** Short category label drawn outside the preview, e.g. `SCENE`, `HDRI`, `KIT`. */
  type_label: string
  /** Human-readable grouping for filtering/search hosts, e.g. `Scene` or `Material`. */
  category?: string
  /** One-line description for the detail panel. */
  summary?: string
  author?: string
  license?: string
  source?: string
  source_url?: string
  storage_uri?: string
  tags?: string[]
  audit_status?: asset_audit_status
  updated_at?: string
  size_bytes?: number
  scene_count?: number
  /** Optional packed `0xAABBGGRR` color used to tint the generated preview. */
  preview_color?: number
  /** Deprecated alias retained for older hosts. Prefer `preview_color`. */
  thumbnail_color?: number
}

export interface asset_hub_state {
  selected_asset_id: string | null
  grid_scroll: ui_scroll_state
  detail_scroll: ui_scroll_state
  /** Internal: prevents one pointer press from activating multiple actions. */
  _press_consumed: boolean
}

export interface asset_hub_options {
  font_px?: number
  card_w?: number
  card_h?: number
  detail_w?: number
  preview_label?: string
  share_label?: string
  empty_label?: string
  /** Draw a preview image; return true if it drew, otherwise fallback preview art is used. */
  render_thumbnail?: (asset: asset_hub_item, x: number, y: number, w: number, h: number) => boolean
}

export interface asset_hub_event {
  selected?: asset_hub_item
  preview_requested?: asset_hub_item
  share_requested?: asset_hub_item
}

export function create_asset_hub_state(): asset_hub_state {
  return {
    selected_asset_id: null,
    grid_scroll: { offset_y: 0 },
    detail_scroll: { offset_y: 0 },
    _press_consumed: false,
  }
}

export function asset_hub(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  items: asset_hub_item[],
  state: asset_hub_state,
  options?: asset_hub_options,
): asset_hub_event {
  const scale = window.devicePixelRatio || 1
  const font_px = (options?.font_px ?? 12.5) * scale
  const col = (slot: theme_slot) => pack(theme_color(theme, slot))
  const event: asset_hub_event = {}
  const pad = 10 * scale
  const header_h = 36 * scale
  const gap = 8 * scale
  const side_by_side = w >= 620 * scale
  const detail_w = side_by_side ? Math.min((options?.detail_w ?? 292) * scale, Math.max(220 * scale, w * 0.38)) : w
  const detail_h = side_by_side ? h - header_h - pad * 2 : Math.min(218 * scale, Math.max(160 * scale, h * 0.44))
  const grid_rect = side_by_side
    ? { x: x + pad, y: y + header_h, w: Math.max(0, w - detail_w - pad * 3), h: Math.max(0, h - header_h - pad) }
    : { x: x + pad, y: y + header_h, w: Math.max(0, w - pad * 2), h: Math.max(0, h - header_h - detail_h - gap - pad) }
  const detail_rect = side_by_side
    ? { x: x + w - detail_w - pad, y: y + header_h, w: detail_w, h: detail_h }
    : { x: x + pad, y: y + h - detail_h - pad, w: Math.max(0, w - pad * 2), h: detail_h }

  if (!input.mouse_down) state._press_consumed = false
  ensure_selection(items, state)

  ui.fill_rect(x, y, w, h, col('panel'))
  draw_header(ui, x + pad, y, Math.max(0, w - pad * 2), header_h, items, state, font_px, scale, col)
  draw_grid(ui, input, grid_rect, items, state, font_px, scale, col, options, event)
  draw_details(ui, input, detail_rect, selected_asset(items, state), state, font_px, scale, col, options, event)

  return event
}

function draw_header(
  ui: ui_renderer,
  x: number,
  y: number,
  w: number,
  h: number,
  items: asset_hub_item[],
  state: asset_hub_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
): void {
  const title = 'Asset Hub'
  const selected = selected_asset(items, state)
  const authors = new Set(items.map((item) => item.author).filter(Boolean))
  const summary = `${items.length} assets   ${authors.size} authors   ${selected?.type_label ?? 'No selection'}`
  ui.draw_text(x, ui.text_v_center_y(y, h, font_px + 2 * scale), title, font_px + 2 * scale, col('text'))
  const sw = ui.text_width(summary, 10.5 * scale, FONT_MONO)
  ui.push_clip(x + Math.min(w, 118 * scale), y, Math.max(0, w - 118 * scale), h)
  ui.draw_text(x + Math.max(0, w - sw), ui.text_v_center_y(y, h, 10.5 * scale), summary, 10.5 * scale, col('text_dim'), FONT_MONO)
  ui.pop_clip()
}

function draw_grid(
  ui: ui_renderer,
  input: ui_input_snapshot,
  rect: { x: number; y: number; w: number; h: number },
  items: asset_hub_item[],
  state: asset_hub_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  options: asset_hub_options | undefined,
  event: asset_hub_event,
): void {
  const pad = 8 * scale
  const card_w = (options?.card_w ?? 136) * scale
  const card_h = (options?.card_h ?? 172) * scale
  const gap = 10 * scale
  const cols = Math.max(1, Math.floor((rect.w - pad * 2 + gap) / (card_w + gap)))
  const rows = Math.ceil(items.length / cols)
  const content_h = pad * 2 + rows * (card_h + gap) - gap
  const max_off = Math.max(0, content_h - rect.h)
  const over = point_in(input, rect.x, rect.y, rect.w, rect.h)

  if (over && input.wheel_y) state.grid_scroll.offset_y = clamp(state.grid_scroll.offset_y - input.wheel_y * 28 * scale, 0, max_off)
  state.grid_scroll.offset_y = clamp(state.grid_scroll.offset_y, 0, max_off)

  ui.fill_rect(rect.x, rect.y, rect.w, rect.h, col('panel'))
  ui.stroke_rect(rect.x, rect.y, rect.w, rect.h, 1, col('border'))
  ui.push_clip(rect.x, rect.y, rect.w, rect.h)

  if (items.length === 0) {
    ui.draw_text(rect.x + pad, rect.y + pad, options?.empty_label ?? 'No assets in this hub', font_px, col('text_dim'))
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
  asset: asset_hub_item,
  state: asset_hub_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  options: asset_hub_options | undefined,
  event: asset_hub_event,
): void {
  const selected = state.selected_asset_id === asset.id
  const hover = point_in(input, x, y, w, h)
  const thumb_h = 92 * scale
  const button_h = 24 * scale
  const button_y = y + h - button_h - 7 * scale
  const bg = selected ? col('selected') : hover ? col('hover') : col('panel_alt')

  ui.fill_round_rect(x, y, w, h, 4 * scale, bg)
  ui.stroke_round_rect(x, y, w, h, 4 * scale, 1, selected ? col('scene_outline') : col('border'))

  const thumb_x = x + 8 * scale
  const thumb_y = y + 8 * scale
  const thumb_w = w - 16 * scale
  const drew = options?.render_thumbnail?.(asset, thumb_x, thumb_y, thumb_w, thumb_h) ?? false
  if (!drew) draw_preview_thumbnail(ui, asset, thumb_x, thumb_y, thumb_w, thumb_h, scale, col)

  const label_y = thumb_y + thumb_h + 7 * scale
  ui.push_clip(x + 8 * scale, label_y, w - 16 * scale, 18 * scale)
  ui.draw_text(x + 8 * scale, label_y, asset.name, font_px, col('text'))
  ui.pop_clip()

  const meta = asset.author ? `${asset.type_label} / ${asset.author}` : asset.type_label
  ui.push_clip(x + 8 * scale, label_y + 19 * scale, w - 16 * scale, 15 * scale)
  ui.draw_text(x + 8 * scale, label_y + 19 * scale, meta, 10.5 * scale, col('text_dim'), FONT_MONO)
  ui.pop_clip()

  const preview_pressed = button(ui, input, x + 8 * scale, button_y, w - 16 * scale, button_h, options?.preview_label ?? 'Preview', selected, font_px, scale, col)
  if (preview_pressed && !state._press_consumed) {
    state._press_consumed = true
    state.selected_asset_id = asset.id
    event.selected = asset
    event.preview_requested = asset
  } else if (!preview_pressed && hover && input.mouse_pressed) {
    state.selected_asset_id = asset.id
    event.selected = asset
  }
}

function draw_details(
  ui: ui_renderer,
  input: ui_input_snapshot,
  rect: { x: number; y: number; w: number; h: number },
  asset: asset_hub_item | null,
  state: asset_hub_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  options: asset_hub_options | undefined,
  event: asset_hub_event,
): void {
  const pad = 10 * scale
  const title_h = 30 * scale
  const footer_h = 52 * scale
  const list_y = rect.y + title_h
  const list_h = Math.max(0, rect.h - title_h - footer_h)
  const preview_h = Math.min(150 * scale, Math.max(86 * scale, list_h * 0.44))
  const detail_content_h = asset ? preview_h + 188 * scale + detail_rows(asset).length * 21 * scale : 40 * scale
  const max_off = Math.max(0, detail_content_h - list_h)
  const over_list = point_in(input, rect.x, list_y, rect.w, list_h)

  if (over_list && input.wheel_y) state.detail_scroll.offset_y = clamp(state.detail_scroll.offset_y - input.wheel_y * 26 * scale, 0, max_off)
  state.detail_scroll.offset_y = clamp(state.detail_scroll.offset_y, 0, max_off)

  ui.fill_rect(rect.x, rect.y, rect.w, rect.h, col('panel_alt'))
  ui.stroke_rect(rect.x, rect.y, rect.w, rect.h, 1, col('border'))
  ui.draw_text(rect.x + pad, ui.text_v_center_y(rect.y, title_h, font_px), 'Scene Preview', font_px, col('text'))

  const status = asset?.audit_status ? status_label(asset.audit_status) : 'Ready'
  const status_w = ui.text_width(status, 10.5 * scale, FONT_MONO)
  ui.draw_text(rect.x + rect.w - pad - status_w, ui.text_v_center_y(rect.y, title_h, 10.5 * scale), status, 10.5 * scale, status_color(asset?.audit_status, col), FONT_MONO)

  ui.push_clip(rect.x, list_y, rect.w, list_h)
  if (!asset) {
    ui.draw_text(rect.x + pad, list_y + pad, 'Select an asset to preview hub metadata', font_px, col('text_dim'))
  } else {
    let cy = list_y + pad - state.detail_scroll.offset_y
    const px = rect.x + pad
    const pw = rect.w - pad * 2
    draw_preview_thumbnail(ui, asset, px, cy, pw, preview_h, scale, col)
    cy += preview_h + 10 * scale

    ui.push_clip(px, cy, pw, 22 * scale)
    ui.draw_text(px, cy, asset.name, font_px + 1 * scale, col('text'))
    ui.pop_clip()
    cy += 23 * scale

    if (asset.summary) {
      ui.push_clip(px, cy, pw, 32 * scale)
      ui.draw_text(px, cy, asset.summary, 10.5 * scale, col('text_dim'))
      ui.pop_clip()
      cy += 36 * scale
    }

    const rows = detail_rows(asset)
    for (const row of rows) {
      draw_detail_row(ui, px, cy, pw, row.label, row.value, scale, col)
      cy += 21 * scale
    }
  }
  ui.pop_clip()
  draw_scrollbar(ui, { x: rect.x, y: list_y, w: rect.w, h: list_h }, state.detail_scroll.offset_y, detail_content_h, scale, col)

  const footer_y = rect.y + rect.h - footer_h
  ui.fill_rect(rect.x, footer_y, rect.w, footer_h, col('panel'))
  ui.stroke_rect(rect.x, footer_y, rect.w, 1, 1, col('border'))
  const preview_w = Math.min(118 * scale, Math.max(86 * scale, (rect.w - pad * 3) * 0.5))
  const share_w = Math.min(112 * scale, Math.max(76 * scale, rect.w - pad * 3 - preview_w))
  const preview_pressed = button(ui, input, rect.x + pad, footer_y + 13 * scale, preview_w, 28 * scale, options?.preview_label ?? 'Preview', false, font_px, scale, col, !asset)
  const share_pressed = button(ui, input, rect.x + pad * 2 + preview_w, footer_y + 13 * scale, share_w, 28 * scale, options?.share_label ?? 'Share', false, font_px, scale, col, !asset)
  if (asset && preview_pressed && !state._press_consumed) {
    state._press_consumed = true
    event.preview_requested = asset
  }
  if (asset && share_pressed && !state._press_consumed) {
    state._press_consumed = true
    event.share_requested = asset
  }
}

function draw_detail_row(
  ui: ui_renderer,
  x: number,
  y: number,
  w: number,
  label: string,
  value: string,
  scale: number,
  col: (slot: theme_slot) => number,
): void {
  const label_w = Math.min(78 * scale, w * 0.34)
  ui.draw_text(x, y, label, 10.5 * scale, col('text_dim'), FONT_MONO)
  ui.push_clip(x + label_w, y, Math.max(0, w - label_w), 16 * scale)
  ui.draw_text(x + label_w, y, value, 10.5 * scale, col('text'))
  ui.pop_clip()
}

function detail_rows(asset: asset_hub_item): { label: string; value: string }[] {
  const rows: { label: string; value: string }[] = [
    { label: 'TYPE', value: asset.category ?? asset.type_label },
    { label: 'AUTHOR', value: asset.author ?? 'Unknown' },
    { label: 'LICENSE', value: asset.license ?? 'Unspecified' },
  ]
  if (asset.storage_uri) rows.push({ label: 'STORAGE', value: asset.storage_uri })
  if (asset.source) rows.push({ label: 'SOURCE', value: asset.source })
  if (asset.updated_at) rows.push({ label: 'UPDATED', value: asset.updated_at })
  if (asset.size_bytes) rows.push({ label: 'SIZE', value: format_bytes(asset.size_bytes) })
  if (asset.scene_count) rows.push({ label: 'SCENES', value: `${asset.scene_count}` })
  if (asset.tags?.length) rows.push({ label: 'TAGS', value: asset.tags.join(', ') })
  return rows
}

function draw_preview_thumbnail(
  ui: ui_renderer,
  asset: asset_hub_item,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  col: (slot: theme_slot) => number,
): void {
  const seed = hash(asset.id)
  const accent = asset.preview_color ?? asset.thumbnail_color ?? palette_color(seed)
  const sky = mix_rgb(accent, 0xff1b2434, 0.28)
  const horizon = mix_rgb(accent, 0xffffffff, 0.34)
  const ground = mix_rgb(accent, 0xff20252a, 0.54)
  const shadow = with_alpha(0xff000000, 0.22)
  const mist = with_alpha(0xffffffff, 0.12)

  ui.fill_round_rect(x, y, w, h, 4 * scale, col('track'))
  ui.push_clip(x, y, w, h)
  ui.fill_rect(x, y, w, h * 0.58, sky)
  ui.fill_rect(x, y + h * 0.45, w, h * 0.18, horizon)
  ui.fill_rect(x, y + h * 0.6, w, h * 0.4, ground)
  ui.fill_circle(x + w * (0.18 + ((seed >> 8) % 20) / 100), y + h * 0.24, Math.max(8 * scale, h * 0.1), mist)

  const hill_y = y + h * 0.58
  ui.fill_triangle(x - w * 0.05, hill_y, x + w * 0.25, y + h * 0.34, x + w * 0.58, hill_y, with_alpha(accent, 0.36))
  ui.fill_triangle(x + w * 0.36, hill_y, x + w * 0.72, y + h * 0.31, x + w * 1.08, hill_y, with_alpha(ground, 0.74))

  const object_x = x + w * (0.42 + ((seed >> 3) % 14) / 100)
  const object_y = y + h * 0.52
  const object_w = w * (0.18 + (seed % 7) / 100)
  const object_h = h * (0.28 + ((seed >> 5) % 9) / 100)
  ui.fill_round_rect(object_x, object_y, object_w, object_h, 3 * scale, with_alpha(0xff0f141b, 0.72))
  ui.fill_rect(object_x + object_w * 0.12, object_y + object_h * 0.18, object_w * 0.76, 2 * scale, with_alpha(accent, 0.8))
  ui.fill_circle(object_x + object_w * 0.5, object_y + object_h + 4 * scale, object_w * 0.62, shadow)

  const rail_y = y + h * 0.82
  for (let i = 0; i < 3; i += 1) {
    ui.fill_rect(x + w * (0.12 + i * 0.25), rail_y + i * 1.5 * scale, w * 0.18, 1 * scale, with_alpha(0xffffffff, 0.16))
  }
  ui.pop_clip()
  ui.stroke_round_rect(x, y, w, h, 4 * scale, 1, with_alpha(col('border_strong'), 0.72))
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

function ensure_selection(items: asset_hub_item[], state: asset_hub_state): void {
  if (items.length === 0) {
    state.selected_asset_id = null
    return
  }
  if (!state.selected_asset_id || !items.some((item) => item.id === state.selected_asset_id)) {
    state.selected_asset_id = items[0]!.id
    state.detail_scroll.offset_y = 0
  }
}

function selected_asset(items: asset_hub_item[], state: asset_hub_state): asset_hub_item | null {
  return items.find((item) => item.id === state.selected_asset_id) ?? null
}

function status_label(status: asset_audit_status): string {
  if (status === 'passed') return 'Audited'
  if (status === 'warning') return 'Needs review'
  if (status === 'failed') return 'Blocked'
  return 'Pending'
}

function status_color(status: asset_audit_status | undefined, col: (slot: theme_slot) => number): number {
  if (status === 'passed') return 0xff5fb878
  if (status === 'warning' || status === 'pending') return 0xffd8a24a
  if (status === 'failed') return 0xffd9534f
  return col('text_dim')
}

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
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

function mix_rgb(a: number, b: number, t: number): number {
  const clamped = clamp(t, 0, 1)
  const ar = a & 255
  const ag = (a >> 8) & 255
  const ab = (a >> 16) & 255
  const br = b & 255
  const bg = (b >> 8) & 255
  const bb = (b >> 16) & 255
  const r = Math.round(ar + (br - ar) * clamped)
  const g = Math.round(ag + (bg - ag) * clamped)
  const bl = Math.round(ab + (bb - ab) * clamped)
  return ((255 << 24) | (bl << 16) | (g << 8) | r) >>> 0
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
