// gamepad_test — a "Controller Test" panel plugin.
//
// Visualises the active game controller as a stylised gamepad shape whose
// sticks, d-pad, face buttons, bumpers, triggers and centre cluster all light
// up live, plus a raw keymap readout — every button index/name/value and every
// axis — so you can check which controller is currently in use and verify its
// mapping end to end.
//
//   ┌ header ───────────────────────────────────────────────┐  connected pads,
//   │ Game Controller Test          Last input: RB (5)      │  active marked
//   │ ● #0 Xbox Wireless Controller · standard mapping      │
//   ├ controller ───────────────────────────────────────────┤
//   │   [LT████  ]                            [RT█     ]    │  analog triggers
//   │   [  LB   ]                             [   RB   ]    │
//   │  ╭──────────────────────────────────────────────╮     │
//   │  │  (LS)      Back  Home  Start         (Y)     │     │  live sticks,
//   │  │             ✛                      (X) (B)   │     │  d-pad, face
//   │  │            d-pad        (RS)         (A)     │     │  buttons
//   │  ╰──────────────────────────────────────────────╯     │
//   ├ keymap ───────────────────────────────────────────────┤
//   │ BUTTONS                    AXES                       │  every button +
//   │  0 A     ▕█▏ 1.00          0 LX  ▕──█──▏ -0.32        │  axis with live
//   │  1 B     ▕ ▏ 0.00          1 LY  ▕──█──▏  0.00        │  value bars
//   └────────────────────────────────────────────────────────┘
//
// Usage (once per frame, inside begin_frame()/flush()):
//
//   gamepad_test_panel(ui, theme, input, x, y, w, h, gamepad, state)

import { pack_color } from '../ui_theme'
import type { theme_definition, theme_slot } from '../ui_types'
import { FONT_MONO, type ui_renderer } from '../ui_renderer'
import type { ui_input_snapshot } from '../ui_widgets'
import { gamepad_axis_label, gamepad_button_label, GAMEPAD_STANDARD_BUTTONS, type gamepad_input, type ui_gamepad_snapshot } from '../ui_gamepad'

export interface gamepad_test_state {
  scroll_y: number
  /** Index of the most recently pressed button, for the header readout. */
  last_button: number | null
}

export function create_gamepad_test_state(): gamepad_test_state {
  return { scroll_y: 0, last_button: null }
}

// Classic face-button rim colours (A green, B red, X blue, Y amber) — kept
// hardcoded like other plugins' fixed series colours so the layout reads as a
// gamepad under any theme.
const FACE_COLORS = ['#5fb878', '#d9534f', '#4c8bf5', '#d8a24a']

