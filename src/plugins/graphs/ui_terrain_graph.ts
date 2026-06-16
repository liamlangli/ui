// terrain_graph - node-based base terrain generator.
//
// A reusable terrain authoring panel built on the generic graph_canvas plugin.
// It ports the core data model and CPU evaluator from ~/os/li so apps can edit
// a procedural terrain graph, inspect node params, and preview the generated
// height/ecology fields without depending on the li renderer.

import { pack_color } from '../../core/ui_theme'
import type { theme_definition, theme_slot } from '../../core/ui_types'
import { FONT_MONO, type ui_renderer } from '../../core/ui_renderer'
import type { ui_input_snapshot, ui_scroll_state, ui_widgets } from '../../core/ui_widgets'
import {
  create_graph_state,
  graph_canvas,
  type graph_body_rect,
  type graph_link,
  type graph_node_base,
  type graph_node_view,
  type graph_state,
} from './ui_graph'

export interface terrain_graph_node extends graph_node_base {
  id: string
  type: string
  x: number
  y: number
  params: Record<string, number>
  label?: string
}

export interface terrain_graph_connection {
  from_node: string
  from_port: string
  to_node: string
  to_port: string
}

export interface terrain_graph {
  nodes: terrain_graph_node[]
  connections: terrain_graph_connection[]
  seed: number
}

export interface terrain_eval_context {
  wx: number
  wz: number
  nx: number
  nz: number
  seed: number
}

export interface terrain_port_def {
  id: string
  name: string
  default?: number
}

export interface terrain_param_def {
  id: string
  label: string
  default: number
  min: number
  max: number
  step?: number
}

export interface terrain_node_type_def {
  type: string
  label: string
  category: string
  color: string
  inputs: terrain_port_def[]
  outputs: terrain_port_def[]
  params: terrain_param_def[]
  evaluate(inputs: Record<string, number>, params: Record<string, number>, ctx: terrain_eval_context): Record<string, number>
}

export interface terrain_graph_sample {
  height: number
  moisture: number
  vegetation: number
  rock: number
  volcanic: number
}

export interface terrain_graph_state {
  graph_state: graph_state
  selected_node_id: string | null
  menu: { x: number; y: number; graph_x: number; graph_y: number } | null
  preview_mode: 'height' | 'moisture' | 'vegetation' | 'rock' | 'volcanic'
  preview_res: number
  preview: Float32Array
  preview_dirty: boolean
  scroll: ui_scroll_state
}

export interface terrain_graph_event {
  changed?: boolean
  graph?: terrain_graph
  selected_node_id?: string | null
}

export interface terrain_graph_options {
  scale?: number
  preview_res?: number
}

export const TERRAIN_NODE_REGISTRY = new Map<string, terrain_node_type_def>()

export function register_terrain_node_type(def: terrain_node_type_def): void {
  TERRAIN_NODE_REGISTRY.set(def.type, def)
}

export function create_terrain_graph_state(): terrain_graph_state {
  return {
    graph_state: create_graph_state(),
    selected_node_id: null,
    menu: null,
    preview_mode: 'height',
    preview_res: 64,
    preview: new Float32Array(64 * 64),
    preview_dirty: true,
    scroll: { offset_y: 0 },
  }
}

export function create_default_terrain_graph(): terrain_graph {
  return {
    seed: 1337,
    nodes: [
      {
        id: 'heightmap_layout',
        type: 'heightmap_island',
        x: 120,
        y: 110,
        params: {
          mountainHeight: 2.2,
          seaFloor: -0.55,
          shoreLevel: 0.3,
          lakeLift: 0.55,
          landGamma: 1.35,
          trenchDepth: -1.4,
          detailStrength: 0.08,
          detailScale: 0.22,
          edgeSinkStart: 0.4,
          edgeSinkEnd: 0.5,
        },
        label: 'Heightmap Island',
      },
      { id: 'output', type: 'terrain_output', x: 440, y: 145, params: {} },
    ],
    connections: [
      { from_node: 'heightmap_layout', from_port: 'height', to_node: 'output', to_port: 'height' },
      { from_node: 'heightmap_layout', from_port: 'moisture', to_node: 'output', to_port: 'moisture' },
      { from_node: 'heightmap_layout', from_port: 'vegetation', to_node: 'output', to_port: 'vegetation' },
      { from_node: 'heightmap_layout', from_port: 'rock', to_node: 'output', to_port: 'rock' },
      { from_node: 'heightmap_layout', from_port: 'volcanic', to_node: 'output', to_port: 'volcanic' },
    ],
  }
}

