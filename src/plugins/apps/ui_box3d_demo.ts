// Box3D Physics — a small rigid-body playground backed by the toolkit's WASM
// physics module. The viewport is deliberately drawn with UI primitives so the
// app works inside the same immediate-mode window system as every other panel.

import { pack_color, pack_rgba_floats } from '../../core/ui_theme'
import { FONT_MONO, type ui_renderer } from '../../core/ui_renderer'
import type { theme_definition } from '../../core/ui_types'
import type { ui_input_snapshot, ui_widgets } from '../../core/ui_widgets'
import {
  physics_world,
  quaternion_from_euler,
  type physics_quaternion,
  type physics_transform,
  type physics_vector3,
} from '../../physics'

type demo_shape = 'box' | 'sphere'

interface demo_body {
  handle: number
  shape: demo_shape
  half_size: physics_vector3
  radius: number
  transform: physics_transform
  color: [number, number, number]
}

interface demo_static_box {
  position: physics_vector3
  rotation: physics_quaternion
  half_size: physics_vector3
  color: [number, number, number]
}

export interface box3d_demo_state {
  world: physics_world | null
  loading: Promise<void> | null
  error: string | null
  paused: boolean
  last_time: number
  accumulator: number
  step_count: number
  drop_sequence: number
  bodies: demo_body[]
  static_boxes: demo_static_box[]
  on_change?: () => void
}

export interface box3d_demo_options {
  scale?: number
}

const IDENTITY: physics_quaternion = { x: 0, y: 0, z: 0, w: 1 }
const FIXED_STEP = 1 / 60
const MAX_BODIES = 48

export function create_box3d_demo_state(on_change?: () => void): box3d_demo_state {
  return {
    world: null,
    loading: null,
    error: null,
    paused: false,
    last_time: 0,
    accumulator: 0,
    step_count: 0,
    drop_sequence: 0,
    bodies: [],
    static_boxes: [],
    on_change,
  }
}

export function box3d_demo(
  ui: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  state: box3d_demo_state,
  options?: box3d_demo_options,
): void {
  const scale = options?.scale ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const m = 8 * scale
  ui.fill_rect(x, y, w, h, slot('panel'))
  ensure_world(state)

  const toolbar_h = 34 * scale
  const button_h = 26 * scale
  const button_y = y + m + (toolbar_h - button_h) * 0.5
  let bx = x + m
  if (widgets.button('box3d_reset', bx, button_y, 62 * scale, button_h, 'Reset')) reset_scene(state)
  bx += 68 * scale
  if (widgets.button('box3d_pause', bx, button_y, 76 * scale, button_h, state.paused ? 'Resume' : 'Pause', { active: state.paused })) {
    state.paused = !state.paused
    state.last_time = performance.now()
    state.on_change?.()
  }
  bx += 82 * scale
  if (widgets.button('box3d_drop_box', bx, button_y, 78 * scale, button_h, 'Drop Box')) spawn_body(state, 'box')
  bx += 84 * scale
  if (widgets.button('box3d_drop_sphere', bx, button_y, 92 * scale, button_h, 'Drop Sphere')) spawn_body(state, 'sphere')

  const ready_label = state.error ? 'WASM error' : state.world ? 'Box3D · WASM' : 'Loading Box3D…'
  const label_w = ui.text_width(ready_label, 10 * scale, FONT_MONO)
  if (x + w - m - label_w > bx) {
    ui.fill_circle(x + w - m - label_w - 9 * scale, y + m + toolbar_h * 0.5, 3 * scale, state.error ? pack_color('#ef6262') : state.world ? pack_color('#62d18b') : pack_color('#e5af54'))
    ui.draw_text(x + w - m - label_w, y + m + (toolbar_h - 10 * scale) * 0.5, ready_label, 10 * scale, slot('text_dim'), FONT_MONO)
  }

  const body_y = y + m + toolbar_h + m
  const body_h = Math.max(40 * scale, y + h - m - body_y)
  const sidebar_w = w >= 670 * scale ? 188 * scale : 0
  const viewport_x = x + m
  const viewport_y = body_y
  const viewport_w = Math.max(80 * scale, w - m * 2 - (sidebar_w > 0 ? sidebar_w + m : 0))

  simulate(state)
  draw_world(ui, theme, viewport_x, viewport_y, viewport_w, body_h, state, scale)
  if (sidebar_w > 0) draw_stats(ui, theme, viewport_x + viewport_w + m, body_y, sidebar_w, body_h, state, scale)

  if (state.world && input.mouse_pressed && point_in(input.mouse_x, input.mouse_y, viewport_x, viewport_y, viewport_w, body_h)) {
    const point = inverse_ground(input.mouse_x, input.mouse_y, viewport_x, viewport_y, viewport_w, body_h, scale)
    spawn_body(state, state.drop_sequence % 2 === 0 ? 'box' : 'sphere', point.x, point.z)
  }

  if (state.world && !state.paused) {
    state.on_change?.()
    ui.request_render()
  }
}