export function gamepad_test_panel(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  gamepad: gamepad_input,
  state: gamepad_test_state,
): void {
  const scale = window.devicePixelRatio || 1
  const slot = (s: theme_slot) => pack_color(theme.palette[s])
  const pad_px = 14 * scale
  ui.fill_rect(x, y, w, h, slot('panel'))

  let cy = y + 10 * scale
  ui.draw_text(x + pad_px, cy, 'Game Controller Test', 13 * scale, slot('text'))

  if (!gamepad.supported) {
    ui.draw_text(x + pad_px, cy + 24 * scale, 'The Gamepad API is not available in this browser.', 11 * scale, slot('text_dim'))
    return
  }
  if (gamepad.pads.length === 0) {
    state.last_button = null
    ui.draw_text(x + pad_px, cy + 24 * scale, 'No controller detected.', 11.5 * scale, slot('text_dim'))
    ui.draw_text(x + pad_px, cy + 42 * scale, 'Connect a gamepad and press any button to wake it up.', 10.5 * scale, slot('text_dim'))
    return
  }

  const pad = gamepad.active
  for (let i = 0; i < pad.pressed.length; i += 1) {
    if (pad.pressed[i]) state.last_button = i
  }
  if (state.last_button != null) {
    const msg = `Last input: ${gamepad_button_label(state.last_button)} (button ${state.last_button})`
    const mw = ui.text_width(msg, 10.5 * scale, FONT_MONO)
    ui.draw_text(x + w - pad_px - mw, cy + 2 * scale, msg, 10.5 * scale, slot('accent'), FONT_MONO)
  }
  cy += 22 * scale

  // Connected pads, the active one marked — press a button on another pad to
  // make it the active (visualised) one.
  for (const p of gamepad.pads) {
    const is_active = p.index === pad.index
    ui.fill_circle(x + pad_px + 3 * scale, cy + 6 * scale, 3 * scale, is_active ? slot('accent') : slot('border_strong'))
    const label = `#${p.index} ${p.id} · ${p.mapping === 'standard' ? 'standard mapping' : `mapping: ${p.mapping}`}`
    ui.push_clip(x + pad_px, cy, w - pad_px * 2, 14 * scale)
    ui.draw_text(x + pad_px + 11 * scale, cy, label, 10.5 * scale, is_active ? slot('text') : slot('text_dim'), FONT_MONO)
    ui.pop_clip()
    cy += 15 * scale
  }
  if (gamepad.pads.length > 1) {
    ui.draw_text(x + pad_px, cy, 'Press any button on a controller to make it active.', 9.5 * scale, slot('text_dim'))
    cy += 13 * scale
  }
  cy += 4 * scale

  // Everything below the header scrolls together when the panel is short.
  const body_y = cy
  const body_h = Math.max(0, y + h - body_y - 8 * scale)
  const bw = w - pad_px * 2
  const viz_h = Math.min(230 * scale, Math.max(130 * scale, body_h * 0.48))
  const col_gap = 16 * scale
  const left_w = Math.max(150 * scale, Math.min(300 * scale, (bw - col_gap) * 0.55))
  const right_w = Math.max(120 * scale, bw - left_w - col_gap)
  const row_h = 15 * scale
  const sec_h = 18 * scale
  const button_rows = Math.max(GAMEPAD_STANDARD_BUTTONS.length, pad.buttons.length)
  const buttons_h = sec_h + button_rows * row_h
  const axes_h = sec_h + pad.axes.length * row_h
  const info_h = sec_h + 4 * 14 * scale
  const content_h = viz_h + 10 * scale + Math.max(buttons_h, axes_h + 10 * scale + info_h)

  const max_scroll = Math.max(0, content_h - body_h)
  const hovered = input.mouse_x >= x && input.mouse_x < x + w && input.mouse_y >= body_y && input.mouse_y < body_y + body_h
  if (hovered && input.wheel_y !== 0 && max_scroll > 0) state.scroll_y -= input.wheel_y * 48 * scale
  state.scroll_y = Math.max(0, Math.min(max_scroll, state.scroll_y))

  ui.push_clip(x, body_y, w, body_h)
  let oy = body_y - state.scroll_y
  draw_controller(ui, theme, pad, x + pad_px, oy, bw, viz_h, scale)
  oy += viz_h + 10 * scale
  draw_button_table(ui, theme, pad, x + pad_px, oy, left_w, button_rows, scale)
  let ry = draw_axes_table(ui, theme, pad, x + pad_px + left_w + col_gap, oy, right_w, scale)
  ry += 10 * scale
  draw_info(ui, theme, pad, x + pad_px + left_w + col_gap, ry, right_w, scale)
  ui.pop_clip()

  if (max_scroll > 0) {
    const sb_w = 4 * scale
    const thumb_h = Math.max(24 * scale, (body_h / content_h) * body_h)
    const thumb_y = body_y + (state.scroll_y / max_scroll) * (body_h - thumb_h)
    ui.fill_round_rect(x + w - sb_w - 3 * scale, thumb_y, sb_w, thumb_h, sb_w / 2, slot('ghost'))
  }
}

// --- controller shape ---------------------------------------------------------
// Drawn in a 100×52-unit design grid mapped to fit centred in the given rect.

