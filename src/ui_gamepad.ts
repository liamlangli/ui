// Game controller (Gamepad API) support.
//
// `gamepad_input` polls `navigator.getGamepads()` once per frame into
// `ui_gamepad_snapshot`s: dead-zoned sticks, per-frame press/release edges and
// an "active" pad (the one that most recently saw input). Gamepads never fire
// move/press DOM events, so hosts must keep rendering while a pad is connected
// (e.g. call `renderer.request_render()` each frame when `gamepad.connected`).
//
// `gamepad_cursor_update` / `gamepad_cursor_draw` implement an on-screen
// cursor made of transparent circles, driven by the controller: the left
// stick moves it, A clicks, the right stick scrolls. With `drive_pointer`
// (the default) the cursor is mirrored into the frame's `ui_input_snapshot`,
// so a connected controller can operate every widget like a mouse.
//
//   const gamepad = new gamepad_input(() => renderer.request_render())
//   const cursor = create_gamepad_cursor_state()
//   // per frame, after input.begin_frame():
//   gamepad.poll()
//   gamepad_cursor_update(gamepad.active, snapshot, x, y, w, h, cursor)
//   // ...draw the UI...
//   gamepad_cursor_draw(renderer, theme, gamepad.active, cursor)

import { pack_color } from './ui_theme'
import type { theme_definition } from './ui_types'
import type { ui_renderer } from './ui_renderer'
import type { ui_input_snapshot } from './ui_widgets'

/** Button names for the W3C "standard" gamepad mapping (Xbox-style layout). */
export const GAMEPAD_STANDARD_BUTTONS = [
  'A', 'B', 'X', 'Y',
  'LB', 'RB', 'LT', 'RT',
  'Back', 'Start', 'L3', 'R3',
  'DPad Up', 'DPad Down', 'DPad Left', 'DPad Right',
  'Home',
] as const

export function gamepad_button_label(index: number): string {
  return GAMEPAD_STANDARD_BUTTONS[index] ?? `B${index}`
}

export function gamepad_axis_label(index: number): string {
  return ['LX', 'LY', 'RX', 'RY'][index] ?? `A${index}`
}

export interface gamepad_button_state {
  pressed: boolean
  touched: boolean
  value: number
}

export interface ui_gamepad_snapshot {
  connected: boolean
  /** `Gamepad.index` slot in the browser, -1 when disconnected. */
  index: number
  id: string
  mapping: string
  buttons: gamepad_button_state[]
  /** Per-button press edge for this frame. */
  pressed: boolean[]
  /** Per-button release edge for this frame. */
  released: boolean[]
  /** Raw axes exactly as the browser reports them. */
  axes: number[]
  /** Dead-zoned stick deflections, -1..1 (standard mapping axes 0-3). */
  left_x: number
  left_y: number
  right_x: number
  right_y: number
  /** Analog trigger values, 0..1 (standard mapping buttons 6/7). */
  left_trigger: number
  right_trigger: number
  /** True when any button, stick or trigger saw input this frame. */
  activity: boolean
}

export function create_empty_gamepad_snapshot(): ui_gamepad_snapshot {
  return {
    connected: false,
    index: -1,
    id: '',
    mapping: '',
    buttons: [],
    pressed: [],
    released: [],
    axes: [],
    left_x: 0,
    left_y: 0,
    right_x: 0,
    right_y: 0,
    left_trigger: 0,
    right_trigger: 0,
    activity: false,
  }
}

/**
 * Radial stick dead zone: deflections inside `dead_zone` collapse to 0 and the
 * remaining range is rescaled so output still spans the full -1..1.
 */
export function apply_radial_dead_zone(x: number, y: number, dead_zone: number): [number, number] {
  const m = Math.hypot(x, y)
  if (m <= dead_zone || dead_zone >= 1) return [0, 0]
  const scaled = Math.min(1, (m - dead_zone) / (1 - dead_zone)) / m
  return [x * scaled, y * scaled]
}