function ensure_world(state: box3d_demo_state): void {
  if (state.world || state.loading || state.error) return
  state.loading = physics_world.create()
    .then((world) => {
      state.world = world
      state.loading = null
      reset_scene(state)
    })
    .catch((error: unknown) => {
      state.loading = null
      state.error = error instanceof Error ? error.message : String(error)
      state.on_change?.()
    })
}

function reset_scene(state: box3d_demo_state): void {
  const world = state.world
  if (!world) return
  world.reset()
  world.set_gravity({ x: 0, y: -9.81, z: 0 })
  state.error = null
  state.bodies = []
  state.static_boxes = []
  state.step_count = 0
  state.drop_sequence = 0
  state.accumulator = 0
  state.last_time = performance.now()

  add_static_box(state, { x: 0, y: -0.45, z: 0 }, IDENTITY, { x: 5.8, y: 0.45, z: 4.6 }, [0.25, 0.31, 0.36])
  add_static_box(state, { x: -2.2, y: 0.55, z: 0.1 }, quaternion_from_euler({ x: 0, y: 0, z: -0.28 }), { x: 1.65, y: 0.17, z: 1.35 }, [0.30, 0.42, 0.50])
  add_static_box(state, { x: 3.5, y: 0.55, z: 1.15 }, IDENTITY, { x: 0.75, y: 0.55, z: 0.75 }, [0.34, 0.38, 0.46])

  const initial: Array<[demo_shape, number, number, number]> = [
    ['box', -1.4, 2.7, -0.1], ['box', -0.3, 3.4, 0.1], ['sphere', 0.9, 4.0, 0.0],
    ['box', 1.9, 4.8, 0.15], ['sphere', -0.8, 5.7, -0.2], ['box', 0.45, 6.5, 0.2],
    ['sphere', 2.5, 7.2, -0.1], ['box', 1.3, 8.0, 0.15],
  ]
  for (const [shape, px, py, pz] of initial) spawn_body(state, shape, px, pz, py)
  state.on_change?.()
}

function add_static_box(
  state: box3d_demo_state,
  position: physics_vector3,
  rotation: physics_quaternion,
  half_size: physics_vector3,
  color: [number, number, number],
): void {
  if (!state.world?.add_box(position, rotation, half_size)) throw new Error('Box3D static body creation failed')
  state.static_boxes.push({ position, rotation, half_size, color })
}

function spawn_body(state: box3d_demo_state, shape: demo_shape, px?: number, pz?: number, py = 7): void {
  const world = state.world
  if (!world || state.bodies.length >= MAX_BODIES) return
  const index = state.drop_sequence++
  const x = px ?? ((index * 1.73) % 5.4) - 2.7
  const z = pz ?? ((index * 0.91) % 2.8) - 1.4
  const position = { x, y: py, z }
  const half_size = shape === 'box'
    ? { x: 0.38 + (index % 3) * 0.07, y: 0.38, z: 0.38 + ((index + 1) % 2) * 0.08 }
    : { x: 0.42, y: 0.42, z: 0.42 }
  const radius = 0.42
  const rotation = shape === 'box' ? quaternion_from_euler({ x: index * 0.13, y: index * 0.31, z: index * 0.09 }) : IDENTITY
  const handle = shape === 'box'
    ? world.add_dynamic_box(position, rotation, half_size)
    : world.add_dynamic_sphere(position, radius)
  if (!handle) return
  const colors: Array<[number, number, number]> = [
    [0.24, 0.62, 0.96], [0.96, 0.53, 0.28], [0.49, 0.78, 0.45], [0.72, 0.47, 0.91],
  ]
  state.bodies.push({
    handle,
    shape,
    half_size,
    radius,
    transform: { position, rotation },
    color: colors[index % colors.length]!,
  })
  state.on_change?.()
}

