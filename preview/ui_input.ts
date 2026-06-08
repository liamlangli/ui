// Bridges raw DOM pointer/keyboard events into the per-frame `ui_input_snapshot`
// the toolkit consumes. Coordinates are reported in *physical* pixels
// (clientX * devicePixelRatio) to match the renderer's coordinate space.

import { create_empty_ui_input, type ui_input_snapshot, type ui_native_text_input, type ui_native_text_region } from '../src'

export class input_collector {
  private state: ui_input_snapshot = create_empty_ui_input()
  private typed = ''
  private wheel = 0
  private pressed = false
  private released = false
  private middle_down = false
  private right_pressed = false
  // one-shot key edges, consumed each frame
  private keys = new Set<string>()
  // held modifiers, persist across frames until keyup
  private ctrl = false
  private meta = false
  private shift = false
  private readonly ime: HTMLTextAreaElement
  private native_active = false
  private composition = ''
  private pending_composition_commit = ''
  private composition_commit_seen = false
  private native_regions: ui_native_text_region[] = []

  constructor(private readonly canvas: HTMLCanvasElement, private readonly on_event: () => void = () => {}) {
    const dpr = () => window.devicePixelRatio || 1
    const wake = () => this.on_event()
    this.ime = document.createElement('textarea')
    this.ime.setAttribute('aria-hidden', 'true')
    this.ime.setAttribute('autocorrect', 'off')
    this.ime.autocapitalize = 'off'
    this.ime.autocomplete = 'off'
    this.ime.spellcheck = false
    this.ime.wrap = 'off'
    this.ime.readOnly = false
    Object.assign(this.ime.style, {
      position: 'fixed',
      left: '0px',
      top: '0px',
      width: '24px',
      height: '24px',
      opacity: '0.01',
      color: 'transparent',
      caretColor: 'transparent',
      background: 'transparent',
      border: '0',
      outline: '0',
      padding: '0',
      margin: '0',
      resize: 'none',
      overflow: 'hidden',
      pointerEvents: 'none',
      zIndex: '2147483647',
      fontSize: '16px',
      lineHeight: '20px',
      transform: 'translateZ(0)',
    } satisfies Partial<CSSStyleDeclaration>)
    canvas.insertAdjacentElement('afterend', this.ime)

    canvas.addEventListener('pointermove', (e) => {
      const rect = canvas.getBoundingClientRect()
      this.state.mouse_x = (e.clientX - rect.left) * dpr()
      this.state.mouse_y = (e.clientY - rect.top) * dpr()
      wake()
    })
    canvas.addEventListener('pointerdown', (e) => {
      const rect = canvas.getBoundingClientRect()
      this.state.mouse_x = (e.clientX - rect.left) * dpr()
      this.state.mouse_y = (e.clientY - rect.top) * dpr()
      if (e.button === 1) {
        this.middle_down = true
      } else if (e.button === 2) {
        this.right_pressed = true
      } else {
        this.state.mouse_down = true
        this.pressed = true
        const region = this.hit_native_text_region(this.state.mouse_x, this.state.mouse_y)
        if (region) this.focus_native_text_region(region)
      }
      canvas.setPointerCapture(e.pointerId)
      wake()
    })
    canvas.addEventListener('contextmenu', (e) => e.preventDefault())
    canvas.addEventListener(
      'touchstart',
      (e) => {
        const touch = e.changedTouches[0]
        if (!touch) return
        const rect = canvas.getBoundingClientRect()
        const x = (touch.clientX - rect.left) * dpr()
        const y = (touch.clientY - rect.top) * dpr()
        const region = this.hit_native_text_region(x, y)
        if (region) this.focus_native_text_region(region)
      },
      { passive: true },
    )
    canvas.addEventListener('mousedown', (e) => {
      const rect = canvas.getBoundingClientRect()
      const x = (e.clientX - rect.left) * dpr()
      const y = (e.clientY - rect.top) * dpr()
      const region = this.hit_native_text_region(x, y)
      if (region) this.focus_native_text_region(region)
    })
    canvas.addEventListener('pointerup', (e) => {
      if (e.button === 1) {
        this.middle_down = false
      } else if (e.button !== 2) {
        this.state.mouse_down = false
        this.released = true
      }
      wake()
    })
    canvas.addEventListener(
      'wheel',
      (e) => {
        this.wheel += -e.deltaY / 100
        e.preventDefault()
        wake()
      },
      { passive: false },
    )

    window.addEventListener('keydown', (e) => {
      this.keys.add(e.key)
      this.ctrl = e.ctrlKey
      this.meta = e.metaKey
      this.shift = e.shiftKey
      // Printable text (ignore when a modifier that implies a shortcut is held).
      if (!this.native_active && e.key.length === 1 && !e.ctrlKey && !e.metaKey) this.typed += e.key
      // Keep browser focus shortcuts working but prevent scrolling on space etc.
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace'].includes(e.key)) {
        if (document.activeElement === document.body) e.preventDefault()
      }
      if (this.native_active && !e.isComposing && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Backspace', 'Delete', 'Home', 'End', 'Enter'].includes(e.key)) {
        e.preventDefault()
      }
      wake()
    })
    window.addEventListener('keyup', (e) => {
      this.ctrl = e.ctrlKey
      this.meta = e.metaKey
      this.shift = e.shiftKey
      wake()
    })

