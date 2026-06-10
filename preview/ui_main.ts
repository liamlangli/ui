// @liamlangli/ui — interactive preview / playground.
//
// Boots the WebGPU renderer and lays the whole demo out as a desktop driven by
// the `window_system` plugin: every view floats in its own window. The old
// docked workspace (Explorer, Editor, Console, Metrics) is now just one app —
// "Demo Editor" — whose window body is a `dock_system`. The remaining views
// (Widgets, Icons, Graph, Node Graph, About, Chat) open as standalone windows.
// Everything is drawn on the GPU.

import {
  apply_theme,
  load_theme,
  lerp_theme,
  default_themes,
  ui_renderer,
  ui_widgets,
  ui_icons,
  hex_to_normalized_rgba,
  pack_color,
  create_text_view_state,
  create_stack_ui_layout,
  set_stack_layout_debug_wireframe,
  type stack_ui_layout,
  FONT_MONO,
  type theme_definition,
  type theme_preset,
  type dock_layout,
  type ui_color_rgba,
  type ui_input_text_state,
  type ui_renderer_stats,
  type ui_scroll_state,
  type ui_text_view_line,
  // plugins
  dock_system,
  window_system,
  type window_layout,
  type window_new_options,
  file_browser,
  create_file_browser_state,
  im_dialog,
  create_im_dialog_state,
  code_editor,
  create_code_editor_state,
  text_buffer,
  ui_main_menu,
  visit_dock_leaves,
  activate_dock_tab,
  graph_canvas,
  create_graph_state,
  node_graph,
  create_node_graph_state,
  add_node,
  type editor_token,
  type editor_token_kind,
  type file_node,
  type im_message,
  type ui_menu_node,
  type graph_node_base,
  type graph_node_view,
  type graph_link,
  type node_graph_node,
  type node_graph_connection,
  type node_graph_template,
  input_collector,
} from '../src/index'
import theme_url from './theme.json?url'

const canvas = document.getElementById('app') as HTMLCanvasElement

// The docked workspace that lives inside the "Demo Editor" app window.
function build_layout(): dock_layout {
  const leaf = (id: string, tabs: { id: string; title: string }[], active: string) =>
    ({ kind: 'leaf', id, tabs, active_tab_id: active, ox: 0, oy: 0, ow: 1, oh: 1 } as const)
  return {
    root: {
      kind: 'split',
      id: 'split-root',
      axis: 'horizontal',
      ratio: 0.24,
      left: leaf('leaf-files', [{ id: 'files', title: 'Explorer' }], 'files'),
      right: {
        kind: 'split',
        id: 'split-center',
        axis: 'vertical',
        ratio: 0.64,
        left: leaf('leaf-main', [{ id: 'editor', title: 'Editor' }], 'editor'),
        right: leaf('leaf-console', [
          { id: 'console', title: 'Console' },
          { id: 'metrics', title: 'Metrics' },
        ], 'console'),
      },
    },
    next_id: 100,
    last_active_leaf_id: 'leaf-main',
  }
}

const file_tree: file_node[] = [
  {
    name: 'src', kind: 'dir', children: [
      { name: 'index.ts' },
      { name: 'ui_renderer.ts' },
      { name: 'ui_widgets.ts' },
      { name: 'dock.ts' },
      { name: 'theme.ts' },
      {
        name: 'plugins', kind: 'dir', children: [
          { name: 'dock_system.ts' },
          { name: 'file_browser.ts' },
          { name: 'im_dialog.ts' },
          { name: 'index.ts' },
        ],
      },
    ],
  },
  {
    name: 'assets', kind: 'dir', children: [
      { name: 'latin_mono.webp', icon: '🖼️' },
      { name: 'ping_fang_sc_regular.webp', icon: '🖼️' },
      { name: 'ui.wgsl', icon: '⚙️' },
    ],
  },
  { name: 'README.md', icon: '📖' },
  { name: 'package.json', icon: '📦' },
]

const about_lines: ui_text_view_line[] = [
  { text: '@liamlangli/ui — immediate-mode WebGPU UI toolkit', color: '#e6e9ef' },
  { text: '' },
  { text: 'This page is rendered entirely on the GPU — every panel, tab,', color: '#9aa3b0' },
  { text: 'splitter, bubble and glyph is drawn through ui_renderer.', color: '#9aa3b0' },
  { text: '' },
  { text: 'Plugins on show:', color: '#4c8bf5' },
  { text: '  • window_system — every view floats in its own desktop window', color: '#9aa3b0' },
  { text: '  • dock_system   — the Demo Editor app: a docked workspace in a window', color: '#9aa3b0' },
  { text: '  • file_browser  — the Explorer panel inside Demo Editor', color: '#9aa3b0' },
  { text: '  • code_editor   — the Editor tab (type, select, syntax-highlight)', color: '#9aa3b0' },
  { text: '  • im_dialog     — the Chat window', color: '#9aa3b0' },
  { text: '' },
  { text: 'Try: drag windows around, then drag a tab inside Demo Editor to split.', color: '#5fb878' },
  { text: '试试中文：渲染器内置 PingFang SC 字形图集。', color: '#d8a24a' },
]

const console_lines: ui_text_view_line[] = [
  { text: '$ vite build', color: '#5fb878' },
  { text: 'vite v6.0.0 building for production...', color: '#9aa3b0' },
  { text: '✓ 42 modules transformed.', color: '#9aa3b0' },
  { text: 'dist/index.html                  0.51 kB', color: '#9aa3b0' },
  { text: 'dist/assets/index.js           128.4 kB │ gzip: 41.2 kB', color: '#9aa3b0' },
  { text: 'warning: WebGPU adapter prefers low-power mode', color: '#d8a24a' },
  { text: '✓ built in 1.84s', color: '#5fb878' },
  { text: 'This console is a GPU text_view — select & copy works.', color: '#4c8bf5' },
]