function simulate(state: box3d_demo_state): void {
  const world = state.world
  if (!world) return
  const now = performance.now()
  if (state.last_time === 0) state.last_time = now
  const elapsed = Math.min(0.08, Math.max(0, (now - state.last_time) / 1000))
  state.last_time = now
  if (!state.paused) {
    state.accumulator += elapsed
    let steps = 0
    while (state.accumulator >= FIXED_STEP && steps < 5) {
      world.step(FIXED_STEP, 4)
      state.accumulator -= FIXED_STEP
      state.step_count += 1
      steps += 1
    }
  }
  for (const body of state.bodies) {
    const transform = world.body_transform(body.handle)
    if (transform) body.transform = transform
  }
}

function draw_world(
  ui: ui_renderer,
  theme: theme_definition,
  x: number,
  y: number,
  w: number,
  h: number,
  state: box3d_demo_state,
  scale: number,
): void {
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  ui.fill_round_rect(x, y, w, h, 7 * scale, pack_color('#111821'))
  ui.push_clip(x, y, w, h)

  const floor = state.static_boxes[0]
  if (floor) draw_box(ui, floor.position, floor.rotation, floor.half_size, floor.color, x, y, w, h, scale, true)

  const grid = pack_color('#273541')
  for (let i = -5; i <= 5; i += 1) {
    const a = project({ x: i, y: 0.012, z: -4.2 }, x, y, w, h, scale)
    const b = project({ x: i, y: 0.012, z: 4.2 }, x, y, w, h, scale)
    ui.stroke_line(a.x, a.y, b.x, b.y, i === 0 ? 1.3 * scale : 0.7 * scale, i === 0 ? pack_color('#3f6170') : grid)
    const c = project({ x: -5.2, y: 0.012, z: i * 0.8 }, x, y, w, h, scale)
    const d = project({ x: 5.2, y: 0.012, z: i * 0.8 }, x, y, w, h, scale)
    ui.stroke_line(c.x, c.y, d.x, d.y, i === 0 ? 1.3 * scale : 0.7 * scale, i === 0 ? pack_color('#3f6170') : grid)
  }

  const items: Array<{ depth: number; draw: () => void }> = []
  for (const box of state.static_boxes.slice(1)) {
    const p = project(box.position, x, y, w, h, scale)
    items.push({ depth: p.depth, draw: () => draw_box(ui, box.position, box.rotation, box.half_size, box.color, x, y, w, h, scale, true) })
  }
  for (const body of state.bodies) {
    const p = project(body.transform.position, x, y, w, h, scale)
    if (body.shape === 'box') {
      items.push({ depth: p.depth, draw: () => draw_box(ui, body.transform.position, body.transform.rotation, body.half_size, body.color, x, y, w, h, scale, false) })
    } else {
      items.push({ depth: p.depth, draw: () => draw_sphere(ui, body.transform.position, body.radius, body.color, x, y, w, h, scale) })
    }
  }
  items.sort((a, b) => a.depth - b.depth)
  for (const item of items) item.draw()

  if (state.error) {
    ui.draw_text(x + 14 * scale, y + 14 * scale, state.error, 11 * scale, pack_color('#ef7777'), FONT_MONO)
  } else if (!state.world) {
    ui.draw_text(x + 14 * scale, y + 14 * scale, 'Loading Box3D WebAssembly…', 11 * scale, slot('text_dim'), FONT_MONO)
  }
  const hint = state.bodies.length >= MAX_BODIES ? `Body limit reached (${MAX_BODIES})` : 'Click the floor to drop alternating shapes'
  ui.draw_text(x + 12 * scale, y + h - 22 * scale, hint, 10 * scale, slot('text_dim'), FONT_MONO)
  ui.pop_clip()
  ui.stroke_round_rect(x, y, w, h, 7 * scale, 1 * scale, slot('border'))
}