function draw_controller(
  ui: ui_renderer,
  theme: theme_definition,
  pad: ui_gamepad_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
): void {
  const slot = (s: theme_slot) => pack_color(theme.palette[s])
  const u = Math.min(w / 100, h / 52)
  const ox = x + (w - 100 * u) / 2
  const oy = y + (h - 52 * u) / 2
  const X = (gx: number) => ox + gx * u
  const Y = (gy: number) => oy + gy * u
  const down = (i: number) => pad.buttons[i]?.pressed === true
  const fill_for = (i: number) => (down(i) ? slot('accent') : slot('panel_alt'))
  const font = Math.max(7, 3 * u)

  const label = (cx: number, cyy: number, text: string, color: number) => {
    const tw = ui.text_width(text, font, FONT_MONO)
    ui.draw_text(X(cx) - tw / 2, ui.text_v_center_y(Y(cyy), 0, font), text, font, color, FONT_MONO)
  }

  // Body.
  ui.fill_round_rect(X(10), Y(12), 80 * u, 32 * u, 9 * u, slot('panel_alt'))
  ui.stroke_round_rect(X(10), Y(12), 80 * u, 32 * u, 9 * u, scale, slot('border_strong'))

  // Analog triggers (LT/RT) — bars filled by the live value.
  const trigger = (gx: number, value: number, name: string) => {
    ui.fill_round_rect(X(gx), Y(2), 18 * u, 4.5 * u, 1.5 * u, slot('track'))
    if (value > 0) ui.fill_round_rect(X(gx), Y(2), 18 * u * Math.min(1, value), 4.5 * u, 1.5 * u, slot('accent'))
    ui.stroke_round_rect(X(gx), Y(2), 18 * u, 4.5 * u, 1.5 * u, scale, slot('border'))
    label(gx + 9, 4.25, name, slot('text_dim'))
  }
  trigger(14, pad.left_trigger, 'LT')
  trigger(68, pad.right_trigger, 'RT')

  // Bumpers (LB/RB).
  const bumper = (gx: number, i: number, name: string) => {
    ui.fill_round_rect(X(gx), Y(8), 18 * u, 4 * u, 1.5 * u, fill_for(i))
    ui.stroke_round_rect(X(gx), Y(8), 18 * u, 4 * u, 1.5 * u, scale, slot('border_strong'))
    label(gx + 9, 10, name, down(i) ? slot('bg') : slot('text_dim'))
  }
  bumper(14, 4, 'LB')
  bumper(68, 5, 'RB')

  // Sticks: well + live dot offset by the raw axes; pressing L3/R3 lights the dot.
  const stick = (gx: number, gy: number, ax: number, ay: number, press_btn: number) => {
    ui.fill_circle(X(gx), Y(gy), 7 * u, slot('track'))
    ui.stroke_circle(X(gx), Y(gy), 7 * u, scale, slot('border_strong'))
    const dx = (pad.axes[ax] ?? 0) * 3.8
    const dy = (pad.axes[ay] ?? 0) * 3.8
    ui.fill_circle(X(gx + dx), Y(gy + dy), 3.2 * u, down(press_btn) ? slot('accent') : slot('text_dim'))
    ui.stroke_circle(X(gx + dx), Y(gy + dy), 3.2 * u, scale, slot('border_strong'))
  }
  stick(27, 23, 0, 1, 10)
  stick(61, 33, 2, 3, 11)

  // D-pad (buttons 12-15).
  const arm = (gx: number, gy: number, gw: number, gh: number, i: number) => {
    ui.fill_round_rect(X(gx), Y(gy), gw * u, gh * u, u, fill_for(i))
    ui.stroke_round_rect(X(gx), Y(gy), gw * u, gh * u, u, scale, slot('border_strong'))
  }
  arm(38, 25, 4, 6, 12)
  arm(38, 37, 4, 6, 13)
  arm(32, 31, 6, 4, 14)
  arm(44, 31, 6, 4, 15)
  ui.fill_rect(X(38), Y(31), 4 * u, 4 * u, slot('panel_alt'))

  // Face buttons (A/B/X/Y diamond) with classic rim colours.
  const face = (gx: number, gy: number, i: number) => {
    ui.fill_circle(X(gx), Y(gy), 3.2 * u, fill_for(i))
    ui.stroke_circle(X(gx), Y(gy), 3.2 * u, scale, pack_color(FACE_COLORS[i] ?? theme.palette.border_strong))
    label(gx, gy, gamepad_button_label(i), down(i) ? slot('bg') : slot('text'))
  }
  face(76, 29, 0) // A
  face(82, 23, 1) // B
  face(70, 23, 2) // X
  face(76, 17, 3) // Y

  // Centre cluster: Back (8), Home (16), Start (9).
  const center = (gx: number, gy: number, r: number, i: number) => {
    ui.fill_circle(X(gx), Y(gy), r * u, fill_for(i))
    ui.stroke_circle(X(gx), Y(gy), r * u, scale, slot('border_strong'))
  }
  center(45, 19, 2.2, 8)
  center(55, 19, 2.2, 9)
  center(50, 23, 3, 16)
}

// --- keymap tables ------------------------------------------------------------

function section(ui: ui_renderer, theme: theme_definition, x: number, y: number, w: number, text: string, scale: number): number {
  const dim = pack_color(theme.palette.text_dim)
  ui.draw_text(x, y, text, 10 * scale, dim)
  const tw = ui.text_width(text, 10 * scale)
  ui.fill_rect(x + tw + 8 * scale, y + 6 * scale, Math.max(0, w - tw - 8 * scale), 1, pack_color(theme.palette.border))
  return y + 18 * scale
}

