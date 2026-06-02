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

The renderer loads its Latin/monospace font atlas (`assets/latin_mono.{json,png}`),
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

## Peer dependencies

- [`@webgpu/types`](https://www.npmjs.com/package/@webgpu/types) for `GPU*` typings.