function draw_stats(
  ui: ui_renderer,
  theme: theme_definition,
  x: number,
  y: number,
  w: number,
  h: number,
  state: box3d_demo_state,
  scale: number,
): void {
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  ui.fill_round_rect(x, y, w, h, 7 * scale, slot('panel_alt'))
  ui.stroke_round_rect(x, y, w, h, 7 * scale, 1 * scale, slot('border'))
  const tx = x + 13 * scale
  let ty = y + 15 * scale
  const line = 19 * scale
  ui.draw_text(tx, ty, 'SIMULATION', 10 * scale, slot('accent'), FONT_MONO)
  ty += line * 1.45
  const rows: Array<[string, string]> = [
    ['Engine', 'Box3D'], ['Runtime', 'WebAssembly'], ['Bodies', `${state.bodies.length} / ${MAX_BODIES}`],
    ['Gravity', '−9.81 m/s²'], ['Step', '60 Hz'], ['Substeps', '4'], ['Ticks', state.step_count.toLocaleString()],
  ]
  for (const [label, value] of rows) {
    ui.draw_text(tx, ty, label, 10 * scale, slot('text_dim'), FONT_MONO)
    const vw = ui.text_width(value, 10 * scale, FONT_MONO)
    ui.draw_text(x + w - 13 * scale - vw, ty, value, 10 * scale, slot('text'), FONT_MONO)
    ty += line
  }
  ty += 8 * scale
  ui.stroke_line(tx, ty, x + w - 13 * scale, ty, 1, slot('border'))
  ty += 15 * scale
  ui.draw_text(tx, ty, state.paused ? 'PAUSED' : 'RUNNING', 10 * scale, state.paused ? pack_color('#e5af54') : pack_color('#62d18b'), FONT_MONO)
  ty += line
  ui.draw_text(tx, ty, 'Lambert-lit UI', 9 * scale, slot('text_dim'), FONT_MONO)
  ui.draw_text(tx, ty + 14 * scale, 'primitive renderer', 9 * scale, slot('text_dim'), FONT_MONO)
}

interface projected_point { x: number; y: number; depth: number }

function projection_unit(w: number, h: number, scale: number): number {
  return Math.max(18 * scale, Math.min(46 * scale, Math.min(w / 11.5, h / 8.2)))
}

function project(p: physics_vector3, x: number, y: number, w: number, h: number, scale: number): projected_point {
  const yaw = 0.64
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const horizontal = p.x * c - p.z * s
  const depth = p.x * s + p.z * c
  const unit = projection_unit(w, h, scale)
  return {
    x: x + w * 0.50 + horizontal * unit,
    y: y + h * 0.72 - p.y * unit + depth * unit * 0.42,
    depth,
  }
}

function inverse_ground(mx: number, my: number, x: number, y: number, w: number, h: number, scale: number): { x: number; z: number } {
  const yaw = 0.64
  const c = Math.cos(yaw)
  const s = Math.sin(yaw)
  const unit = projection_unit(w, h, scale)
  const horizontal = (mx - (x + w * 0.50)) / unit
  const depth = (my - (y + h * 0.72)) / (unit * 0.42)
  return {
    x: clamp(horizontal * c + depth * s, -4.3, 4.3),
    z: clamp(-horizontal * s + depth * c, -3.5, 3.5),
  }
}