const chat_messages: im_message[] = [
  { author: 'Ada', side: 'left', text: 'Hey! Did the WebGPU renderer land?', timestamp: Date.now() - 1000 * 60 * 8 },
  { author: 'Me', side: 'right', text: 'Yep — batched rects, SDF text and images all in one pass.', timestamp: Date.now() - 1000 * 60 * 7 },
  { author: 'Ada', side: 'left', text: 'And the docking system?', timestamp: Date.now() - 1000 * 60 * 6 },
  { author: 'Me', side: 'right', text: 'Packaged as a plugin now. Drag a tab to split panels 👌', timestamp: Date.now() - 1000 * 60 * 5 },
  { author: 'Ada', side: 'left', text: '太棒了！中文也能渲染吗？', timestamp: Date.now() - 1000 * 60 * 4 },
  { author: 'Me', side: 'right', text: '当然，PingFang SC 图集异步加载即可。', timestamp: Date.now() - 1000 * 60 * 3 },
]

const auto_replies = [
  'Nice one 👍',
  'Got it, thanks!',
  '收到～',
  'That makes sense.',
  'Let me try that.',
]

// --- graph plugin demo ------------------------------------------------------
interface demo_graph_node extends graph_node_base {
  title: string
  inputs: { label: string; kind: string }[]
  outputs: { label: string; kind: string }[]
}
const graph_nodes: demo_graph_node[] = [
  { id: 1, x: 20, y: 30, title: 'UV', inputs: [], outputs: [{ label: 'UV', kind: 'uv' }] },
  { id: 2, x: 220, y: 20, title: 'Texture', inputs: [{ label: 'UV', kind: 'uv' }], outputs: [{ label: 'RGBA', kind: 'color' }] },
  { id: 3, x: 220, y: 200, title: 'Color', inputs: [], outputs: [{ label: 'RGB', kind: 'color' }] },
  { id: 4, x: 440, y: 110, title: 'Multiply', inputs: [{ label: 'A', kind: 'color' }, { label: 'B', kind: 'color' }], outputs: [{ label: 'Out', kind: 'color' }] },
  { id: 5, x: 660, y: 120, title: 'Output', inputs: [{ label: 'Base Color', kind: 'color' }, { label: 'Alpha', kind: 'float' }], outputs: [] },
]
const graph_links: graph_link[] = [
  { src_node: 1, src_pin: 0, dst_node: 2, dst_pin: 0 },
  { src_node: 2, src_pin: 0, dst_node: 4, dst_pin: 0 },
  { src_node: 3, src_pin: 0, dst_node: 4, dst_pin: 1 },
  { src_node: 4, src_pin: 0, dst_node: 5, dst_pin: 0 },
]
const graph_state_demo = create_graph_state()
const graph_view = (node: demo_graph_node): graph_node_view => ({ title: node.title, inputs: node.inputs, outputs: node.outputs })

// --- node_graph plugin demo (dotted backdrop + typed slots) ----------------
const node_graph_nodes: node_graph_node[] = [
  add_node('Input', 20, 40, { id: 'in', outputs: [{ label: 'Position', type: 'vec3' }, { label: 'UV', type: 'vec2' }] }),
  add_node('Sample', 240, 60, { id: 'tex', inputs: [{ label: 'UV', type: 'vec2' }], outputs: [{ label: 'Color', type: 'color' }] }),
  add_node('Tint', 240, 220, { id: 'tint', inputs: [{ label: 'A', type: 'color' }], outputs: [{ label: 'Out', type: 'color' }] }),
  add_node('Output', 470, 120, { id: 'out', inputs: [{ label: 'Albedo', type: 'color' }, { label: 'Normal', type: 'vec3' }] }),
]
const node_graph_connections: node_graph_connection[] = [
  { from_node: 'in', from_slot: 1, to_node: 'tex', to_slot: 0 },
  { from_node: 'tex', from_slot: 0, to_node: 'tint', to_slot: 0 },
  { from_node: 'tint', from_slot: 0, to_node: 'out', to_slot: 0 },
  { from_node: 'in', from_slot: 0, to_node: 'out', to_slot: 1 },
]
const node_graph_state = create_node_graph_state()
const node_graph_templates: node_graph_template[] = [
  { type: 'Input', outputs: [{ label: 'Position', type: 'vec3' }, { label: 'UV', type: 'vec2' }] },
  { type: 'Sample', inputs: [{ label: 'UV', type: 'vec2' }], outputs: [{ label: 'Color', type: 'color' }] },
  { type: 'Tint', inputs: [{ label: 'A', type: 'color' }], outputs: [{ label: 'Out', type: 'color' }] },
  { type: 'Output', inputs: [{ label: 'Albedo', type: 'color' }, { label: 'Normal', type: 'vec3' }] },
]

// The desktop: the Demo Editor app window (hosting the dock layout above)
// next to a floating Chat window. Other apps spawn from the View menu.
function build_window_layout(): window_layout {
  const win = (id: string, title: string, x: number, y: number, w: number, h: number, z: number) =>
    ({ id, title, x, y, w, h, z, minimized: false, maximized: false, restore_x: x, restore_y: y, restore_w: w, restore_h: h } as const)
  return {
    windows: [
      win('demo-editor', 'Demo Editor', 24, 16, 820, 540, 2),
      win('chat', 'Chat', 880, 48, 300, 400, 1),
    ],
    next_z: 3,
    focused_id: 'demo-editor',
  }
}

// --- Persistent widget / plugin state -------------------------------------
const dock = new dock_system(build_layout())
const windows = new window_system(build_window_layout())
// Baked once after the renderer initialises (see main()); drawn in the gallery.
let icon_set: ui_icons | null = null
// Set once the renderer is live (see main()); lets async helpers (console
// appends, deferred compiles) wake the adaptive renderer outside a frame.
let active_renderer: ui_renderer | null = null

// Views that live as dock tabs inside the Demo Editor app window. Everything
// else floats as its own window, so each view exists in exactly one place.
const EDITOR_VIEW_IDS = new Set(['files', 'editor', 'console', 'metrics'])

