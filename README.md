# @liamlangli/ui

Immediate-mode WebGPU UI toolkit extracted from the `union` editor runtime.

It bundles the pieces needed to build a browser-native editor UI on top of WebGPU:

- **`ui_renderer`** — a batched WebGPU renderer for rectangles, rounded rects, SDF text (Lato main text and jb_mono monospace text in a shared atlas, PingFang SC for Chinese text), images, and the HSV color picker panels.
- **`ui_widgets`** — an immediate-mode widget layer (buttons, toggles, sliders, dropdowns, text/number inputs, color pickers, scroll regions, menus) drawn through `ui_renderer`.
- **`ui_icon`** — a set of vector icons (file, folder, folder_open, chevrons, search, settings, …) composed from `ui_renderer` draw commands and baked once into a single cached 512² atlas texture (32² per cell), then drawn tinted to any colour. See [Icons](#icons).
- **`dock`** — a docking layout engine: split/leaf trees, tab drag-and-drop, drop targets, and (de)serialization.
- **`dock_system` / `window_system`** — ready-to-use workspace systems built on `dock`/`window`: a docked split workspace and a floating desktop-style window manager, both part of core so third-party projects can build directly on them. See [Workspace systems](#workspace-systems).
- **`theme`** — palette/CSS-variable theming with `load_theme`, `apply_theme`, `theme_color`, `theme_rgba`, `pack_color`, and `hex_to_normalized_rgba`.
- **`app_registry`** — installable apps described by a JSON manifest: install/uninstall, persistence, and update checks against each app's `shipping_path`. See [`dashboard`](#dashboard--full-screen-app-launcher).
- **`plugins`** — opt-in, higher-level drop-in components (`file_browser`, `graph`, `node_graph`, `im_dialog`, `code_editor`, `dashboard`, `avatar_generator`, `material_audit`, `webtix` WebGPU path tracer) packaged so other projects can reuse them piecemeal. See [Plugins](#plugins).

## Live preview

An interactive playground lives in [`preview/`](preview) and is wired up with
Vite. It boots the renderer and lays the whole demo out as a desktop driven by
the core `window_system`: the docked workspace (Explorer, Editor, Console,
Metrics) is a single "Demo Editor" app window powered by `dock_system`, and the
other views (Widgets gallery, Icons, Graph, Node Graph, About, Chat) float as
their own windows — every pixel is drawn on the GPU.

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

## Workspace systems

`dock_system` and `window_system` are part of the core package: they are the
two ready-to-use workspace shells third-party apps are expected to build on.
Each is a self-contained immediate-mode component: it owns its drawing and
input handling and takes your `ui_renderer`, a `theme_definition`, and the
per-frame `ui_input_snapshot`.

```ts
import { dock_system, window_system } from '@liamlangli/ui'
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

### `window_system` — floating window workspace

The sibling of `dock_system`, for a desktop-style "window mode". The core
`window` module is pure layout state; `window_system` is the rendering + input
glue. Each view floats in its own frame with a header bar (title plus
minimize / maximize / close buttons), drag-to-move, drag-to-resize from any
edge or corner, and click-to-focus z-ordering. A rounded taskbar pinned to the
bottom lists the running views and shows a live clock; clicking a chip focuses,
restores or minimizes its window. The body callback hands back the same `panel`
shape as `dock_system`, so one render switch can drive both — let the user flip
between dock mode and window mode.

```ts
const windows = new window_system() // or new window_system(my_saved_layout)

// each frame, between renderer.begin_frame() and renderer.flush():
windows.frame(renderer, theme, input, x, y, w, h, (panel) => {
  // panel.{x,y,w,h} is the clipped body rect (physical px) — identical to dock_system
  if (panel.tab.id === 'files') file_browser(renderer, theme, input, panel.x, panel.y, panel.w, panel.h, tree, fb_state)
})

windows.add_window('log', 'Log') // spawn/focus a window
const saved = serialize_window_layout(windows.layout)
```

By default (`cache_bodies: true`) only the focused window renders its body live
each frame; inactive windows have their geometry cached and replayed (see
[Retained layers](#retained-layers--cached-panels)), so a workspace full of
windows costs roughly one live panel plus cheap buffer copies. Call
`windows.invalidate(id)` when an inactive window's content changes (the preview
does this for the Chat window when a message arrives).

## Plugins

Import individual plugins from the `@liamlangli/ui/plugins` sub-path (or the
package root). Each is a self-contained immediate-mode component: it owns its
drawing and input handling and takes your `ui_renderer` (+ `ui_widgets` where
needed), a `theme_definition`, and the per-frame `ui_input_snapshot`.

```ts
import { code_editor, dashboard, file_browser, graph_canvas, node_graph, im_dialog } from '@liamlangli/ui/plugins'
```

For the fastest first paint, import the core toolkit from `@liamlangli/ui/core`
(everything except the plugins) and pull the plugins in behind a dynamic
`import('@liamlangli/ui/plugins')` once the first frame is on screen. The
preview's `ui_main.ts` does exactly this: the window-system desktop renders
immediately with "Loading…" panel bodies, then swaps them live when the plugin
chunk arrives.

### `file_browser` — tree + project browser

A scrollable, expandable file/folder tree. You own the `file_node[]` forest and
the persistent state; it reports selection / activation (double-click or Enter) /
expand-toggle.

```ts
const fb = create_file_browser_state()
const tree: file_node[] = [{ name: 'src', kind: 'dir', children: [{ name: 'index.ts' }] }]

const ev = file_browser(renderer, theme, input, x, y, w, h, tree, fb, { default_expanded: true })
if (ev.activated) open_file(ev.activated.name)
```

The same `file_browser` function also supports the richer content-browser
pattern: a collapsible folder tree, breadcrumb, file search, list/grid modes,
host toolbar buttons, context-menu intents, and preview extension hooks. You own
the folder forest, current-folder entries, optional global search entries, and
each thumbnail via `render_preview`. Projects such as Union keep 3D image/model
preview rendering in their own code and hook it in through that callback.

```ts
const fb = create_file_browser_state('Project')
const folders: file_browser_folder_node[] = [{ path: 'Project', name: 'Project', children: [{ path: 'Project/Textures', name: 'Textures' }] }]
const entries: file_browser_entry[] = [{ path: 'Project/Textures/brick.png', name: 'brick.png', kind: 'file', type_label: 'TEXTURE' }]

const ev = file_browser(renderer, theme, input, x, y, w, h, folders, entries, fb, {
  toolbar: [{ id: 'create', label: 'Create Asset' }, { id: 'import', label: 'Import' }],
  render_preview: (entry, px, py, pw, ph) => draw_thumbnail(entry, px, py, pw, ph),
})
if (ev.folder_selected) load_folder(ev.folder_selected)
if (ev.entry_activated) open_asset(ev.entry_activated.path)
if (ev.toolbar_clicked === 'create') open_create_menu()
if (ev.context_requested) open_context_menu(ev.context_requested)
```

### `graph` — node-graph canvas

A generic, content-agnostic node editor surface: a pannable / zoomable grid,
nodes with typed input/output pins, bezier wires, a marquee selection box and a
floating link draft. It owns all interaction — left-drag a node to move it (or a
marquee on empty canvas to select; Shift extends), drag from an output pin to an
input pin to connect, middle-drag to pan, wheel to zoom, right-click for a create
menu. You own the `nodes`/`links` arrays and describe each node through a
`spec(node) → { title, inputs, outputs }`, so the same canvas drives a shader
graph, render graph, material graph, … The plugin mutates `node.x/.y` on drag and
pushes to `links` on connect; events are returned so you can react.

```ts
import { graph_canvas, create_graph_state } from '@liamlangli/ui/plugins'
import type { graph_node_view } from '@liamlangli/ui/plugins'

const gstate = create_graph_state()
const nodes = [
  { id: 1, x: 20, y: 30, type: 'UV' },
  { id: 2, x: 240, y: 40, type: 'Output' },
]
const links = [{ src_node: 1, src_pin: 0, dst_node: 2, dst_pin: 0 }]

function spec(node: (typeof nodes)[number]): graph_node_view {
  // → host maps its node model to a title + typed pins
  return node.type === 'UV'
    ? { title: 'UV', inputs: [], outputs: [{ label: 'UV', kind: 'uv' }] }
    : { title: 'Output', inputs: [{ label: 'Base Color', kind: 'color' }], outputs: [] }
}

// each frame, between renderer.begin_frame() and renderer.flush():
const ev = graph_canvas(renderer, theme, input, x, y, w, h, nodes, links, gstate, spec, {
  compatible: (out_kind, in_kind) => out_kind === in_kind,   // gate wire creation
  render_body: (node, view, body) => draw_inline_editor(node, body), // inline node content
})
if (ev.link_created) recompile()
if (ev.link_removed) recompile()                              // pin click or alt-click on a wire
if (ev.menu_requested) open_create_menu(ev.menu_requested)    // { screen_x, screen_y, graph_x, graph_y }
if (ev.delete_requested) remove_selected(gstate.selected)
```

Wires are cut two ways: click a pin to drop every wire on it, or hold Alt and
click a wire to cut just that one (a spatial grid finds the wire under the
cursor without testing every link). Pan and the create menu need the middle /
right mouse buttons forwarded on the `ui_input_snapshot` (`mouse_middle_down`,
`mouse_right_pressed`), and Alt-cut needs the `alt` modifier; selection,
node-drag, marquee, wire-drag and zoom work with the base left-button + wheel
fields alone.

### `node_graph` — dotted node editor with typed slots

A self-contained node editor with a pannable / zoomable **field of dots** for a
backdrop, nodes that carry typed input/output *slots*, bezier wires, a marquee
selection box and a built-in right-click "add node" menu. Every connection is
**type-gated**: a wire is only created when the output slot's `type` is
compatible with the input slot's `type` (`compatible` defaults to exact match),
so a `color` output won't drop onto a `vec3` input. Unlike `graph` (which keeps
node shape in a host `spec` callback over a line grid), `node_graph` stores
slots directly on the node, so *adding a node or a slot is a plain data
mutation* — use the `add_node` / `add_slot` helpers.

It owns all interaction — left-drag a node to move it (or a marquee on empty
canvas to select; Shift extends), drag from one slot to a compatible slot to
connect, middle-drag to pan, wheel to zoom, right-click for the create menu,
Delete/Backspace to remove the selection. You own the `nodes`/`connections`
arrays; events are returned so you can react.

```ts
import { node_graph, create_node_graph_state, add_node, add_slot } from '@liamlangli/ui/plugins'
import type { node_graph_node, node_graph_connection, node_graph_template } from '@liamlangli/ui/plugins'

const state = create_node_graph_state()
const nodes: node_graph_node[] = [
  add_node('Input', 20, 40, { id: 'in', outputs: [{ label: 'UV', type: 'vec2' }] }),
  add_node('Output', 240, 60, { id: 'out', inputs: [{ label: 'Albedo', type: 'color' }] }),
]
add_slot(nodes[1], true, { label: 'Normal', type: 'vec3' }) // append a typed slot in place
const connections: node_graph_connection[] = []

// templates populate the built-in right-click "add node" menu (omit to disable it):
const node_types: node_graph_template[] = [
  { type: 'Sample', inputs: [{ label: 'UV', type: 'vec2' }], outputs: [{ label: 'Color', type: 'color' }] },
]

// each frame, between renderer.begin_frame() and renderer.flush():
const ev = node_graph(renderer, theme, input, x, y, w, h, nodes, connections, state, {
  compatible: (out_type, in_type) => out_type === in_type, // gate wire creation by slot type
  node_types,
})
if (ev.connection_created) recompile()
if (ev.connection_rejected) flash_warning(ev.connection_rejected) // incompatible types
if (ev.node_created) console.log('spawned', ev.node_created.title)
if (ev.delete_requested) remove_selected(state.selected)
```

Pan and the create menu need the middle / right mouse buttons forwarded on the
`ui_input_snapshot` (`mouse_middle_down`, `mouse_right_pressed`); selection,
node-drag, marquee, wire-drag and zoom work with the base left-button + wheel
fields alone.

### `dashboard` — full-screen app launcher

A whole-screen launcher over the core **`app_registry`**: every installed app
appears as a grid tile (icon plate with the app name under it). Clicking a tile
launches the app, right-clicking opens a manage menu (Open / Check for Updates /
Update / Uninstall), and dragging an app *description JSON* onto the page
installs it. An app ships as a small manifest:

```json
{
  "id": "notes",
  "name": "Notes",
  "version": "2.1.0",
  "description": "A tiny scratchpad app.",
  "icon": "file_text",
  "accent": "#3d6b4f",
  "shipping_path": "apps/notes.json"
}
```

`shipping_path` is the URL the manifest is served from — the registry re-fetches
it to check for updates (per-segment numeric version compare), so publishing a
newer manifest at the same path is all a vendor needs to do to ship an update.
Tiles show a badge while an update is pending.

```ts
import { app_registry, serialize_app_registry } from '@liamlangli/ui'
import { dashboard, create_dashboard_state, dashboard_drop_target } from '@liamlangli/ui/plugins'

const registry = new app_registry(localStorage.getItem(KEY))
registry.on_change = () => localStorage.setItem(KEY, serialize_app_registry(registry))
registry.install({ id: 'editor', name: 'Editor', version: '1.0.0', icon: 'code' }, { builtin: true })

const dash = create_dashboard_state()
// drag-to-install: dropped .json files (or dragged manifest URLs) install into the registry
dashboard_drop_target(canvas, registry, dash, { on_installed: (app) => show_dashboard() })

// each frame, drawn last so it covers the whole screen:
const ev = dashboard(renderer, theme, input, 0, 0, screen_w, screen_h, registry.apps, dash, { icons })
if (ev.launched) open_app(ev.launched)
if (ev.uninstall_requested) registry.uninstall(ev.uninstall_requested.manifest.id)
if (ev.check_updates_requested) registry.check_update(ev.check_updates_requested.manifest.id)
if (ev.update_requested) registry.apply_update(ev.update_requested.manifest.id)
if (ev.dismissed) hide_dashboard()
```

Built-in apps (installed with `{ builtin: true }`) have no shipping path and
can't be uninstalled from the menu by default. The preview wires the whole flow
up under **View ▸ Apps ▸ Dashboard**; drag
[`public/apps/notes_v1.json`](public/apps/notes_v1.json) onto it to install an
app whose shipping path already serves a newer version, then right-click its
tile to update.

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

A GPU-rendered, editable code editor: an optional folder/file tree, a
line-number gutter, selection highlight, blinking caret, mouse selection (click
/ drag / double-click word / triple-click line) and full keyboard editing
(typing, Backspace/Delete, Enter with auto-indent, Tab→spaces, arrows,
Home/End, PageUp/PageDown, Ctrl/Cmd+A, Ctrl/Cmd+C). You own the text model
(`text_buffer`) and the view state (`code_editor_state`).

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
  file_tree: [{ name: 'src', kind: 'folder', children: [{ name: 'main.ts' }] }],
  // token_colors: { keyword: '#c678dd' }, read_only, font_px, tab_size, highlights, …
})
if (ev.changed) recompile(buf.get_text())
if (ev.tree_activated) open_file(ev.tree_activated)
```

The host forwards the same `ui_input_snapshot` the other plugins use; typed
characters arrive on `typed_text` and editing/navigation keys on the
`key_*` / `ctrl` / `meta` / `shift` flags (see [Text view](#text-view-selectable--copyable-console)
for the full list). Token `kind`s are `keyword`, `type`, `number`, `string`,
`comment`, `operator`, `identifier`, `punctuation`, `function`, `whitespace`,
`plain`.

### `avatar_generator` — procedural human mesh from a skeleton

A bones-first body generator with **no template mesh anywhere**: body
parameters place a parametric humanoid skeleton (joint positions + hierarchy,
down to per-finger and per-toe chains and breast anchor bones), lean anatomical
SDF volumes sweep every bone (rounded cones for limbs and digits, ellipsoids
for head/torso), a **muscle layer** grows the frame and lays named bellies over
it (deltoids, traps, pecs, biceps, quads, glutes, calves), a **fat layer** adds
the adipose masses (belly, love handles, glute pads, bust, chin) and swells
every soft part subcutaneously, the volumes fuse through a smooth union, and
surface nets polygonize the combined field into a triangle mesh with
SDF-gradient normals. Because a skeleton alone doesn't determine a body, the
muscle and fat passes run as explicit pipeline steps between the bone frame and
polygonization — each frame part annotates how strongly it responds to either
layer, so the same bones can carry a sprinter or a powerlifter.

The panel shows the result in a WebGPU orbit viewport (it reuses the asset-audit
viewer): sliders regenerate the mesh live (drafted at a coarse grid while
dragging, refined on release), presets cover common body types, an armature
overlay draws the generating skeleton, and Export writes a self-contained GLB
via the asset-audit encoder.

The skeleton is also directly editable in the viewport: a **Bones** overlay
draws a circle at every joint with lines along the bones, and dragging a circle
moves that joint (plus its whole subtree, forward-kinematics style) in the
camera plane — the mirrored side follows automatically and the body mesh
regenerates around the edited skeleton. Edits persist as per-joint offsets on
top of the parametric skeleton (`avatar_joint_offsets`), survive slider
changes, and reset from the sidebar.

```ts
import { avatar_generator, create_avatar_generator_state, generate_avatar } from '@liamlangli/ui/plugins'

const av = create_avatar_generator_state()

// each frame, between renderer.begin_frame() and renderer.flush():
const ev = avatar_generator(renderer, widgets, theme, input, x, y, w, h, av)
if (ev.exported_bytes) console.log(`wrote avatar.glb (${ev.exported_bytes} bytes)`)

// or run the pipeline headless — skeleton → frame → muscle → fat → mesh:
const { mesh, skeleton } = generate_avatar({ ...create_avatar_params(), muscle: 0.8 })
```

### `material_audit` — material / tiling inspector

Drop or upload a material's maps — a base color map and/or a tangent-space
normal map (dropped filenames route automatically: `*_normal*`, `*_nrm*`,
`*_n.*`, … land in the normal slot) — then validate them on three preview
shapes:

- **grid** — the maps tiled endlessly on a flat plane (repeat-addressed
  sampler), so seams, borders and periodic patterns stand out immediately; a
  loaded normal map lights the plane so bump seams show too. A *tile guides*
  toggle draws 1px lines on the tile boundaries.
- **sphere** — a UV sphere: pole pinching, UV stretch and normal-map shading.
- **cube** — a rounded cube: flat faces with beveled edges, the classic
  trim/material check. A *repeat* control tiles the UVs ×1/×2/×4/×8 on the 3D
  shapes.

The grid pans and zooms through the shared core `pan_zoom` module (drag with
the mouse or one finger, wheel or two-finger pinch); the 3D shapes orbit on
drag and dolly on wheel / pinch. A full mip chain is generated for every
upload, and in the default `auto` mode mip sampling is enabled while the
texture is minified (grid zoom < 100%, and always on the 3D shapes, which
perspective-minify) — force it `on` / `off` from the toolbar to compare the
shimmer. The status line reports both map slots, POT-ness, the current view
and the live mip decision.

```ts
import { material_audit, material_audit_dom_target, create_material_audit_state } from '@liamlangli/ui/plugins'

const ma = create_material_audit_state()
material_audit_dom_target(canvas, ma, { on_change: () => renderer.request_render() })

// each frame, between renderer.begin_frame() and renderer.flush():
const ev = material_audit(renderer, widgets, theme, input, x, y, w, h, ma)
if (ev.loaded) console.log(`${ev.loaded.slot} map: ${ev.loaded.name} (${ev.loaded.width}×${ev.loaded.height})`)
```

The wheel-zoom / two-finger pan + pinch handling lives in core as
`pan_zoom_apply` / `pan_zoom_drag` (`@liamlangli/ui` → `ui_pan_zoom`); the
`graph` and `node_graph` canvases run on the same module.

### `webtix` — WebGPU path tracer

The [`webtix`](https://github.com/liamlangli/webtix) path-tracing engine,
migrated into the toolkit as a plugin and **reimplemented from WebGL2 to
WebGPU**. The original ran the integrator in a GLSL fragment shader and read the
BVH + geometry out of RGB float *textures* addressed with `fract()`/`floor()`
math; this version walks a packed **storage-buffer BVH** (`array<bvh_node>`,
32 bytes/node, O(1) random access — no texel addressing) from a WGSL shader and
accumulates progressively into an rgba16float ping-pong, presenting a tonemapped
texture the panel composites with `draw_texture`.

It shares the host `GPUDevice` (no second WebGPU context), ships built-in
procedural scenes (sphere, torus, box, spheres + ground), an orbit viewport and
a live Disney-material sidebar (metallic / roughness / specular / transmission /
subsurface / clearcoat / IOR / base colour). It is a wavefront integrator: a
persistent per-pixel ray queue is advanced by a bounded number of single-bounce
compute runs per frame, so frame cost stays roughly constant regardless of the
bounce budget while the image refines progressively. It asks the adaptive
renderer to keep ticking until it hits the sample budget, then idles — any
camera, material or scene change restarts accumulation.

```ts
import { webtix, create_webtix_state } from '@liamlangli/ui/plugins'

const pt = create_webtix_state('sphere')

// each frame, between renderer.begin_frame() and renderer.flush():
webtix(renderer, widgets, theme, input, x, y, w, h, pt, { scale })
```

The TLAS builder, legacy BLAS builder and procedural geometry are also exported
standalone (`build_tlas`, `build_tlas_scene`, `build_bvh`, `build_scene`,
`make_sphere`, …) alongside the GPU engine (`webtix_tracer`), so a host can
trace mixed analytic/mesh scenes or keep using its own triangle mesh:

```ts
import { build_tlas, build_tlas_scene, webtix_tracer, default_material } from '@liamlangli/ui/plugins'

const scene = build_tlas(build_tlas_scene('spheres')) // analytic spheres + finite ground plane
const tracer = new webtix_tracer()
tracer.init(device)
tracer.set_tlas_scene(scene)
const texture = tracer.render_sample(w, h, { eye, target, fov, bounces: 5, material: default_material(), env_top, env_bottom, env_intensity: 1 })
```

`tracer.set_scene(build_bvh(positions, indices), positions, normals)` remains
available for existing mesh-only callers; it is adapted to a one-instance TLAS
internally.

## Usage

```ts
import { ui_renderer, ui_widgets, create_empty_ui_input, apply_theme } from '@liamlangli/ui'

const renderer = new ui_renderer(canvas)
await renderer.init()
const widgets = new ui_widgets(renderer)
```

The renderer loads its Latin/monospace font atlas (`assets/latin_mono.{json,webp}`),
Chinese font atlas (`assets/ping_fang_sc_regular.{json,webp}`), and shader
(`assets/ui.wgsl`) via Vite `?url` imports by default, so consumers are
expected to build with Vite (or an equivalent bundler that understands the
`?url` suffix). Font atlases can also be supplied as explicit URLs during
renderer initialization.

### Stack layout (vstack / hstack / zstack)

`ui_widgets` methods all take explicit `(x, y, w, h)` rects, which means panels
end up threading a manual `cy +=` cursor between every call. `stack_ui_layout`
is a thin facade over `ui_widgets` that removes that bookkeeping: pick an axis
(`vstack`, `hstack`, or `zstack`), then each widget call consumes the next slot
and forwards to the underlying widget. The preview's **Widgets** gallery is
built entirely this way.

```ts
import { create_stack_ui_layout } from '@liamlangli/ui'

const stack = create_stack_ui_layout(widgets) // create once, reuse each frame

// A vertical column of labelled sections + controls — no x/y cursor math.
stack.vstack(x, y, w, h, /* slot count */ 6, { gap: 12 })
stack.section(22, 'THEME')
const theme = stack.dropdown('theme', { w: 200, h: 28 }, theme_names, theme_index)
stack.section(22, 'VOLUME')
const volume = stack.slider('vol', { w: w - 60, h: 18 }, volume, 0, 1, true)

// Need a row inside the column? Pull one slot's rect and nest a second stack.
const row = stack.next_rect(30)
inner.hstack(row.x, row.y, row.w, row.h, 2, { gap: 12 })
if (inner.button('ok', { w: 120, h: 30 }, 'OK')) save()
inner.button('cancel', { w: 120, h: 30 }, 'Cancel')
```

A numeric `size` fills the cross axis (full width in a `vstack`, full height in
an `hstack`); pass `{ w, h }` for an explicitly sized slot. Alignment
(`STACK_ALIGN_*`), `reverse`, `gap`, and `padding` are all supported, and the
pure `layout_stack_into` / `layout_*stack_into` functions expose the same math
for callers that just want rects without the widget facade.

`padding` insets every child by the given amount on all four sides, and it is
applied regardless of alignment — alignment, gaps, and `STACK_FILL` are all
resolved inside the padded content box. Pass `STACK_FILL` (`-1`) for any width
or height to make that dimension stretch: on the cross axis it fills the padded
content extent, and on the main axis it absorbs the leftover space after
padding, gaps, and fixed-size siblings.

```ts
import { STACK_FILL } from '@liamlangli/ui'

// A toolbar row: fixed buttons on the ends, a search box that eats the middle.
// Reserving space around a main-axis fill needs the precomputed `sizes` buffer,
// so the layout can see every slot up front and split the remainder correctly.
const sizes = [80, STACK_FILL, STACK_FILL, STACK_FILL, 80, STACK_FILL] // [w, h] per slot
stack.hstack(x, y, w, h, 3, { gap: 8, padding: 12, sizes })
stack.button('back', undefined, 'Back')                       // 80 wide, full padded height
stack.input_field('q', undefined, query, 'Search…', state)    // fills the remaining width
stack.button('go', undefined, 'Go')                           // 80 wide

// Without a `sizes` buffer the streaming facade can't look ahead, so a
// main-axis STACK_FILL is greedy — it grabs all space from the cursor to the
// content edge. That's the right tool when the fill slot is the last one:
stack.hstack(x, y, w, h, 2, { gap: 8, padding: 12 })
stack.button('add', { w: 80, h: STACK_FILL }, 'Add')
stack.input_field('q', { w: STACK_FILL, h: 28 }, query, 'Search…', state) // eats the rest
```

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

#### Custom language font

To overwrite the default PingFang SC atlas with your own font, supply a
`language_font` source — a name plus the URLs of the font's JSON metrics
(BMFont-style `chars` table) and its atlas image. The URLs are fetched as-is,
so a bundler asset URL, an absolute path, or a remote URL all work:

```ts
import my_font_json from './my_font.json?url'
import my_font_image from './my_font.webp?url'

await renderer.init({
  language_font: { name: 'My Font', json: my_font_json, image: my_font_image },
})

// Or swap fonts after init (passing a source always forces a reload):
await renderer.load_chinese_font({ name: 'My Font', json: my_font_json, image: my_font_image })
```

#### Custom Latin/monospace font

To overwrite the default Lato/jb_mono atlas with your own Latin font bundle,
supply a `latin_font` source during initialization. Its JSON metrics document
must be a bundle with `FONT_MAIN` and `FONT_MONO` faces plus the atlas image
URL:

```ts
import my_latin_font_json from './my-latin-font.json?url'
import my_latin_font_image from './my-latin-font.webp?url'

await renderer.init({
  latin_font: {
    name: 'My Latin Font',
    json: my_latin_font_json,
    image: my_latin_font_image,
  },
})
```

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

### Atlas render target

The renderer keeps a single built-in **atlas** texture: a user-owned render
target you paint into yourself, then sample back as a first-class `'atlas'`
primitive. It gives the UI a scratch surface for content the immediate-mode
primitives can't express directly — custom-shaded output, a cached composite,
externally rendered imagery — while still flowing through the normal draw
pipeline (clip stack, command batching, tinting).

Allocate it at `init()` with `atlas`, or any time via `configure_atlas` (a
single number makes a square atlas; pass `{ width, height }` for a non-square
one). Paint into it with `render_to_atlas`, then blit the whole thing or a UV
sub-region into the frame:

```ts
await renderer.init({ atlas: { size: 1024, filter: 'linear' } })
// or, later / to resize: renderer.configure_atlas({ width: 800, height: 600 })

// paint into the atlas — the pixel→NDC mapping is rebased to the atlas size,
// so (0,0)..(atlas_width, atlas_height) covers it exactly. Pass a clear colour
// to wipe it first; omit it to composite over the existing contents.
renderer.render_to_atlas(() => {
  renderer.fill_round_rect(32, 32, 256, 128, 16, 0xff3366ff)
  renderer.draw_text(48, 64, 'baked into the atlas', 24, 0xffffffff)
}, { r: 0, g: 0, b: 0, a: 0 })

// draw it into the current frame as the dedicated 'atlas' primitive
renderer.draw_atlas(x, y, w, h)                                  // whole atlas
renderer.draw_atlas_region(x, y, w, h, 0, 0, 0.5, 0.5)          // top-left quadrant
```

`atlas_texture_id()` returns the texture id (usable anywhere a texture id is
accepted, e.g. `draw_texture`), and `atlas_size()` reports the current
dimensions (both are `-1` / `null` until the atlas is configured).

### Icons

`ui_icons` composes a set of vector icons from the renderer's own draw commands
(`stroke_line`, `stroke_round_rect`, `fill_triangle`, `fill_circle`, …) and bakes
them once into a single cached atlas texture — `512×512` by default, with each
icon occupying a `32×32` cell (so up to `16×16 = 256` icons share one texture).
Icons are baked white, so a draw call tints them to any colour for free:

```ts
const icons = new ui_icons(renderer)             // bake after renderer.init()
icons.draw('folder', x, y)                        // 32px, untinted
icons.draw('folder_open', x, y, 16, theme_rgba(theme, 'accent')) // 16px, tinted
```

Built-in names include `file`, `file_text`, `folder`, `folder_open`,
`chevron_right` / `chevron_down` / `chevron_up` / `chevron_left`, `plus`,
`minus`, `close`, `check`, `search`, `settings`, `trash`, `image`, `code`,
`star`, `circle`, `dot`, and `home` (see `ui_icon_name`). Pass
`{ atlas_size, cell_size }` to the constructor to change the cache geometry, and
call `bake()` to refresh the atlas (e.g. after a device reset). The bake is built
on the general-purpose `renderer.render_to_texture(target, w, h, draw)`, which
renders any UI draw commands into an offscreen texture.

### Retained layers (cached panels)

Immediate mode rebuilds every primitive each frame. For content that rarely
changes — the body of an unfocused window, an inactive dock panel — that work
is wasted. The renderer can capture a slice of geometry between `begin_layer()`
and `end_layer()` into a `ui_layer` (its raw vertex bytes plus the draw commands
that reference them), then `replay_layer()` it on later frames — optionally
translated — without re-running the code that produced it:

```ts
// first frame: record while the panel draws normally
renderer.begin_layer(x, y)
render_panel_body(x, y, w, h)            // text shaping, layout, …
const layer = renderer.end_layer()       // stash this

// later frames: skip the work, just replay the geometry
renderer.push_clip(x, y, w, h)
renderer.replay_layer(layer, x - layer.origin_x, y - layer.origin_y) // move-aware
renderer.pop_clip()
```

Commands are re-clipped against the live clip stack, so replaying inside a
`push_clip` confines the cached geometry. Invalidate (re-record) when the
content or the panel size changes. `window_system` uses this for inactive
windows out of the box; `dock_system` exposes the same behaviour behind its
`cache_bodies` option.

## Peer dependencies

- [`@webgpu/types`](https://www.npmjs.com/package/@webgpu/types) for `GPU*` typings.