export function terrain_graph_generator(
  ui: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  graph: terrain_graph,
  state: terrain_graph_state,
  options?: terrain_graph_options,
): terrain_graph_event {
  ensure_builtin_terrain_nodes()
  const scale = options?.scale ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
  const event: terrain_graph_event = { graph }
  const col = (slot: theme_slot) => pack_color(theme.palette[slot])
  const panel = col('panel')
  const panel_alt = col('panel_alt')
  const text = col('text')
  const dim = col('text_dim')
  const border = col('border')
  const accent = col('accent')
  const m = 8 * scale
  const toolbar_h = 34 * scale
  const side_w = w >= 650 * scale ? Math.min(294 * scale, Math.floor(w * 0.34)) : 0
  const graph_w = Math.max(40 * scale, w - side_w)

  ui.fill_rect(x, y, w, h, panel)
  ui.fill_rect(x, y, graph_w, toolbar_h, panel_alt)
  ui.stroke_rect(x, y + toolbar_h - 1, graph_w, 1, 1, border)
  ui.draw_text(x + m, ui.text_v_center_y(y, toolbar_h, 10 * scale), 'Terrain Graph', 10 * scale, text)

  let bx = x + Math.max(118 * scale, graph_w - 262 * scale)
  if (widgets.button('tg_reset', bx, y + 5 * scale, 64 * scale, 24 * scale, 'Reset')) {
    const next = create_default_terrain_graph()
    graph.nodes.splice(0, graph.nodes.length, ...next.nodes)
    graph.connections.splice(0, graph.connections.length, ...next.connections)
    graph.seed = next.seed
    state.graph_state.selected.clear()
    state.selected_node_id = null
    mark_terrain_graph_changed(state, event)
  }
  bx += 70 * scale
  const modes: terrain_graph_state['preview_mode'][] = ['height', 'moisture', 'vegetation', 'rock', 'volcanic']
  const mode_index = widgets.dropdown('tg_mode', bx, y + 5 * scale, 108 * scale, 24 * scale, modes, Math.max(0, modes.indexOf(state.preview_mode)))
  if (modes[mode_index] && modes[mode_index] !== state.preview_mode) {
    state.preview_mode = modes[mode_index]!
    state.preview_dirty = true
  }
  bx += 114 * scale
  if (widgets.button('tg_random_seed', bx, y + 5 * scale, 68 * scale, 24 * scale, 'Seed')) {
    graph.seed = Math.floor(Math.random() * 100_000)
    mark_terrain_graph_changed(state, event)
  }

  const links = to_graph_links(graph)
  const gev = graph_canvas(ui, theme, input, x, y + toolbar_h, graph_w, h - toolbar_h, graph.nodes, links, state.graph_state, terrain_node_view, {
    node_w: 142,
    compatible: (a, b) => a === b || a === 'scalar' || b === 'scalar',
    header_color: (node) => pack_hex(TERRAIN_NODE_REGISTRY.get(node.type)?.color ?? '#303846'),
    pin_color: terrain_pin_color,
    link_color: terrain_link_color,
    render_body: (node, _view, body) => draw_terrain_node_body(ui, graph, node, body, state.preview_mode),
  })
  graph.connections = from_graph_links(graph, links)
  if (gev.node_pressed) {
    state.selected_node_id = String(gev.node_pressed)
    event.selected_node_id = state.selected_node_id
  }
  if (gev.selection_changed && state.graph_state.selected.size === 0) {
    state.selected_node_id = null
    event.selected_node_id = null
  }
  if (gev.menu_requested) state.menu = { x: gev.menu_requested.screen_x, y: gev.menu_requested.screen_y, graph_x: gev.menu_requested.graph_x, graph_y: gev.menu_requested.graph_y }
  if (gev.delete_requested) {
    for (const id of [...state.graph_state.selected]) {
      if (String(id) === 'output') continue
      graph.nodes = graph.nodes.filter((node) => node.id !== id)
      graph.connections = graph.connections.filter((c) => c.from_node !== id && c.to_node !== id)
    }
    state.graph_state.selected.clear()
    state.selected_node_id = null
    mark_terrain_graph_changed(state, event)
  }
  if (gev.link_created || gev.link_removed || gev.nodes_moved) mark_terrain_graph_changed(state, event)

  if (state.menu) {
    const picked = draw_create_menu(ui, theme, input, state.menu, scale)
    if (picked) {
      add_terrain_node(graph, picked, state.menu.graph_x, state.menu.graph_y, state)
      state.menu = null
      mark_terrain_graph_changed(state, event)
    } else if ((input.mouse_pressed || input.mouse_right_pressed) && !point_in(input.mouse_x, input.mouse_y, state.menu.x, state.menu.y, 220 * scale, menu_height(scale))) {
      state.menu = null
    } else if (input.key_escape) {
      state.menu = null
    }
  }

  if (side_w > 0) {
    draw_side_panel(ui, widgets, theme, input, x + graph_w, y, side_w, h, graph, state, scale, event)
  }

  return event
}