// Every view the top menu can spawn, with default geometry for window apps.
const VIEW_TABS: { id: string; title: string; win?: window_new_options }[] = [
  { id: 'demo-editor', title: 'Demo Editor', win: { x: 24, y: 16, w: 820, h: 540 } },
  { id: 'files', title: 'Explorer' },
  { id: 'editor', title: 'Editor' },
  { id: 'console', title: 'Console' },
  { id: 'metrics', title: 'Metrics' },
  { id: 'gallery', title: 'Widgets', win: { w: 420, h: 540 } },
  { id: 'icons', title: 'Icons', win: { w: 560, h: 420 } },
  { id: 'graph', title: 'Graph', win: { w: 640, h: 420 } },
  { id: 'node_graph', title: 'Node Graph', win: { w: 640, h: 420 } },
  { id: 'about', title: 'About', win: { w: 540, h: 340 } },
  { id: 'chat', title: 'Chat', win: { w: 300, h: 400 } },
]

// Spawn or focus the Demo Editor app window.
function open_demo_editor(): void {
  windows.add_window('demo-editor', 'Demo Editor', VIEW_TABS[0]!.win)
}

// Spawn a view — or just focus it if it already exists. Editor views open as
// dock tabs inside the Demo Editor window; everything else gets its own window.
function open_view_tab(id: string, title: string): void {
  if (!EDITOR_VIEW_IDS.has(id)) {
    windows.add_window(id, title, VIEW_TABS.find((t) => t.id === id)?.win)
    return
  }
  open_demo_editor()
  let found_leaf: string | null = null
  visit_dock_leaves(dock.layout.root, (leaf) => {
    if (!found_leaf && leaf.tabs.some((t) => t.id === id)) found_leaf = leaf.id
  })
  if (found_leaf) activate_dock_tab(dock.layout, found_leaf, id)
  else dock.add_tab({ id, title })
  windows.invalidate('demo-editor')
}

// The Theme sub-menu is rebuilt each frame (to reflect the live selection), so
// keep a reference to splice fresh children into.
const theme_menu: ui_menu_node = { label: 'Theme', children: [] }

const compile_ctrl = {
  auto_compile: true,
  debounce_ms: 650,
  timer: 0,
  sequence: 0,
  last_source_version: 0,
  status: 'Idle' as 'Idle' | 'Queued' | 'Compiling' | 'Built',
}

// Append a line to the Console view and keep it scrolled to the tail. Wakes the
// adaptive renderer so the update shows even when called outside a frame.
function append_console(text: string, color?: string): void {
  console_lines.push(color ? { text, color } : { text })
  console_state.scroll_to_line = console_lines.length - 1
  windows.invalidate('demo-editor') // the Console lives inside the Demo Editor window
  active_renderer?.request_render()
}

// Cancel any pending (debounced) compile and reset a queued status to idle.
function cancel_compile(): void {
  if (compile_ctrl.timer) {
    window.clearTimeout(compile_ctrl.timer)
    compile_ctrl.timer = 0
  }
  if (compile_ctrl.status === 'Queued') compile_ctrl.status = 'Idle'
}

// Debounced auto-compile: schedules a build after the editor goes quiet.
function schedule_compile(): void {
  if (!compile_ctrl.auto_compile) return
  cancel_compile()
  compile_ctrl.status = 'Queued'
  compile_ctrl.timer = window.setTimeout(() => {
    compile_ctrl.timer = 0
    run_compile()
  }, compile_ctrl.debounce_ms)
}

// Run a (simulated) build now. The demo has no real compiler, so this just
// reports progress to the Console and flips the status flag.
function run_compile(): void {
  cancel_compile()
  const seq = (compile_ctrl.sequence += 1)
  compile_ctrl.last_source_version = editor_buffer.version
  compile_ctrl.status = 'Compiling'
  append_console(`$ build #${seq} — compiling ${editor_buffer.get_text().length} bytes`, '#4c8bf5')
  window.setTimeout(() => {
    if (compile_ctrl.sequence !== seq) return // superseded by a newer build
    compile_ctrl.status = 'Built'
    append_console(`✓ build #${seq} done`, '#5fb878')
    active_renderer?.request_render()
  }, 220)
}

const main_menu = new ui_main_menu([
  {
    label: 'File',
    children: [
      { id: 'new-file', label: 'New File' },
      { id: 'open-file', label: 'Open File' },
      { id: 'save-file', label: 'Save' },
      { label: '', separator: true },
      { id: 'files', label: 'Explorer' },
    ],
  },
  {
    label: 'Edit',
    children: [
      { id: 'focus-editor', label: 'Focus Editor' },
      { id: 'select-all', label: 'Select All' },
    ],
  },
  {
    label: 'View',
    children: [
      {
        label: 'Workspace',
        children: [
          { id: 'demo-editor', label: 'Demo Editor' },
          { id: 'files', label: 'Explorer' },
          { id: 'editor', label: 'Editor' },
          { id: 'console', label: 'Console' },
          { id: 'metrics', label: 'Metrics' },
        ],
      },
      {
        label: 'Apps',
        children: [
          { id: 'graph', label: 'Graph' },
          { id: 'node_graph', label: 'Node Graph' },
          { id: 'gallery', label: 'Widgets' },
          { id: 'icons', label: 'Icons' },
          { id: 'chat', label: 'Chat' },
          { id: 'about', label: 'About' },
        ],
      },
      { label: '', separator: true },
      { id: 'open-all', label: 'Open all views' },
      { id: 'reset', label: 'Reset layout' },
    ],
  },
  {
    label: 'Run',
    children: [
      { id: 'compile-now', label: 'Compile Now' },
      { id: 'auto-compile', label: 'Auto Compile', checked: compile_ctrl.auto_compile },
    ],
  },
  theme_menu,
])