function draw_box(
  ui: ui_renderer,
  position: physics_vector3,
  rotation: physics_quaternion,
  half: physics_vector3,
  color: [number, number, number],
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  is_static: boolean,
): void {
  const signs = [-1, 1]
  const vertices: physics_vector3[] = []
  for (const sy of signs) for (const sz of signs) for (const sx of signs) {
    const local = { x: sx * half.x, y: sy * half.y, z: sz * half.z }
    const rotated = rotate(local, rotation)
    vertices.push({ x: position.x + rotated.x, y: position.y + rotated.y, z: position.z + rotated.z })
  }
  const faces = [
    { indices: [0, 1, 3, 2], normal: { x: 0, y: -1, z: 0 } },
    { indices: [4, 6, 7, 5], normal: { x: 0, y: 1, z: 0 } },
    { indices: [0, 4, 5, 1], normal: { x: 0, y: 0, z: -1 } },
    { indices: [2, 3, 7, 6], normal: { x: 0, y: 0, z: 1 } },
    { indices: [0, 2, 6, 4], normal: { x: -1, y: 0, z: 0 } },
    { indices: [1, 5, 7, 3], normal: { x: 1, y: 0, z: 0 } },
  ]
  const projected = vertices.map((v) => project(v, x, y, w, h, scale))
  const sorted = faces.map((face) => ({
    ...face,
    depth: face.indices.reduce((sum, i) => sum + projected[i]!.depth, 0) / 4,
  })).sort((a, b) => a.depth - b.depth)
  const light = normalize({ x: -0.45, y: 0.82, z: -0.35 })
  for (const face of sorted) {
    const n = rotate(face.normal, rotation)
    const brightness = 0.32 + Math.max(0, dot(n, light)) * 0.68
    const tint = is_static ? 0.86 : 1
    const rgba = pack_rgba_floats(color[0] * brightness * tint, color[1] * brightness * tint, color[2] * brightness * tint)
    const [a, b, c, d] = face.indices.map((i) => projected[i]!)
    ui.fill_triangle(a!.x, a!.y, b!.x, b!.y, c!.x, c!.y, rgba)
    ui.fill_triangle(a!.x, a!.y, c!.x, c!.y, d!.x, d!.y, rgba)
    const edge = pack_rgba_floats(color[0] * 0.22, color[1] * 0.22, color[2] * 0.22, 0.72)
    ui.stroke_line(a!.x, a!.y, b!.x, b!.y, 0.65 * scale, edge)
    ui.stroke_line(b!.x, b!.y, c!.x, c!.y, 0.65 * scale, edge)
    ui.stroke_line(c!.x, c!.y, d!.x, d!.y, 0.65 * scale, edge)
    ui.stroke_line(d!.x, d!.y, a!.x, a!.y, 0.65 * scale, edge)
  }
}

function draw_sphere(
  ui: ui_renderer,
  position: physics_vector3,
  radius: number,
  color: [number, number, number],
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
): void {
  const p = project(position, x, y, w, h, scale)
  const r = radius * projection_unit(w, h, scale)
  ui.fill_circle(p.x + r * 0.14, p.y + r * 0.18, r, pack_rgba_floats(color[0] * 0.32, color[1] * 0.32, color[2] * 0.32))
  ui.fill_circle(p.x, p.y, r * 0.93, pack_rgba_floats(color[0] * 0.72, color[1] * 0.72, color[2] * 0.72))
  ui.fill_circle(p.x - r * 0.23, p.y - r * 0.28, r * 0.46, pack_rgba_floats(Math.min(1, color[0] * 1.25), Math.min(1, color[1] * 1.25), Math.min(1, color[2] * 1.25), 0.82), r * 0.18)
  ui.stroke_circle(p.x, p.y, r, 0.8 * scale, pack_rgba_floats(color[0] * 0.2, color[1] * 0.2, color[2] * 0.2))
}

function rotate(v: physics_vector3, q: physics_quaternion): physics_vector3 {
  const tx = 2 * (q.y * v.z - q.z * v.y)
  const ty = 2 * (q.z * v.x - q.x * v.z)
  const tz = 2 * (q.x * v.y - q.y * v.x)
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  }
}

function normalize(v: physics_vector3): physics_vector3 {
  const inv = 1 / Math.max(1e-6, Math.hypot(v.x, v.y, v.z))
  return { x: v.x * inv, y: v.y * inv, z: v.z * inv }
}

function dot(a: physics_vector3, b: physics_vector3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

function point_in(px: number, py: number, x: number, y: number, w: number, h: number): boolean {
  return px >= x && py >= y && px <= x + w && py <= y + h
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}