export function evaluate_terrain_graph_at(graph: terrain_graph, ctx: terrain_eval_context): terrain_graph_sample {
  ensure_builtin_terrain_nodes()
  const order = topo_sort(graph)
  const conn_map = new Map<string, { from_node: string; from_port: string }>()
  for (const c of graph.connections) conn_map.set(`${c.to_node}::${c.to_port}`, { from_node: c.from_node, from_port: c.from_port })
  const node_map = new Map(graph.nodes.map((node) => [node.id, node]))
  const cache = new Map<string, Record<string, number>>()
  for (const node_id of order) {
    const node = node_map.get(node_id)
    if (!node) continue
    const def = TERRAIN_NODE_REGISTRY.get(node.type)
    if (!def) continue
    const inputs: Record<string, number> = {}
    for (const port of def.inputs) {
      const conn = conn_map.get(`${node.id}::${port.id}`)
      inputs[port.id] = conn ? cache.get(conn.from_node)?.[conn.from_port] ?? port.default ?? 0 : port.default ?? 0
    }
    cache.set(node.id, def.evaluate(inputs, node.params, ctx))
  }
  const result: terrain_graph_sample = { height: 0, moisture: 0.5, vegetation: 0.5, rock: 0, volcanic: 0 }
  for (const node of graph.nodes) {
    if (node.type !== 'terrain_output') continue
    const out = cache.get(node.id)
    if (out) {
      result.height = out.height ?? result.height
      result.moisture = out.moisture ?? result.moisture
      result.vegetation = out.vegetation ?? result.vegetation
      result.rock = out.rock ?? result.rock
      result.volcanic = out.volcanic ?? result.volcanic
    }
  }
  return result
}

function draw_side_panel(
  ui: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  graph: terrain_graph,
  state: terrain_graph_state,
  scale: number,
  event: terrain_graph_event,
): void {
  const col = (slot: theme_slot) => pack_color(theme.palette[slot])
  const pad = 10 * scale
  const preview_h = Math.min(230 * scale, Math.max(120 * scale, w - pad * 2))
  ui.fill_rect(x, y, w, h, col('panel'))
  ui.stroke_rect(x, y, 1, h, 1, col('border'))
  ui.draw_text(x + pad, y + pad, 'Preview', 10 * scale, col('text'))
  draw_preview(ui, graph, state, x + pad, y + 28 * scale, w - pad * 2, preview_h, scale)

  let cy = y + 28 * scale + preview_h + 12 * scale - state.scroll.offset_y
  const content_top = y + 28 * scale + preview_h + 8 * scale
  ui.push_clip(x, content_top, w, Math.max(0, h - (content_top - y)))
  ui.draw_text(x + pad, cy, 'Seed', 8.5 * scale, col('text_dim'))
  const next_seed = widgets.slider('tg_seed_slider', x + pad, cy + 15 * scale, w - pad * 2, 14 * scale, graph.seed, 0, 9999, true)
  if (Math.round(next_seed) !== graph.seed) {
    graph.seed = Math.round(next_seed)
    mark_terrain_graph_changed(state, event)
  }
  cy += 40 * scale

  const selected = selected_terrain_node(graph, state)
  if (!selected) {
    ui.draw_text_wrapped(x + pad, cy, w - pad * 2, 'Select a node to edit its parameters. Right-click the graph to create nodes; drag pins to wire them.', 9 * scale, col('text_dim'))
    cy += 54 * scale
  } else {
    const def = TERRAIN_NODE_REGISTRY.get(selected.type)
    ui.draw_text(x + pad, cy, selected.label ?? def?.label ?? selected.type, 10 * scale, col('text'))
    cy += 20 * scale
    if (def && def.params.length > 0) {
      for (const param of def.params) {
        const value = selected.params[param.id] ?? param.default
        ui.draw_text(x + pad, cy, param.label, 8.5 * scale, col('text_dim'))
        const value_text = param.step === 1 ? `${Math.round(value)}` : value.toFixed(2)
        const value_w = ui.text_width(value_text, 8.5 * scale, FONT_MONO)
        ui.draw_text(x + w - pad - value_w, cy, value_text, 8.5 * scale, col('text'), FONT_MONO)
        const next = widgets.slider(`tg_param_${selected.id}_${param.id}`, x + pad, cy + 15 * scale, w - pad * 2, 14 * scale, value, param.min, param.max)
        const snapped = param.step === 1 ? Math.round(next) : next
        if (snapped !== value) {
          selected.params[param.id] = snapped
          mark_terrain_graph_changed(state, event)
        }
        cy += 40 * scale
      }
    } else {
      ui.draw_text(x + pad, cy, 'No parameters', 8.5 * scale, col('text_dim'))
      cy += 22 * scale
    }
  }
  ui.pop_clip()
  const content_h = Math.max(h, cy + state.scroll.offset_y - content_top + 12 * scale)
  if (content_h > h - (content_top - y)) {
    widgets.scrollbar('tg_side_scroll', x + w - 8 * scale, content_top, 6 * scale, h - (content_top - y) - 4 * scale, state.scroll, content_h)
  }
}