    this.ime.addEventListener('compositionstart', () => {
      this.composition = ''
      this.pending_composition_commit = ''
      this.composition_commit_seen = false
      wake()
    })
    this.ime.addEventListener('compositionupdate', (e) => {
      this.composition = e.data
      wake()
    })
    this.ime.addEventListener('compositionend', (e) => {
      this.composition = ''
      this.pending_composition_commit = e.data
      window.setTimeout(() => {
        if (!this.pending_composition_commit || this.composition_commit_seen) return
        this.typed += this.pending_composition_commit
        this.pending_composition_commit = ''
        this.composition_commit_seen = true
        this.ime.value = ''
        wake()
      }, 0)
      wake()
    })
    this.ime.addEventListener('input', (e) => {
      const ev = e as InputEvent
      if (ev.isComposing) {
        this.composition = ev.data ?? this.ime.value
        wake()
        return
      }
      const text = this.ime.value || ev.data || ''
      if (text) {
        this.typed += text
        this.pending_composition_commit = ''
        this.composition_commit_seen = true
      }
      this.composition = ''
      this.ime.value = ''
      wake()
    })
  }

  /** Build the snapshot for this frame. Call once per frame before drawing. */
  begin_frame(): ui_input_snapshot {
    const s = this.state
    s.mouse_pressed = this.pressed
    s.mouse_released = this.released
    s.mouse_middle_down = this.middle_down
    s.mouse_right_pressed = this.right_pressed
    s.wheel_y = this.wheel
    s.typed_text = this.typed
    s.ime_composition = this.composition
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
    this.sync_native_text_input(this.state.native_text_input ?? null)
    this.native_regions = [...(this.state.native_text_regions ?? [])]
    this.pressed = false
    this.released = false
    this.right_pressed = false
    this.wheel = 0
    this.typed = ''
    this.keys.clear()
  }

  private sync_native_text_input(request: ui_native_text_input | null): void {
    if (!request) {
      this.native_active = false
      this.composition = ''
      this.pending_composition_commit = ''
      this.composition_commit_seen = false
      this.ime.value = ''
      if (document.activeElement === this.ime) this.ime.blur()
      return
    }

    this.position_native_text_region(request)
    this.ime.inputMode = request.mode === 'numeric' ? 'decimal' : 'text'
    this.native_active = true
    if (document.activeElement !== this.ime) this.focus_ime()
  }

  private focus_native_text_region(region: ui_native_text_region): void {
    this.position_native_text_region(region)
    this.ime.inputMode = region.mode === 'numeric' ? 'decimal' : 'text'
    this.native_active = true
    this.focus_ime()
  }

  private position_native_text_region(region: ui_native_text_region): void {
    const scale = window.devicePixelRatio || 1
    const rect = this.canvas.getBoundingClientRect()
    this.ime.style.left = `${rect.left + region.x / scale}px`
    this.ime.style.top = `${rect.top + region.y / scale}px`
    this.ime.style.width = `${Math.max(1, region.w / scale)}px`
    this.ime.style.height = `${Math.max(1, region.h / scale)}px`
  }

  private focus_ime(): void {
    try {
      this.ime.focus({ preventScroll: true })
    } catch {
      this.ime.focus()
    }
    try {
      const end = this.ime.value.length
      this.ime.setSelectionRange(end, end)
    } catch {
      /* Some mobile browsers restrict selection on hidden-ish controls. */
    }
  }

  private hit_native_text_region(x: number, y: number): ui_native_text_region | null {
    for (let i = this.native_regions.length - 1; i >= 0; i -= 1) {
      const region = this.native_regions[i]!
      if (x >= region.x && y >= region.y && x < region.x + region.w && y < region.y + region.h) return region
    }
    return null
  }
}
