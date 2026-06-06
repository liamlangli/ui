// im_dialog — an instant-messaging chat panel plugin.
//
// Renders a scrollable list of chat bubbles (incoming on the left, outgoing on
// the right) with avatars, author names and timestamps, plus an optional
// composer row (text input + Send button). It auto-scrolls to the newest
// message while the view is pinned to the bottom, and reports submitted text
// back to the host so the host can append it to its own message array.
//
// Usage (inside begin_frame()/flush(), after widgets.begin_frame()):
//
//   const ev = im_dialog(ui, widgets, theme, input, x, y, w, h, messages, state)
//   if (ev.sent) messages.push({ text: ev.sent, side: 'right', author: 'Me' })

import { theme_color } from '../theme'
import type { theme_definition } from '../types'
import { FONT_MAIN, ui_renderer } from '../ui_renderer'
import { ui_widgets, type ui_input_snapshot, type ui_input_text_state, type ui_scroll_state } from '../ui_widgets'

export interface im_message {
  id?: string
  /** Display name shown above incoming bubbles. */
  author?: string
  text: string
  /** `'right'` = outgoing (me), `'left'` = incoming. Defaults to `'left'`. */
  side?: 'left' | 'right'
  /** Epoch ms or a pre-formatted string; rendered as a small dim caption. */
  timestamp?: number | string
  /** Avatar fill colour (`#rrggbb`). Falls back to a hash of the author. */
  avatar_color?: string
  /** Single character / emoji drawn inside the avatar. Defaults to the initial. */
  avatar?: string
  /** Renders a faint "sending…" style bubble. */
  pending?: boolean
}

export interface im_dialog_state {
  scroll: ui_scroll_state
  draft: string
  input_state: ui_input_text_state
  /** Whether the view is pinned to the newest message (enables auto-scroll). */
  stick_to_bottom: boolean
  /** Internal: last message count, to detect appends. */
  last_count: number
}

export interface im_dialog_options {
  /** Logical message font size. Defaults to 13.5. */
  font_px?: number
  /** Show the composer row. Defaults to true. */
  show_input?: boolean
  /** Composer placeholder. Defaults to "Message…". */
  placeholder?: string
  /** Optional header title bar. */
  title?: string
  /** Shows a header typing status and a temporary incoming typing bubble. */
  is_typing?: boolean
  /** Display name / avatar seed for the temporary typing bubble. */
  typing_author?: string
  /** Avatar fill colour (`#rrggbb`) for the temporary typing bubble. */
  typing_avatar_color?: string
  /** Single character / emoji drawn inside the temporary typing avatar. */
  typing_avatar?: string
  /** Max bubble width as a fraction of the panel width. Defaults to 0.72. */
  bubble_max_frac?: number
}

export interface im_dialog_event {
  /** Non-empty text submitted via Enter or the Send button this frame. */
  sent?: string
}

export function create_im_dialog_state(): im_dialog_state {
  return {
    scroll: { offset_y: 0 },
    draft: '',
    input_state: { cursor: 0, sel_anchor: 0, sel_head: 0 },
    stick_to_bottom: true,
    last_count: 0,
  }
}

function pack(hex: string): number {
  const raw = hex.trim().replace('#', '')
  const p = (s: number) => Number.parseInt(raw.slice(s, s + 2), 16)
  if (raw.length === 6) return (((255 << 24) | (p(4) << 16) | (p(2) << 8) | p(0)) >>> 0)
  if (raw.length === 8) return (((p(6) << 24) | (p(4) << 16) | (p(2) << 8) | p(0)) >>> 0)
  return 0xffffffff
}

const avatar_palette = ['#e0698b', '#5b9bd5', '#5fb878', '#d8a24a', '#a06ad8', '#48b6b6', '#d77a4a']

function avatar_color_for(msg: im_message): number {
  if (msg.avatar_color) return pack(msg.avatar_color)
  const key = msg.author ?? msg.text
  let hash = 0
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0
  return pack(avatar_palette[hash % avatar_palette.length])
}

function format_time(ts: number | string | undefined): string {
  if (ts === undefined) return ''
  if (typeof ts === 'string') return ts
  const d = new Date(ts)
  const hh = `${d.getHours()}`.padStart(2, '0')
  const mm = `${d.getMinutes()}`.padStart(2, '0')
  return `${hh}:${mm}`
}