function draw_preview(ui: ui_renderer, graph: terrain_graph, state: terrain_graph_state, x: number, y: number, w: number, h: number, scale: number): void {
  const res = Math.max(16, Math.min(128, Math.round(state.preview_res || 64)))
  if (state.preview.length !== res * res) {
    state.preview = new Float32Array(res * res)
    state.preview_dirty = true
  }
  if (state.preview_dirty) {
    for (let py = 0; py < res; py += 1) {
      for (let px = 0; px < res; px += 1) {
        const nx = px / (res - 1) - 0.5
        const nz = py / (res - 1) - 0.5
        const sample = evaluate_terrain_graph_at(graph, { wx: nx * 112, wz: nz * 112, nx, nz, seed: graph.seed })
        state.preview[py * res + px] = sample[state.preview_mode]
      }
    }
    state.preview_dirty = false
  }
  ui.fill_rect(x, y, w, h, pack_hex('#0b1118'))
  const cell_w = Math.max(1, Math.ceil(w / res))
  const cell_h = Math.max(1, Math.ceil(h / res))
  for (let py = 0; py < res; py += 1) {
    for (let px = 0; px < res; px += 1) {
      const v = state.preview[py * res + px]!
      ui.fill_rect(x + (px / res) * w, y + (py / res) * h, cell_w, cell_h, terrain_preview_color(v, state.preview_mode))
    }
  }
  ui.stroke_rect(x, y, w, h, 1 * scale, pack_hex('#6f7888'))
  ui.draw_text(x + 7 * scale, y + 7 * scale, state.preview_mode, 8.5 * scale, 0xfff0f6ff)
}

function terrain_node_view(node: terrain_graph_node): graph_node_view {
  const def = TERRAIN_NODE_REGISTRY.get(node.type)
  return {
    title: node.label ?? def?.label ?? node.type,
    inputs: (def?.inputs ?? []).map((p) => ({ label: p.name, kind: terrain_port_kind(p.id) })),
    outputs: (def?.outputs ?? []).map((p) => ({ label: p.name, kind: terrain_port_kind(p.id) })),
    body_rows: Math.min(2, Math.ceil((def?.params.length ?? 0) / 3)),
  }
}

function draw_terrain_node_body(ui: ui_renderer, graph: terrain_graph, node: terrain_graph_node, body: graph_body_rect, mode: terrain_graph_state['preview_mode']): void {
  const sample = evaluate_terrain_graph_at(graph, { wx: 0, wz: 0, nx: 0, nz: 0, seed: graph.seed })
  const value = sample[mode] ?? 0
  const label = `${mode}: ${value.toFixed(2)}`
  ui.draw_text(body.x + 5 * body.gs, body.y + 3 * body.gs, label, 5.8 * body.gs, 0xccf3f6ff, FONT_MONO)
  const bar_w = Math.max(0, body.w - 10 * body.gs)
  const t = clamp(mode === 'height' ? (value + 1.4) / 3.8 : value, 0, 1)
  ui.fill_rect(body.x + 5 * body.gs, body.y + 14 * body.gs, bar_w, 3 * body.gs, 0x55333a44)
  ui.fill_rect(body.x + 5 * body.gs, body.y + 14 * body.gs, bar_w * t, 3 * body.gs, terrain_preview_color(value, mode))
}

function draw_create_menu(ui: ui_renderer, theme: theme_definition, input: ui_input_snapshot, menu: terrain_graph_state['menu'], scale: number): string | null {
  if (!menu) return null
  const defs = [...TERRAIN_NODE_REGISTRY.values()].filter((def) => def.type !== 'terrain_output')
  const by_category = new Map<string, terrain_node_type_def[]>()
  for (const def of defs) {
    const list = by_category.get(def.category)
    if (list) list.push(def)
    else by_category.set(def.category, [def])
  }
  const col = (slot: theme_slot) => pack_color(theme.palette[slot])
  const w = 220 * scale
  const row_h = 22 * scale
  let cy = menu.y
  ui.fill_round_rect(menu.x, menu.y, w, menu_height(scale), 6 * scale, col('panel'))
  ui.stroke_round_rect(menu.x, menu.y, w, menu_height(scale), 6 * scale, 1, col('border'))
  for (const [category, list] of by_category) {
    ui.draw_text(menu.x + 9 * scale, cy + 7 * scale, category.toUpperCase(), 7 * scale, col('text_dim'))
    cy += 18 * scale
    for (const def of list) {
      const hover = point_in(input.mouse_x, input.mouse_y, menu.x + 4 * scale, cy, w - 8 * scale, row_h)
      if (hover) ui.fill_round_rect(menu.x + 4 * scale, cy, w - 8 * scale, row_h, 4 * scale, col('hover'))
      ui.fill_rect(menu.x + 10 * scale, cy + 7 * scale, 8 * scale, 8 * scale, pack_hex(def.color))
      ui.draw_text(menu.x + 24 * scale, ui.text_v_center_y(cy, row_h, 8.5 * scale), def.label, 8.5 * scale, col('text'))
      if (hover && input.mouse_pressed) return def.type
      cy += row_h
    }
    cy += 4 * scale
  }
  return null
}

function menu_height(scale: number): number {
  let h = 10 * scale
  const categories = new Set([...TERRAIN_NODE_REGISTRY.values()].filter((def) => def.type !== 'terrain_output').map((def) => def.category))
  h += categories.size * 22 * scale
  h += [...TERRAIN_NODE_REGISTRY.values()].filter((def) => def.type !== 'terrain_output').length * 22 * scale
  return h
}

