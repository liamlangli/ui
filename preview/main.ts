// @liamlangli/ui — interactive preview / playground.
//
// Boots the WebGPU renderer and lays the whole demo out inside the `dock_system`
// plugin: an Explorer (file_browser), an Editor (code_editor), a Widgets
// gallery, a Console (text_view), an About panel, and a Chat panel (im_dialog).
// Everything is drawn on the GPU.

import {
  apply_theme,
  load_theme,
  lerp_theme,
  default_themes,
  ui_renderer,
  ui_widgets,
  hex_to_normalized_rgba,
  pack_color,
  create_text_view_state,
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
  file_browser,
  create_file_browser_state,
  im_dialog,
  create_im_dialog_state,
  code_editor,
  create_code_editor_state,
  text_buffer,
  type editor_token,
  type editor_token_kind,
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
            { id: 'editor', title: 'Editor' },
            { id: 'gallery', title: 'Widgets' },
            { id: 'about', title: 'About' },
          ], 'editor'),
          right: leaf('leaf-console', [
            { id: 'console', title: 'Console' },
            { id: 'metrics', title: 'Metrics' },
          ], 'metrics'),
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
  { text: '  • code_editor  — the Editor tab (type, select, syntax-highlight)', color: '#9aa3b0' },
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
  const widgets = new ui_widgets(renderer)
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

    dock.frame(renderer, theme, snapshot, safe.x + m, safe.y + m, safe.w - m * 2, safe.h - m * 2, (panel) => {
      const inset = 0
      const px = panel.x + inset
      const py = panel.y + inset
      const pw = panel.w - inset * 2
      const ph = panel.h - inset * 2
      switch (panel.tab.id) {
        case 'files':
          render_files(renderer, widgets, theme, snapshot, px, py, pw, ph)
          break
        case 'editor':
          code_editor(renderer, theme, snapshot, px, py, pw, ph, editor_buffer, editor_state, { tokenize: demo_tokenize })
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
        case 'metrics':
          render_metrics(renderer, theme, px, py, pw, ph, scale)
          break
        case 'chat':
          render_chat(renderer, widgets, theme, snapshot, px, py, pw, ph)
          break
      }
    })

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

  cy = widgets.section(cx, cy, col_w, 'THEME') + 6 * scale
  const theme_names = theme_ctrl.presets.map((p) => p.name)
  const picked = widgets.dropdown('g_theme', cx, cy, 200 * scale, 28 * scale, theme_names, theme_ctrl.index)
  if (picked !== theme_ctrl.index) transition_theme_to(picked, performance.now())
  cy += row + gap

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
  const cell_w = Math.max(1, (w - cell_gap * (items.length - 1)) / items.length)
  for (let i = 0; i < items.length; i += 1) {
    const px = x + i * (cell_w + cell_gap)
    renderer.fill_rect(px, y, cell_w, h, pack_color(theme.palette.panel_alt))
    renderer.stroke_rect(px, y, cell_w, h, 1, pack_color(theme.palette.border))
    renderer.push_clip(px + 7 * scale, y, Math.max(0, cell_w - 14 * scale), h)
    renderer.draw_text(px + 7 * scale, renderer.text_v_center_y(y, h, 10.5 * scale), items[i] ?? '', 10.5 * scale, pack_color(theme.palette.text), FONT_MONO)
    renderer.pop_clip()
  }
}

function draw_chart_frame(renderer: ui_renderer, theme: theme_definition, x: number, y: number, w: number, h: number, scale: number): void {
  renderer.fill_rect(x, y, w, h, pack_color(theme.palette.track))
  renderer.stroke_rect(x, y, w, h, 1, pack_color(theme.palette.border))
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
  renderer.fill_rect(px, y + 8 * scale, dot, dot, pack_color(color))
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
  renderer.fill_rect(x, bar_y, w, bar_h, pack_color(theme.palette.track))
  renderer.fill_rect(x, bar_y, w * ratio, bar_h, total > 0 ? pack_color(theme.palette.accent) : pack_color(theme.palette.ghost))
  renderer.stroke_rect(x, bar_y, w, bar_h, 1, pack_color(theme.palette.border))
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