function point_in(input: ui_input_snapshot, x: number, y: number, w: number, h: number): boolean {
  return input.mouse_x >= x && input.mouse_y >= y && input.mouse_x < x + w && input.mouse_y < y + h
}

function white_alpha(alpha: number): number {
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)))
  return (((a << 24) | 0x00ffffff) >>> 0)
}

type laid_message = {
  msg: im_message
  lines: string[]
  bubble_w: number
  bubble_h: number
  total_h: number
  has_meta: boolean
}

export function im_dialog(
  ui: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  messages: im_message[],
  state: im_dialog_state,
  options?: im_dialog_options,
): im_dialog_event {
  const scale = window.devicePixelRatio || 1
  const font_px = (options?.font_px ?? 13.5) * scale
  const show_input = options?.show_input ?? true
  const title = options?.title
  const is_typing = options?.is_typing ?? false
  const bubble_max_frac = options?.bubble_max_frac ?? 0.72
  const col = (slot: Parameters<typeof theme_color>[1]) => pack(theme_color(theme, slot))
  const event: im_dialog_event = {}

  const line_h = ui.text_line_height(font_px, FONT_MAIN)
  const pad = 10 * scale
  const bubble_pad = 9 * scale
  const avatar_r = 15 * scale
  const gap = 10 * scale
  const meta_h = 15 * scale

  // --- Regions -----------------------------------------------------------
  let cy = y
  if (title || is_typing) {
    const title_h = 30 * scale
    ui.fill_rect(x, y, w, title_h, col('panel_alt'))
    ui.fill_rect(x, y + title_h - 1 * scale, w, 1 * scale, col('border'))
    if (title) ui.draw_text(x + pad, ui.text_v_center_y(y, title_h, 13 * scale), title, 13 * scale, col('text'))
    if (is_typing) {
      const label = 'typing…'
      const label_font = 11.5 * scale
      const label_w = ui.text_width(label, label_font, FONT_MAIN)
      ui.draw_text(x + w - pad - label_w, ui.text_v_center_y(y, title_h, label_font), label, label_font, col('text_dim'))
    }
    cy += title_h
  }
  const input_h = show_input ? 44 * scale : 0
  const list_x = x
  const list_y = cy
  const list_w = w
  const list_h = y + h - input_h - cy

  // --- Layout pass -------------------------------------------------------
  const avatar_col = avatar_r * 2 + gap
  const max_bubble_w = Math.min(w * bubble_max_frac, w - avatar_col - pad * 2)
  const text_max_w = max_bubble_w - bubble_pad * 2
  const laid: laid_message[] = []
  let content_h = pad
  for (const msg of messages) {
    const lines = ui.wrap_text(msg.text, font_px, text_max_w, FONT_MAIN)
    let widest = 0
    for (const ln of lines) widest = Math.max(widest, ui.text_width(ln, font_px, FONT_MAIN))
    const bubble_w = Math.min(max_bubble_w, widest + bubble_pad * 2)
    const has_meta = !!(msg.author && msg.side !== 'right') || msg.timestamp !== undefined
    const bubble_h = lines.length * line_h + bubble_pad * 2
    const total_h = bubble_h + (has_meta ? meta_h : 0) + gap
    laid.push({ msg, lines, bubble_w, bubble_h, total_h, has_meta })
    content_h += total_h
  }
  const typing_msg: im_message = {
    author: options?.typing_author ?? 'typing',
    side: 'left',
    text: '',
    avatar: options?.typing_avatar,
    avatar_color: options?.typing_avatar_color,
  }
  const typing_bubble_w = 56 * scale
  const typing_bubble_h = Math.max(32 * scale, line_h + bubble_pad * 1.35)
  const typing_total_h = typing_bubble_h + gap
  if (is_typing) content_h += typing_total_h
  content_h += pad - gap

  // --- Scroll ------------------------------------------------------------
  const max_off = Math.max(0, content_h - list_h)
  if (messages.length !== state.last_count || is_typing) {
    if (state.stick_to_bottom) state.scroll.offset_y = max_off
    state.last_count = messages.length
  }
  if (point_in(input, list_x, list_y, list_w, list_h) && input.wheel_y) {
    state.scroll.offset_y = Math.max(0, Math.min(max_off, state.scroll.offset_y - input.wheel_y * 24 * scale))
  }
  state.scroll.offset_y = Math.max(0, Math.min(max_off, state.scroll.offset_y))
  state.stick_to_bottom = max_off - state.scroll.offset_y < 4 * scale
  if (is_typing) ui.request_render(2)

  // --- Render messages ---------------------------------------------------
  ui.fill_rect(list_x, list_y, list_w, list_h, col('bg'))
  ui.push_clip(list_x, list_y, list_w, list_h)
  let draw_y = list_y + pad - state.scroll.offset_y
  for (const item of laid) {
    const right = item.msg.side === 'right'
    if (draw_y + item.total_h >= list_y && draw_y <= list_y + list_h) {
      render_bubble(ui, item, draw_y, right, {
        list_x,
        list_w,
        pad,
        avatar_r,
        gap,
        bubble_pad,
        meta_h,
        line_h,
        font_px,
        scale,
        col,
      })
    }
    draw_y += item.total_h
  }
  if (is_typing && draw_y + typing_total_h >= list_y && draw_y <= list_y + list_h) {
    render_typing_bubble(ui, typing_msg, draw_y, performance.now(), {
      list_x,
      pad,
      avatar_r,
      gap,
      bubble_w: typing_bubble_w,
      bubble_h: typing_bubble_h,
      scale,
      col,
    })
  }
  ui.pop_clip()

  // --- Composer ----------------------------------------------------------
  if (show_input) {
    const iy = y + h - input_h
    ui.fill_rect(x, iy, w, input_h, col('panel'))
    ui.fill_rect(x, iy, w, 1 * scale, col('border'))
    const btn_w = 64 * scale
    const field_x = x + pad
    const field_y = iy + (input_h - 28 * scale) * 0.5
    const field_h = 28 * scale
    const field_w = w - pad * 3 - btn_w
    state.draft = widgets.input_field('im_dialog_input', field_x, field_y, field_w, field_h, state.draft, options?.placeholder ?? 'Message…', state.input_state)
    const send = widgets.button('im_dialog_send', field_x + field_w + pad, field_y, btn_w, field_h, 'Send', { active: state.draft.trim().length > 0 })
    const enter = widgets.has_keyboard_focus() && input.key_enter
    if ((send || enter) && state.draft.trim().length > 0) {
      event.sent = state.draft.trim()
      state.draft = ''
      state.input_state.cursor = 0
      state.input_state.sel_anchor = 0
      state.input_state.sel_head = 0
      state.stick_to_bottom = true
    }
  }

  return event
}