function add_terrain_node(graph: terrain_graph, type: string, x: number, y: number, state: terrain_graph_state): void {
  const def = TERRAIN_NODE_REGISTRY.get(type)
  if (!def) return
  const base = type.replace(/[^a-z0-9_]/gi, '_')
  let i = graph.nodes.length + 1
  let id = `${base}_${i}`
  while (graph.nodes.some((node) => node.id === id)) id = `${base}_${++i}`
  const params: Record<string, number> = {}
  for (const param of def.params) params[param.id] = param.default
  graph.nodes.push({ id, type, x, y, params })
  state.graph_state.selected.clear()
  state.graph_state.selected.add(id)
  state.selected_node_id = id
}

function selected_terrain_node(graph: terrain_graph, state: terrain_graph_state): terrain_graph_node | null {
  const id = state.selected_node_id ?? String(state.graph_state.selected.values().next().value ?? '')
  return graph.nodes.find((node) => node.id === id) ?? null
}

function mark_terrain_graph_changed(state: terrain_graph_state, event: terrain_graph_event): void {
  state.preview_dirty = true
  event.changed = true
}

function to_graph_links(graph: terrain_graph): graph_link[] {
  const links: graph_link[] = []
  for (const c of graph.connections) {
    const from = graph.nodes.find((node) => node.id === c.from_node)
    const to = graph.nodes.find((node) => node.id === c.to_node)
    const from_def = from ? TERRAIN_NODE_REGISTRY.get(from.type) : undefined
    const to_def = to ? TERRAIN_NODE_REGISTRY.get(to.type) : undefined
    const src_pin = from_def?.outputs.findIndex((p) => p.id === c.from_port) ?? -1
    const dst_pin = to_def?.inputs.findIndex((p) => p.id === c.to_port) ?? -1
    if (src_pin >= 0 && dst_pin >= 0) links.push({ src_node: c.from_node, src_pin, dst_node: c.to_node, dst_pin })
  }
  return links
}

function from_graph_links(graph: terrain_graph, links: graph_link[]): terrain_graph_connection[] {
  const result: terrain_graph_connection[] = []
  for (const link of links) {
    const from = graph.nodes.find((node) => node.id === link.src_node)
    const to = graph.nodes.find((node) => node.id === link.dst_node)
    const from_port = from ? TERRAIN_NODE_REGISTRY.get(from.type)?.outputs[link.src_pin]?.id : undefined
    const to_port = to ? TERRAIN_NODE_REGISTRY.get(to.type)?.inputs[link.dst_pin]?.id : undefined
    if (from && to && from_port && to_port) result.push({ from_node: from.id, from_port, to_node: to.id, to_port })
  }
  return result
}

function topo_sort(graph: terrain_graph): string[] {
  const in_deg = new Map<string, number>()
  const adj = new Map<string, string[]>()
  for (const node of graph.nodes) {
    in_deg.set(node.id, 0)
    adj.set(node.id, [])
  }
  for (const c of graph.connections) {
    adj.get(c.from_node)?.push(c.to_node)
    in_deg.set(c.to_node, (in_deg.get(c.to_node) ?? 0) + 1)
  }
  const queue = [...in_deg.entries()].filter(([, d]) => d === 0).map(([id]) => id)
  const order: string[] = []
  while (queue.length) {
    const id = queue.shift()!
    order.push(id)
    for (const next of adj.get(id) ?? []) {
      const d = (in_deg.get(next) ?? 0) - 1
      in_deg.set(next, d)
      if (d === 0) queue.push(next)
    }
  }
  return order.length === graph.nodes.length ? order : graph.nodes.map((node) => node.id)
}

let builtins_registered = false

