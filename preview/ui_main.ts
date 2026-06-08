// @liamlangli/ui — interactive preview / playground.
//
// Boots the WebGPU renderer and draws a small live gallery — a top menu bar
// plus a panel of widgets (buttons, a toggle, a slider) — entirely on the GPU.
// The previous, much larger demo was retired alongside the docking/window
// plugins; this keeps the deployed GitHub Pages preview exercising the core
// renderer + widgets + menu surface.

import {
  ui_renderer,
  ui_widgets,
  load_theme,
  hex_to_normalized_rgba,
  pack_color,
  create_empty_ui_input,
  FONT_MONO,
  ui_main_menu,
  type theme_definition,
  type ui_input_snapshot,
  type ui_menu_node,
} from '../src/ui_index'
import theme_url from './theme.json?url'

const canvas = document.getElementById('app') as HTMLCanvasElement

// ---------------------------------------------------------------------------
// Minimal pointer/keyboard collector. The retired preview/input.ts handled IME,
// touch, and gizmo state; the core widgets used here only need mouse + a few
// keys, so we build the per-frame snapshot inline.
// ---------------------------------------------------------------------------
class input_collector {
  private mouse_x = 0
  private mouse_y = 0
  private down = false
  private pressed = false
  private released = false
  private wheel = 0

  constructor(target: HTMLCanvasElement, private readonly wake: () => void) {
    const to_local = (e: PointerEvent | WheelEvent) => {
      const rect = target.getBoundingClientRect()
      const scale = window.devicePixelRatio || 1
      this.mouse_x = (e.clientX - rect.left) * scale
      this.mouse_y = (e.clientY - rect.top) * scale
    }
    target.addEventListener('pointermove', (e) => { to_local(e); this.wake() })
    target.addEventListener('pointerdown', (e) => {
      to_local(e)
      this.down = true
      this.pressed = true
      target.setPointerCapture(e.pointerId)
      this.wake()
    })
    target.addEventListener('pointerup', (e) => {
      to_local(e)
      this.down = false
      this.released = true
      this.wake()
    })
    target.addEventListener('wheel', (e) => {
      this.wheel += e.deltaY
      this.wake()
    }, { passive: true })
  }

  begin_frame(): ui_input_snapshot {
    const snapshot: ui_input_snapshot = {
      ...create_empty_ui_input(),
      mouse_x: this.mouse_x,
      mouse_y: this.mouse_y,
      mouse_down: this.down,
      mouse_pressed: this.pressed,
      mouse_released: this.released,
      wheel_y: this.wheel,
    }
    return snapshot
  }

  end_frame(): void {
    this.pressed = false
    this.released = false
    this.wheel = 0
  }
}

const menus: ui_menu_node[] = [
  {
    label: 'File',
    children: [
      { id: 'file:new', label: 'New' },
      { id: 'file:open', label: 'Open…' },
      { separator: true, label: '' },
      { id: 'file:quit', label: 'Quit' },
    ],
  },
  {
    label: 'View',
    children: [
      { id: 'view:reset', label: 'Reset Layout' },
      { id: 'view:fullscreen', label: 'Toggle Fullscreen' },
    ],
  },
  {
    label: 'Help',
    children: [{ id: 'help:about', label: 'About @liamlangli/ui' }],
  },
]

async function main(): Promise<void> {
  const renderer = new ui_renderer(canvas)
  await renderer.init()
  const widgets = new ui_widgets(renderer)
  const theme: theme_definition = await load_theme(theme_url)
  const main_menu = new ui_main_menu(menus)

  const input = new input_collector(canvas, () => renderer.request_render())
  window.addEventListener('resize', () => renderer.resize())

  // Demo widget state.
  let counter = 0
  let muted = false
  let volume = 0.6
  let last_action = 'ready'

  function frame(): void {
    const snapshot = input.begin_frame()
    const safe = renderer.safe_rect()
    const scale = window.devicePixelRatio || 1
    const m = 8 * scale
    const clear = hex_to_normalized_rgba(theme.palette.bg)

    const menu_h = 30 * scale
    const bar_x = safe.x + m
    const bar_y = safe.y + m
    const bar_w = safe.w - m * 2

    // Mask input from the panel while a dropdown is open over it. The menu bar
    // (drawn last) still reads the real snapshot it is passed directly.
    const block = main_menu.blocks_point(snapshot.mouse_x, snapshot.mouse_y)
    const panel_input = block
      ? { ...snapshot, mouse_pressed: false, mouse_down: false, mouse_released: false, wheel_y: 0 }
      : snapshot

    renderer.begin_frame()
    widgets.begin_frame(theme, panel_input)

    // Content panel below the menu bar.
    const panel_x = bar_x
    const panel_y = bar_y + menu_h + m
    const panel_w = bar_w
    const panel_h = safe.y + safe.h - m - panel_y
    renderer.fill_round_rect(panel_x, panel_y, panel_w, panel_h, 6 * scale, pack_color(theme.palette.panel))
    renderer.stroke_round_rect(panel_x, panel_y, panel_w, panel_h, 6 * scale, 1, pack_color(theme.palette.border))

    const pad = 16 * scale
    let cx = panel_x + pad
    let cy = panel_y + pad
    renderer.draw_text(cx, cy, '@liamlangli/ui — widget gallery', 14 * scale, pack_color(theme.palette.text))
    cy += 30 * scale

    const btn_w = 140 * scale
    const btn_h = 30 * scale
    if (widgets.button('inc', cx, cy, btn_w, btn_h, `Clicked ${counter}×`)) {
      counter += 1
      last_action = 'button: increment'
    }
    if (widgets.button('reset', cx + btn_w + m, cy, btn_w, btn_h, 'Reset')) {
      counter = 0
      last_action = 'button: reset'
    }
    cy += btn_h + m * 2

    const next_muted = widgets.toggle('mute', cx, cy, muted, muted ? 'Muted' : 'Audio on')
    if (next_muted !== muted) {
      muted = next_muted
      last_action = `toggle: ${muted ? 'muted' : 'unmuted'}`
    }
    cy += btn_h + m * 2

    renderer.draw_text(cx, cy, 'Volume', 12 * scale, pack_color(theme.palette.text_dim))
    cy += 18 * scale
    const next_volume = widgets.slider('volume', cx, cy, 260 * scale, btn_h, volume, 0, 1, true)
    if (next_volume !== volume) {
      volume = next_volume
      last_action = `slider: ${volume.toFixed(2)}`
    }
    cy += btn_h + m * 2

    renderer.draw_text(cx, cy, `last action: ${last_action}`, 11 * scale, pack_color(theme.palette.text_dim), FONT_MONO)

    // Menu bar draws on top so its dropdowns overlay the panel.
    const menu_event = main_menu.frame(renderer, theme, snapshot, bar_x, bar_y, bar_w, menu_h)
    if (menu_event.activated?.id) last_action = `menu: ${menu_event.activated.id}`

    widgets.end_frame()
    renderer.flush(clear)
    input.end_frame()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

main().catch((err) => {
  console.error(err)
  const el = document.getElementById('error')
  if (el) {
    el.style.display = 'block'
    el.textContent = `${err}`
  }
})
