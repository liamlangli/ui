# @liamlangli/ui

Immediate-mode WebGPU UI toolkit extracted from the `union` editor runtime.

It bundles the pieces needed to build a browser-native editor UI on top of WebGPU:

- **`ui_renderer`** — a batched WebGPU renderer for rectangles, rounded rects, SDF text (Inter atlas), images, and the HSV color picker panels.
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

The renderer loads its font atlas (`assets/Inter.{json,png}`) and shader (`assets/ui.wgsl`)
via Vite `?url` imports, so consumers are expected to build with Vite (or an equivalent
bundler that understands the `?url` suffix).

## Peer dependencies

- [`@webgpu/types`](https://www.npmjs.com/package/@webgpu/types) for `GPU*` typings.
