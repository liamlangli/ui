// @liamlangli/ui — interactive preview / playground.
//
// Boots the WebGPU renderer and lays the whole demo out inside the `dock_system`
// plugin: an Explorer (file_browser), a Widgets gallery, a Console (text_view),
// an About panel, and a Chat panel (im_dialog). Everything is drawn on the GPU.

import {
  apply_theme,
  load_theme,
  ui_renderer,
  ui_widgets,
  hex_to_normalized_rgba,
  create_text_view_state,
  type theme_definition,
  type dock_layout,
  type ui_color_rgba,
  type ui_input_text_state,
  type ui_scroll_state,
  type ui_text_view_line,
  // plugins
  dock_system,
  file_browser,
  create_file_browser_state,
  im_dialog,
  create_im_dialog_state,
  type file_node,
  type im_message,
} from '../src/index'
import { input_collector } from './input'
import theme_url from './theme.json?url'

const canvas = document.getElementById('app') as HTMLCanvasElement

function build_layout(): dock_layout {
  const leaf = (id: string, tabs: { id: string; title: string }[], active: string) =>
    ({ kind: 'leaf', id, tabs, active_tab_id: active, ox: 0, oy: 0, ow: 1, oh: 1 } as const)
  return {
    root: {
      kind: 'split',
      id: 'split-root',
      axis: 'horizontal',
      ratio: 0.2,
      left: leaf('leaf-files', [{ id: 'files', title: 'Explorer' }], 'files'),
      right: {
        kind: 'split',
        id: 'split-right',
        axis: 'horizontal',
        ratio: 0.64,
        left: {
          kind: 'split',
          id: 'split-center',
          axis: 'vertical',
          ratio: 0.64,
          left: leaf('leaf-main', [
            { id: 'gallery', title: 'Widgets' },
            { id: 'about', title: 'About' },
          ], 'gallery'),
          right: leaf('leaf-console', [{ id: 'console', title: 'Console' }], 'console'),
        },
        right: leaf('leaf-chat', [{ id: 'chat', title: 'Chat' }], 'chat'),
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
  { text: '  • dock_system  — drag tabs to reorder / split, drag splitters', color: '#9aa3b0' },
  { text: '  • file_browser — the Explorer panel on the left', color: '#9aa3b0' },
  { text: '  • im_dialog    — the Chat panel on the right', color: '#9aa3b0' },
  { text: '' },
  { text: 'Try: drag the "Widgets" tab onto another panel edge to split.', color: '#5fb878' },
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

// --- Persistent widget / plugin state -------------------------------------
const dock = new dock_system(build_layout())
const file_state = create_file_browser_state()
const chat_state = create_im_dialog_state()
const console_state = create_text_view_state()
const about_state = create_text_view_state()

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

async function main(): Promise<void> {
  const renderer = new ui_renderer(canvas)
  await renderer.init()
  const widgets = new ui_widgets(renderer)
  const theme: theme_definition = await load_theme(theme_url)
  apply_theme(theme)
  document.body.style.background = theme.palette.bg

  const input = new input_collector(canvas)
  const resize = () => renderer.resize()
  window.addEventListener('resize', resize)

  const clear = hex_to_normalized_rgba(theme.palette.bg)

  function frame(): void {
    const snapshot = input.begin_frame()
    const { width, height } = renderer.canvas_size()
    const scale = window.devicePixelRatio || 1
    const m = 8 * scale

    renderer.begin_frame()
    widgets.begin_frame(theme, snapshot)

    dock.frame(renderer, theme, snapshot, m, m, width - m * 2, height - m * 2, (panel) => {
      const inset = 0
      const px = panel.x + inset
      const py = panel.y + inset
      const pw = panel.w - inset * 2
      const ph = panel.h - inset * 2
      switch (panel.tab.id) {
        case 'files':
          render_files(renderer, widgets, theme, snapshot, px, py, pw, ph)
          break
        case 'gallery':
          render_gallery(renderer, widgets, theme, px, py, pw, ph, scale)
          break
        case 'about':
          widgets.text_view('about_view', px + 8 * scale, py + 8 * scale, pw - 16 * scale, ph - 16 * scale, about_lines, about_state, { wrap: true, background: false, read_only: true })
          break
        case 'console':
          widgets.text_view('console_view', px + 6 * scale, py + 6 * scale, pw - 12 * scale, ph - 12 * scale, console_lines, console_state, { wrap: true })
          break
        case 'chat':
          render_chat(renderer, widgets, theme, snapshot, px, py, pw, ph)
          break
      }
    })

    widgets.end_frame()
    renderer.flush(clear)
    input.end_frame()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

function render_files(
  renderer: ui_renderer,
  _widgets: ui_widgets,
  theme: theme_definition,
  snapshot: ReturnType<input_collector['begin_frame']>,
  x: number,
  y: number,
  w: number,
  h: number,
): void {
  const ev = file_browser(renderer, theme, snapshot, x, y, w, h, file_tree, file_state, { default_expanded: true })
  if (ev.activated) {
    console_lines.push({ text: `→ opened ${ev.activated.name}`, color: '#4c8bf5' })
    console_state.scroll_to_line = console_lines.length - 1
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
  const ev = im_dialog(renderer, widgets, theme, snapshot, x, y, w, h, chat_messages, chat_state, { title: 'Ada · online', placeholder: 'Message Ada…' })
  if (ev.sent) {
    chat_messages.push({ author: 'Me', side: 'right', text: ev.sent, timestamp: Date.now() })
    const reply = auto_replies[Math.floor(Math.random() * auto_replies.length)]
    window.setTimeout(() => {
      chat_messages.push({ author: 'Ada', side: 'left', text: reply, timestamp: Date.now() })
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
  _h: number,
  scale: number,
): void {
  const pad = 16 * scale
  const col_w = Math.min(360 * scale, w - pad * 2)
  let cy = y + pad
  const cx = x + pad
  const row = 34 * scale
  const gap = 12 * scale

  cy = widgets.section(cx, cy, col_w, 'BUTTONS') + 6 * scale
  if (widgets.button('g_btn', cx, cy, 120 * scale, 30 * scale, `Clicked ${gallery.clicks}×`)) gallery.clicks += 1
  widgets.button('g_btn2', cx + 132 * scale, cy, 120 * scale, 30 * scale, 'Secondary', { active: gallery.clicks % 2 === 1 })
  cy += row + gap

  cy = widgets.section(cx, cy, col_w, 'TOGGLES') + 6 * scale
  gallery.toggle_a = widgets.toggle('g_tg_a', cx, cy, gallery.toggle_a, 'Enable shadows')
  cy += 26 * scale
  gallery.toggle_b = widgets.toggle('g_tg_b', cx, cy, gallery.toggle_b, 'Wireframe overlay')
  cy += row + gap

  cy = widgets.section(cx, cy, col_w, 'SLIDER') + 10 * scale
  gallery.slider = widgets.slider('g_sl', cx, cy, col_w - 60 * scale, 18 * scale, gallery.slider, 0, 1, true)
  cy += row + gap

  cy = widgets.section(cx, cy, col_w, 'DROPDOWN') + 6 * scale
  gallery.dropdown = widgets.dropdown('g_dd', cx, cy, 180 * scale, 28 * scale, ['Low', 'Medium', 'High', 'Ultra'], gallery.dropdown)
  cy += row + gap

  cy = widgets.section(cx, cy, col_w, 'TEXT INPUT') + 6 * scale
  gallery.input = widgets.input_field('g_in', cx, cy, col_w, 30 * scale, gallery.input, 'Type something…', gallery.input_state)
  cy += row + gap

  cy = widgets.section(cx, cy, col_w, 'COLOR') + 6 * scale
  gallery.color = widgets.ui_color_picker('g_col', cx, cy, 180 * scale, 28 * scale, gallery.color)
}

main().catch((err) => {
  console.error(err)
  const el = document.getElementById('error')
  if (el) {
    el.style.display = 'block'
    el.textContent = `${err}`
  }
})