function draw_button_table(
  ui: ui_renderer,
  theme: theme_definition,
  pad: ui_gamepad_snapshot,
  x: number,
  y: number,
  w: number,
  rows: number,
  scale: number,
): number {
  const slot = (s: theme_slot) => pack_color(theme.palette[s])
  const row_h = 15 * scale
  const font = 9.5 * scale
  let cy = section(ui, theme, x, y, w, 'BUTTONS', scale)
  const bar_w = Math.min(60 * scale, w * 0.28)
  const value_w = ui.text_width('0.00', font, FONT_MONO)
  for (let i = 0; i < rows; i += 1) {
    const b = pad.buttons[i]
    const pressed = b?.pressed === true
    if (pressed) ui.fill_round_rect(x - 4 * scale, cy - scale, w + 8 * scale, row_h, 3 * scale, slot('selected'))
    const ty = ui.text_v_center_y(cy, row_h - 2 * scale, font)
    ui.draw_text(x, ty, `${i}`.padStart(2, ' '), font, slot('text_dim'), FONT_MONO)
    ui.draw_text(x + 18 * scale, ty, gamepad_button_label(i), font, pressed ? slot('accent') : slot('text'), FONT_MONO)
    const bar_x = x + w - bar_w - value_w - 8 * scale
    const bar_y = cy + (row_h - 2 * scale - 5 * scale) / 2
    ui.fill_round_rect(bar_x, bar_y, bar_w, 5 * scale, 2.5 * scale, slot('track'))
    const v = Math.max(0, Math.min(1, b?.value ?? 0))
    if (v > 0) ui.fill_round_rect(bar_x, bar_y, Math.max(bar_w * v, Math.min(5 * scale, bar_w)), 5 * scale, 2.5 * scale, slot('accent'))
    ui.draw_text(x + w - value_w, ty, (b?.value ?? 0).toFixed(2), font, slot('text_dim'), FONT_MONO)
    cy += row_h
  }
  return cy
}

function draw_axes_table(
  ui: ui_renderer,
  theme: theme_definition,
  pad: ui_gamepad_snapshot,
  x: number,
  y: number,
  w: number,
  scale: number,
): number {
  const slot = (s: theme_slot) => pack_color(theme.palette[s])
  const row_h = 15 * scale
  const font = 9.5 * scale
  let cy = section(ui, theme, x, y, w, 'AXES', scale)
  const value_w = ui.text_width('-0.00', font, FONT_MONO)
  const bar_w = Math.max(30 * scale, w - 34 * scale - value_w - 8 * scale)
  for (let i = 0; i < pad.axes.length; i += 1) {
    const v = Math.max(-1, Math.min(1, pad.axes[i] ?? 0))
    const ty = ui.text_v_center_y(cy, row_h - 2 * scale, font)
    ui.draw_text(x, ty, `${i}`.padStart(2, ' '), font, slot('text_dim'), FONT_MONO)
    ui.draw_text(x + 18 * scale, ty, gamepad_axis_label(i), font, v !== 0 ? slot('accent') : slot('text'), FONT_MONO)
    // Centred bar: fill grows from the middle toward the deflection.
    const bar_x = x + 34 * scale
    const bar_y = cy + (row_h - 2 * scale - 5 * scale) / 2
    ui.fill_round_rect(bar_x, bar_y, bar_w, 5 * scale, 2.5 * scale, slot('track'))
    const mid = bar_x + bar_w / 2
    const fill = (bar_w / 2) * Math.abs(v)
    if (fill > 0) ui.fill_rect(v < 0 ? mid - fill : mid, bar_y, fill, 5 * scale, slot('accent'))
    ui.fill_rect(mid - scale / 2, bar_y - scale, 1 * scale, 7 * scale, slot('border_strong'))
    ui.draw_text(x + w - value_w, ty, v.toFixed(2), font, slot('text_dim'), FONT_MONO)
    cy += row_h
  }
  return cy
}

function draw_info(
  ui: ui_renderer,
  theme: theme_definition,
  pad: ui_gamepad_snapshot,
  x: number,
  y: number,
  w: number,
  scale: number,
): void {
  const slot = (s: theme_slot) => pack_color(theme.palette[s])
  const font = 9.5 * scale
  let cy = section(ui, theme, x, y, w, 'INFO', scale)
  cy += ui.draw_text_wrapped(x, cy, w, pad.id, font, slot('text'), FONT_MONO) + 4 * scale
  ui.draw_text(x, cy, `mapping: ${pad.mapping}`, font, slot('text_dim'), FONT_MONO)
  cy += 14 * scale
  ui.draw_text(x, cy, `slot #${pad.index} · ${pad.buttons.length} buttons · ${pad.axes.length} axes`, font, slot('text_dim'), FONT_MONO)
}