export class gamepad_input {
  /** Snapshots of every connected pad, refreshed by `poll()`. */
  pads: ui_gamepad_snapshot[] = []
  /** The pad that most recently saw input (or the first connected one). */
  active: ui_gamepad_snapshot = create_empty_gamepad_snapshot()
  private active_index = -1
  private prev_pressed = new Map<number, boolean[]>()

  constructor(private readonly on_event: () => void = () => {}, private readonly dead_zone = 0.18) {
    if (typeof window === 'undefined') return
    // Connect/disconnect are the only gamepad DOM events — use them to wake
    // the host (everything else has to come from per-frame polling).
    window.addEventListener('gamepadconnected', () => this.on_event())
    window.addEventListener('gamepaddisconnected', () => this.on_event())
  }

  get supported(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'
  }

  get connected(): boolean {
    return this.active.connected
  }

  /** Re-read every connected pad. Call once per frame; returns the active pad. */
  poll(): ui_gamepad_snapshot {
    this.pads = []
    if (this.supported) {
      const seen = new Set<number>()
      for (const pad of navigator.getGamepads()) {
        if (!pad || !pad.connected) continue
        seen.add(pad.index)
        this.pads.push(this.snapshot_pad(pad))
      }
      for (const index of [...this.prev_pressed.keys()]) {
        if (!seen.has(index)) this.prev_pressed.delete(index)
      }
    }
    // Whichever pad saw input this frame becomes the active one; otherwise
    // stick with the current pad while it stays connected.
    const current = this.pads.find((p) => p.index === this.active_index)
    const next = this.pads.find((p) => p.activity) ?? current ?? this.pads[0] ?? create_empty_gamepad_snapshot()
    this.active_index = next.index
    this.active = next
    return next
  }

  private snapshot_pad(pad: Gamepad): ui_gamepad_snapshot {
    const prev = this.prev_pressed.get(pad.index) ?? []
    const buttons: gamepad_button_state[] = []
    const pressed: boolean[] = []
    const released: boolean[] = []
    const held: boolean[] = []
    let activity = false
    for (let i = 0; i < pad.buttons.length; i += 1) {
      const b = pad.buttons[i]!
      const down = b.pressed || b.value > 0.5
      buttons.push({ pressed: down, touched: b.touched, value: b.value })
      pressed.push(down && !prev[i])
      released.push(!down && prev[i] === true)
      held.push(down)
      if (down || b.value > 0.05) activity = true
    }
    this.prev_pressed.set(pad.index, held)
    const [lx, ly] = apply_radial_dead_zone(pad.axes[0] ?? 0, pad.axes[1] ?? 0, this.dead_zone)
    const [rx, ry] = apply_radial_dead_zone(pad.axes[2] ?? 0, pad.axes[3] ?? 0, this.dead_zone)
    if (lx !== 0 || ly !== 0 || rx !== 0 || ry !== 0) activity = true
    return {
      connected: true,
      index: pad.index,
      id: pad.id,
      mapping: pad.mapping || 'unknown',
      buttons,
      pressed,
      released,
      axes: [...pad.axes],
      left_x: lx,
      left_y: ly,
      right_x: rx,
      right_y: ry,
      left_trigger: buttons[6]?.value ?? 0,
      right_trigger: buttons[7]?.value ?? 0,
      activity,
    }
  }
}

// --- transparent circle cursor ----------------------------------------------

export interface gamepad_cursor_state {
  x: number
  y: number
  /** False until the cursor has been centred once after a pad connects. */
  placed: boolean
  /** 1 → 0 decay of the expanding ring shown after a button press. */
  pulse: number
  last_ms: number
}

export function create_gamepad_cursor_state(): gamepad_cursor_state {
  return { x: 0, y: 0, placed: false, pulse: 0, last_ms: 0 }
}

export interface gamepad_cursor_options {
  /** Cursor speed at full stick deflection, logical px/s (scaled by devicePixelRatio). Default 900. */
  speed?: number
  /** Right-stick scroll speed in wheel units/s. Default 24. */
  scroll_speed?: number
  /** Mirror the cursor into the input snapshot (move + A click + scroll) so the controller drives the widgets. Default true. */
  drive_pointer?: boolean
}