function render_typing_bubble(
  ui: ui_renderer,
  msg: im_message,
  draw_y: number,
  now_ms: number,
  g: {
    list_x: number
    pad: number
    avatar_r: number
    gap: number
    bubble_w: number
    bubble_h: number
    scale: number
    col: (slot: Parameters<typeof theme_color>[1]) => number
  },
): void {
  const { list_x, pad, avatar_r, gap, bubble_w, bubble_h, scale, col } = g
  const avatar_d = avatar_r * 2
  const radius = 9 * scale
  const ax = list_x + pad
  const bx = ax + avatar_d + gap
  const bubble_top = draw_y

  ui.fill_circle(ax + avatar_r, bubble_top + avatar_r, avatar_r, avatar_color_for(msg), 1)
  draw_avatar_glyph(ui, msg, ax + avatar_r, bubble_top + avatar_r, avatar_r, 13.5 * scale)
  ui.fill_round_rect(bx, bubble_top, bubble_w, bubble_h, radius, col('panel_alt'))
  ui.stroke_round_rect(bx, bubble_top, bubble_w, bubble_h, radius, 1, col('border'))

  const dot_r = 3.2 * scale
  const dot_gap = 9 * scale
  const total_w = dot_gap * 2 + dot_r * 2
  const start_x = bx + (bubble_w - total_w) * 0.5
  const cy = bubble_top + bubble_h * 0.5
  const phase = (now_ms % 1200) / 1200
  for (let i = 0; i < 3; i += 1) {
    const t = (phase + i * 0.18) % 1
    const alpha = 0.35 + 0.65 * (0.5 + Math.sin(t * Math.PI * 2) * 0.5)
    ui.fill_circle(start_x + i * dot_gap + dot_r, cy, dot_r, white_alpha(alpha), 1 * scale)
  }
}