function ensure_builtin_terrain_nodes(): void {
  if (builtins_registered) return
  builtins_registered = true
  register_terrain_node_type({
    type: 'coordinate',
    label: 'Coordinate',
    category: 'Source',
    color: '#2d4a6e',
    inputs: [],
    outputs: [{ id: 'nx', name: 'NX' }, { id: 'nz', name: 'NZ' }, { id: 'wx', name: 'WX' }, { id: 'wz', name: 'WZ' }, { id: 'radial', name: 'Radial' }],
    params: [],
    evaluate(_i, _p, ctx) { return { nx: ctx.nx, nz: ctx.nz, wx: ctx.wx, wz: ctx.wz, radial: Math.hypot(ctx.nx, ctx.nz) } },
  })
  register_terrain_node_type({
    type: 'constant',
    label: 'Constant',
    category: 'Source',
    color: '#2d4a6e',
    inputs: [],
    outputs: [{ id: 'value', name: 'Value' }],
    params: [{ id: 'value', label: 'Value', default: 0, min: -10, max: 10, step: 0.01 }],
    evaluate(_i, p) { return { value: p.value ?? 0 } },
  })
  register_terrain_node_type({
    type: 'fbm',
    label: 'FBM Noise',
    category: 'Noise',
    color: '#1a4a3a',
    inputs: [{ id: 'x', name: 'X', default: 0 }, { id: 'z', name: 'Z', default: 0 }, { id: 'offsetX', name: 'Offset X', default: 0 }, { id: 'offsetZ', name: 'Offset Z', default: 0 }],
    outputs: [{ id: 'value', name: 'Value' }],
    params: [{ id: 'scale', label: 'Scale', default: 1, min: 0.001, max: 20, step: 0.01 }, { id: 'octaves', label: 'Octaves', default: 6, min: 1, max: 10, step: 1 }, { id: 'seedOffset', label: 'Seed+', default: 0, min: 0, max: 1000, step: 1 }],
    evaluate(inp, p, ctx) {
      const x = (inp.x !== 0 ? inp.x : ctx.wx) + (inp.offsetX ?? 0)
      const z = (inp.z !== 0 ? inp.z : ctx.wz) + (inp.offsetZ ?? 0)
      return { value: fbm_noise(x, z, ctx.seed + (p.seedOffset ?? 0), p.octaves ?? 6, p.scale ?? 1) }
    },
  })
  register_terrain_node_type({
    type: 'ridge_noise',
    label: 'Ridge Noise',
    category: 'Noise',
    color: '#1a4a3a',
    inputs: [{ id: 'x', name: 'X', default: 0 }, { id: 'z', name: 'Z', default: 0 }, { id: 'offsetX', name: 'Offset X', default: 0 }, { id: 'offsetZ', name: 'Offset Z', default: 0 }],
    outputs: [{ id: 'value', name: 'Value' }],
    params: [{ id: 'scale', label: 'Scale', default: 1, min: 0.001, max: 20, step: 0.01 }, { id: 'octaves', label: 'Octaves', default: 6, min: 1, max: 10, step: 1 }, { id: 'seedOffset', label: 'Seed+', default: 0, min: 0, max: 1000, step: 1 }],
    evaluate(inp, p, ctx) {
      const x = (inp.x !== 0 ? inp.x : ctx.wx) + (inp.offsetX ?? 0)
      const z = (inp.z !== 0 ? inp.z : ctx.wz) + (inp.offsetZ ?? 0)
      return { value: 1 - Math.abs(fbm_noise(x, z, ctx.seed + (p.seedOffset ?? 0), p.octaves ?? 6, p.scale ?? 1) * 2 - 1) }
    },
  })
  register_terrain_node_type({
    type: 'math_add',
    label: 'Add',
    category: 'Math',
    color: '#3a2d5e',
    inputs: [{ id: 'a', name: 'A', default: 0 }, { id: 'b', name: 'B', default: 0 }],
    outputs: [{ id: 'value', name: 'A+B' }],
    params: [],
    evaluate(inp) { return { value: inp.a + inp.b } },
  })
  register_terrain_node_type({
    type: 'math_multiply',
    label: 'Multiply',
    category: 'Math',
    color: '#3a2d5e',
    inputs: [{ id: 'a', name: 'A', default: 1 }, { id: 'b', name: 'B', default: 1 }],
    outputs: [{ id: 'value', name: 'A*B' }],
    params: [],
    evaluate(inp) { return { value: inp.a * inp.b } },
  })
  register_terrain_node_type({
    type: 'math_mix',
    label: 'Mix',
    category: 'Math',
    color: '#3a2d5e',
    inputs: [{ id: 'a', name: 'A', default: 0 }, { id: 'b', name: 'B', default: 1 }, { id: 't', name: 'T', default: 0.5 }],
    outputs: [{ id: 'value', name: 'Mix' }],
    params: [],
    evaluate(inp) { return { value: mix(inp.a, inp.b, clamp(inp.t, 0, 1)) } },
  })
  register_terrain_node_type({
    type: 'math_clamp',
    label: 'Clamp',
    category: 'Math',
    color: '#3a2d5e',
    inputs: [{ id: 'value', name: 'Value', default: 0 }],
    outputs: [{ id: 'value', name: 'Clamped' }],
    params: [{ id: 'min', label: 'Min', default: 0, min: -10, max: 10, step: 0.01 }, { id: 'max', label: 'Max', default: 1, min: -10, max: 10, step: 0.01 }],
    evaluate(inp, p) { return { value: clamp(inp.value, p.min ?? 0, p.max ?? 1) } },
  })
  register_terrain_node_type({
    type: 'island_mask',
    label: 'Island Mask',
    category: 'Shape',
    color: '#4a3010',
    inputs: [],
    outputs: [{ id: 'island', name: 'Island' }, { id: 'shelf', name: 'Shelf' }, { id: 'shape', name: 'Shape' }],
    params: [{ id: 'islandRadius', label: 'Island Radius', default: 0.5, min: 0.1, max: 1, step: 0.01 }, { id: 'shelfRadius', label: 'Shelf Radius', default: 0.76, min: 0.2, max: 2, step: 0.01 }, { id: 'stretchX', label: 'Stretch X', default: 1.08, min: 0.5, max: 2, step: 0.01 }, { id: 'stretchZ', label: 'Stretch Z', default: 0.92, min: 0.5, max: 2, step: 0.01 }],
    evaluate(_i, p, ctx) {
      const radial = Math.hypot(ctx.nx * (p.stretchX ?? 1.08), ctx.nz * (p.stretchZ ?? 0.92))
      const island = smoothstep(p.islandRadius ?? 0.5, (p.islandRadius ?? 0.5) * 0.38, radial)
      const shelf = smoothstep(p.shelfRadius ?? 0.76, (p.islandRadius ?? 0.5) * 0.68, radial)
      return { island, shelf, shape: island * smoothstep(0.05, 0.8, shelf) }
    },
  })
  register_terrain_node_type({
    type: 'ring_shape',
    label: 'Ring Shape',
    category: 'Shape',
    color: '#1a5e3a',
    inputs: [{ id: 'noiseDisplace', name: 'Displace', default: 0 }],
    outputs: [{ id: 'ring', name: 'Ring' }, { id: 'height', name: 'Height' }, { id: 'islandMask', name: 'Island' }],
    params: [{ id: 'ringRadius', label: 'Ring Radius', default: 0.31, min: 0.05, max: 0.8, step: 0.01 }, { id: 'ringWidth', label: 'Ring Width', default: 0.13, min: 0.02, max: 0.45, step: 0.01 }, { id: 'displaceStrength', label: 'Displace Str', default: 0.24, min: 0, max: 0.6, step: 0.01 }],
    evaluate(inp, p, ctx) {
      const r = Math.hypot(ctx.nx, ctx.nz) + (inp.noiseDisplace ?? 0) * (p.displaceStrength ?? 0.24)
      const ring = smoothstep(p.ringWidth ?? 0.13, 0, Math.abs(r - (p.ringRadius ?? 0.31)))
      return { ring, height: Math.pow(Math.max(ring, 0.001), 1.6), islandMask: smoothstep((p.ringWidth ?? 0.13) * 2.35, (p.ringWidth ?? 0.13) * 0.12, Math.abs(r - (p.ringRadius ?? 0.31))) }
    },
  })
  register_terrain_node_type({
    type: 'heightmap_island',
    label: 'Heightmap Island',
    category: 'Shape',
    color: '#1f6b58',
    inputs: [],
    outputs: [{ id: 'height', name: 'Height' }, { id: 'moisture', name: 'Moisture' }, { id: 'vegetation', name: 'Vegetation' }, { id: 'rock', name: 'Rock' }, { id: 'volcanic', name: 'Volcanic' }, { id: 'landMask', name: 'Land Mask' }],
    params: [
      { id: 'mountainHeight', label: 'Mountain H', default: 2.2, min: 0.4, max: 3.5, step: 0.01 },
      { id: 'seaFloor', label: 'Sea Floor', default: -0.55, min: -2, max: 0, step: 0.01 },
      { id: 'shoreLevel', label: 'Shore Level', default: 0.3, min: 0.05, max: 0.7, step: 0.01 },
      { id: 'lakeLift', label: 'Lake Lift', default: 0.55, min: 0.2, max: 1, step: 0.01 },
      { id: 'landGamma', label: 'Land Gamma', default: 1.35, min: 0.5, max: 3, step: 0.05 },
      { id: 'trenchDepth', label: 'Trench Depth', default: -1.4, min: -2.5, max: -0.2, step: 0.01 },
      { id: 'detailStrength', label: 'Detail Strength', default: 0.08, min: 0, max: 0.35, step: 0.005 },
      { id: 'detailScale', label: 'Detail Scale', default: 0.22, min: 0.03, max: 2, step: 0.01 },
      { id: 'edgeSinkStart', label: 'Edge Sink Start', default: 0.4, min: 0.25, max: 0.5, step: 0.005 },
      { id: 'edgeSinkEnd', label: 'Edge Sink End', default: 0.5, min: 0.3, max: 0.55, step: 0.005 },
    ],
    evaluate(_i, p, ctx) {
      const r = Math.hypot(ctx.nx * 1.04, ctx.nz * 0.96)
      const v = clamp(1 - smoothstep(0.1, 0.42, r), 0, 1)
      const shore = p.shoreLevel ?? 0.3
      const underwater = mix(p.seaFloor ?? -0.55, 0, Math.pow(clamp(v / Math.max(shore, 0.001), 0, 1), p.lakeLift ?? 0.55))
      const land_t = Math.pow(clamp((v - shore) / Math.max(1 - shore, 0.001), 0, 1), p.landGamma ?? 1.35)
      const detail = (fbm_noise(ctx.wx + 113, ctx.wz + 47, ctx.seed + 211, 5, p.detailScale ?? 0.22) * 2 - 1) * (p.detailStrength ?? 0.08)
      const base = v < shore ? underwater : mix(0, p.mountainHeight ?? 2.2, land_t)
      const sink = smoothstep(p.edgeSinkStart ?? 0.4, p.edgeSinkEnd ?? 0.5, Math.max(Math.abs(ctx.nx), Math.abs(ctx.nz)))
      const height = mix(base + detail, p.trenchDepth ?? -1.4, sink)
      const landMask = smoothstep(shore, shore + 0.18, v)
      const elev = smoothstep(0.8, 2.2, height)
      const moisture = clamp(0.55 + fbm_noise(ctx.wx + 41, ctx.wz + 5, ctx.seed + 41, 6, 0.045) * 0.28 - elev * 0.35, 0, 1)
      const vegetation = clamp(smoothstep(0.02, 0.35, height) * moisture * (1 - elev * 0.6), 0, 1)
      const rock = clamp(smoothstep(1.1, 2.3, height) * 0.6, 0, 1)
      return { height, moisture, vegetation, rock, volcanic: 0, landMask }
    },
  })
  register_terrain_node_type({
    type: 'terrain_output',
    label: 'Terrain Output',
    category: 'Output',
    color: '#1a1a2e',
    inputs: [{ id: 'height', name: 'Height', default: 0 }, { id: 'moisture', name: 'Moisture', default: 0.5 }, { id: 'vegetation', name: 'Vegetation', default: 0.5 }, { id: 'rock', name: 'Rock', default: 0 }, { id: 'volcanic', name: 'Volcanic', default: 0 }],
    outputs: [],
    params: [],
    evaluate(inp) { return { height: inp.height, moisture: inp.moisture, vegetation: inp.vegetation, rock: inp.rock, volcanic: inp.volcanic } },
  })
}

