// @liamlangli/ui — interactive preview / playground.
//
// Boots the WebGPU renderer and lays the whole demo out as a desktop driven by
// the core `window_system`: every view floats in its own window. The old
// docked workspace (Explorer, Editor, Console, Metrics) is now just one app —
// "Demo Editor" — whose window body is a `dock_system`. The remaining views
// (Widgets, Icons, Graph, Node Graph, About, Chat) open as standalone windows.
// Everything is drawn on the GPU.

// Only the core toolkit is imported statically — the plugins (file browser,
// code editor, chat, graphs, asset audit, dashboard, menu, …) load behind a
// dynamic import so the window-system desktop can put its first frame on
// screen without waiting for (or parsing) any plugin code.
import {
  apply_theme,
  load_theme,
  lerp_theme,
  default_themes,
  ui_renderer,
  ui_widgets,
  ui_icons,
  type ui_icon_name,
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
  // workspace systems (core)
  dock_system,
  window_system,
  serialize_window_layout,
  restore_window_layout,
  type window_layout,
  type window_new_options,
  // installed-app registry (core)
  app_registry,
  serialize_app_registry,
  type installed_app,
  visit_dock_leaves,
  activate_dock_tab,
  profiler,
  memory,
  input_collector,
  gamepad_input,
  gamepad_cursor_update,
  gamepad_cursor_draw,
  create_gamepad_cursor_state,
  ui_has_metal_gpu_capture_bridge,
  ui_queue_metal_frame_capture,
  ui_task_queue_bounds,
  ui_task_queue_blocks_point,
  ui_task_queue_render,
  create_ui_task_queue_state,
} from '../src/core'
// Plugin types only — `import type` is erased at build time, so this does not
// pull the plugin modules into the startup chunk.
import type {
  ui_main_menu,
  text_buffer,
  editor_token,
  editor_token_kind,
  file_node,
  im_message,
  ui_menu_node,
  graph_node_base,
  graph_node_view,
  graph_link,
  node_graph_node,
  node_graph_connection,
  node_graph_template,
} from '../src/plugins'
import theme_url from './theme.json?url'