function render_bubble(
  ui: ui_renderer,
  item: laid_message,
  draw_y: number,
  right: boolean,
  g: {
    list_x: number
    list_w: number
    pad: number
    avatar_r: number
    gap: number
    bubble_pad: number
    meta_h: number
    line_h: number
    font_px: number
    scale: number
    col: (slot: Parameters<typeof theme_color>[1]) => number
  },
): void {
  const { list_x, list_w, pad, avatar_r, gap, bubble_pad, meta_h, line_h, font_px, scale, col } = g
  const avatar_d = avatar_r * 2
  const radius = 9 * scale

  const meta_y = draw_y
  const bubble_top = draw_y + (item.has_meta ? meta_h : 0)

  if (right) {
    const ax = list_x + list_w - pad - avatar_d
    const bx = ax - gap - item.bubble_w
    // Avatar
    ui.fill_circle(ax + avatar_r, bubble_top + avatar_r, avatar_r, avatar_color_for(item.msg), 1)
    draw_avatar_glyph(ui, item.msg, ax + avatar_r, bubble_top + avatar_r, avatar_r, font_px)
    // Meta (timestamp) right-aligned over the bubble
    if (item.has_meta) {
      const ts = format_time(item.msg.timestamp)
      if (ts) {
        const tw = ui.text_width(ts, 10.5 * scale, FONT_MAIN)
        ui.draw_text(bx + item.bubble_w - tw, meta_y + 1 * scale, ts, 10.5 * scale, col('text_dim'))
      }
    }
    const fill = item.msg.pending ? col('accent_dim') : col('accent')
    ui.fill_round_rect(bx, bubble_top, item.bubble_w, item.bubble_h, radius, fill)
    draw_lines(ui, item.lines, bx + bubble_pad, bubble_top + bubble_pad, line_h, font_px, col('text'))
  } else {
    const ax = list_x + pad
    const bx = ax + avatar_d + gap
    ui.fill_circle(ax + avatar_r, bubble_top + avatar_r, avatar_r, avatar_color_for(item.msg), 1)
    draw_avatar_glyph(ui, item.msg, ax + avatar_r, bubble_top + avatar_r, avatar_r, font_px)
    if (item.has_meta) {
      const author = item.msg.author ?? ''
      const ts = format_time(item.msg.timestamp)
      let mx = bx
      if (author) {
        ui.draw_text(mx, meta_y + 1 * scale, author, 11 * scale, col('text'))
        mx += ui.text_width(author, 11 * scale, FONT_MAIN) + 8 * scale
      }
      if (ts) ui.draw_text(mx, meta_y + 2 * scale, ts, 10.5 * scale, col('text_dim'))
    }
    const fill = item.msg.pending ? col('panel') : col('panel_alt')
    ui.fill_round_rect(bx, bubble_top, item.bubble_w, item.bubble_h, radius, fill)
    ui.stroke_round_rect(bx, bubble_top, item.bubble_w, item.bubble_h, radius, 1, col('border'))
    draw_lines(ui, item.lines, bx + bubble_pad, bubble_top + bubble_pad, line_h, font_px, col('text'))
  }
}

function draw_lines(ui: ui_renderer, lines: string[], x: number, y: number, line_h: number, font_px: number, color: number): void {
  for (let i = 0; i < lines.length; i += 1) {
    ui.draw_text(x, y + i * line_h, lines[i], font_px, color, FONT_MAIN)
  }
}

function draw_avatar_glyph(ui: ui_renderer, msg: im_message, cx: number, cy: number, r: number, font_px: number): void {
  const glyph = msg.avatar ?? (msg.author ? msg.author.slice(0, 1).toUpperCase() : (msg.side === 'right' ? 'M' : '?'))
  const fs = font_px * 0.95
  const tw = ui.text_width(glyph, fs, FONT_MAIN)
  ui.draw_text(cx - tw * 0.5, ui.text_v_center_y(cy - r, r * 2, fs), glyph, fs, 0xffffffff)
}
