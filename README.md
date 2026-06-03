# @liamlangli/ui

Immediate-mode WebGPU UI toolkit extracted from the `union` editor runtime.

It bundles the pieces needed to build a browser-native editor UI on top of WebGPU:

- **`ui_renderer`** — a batched WebGPU renderer for rectangles, rounded rects, SDF text (Lato main text and jb_mono monospace text in a shared atlas, PingFang SC for Chinese text), images, and the HSV color picker panels.
- **`ui_widgets`** — an immediate-mode widget layer (buttons, toggles, sliders, dropdowns, text/number inputs, color pickers, scroll regions, menus) drawn through `ui_renderer`.
- **`dock`** — a docking layout engine: split/leaf trees, tab drag-and-drop, drop targets, and (de)serialization.
- **`theme`** — palette/CSS-variable theming with `load_theme`, `apply_theme`, `theme_color`, `theme_rgba`, `pack_color`, and `hex_to_normalized_rgba`.
- **`plugins`** — opt-in, higher-level drop-in components (`dock_system`, `file_browser`, `im_dialog`, `code_editor`) packaged so other projects can reuse them piecemeal. See [Plugins](#plugins).

## Live preview

An interactive playground lives in [`preview/`](preview) and is wired up with
Vite. It boots the renderer and lays the whole demo out inside the `dock_system`
plugin (Explorer, an Editor, Widgets gallery, Console, About, and a Chat panel)
— every pixel is drawn on the GPU.

```bash
npm install
npm run dev      # local dev server
npm run build    # production build → dist/ (GitHub Pages base = /ui/)
```

> Requires a WebGPU-capable browser (recent Chrome/Edge, or Safari Technology
> Preview). The page shows a graceful fallback otherwise.

### GitHub Pages

`.github/workflows/deploy-pages.yml` builds the preview and deploys it to GitHub
Pages on every push to `main` (or via *Run workflow*). Once enabled
(**Settings → Pages → Source: GitHub Actions**) the demo is served at
`https://liamlangli.github.io/ui/`. The Pages sub-path is injected at build time
via the `BASE_PATH` env var, so forks deploy under their own repo name
automatically.

## Plugins

Import individual plugins from the `@liamlangli/ui/plugins` sub-path (or the
package root). Each is a self-contained immediate-mode component: it owns its
drawing and input handling and takes your `ui_renderer` (+ `ui_widgets` where
needed), a `theme_definition`, and the per-frame `ui_input_snapshot`.

```ts
import { code_editor, dock_system, file_browser, im_dialog } from '@liamlangli/ui/plugins'
```

### `dock_system` — docking workspace

The core `dock` module is pure layout math; `dock_system` is the rendering +
input glue around it. It draws tab bars, splitters, the drag ghost and drop
overlay, drives tab activation / drag-to-reorder / drag-to-split / splitter
resize, and hands each visible panel body back to you to fill.

```ts
const dock = new dock_system() // or new dock_system(my_saved_layout)

// each frame, between renderer.begin_frame() and renderer.flush():
dock.frame(renderer, theme, input, x, y, w, h, (panel) => {
  // panel.{x,y,w,h} is the clipped body rect (physical px)
  if (panel.tab.id === 'files') file_browser(renderer, theme, input, panel.x, panel.y, panel.w, panel.h, tree, fb_state)
})

dock.add_tab({ id: 'log', title: 'Log' }) // spawn/focus a tab
const saved = serialize_dock_layout(dock.layout)
```

### `file_browser` — tree view

A scrollable, expandable file/folder tree. You own the `file_node[]` forest and
the persistent state; it reports selection / activation (double-click or Enter) /
expand-toggle.

```ts
const fb = create_file_browser_state()
const tree: file_node[] = [{ name: 'src', kind: 'dir', children: [{ name: 'index.ts' }] }]

const ev = file_browser(renderer, theme, input, x, y, w, h, tree, fb, { default_expanded: true })
if (ev.activated) open_file(ev.activated.name)
```

### `im_dialog` — IM chat panel

A chat surface with incoming/outgoing bubbles, avatars, author + timestamp
captions, auto-scroll-to-newest, and an optional composer (text input + Send).
It returns submitted text so you can append it to your own message array.

```ts
const chat = create_im_dialog_state()
const messages: im_message[] = [
  { author: 'Ada', side: 'left', text: 'Hi!', timestamp: Date.now() },
]

// widgets.begin_frame() must have run this frame (im_dialog uses the composer):
const ev = im_dialog(renderer, widgets, theme, input, x, y, w, h, messages, chat, {
  title: 'Ada · online',
  placeholder: 'Message Ada…',
  is_typing: adaIsTyping,
  typing_author: 'Ada',
})
if (ev.sent) messages.push({ author: 'Me', side: 'right', text: ev.sent, timestamp: Date.now() })
```

CJK works once the Chinese atlas has loaded (see [Chinese font loading](#chinese-font-loading)).

### `code_editor` — editable code surface

A GPU-rendered, editable code editor: a line-number gutter, selection
highlight, blinking caret, mouse selection (click / drag / double-click word /
triple-click line) and full keyboard editing (typing, Backspace/Delete, Enter
with auto-indent, Tab→spaces, arrows, Home/End, PageUp/PageDown, Ctrl/Cmd+A,
Ctrl/Cmd+C). You own the text model (`text_buffer`) and the view state
(`code_editor_state`).

Syntax highlighting is **pluggable and language-agnostic**: pass a per-line
`tokenize` function returning `{ kind, text }` tokens — the toolkit ships a
neutral default palette and never bakes in a language. Wire a real tokenizer
(regex, a language server, a WASM lexer, …) from the host.

```ts
import { code_editor, create_code_editor_state, text_buffer } from '@liamlangli/ui/plugins'
import type { editor_token } from '@liamlangli/ui/plugins'

const buf = new text_buffer('fn main() {}')
const ed = create_code_editor_state()

function my_tokenize(line: string): editor_token[] {
  // → [{ kind: 'keyword', text: 'fn' }, { kind: 'whitespace', text: ' ' }, …]
}

// each frame, between renderer.begin_frame() and renderer.flush():
const ev = code_editor(renderer, theme, input, x, y, w, h, buf, ed, {
  tokenize: my_tokenize,           // omit for plain (unhighlighted) text
  // token_colors: { keyword: '#c678dd' }, read_only, font_px, tab_size, highlights, …
})
if (ev.changed) recompile(buf.get_text())
```

The host forwards the same `ui_input_snapshot` the other plugins use; typed
characters arrive on `typed_text` and editing/navigation keys on the
`key_*` / `ctrl` / `meta` / `shift` flags (see [Text view](#text-view-selectable--copyable-console)
for the full list). Token `kind`s are `keyword`, `type`, `number`, `string`,
`comment`, `operator`, `identifier`, `punctuation`, `function`, `whitespace`,
`plain`.

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