function handle_menu(node: ui_menu_node): void {
  const id = node.id
  if (!id) return
  if (id.startsWith('theme:')) {
    transition_theme_to(Number(id.slice('theme:'.length)), performance.now())
    return
  }
  if (id === 'open-all') {
    for (const tab of VIEW_TABS) open_view_tab(tab.id, tab.title)
    return
  }
  if (id === 'reset') {
    windows.layout = build_window_layout()
    dock.layout = build_layout()
    windows.invalidate()
    return
  }
  if (id === 'focus-editor') {
    open_view_tab('editor', 'Editor')
    editor_state.focused = true
    return
  }
  if (id === 'select-all') {
    open_view_tab('editor', 'Editor')
    editor_buffer.select_all()
    return
  }
  if (id === 'new-file') {
    open_view_tab('editor', 'Editor')
    editor_buffer.set_text('')
    schedule_compile()
    return
  }
  if (id === 'open-file') {
    open_view_tab('files', 'Explorer')
    append_console('open file: use the Explorer view', '#d8a24a')
    return
  }
  if (id === 'save-file') {
    append_console(`saved buffer (${editor_buffer.get_text().length} bytes)`, '#5fb878')
    return
  }
  if (id === 'compile-now') {
    run_compile()
    return
  }
  if (id === 'auto-compile') {
    compile_ctrl.auto_compile = !compile_ctrl.auto_compile
    if (compile_ctrl.auto_compile) schedule_compile()
    else cancel_compile()
    return
  }
  const tab = VIEW_TABS.find((t) => t.id === id)
  if (tab) open_view_tab(tab.id, tab.title)
}

const file_state = create_file_browser_state()
const chat_state = create_im_dialog_state()
let chat_is_typing = false
const console_state = create_text_view_state()
const about_state = create_text_view_state()

// --- code_editor demo -------------------------------------------------------
const editor_buffer = new text_buffer(
  [
    '// code_editor — a GPU-rendered editable text surface.',
    '// Click to place the caret, drag to select, type to edit.',
    '',
    'function fib(n: number): number {',
    '  if (n < 2) return n',
    '  return fib(n - 1) + fib(n - 2)',
    '}',
    '',
    'const seq = []',
    'for (let i = 0; i < 10; i++) {',
    '  seq.push(fib(i))',
    '}',
    'console.log(seq) // [0, 1, 1, 2, 3, 5, 8, ...]',
  ].join('\n'),
)
const editor_state = create_code_editor_state()

// A tiny, dependency-free tokenizer just to exercise the pluggable highlighting
// — real consumers pass their own (e.g. a language-server / WASM tokenizer).
const DEMO_KEYWORDS = new Set(['function', 'const', 'let', 'var', 'return', 'if', 'else', 'for', 'while', 'number', 'string', 'boolean'])
function demo_tokenize(line: string): editor_token[] {
  const out: editor_token[] = []
  const ci = line.indexOf('//')
  const code = ci >= 0 ? line.slice(0, ci) : line
  const re = /(\s+)|([A-Za-z_$][\w$]*)|(\d+(?:\.\d+)?)|("[^"]*"|'[^']*')|([(){}\[\].,;:])|([+\-*/<>=!&|%]+)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(code))) {
    let kind: editor_token_kind = 'plain'
    if (m[1]) kind = 'whitespace'
    else if (m[2]) kind = DEMO_KEYWORDS.has(m[2]) ? 'keyword' : 'identifier'
    else if (m[3]) kind = 'number'
    else if (m[4]) kind = 'string'
    else if (m[5]) kind = 'punctuation'
    else if (m[6]) kind = 'operator'
    out.push({ kind, text: m[0] })
  }
  if (ci >= 0) out.push({ kind: 'comment', text: line.slice(ci) })
  return out
}

const gallery = {
  toggle_a: true,
  toggle_b: false,
  slider: 0.4,
  dropdown: 1,
  input: '',
  input_state: { cursor: 0, sel_anchor: 0, sel_head: 0 } as ui_input_text_state,
  color: { r: 0.3, g: 0.55, b: 0.95, a: 1 } as ui_color_rgba,
  list_scroll: { offset_y: 0 } as ui_scroll_state,
  list_selected: 0,
  clicks: 0,
}

// Stack-layout facades over the gallery's widgets. The outer one stacks the
// labelled sections + controls vertically; the inner one lays the two-button
// row out horizontally. Both are created once the widgets exist (see below).
let gallery_col: stack_ui_layout | null = null
let gallery_row: stack_ui_layout | null = null

// --- icons gallery state ----------------------------------------------------
const ICON_SIZE_OPTIONS = [16, 24, 32, 48]
const icons_panel = {
  scroll: { offset_y: 0 } as ui_scroll_state,
  size_index: 1,
}

type metric_sample = {
  fps: number
  cpu_ms: number
  stats: ui_renderer_stats
}

const metrics = {
  samples: [] as metric_sample[],
  last_frame_start_ms: performance.now(),
}

// --- Theme switching with a linear cross-fade ------------------------------
const theme_ctrl = {
  presets: [] as theme_preset[],
  index: 0,
  from: null as theme_definition | null,
  to: null as theme_definition | null,
  start_ms: 0,
  duration_ms: 360,
  current: null as theme_definition | null,
  applied: null as theme_definition | null,
}

function init_themes(base: theme_preset): void {
  // The loaded JSON theme leads the list; the built-ins follow (skipping any
  // that share its name so we don't list the default twice).
  theme_ctrl.presets = [base, ...default_themes.filter((p) => p.name !== base.name)]
  theme_ctrl.from = base.theme
  theme_ctrl.to = base.theme
  theme_ctrl.current = base.theme
  theme_ctrl.index = 0
}

function transition_theme_to(index: number, now: number): void {
  const preset = theme_ctrl.presets[index]
  if (!preset || index === theme_ctrl.index) return
  // Start from whatever is on screen right now so mid-transition switches stay smooth.
  theme_ctrl.from = theme_ctrl.current ?? preset.theme
  theme_ctrl.to = preset.theme
  theme_ctrl.start_ms = now
  theme_ctrl.index = index
}

function tick_theme(now: number): theme_definition {
  const from = theme_ctrl.from!
  const to = theme_ctrl.to!
  const t = theme_ctrl.duration_ms <= 0 ? 1 : Math.min(1, (now - theme_ctrl.start_ms) / theme_ctrl.duration_ms)
  const current = lerp_theme(from, to, t)
  theme_ctrl.current = current
  // lerp_theme returns the `to` reference once settled, so identity tells us
  // when the palette actually changed — avoids re-applying CSS vars every frame.
  if (current !== theme_ctrl.applied) {
    apply_theme(current)
    document.body.style.background = current.palette.bg
    theme_ctrl.applied = current
  }
  return current
}