function terrain_port_kind(id: string): string {
  if (id === 'height') return 'height'
  if (id === 'moisture' || id === 'vegetation' || id === 'rock' || id === 'volcanic') return 'mask'
  if (id === 'nx' || id === 'nz' || id === 'wx' || id === 'wz' || id === 'radial') return 'coord'
  return 'scalar'
}

function terrain_pin_color(kind: string): number {
  if (kind === 'height') return pack_hex('#d89b48')
  if (kind === 'mask') return pack_hex('#58b878')
  if (kind === 'coord') return pack_hex('#58a6d8')
  return pack_hex('#b8a2e0')
}

function terrain_link_color(a: string, b: string): number {
  return terrain_pin_color(a === 'scalar' ? b : a)
}

function terrain_preview_color(value: number, mode: terrain_graph_state['preview_mode']): number {
  if (mode === 'height') {
    const sea = clamp((-value) / 1.4, 0, 1)
    const land = clamp(value / 2.4, 0, 1)
    if (value < 0) return rgba(18 + sea * 10, 72 + sea * 46, 118 + sea * 70, 255)
    return rgba(62 + land * 120, 112 + land * 82, 68 + land * 80, 255)
  }
  if (mode === 'moisture') return rgba(28, 62 + value * 120, 118 + value * 92, 255)
  if (mode === 'vegetation') return rgba(36 + value * 30, 92 + value * 130, 54 + value * 40, 255)
  if (mode === 'rock') return rgba(70 + value * 130, 72 + value * 122, 78 + value * 112, 255)
  return rgba(72 + value * 150, 38 + value * 74, 36 + value * 42, 255)
}

