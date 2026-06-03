// Bridges raw DOM pointer/keyboard events into the per-frame `ui_input_snapshot`
// the toolkit consumes. Coordinates are reported in *physical* pixels
// (clientX * devicePixelRatio) to match the renderer's coordinate space.

import { create_empty_ui_input, type ui_input_snapshot } from '../src/index'

export class input_collector {
  private state: ui_input_snapshot = create_empty_ui_input()
  private typed = ''
  private wheel = 0
  private pressed = false
  private released = false
  // one-shot key edges, consumed each frame
  private keys = new Set<string>()
  // held modifiers, persist across frames until keyup
  private ctrl = false
  private meta = false
  private shift = false

  constructor(private readonly canvas: HTMLCanvasElement) {
    const dpr = () => window.devicePixelRatio || 1

    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect()
      this.state.mouse_x = (e.clientX - rect.left) * dpr()
      this.state.mouse_y = (e.clientY - rect.top) * dpr()
    })
    canvas.addEventListener('pointerdown', (e) => {
      canvas.setPointerCapture(e.pointerId)
      const rect = canvas.getBoundingClientRect()
      this.state.mouse_x = (e.clientX - rect.left) * dpr()
      this.state.mouse_y = (e.clientY - rect.top) * dpr()
      this.state.mouse_down = true
      this.pressed = true
    })
    canvas.addEventListener('pointerup', () => {
      this.state.mouse_down = false
      this.released = true
    })
    canvas.addEventListener(
      'wheel',
      (e) => {
        this.wheel += -e.deltaY / 100
        e.preventDefault()
      },
      { passive: false },
    )

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.key)
      this.ctrl = e.ctrlKey
      this.meta = e.metaKey
      this.shift = e.shiftKey
      // Printable text (ignore when a modifier that implies a shortcut is held).
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey) this.typed += e.key
      // Keep browser focus shortcuts working but prevent scrolling on space etc.
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace'].includes(e.key)) {
        if (document.activeElement === document.body) e.preventDefault()
      }
    })
    window.addEventListener('keyup', (e) => {
      this.ctrl = e.ctrlKey
      this.meta = e.metaKey
      this.shift = e.shiftKey
    })
  }

  /** Build the snapshot for this frame. Call once per frame before drawing. */
  begin_frame(): ui_input_snapshot {
    const s = this.state
    s.mouse_pressed = this.pressed
    s.mouse_released = this.released
    s.wheel_y = this.wheel
    s.typed_text = this.typed
    s.key_backspace = this.keys.has('Backspace')
    s.key_delete = this.keys.has('Delete')
    s.key_enter = this.keys.has('Enter')
    s.key_escape = this.keys.has('Escape')
    s.key_left = this.keys.has('ArrowLeft')
    s.key_right = this.keys.has('ArrowRight')
    s.key_up = this.keys.has('ArrowUp')
    s.key_down = this.keys.has('ArrowDown')
    s.key_home = this.keys.has('Home')
    s.key_end = this.keys.has('End')
    s.key_page_up = this.keys.has('PageUp')
    s.key_page_down = this.keys.has('PageDown')
    s.key_a = this.keys.has('a') || this.keys.has('A')
    s.key_c = this.keys.has('c') || this.keys.has('C')
    s.shift = this.shift
    s.ctrl = this.ctrl
    s.meta = this.meta
    return s
  }

  /** Clear per-frame edges/deltas. Call once per frame after drawing. */
  end_frame(): void {
    this.pressed = false
    this.released = false
    this.wheel = 0
    this.typed = ''
    this.keys.clear()
  }
}