async function main(): Promise<void> {
  const renderer = new ui_renderer(canvas)
  await renderer.init()
  active_renderer = renderer
  compile_ctrl.last_source_version = editor_buffer.version
  const widgets = new ui_widgets(renderer)
  icon_set = new ui_icons(renderer)
  const loaded: theme_definition = await load_theme(theme_url)
  init_themes({ name: 'Midnight', theme: loaded })

  const input = new input_collector(canvas, () => renderer.request_render())
  const resize = () => renderer.resize()
  window.addEventListener('resize', resize)

  function frame(): void {
    const frame_start_ms = performance.now()
    const frame_delta_ms = frame_start_ms - metrics.last_frame_start_ms
    metrics.last_frame_start_ms = frame_start_ms
    const snapshot = input.begin_frame()
    const safe = renderer.safe_rect()
    const scale = window.devicePixelRatio || 1
    const m = 8 * scale

    const theme = tick_theme(frame_start_ms)
    const clear = hex_to_normalized_rgba(theme.palette.bg)
    // While a cross-fade is in flight the palette changes every frame, so keep
    // waking the (adaptive) renderer until it settles — `lerp_theme` returns the
    // `to` reference once finished, which we detect by identity.
    if (theme !== theme_ctrl.to) renderer.request_render()

    renderer.begin_frame()
    widgets.begin_frame(theme, snapshot)

    // Top menu bar reserves a strip; the window desktop fills the area below it.
    const menu_h = 30 * scale
    const bar_x = safe.x + m
    const bar_y = safe.y + m
    const bar_w = safe.w - m * 2
    const dock_y = bar_y + menu_h + m
    const dock_h = safe.y + safe.h - m - dock_y

    // When a dropdown is open over the dock, swallow the click so the panel
    // underneath doesn't also react to it.
    const block = main_menu.blocks_point(snapshot.mouse_x, snapshot.mouse_y)
    const dock_input = block ? { ...snapshot, mouse_pressed: false, mouse_down: false, mouse_released: false, wheel_y: 0 } : snapshot

    const render_panel = (panel: { x: number; y: number; w: number; h: number; tab: { id: string } }) => {
      const inset = 0
      const px = panel.x + inset
      const py = panel.y + inset
      const pw = panel.w - inset * 2
      const ph = panel.h - inset * 2
      switch (panel.tab.id) {
        case 'demo-editor':
          // The Demo Editor app: its window body is a whole docked workspace.
          dock.frame(renderer, theme, dock_input, px, py, pw, ph, render_panel)
          break
        case 'files':
          render_files(renderer, widgets, theme, snapshot, px, py, pw, ph)
          break
        case 'editor':
          code_editor(renderer, theme, snapshot, px, py, pw, ph, editor_buffer, editor_state, {
            tokenize: demo_tokenize,
            file_tree,
          })
          break
        case 'gallery':
          render_gallery(renderer, widgets, theme, px, py, pw, ph, scale)
          break
        case 'icons':
          render_icons(renderer, widgets, theme, snapshot, px, py, pw, ph, scale)
          break
        case 'about':
          widgets.text_view('about_view', px + 8 * scale, py + 8 * scale, pw - 16 * scale, ph - 16 * scale, about_lines, about_state, { wrap: true, background: false, read_only: true })
          break
        case 'console':
          widgets.text_view('console_view', px + 6 * scale, py + 6 * scale, pw - 12 * scale, ph - 12 * scale, console_lines, console_state, { wrap: true })
          break
        case 'metrics':
          render_metrics(renderer, theme, px, py, pw, ph, scale)
          break
        case 'graph':
          graph_canvas(renderer, theme, snapshot, px, py, pw, ph, graph_nodes, graph_links, graph_state_demo, graph_view, {
            compatible: (a, b) => a === b || a === 'color' || b === 'color',
          })
          break
        case 'node_graph': {
          const ng = node_graph(renderer, theme, snapshot, px, py, pw, ph, node_graph_nodes, node_graph_connections, node_graph_state, {
            compatible: (a, b) => a === b,
            node_types: node_graph_templates,
          })
          if (ng.delete_requested) {
            for (let i = node_graph_connections.length - 1; i >= 0; i -= 1) {
              const c = node_graph_connections[i]
              if (node_graph_state.selected.has(c.from_node) || node_graph_state.selected.has(c.to_node)) node_graph_connections.splice(i, 1)
            }
            for (let i = node_graph_nodes.length - 1; i >= 0; i -= 1) {
              if (node_graph_state.selected.has(node_graph_nodes[i].id)) node_graph_nodes.splice(i, 1)
            }
            node_graph_state.selected.clear()
          }
          break
        }
        case 'chat':
          render_chat(renderer, widgets, theme, snapshot, px, py, pw, ph)
          break
      }
    }

    // The window system is the workspace; the Demo Editor window nests the dock.
    windows.frame(renderer, theme, dock_input, bar_x, dock_y, bar_w, dock_h, render_panel)

    // Auto-compile: when the editor buffer changes, (re)arm the debounced build.
    if (compile_ctrl.auto_compile && editor_buffer.version !== compile_ctrl.last_source_version) {
      compile_ctrl.last_source_version = editor_buffer.version
      schedule_compile()
    }

    // Refresh the Theme sub-menu against the live selection, then draw the menu
    // bar on top of the dock so its dropdowns overlay the panels below.
    theme_menu.children = theme_ctrl.presets.map((preset, i) => ({ id: `theme:${i}`, label: preset.name, checked: i === theme_ctrl.index }))
    const menu_event = main_menu.frame(renderer, theme, snapshot, bar_x, bar_y, bar_w, menu_h)
    if (menu_event.activated) handle_menu(menu_event.activated)

    widgets.end_frame()
    renderer.flush(clear)
    record_metric_sample(frame_delta_ms > 0 ? 1000 / frame_delta_ms : 0, performance.now() - frame_start_ms, renderer.renderer_stats())
    input.end_frame()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

function render_files(
  renderer: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  snapshot: ReturnType<input_collector['begin_frame']>,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const ev = file_browser(renderer, theme, snapshot, x, y, w, h, file_tree, file_state, {
    default_expanded: true,
    view_mode: 'grid',
    view_toggle: false,
    widgets,
  })
  if (ev.activated || ev.entry_activated) {
    const name = ev.entry_activated?.name ?? ev.activated?.name
    append_console(`→ opened ${name}`, '#4c8bf5')
  }
}

function render_chat(
  renderer: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  snapshot: ReturnType<input_collector['begin_frame']>,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const ev = im_dialog(renderer, widgets, theme, snapshot, x, y, w, h, chat_messages, chat_state, {
    title: 'Ada · online',
    placeholder: 'Message Ada…',
    is_typing: chat_is_typing,
    typing_author: 'Ada',
  })
  if (ev.sent) {
    chat_messages.push({ author: 'Me', side: 'right', text: ev.sent, timestamp: Date.now() })
    chat_is_typing = true
    windows.invalidate('chat') // refresh the Chat window even if it's inactive
    renderer.request_render()
    const reply = auto_replies[Math.floor(Math.random() * auto_replies.length)]
    window.setTimeout(() => {
      chat_is_typing = false
      chat_messages.push({ author: 'Ada', side: 'left', text: reply, timestamp: Date.now() })
      windows.invalidate('chat')
      renderer.request_render()
    }, 600 + Math.random() * 700)
  }
}

function render_gallery(
  renderer: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
): void {
  const pad = 16 * scale
  const col_w = Math.min(360 * scale, w - pad * 2)
  const cx = x + pad
  const sec = 22 * scale // section row height
  const ctrl = 28 * scale // control row height
  set_stack_layout_debug_wireframe(gallery.toggle_b)

  // A single vertical stack drives the whole panel: each section label and its
  // control is just the next slot, so there is no x/y cursor bookkeeping here.
  const stack = (gallery_col ??= create_stack_ui_layout(widgets))
  stack.vstack(cx, y + pad, col_w, h - pad * 2, 15, { gap: 12 * scale })

  stack.section(sec, 'THEME')
  const theme_names = theme_ctrl.presets.map((p) => p.name)
  const picked = stack.dropdown('g_theme', { w: 200 * scale, h: ctrl }, theme_names, theme_ctrl.index)
  if (picked !== theme_ctrl.index) transition_theme_to(picked, performance.now())

  stack.section(sec, 'BUTTONS')
  // Two buttons share one row — lay them out with a nested horizontal stack.
  const btn_row = stack.next_rect(30 * scale)
  const row = (gallery_row ??= create_stack_ui_layout(widgets))
  row.hstack(btn_row.x, btn_row.y, btn_row.w, btn_row.h, 2, { gap: 12 * scale })
  if (row.button('g_btn', { w: 120 * scale, h: 30 * scale }, `Clicked ${gallery.clicks}×`)) gallery.clicks += 1
  row.button('g_btn2', { w: 120 * scale, h: 30 * scale }, 'Secondary', { active: gallery.clicks % 2 === 1 })

  stack.section(sec, 'TOGGLES')
  gallery.toggle_a = stack.toggle('g_tg_a', 20 * scale, gallery.toggle_a, 'Enable shadows')
  gallery.toggle_b = stack.toggle('g_tg_b', 20 * scale, gallery.toggle_b, 'Wireframe overlay')
  set_stack_layout_debug_wireframe(gallery.toggle_b)

  stack.section(sec, 'SLIDER')
  gallery.slider = stack.slider('g_sl', { w: col_w - 60 * scale, h: 18 * scale }, gallery.slider, 0, 1, true)

  stack.section(sec, 'DROPDOWN')
  gallery.dropdown = stack.dropdown('g_dd', { w: 180 * scale, h: ctrl }, ['Low', 'Medium', 'High', 'Ultra'], gallery.dropdown)

  stack.section(sec, 'TEXT INPUT')
  gallery.input = stack.input_field('g_in', { w: col_w, h: 30 * scale }, gallery.input, 'Type something…', gallery.input_state)

  stack.section(sec, 'COLOR')
  gallery.color = stack.ui_color_picker('g_col', { w: 180 * scale, h: ctrl }, gallery.color)
}

function render_icons(
  renderer: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  snapshot: ReturnType<input_collector['begin_frame']>,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
): void {
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const pad = 16 * scale

  renderer.fill_rect(x, y, w, h, slot('panel'))
  if (!icon_set) {
    renderer.draw_text(x + pad, y + pad, 'Baking icon atlas…', 12 * scale, slot('text_dim'))
    return
  }
  const names = icon_set.names()

  // Header: title + a size picker. The atlas is baked once; only the draw size
  // changes here (the cached texture is sampled at whatever size you ask for).
  renderer.draw_text(x + pad, y + 12 * scale, `Built-in icons · ${names.length}`, 13 * scale, slot('text'))
  renderer.draw_text(x + pad, y + 30 * scale, 'Composed from ui_renderer draw commands, cached in one 512² atlas (32² cells).', 10.5 * scale, slot('text_dim'))
  const dd_w = 96 * scale
  const dd_h = 26 * scale
  const dd_x = x + w - pad - dd_w
  const dd_y = y + 12 * scale
  icons_panel.size_index = widgets.dropdown(
    'icons_size',
    dd_x,
    dd_y,
    dd_w,
    dd_h,
    ICON_SIZE_OPTIONS.map((s) => `${s} px`),
    icons_panel.size_index,
  )
  const icon_px = (ICON_SIZE_OPTIONS[icons_panel.size_index] ?? 24) * scale

  // Grid viewport (scrollable).
  const grid_x = x + pad
  const grid_y = y + 52 * scale
  const grid_w = Math.max(1, w - pad * 2)
  const grid_h = Math.max(1, y + h - pad - grid_y)

  const gap = 10 * scale
  const tile_w = Math.max(80 * scale, icon_px + 34 * scale)
  const tile_h = icon_px + 36 * scale
  const columns = Math.max(1, Math.floor((grid_w + gap) / (tile_w + gap)))
  const rows = Math.ceil(names.length / columns)
  const content_h = rows * (tile_h + gap)

  widgets.handle_scroll_area(grid_x, grid_y, grid_w, grid_h, icons_panel.scroll, content_h)
  const max_off = Math.max(0, content_h - grid_h)
  icons_panel.scroll.offset_y = Math.max(0, Math.min(max_off, icons_panel.scroll.offset_y))

  renderer.push_clip(grid_x, grid_y, grid_w, grid_h)
  const label_font = 9.5 * scale
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i]
    if (!name) continue
    const col = i % columns
    const rowi = Math.floor(i / columns)
    const tile_x = grid_x + col * (tile_w + gap)
    const tile_y = grid_y + rowi * (tile_h + gap) - icons_panel.scroll.offset_y
    if (tile_y + tile_h < grid_y || tile_y > grid_y + grid_h) continue // cull off-screen rows

    const hover =
      snapshot.mouse_x >= tile_x &&
      snapshot.mouse_x < tile_x + tile_w &&
      snapshot.mouse_y >= Math.max(grid_y, tile_y) &&
      snapshot.mouse_y < Math.min(grid_y + grid_h, tile_y + tile_h)

    renderer.fill_round_rect(tile_x, tile_y, tile_w, tile_h, 6 * scale, hover ? slot('hover') : slot('panel_alt'))
    renderer.stroke_round_rect(tile_x, tile_y, tile_w, tile_h, 6 * scale, 1, slot('border'))

    const ix = tile_x + (tile_w - icon_px) * 0.5
    const iy = tile_y + 11 * scale
    icon_set.draw(name, ix, iy, icon_px, hover ? slot('accent') : slot('text'))

    const label_w = renderer.text_width(name, label_font, FONT_MONO)
    const label_x = tile_x + Math.max(4 * scale, (tile_w - label_w) * 0.5)
    renderer.push_clip(tile_x + 3 * scale, tile_y, tile_w - 6 * scale, tile_h)
    renderer.draw_text(label_x, tile_y + tile_h - 16 * scale, name, label_font, hover ? slot('text') : slot('text_dim'), FONT_MONO)
    renderer.pop_clip()
  }
  renderer.pop_clip()

  if (content_h > grid_h) {
    const sb_w = 7 * scale
    widgets.scrollbar('icons_sb', grid_x + grid_w - sb_w, grid_y, sb_w, grid_h, icons_panel.scroll, content_h)
  }
}