function fbm_noise(px: number, py: number, seed: number, octaves: number, scale: number): number {
  let x = px * scale
  let y = py * scale
  let amp = 0.5
  let sum = 0
  let norm = 0
  const oct = Math.round(clamp(octaves, 1, 10))
  for (let i = 0; i < oct; i += 1) {
    sum += value_noise(x, y, seed + i * 31.7) * amp
    norm += amp
    const nx = 1.62 * x + 1.18 * y + 7.3
    const ny = -1.18 * x + 1.62 * y + 2.1
    x = nx
    y = ny
    amp *= 0.5
  }
  return sum / Math.max(0.0001, norm)
}

function value_noise(px: number, py: number, seed: number): number {
  const ix = Math.floor(px)
  const iy = Math.floor(py)
  const fx = fract(px)
  const fy = fract(py)
  const ux = fx * fx * (3 - 2 * fx)
  const uy = fy * fy * (3 - 2 * fy)
  return mix(mix(hash1(ix, iy, seed), hash1(ix + 1, iy, seed), ux), mix(hash1(ix, iy + 1, seed), hash1(ix + 1, iy + 1, seed), ux), uy)
}

function hash1(x: number, y: number, seed: number): number {
  return fract(Math.sin(x * 127.1 + y * 311.7 + seed * 74.7) * 43758.5453123)
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = clamp((x - e0) / (e1 - e0), 0, 1)
  return t * t * (3 - 2 * t)
}

function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v))
}

function fract(v: number): number {
  return v - Math.floor(v)
}

function point_in(px: number, py: number, x: number, y: number, w: number, h: number): boolean {
  return px >= x && px < x + w && py >= y && py < y + h
}

function pack_hex(hex: string): number {
  const raw = hex.startsWith('#') ? hex.slice(1) : hex
  const r = Number.parseInt(raw.slice(0, 2), 16)
  const g = Number.parseInt(raw.slice(2, 4), 16)
  const b = Number.parseInt(raw.slice(4, 6), 16)
  return rgba(r, g, b, 255)
}

function rgba(r: number, g: number, b: number, a: number): number {
  return ((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)
}