type plugin_module = typeof import('../src/plugins')

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
      { name: 'dock_system.ts' },
      { name: 'window_system.ts' },
      { name: 'theme.ts' },
      {
        name: 'plugins', kind: 'dir', children: [
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
  { text: '  • gamepad_test  — Controller Test (plug in a game controller)', color: '#9aa3b0' },
  { text: '  • asset_audit   — View ▸ Apps ▸ Asset Audit: drop a .glb/.gltf/.fbx', color: '#9aa3b0' },
  { text: '                    (or a folder) to preview it in a WebGPU viewport,', color: '#9aa3b0' },
  { text: '                    audit its stats, optimize and download a fixed GLB.', color: '#9aa3b0' },
  { text: '  • material_audit — View ▸ Apps ▸ Material Audit: drop base color /', color: '#9aa3b0' },
  { text: '                    normal maps and validate them on a repeat grid, a UV', color: '#9aa3b0' },
  { text: '                    sphere or a rounded cube — auto mipmaps, pan & pinch.', color: '#9aa3b0' },
  { text: '  • dashboard     — View ▸ Apps ▸ Dashboard: a full-screen launcher over', color: '#9aa3b0' },
  { text: '                    the app_registry. Drop an app description .json to', color: '#9aa3b0' },
  { text: '                    install (try apps/notes_v1.json — its shipping path', color: '#9aa3b0' },
  { text: '                    serves v2.1.0, so Check for Updates offers an update);', color: '#9aa3b0' },
  { text: '                    right-click a tile to update or uninstall.', color: '#9aa3b0' },
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

const CHAT_AGENT_NAME = 'Adam'
const CHAT_MODEL = 'qwen2.5:7b-instruct'
const CHAT_COMPLETIONS_URL = 'http://localhost:11434/v1/chat/completions'
const CHAT_CONTEXT_TOKEN_BUDGET = 7000
const CHAT_COMPRESSION_CHUNK_TOKEN_BUDGET = 5200
const CHAT_SUMMARY_TARGET_TOKENS = 900

function create_chat_greeting(): im_message {
  return {
    author: CHAT_AGENT_NAME,
    side: 'left',
    text: 'Hi, I am Adam. Ask me about this WebGPU UI repo, the preview, or any installed plugin.',
    timestamp: Date.now() - 1000 * 60,
  }
}

const chat_messages: im_message[] = [create_chat_greeting()]

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
const graph_view = (node: demo_graph_node): graph_node_view => ({ title: node.title, inputs: node.inputs, outputs: node.outputs })

// --- node_graph plugin demo (dotted backdrop + typed slots) ----------------
// The seeded nodes need the plugin's `add_node`, so they are built lazily in
// `init_plugins` (see `demo_plugins`); the wiring data below is plain JSON.
const node_graph_connections: node_graph_connection[] = [
  { from_node: 'in', from_slot: 1, to_node: 'tex', to_slot: 0 },
  { from_node: 'tex', from_slot: 0, to_node: 'tint', to_slot: 0 },
  { from_node: 'tint', from_slot: 0, to_node: 'out', to_slot: 0 },
  { from_node: 'in', from_slot: 0, to_node: 'out', to_slot: 1 },
]
const node_graph_templates: node_graph_template[] = [
  { type: 'Input', outputs: [{ label: 'Position', type: 'vec3' }, { label: 'UV', type: 'vec2' }] },
  { type: 'Sample', inputs: [{ label: 'UV', type: 'vec2' }], outputs: [{ label: 'Color', type: 'color' }] },
  { type: 'Tint', inputs: [{ label: 'A', type: 'color' }], outputs: [{ label: 'Out', type: 'color' }] },
  { type: 'Output', inputs: [{ label: 'Albedo', type: 'color' }, { label: 'Normal', type: 'vec3' }] },
]

// Asset Hub is now a cloud drive viewer: it browses the `asset_hub/` folder in
// the user's own Google Drive through the storage-provider abstraction (see
// src/storage). The provider + panel state are built lazily in `init_plugins`.

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

// --- Window layout persistence ----------------------------------------------
// The desktop arrangement survives reloads: the layout is snapshotted to
// localStorage every 5 seconds (when it changed) and restored on boot.
const WINDOW_LAYOUT_STORAGE_KEY = 'ui.preview.window_layout'
const WINDOW_LAYOUT_SAVE_INTERVAL_MS = 5000

function load_saved_window_layout(): window_layout | null {
  try {
    const raw = window.localStorage.getItem(WINDOW_LAYOUT_STORAGE_KEY)
    if (!raw) return null
    return restore_window_layout(JSON.parse(raw))
  } catch {
    return null // storage unavailable or corrupt blob — fall back to the default desktop
  }
}

let last_saved_window_layout = ''

function save_window_layout(): void {
  try {
    const raw = serialize_window_layout(windows.layout)
    if (raw === last_saved_window_layout) return
    window.localStorage.setItem(WINDOW_LAYOUT_STORAGE_KEY, raw)
    last_saved_window_layout = raw
  } catch {
    // storage unavailable (private mode / quota) — keep running without persistence
  }
}

// --- Persistent widget / plugin state -------------------------------------
const dock = new dock_system(build_layout())
const windows = new window_system(load_saved_window_layout() ?? build_window_layout())
window.setInterval(save_window_layout, WINDOW_LAYOUT_SAVE_INTERVAL_MS)
// Baked once after the renderer initialises (see main()); drawn in the gallery.
let icon_set: ui_icons | null = null
// Set once the renderer is live (see main()); lets async helpers (console
// appends, deferred compiles) wake the adaptive renderer outside a frame.
let active_renderer: ui_renderer | null = null
// One application-level queue shared by every producer. Any subsystem can
// call ui_task_queue_send(desktop_task_queue, message) to surface work here.
const desktop_task_queue = create_ui_task_queue_state(() => active_renderer?.request_render())

// --- Installed apps + Dashboard ---------------------------------------------
// Every desktop app is an entry in the core `app_registry`. The built-in views
// are seeded as builtin apps; further apps install by dragging a description
// .json onto the page (try public/apps/notes_v1.json — its shipping path points
// at the newer apps/notes.json, so "Check for Updates" offers an update). The
// installed set persists in localStorage alongside the window layout.
const APP_REGISTRY_STORAGE_KEY = 'ui.preview.app_registry'

function load_saved_app_registry(): string | null {
  try {
    return window.localStorage.getItem(APP_REGISTRY_STORAGE_KEY)
  } catch {
    return null
  }
}

const registry = new app_registry(load_saved_app_registry())

// Apps shipped with the preview itself: no shipping path (they update with the
// host), so the dashboard greys out "Check for Updates" and "Uninstall" on them.
const BUILTIN_APPS: { id: string; name: string; icon: string; accent?: string; description: string }[] = [
  { id: 'demo-editor', name: 'Demo Editor', icon: 'code', accent: '#3d4f6b', description: 'Docked workspace: Explorer, Editor, Console, Metrics.' },
  { id: 'gallery', name: 'Widgets', icon: 'settings', description: 'Widget gallery built on the stack layout.' },
  { id: 'icons', name: 'Icons', icon: 'image', description: 'Built-in vector icon atlas.' },
  { id: 'graph', name: 'Graph', icon: 'star', description: 'Generic node-graph canvas.' },
  { id: 'node_graph', name: 'Node Graph', icon: 'dot', description: 'Dotted node editor with typed slots.' },
  { id: 'chat', name: 'Chat', icon: 'file_text', accent: '#3d6b4f', description: 'IM dialog plugin.' },
  { id: 'profiler', name: 'Profiler', icon: 'search', description: 'Frame profiler and memory registry.' },
  { id: 'gamepad', name: 'Controller Test', icon: 'circle', description: 'Game controller visualiser.' },
  { id: 'asset_audit', name: 'Asset Audit', icon: 'file', accent: '#6b3d5a', description: 'Drop or upload .glb/.fbx assets: 3D preview, stats, optimize, re-export.' },
  { id: 'asset_hub', name: 'Asset Hub', icon: 'image', accent: '#3d5f6b', description: 'Browse the asset_hub folder of your Google Drive — read-only, entirely in the browser.' },
  { id: 'material_audit', name: 'Material Audit', icon: 'image', accent: '#5a6b3d', description: 'Upload base color / normal maps and validate them on a repeat grid, UV sphere or rounded cube.' },
  { id: 'about', name: 'About', icon: 'home', description: 'About this demo.' },
]
for (const def of BUILTIN_APPS) {
  if (!registry.get(def.id)) {
    registry.install(
      { id: def.id, name: def.name, version: '1.0.0', icon: def.icon, accent: def.accent, description: def.description },
      { builtin: true },
    )
  }
}

registry.on_change = () => {
  try {
    window.localStorage.setItem(APP_REGISTRY_STORAGE_KEY, serialize_app_registry(registry))
  } catch {
    // storage unavailable — keep running without persistence
  }
  windows.invalidate() // installed-app windows render manifest state
  active_renderer?.request_render()
}

// --- Lazily loaded plugins ----------------------------------------------------
// All plugin code — and every piece of demo state owned by a plugin — sits
// behind a dynamic `import('../src/plugins')`. The core desktop (window
// system, taskbar, dock chrome) renders immediately; panel bodies show a
// loading hint until the plugin chunk arrives, then everything springs live.
interface demo_plugins {
  mod: plugin_module
  main_menu: ui_main_menu
  dashboard_state: ReturnType<plugin_module['create_dashboard_state']>
  file_state: ReturnType<plugin_module['create_file_browser_state']>
  audit_state: ReturnType<plugin_module['create_asset_audit_state']>
  asset_hub_drive_state: ReturnType<plugin_module['create_asset_hub_drive_state']>
  material_audit_state: ReturnType<plugin_module['create_material_audit_state']>
  chat_state: ReturnType<plugin_module['create_im_dialog_state']>
  profiler_state: ReturnType<plugin_module['create_profiler_panel_state']>
  gamepad_test_state: ReturnType<plugin_module['create_gamepad_test_state']>
  editor_buffer: text_buffer
  editor_state: ReturnType<plugin_module['create_code_editor_state']>
  graph_state: ReturnType<plugin_module['create_graph_state']>
  node_graph_state: ReturnType<plugin_module['create_node_graph_state']>
  node_graph_nodes: node_graph_node[]
  webtix_state: ReturnType<plugin_module['create_webtix_state']>
}
let plugins: demo_plugins | null = null

let dashboard_open = false
let last_update_check = 0
let last_update_toast_signature = ''

type toast_kind = 'info' | 'success' | 'error'

interface toast_message {
  id: number
  title: string
  body: string
  kind: toast_kind
  created_at: number
  ttl_ms: number
}

const toast_messages: toast_message[] = []
let next_toast_id = 1

function push_toast(title: string, body: string, kind: toast_kind = 'info', ttl_ms = 9000): void {
  toast_messages.push({ id: next_toast_id++, title, body, kind, created_at: performance.now(), ttl_ms })
  while (toast_messages.length > 3) toast_messages.shift()
  active_renderer?.request_render()
}

function color_with_alpha(hex: string, alpha: string): string {
  const raw = hex.trim().replace('#', '')
  return `#${raw.slice(0, 6)}${alpha}`
}

function pack_ui_color(color: ui_color_rgba): number {
  const r = Math.max(0, Math.min(255, Math.round(color.r * 255)))
  const g = Math.max(0, Math.min(255, Math.round(color.g * 255)))
  const b = Math.max(0, Math.min(255, Math.round(color.b * 255)))
  const a = Math.max(0, Math.min(255, Math.round(color.a * 255)))
  return (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0
}

function available_plugin_updates(): installed_app[] {
  return registry.apps.filter((app) => app.update_available)
}

function notify_available_plugin_updates(): void {
  const updates = available_plugin_updates()
  if (updates.length === 0) return
  const signature = updates
    .map((app) => `${app.manifest.id}@${app.update_available?.version ?? ''}`)
    .sort()
    .join('|')
  if (signature === last_update_toast_signature) return
  last_update_toast_signature = signature
  if (updates.length === 1) {
    const app = updates[0]!
    push_toast(
      `${app.manifest.name} can be updated`,
      `Version ${app.update_available?.version} is available. Use Help > Installed Plugins to update.`,
    )
    return
  }
  push_toast(
    `${updates.length} plugins can be updated`,
    'Use Help > Installed Plugins to review and apply available updates.',
  )
}

function check_all_plugin_updates(options?: { toast?: boolean; toast_when_current?: boolean; log?: boolean }): void {
  void registry.check_all_updates().then(() => {
    const updates = available_plugin_updates()
    if (options?.log) append_console(`checked ${registry.apps.filter((app) => app.shipping_path).length} plugin update channel(s)`, '#4c8bf5')
    if (updates.length > 0) {
      if (options?.toast !== false) notify_available_plugin_updates()
      return
    }
    if (options?.toast_when_current) push_toast('Plugins are up to date', 'No installed plugin updates were found.', 'success', 5000)
  })
}

// Show the full-screen dashboard; piggyback a (throttled) update sweep so
// freshly published manifests show their badge without a manual check.
function open_dashboard(): void {
  dashboard_open = true
  active_renderer?.request_render()
  const now = Date.now()
  if (now - last_update_check > 30_000) {
    last_update_check = now
    check_all_plugin_updates({ toast: true })
  }
}

// Open an app from the dashboard: built-ins route to their view/window, apps
// installed from a description JSON get a generic manifest window.
function launch_app(app: installed_app): void {
  dashboard_open = false
  if (app.builtin) {
    const tab = VIEW_TABS.find((t) => t.id === app.manifest.id)
    open_view_tab(app.manifest.id, tab?.title ?? app.manifest.name)
  } else {
    windows.add_window(`app:${app.manifest.id}`, app.manifest.name, { w: 460, h: 320 })
  }
}

function report_update_check(id: string): void {
  void registry.check_update(id).then((update) => {
    const app = registry.get(id)
    if (!app) return
    if (update) {
      append_console(`${app.manifest.name}: update v${update.version} available`, '#4c8bf5')
      notify_available_plugin_updates()
    }
    else if (app.last_error) append_console(`${app.manifest.name}: update check failed — ${app.last_error}`, '#d9534f')
    else append_console(`${app.manifest.name}: up to date (v${app.manifest.version})`, '#5fb878')
  })
}

function apply_plugin_update(id: string): void {
  void registry.apply_update(id).then((updated) => {
    const app = registry.get(id)
    if (!app) return
    if (updated) {
      append_console(`updated ${app.manifest.name} to v${app.manifest.version}`, '#5fb878')
      push_toast(`${app.manifest.name} updated`, `Now running v${app.manifest.version}.`, 'success', 5000)
      last_update_toast_signature = ''
    } else if (app.last_error) {
      append_console(`${app.manifest.name}: update failed — ${app.last_error}`, '#d9534f')
      push_toast(`${app.manifest.name} update failed`, app.last_error, 'error', 7000)
    } else {
      append_console(`${app.manifest.name}: no update available`, '#9aa3b0')
    }
  })
}

function open_plugin_about(id: string): void {
  const app = registry.get(id)
  if (!app) return
  windows.add_window(`plugin:${id}`, `${app.manifest.name} About`, { w: 460, h: 320 })
}

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
  { id: 'gallery', title: 'Widgets', win: { w: 420, h: 680 } },
  { id: 'icons', title: 'Icons', win: { w: 560, h: 420 } },
  { id: 'graph', title: 'Graph', win: { w: 640, h: 420 } },
  { id: 'node_graph', title: 'Node Graph', win: { w: 640, h: 420 } },
  { id: 'about', title: 'About', win: { w: 540, h: 340 } },
  { id: 'chat', title: 'Chat', win: { w: 300, h: 400 } },
  { id: 'profiler', title: 'Profiler', win: { w: 760, h: 460 } },
  { id: 'gamepad', title: 'Controller Test', win: { w: 620, h: 540 } },
  { id: 'asset_audit', title: 'Asset Audit', win: { w: 900, h: 560 } },
  { id: 'asset_hub', title: 'Asset Hub', win: { w: 920, h: 560 } },
  { id: 'material_audit', title: 'Material Audit', win: { w: 760, h: 560 } },
  { id: 'webtix', title: 'Path Tracer', win: { w: 900, h: 600 } },
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
const installed_plugins_menu: ui_menu_node = { label: 'Installed Plugins', children: [] }

function refresh_installed_plugins_menu(): void {
  installed_plugins_menu.children = registry.apps.map((app) => {
    const pending = app.update_available ? ` -> v${app.update_available.version}` : ''
    const status = app.checking ? ' (checking)' : pending
    const children: ui_menu_node[] = [
      { id: `plugin-about:${app.manifest.id}`, label: 'About' },
      { id: `plugin-check:${app.manifest.id}`, label: app.checking ? 'Checking...' : 'Check for Updates', disabled: app.checking || !app.shipping_path },
      app.update_available
        ? { id: `plugin-update:${app.manifest.id}`, label: `Update to v${app.update_available.version}`, disabled: app.checking }
        : { id: `plugin-update:${app.manifest.id}`, label: 'Update', disabled: true },
    ]
    return { label: `${app.manifest.name} v${app.manifest.version}${status}`, children }
  })
  if (installed_plugins_menu.children.length === 0) {
    installed_plugins_menu.children = [{ label: 'No installed plugins', disabled: true }]
  }
}

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
  if (!plugins) return
  cancel_compile()
  const seq = (compile_ctrl.sequence += 1)
  compile_ctrl.last_source_version = plugins.editor_buffer.version
  compile_ctrl.status = 'Compiling'
  append_console(`$ build #${seq} — compiling ${plugins.editor_buffer.get_text().length} bytes`, '#4c8bf5')
  window.setTimeout(() => {
    if (compile_ctrl.sequence !== seq) return // superseded by a newer build
    compile_ctrl.status = 'Built'
    append_console(`✓ build #${seq} done`, '#5fb878')
    active_renderer?.request_render()
  }, 220)
}

function build_main_menu(mod: plugin_module): ui_main_menu {
  return new mod.ui_main_menu([
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
          { id: 'dashboard', label: 'Dashboard' },
          { id: 'graph', label: 'Graph' },
          { id: 'node_graph', label: 'Node Graph' },
          { id: 'gallery', label: 'Widgets' },
          { id: 'icons', label: 'Icons' },
          { id: 'chat', label: 'Chat' },
          { id: 'profiler', label: 'Profiler' },
          { id: 'gamepad', label: 'Controller Test' },
          { id: 'asset_audit', label: 'Asset Audit' },
          { id: 'asset_hub', label: 'Asset Hub' },
          { id: 'material_audit', label: 'Material Audit' },
          { id: 'webtix', label: 'Path Tracer' },
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
  {
    label: 'Help',
    children: [
      { id: 'about', label: 'About' },
      { label: '', separator: true },
      { id: 'plugin-check-all', label: 'Check All Plugin Updates' },
      installed_plugins_menu,
    ],
  },
  ])
}

function handle_menu(node: ui_menu_node): void {
  const id = node.id
  if (!id) return
  if (id === 'dashboard') {
    open_dashboard()
    return
  }
  if (id === 'plugin-check-all') {
    check_all_plugin_updates({ toast: true, toast_when_current: true, log: true })
    return
  }
  if (id.startsWith('plugin-about:')) {
    open_plugin_about(id.slice('plugin-about:'.length))
    return
  }
  if (id.startsWith('plugin-check:')) {
    report_update_check(id.slice('plugin-check:'.length))
    return
  }
  if (id.startsWith('plugin-update:')) {
    apply_plugin_update(id.slice('plugin-update:'.length))
    return
  }
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
    // Drop the persisted snapshot right away so a reload before the next
    // periodic save doesn't resurrect the pre-reset desktop.
    try {
      window.localStorage.removeItem(WINDOW_LAYOUT_STORAGE_KEY)
    } catch { /* storage unavailable */ }
    last_saved_window_layout = ''
    return
  }
  if (id === 'focus-editor') {
    open_view_tab('editor', 'Editor')
    if (plugins) plugins.editor_state.focused = true
    return
  }
  if (id === 'select-all') {
    open_view_tab('editor', 'Editor')
    plugins?.editor_buffer.select_all()
    return
  }
  if (id === 'new-file') {
    open_view_tab('editor', 'Editor')
    plugins?.editor_buffer.set_text('')
    schedule_compile()
    return
  }
  if (id === 'open-file') {
    open_view_tab('files', 'Explorer')
    append_console('open file: use the Explorer view', '#d8a24a')
    return
  }
  if (id === 'save-file') {
    append_console(`saved buffer (${plugins?.editor_buffer.get_text().length ?? 0} bytes)`, '#5fb878')
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

let chat_is_typing = false
let chat_pending_replies = 0
let chat_history_summary = ''
let chat_history_summary_through = 0
let chat_generation = 0
const console_state = create_text_view_state()
const about_state = create_text_view_state()

type chat_role = 'system' | 'user' | 'assistant'

interface chat_completion_message {
  role: chat_role
  content: string
}

interface chat_completion_response {
  choices?: { message?: { content?: string } }[]
  error?: { message?: string } | string
}

function estimate_chat_tokens(text: string): number {
  return Math.ceil(text.length / 4)
}

const REPOSITORY_CHAT_CONTEXT = [
  '@liamlangli/ui is a browser-native immediate-mode WebGPU UI toolkit.',
  'The core package provides the renderer, widgets, theme system, text views, docking layout, floating window system, app registry, input, gamepad cursor, profiler, memory registry, GPU capture helpers, and shared layout/math utilities.',
  'The preview is a Vite-powered desktop-style playground. It lazy-loads plugins, opens each view in windows, persists the app registry and window layout in localStorage, and demonstrates UI components directly on a WebGPU canvas.',
  'Plugins are optional reusable UI building blocks exported from @liamlangli/ui/plugins. Current source plugins include apps/dashboard/file browser/chat/main menu, code editor, generic graph, typed node graph, controller test, asset audit, asset hub, material audit, layout split view, profiler/material inspection tools, and the WebTIX path tracer.',
  'Avatar Generator and Terrain Graph have been removed from this workspace.',
].join('\n')

function installed_plugin_context(): string {
  if (registry.apps.length === 0) return 'No preview apps/plugins are currently installed.'
  return registry.apps.map((app) => {
    const m = app.manifest
    const source = app.builtin ? 'builtin' : app.shipping_path ? `installed from ${app.shipping_path}` : 'installed'
    const update = app.update_available ? `; update available ${app.update_available.version}` : ''
    const description = m.description ? ` — ${m.description}` : ''
    return `- ${m.name} (${m.id}) v${m.version}, ${source}${update}${description}`
  }).join('\n')
}

function build_adam_system_prompt(): string {
  return [
    `You are ${CHAT_AGENT_NAME}, a helpful local assistant embedded in the @liamlangli/ui preview.`,
    `You are running through Ollama's OpenAI-compatible endpoint with model ${CHAT_MODEL}.`,
    'Reply in the same language the user used unless they ask otherwise. Be concise, practical, and specific to this repository.',
    'Use the repository and installed-plugin context below when answering. If the user asks about code details that are not in this context, say what you can infer and suggest where to inspect next instead of inventing facts.',
    '',
    'Repository context:',
    REPOSITORY_CHAT_CONTEXT,
    '',
    'Installed preview apps/plugins:',
    installed_plugin_context(),
  ].join('\n')
}

function model_chat_history(history: im_message[]): chat_completion_message[] {
  const out: chat_completion_message[] = []
  if (chat_history_summary) {
    out.push({
      role: 'system',
      content: `Compressed earlier chat history:\n${chat_history_summary}`,
    })
  }
  const start = chat_history_summary ? Math.min(chat_history_summary_through, history.length) : 0
  return out.concat(history
    .slice(start)
    .map((msg) => ({
      role: msg.side === 'right' ? 'user' : 'assistant',
      content: `${msg.author ?? (msg.side === 'right' ? 'Me' : CHAT_AGENT_NAME)}: ${msg.text}`,
    })))
}

function build_adam_messages(history: im_message[]): chat_completion_message[] {
  return [
    { role: 'system', content: build_adam_system_prompt() },
    ...model_chat_history(history),
  ]
}

function estimate_messages_tokens(messages: chat_completion_message[]): number {
  return messages.reduce((sum, msg) => sum + estimate_chat_tokens(msg.role) + estimate_chat_tokens(msg.content) + 4, 0)
}

function format_chat_transcript(messages: im_message[]): string {
  return messages.map((msg) => {
    const author = msg.author ?? (msg.side === 'right' ? 'Me' : CHAT_AGENT_NAME)
    return `${author}: ${msg.text}`
  }).join('\n\n')
}

async function post_chat_completion(messages: chat_completion_message[], temperature = 0.35, max_tokens?: number): Promise<string> {
  const body: {
    model: string
    stream: false
    temperature: number
    messages: chat_completion_message[]
    max_tokens?: number
  } = {
    model: CHAT_MODEL,
    stream: false,
    temperature,
    messages,
  }
  if (max_tokens) body.max_tokens = max_tokens
  const res = await fetch(CHAT_COMPLETIONS_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({})) as chat_completion_response
  if (!res.ok) {
    const detail = typeof data.error === 'string' ? data.error : data.error?.message
    throw new Error(detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}`)
  }
  const content = data.choices?.[0]?.message?.content?.trim()
  if (!content) throw new Error('Ollama returned an empty response')
  return content
}

async function compress_history_chunk(existing_summary: string, chunk: im_message[]): Promise<string> {
  const summary = existing_summary || 'No previous summary.'
  const transcript = format_chat_transcript(chunk)
  return post_chat_completion([
    {
      role: 'system',
      content: [
        `You are ${CHAT_AGENT_NAME}. Compress chat history for future continuation.`,
        `Target about ${CHAT_SUMMARY_TARGET_TOKENS} tokens or less.`,
        'Preserve user goals, decisions, constraints, unresolved questions, repo/plugin facts, and any promises made by the assistant.',
        'Do not answer the user. Return only the compressed history summary.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: `Existing compressed summary:\n${summary}\n\nMessages to incorporate:\n${transcript}`,
    },
  ], 0.15, CHAT_SUMMARY_TARGET_TOKENS)
}

async function compress_messages_into_summary(existing_summary: string, messages: im_message[]): Promise<string> {
  let summary = existing_summary
  let chunk: im_message[] = []
  for (const msg of messages) {
    const candidate = chunk.concat(msg)
    const estimated = estimate_chat_tokens(summary) + estimate_chat_tokens(format_chat_transcript(candidate))
    if (chunk.length > 0 && estimated > CHAT_COMPRESSION_CHUNK_TOKEN_BUDGET) {
      summary = await compress_history_chunk(summary, chunk)
      chunk = [msg]
    } else {
      chunk = candidate
    }
  }
  if (chunk.length > 0) summary = await compress_history_chunk(summary, chunk)
  return summary
}

async function prepare_adam_messages(history: im_message[], generation: number): Promise<chat_completion_message[]> {
  let messages = build_adam_messages(history)
  if (estimate_messages_tokens(messages) <= CHAT_CONTEXT_TOKEN_BUDGET) return messages

  const latest_index = Math.max(0, history.length - 1)
  const start = chat_history_summary ? Math.min(chat_history_summary_through, latest_index) : 0
  const to_compress = history.slice(start, latest_index)
  if (to_compress.length > 0) {
    const next_summary = await compress_messages_into_summary(chat_history_summary, to_compress)
    if (generation !== chat_generation) throw new Error('chat request was superseded')
    chat_history_summary = next_summary
    chat_history_summary_through = latest_index
    append_console(`chat: compressed ${to_compress.length} earlier messages for Adam context`, '#d8a24a')
  }

  messages = build_adam_messages(history)
  if (estimate_messages_tokens(messages) > CHAT_CONTEXT_TOKEN_BUDGET) {
    append_console('chat: Adam context is still large after compression; sending compacted request', '#d8a24a')
  }
  return messages
}

function set_chat_typing(delta: number): void {
  chat_pending_replies = Math.max(0, chat_pending_replies + delta)
  chat_is_typing = chat_pending_replies > 0
  windows.invalidate('chat')
  active_renderer?.request_render()
}

function error_message(err: unknown): string {
  if (err instanceof Error) return err.message
  return `${err}`
}

async function fetch_adam_reply(history: im_message[], generation: number): Promise<string> {
  return post_chat_completion(await prepare_adam_messages(history, generation))
}

function ask_adam(): void {
  const generation = chat_generation
  const history = chat_messages.slice()
  set_chat_typing(1)
  void fetch_adam_reply(history, generation)
    .then((reply) => {
      if (generation !== chat_generation) return
      chat_messages.push({ author: CHAT_AGENT_NAME, side: 'left', text: reply, timestamp: Date.now() })
    })
    .catch((err) => {
      if (generation !== chat_generation) return
      chat_messages.push({
        author: CHAT_AGENT_NAME,
        side: 'left',
        text: `I could not reach local Ollama at ${CHAT_COMPLETIONS_URL} with model ${CHAT_MODEL}.\n\n${error_message(err)}\n\nMake sure Ollama is running and the model is available.`,
        timestamp: Date.now(),
      })
      append_console(`chat: Ollama request failed — ${error_message(err)}`, '#d9534f')
    })
    .finally(() => {
      if (generation === chat_generation) set_chat_typing(-1)
    })
}

function clear_chat_history(): void {
  chat_generation += 1
  chat_pending_replies = 0
  chat_is_typing = false
  chat_history_summary = ''
  chat_history_summary_through = 0
  chat_messages.splice(0, chat_messages.length, create_chat_greeting())
  if (plugins) {
    plugins.chat_state.scroll.offset_y = 0
    plugins.chat_state.draft = ''
    plugins.chat_state.input_state.cursor = 0
    plugins.chat_state.input_state.sel_anchor = 0
    plugins.chat_state.input_state.sel_head = 0
    plugins.chat_state.stick_to_bottom = true
    plugins.chat_state.last_count = 0
  }
  windows.invalidate('chat')
  active_renderer?.request_render()
}

// --- game controller demo ---------------------------------------------------
// Polls connected game controllers every frame. While one is connected a
// translucent circle cursor appears: the left stick moves it, A clicks and the
// right stick scrolls — and the Controller Test window shows the live keymap.
const gamepad = new gamepad_input(() => active_renderer?.request_render())
const gamepad_cursor = create_gamepad_cursor_state()

// Build every plugin-owned piece of demo state once the plugin chunk lands,
// then wire the DOM drop/picker targets and wake the renderer so the panels
// switch from their loading hint to live content on the next frame.
function init_plugins(mod: plugin_module): void {
  if (plugins) return
  // Asset Hub: a read-only viewer over the `asset_hub/` folder in the user's
  // Google Drive. The provider only exists when VITE_GOOGLE_CLIENT_ID is set;
  // otherwise the panel shows a configuration message (see README).
  const cloud_cfg = mod.load_cloud_config()
  const drive_provider = cloud_cfg.google_client_id
    ? new mod.google_drive_provider(cloud_cfg.google_client_id, cloud_cfg.default_root_folder_name, { api_key: cloud_cfg.google_api_key })
    : null
  const editor_buffer = new mod.text_buffer(
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
  plugins = {
    mod,
    main_menu: build_main_menu(mod),
    dashboard_state: mod.create_dashboard_state(),
    file_state: mod.create_file_browser_state(),
    audit_state: mod.create_asset_audit_state(),
    asset_hub_drive_state: mod.create_asset_hub_drive_state(drive_provider, {
      root_folder_name: cloud_cfg.default_root_folder_name,
      task_queue: desktop_task_queue,
      on_change: () => {
        windows.invalidate('asset_hub')
        active_renderer?.request_render()
      },
    }),
    material_audit_state: mod.create_material_audit_state(),
    chat_state: mod.create_im_dialog_state(),
    profiler_state: mod.create_profiler_panel_state(),
    gamepad_test_state: mod.create_gamepad_test_state(),
    editor_buffer,
    editor_state: mod.create_code_editor_state(),
    graph_state: mod.create_graph_state(),
    node_graph_state: mod.create_node_graph_state(),
    webtix_state: mod.create_webtix_state(),
    node_graph_nodes: [
      mod.add_node('Input', 20, 40, { id: 'in', outputs: [{ label: 'Position', type: 'vec3' }, { label: 'UV', type: 'vec2' }] }),
      mod.add_node('Sample', 240, 60, { id: 'tex', inputs: [{ label: 'UV', type: 'vec2' }], outputs: [{ label: 'Color', type: 'color' }] }),
      mod.add_node('Tint', 240, 220, { id: 'tint', inputs: [{ label: 'A', type: 'color' }], outputs: [{ label: 'Out', type: 'color' }] }),
      mod.add_node('Output', 470, 120, { id: 'out', inputs: [{ label: 'Albedo', type: 'color' }, { label: 'Normal', type: 'vec3' }] }),
    ],
  }
  compile_ctrl.last_source_version = editor_buffer.version

  // Drag-to-audit: dropping a .glb/.gltf/.fbx file (or a folder of them) on the
  // canvas loads it into the Asset Audit window; the bridge also installs the
  // hidden file/folder pickers behind the panel's Upload buttons.
  const audit_state = plugins.audit_state
  let audit_asset_count = 0
  mod.asset_audit_dom_target(canvas, audit_state, {
    on_change: () => {
      windows.invalidate('asset_audit')
      active_renderer?.request_render()
      // Surface the window when files arrive (drag hover / load), but defer the
      // spawn: on_change can fire mid-frame from inside windows.frame().
      const should_open = audit_state.drop_hover || audit_state.loading > 0 || audit_state.assets.length !== audit_asset_count
      audit_asset_count = audit_state.assets.length
      if (should_open) {
        window.setTimeout(() => {
          open_view_tab('asset_audit', 'Asset Audit')
          active_renderer?.request_render()
        }, 0)
      }
    },
  })

  // Drag-to-audit: dropping an image on the canvas loads it into the Material
  // Audit window (filenames that look like a normal map land in the normal
  // slot); the bridge also installs the hidden picker behind its Upload buttons.
  const material_audit_state = plugins.material_audit_state
  let material_audit_version = 0
  mod.material_audit_dom_target(canvas, material_audit_state, {
    on_change: () => {
      windows.invalidate('material_audit')
      active_renderer?.request_render()
      // Surface the window when an image arrives, deferred for the same
      // mid-frame reason as asset_audit above.
      const should_open = material_audit_state.drop_hover || material_audit_state.loading > 0 || material_audit_state.source_version !== material_audit_version
      material_audit_version = material_audit_state.source_version
      if (should_open) {
        window.setTimeout(() => {
          open_view_tab('material_audit', 'Material Audit')
          active_renderer?.request_render()
        }, 0)
      }
    },
    on_error: (message) => append_console(message, '#d9534f'),
  })

  // Asset Hub uploads: wires the hidden `.glb` / `.zip` file input behind the
  // panel's Upload button (on_change is already set by create_asset_hub_drive_state above).
  mod.asset_hub_drive_dom_target(canvas, plugins.asset_hub_drive_state)

  // Drag-to-install: dropping an app description .json (or a manifest URL)
  // anywhere on the canvas installs it; the dashboard opens as the drop zone.
  mod.dashboard_drop_target(canvas, registry, plugins.dashboard_state, {
    on_installed: (app) => {
      append_console(`installed ${app.manifest.name} v${app.manifest.version}`, '#5fb878')
      open_dashboard()
    },
    on_error: (message) => {
      append_console(message, '#d9534f')
      active_renderer?.request_render()
    },
    on_drag_state: (active) => {
      if (active) open_dashboard()
      active_renderer?.request_render()
    },
  })

  // Cached window bodies rendered the loading hint — re-render them live.
  windows.invalidate()
  active_renderer?.request_render()
}

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
  scroll: { offset_y: 0 } as ui_scroll_state,
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

// Report the demo's own CPU-side captures to the shared memory registry, so the
// profiler's Memory tab shows host resources next to the renderer's. Sizes are
// rough per-record estimates — enough to see the moving windows grow and settle.
function track_host_memory(): void {
  let span_count = 0
  for (const f of profiler.frames) span_count += f.spans.length
  memory.track('app.profiler_capture', 'profiler', 'cpu', profiler.frames.length * 96 + span_count * 72, `${profiler.frames.length} frames`)
  memory.track('app.metrics_samples', 'profiler', 'cpu', metrics.samples.length * 120, `${metrics.samples.length} samples`)
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
  const widgets = new ui_widgets(renderer)
  icon_set = new ui_icons(renderer)
  const loaded: theme_definition = await load_theme(theme_url)
  init_themes({ name: 'Midnight', theme: loaded })

  const input = new input_collector(canvas, () => renderer.request_render())
  const resize = () => renderer.resize()
  window.addEventListener('resize', resize)
  window.setTimeout(() => check_all_plugin_updates({ toast: true }), 800)

  function frame(): void {
    const frame_start_ms = performance.now()
    const frame_delta_ms = frame_start_ms - metrics.last_frame_start_ms
    metrics.last_frame_start_ms = frame_start_ms
    profiler.begin_frame(frame_start_ms)
    profiler.begin('input')
    const snapshot = input.begin_frame()
    profiler.end()
    // While the dashboard covers the screen, everything beneath it (menu bar,
    // windows, widgets) sees neutered input so clicks can't fall through.
    const blank_input = {
      ...snapshot,
      mouse_pressed: false, mouse_down: false, mouse_released: false,
      mouse_right_pressed: false, mouse_right_down: false, wheel_y: 0,
      typed_text: '', ime_composition: '',
      key_backspace: false, key_delete: false, key_enter: false, key_escape: false,
      key_left: false, key_right: false, key_up: false, key_down: false,
      key_home: false, key_end: false, key_page_up: false, key_page_down: false,
      key_f12: false, key_a: false, key_c: false,
    }
    const base_desktop_snapshot = dashboard_open ? blank_input : snapshot
    if (snapshot.key_f12) {
      if (ui_queue_metal_frame_capture({ directory: '.', scope: 'frame', label: 'ui.preview.frame' })) {
        append_console('Metal GPU frame capture requested: ./ui-frame-*.gputrace', '#5fb878')
        renderer.request_render(1)
      } else {
        append_console('Metal GPU capture bridge unavailable (window.ui_metal_gpu_capture)', '#d8a24a')
      }
      if (!ui_has_metal_gpu_capture_bridge()) console.warn('Install window.ui_metal_gpu_capture or a uiMetalGpuCapture WebKit message handler to save Metal captures.')
    }
    // The menu activates on mouse_pressed, so when it opens the dashboard the
    // press edge is still live in this frame's snapshot — feed the dashboard
    // blank input on its opening frame so that click can't instantly launch a
    // tile under the cursor or dismiss the dashboard again.
    const dashboard_open_at_frame_start = dashboard_open
    const safe = renderer.safe_rect()
    const scale = window.devicePixelRatio || 1
    const m = 8 * scale
    const transfer_queue_bounds = ui_task_queue_bounds(desktop_task_queue, safe.x, safe.y, safe.w, safe.h, scale)
    const transfer_queue_blocks_input = ui_task_queue_blocks_point(
      desktop_task_queue,
      snapshot.mouse_x,
      snapshot.mouse_y,
      transfer_queue_bounds,
    )
    const desktop_snapshot = transfer_queue_blocks_input ? blank_input : base_desktop_snapshot

    // Poll game controllers and drive the transparent circle cursor. Gamepads
    // never fire DOM events, so keep the adaptive renderer awake (and the
    // Controller Test window live) while one is connected.
    profiler.begin('gamepad')
    gamepad.poll()
    gamepad_cursor_update(gamepad.active, snapshot, safe.x, safe.y, safe.w, safe.h, gamepad_cursor)
    if (gamepad.connected) {
      renderer.request_render()
      if (windows.layout.windows.some((win) => win.id === 'gamepad')) windows.invalidate('gamepad')
    }
    profiler.end()

    profiler.begin('theme')
    const theme = tick_theme(frame_start_ms)
    profiler.end()
    const clear = hex_to_normalized_rgba(theme.palette.bg)
    // While a cross-fade is in flight the palette changes every frame, so keep
    // waking the (adaptive) renderer until it settles — `lerp_theme` returns the
    // `to` reference once finished, which we detect by identity.
    if (theme !== theme_ctrl.to) renderer.request_render()

    renderer.begin_frame()
    widgets.begin_frame(theme, desktop_snapshot)

    // Top menu bar reserves a strip; the window desktop fills the area below it.
    const menu_h = 30 * scale
    const bar_x = safe.x + m
    const bar_y = safe.y + m
    const bar_w = safe.w - m * 2
    const dock_y = bar_y + menu_h + m
    const dock_h = safe.y + safe.h - m - dock_y

    // When a dropdown is open over the dock, swallow the click so the panel
    // underneath doesn't also react to it.
    const block = plugins ? plugins.main_menu.blocks_point(snapshot.mouse_x, snapshot.mouse_y) : false
    const dock_input = block && !dashboard_open ? { ...snapshot, mouse_pressed: false, mouse_down: false, mouse_released: false, wheel_y: 0 } : desktop_snapshot

    const render_panel = (panel: { x: number; y: number; w: number; h: number; tab: { id: string } }) => {
      const snapshot = desktop_snapshot // panel bodies are blocked while the dashboard is up
      const inset = 0
      const px = panel.x + inset
      const py = panel.y + inset
      const pw = panel.w - inset * 2
      const ph = panel.h - inset * 2
      profiler.begin(`panel:${panel.tab.id}`)
      if (panel.tab.id.startsWith('app:')) {
        // A window for an app installed from a description JSON: show its manifest.
        render_installed_app(renderer, widgets, theme, panel.tab.id.slice('app:'.length), px, py, pw, ph, scale)
        profiler.end()
        return
      }
      if (panel.tab.id.startsWith('plugin:')) {
        // Help > Installed Plugins opens manifest/update details for any plugin,
        // including built-ins whose normal launch target is a feature view.
        render_installed_app(renderer, widgets, theme, panel.tab.id.slice('plugin:'.length), px, py, pw, ph, scale)
        profiler.end()
        return
      }
      const live = plugins
      if (!live) {
        // Plugin chunk still in flight — placeholder body. `init_plugins`
        // invalidates every cached window once it lands, swapping these live.
        render_loading_panel(renderer, theme, px, py, pw, ph, scale)
        profiler.end()
        return
      }
      switch (panel.tab.id) {
        case 'demo-editor':
          // The Demo Editor app: its window body is a whole docked workspace.
          dock.frame(renderer, theme, dock_input, px, py, pw, ph, render_panel)
          break
        case 'files':
          render_files(renderer, widgets, theme, snapshot, px, py, pw, ph)
          break
        case 'editor':
          live.mod.code_editor(renderer, theme, snapshot, px, py, pw, ph, live.editor_buffer, live.editor_state, {
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
          live.mod.graph_canvas(renderer, theme, snapshot, px, py, pw, ph, graph_nodes, graph_links, live.graph_state, graph_view, {
            compatible: (a, b) => a === b || a === 'color' || b === 'color',
          })
          break
        case 'node_graph': {
          const ng = live.mod.node_graph(renderer, theme, snapshot, px, py, pw, ph, live.node_graph_nodes, node_graph_connections, live.node_graph_state, {
            compatible: (a, b) => a === b,
            node_types: node_graph_templates,
          })
          if (ng.delete_requested) {
            for (let i = node_graph_connections.length - 1; i >= 0; i -= 1) {
              const c = node_graph_connections[i]
              if (live.node_graph_state.selected.has(c.from_node) || live.node_graph_state.selected.has(c.to_node)) node_graph_connections.splice(i, 1)
            }
            for (let i = live.node_graph_nodes.length - 1; i >= 0; i -= 1) {
              if (live.node_graph_state.selected.has(live.node_graph_nodes[i].id)) live.node_graph_nodes.splice(i, 1)
            }
            live.node_graph_state.selected.clear()
          }
          break
        }
        case 'chat':
          render_chat(renderer, widgets, theme, snapshot, px, py, pw, ph)
          break
        case 'profiler':
          live.mod.profiler_panel(renderer, theme, snapshot, px, py, pw, ph, profiler, live.profiler_state)
          break
        case 'gamepad':
          live.mod.gamepad_test_panel(renderer, theme, snapshot, px, py, pw, ph, gamepad, live.gamepad_test_state)
          break
        case 'asset_audit':
          live.mod.asset_audit(renderer, widgets, theme, snapshot, px, py, pw, ph, live.audit_state, { scale })
          break
        case 'asset_hub': {
          const ev = live.mod.asset_hub_drive(renderer, theme, snapshot, px, py, pw, ph, live.asset_hub_drive_state)
          if (ev.connect_requested) append_console('asset hub: connecting to Google Drive…', '#4c8bf5')
          if (ev.pick_requested) append_console('asset hub: choosing a Drive folder…', '#4c8bf5')
          if (ev.signed_out) append_console('asset hub: signed out of Google Drive', '#9aa3b0')
          if (ev.refreshed) append_console('asset hub: refreshing current folder', '#9aa3b0')
          if (ev.folder_opened) append_console(`asset hub: opened ${ev.folder_opened.name}/`, '#4c8bf5')
          if (ev.download_requested) append_console(`asset hub: downloading ${ev.download_requested.name}`, '#5fb878')
          if (ev.open_requested) append_console(`asset hub: opened ${ev.open_requested.name} in Drive`, '#9aa3b0')
          if (Object.keys(ev).length > 0) windows.invalidate('asset_hub')
          break
        }
        case 'material_audit': {
          const ev = live.mod.material_audit(renderer, widgets, theme, snapshot, px, py, pw, ph, live.material_audit_state, { scale })
          if (ev.loaded) append_console(`material audit: ${ev.loaded.slot} map ${ev.loaded.name} (${ev.loaded.width}×${ev.loaded.height})`, '#5fb878')
          break
        }
        case 'webtix':
          live.mod.webtix(renderer, widgets, theme, snapshot, px, py, pw, ph, live.webtix_state, { scale })
          break
      }
      profiler.end()
    }

    // The window system is the workspace; the Demo Editor window nests the dock.
    // While the profiler records, keep its window redrawing so the capture streams.
    if (!profiler.paused && windows.layout.windows.some((win) => win.id === 'profiler')) windows.invalidate('profiler')
    profiler.begin('windows')
    windows.frame(renderer, theme, dock_input, bar_x, dock_y, bar_w, dock_h, render_panel)
    profiler.end()

    // Auto-compile: when the editor buffer changes, (re)arm the debounced build.
    if (plugins && compile_ctrl.auto_compile && plugins.editor_buffer.version !== compile_ctrl.last_source_version) {
      compile_ctrl.last_source_version = plugins.editor_buffer.version
      schedule_compile()
    }

    // Refresh the Theme sub-menu against the live selection, then draw the menu
    // bar on top of the dock so its dropdowns overlay the panels below. Until
    // the plugin chunk lands, an empty bar holds the menu's place.
    profiler.begin('menu')
    if (plugins) {
      theme_menu.children = theme_ctrl.presets.map((preset, i) => ({ id: `theme:${i}`, label: preset.name, checked: i === theme_ctrl.index }))
      refresh_installed_plugins_menu()
      const menu_event = plugins.main_menu.frame(renderer, theme, desktop_snapshot, bar_x, bar_y, bar_w, menu_h)
      profiler.end()
      if (menu_event.activated) handle_menu(menu_event.activated)
    } else {
      renderer.fill_round_rect(bar_x, bar_y, bar_w, menu_h, 6 * scale, pack_color(theme.palette.panel_alt))
      renderer.stroke_round_rect(bar_x, bar_y, bar_w, menu_h, 6 * scale, 1, pack_color(theme.palette.border))
      profiler.end()
    }

    // The Dashboard app: a full-screen launcher over the installed-app
    // registry, drawn above the desktop and the menu bar.
    if (dashboard_open && plugins) {
      profiler.begin('dashboard')
      const dashboard_input = transfer_queue_blocks_input ? blank_input : dashboard_open_at_frame_start ? snapshot : blank_input
      const ev = plugins.mod.dashboard(renderer, theme, dashboard_input, safe.x, safe.y, safe.w, safe.h, registry.apps, plugins.dashboard_state, { icons: icon_set ?? undefined })
      profiler.end()
      if (ev.launched) launch_app(ev.launched)
      if (ev.dismissed) dashboard_open = false
      if (ev.uninstall_requested) {
        const name = ev.uninstall_requested.manifest.name
        if (registry.uninstall(ev.uninstall_requested.manifest.id)) append_console(`uninstalled ${name}`, '#d8a24a')
      }
      if (ev.check_updates_requested) report_update_check(ev.check_updates_requested.manifest.id)
      if (ev.update_requested) {
        apply_plugin_update(ev.update_requested.manifest.id)
      }
    }

    widgets.end_frame()
    const transfer_queue_offset = transfer_queue_bounds ? transfer_queue_bounds.h + 8 * scale : 0
    render_toasts(renderer, theme, safe.x, safe.y, safe.w, safe.h, scale, transfer_queue_offset)
    ui_task_queue_render(renderer, theme, snapshot, desktop_task_queue, transfer_queue_bounds, scale)
    // Controller cursor rides above every window, menu and popup.
    gamepad_cursor_draw(renderer, theme, gamepad.active, gamepad_cursor)
    profiler.begin('flush')
    renderer.flush(clear)
    profiler.end()
    profiler.end_frame()
    track_host_memory()
    record_metric_sample(frame_delta_ms > 0 ? 1000 / frame_delta_ms : 0, performance.now() - frame_start_ms, renderer.renderer_stats())
    input.end_frame()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)

  // Pull the plugin chunk in only after the first core frame is scheduled, so
  // its fetch/parse never delays the desktop's first paint.
  void import('../src/plugins')
    .then((mod) => init_plugins(mod))
    .catch((err) => {
      console.error('failed to load plugins', err)
      append_console(`failed to load plugins: ${err}`, '#d9534f')
    })
}

// Placeholder body drawn while the plugin chunk is still loading: the core
// window system (frames, taskbar, dock chrome) is already fully interactive.
function render_loading_panel(
  renderer: ui_renderer,
  theme: theme_definition,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
): void {
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  renderer.fill_rect(x, y, w, h, slot('panel'))
  const label = 'Loading…'
  const font = 11.5 * scale
  renderer.draw_text(x + (w - renderer.text_width(label, font)) / 2, renderer.text_v_center_y(y, h, font), label, font, slot('text_dim'))
}

function render_toasts(
  renderer: ui_renderer,
  theme: theme_definition,
  safe_x: number,
  safe_y: number,
  safe_w: number,
  safe_h: number,
  scale: number,
  bottom_offset = 0,
): void {
  const now = performance.now()
  for (let i = toast_messages.length - 1; i >= 0; i -= 1) {
    const toast = toast_messages[i]!
    if (now - toast.created_at > toast.ttl_ms) toast_messages.splice(i, 1)
  }
  if (toast_messages.length === 0) return

  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const toast_w = Math.min(360 * scale, Math.max(180 * scale, safe_w - 20 * scale))
  const pad = 12 * scale
  const gap = 8 * scale
  const title_font = 12 * scale
  const body_font = 10.5 * scale
  const line_w = Math.max(20 * scale, toast_w - pad * 2 - 6 * scale)
  let y = safe_y + safe_h - 10 * scale - bottom_offset

  for (let i = toast_messages.length - 1; i >= 0; i -= 1) {
    const toast = toast_messages[i]!
    const body_h = renderer.wrap_text(toast.body, body_font, line_w).length * renderer.text_line_height(body_font)
    const toast_h = Math.max(68 * scale, pad * 2 + renderer.text_line_height(title_font) + 3 * scale + body_h)
    y -= toast_h
    const x = safe_x + safe_w - toast_w - 10 * scale
    const accent = toast.kind === 'success' ? pack_color('#5fb878') : toast.kind === 'error' ? pack_color('#d9534f') : slot('accent')
    renderer.fill_round_rect(x, y, toast_w, toast_h, 7 * scale, pack_color(color_with_alpha(theme.palette.panel_alt, 'f2')))
    renderer.stroke_round_rect(x, y, toast_w, toast_h, 7 * scale, 1, slot('border_strong'))
    renderer.fill_round_rect(x + pad, y + pad, 4 * scale, toast_h - pad * 2, 2 * scale, accent)
    renderer.draw_text(x + pad + 10 * scale, y + pad - 1 * scale, toast.title, title_font, slot('text'))
    renderer.draw_text_wrapped(x + pad + 10 * scale, y + pad + renderer.text_line_height(title_font) + 2 * scale, line_w, toast.body, body_font, slot('text_dim'))
    y -= gap
  }
  active_renderer?.request_render()
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
  if (!plugins) return
  const ev = plugins.mod.file_browser(renderer, theme, snapshot, x, y, w, h, file_tree, plugins.file_state, {
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

// Body of a window for an app installed from a description JSON: the demo has
// no real code to run, so it shows the manifest plus live update controls.
function render_installed_app(
  renderer: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
): void {
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const pad = 16 * scale
  renderer.fill_rect(x, y, w, h, slot('panel'))
  const app = registry.get(id)
  if (!app) {
    renderer.draw_text(x + pad, y + pad, 'This app has been uninstalled.', 11.5 * scale, slot('text_dim'))
    return
  }

  // Icon plate + name/version header.
  const icon_s = 44 * scale
  const plate = app.manifest.accent ? pack_color(app.manifest.accent) : slot('accent_dim')
  renderer.fill_round_rect(x + pad, y + pad, icon_s, icon_s, 10 * scale, plate)
  renderer.stroke_round_rect(x + pad, y + pad, icon_s, icon_s, 10 * scale, 1, slot('border_strong'))
  const icon_name = app.manifest.icon as ui_icon_name | undefined
  if (icon_set && icon_name && icon_set.has(icon_name)) {
    const glyph = icon_s * 0.56
    icon_set.draw(icon_name, x + pad + (icon_s - glyph) / 2, y + pad + (icon_s - glyph) / 2, glyph, slot('text'))
  } else {
    const initial = (app.manifest.name[0] ?? '?').toUpperCase()
    const ifont = icon_s * 0.46
    const iw = renderer.text_width(initial, ifont)
    renderer.draw_text(x + pad + (icon_s - iw) / 2, renderer.text_v_center_y(y + pad, icon_s, ifont), initial, ifont, slot('text'))
  }
  const head_x = x + pad + icon_s + 12 * scale
  renderer.draw_text(head_x, y + pad + 2 * scale, app.manifest.name, 15 * scale, slot('text'))
  renderer.draw_text(head_x, y + pad + 24 * scale, `v${app.manifest.version}`, 10.5 * scale, slot('text_dim'), FONT_MONO)

  let cy = y + pad + icon_s + 14 * scale
  const body_w = Math.max(40 * scale, w - pad * 2)
  if (app.manifest.description) {
    cy += renderer.draw_text_wrapped(x + pad, cy, body_w, app.manifest.description, 11 * scale, slot('text')) + 10 * scale
  }
  renderer.push_clip(x + pad, cy, body_w, 14 * scale)
  renderer.draw_text(x + pad, cy, `shipping path: ${app.shipping_path ?? '—'}`, 9.5 * scale, slot('text_dim'), FONT_MONO)
  renderer.pop_clip()
  cy += 18 * scale

  const status = app.checking
    ? 'checking for updates…'
    : app.update_available
      ? `update available: v${app.update_available.version}`
      : app.last_error
        ? `update check failed — ${app.last_error}`
        : app.last_checked
          ? `up to date (checked ${new Date(app.last_checked).toLocaleTimeString()})`
          : `installed ${new Date(app.installed_at).toLocaleString()}`
  renderer.draw_text(x + pad, cy, status, 10 * scale, app.update_available ? slot('accent') : app.last_error ? pack_color('#d9534f') : slot('text_dim'))
  cy += 24 * scale

  // Update controls, driven by the registry's shipping path.
  if (app.shipping_path) {
    const btn_h = 28 * scale
    if (widgets.button(`app_check:${id}`, x + pad, cy, 150 * scale, btn_h, app.checking ? 'Checking…' : 'Check for Updates')) {
      report_update_check(id)
    }
    if (app.update_available) {
      if (widgets.button(`app_update:${id}`, x + pad + 162 * scale, cy, 150 * scale, btn_h, `Update to v${app.update_available.version}`, { active: true })) {
        apply_plugin_update(id)
      }
    }
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
  if (!plugins) return
  const ev = plugins.mod.im_dialog(renderer, widgets, theme, snapshot, x, y, w, h, chat_messages, plugins.chat_state, {
    title: `${CHAT_AGENT_NAME} · ${CHAT_MODEL}`,
    header_action_label: 'Clear',
    placeholder: `Message ${CHAT_AGENT_NAME}…`,
    is_typing: chat_is_typing,
    typing_author: CHAT_AGENT_NAME,
  })
  if (ev.header_action) {
    clear_chat_history()
    return
  }
  if (ev.sent) {
    chat_messages.push({ author: 'Me', side: 'right', text: ev.sent, timestamp: Date.now() })
    windows.invalidate('chat') // refresh the Chat window even if it's inactive
    renderer.request_render()
    ask_adam()
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
  const sec = 22 * scale // section row height
  const ctrl = 28 * scale // control row height
  const gap = 12 * scale
  const stack_count = 17
  const content_h = pad * 2
    + sec * 8
    + ctrl * 3
    + 30 * scale
    + 20 * scale * 2
    + 18 * scale
    + 30 * scale
    + 96 * scale
    + gap * (stack_count - 1)
  const sb_w = 7 * scale
  const overflow = content_h > h
  const col_w = Math.min(360 * scale, Math.max(1, w - pad * 2 - (overflow ? sb_w + 8 * scale : 0)))
  const cx = x + pad
  set_stack_layout_debug_wireframe(gallery.toggle_b)

  widgets.handle_scroll_area(x, y, w, h, gallery.scroll, content_h)
  gallery.scroll.offset_y = Math.max(0, Math.min(Math.max(0, content_h - h), gallery.scroll.offset_y))

  // A single vertical stack drives the whole panel: each section label and its
  // control is just the next slot, so there is no x/y cursor bookkeeping here.
  const stack = (gallery_col ??= create_stack_ui_layout(widgets))
  renderer.push_clip(x, y, w, h)
  stack.vstack(cx, y + pad - gallery.scroll.offset_y, col_w, Math.max(1, content_h - pad * 2), stack_count, { gap })

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

  stack.section(sec, 'TEXT STYLE')
  const text_rect = stack.next_rect(96 * scale)
  draw_gallery_text_specimen(renderer, theme, text_rect.x, text_rect.y, text_rect.w, text_rect.h, scale)
  renderer.pop_clip()

  if (overflow) {
    widgets.scrollbar('gallery_sb', x + w - sb_w - 4 * scale, y, sb_w, h, gallery.scroll, content_h)
  }
}

function draw_gallery_text_specimen(
  renderer: ui_renderer,
  theme: theme_definition,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
): void {
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const tint = pack_ui_color(gallery.color)
  const pad = 10 * scale
  const panel = pack_color(color_with_alpha(theme.palette.panel_alt, 'a8'))
  const outline = slot('border_strong')
  const shadow = 0x9c000000

  renderer.fill_round_rect(x, y, w, h, 4 * scale, panel)
  renderer.stroke_round_rect(x, y, w, h, 4 * scale, 1, slot('border'))

  const left = x + pad
  const top = y + 7 * scale
  renderer.draw_text_msdf(left, top, 'Small / normal / tint', 10 * scale, slot('text_dim'), { weight: -0.1 })
  renderer.draw_text_msdf(left, top + 17 * scale, 'Medium weighted', 13.5 * scale, tint, { weight: 0.2 })
  draw_msdf_outline_text(renderer, left, top + 40 * scale, 'Outline', 18 * scale, slot('text'), outline, 1.15 * scale)

  const right = x + Math.max(168 * scale, w * 0.52)
  renderer.draw_text_msdf(right, top + 3 * scale, 'Shadow', 20 * scale, slot('accent'), {
    weight: 0.12,
    shadow: { dx: 2.5 * scale, dy: 3 * scale, color: shadow, weight: 0.28, softness: 2.25 },
  })
  renderer.draw_text_msdf(right, top + 39 * scale, 'Varied weight', 13 * scale, slot('text'), {
    weight: (_ch, index) => (index % 2 === 0 ? 0.36 : -0.16),
  })
}

function draw_msdf_outline_text(
  renderer: ui_renderer,
  x: number,
  y: number,
  text: string,
  font_px: number,
  fill: number,
  outline: number,
  outline_px: number,
): void {
  const steps = [
    [-1, -1], [0, -1], [1, -1],
    [-1, 0], [1, 0],
    [-1, 1], [0, 1], [1, 1],
  ] as const
  for (const [dx, dy] of steps) {
    renderer.draw_text_msdf(x + dx * outline_px, y + dy * outline_px, text, font_px, outline, { weight: 0.32, softness: 1.15 })
  }
  renderer.draw_text_msdf(x, y, text, font_px, fill, { weight: 0.02 })
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

// A small live-state handle for automated smoke tests and console debugging
// (drives nothing by itself — everything stays plain preview state).
;(window as unknown as Record<string, unknown>).__ui_preview = {
  registry,
  windows,
  dock,
  // Plugin-owned pieces resolve to null until the lazy plugin chunk lands.
  get main_menu() { return plugins?.main_menu ?? null },
  get dashboard_state() { return plugins?.dashboard_state ?? null },
  plugins_loaded: () => plugins !== null,
  is_dashboard_open: () => dashboard_open,
}

if (!('gpu' in navigator)) {
  const fallback = document.getElementById('nogpu')
  if (fallback) fallback.style.display = 'grid'
  canvas.style.display = 'none'
} else {
  main().catch((err) => {
    console.error(err)
    const el = document.getElementById('error')
    if (el) {
      el.style.display = 'block'
      el.textContent = `${err}`
    }
  })
}