function record_metric_sample(fps: number, cpu_ms: number, stats: ui_renderer_stats): void {
  metrics.samples.push({ fps, cpu_ms, stats })
  if (metrics.samples.length > 180) metrics.samples.splice(0, metrics.samples.length - 180)
}

function render_metrics(
  renderer: ui_renderer,
  theme: theme_definition,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
): void {
  const col = (hex: string) => pack_color(hex)
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const pad = 14 * scale
  const font = 11.5 * scale
  const mono = 11 * scale
  const samples = metrics.samples
  const latest = samples[samples.length - 1]
  const stats = latest?.stats ?? renderer.renderer_stats()
  const fps = latest?.fps ?? 0
  const cpu = latest?.cpu_ms ?? 0

  renderer.fill_rect(x, y, w, h, slot('panel'))
  renderer.draw_text(x + pad, y + 10 * scale, 'Renderer Metrics', 13 * scale, slot('text'))

  const summary_y = y + 34 * scale
  const summary = [
    `FPS ${fps.toFixed(1)}`,
    `CPU/frame ${cpu.toFixed(2)} ms`,
    `Canvas ${stats.canvas_width} x ${stats.canvas_height}`,
    `Primitives ${format_count(stats.primitive_count)}`,
  ]
  draw_summary_row(renderer, theme, summary, x + pad, summary_y, Math.max(0, w - pad * 2), 26 * scale, scale)

  const chart_x = x + pad
  const chart_y = summary_y + 38 * scale
  const content_w = Math.max(40 * scale, w - pad * 2)
  const two_col = content_w >= 520 * scale
  const col_gap = 18 * scale
  const chart_w = two_col ? Math.max(220 * scale, content_w * 0.58) : content_w
  const chart_h = Math.max(72 * scale, Math.min(136 * scale, h - (chart_y - y) - 22 * scale))
  const fps_max = nice_chart_max(Math.max(90, max_metric(samples, 'fps') * 1.15))
  const cpu_max = nice_chart_max(Math.max(16.7, max_metric(samples, 'cpu_ms') * 1.25))
  draw_chart_frame(renderer, theme, chart_x, chart_y, chart_w, chart_h, scale)
  draw_line_series(renderer, samples.map((sample) => sample.fps), fps_max, chart_x, chart_y, chart_w, chart_h, col('#5fb878'), 2 * scale)
  draw_line_series(renderer, samples.map((sample) => sample.cpu_ms), cpu_max, chart_x, chart_y, chart_w, chart_h, col('#d8a24a'), 2 * scale)
  draw_chart_label(renderer, theme, chart_x, chart_y, chart_w, scale, `FPS max ${fps_max.toFixed(0)}`, '#5fb878', 'left')
  draw_chart_label(renderer, theme, chart_x, chart_y, chart_w, scale, `CPU max ${cpu_max.toFixed(cpu_max < 20 ? 1 : 0)} ms`, '#d8a24a', 'right')

  const buffer_x = two_col ? chart_x + chart_w + col_gap : chart_x
  const buffer_w = two_col ? Math.max(160 * scale, x + w - pad - buffer_x) : content_w
  let cy = two_col ? chart_y : chart_y + chart_h + 18 * scale
  renderer.draw_text(buffer_x, cy, 'Buffers', font, slot('text_dim'))
  cy += 20 * scale
  cy = draw_buffer_bar(renderer, theme, buffer_x, cy, buffer_w, 'ui_primitive_buffer', stats.primitive_buffer_bytes_used, stats.primitive_buffer_bytes_total, scale)
  cy = draw_buffer_bar(renderer, theme, buffer_x, cy, buffer_w, 'ui_vertex_buffer', stats.vertex_buffer_bytes_used, stats.vertex_buffer_bytes_total, scale)

  const detail_y = cy + 4 * scale
  const detail = `Draw commands ${format_count(stats.draw_commands)}   Vertices ${format_count(stats.vertex_count)}   Textures ${format_count(stats.texture_count)}`
  renderer.push_clip(buffer_x, detail_y, buffer_w, Math.max(0, y + h - detail_y - 2 * scale))
  renderer.draw_text(buffer_x, detail_y, detail, mono, slot('text_dim'), FONT_MONO)
  renderer.pop_clip()
}