/**
 * Advance the controller cursor for this frame: move it with the left stick,
 * clamp it to the given rect and (unless `drive_pointer` is false) inject it
 * into `input` so widgets see it as the mouse — A presses click, the right
 * stick scrolls. Call after `input_collector.begin_frame()` and before any
 * widget consumes the snapshot; draw it later with `gamepad_cursor_draw`.
 */
export function gamepad_cursor_update(
  pad: ui_gamepad_snapshot,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  state: gamepad_cursor_state,
  options: gamepad_cursor_options = {},
): void {
  const now = performance.now()
  const dt = state.last_ms > 0 ? Math.min(64, now - state.last_ms) / 1000 : 0
  state.last_ms = now
  state.pulse = Math.max(0, state.pulse - dt * 3)
  if (!pad.connected) {
    state.placed = false
    return
  }
  if (!state.placed) {
    state.x = x + w / 2
    state.y = y + h / 2
    state.placed = true
  }
  const scale = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const speed = (options.speed ?? 900) * scale
  // Quadratic stick response: precise near the centre, fast at full tilt.
  const moving = pad.left_x !== 0 || pad.left_y !== 0
  state.x += pad.left_x * Math.abs(pad.left_x) * speed * dt
  state.y += pad.left_y * Math.abs(pad.left_y) * speed * dt
  state.x = Math.max(x, Math.min(x + w, state.x))
  state.y = Math.max(y, Math.min(y + h, state.y))
  if (pad.pressed.some(Boolean)) state.pulse = 1

  if (options.drive_pointer === false) return
  const a_down = pad.buttons[0]?.pressed === true
  if (moving || a_down || pad.released[0]) {
    input.mouse_x = state.x
    input.mouse_y = state.y
    input.pointer_is_touch = false
  }
  // Only edges + the held level are injected; release restores mouse_down so
  // the host collector's persistent state is left consistent.
  if (pad.pressed[0]) input.mouse_pressed = true
  if (a_down) input.mouse_down = true
  if (pad.released[0]) {
    input.mouse_released = true
    input.mouse_down = false
  }
  if (pad.right_y !== 0) input.wheel_y += -pad.right_y * (options.scroll_speed ?? 24) * dt
}

/**
 * Draw the cursor — a stack of transparent circles (halo, body, rim, centre
 * dot), a right-stick "lean" ghost circle and an expanding pulse ring on
 * button presses. Call after everything else so it rides above all windows.
 */
export function gamepad_cursor_draw(
  ui: ui_renderer,
  theme: theme_definition,
  pad: ui_gamepad_snapshot,
  state: gamepad_cursor_state,
): void {
  if (!pad.connected || !state.placed) return
  const scale = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const accent = pack_color(theme.palette.accent)
  const a_down = pad.buttons[0]?.pressed === true
  const r = 13 * scale
  ui.fill_circle(state.x, state.y, r * 1.9, with_alpha(accent, a_down ? 0.1 : 0.06))
  ui.fill_circle(state.x, state.y, r, with_alpha(accent, a_down ? 0.42 : 0.22))
  ui.stroke_circle(state.x, state.y, r, 1.5 * scale, with_alpha(accent, 0.66))
  ui.fill_circle(state.x, state.y, 2.5 * scale, with_alpha(pack_color(theme.palette.text), 0.8))
  if (pad.right_x !== 0 || pad.right_y !== 0) {
    const gx = state.x + pad.right_x * r * 1.6
    const gy = state.y + pad.right_y * r * 1.6
    ui.fill_circle(gx, gy, r * 0.55, with_alpha(accent, 0.18))
    ui.stroke_circle(gx, gy, r * 0.55, scale, with_alpha(accent, 0.4))
  }
  if (state.pulse > 0) {
    ui.stroke_circle(state.x, state.y, r * (1 + (1 - state.pulse) * 1.6), 2 * scale, with_alpha(accent, 0.5 * state.pulse))
  }
}

function with_alpha(rgba: number, alpha: number): number {
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)))
  return (((a & 255) << 24) | (rgba & 0x00ffffff)) >>> 0
}
