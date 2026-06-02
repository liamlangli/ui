# @liamlangli/ui

Immediate-mode WebGPU UI toolkit extracted from the `union` editor runtime.

It bundles the pieces needed to build a browser-native editor UI on top of WebGPU:

- **`ui_renderer`** — a batched WebGPU renderer for rectangles, rounded rects, SDF text (Lato main text and jb_mono monospace text in a shared atlas, PingFang SC for Chinese text), images, and the HSV color picker panels.
- **`ui_widgets`** — an immediate-mode widget layer (buttons, toggles, sliders, dropdowns, text/number inputs, color pickers, scroll regions, menus) drawn through `ui_renderer`.
- **`dock`** — a docking layout engine: split/leaf trees, tab drag-and-drop, drop targets, and (de)serialization.
- **`theme`** — palette/CSS-variable theming with `load_theme`, `apply_theme`, `theme_color`, and `hex_to_normalized_rgba`.

## Usage

```ts
import { ui_renderer, ui_widgets, create_empty_ui_input, apply_theme } from '@liamlangli/ui'

const renderer = new ui_renderer(canvas)
await renderer.init()
const widgets = new ui_widgets(renderer)
```

The renderer loads its Latin/monospace font atlas (`assets/latin_mono.{json,webp}`),
Chinese font atlas (`assets/ping_fang_sc_regular.{json,webp}`), and shader
(`assets/ui.wgsl`) via Vite `?url` imports, so consumers are expected to build
with Vite (or an equivalent bundler that understands the `?url` suffix).

### Chinese font loading

The Chinese (PingFang SC) atlas is several MB, so it never blocks startup:
`init()` resolves as soon as the small Latin/monospace atlas is ready, and the
Chinese atlas is fetched asynchronously in the background. Until it arrives the
CJK slot is backed by a 1x1 transparent texture (CJK glyphs simply render
blank), and once it loads the next frame picks it up automatically.

```ts
// Skip the Chinese atlas entirely (no background fetch):
await renderer.init({ chinese_font: false })

// Load it on demand later (resolves once the atlas is ready):
await renderer.load_chinese_font()
```

`chinese_font` defaults to `true`.

### Text view (selectable / copyable console)

`ui_widgets.text_view` is a fully GPU-rendered, selectable and copyable
scrollable monospace panel — a drop-in replacement for a DOM `<pre>` used as an
output/console view. It supports mouse-drag selection, Shift+click extend,
double-click word and triple-click line selection, wheel + scrollbar and
keyboard (arrows / PageUp / PageDown) scrolling, Ctrl/Cmd+A select-all, and
Ctrl/Cmd+C copy via `navigator.clipboard`.

```ts
import { create_text_view_state, text_view_selected_text } from '@liamlangli/ui'

const log_state = create_text_view_state()
const lines = [
  { text: 'compiling…', color: '#9aa' },
  { text: 'error: unexpected token', color: '#f55' },
]

// each frame, inside begin_frame()/end_frame():
widgets.text_view('output', x, y, w, h, lines, log_state, { wrap: true })

// read the current selection (e.g. for a context-menu "Copy"):
const selected = text_view_selected_text(lines, log_state)

// programmatic scroll:
log_state.scroll_to_line = lines.length - 1 // applied next frame
```

Copy and select-all need the relevant modifier/navigation keys forwarded on the
`ui_input_snapshot` (`ctrl`, `meta`, `key_a`, `key_c`, `key_up`, `key_down`,
`key_page_up`, `key_page_down`).

### CPU-updated textures

For overlays driven by raw pixel data (e.g. a parse/token visualiser that used
to live on a 2D `<canvas>` + `putImageData`), the renderer can create, update,
and draw RGBA textures, including nearest-neighbour ("pixelated") sampling:

```ts
const tex = renderer.create_texture(w, h, { filter: 'nearest' })
renderer.update_texture(tex, rgba /* Uint8ClampedArray | Uint8Array */)
renderer.draw_texture(tex, x, y, w, h) // sampler chosen at create time
renderer.destroy_texture(tex)
```

## Peer dependencies

- [`@webgpu/types`](https://www.npmjs.com/package/@webgpu/types) for `GPU*` typings.