function draw_summary_row(
  renderer: ui_renderer,
  theme: theme_definition,
  items: string[],
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
): void {
  const cell_gap = 8 * scale
  const cell_r = 5 * scale
  const cell_w = Math.max(1, (w - cell_gap * (items.length - 1)) / items.length)
  for (let i = 0; i < items.length; i += 1) {
    const px = x + i * (cell_w + cell_gap)
    renderer.fill_round_rect(px, y, cell_w, h, cell_r, pack_color(theme.palette.panel_alt))
    renderer.stroke_round_rect(px, y, cell_w, h, cell_r, 1, pack_color(theme.palette.border))
    renderer.push_clip(px + 7 * scale, y, Math.max(0, cell_w - 14 * scale), h)
    renderer.draw_text(px + 7 * scale, renderer.text_v_center_y(y, h, 10.5 * scale), items[i] ?? '', 10.5 * scale, pack_color(theme.palette.text), FONT_MONO)
    renderer.pop_clip()
  }
}

function draw_chart_frame(renderer: ui_renderer, theme: theme_definition, x: number, y: number, w: number, h: number, scale: number): void {
  const frame_r = 6 * scale
  renderer.fill_round_rect(x, y, w, h, frame_r, pack_color(theme.palette.track))
  renderer.stroke_round_rect(x, y, w, h, frame_r, 1, pack_color(theme.palette.border))
  const grid = pack_color('#3a414d66')
  for (let i = 1; i < 4; i += 1) {
    const gy = y + (h * i) / 4
    renderer.stroke_line(x, gy, x + w, gy, 1, grid)
  }
  for (let i = 1; i < 6; i += 1) {
    const gx = x + (w * i) / 6
    renderer.stroke_line(gx, y, gx, y + h, 1, grid)
  }
  renderer.draw_text(x + 8 * scale, y + h - 18 * scale, 'last 180 frames', 9.5 * scale, pack_color(theme.palette.text_dim), FONT_MONO)
}

function draw_chart_label(
  renderer: ui_renderer,
  theme: theme_definition,
  x: number,
  y: number,
  w: number,
  scale: number,
  label: string,
  color: string,
  align: 'left' | 'right',
): void {
  const font = 9.5 * scale
  const dot = 6 * scale
  const label_w = renderer.text_width(label, font, FONT_MONO)
  const px = align === 'left' ? x + 8 * scale : x + w - label_w - 18 * scale
  renderer.fill_circle(px + dot / 2, y + 8 * scale + dot / 2, dot / 2, pack_color(color))
  renderer.draw_text(px + dot + 5 * scale, y + 4 * scale, label, font, pack_color(theme.palette.text_dim), FONT_MONO)
}

function draw_line_series(
  renderer: ui_renderer,
  values: number[],
  max_value: number,
  x: number,
  y: number,
  w: number,
  h: number,
  color: number,
  thickness: number,
): void {
  if (values.length < 2 || max_value <= 0) return
  const count = values.length
  const step = w / Math.max(1, count - 1)
  let prev_x = x
  let prev_y = y + h - (Math.max(0, Math.min(1, values[0] / max_value)) * h)
  for (let i = 1; i < count; i += 1) {
    const px = x + i * step
    const py = y + h - (Math.max(0, Math.min(1, values[i] / max_value)) * h)
    renderer.stroke_line(prev_x, prev_y, px, py, thickness, color, 0.5)
    prev_x = px
    prev_y = py
  }
}

function draw_buffer_bar(
  renderer: ui_renderer,
  theme: theme_definition,
  x: number,
  y: number,
  w: number,
  label: string,
  used: number,
  total: number,
  scale: number,
): number {
  const font = 10.5 * scale
  const value_font = 9.5 * scale
  const row_h = 34 * scale
  const bar_h = 7 * scale
  const text_color = pack_color(theme.palette.text)
  const dim = pack_color(theme.palette.text_dim)
  const ratio = total > 0 ? Math.max(0, Math.min(1, used / total)) : 0
  const value = total > 0 ? `${format_bytes(used)} / ${format_bytes(total)} (${Math.round(ratio * 100)}%)` : `${format_bytes(used)} / not allocated`
  renderer.draw_text(x, y, label, font, text_color, FONT_MONO)
  renderer.push_clip(x, y + 12 * scale, w, 11 * scale)
  renderer.draw_text(x, y + 12 * scale, value, value_font, dim, FONT_MONO)
  renderer.pop_clip()
  const bar_y = y + 25 * scale
  const bar_r = bar_h * 0.5
  renderer.fill_round_rect(x, bar_y, w, bar_h, bar_r, pack_color(theme.palette.track))
  const fill_w = w * ratio
  if (fill_w > 0) renderer.fill_round_rect(x, bar_y, Math.max(fill_w, Math.min(bar_h, w)), bar_h, bar_r, total > 0 ? pack_color(theme.palette.accent) : pack_color(theme.palette.ghost))
  renderer.stroke_round_rect(x, bar_y, w, bar_h, bar_r, 1, pack_color(theme.palette.border))
  return y + row_h
}

function max_metric(samples: metric_sample[], key: 'fps' | 'cpu_ms'): number {
  let max = 0
  for (const sample of samples) max = Math.max(max, sample[key])
  return max
}

function nice_chart_max(value: number): number {
  if (value <= 0) return 1
  const exp = 10 ** Math.floor(Math.log10(value))
  const n = value / exp
  const nice = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10
  return nice * exp
}

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`
}

function format_count(value: number): string {
  if (value < 1000) return `${value}`
  if (value < 1000000) return `${(value / 1000).toFixed(1)}k`
  return `${(value / 1000000).toFixed(1)}m`
}

main().catch((err) => {
  console.error(err)
  const el = document.getElementById('error')
  if (el) {
    el.style.display = 'block'
    el.textContent = `${err}`
  }
})
