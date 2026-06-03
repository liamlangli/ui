import latin_mono_font_json_url from '../assets/latin_mono.json?url'
import latin_mono_font_image_url from '../assets/latin_mono.webp?url'
import ping_fang_font_json_url from '../assets/ping_fang_sc_regular.json?url'
import ping_fang_font_image_url from '../assets/ping_fang_sc_regular.webp?url'
import ui_shader_url from '../assets/ui.wgsl?url'
import { clamp } from './math'

export interface ui_draw_command {
  vertex_offset: number
  vertex_count: number
  texture_id: number
  clip_x: number
  clip_y: number
  clip_w: number
  clip_h: number
}

export interface ui_renderer_stats {
  canvas_width: number
  canvas_height: number
  draw_commands: number
  vertex_count: number
  primitive_count: number
  primitive_buffer_bytes_used: number
  primitive_buffer_bytes_total: number
  vertex_buffer_bytes_used: number
  vertex_buffer_bytes_total: number
  texture_count: number
}

type glyph_metric = {
  width: number
  height: number
  x_offset: number
  y_offset: number
  x_advance: number
  atlas_x: number
  atlas_y: number
}

type font_atlas = {
  width: number
  height: number
  font_size: number
  line_height: number
  glyphs: Map<number, glyph_metric>
}

export const FONT_MAIN = 'FONT_MAIN' as const
export const FONT_ZH = 'FONT_ZH' as const
export const FONT_MONO = 'FONT_MONO' as const

export type ui_font_primitive = typeof FONT_MAIN | typeof FONT_ZH | typeof FONT_MONO

/**
 * Controls when `flush()` issues GPU work.
 *
 * - `'realtime'`: every `flush()` submits a render pass, so the canvas is
 *   redrawn on every animation frame. Use when content is continuously
 *   animating.
 * - `'adaptive'` (default): `flush()` only submits a render pass when there
 *   are pending render frames. Pending frames are scheduled by user input
 *   (call `request_render()` from your input handlers) or any script that
 *   needs a redraw. Each request schedules 8 frames so transient effects
 *   (hover, focus rings, cursor blinks tied to input) still finish settling.
 *   When no frames are pending, the immediate-mode logic still runs but no
 *   GPU work is issued — this cuts power on idle UIs.
 */
export type ui_renderer_render_mode = 'realtime' | 'adaptive'

export interface ui_renderer_init_options {
  /**
   * Load the Chinese (PingFang SC) font atlas. Defaults to `true`.
   *
   * The Chinese atlas is large (several MB), so it is always fetched
   * asynchronously and never blocks `init()`. Until it finishes loading the
   * CJK slot is backed by a 1x1 transparent texture. Set this to `false` to
   * skip loading it entirely; you can still load it later via
   * `load_chinese_font()`.
   */
  chinese_font?: boolean
  /**
   * How `flush()` decides whether to submit GPU work. Defaults to
   * `'adaptive'`. See `ui_renderer_render_mode` for details.
   */
  mode?: ui_renderer_render_mode
}

const adaptive_render_burst_frames = 8

type font_face_doc = { chars: number[][]; line_height: number; size: number }
type font_doc = font_face_doc & { pages?: string[]; width: number; height: number }
type font_bundle_doc = {
  pages?: string[]
  width: number
  height: number
  fonts: Record<typeof FONT_MAIN | typeof FONT_MONO, font_face_doc>
}

type clip_rect = { x: number; y: number; w: number; h: number }

type color_panel_texture = {
  texture: GPUTexture
  texture_id: number
  width: number
  height: number
}

export type ui_texture_filter = 'linear' | 'nearest'

type data_texture = {
  texture: GPUTexture
  width: number
  height: number
  filter: ui_texture_filter
}

const vertex_stride = 20
const default_font_scale = 1
const default_round_rect_feather = 1
const circle_min_sector_count = 12
const circle_max_sector_count = 96
const circle_curve_error_px = 0.125
const latin_mono_font_texture_id = 0
const white_texture_id = 1
const cjk_font_texture_id = 2
const first_external_texture_id = 3
const rr_corner_points = 4
const rr_points = 8 + 4 * rr_corner_points
const rr_cos = [0.9510565162951535, 0.8090169943749475, 0.5877852522924732, 0.3090169943749474]
const cjk_punctuation_aliases: [number, number][] = [
  [0x3001, 0x2c],
  [0x3002, 0x2e],
  [0x300a, 0x3c],
  [0x300b, 0x3e],
  [0x2018, 0x27],
  [0x2019, 0x27],
  [0x201c, 0x22],
  [0x201d, 0x22],
  [0xff08, 0x28],
  [0xff09, 0x29],
  [0xff0c, 0x2c],
  [0xff1a, 0x3a],
  [0xff1b, 0x3b],
  [0xff1f, 0x3f],
]
const font_page_urls: Record<string, string> = {
  'latin_mono.webp': latin_mono_font_image_url,
  'ping_fang_sc_regular.webp': ping_fang_font_image_url,
}

const color_panel_shader = /* wgsl */ `
struct Params {
  size : vec2f,
  mode : f32,
  pad0 : f32,
  data : vec4f,
}

struct v_out {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
}

@group(0) @binding(0) var<uniform> u : Params;

@vertex
fn vs_main(@builtin(vertex_index) vi : u32) -> v_out {
  var quad = array<vec2f, 6>(
    vec2f(0.0, 0.0),
    vec2f(1.0, 0.0),
    vec2f(0.0, 1.0),
    vec2f(0.0, 1.0),
    vec2f(1.0, 0.0),
    vec2f(1.0, 1.0),
  );
  let uv = quad[vi];
  var out : v_out;
  out.pos = vec4f(uv * vec2f(2.0, -2.0) + vec2f(-1.0, 1.0), 0.0, 1.0);
  out.uv = uv;
  return out;
}

fn hsv_to_rgb(h : f32, s : f32, v : f32) -> vec3f {
  let hh = ((h % 360.0) + 360.0) % 360.0;
  let ss = clamp(s, 0.0, 1.0);
  let vv = clamp(v, 0.0, 1.0);
  let c = vv * ss;
  let x = c * (1.0 - abs(((hh / 60.0) % 2.0) - 1.0));
  let m = vv - c;
  if (hh < 60.0) { return vec3f(c + m, x + m, m); }
  if (hh < 120.0) { return vec3f(x + m, c + m, m); }
  if (hh < 180.0) { return vec3f(m, c + m, x + m); }
  if (hh < 240.0) { return vec3f(m, x + m, c + m); }
  if (hh < 300.0) { return vec3f(x + m, m, c + m); }
  return vec3f(c + m, m, x + m);
}

fn hash12(p : vec2f) -> f32 {
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

@fragment
fn fs_main(v : v_out) -> @location(0) vec4f {
  let uv = clamp(v.uv, vec2f(0.0), vec2f(1.0));
  var color = vec3f(0.0);
  var alpha = 1.0;
  if (u.mode < 0.5) {
    color = hsv_to_rgb(uv.x * 360.0, 1.0 - uv.y, u.data.x);
  } else {
    color = hsv_to_rgb(u.data.x, u.data.y, 1.0 - uv.y);
    alpha = clamp(u.data.z, 0.0, 1.0);
  }
  let noise = (hash12(floor(uv * u.size)) - 0.5) / 255.0;
  color = clamp(color + vec3f(noise), vec3f(0.0), vec3f(1.0));
  return vec4f(color, alpha);
}
`

async function load_text(url: string): Promise<string> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  return res.text()
}

async function load_json<t>(url: string): Promise<t> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  return res.json() as Promise<t>
}

async function load_image_bitmap_asset(url: string): Promise<ImageBitmap> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  const blob = await res.blob()
  return createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' })
}

function font_image_url(doc: font_doc | font_bundle_doc, label: string): string {
  const page = doc.pages?.[0]
  if (!page) throw new Error(`font ${label} has no atlas page`)
  const page_name = page.split(/[\\/]/).pop() ?? page
  const url = font_page_urls[page_name]
  if (!url) throw new Error(`font ${label} atlas page is not bundled: ${page}`)
  return url
}

function font_face(doc: font_bundle_doc, font_type: typeof FONT_MAIN | typeof FONT_MONO): font_face_doc {
  const face = doc.fonts[font_type]
  if (!face) throw new Error(`font bundle missing ${font_type}`)
  return face
}

function glyph_map(doc: font_face_doc, texture_width: number, texture_height: number, options?: { cjk_punctuation_fallbacks?: boolean }): font_atlas {
  const glyphs = new Map<number, glyph_metric>()
  for (const [code, width, height, x_offset, y_offset, x_advance, atlas_x, atlas_y] of doc.chars) {
    glyphs.set(code, { width, height, x_offset, y_offset, x_advance, atlas_x, atlas_y })
  }
  if (options?.cjk_punctuation_fallbacks) {
    for (const [target, source] of cjk_punctuation_aliases) {
      const glyph = glyphs.get(source)
      if (!glyph || glyphs.has(target)) continue
      const x_advance = Math.max(glyph.x_advance, doc.size)
      glyphs.set(target, {
        ...glyph,
        x_offset: glyph.x_offset + (x_advance - glyph.x_advance) * 0.5,
        x_advance,
      })
    }
  }
  return {
    width: texture_width,
    height: texture_height,
    font_size: doc.size,
    line_height: doc.line_height,
    glyphs,
  }
}

function is_cjk_codepoint(code: number): boolean {
  return (
    (code >= 0x2e80 && code <= 0x2eff) ||
    (code >= 0x3000 && code <= 0x303f) ||
    (code >= 0x3100 && code <= 0x312f) ||
    (code >= 0x31c0 && code <= 0x31ef) ||
    (code >= 0x3400 && code <= 0x4dbf) ||
    (code >= 0x4e00 && code <= 0x9fff) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x20000 && code <= 0x2ebef)
  )
}

function clip_intersect(a: clip_rect, b: clip_rect): clip_rect {
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.w, b.x + b.w)
  const y1 = Math.min(a.y + a.h, b.y + b.h)
  return {
    x: x0,
    y: y0,
    w: Math.max(0, x1 - x0),
    h: Math.max(0, y1 - y0),
  }
}

function build_round_rect_points(
  out: Float32Array,
  x: number,
  y: number,
  w: number,
  h: number,
  rtl: number,
  rtr: number,
  rbl: number,
  rbr: number,
): number {
  const max_r = Math.min(w, h) * 0.5
  rtl = clamp(rtl, 0, max_r)
  rtr = clamp(rtr, 0, max_r)
  rbl = clamp(rbl, 0, max_r)
  rbr = clamp(rbr, 0, max_r)
  let count = 0

  const tl_x = x + rtl
  const tl_y = y + rtl
  const tr_x = x + w - rtr
  const tr_y = y + rtr
  const bl_x = x + rbl
  const bl_y = y + h - rbl
  const br_x = x + w - rbr
  const br_y = y + h - rbr

  count = write_round_rect_corner(out, count, tl_x, tl_y, -rtl, 0, 0, -rtl)
  out[count * 2 + 0] = tl_x
  out[count * 2 + 1] = y
  count += 1
  out[count * 2 + 0] = tr_x
  out[count * 2 + 1] = y
  count += 1
  count = write_round_rect_corner(out, count, tr_x, tr_y, 0, -rtr, rtr, 0)
  out[count * 2 + 0] = x + w
  out[count * 2 + 1] = tr_y
  count += 1
  out[count * 2 + 0] = x + w
  out[count * 2 + 1] = br_y
  count += 1
  count = write_round_rect_corner(out, count, br_x, br_y, rbr, 0, 0, rbr)
  out[count * 2 + 0] = br_x
  out[count * 2 + 1] = y + h
  count += 1
  out[count * 2 + 0] = bl_x
  out[count * 2 + 1] = y + h
  count += 1
  count = write_round_rect_corner(out, count, bl_x, bl_y, 0, rbl, -rbl, 0)
  out[count * 2 + 0] = x
  out[count * 2 + 1] = bl_y
  count += 1
  out[count * 2 + 0] = x
  out[count * 2 + 1] = tl_y
  count += 1
  return count
}

function write_round_rect_corner(out: Float32Array, count: number, cx: number, cy: number, cos_x: number, cos_y: number, sin_x: number, sin_y: number): number {
  for (let i = 0; i < rr_corner_points; i += 1) {
    const c = rr_cos[i] ?? 0
    const s = rr_cos[rr_corner_points - 1 - i] ?? 0
    out[count * 2 + 0] = cx + cos_x * c + sin_x * s
    out[count * 2 + 1] = cy + cos_y * c + sin_y * s
    count += 1
  }
  return count
}

function compact_closed_polyline_points(points: Float32Array, n: number): number {
  const eps = 0.0001
  let write = 0
  for (let i = 0; i < n; i += 1) {
    const px = points[i * 2 + 0] ?? 0
    const py = points[i * 2 + 1] ?? 0
    if (write > 0) {
      const lx = points[(write - 1) * 2 + 0] ?? 0
      const ly = points[(write - 1) * 2 + 1] ?? 0
      if (Math.hypot(px - lx, py - ly) <= eps) continue
    }
    points[write * 2 + 0] = px
    points[write * 2 + 1] = py
    write += 1
  }
  if (write > 1) {
    const fx = points[0] ?? 0
    const fy = points[1] ?? 0
    const lx = points[(write - 1) * 2 + 0] ?? 0
    const ly = points[(write - 1) * 2 + 1] ?? 0
    if (Math.hypot(fx - lx, fy - ly) <= eps) write -= 1
  }
  return write
}

function transparent_color(color: number): number {
  return color & 0x00ffffff
}

function expand_point_from_center(x: number, y: number, cx: number, cy: number, distance: number): { x: number; y: number } {
  const dx = x - cx
  const dy = y - cy
  const len = Math.hypot(dx, dy)
  if (len <= 0.0001) return { x, y }
  return { x: x + (dx / len) * distance, y: y + (dy / len) * distance }
}

function circle_sector_count(radius: number): number {
  const r = Math.max(0, radius)
  if (r <= 0) return 0
  const error = Math.min(circle_curve_error_px, r)
  const sector_angle = 2 * Math.acos(Math.max(-1, Math.min(1, 1 - error / r)))
  const sectors = sector_angle > 0 ? Math.ceil((Math.PI * 2) / sector_angle) : circle_max_sector_count
  return Math.min(circle_max_sector_count, Math.max(circle_min_sector_count, sectors))
}

export class ui_renderer {
  private device: GPUDevice | null = null
  private context: GPUCanvasContext | null = null
  private format: GPUTextureFormat | null = null
  private screen_buffer: GPUBuffer | null = null
  private pipeline_image: GPURenderPipeline | null = null
  private pipeline_sdf: GPURenderPipeline | null = null
  private color_panel_pipeline: GPURenderPipeline | null = null
  private bind_group_white: GPUBindGroup | null = null
  private readonly font_bind_groups = new Map<number, GPUBindGroup>()
  private readonly extra_bind_groups = new Map<number, GPUBindGroup>()
  private vertex_buffer: GPUBuffer | null = null
  private vertex_data = new ArrayBuffer(4096 * vertex_stride)
  private view = new DataView(this.vertex_data)
  private vertex_count = 0
  private commands: ui_draw_command[] = []
  private clip_stack: clip_rect[] = []
  private current_texture_id = white_texture_id
  private readonly font_atlases = new Map<ui_font_primitive, font_atlas>()
  private chinese_font_load: Promise<void> | null = null
  private canvas_width = 1
  private canvas_height = 1
  private bind_group_layout: GPUBindGroupLayout | null = null
  private color_panel_bind_group_layout: GPUBindGroupLayout | null = null
  private sampler: GPUSampler | null = null
  private sampler_nearest: GPUSampler | null = null
  private readonly data_textures = new Map<number, data_texture>()
  private next_texture_id = first_external_texture_id
  private color_panel_uniform: GPUBuffer | null = null
  private color_square_texture: color_panel_texture | null = null
  private color_value_texture: color_panel_texture | null = null
  private readonly round_rect_points = new Float32Array(rr_points * 2)
  private readonly round_rect_outer = new Float32Array(rr_points * 2)
  private readonly round_rect_inner = new Float32Array(rr_points * 2)
  private readonly round_rect_feather_outer = new Float32Array(rr_points * 2)
  private readonly round_rect_feather_inner = new Float32Array(rr_points * 2)
  private last_frame_stats: ui_renderer_stats | null = null
  private render_mode_: ui_renderer_render_mode = 'adaptive'
  private pending_render_frames = 0

  constructor(private readonly canvas: HTMLCanvasElement) {}

  async init(options?: ui_renderer_init_options): Promise<void> {
    this.render_mode_ = options?.mode ?? 'adaptive'
    this.pending_render_frames = adaptive_render_burst_frames
    if (!('gpu' in navigator)) throw new Error('WebGPU not supported')
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error('WebGPU adapter unavailable')
    this.device = await adapter.requestDevice()
    this.context = this.canvas.getContext('webgpu')
    if (!this.context) throw new Error('WebGPU canvas context unavailable')
    this.format = navigator.gpu.getPreferredCanvasFormat()

    const [shader_code, latin_mono_font_doc] = await Promise.all([
      load_text(ui_shader_url),
      load_json<font_bundle_doc>(latin_mono_font_json_url),
    ])
    const latin_mono_font_image = await load_image_bitmap_asset(font_image_url(latin_mono_font_doc, 'latin_mono'))
    this.font_atlases.set(FONT_MAIN, glyph_map(font_face(latin_mono_font_doc, FONT_MAIN), latin_mono_font_doc.width, latin_mono_font_doc.height))
    this.font_atlases.set(FONT_MONO, glyph_map(font_face(latin_mono_font_doc, FONT_MONO), latin_mono_font_doc.width, latin_mono_font_doc.height))
    this.screen_buffer = this.device.createBuffer({ label: 'ui.screen_buffer', size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })

    const shader_module = this.device.createShaderModule({ label: 'ui.shader_module', code: shader_code })
    const color_panel_module = this.device.createShaderModule({ label: 'ui.shader_module.color_panel', code: color_panel_shader })
    const sampler = this.device.createSampler({ label: 'ui.linear_sampler', magFilter: 'linear', minFilter: 'linear' })
    this.sampler = sampler
    this.sampler_nearest = this.device.createSampler({ label: 'ui.nearest_sampler', magFilter: 'nearest', minFilter: 'nearest' })
    const bind_group_layout = this.device.createBindGroupLayout({
      label: 'ui.bind_group_layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 2, visibility: GPUShaderStage.VERTEX, buffer: { type: 'uniform' } },
      ],
    })
    this.bind_group_layout = bind_group_layout
    this.color_panel_bind_group_layout = this.device.createBindGroupLayout({
      label: 'ui.bind_group_layout.color_panel',
      entries: [{ binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }],
    })
    const pipeline_layout = this.device.createPipelineLayout({ label: 'ui.pipeline_layout', bindGroupLayouts: [bind_group_layout] })
    const color_panel_layout = this.device.createPipelineLayout({ label: 'ui.pipeline_layout.color_panel', bindGroupLayouts: [this.color_panel_bind_group_layout] })
    const vertex: GPUVertexBufferLayout = {
      arrayStride: vertex_stride,
      attributes: [
        { shaderLocation: 0, offset: 0, format: 'float32x2' },
        { shaderLocation: 1, offset: 8, format: 'float32x2' },
        { shaderLocation: 2, offset: 16, format: 'unorm8x4' },
      ],
    }
    const color_target: GPUColorTargetState = {
      format: this.format,
      blend: {
        color: { srcFactor: 'src-alpha', dstFactor: 'one-minus-src-alpha', operation: 'add' },
        alpha: { srcFactor: 'one', dstFactor: 'one-minus-src-alpha', operation: 'add' },
      },
    }
    this.pipeline_image = this.device.createRenderPipeline({
      label: 'ui.pipeline.image',
      layout: pipeline_layout,
      vertex: { module: shader_module, entryPoint: 'vs_main', buffers: [vertex] },
      fragment: { module: shader_module, entryPoint: 'fs_image', targets: [color_target] },
      primitive: { topology: 'triangle-list' },
    })
    this.pipeline_sdf = this.device.createRenderPipeline({
      label: 'ui.pipeline.sdf',
      layout: pipeline_layout,
      vertex: { module: shader_module, entryPoint: 'vs_main', buffers: [vertex] },
      fragment: { module: shader_module, entryPoint: 'fs_sdf', targets: [color_target] },
      primitive: { topology: 'triangle-list' },
    })
    this.color_panel_pipeline = this.device.createRenderPipeline({
      label: 'ui.pipeline.color_panel',
      layout: color_panel_layout,
      vertex: { module: color_panel_module, entryPoint: 'vs_main' },
      fragment: { module: color_panel_module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })

    const white_texture = this.device.createTexture({
      label: 'ui.white_texture',
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    this.device.queue.writeTexture({ texture: white_texture }, new Uint8Array([255, 255, 255, 255]), { bytesPerRow: 4 }, { width: 1, height: 1, depthOrArrayLayers: 1 })
    this.bind_group_white = this.device.createBindGroup({
      label: 'ui.bind_group.white',
      layout: bind_group_layout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: white_texture.createView() },
        { binding: 2, resource: { buffer: this.screen_buffer } },
      ],
    })
    this.font_bind_groups.set(latin_mono_font_texture_id, this.create_texture_bind_group('ui.font_texture.latin_mono', latin_mono_font_image, sampler, bind_group_layout))
    this.font_bind_groups.set(cjk_font_texture_id, this.create_placeholder_font_bind_group('ui.font_texture.cjk.placeholder', sampler, bind_group_layout))
    this.color_panel_uniform = this.device.createBuffer({
      label: 'ui.buffer.color_panel',
      size: 32,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    this.resize()

    // The Chinese atlas is large, so load it off the critical path. The CJK
    // slot keeps its transparent placeholder until the real atlas arrives.
    if (options?.chinese_font ?? true) void this.load_chinese_font()
  }

  /**
   * Asynchronously load the Chinese (PingFang SC) font atlas and swap it in
   * once ready. Safe to call multiple times — concurrent and repeat calls
   * share the same in-flight load. Resolves when the atlas is available (or
   * immediately if it has already loaded).
   */
  load_chinese_font(): Promise<void> {
    if (this.font_atlases.has(FONT_ZH)) return Promise.resolve()
    if (this.chinese_font_load) return this.chinese_font_load
    this.chinese_font_load = this.fetch_chinese_font().catch((err) => {
      this.chinese_font_load = null
      throw err
    })
    return this.chinese_font_load
  }

  private async fetch_chinese_font(): Promise<void> {
    const cjk_font_doc = await load_json<font_doc>(ping_fang_font_json_url)
    const cjk_font_image = await load_image_bitmap_asset(font_image_url(cjk_font_doc, 'cjk'))
    if (!this.device || !this.sampler || !this.bind_group_layout || !this.screen_buffer) return
    this.font_atlases.set(FONT_ZH, glyph_map(cjk_font_doc, cjk_font_doc.width, cjk_font_doc.height, { cjk_punctuation_fallbacks: true }))
    this.font_bind_groups.set(cjk_font_texture_id, this.create_texture_bind_group('ui.font_texture.cjk', cjk_font_image, this.sampler, this.bind_group_layout))
  }

  resize(): void {
    if (!this.device || !this.context || !this.format || !this.screen_buffer) return
    const dpr = window.devicePixelRatio || 1
    this.canvas_width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr))
    this.canvas_height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr))
    this.canvas.width = this.canvas_width
    this.canvas.height = this.canvas_height
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' })
    this.device.queue.writeBuffer(this.screen_buffer, 0, new Float32Array([this.canvas_width, this.canvas_height]))
    this.request_render()
  }

  /**
   * Schedule the next N animation frames to actually issue GPU work in
   * `'adaptive'` mode. Defaults to an 8-frame burst, enough to let transient
   * input feedback (hover highlight, focus ring, cursor blink kick) settle
   * before the renderer drops back to idle. Call this from input handlers
   * or whenever a script mutates state that needs to be repainted. No-op
   * in `'realtime'` mode but safe to call.
   */
  request_render(frames: number = adaptive_render_burst_frames): void {
    if (frames <= 0) return
    if (this.pending_render_frames < frames) this.pending_render_frames = frames
  }

  render_mode(): ui_renderer_render_mode {
    return this.render_mode_
  }

  begin_frame(): void {
    this.vertex_count = 0
    this.commands = []
    this.clip_stack = [{ x: 0, y: 0, w: this.canvas_width, h: this.canvas_height }]
    this.current_texture_id = white_texture_id
  }

  register_external_texture(texture: GPUTexture): number {
    if (!this.device || !this.bind_group_layout || !this.sampler || !this.screen_buffer) throw new Error('ui_renderer not initialized')
    const id = this.next_texture_id++
    this.extra_bind_groups.set(id, this.device.createBindGroup({
      label: `ui.bind_group.external.${id}`,
      layout: this.bind_group_layout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: { buffer: this.screen_buffer } },
      ],
    }))
    return id
  }

  update_external_texture(texture_id: number, texture: GPUTexture): void {
    if (!this.device || !this.bind_group_layout || !this.sampler || !this.screen_buffer) return
    this.extra_bind_groups.set(texture_id, this.device.createBindGroup({
      label: `ui.bind_group.external.${texture_id}`,
      layout: this.bind_group_layout,
      entries: [
        { binding: 0, resource: this.sampler },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: { buffer: this.screen_buffer } },
      ],
    }))
  }

  /**
   * Create an RGBA8 GPU texture that can be updated from CPU pixel data via
   * {@link update_texture} and drawn with {@link draw_texture}. Returns an
   * opaque texture id (the same id space as {@link register_external_texture}).
   *
   * `filter` controls sampling: `'nearest'` is the equivalent of CSS
   * `image-rendering: pixelated`; `'linear'` (the default) smooths on scale.
   * The contents are undefined until the first {@link update_texture} call.
   */
  create_texture(width: number, height: number, options?: { filter?: ui_texture_filter }): number {
    if (!this.device) throw new Error('ui_renderer not initialized')
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))
    const filter = options?.filter ?? 'linear'
    const texture = this.device.createTexture({
      label: `ui.data_texture.${this.next_texture_id}`,
      size: [w, h, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    const id = this.next_texture_id++
    this.extra_bind_groups.set(id, this.create_data_texture_bind_group(id, texture, filter))
    this.data_textures.set(id, { texture, width: w, height: h, filter })
    return id
  }

  /**
   * Upload RGBA pixel data (4 bytes/pixel, row-major, top-left origin) into a
   * texture created by {@link create_texture}. This replaces the
   * `ctx2d.putImageData` 2D-canvas path. Pass `width`/`height` to resize the
   * underlying texture; otherwise the data must match the current size.
   */
  update_texture(texture_id: number, data: Uint8ClampedArray | Uint8Array, options?: { width?: number; height?: number }): void {
    const entry = this.data_textures.get(texture_id)
    if (!entry || !this.device) return
    const w = Math.max(1, Math.floor(options?.width ?? entry.width))
    const h = Math.max(1, Math.floor(options?.height ?? entry.height))
    if (w !== entry.width || h !== entry.height) {
      entry.texture.destroy()
      entry.texture = this.device.createTexture({
        label: `ui.data_texture.${texture_id}`,
        size: [w, h, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      entry.width = w
      entry.height = h
      this.extra_bind_groups.set(texture_id, this.create_data_texture_bind_group(texture_id, entry.texture, entry.filter))
    }
    this.device.queue.writeTexture(
      { texture: entry.texture },
      data as unknown as GPUAllowSharedBufferSource,
      { bytesPerRow: w * 4, rowsPerImage: h },
      { width: w, height: h, depthOrArrayLayers: 1 },
    )
  }

  /** Destroy a texture created by {@link create_texture} and release its bind group. */
  destroy_texture(texture_id: number): void {
    const entry = this.data_textures.get(texture_id)
    if (!entry) return
    entry.texture.destroy()
    this.data_textures.delete(texture_id)
    this.extra_bind_groups.delete(texture_id)
  }

  private create_data_texture_bind_group(id: number, texture: GPUTexture, filter: ui_texture_filter): GPUBindGroup {
    if (!this.device || !this.bind_group_layout || !this.screen_buffer) throw new Error('ui_renderer not initialized')
    const sampler = (filter === 'nearest' ? this.sampler_nearest : this.sampler) ?? this.sampler
    if (!sampler) throw new Error('ui_renderer not initialized')
    return this.device.createBindGroup({
      label: `ui.bind_group.data.${id}`,
      layout: this.bind_group_layout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: { buffer: this.screen_buffer } },
      ],
    })
  }

  draw_texture(texture_id: number, x: number, y: number, w: number, h: number, options?: { filter?: ui_texture_filter }): void {
    if (w <= 0 || h <= 0) return
    if (options?.filter) {
      const entry = this.data_textures.get(texture_id)
      if (entry && entry.filter !== options.filter) {
        entry.filter = options.filter
        this.extra_bind_groups.set(texture_id, this.create_data_texture_bind_group(texture_id, entry.texture, entry.filter))
      }
    }
    this.current_texture_id = texture_id
    this.push_quad(x, y, x + w, y + h, 0, 0, 1, 1, 0xffffffff)
  }

  draw_texture_region(texture_id: number, x: number, y: number, w: number, h: number, u0: number, v0: number, u1: number, v1: number): void {
    if (w <= 0 || h <= 0) return
    this.current_texture_id = texture_id
    this.push_quad(x, y, x + w, y + h, u0, v0, u1, v1, 0xffffffff)
  }

  draw_hsv_saturation_square(x: number, y: number, w: number, h: number, value: number): void {
    const texture = this.ensure_color_panel_texture('square', Math.max(1, Math.round(w)), Math.max(1, Math.round(h)))
    if (!texture || !this.device || !this.color_panel_pipeline || !this.color_panel_bind_group_layout || !this.color_panel_uniform) return
    this.device.queue.writeBuffer(this.color_panel_uniform, 0, new Float32Array([texture.width, texture.height, 0, 0, value, 0, 0, 0]))
    const encoder = this.device.createCommandEncoder({ label: 'ui.command_encoder.color_square' })
    const pass = encoder.beginRenderPass({
      label: 'ui.render_pass.color_square',
      colorAttachments: [{
        view: texture.texture.createView({ label: 'ui.view.color_square' }),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    })
    pass.setPipeline(this.color_panel_pipeline)
    pass.setBindGroup(0, this.device.createBindGroup({
      label: 'ui.bind_group.color_square',
      layout: this.color_panel_bind_group_layout,
      entries: [{ binding: 0, resource: { buffer: this.color_panel_uniform } }],
    }))
    pass.draw(6)
    pass.end()
    this.device.queue.submit([encoder.finish()])
    this.draw_texture(texture.texture_id, x, y, w, h)
  }

  draw_hsv_value_bar(x: number, y: number, w: number, h: number, hue: number, saturation: number, alpha: number): void {
    const texture = this.ensure_color_panel_texture('value', Math.max(1, Math.round(w)), Math.max(1, Math.round(h)))
    if (!texture || !this.device || !this.color_panel_pipeline || !this.color_panel_bind_group_layout || !this.color_panel_uniform) return
    this.device.queue.writeBuffer(this.color_panel_uniform, 0, new Float32Array([texture.width, texture.height, 1, 0, hue, saturation, alpha, 0]))
    const encoder = this.device.createCommandEncoder({ label: 'ui.command_encoder.color_value' })
    const pass = encoder.beginRenderPass({
      label: 'ui.render_pass.color_value',
      colorAttachments: [{
        view: texture.texture.createView({ label: 'ui.view.color_value' }),
        clearValue: { r: 0, g: 0, b: 0, a: 0 },
        loadOp: 'clear',
        storeOp: 'store',
      }],
    })
    pass.setPipeline(this.color_panel_pipeline)
    pass.setBindGroup(0, this.device.createBindGroup({
      label: 'ui.bind_group.color_value',
      layout: this.color_panel_bind_group_layout,
      entries: [{ binding: 0, resource: { buffer: this.color_panel_uniform } }],
    }))
    pass.draw(6)
    pass.end()
    this.device.queue.submit([encoder.finish()])
    this.draw_texture(texture.texture_id, x, y, w, h)
  }

  push_clip(x: number, y: number, w: number, h: number): void {
    const next = clip_intersect(this.current_clip(), { x, y, w, h })
    this.clip_stack.push(next)
  }

  pop_clip(): void {
    if (this.clip_stack.length > 1) this.clip_stack.pop()
  }

  set_cursor(cursor: string | null): void {
    this.canvas.style.cursor = cursor ?? ''
  }

  fill_rect(x: number, y: number, w: number, h: number, rgba: number, feather = 0): void {
    if (w <= 0 || h <= 0) return
    this.current_texture_id = white_texture_id
    const u = this.white_u()
    const v = this.white_v()
    this.push_quad(x, y, x + w, y + h, u, v, u, v, rgba)
    const f = Math.max(0, feather)
    if (f <= 0) return
    const transparent = transparent_color(rgba)
    this.push_quad_colored(x, y - f, x + w, y, u, v, u, v, transparent, transparent, rgba, rgba)
    this.push_quad_colored(x, y + h, x + w, y + h + f, u, v, u, v, rgba, rgba, transparent, transparent)
    this.push_quad_colored(x - f, y, x, y + h, u, v, u, v, transparent, rgba, rgba, transparent)
    this.push_quad_colored(x + w, y, x + w + f, y + h, u, v, u, v, rgba, transparent, transparent, rgba)
    this.push_quad_colored(x - f, y - f, x, y, u, v, u, v, transparent, transparent, rgba, transparent)
    this.push_quad_colored(x + w, y - f, x + w + f, y, u, v, u, v, transparent, transparent, transparent, rgba)
    this.push_quad_colored(x - f, y + h, x, y + h + f, u, v, u, v, transparent, rgba, transparent, transparent)
    this.push_quad_colored(x + w, y + h, x + w + f, y + h + f, u, v, u, v, rgba, transparent, transparent, transparent)
  }

  fill_round_rect(x: number, y: number, w: number, h: number, radius: number, rgba: number, feather = default_round_rect_feather): void {
    this.fill_round_rect_per_corner(x, y, w, h, radius, radius, radius, radius, rgba, feather)
  }

  fill_round_rect_per_corner(x: number, y: number, w: number, h: number, rtl: number, rtr: number, rbl: number, rbr: number, rgba: number, feather = default_round_rect_feather): void {
    if (w <= 0 || h <= 0) return
    if (rtl <= 0 && rtr <= 0 && rbl <= 0 && rbr <= 0) {
      this.fill_rect(x, y, w, h, rgba, feather)
      return
    }
    const pts = this.round_rect_points
    const n = compact_closed_polyline_points(pts, build_round_rect_points(pts, x, y, w, h, rtl, rtr, rbl, rbr))
    if (n < 3) return
    this.current_texture_id = white_texture_id
    const u = this.white_u()
    const v = this.white_v()
    const x0 = pts[0]
    const y0 = pts[1]
    for (let i = 1; i < n - 1; i += 1) {
      this.push_tri(x0, y0, pts[i * 2], pts[i * 2 + 1], pts[(i + 1) * 2], pts[(i + 1) * 2 + 1], u, v, rgba)
    }
    const f = Math.max(0, feather)
    if (f > 0) this.push_closed_polyline_fill_feather(pts, n, f, rgba, this.round_rect_outer)
  }

  stroke_round_rect(x: number, y: number, w: number, h: number, radius: number, thickness: number, rgba: number, feather = default_round_rect_feather): void {
    this.stroke_round_rect_per_corner(x, y, w, h, radius, radius, radius, radius, thickness, rgba, feather)
  }

  stroke_round_rect_per_corner(x: number, y: number, w: number, h: number, rtl: number, rtr: number, rbl: number, rbr: number, thickness: number, rgba: number, feather = default_round_rect_feather): void {
    if (w <= 0 || h <= 0 || thickness <= 0) return
    if (rtl <= 0 && rtr <= 0 && rbl <= 0 && rbr <= 0) {
      this.stroke_rect(x, y, w, h, thickness, rgba, feather)
      return
    }
    const pts = this.round_rect_points
    const n = compact_closed_polyline_points(pts, build_round_rect_points(pts, x, y, w, h, rtl, rtr, rbl, rbr))
    if (n < 2) return
    this.current_texture_id = white_texture_id
    this.push_closed_polyline_stroke(pts, n, Math.max(1, thickness), rgba, this.round_rect_outer, this.round_rect_inner, Math.max(0, feather), this.round_rect_feather_outer, this.round_rect_feather_inner)
  }

  fill_triangle(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, rgba: number, feather = 0): void {
    this.current_texture_id = white_texture_id
    const u = this.white_u()
    const v = this.white_v()
    this.push_tri(x0, y0, x1, y1, x2, y2, u, v, rgba)
    const f = Math.max(0, feather)
    if (f <= 0) return
    const cx = (x0 + x1 + x2) / 3
    const cy = (y0 + y1 + y2) / 3
    const e0 = expand_point_from_center(x0, y0, cx, cy, f)
    const e1 = expand_point_from_center(x1, y1, cx, cy, f)
    const e2 = expand_point_from_center(x2, y2, cx, cy, f)
    const transparent = transparent_color(rgba)
    this.push_quad_points_colored(x0, y0, x1, y1, e1.x, e1.y, e0.x, e0.y, u, v, rgba, rgba, transparent, transparent)
    this.push_quad_points_colored(x1, y1, x2, y2, e2.x, e2.y, e1.x, e1.y, u, v, rgba, rgba, transparent, transparent)
    this.push_quad_points_colored(x2, y2, x0, y0, e0.x, e0.y, e2.x, e2.y, u, v, rgba, rgba, transparent, transparent)
  }

  fill_circle(cx: number, cy: number, radius: number, rgba: number, feather = 1): void {
    if (radius <= 0) return
    const f = Math.max(0, feather)
    const steps = circle_sector_count(radius + f)
    this.current_texture_id = white_texture_id
    const u = this.white_u()
    const v = this.white_v()
    let prev_x = cx + radius
    let prev_y = cy
    for (let i = 1; i <= steps; i += 1) {
      const a = (i / steps) * Math.PI * 2
      const x = cx + Math.cos(a) * radius
      const y = cy + Math.sin(a) * radius
      this.push_tri(cx, cy, prev_x, prev_y, x, y, u, v, rgba)
      prev_x = x
      prev_y = y
    }
    if (f <= 0) return
    const transparent = transparent_color(rgba)
    let inner_prev_x = cx + radius
    let inner_prev_y = cy
    let outer_prev_x = cx + radius + f
    let outer_prev_y = cy
    for (let i = 1; i <= steps; i += 1) {
      const a = (i / steps) * Math.PI * 2
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      const inner_x = cx + ca * radius
      const inner_y = cy + sa * radius
      const outer_x = cx + ca * (radius + f)
      const outer_y = cy + sa * (radius + f)
      this.push_quad_points_colored(inner_prev_x, inner_prev_y, inner_x, inner_y, outer_x, outer_y, outer_prev_x, outer_prev_y, u, v, rgba, rgba, transparent, transparent)
      inner_prev_x = inner_x
      inner_prev_y = inner_y
      outer_prev_x = outer_x
      outer_prev_y = outer_y
    }
  }

  stroke_rect(x: number, y: number, w: number, h: number, thickness: number, rgba: number, feather = 0): void {
    const t = Math.max(1, thickness)
    this.fill_rect(x, y, w, t, rgba, feather)
    this.fill_rect(x, y + h - t, w, t, rgba, feather)
    this.fill_rect(x, y, t, h, rgba, feather)
    this.fill_rect(x + w - t, y, t, h, rgba, feather)
  }

  stroke_line(x0: number, y0: number, x1: number, y1: number, thickness: number, rgba: number, feather = 0): void {
    const dx = x1 - x0
    const dy = y1 - y0
    const len = Math.hypot(dx, dy)
    if (len <= 0.0001) return
    const t = Math.max(1, thickness)
    const ux = dx / len
    const uy = dy / len
    const nx = -dy / len
    const ny = dx / len
    const hx = nx * (t * 0.5)
    const hy = ny * (t * 0.5)
    this.current_texture_id = white_texture_id
    const u = this.white_u()
    const v = this.white_v()
    this.push_tri(x0 - hx, y0 - hy, x1 - hx, y1 - hy, x0 + hx, y0 + hy, u, v, rgba)
    this.push_tri(x0 + hx, y0 + hy, x1 - hx, y1 - hy, x1 + hx, y1 + hy, u, v, rgba)
    const f = Math.max(0, feather)
    if (f <= 0) return
    const transparent = transparent_color(rgba)
    const ox = nx * (t * 0.5 + f)
    const oy = ny * (t * 0.5 + f)
    this.push_quad_points_colored(x0 - hx, y0 - hy, x1 - hx, y1 - hy, x1 - ox, y1 - oy, x0 - ox, y0 - oy, u, v, rgba, rgba, transparent, transparent)
    this.push_quad_points_colored(x1 + hx, y1 + hy, x0 + hx, y0 + hy, x0 + ox, y0 + oy, x1 + ox, y1 + oy, u, v, rgba, rgba, transparent, transparent)
    this.push_quad_points_colored(x0 + hx, y0 + hy, x0 - hx, y0 - hy, x0 - hx - ux * f, y0 - hy - uy * f, x0 + hx - ux * f, y0 + hy - uy * f, u, v, rgba, rgba, transparent, transparent)
    this.push_quad_points_colored(x1 - hx, y1 - hy, x1 + hx, y1 + hy, x1 + hx + ux * f, y1 + hy + uy * f, x1 - hx + ux * f, y1 - hy + uy * f, u, v, rgba, rgba, transparent, transparent)
  }

  draw_text(x: number, y: number, text: string, font_px: number, rgba: number, font_type: ui_font_primitive = FONT_MAIN): void {
    if (!text || !this.font_atlases.size) return
    const effective_font_px = font_px * default_font_scale
    let cx = x
    let cy = y
    for (const ch of text) {
      if (ch === '\n') {
        cx = x
        cy += this.text_line_height(font_px, font_type)
        continue
      }
      const code = ch.codePointAt(0) ?? 32
      const font = this.font_for_codepoint(code, font_type)
      if (!font) continue
      const glyph = font.atlas.glyphs.get(code) ?? font.atlas.glyphs.get(32)
      if (!glyph) continue
      const scale = effective_font_px / font.atlas.font_size
      if (glyph.width <= 0 || glyph.height <= 0) {
        cx += glyph.x_advance * scale
        continue
      }
      const inv_w = 1 / font.atlas.width
      const inv_h = 1 / font.atlas.height
      const x0 = cx + glyph.x_offset * scale
      const y0 = cy + glyph.y_offset * scale
      const x1 = x0 + glyph.width * scale
      const y1 = y0 + glyph.height * scale
      this.current_texture_id = font.texture_id
      this.push_quad(
        x0,
        y0,
        x1,
        y1,
        glyph.atlas_x * inv_w,
        glyph.atlas_y * inv_h,
        (glyph.atlas_x + glyph.width) * inv_w,
        (glyph.atlas_y + glyph.height) * inv_h,
        rgba,
      )
      cx += glyph.x_advance * scale
    }
  }

  wrap_text(text: string, font_px: number, max_w: number, font_type: ui_font_primitive = FONT_MAIN): string[] {
    const normalized = text.replace(/\r/g, '')
    if (!normalized) return ['']
    const paragraphs = normalized.split('\n')
    const lines: string[] = []
    for (const paragraph of paragraphs) {
      if (!paragraph) {
        lines.push('')
        continue
      }
      const words = paragraph.split(/\s+/).filter(Boolean)
      let current = ''
      for (const word of words) {
        const candidate = current ? `${current} ${word}` : word
        if (this.text_width(candidate, font_px, font_type) <= max_w) {
          current = candidate
          continue
        }
        if (current) lines.push(current)
        if (this.text_width(word, font_px, font_type) <= max_w) {
          current = word
          continue
        }
        let chunk = ''
        for (const ch of word) {
          const next = `${chunk}${ch}`
          if (chunk && this.text_width(next, font_px, font_type) > max_w) {
            lines.push(chunk)
            chunk = ch
          } else {
            chunk = next
          }
        }
        current = chunk
      }
      if (current) lines.push(current)
    }
    return lines.length ? lines : ['']
  }

  draw_text_wrapped(x: number, y: number, w: number, text: string, font_px: number, rgba: number, font_type: ui_font_primitive = FONT_MAIN): number {
    const lines = this.wrap_text(text, font_px, w, font_type)
    const line_h = this.text_line_height(font_px, font_type)
    for (let i = 0; i < lines.length; i += 1) {
      this.draw_text(x, y + i * line_h, lines[i] ?? '', font_px, rgba, font_type)
    }
    return lines.length * line_h
  }

  text_line_height(font_px: number, font_type: ui_font_primitive = FONT_MAIN): number {
    const atlas = this.font_atlases.get(font_type) ?? this.font_atlases.get(FONT_MAIN)
    if (!atlas) return font_px
    const effective_font_px = font_px * default_font_scale
    return atlas.line_height * (effective_font_px / atlas.font_size)
  }

  text_v_center_y(y: number, h: number, font_px: number, font_type: ui_font_primitive = FONT_MAIN): number {
    const line_h = this.text_line_height(font_px, font_type)
    return y + (h - line_h) * 0.5 - font_px * default_font_scale * 0.03
  }

  /**
   * Measure a single line of text: its advance width and the line height for
   * the given font. (`text_line_height` already exists for the height alone.)
   */
  measure_text(text: string, font_px: number, font_type: ui_font_primitive = FONT_MAIN): { w: number; h: number } {
    return { w: this.text_width(text, font_px, font_type), h: this.text_line_height(font_px, font_type) }
  }

  /**
   * Width of a single `'0'` glyph — for a monospace font this is the per-column
   * advance, useful for laying out / hit-testing fixed-width text grids.
   */
  mono_char_width(font_px: number, font_type: ui_font_primitive = FONT_MONO): number {
    return this.text_width('0', font_px, font_type)
  }

  /**
   * How many monospace columns fit within `width` pixels. Returns at least 1.
   */
  columns_for_width(width: number, font_px: number, font_type: ui_font_primitive = FONT_MONO): number {
    const cw = this.mono_char_width(font_px, font_type)
    if (cw <= 0) return 1
    return Math.max(1, Math.floor(width / cw))
  }

  text_width(text: string, font_px: number, font_type: ui_font_primitive = FONT_MAIN): number {
    const effective_font_px = font_px * default_font_scale
    let width = 0
    for (const ch of text) {
      if (ch === '\n') break
      const font = this.font_for_codepoint(ch.codePointAt(0) ?? 32, font_type)
      if (!font) {
        width += effective_font_px * 0.55
        continue
      }
      const glyph = font.atlas.glyphs.get(ch.codePointAt(0) ?? 32) ?? font.atlas.glyphs.get(32)
      if (glyph) width += glyph.x_advance * (effective_font_px / font.atlas.font_size)
    }
    return width
  }

  flush(clear_color: GPUColorDict): void {
    if (!this.device || !this.context || !this.pipeline_image || !this.pipeline_sdf || !this.bind_group_white) return
    const byte_length = Math.max(this.vertex_count * vertex_stride, vertex_stride)
    if (this.render_mode_ === 'adaptive' && this.pending_render_frames <= 0) {
      this.last_frame_stats = this.capture_stats(this.vertex_buffer?.size ?? byte_length)
      return
    }
    if (this.render_mode_ === 'adaptive') this.pending_render_frames -= 1
    if (!this.vertex_buffer || this.vertex_buffer.size < byte_length) {
      let next_size = Math.max(this.vertex_buffer?.size ?? 0, 4096)
      while (next_size < byte_length) next_size *= 2
      this.vertex_buffer?.destroy()
      this.vertex_buffer = this.device.createBuffer({
        label: 'ui.vertex_buffer',
        size: next_size,
        usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
      })
    }
    this.last_frame_stats = this.capture_stats(byte_length)
    this.device.queue.writeBuffer(this.vertex_buffer, 0, this.vertex_data, 0, this.vertex_count * vertex_stride)
    const encoder = this.device.createCommandEncoder({ label: 'ui.command_encoder' })
    const pass = encoder.beginRenderPass({
      label: 'ui.render_pass',
      colorAttachments: [
        {
          view: this.context.getCurrentTexture().createView({ label: 'ui.swapchain_view' }),
          clearValue: clear_color,
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })
    pass.setVertexBuffer(0, this.vertex_buffer)
    for (const cmd of this.commands) {
      if (cmd.clip_w <= 0 || cmd.clip_h <= 0) continue
      pass.setScissorRect(cmd.clip_x, cmd.clip_y, cmd.clip_w, cmd.clip_h)
      const font_bind_group = this.font_bind_groups.get(cmd.texture_id)
      const bind_group = font_bind_group ?? (cmd.texture_id === white_texture_id ? this.bind_group_white : this.extra_bind_groups.get(cmd.texture_id))
      if (!bind_group) continue
      if (font_bind_group) {
        pass.setPipeline(this.pipeline_sdf)
        pass.setBindGroup(0, bind_group)
      } else {
        pass.setPipeline(this.pipeline_image)
        pass.setBindGroup(0, bind_group)
      }
      pass.draw(cmd.vertex_count, 1, cmd.vertex_offset)
    }
    pass.end()
    this.device.queue.submit([encoder.finish()])
  }

  private create_placeholder_font_bind_group(label: string, sampler: GPUSampler, layout: GPUBindGroupLayout): GPUBindGroup {
    if (!this.device || !this.screen_buffer) throw new Error('ui_renderer not initialized')
    const texture = this.device.createTexture({
      label,
      size: [1, 1, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
    })
    this.device.queue.writeTexture({ texture }, new Uint8Array([0, 0, 0, 0]), { bytesPerRow: 4 }, { width: 1, height: 1, depthOrArrayLayers: 1 })
    return this.device.createBindGroup({
      label: label.replace('texture', 'bind_group'),
      layout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: { buffer: this.screen_buffer } },
      ],
    })
  }

  private create_texture_bind_group(label: string, image: ImageBitmap, sampler: GPUSampler, layout: GPUBindGroupLayout): GPUBindGroup {
    if (!this.device || !this.screen_buffer) throw new Error('ui_renderer not initialized')
    const texture = this.device.createTexture({
      label,
      size: [image.width, image.height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    this.device.queue.copyExternalImageToTexture({ source: image }, { texture }, { width: image.width, height: image.height })
    return this.device.createBindGroup({
      label: label.replace('texture', 'bind_group'),
      layout,
      entries: [
        { binding: 0, resource: sampler },
        { binding: 1, resource: texture.createView() },
        { binding: 2, resource: { buffer: this.screen_buffer } },
      ],
    })
  }

  private font_for_codepoint(code: number, font_type: ui_font_primitive): { texture_id: number; atlas: font_atlas } | null {
    const preferred = this.font_atlases.get(font_type) ?? null
    const main = this.font_atlases.get(FONT_MAIN) ?? null
    const zh = this.font_atlases.get(FONT_ZH) ?? null
    const mono = this.font_atlases.get(FONT_MONO) ?? null
    if (preferred?.glyphs.has(code)) return { texture_id: this.font_texture_id_for_type(font_type), atlas: preferred }
    if (is_cjk_codepoint(code) && zh?.glyphs.has(code)) return { texture_id: cjk_font_texture_id, atlas: zh }
    if (main?.glyphs.has(code)) return { texture_id: latin_mono_font_texture_id, atlas: main }
    if (mono?.glyphs.has(code)) return { texture_id: latin_mono_font_texture_id, atlas: mono }
    if (zh?.glyphs.has(code)) return { texture_id: cjk_font_texture_id, atlas: zh }
    if (preferred) return { texture_id: this.font_texture_id_for_type(font_type), atlas: preferred }
    if (main) return { texture_id: latin_mono_font_texture_id, atlas: main }
    if (zh) return { texture_id: cjk_font_texture_id, atlas: zh }
    if (mono) return { texture_id: latin_mono_font_texture_id, atlas: mono }
    return null
  }

  private font_texture_id_for_type(font_type: ui_font_primitive): number {
    return font_type === FONT_ZH ? cjk_font_texture_id : latin_mono_font_texture_id
  }

  canvas_size(): { width: number; height: number } {
    return { width: this.canvas_width, height: this.canvas_height }
  }

  renderer_stats(): ui_renderer_stats {
    return this.last_frame_stats ?? this.capture_stats(Math.max(this.vertex_count * vertex_stride, vertex_stride))
  }

  gpu(): { device: GPUDevice | null; context: GPUCanvasContext | null; format: GPUTextureFormat | null } {
    return { device: this.device, context: this.context, format: this.format }
  }

  private capture_stats(vertex_buffer_bytes_used: number): ui_renderer_stats {
    const primitive_buffer_bytes_used = this.vertex_count * vertex_stride
    return {
      canvas_width: this.canvas_width,
      canvas_height: this.canvas_height,
      draw_commands: this.commands.length,
      vertex_count: this.vertex_count,
      primitive_count: Math.floor(this.vertex_count / 3),
      primitive_buffer_bytes_used,
      primitive_buffer_bytes_total: this.vertex_data.byteLength,
      vertex_buffer_bytes_used,
      vertex_buffer_bytes_total: this.vertex_buffer?.size ?? 0,
      texture_count: this.font_bind_groups.size + this.extra_bind_groups.size + (this.bind_group_white ? 1 : 0),
    }
  }

  private push_closed_polyline_fill_feather(points: Float32Array, n: number, feather: number, color: number, outer: Float32Array): void {
    if (n < 2 || feather <= 0) return
    const normal_sign = this.closed_polyline_normal_sign(points, n)
    for (let i = 0; i < n; i += 1) {
      this.write_closed_polyline_stroke_offset_vertex(points, n, normal_sign, i, feather, outer)
    }

    const u = this.white_u()
    const v = this.white_v()
    const transparent = transparent_color(color)
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n
      const ix0 = points[i * 2 + 0] ?? 0
      const iy0 = points[i * 2 + 1] ?? 0
      const ix1 = points[j * 2 + 0] ?? 0
      const iy1 = points[j * 2 + 1] ?? 0
      const ox0 = outer[i * 2 + 0] ?? 0
      const oy0 = outer[i * 2 + 1] ?? 0
      const ox1 = outer[j * 2 + 0] ?? 0
      const oy1 = outer[j * 2 + 1] ?? 0
      this.push_quad_points_colored(ix0, iy0, ix1, iy1, ox1, oy1, ox0, oy0, u, v, color, color, transparent, transparent)
    }
  }

  private push_closed_polyline_stroke(
    points: Float32Array,
    n: number,
    thickness: number,
    color: number,
    outer: Float32Array,
    inner: Float32Array,
    feather = 0,
    feather_outer?: Float32Array,
    feather_inner?: Float32Array,
  ): void {
    if (n < 2) return
    const normal_sign = this.closed_polyline_normal_sign(points, n)
    const half = thickness * 0.5

    for (let i = 0; i < n; i += 1) {
      this.write_closed_polyline_stroke_offset_vertex(points, n, normal_sign, i, half, outer)
      this.write_closed_polyline_stroke_offset_vertex(points, n, normal_sign, i, -half, inner)
      if (feather > 0 && feather_outer && feather_inner) {
        this.write_closed_polyline_stroke_offset_vertex(points, n, normal_sign, i, half + feather, feather_outer)
        this.write_closed_polyline_stroke_offset_vertex(points, n, normal_sign, i, -half - feather, feather_inner)
      }
    }

    const u = this.white_u()
    const v = this.white_v()
    const transparent = transparent_color(color)
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n
      const ox0 = outer[i * 2 + 0] ?? 0
      const oy0 = outer[i * 2 + 1] ?? 0
      const ox1 = outer[j * 2 + 0] ?? 0
      const oy1 = outer[j * 2 + 1] ?? 0
      const ix0 = inner[i * 2 + 0] ?? 0
      const iy0 = inner[i * 2 + 1] ?? 0
      const ix1 = inner[j * 2 + 0] ?? 0
      const iy1 = inner[j * 2 + 1] ?? 0
      this.push_tri(ox0, oy0, ox1, oy1, ix0, iy0, u, v, color)
      this.push_tri(ix0, iy0, ox1, oy1, ix1, iy1, u, v, color)
      if (feather > 0 && feather_outer && feather_inner) {
        const fox0 = feather_outer[i * 2 + 0] ?? 0
        const foy0 = feather_outer[i * 2 + 1] ?? 0
        const fox1 = feather_outer[j * 2 + 0] ?? 0
        const foy1 = feather_outer[j * 2 + 1] ?? 0
        const fix0 = feather_inner[i * 2 + 0] ?? 0
        const fiy0 = feather_inner[i * 2 + 1] ?? 0
        const fix1 = feather_inner[j * 2 + 0] ?? 0
        const fiy1 = feather_inner[j * 2 + 1] ?? 0
        this.push_quad_points_colored(ox0, oy0, ox1, oy1, fox1, foy1, fox0, foy0, u, v, color, color, transparent, transparent)
        this.push_quad_points_colored(ix1, iy1, ix0, iy0, fix0, fiy0, fix1, fiy1, u, v, color, color, transparent, transparent)
      }
    }
  }

  private closed_polyline_normal_sign(points: Float32Array, n: number): number {
    let area = 0
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n
      area += (points[i * 2 + 0] ?? 0) * (points[j * 2 + 1] ?? 0) - (points[j * 2 + 0] ?? 0) * (points[i * 2 + 1] ?? 0)
    }
    return area >= 0 ? 1 : -1
  }

  private write_closed_polyline_stroke_offset_vertex(points: Float32Array, n: number, normal_sign: number, i: number, distance: number, out: Float32Array): void {
    const pi = (i + n - 1) % n
    const ni = (i + 1) % n
    const px = points[i * 2 + 0] ?? 0
    const py = points[i * 2 + 1] ?? 0
    const prev_x = points[pi * 2 + 0] ?? px
    const prev_y = points[pi * 2 + 1] ?? py
    const next_x = points[ni * 2 + 0] ?? px
    const next_y = points[ni * 2 + 1] ?? py
    let d0x = px - prev_x
    let d0y = py - prev_y
    let d1x = next_x - px
    let d1y = next_y - py
    const d0l = Math.hypot(d0x, d0y)
    const d1l = Math.hypot(d1x, d1y)
    if (d0l <= 0.0001 || d1l <= 0.0001) {
      out[i * 2 + 0] = px
      out[i * 2 + 1] = py
      return
    }
    d0x /= d0l
    d0y /= d0l
    d1x /= d1l
    d1y /= d1l
    const n0x = d0y * normal_sign
    const n0y = -d0x * normal_sign
    const n1x = d1y * normal_sign
    const n1y = -d1x * normal_sign
    let mx = n0x + n1x
    let my = n0y + n1y
    const ml = Math.hypot(mx, my)
    if (ml <= 0.0001) {
      out[i * 2 + 0] = px + n1x * distance
      out[i * 2 + 1] = py + n1y * distance
      return
    }
    mx /= ml
    my /= ml
    const denom = Math.max(0.2, Math.abs(mx * n1x + my * n1y))
    const miter_len = Math.min(Math.abs(distance) / denom, Math.abs(distance) * 4)
    const sign = distance < 0 ? -1 : 1
    out[i * 2 + 0] = px + mx * miter_len * sign
    out[i * 2 + 1] = py + my * miter_len * sign
  }

  private current_clip(): clip_rect {
    return this.clip_stack[this.clip_stack.length - 1] ?? { x: 0, y: 0, w: this.canvas_width, h: this.canvas_height }
  }

  private ensure_vertices(extra_vertices: number): void {
    const needed = (this.vertex_count + extra_vertices) * vertex_stride
    if (needed <= this.vertex_data.byteLength) return
    let next = this.vertex_data.byteLength
    while (next < needed) next *= 2
    const next_buffer = new ArrayBuffer(next)
    new Uint8Array(next_buffer).set(new Uint8Array(this.vertex_data))
    this.vertex_data = next_buffer
    this.view = new DataView(this.vertex_data)
  }

  private push_vertex(x: number, y: number, u: number, v: number, color: number): void {
    this.ensure_vertices(1)
    const offset = this.vertex_count * vertex_stride
    this.view.setFloat32(offset + 0, x, true)
    this.view.setFloat32(offset + 4, y, true)
    this.view.setFloat32(offset + 8, u, true)
    this.view.setFloat32(offset + 12, v, true)
    this.view.setUint32(offset + 16, color, true)
    this.vertex_count += 1
  }

  private push_quad_colored(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    c00: number,
    c10: number,
    c11: number,
    c01: number,
  ): void {
    this.push_quad_points_colored(x0, y0, x1, y0, x1, y1, x0, y1, u0, v0, c00, c10, c11, c01, u1, v1)
  }

  private push_quad_points_colored(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    x3: number,
    y3: number,
    u: number,
    v: number,
    c0: number,
    c1: number,
    c2: number,
    c3: number,
    u1 = u,
    v1 = v,
  ): void {
    this.push_tri_colored(x0, y0, x1, y1, x2, y2, u, v, c0, c1, c2)
    this.push_tri_colored(x0, y0, x2, y2, x3, y3, u, v, c0, c2, c3, u1, v1)
  }

  private push_tri_colored(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    u: number,
    v: number,
    c0: number,
    c1: number,
    c2: number,
    u1 = u,
    v1 = v,
  ): void {
    const clip = this.current_clip()
    const min_x = Math.min(x0, x1, x2)
    const min_y = Math.min(y0, y1, y2)
    const max_x = Math.max(x0, x1, x2)
    const max_y = Math.max(y0, y1, y2)
    if (max_x <= clip.x || max_y <= clip.y || min_x >= clip.x + clip.w || min_y >= clip.y + clip.h) return
    const base = this.vertex_count
    this.push_vertex(x0, y0, u, v, c0)
    this.push_vertex(x1, y1, u1, v, c1)
    this.push_vertex(x2, y2, u1, v1, c2)
    this.emit_command(base, 3)
  }

  private push_quad(x0: number, y0: number, x1: number, y1: number, u0: number, v0: number, u1: number, v1: number, color: number): void {
    const clip = this.current_clip()
    const cx0 = Math.max(x0, clip.x)
    const cy0 = Math.max(y0, clip.y)
    const cx1 = Math.min(x1, clip.x + clip.w)
    const cy1 = Math.min(y1, clip.y + clip.h)
    if (cx1 <= cx0 || cy1 <= cy0) return
    const inv_w = 1 / Math.max(1e-6, x1 - x0)
    const inv_h = 1 / Math.max(1e-6, y1 - y0)
    const cu0 = u0 + (u1 - u0) * ((cx0 - x0) * inv_w)
    const cv0 = v0 + (v1 - v0) * ((cy0 - y0) * inv_h)
    const cu1 = u0 + (u1 - u0) * ((cx1 - x0) * inv_w)
    const cv1 = v0 + (v1 - v0) * ((cy1 - y0) * inv_h)
    const base = this.vertex_count
    this.push_vertex(cx0, cy0, cu0, cv0, color)
    this.push_vertex(cx1, cy0, cu1, cv0, color)
    this.push_vertex(cx1, cy1, cu1, cv1, color)
    this.push_vertex(cx0, cy0, cu0, cv0, color)
    this.push_vertex(cx1, cy1, cu1, cv1, color)
    this.push_vertex(cx0, cy1, cu0, cv1, color)
    this.emit_command(base, 6)
  }

  private push_tri(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number, u: number, v: number, color: number): void {
    const clip = this.current_clip()
    const min_x = Math.min(x0, x1, x2)
    const min_y = Math.min(y0, y1, y2)
    const max_x = Math.max(x0, x1, x2)
    const max_y = Math.max(y0, y1, y2)
    if (max_x <= clip.x || max_y <= clip.y || min_x >= clip.x + clip.w || min_y >= clip.y + clip.h) return
    const base = this.vertex_count
    this.push_vertex(x0, y0, u, v, color)
    this.push_vertex(x1, y1, u, v, color)
    this.push_vertex(x2, y2, u, v, color)
    this.emit_command(base, 3)
  }

  private emit_command(vertex_offset: number, vertex_count: number): void {
    const clip = this.current_clip()
    if (clip.w <= 0 || clip.h <= 0) return
    const cmd: ui_draw_command = {
      vertex_offset,
      vertex_count,
      texture_id: this.current_texture_id,
      clip_x: Math.floor(clip.x),
      clip_y: Math.floor(clip.y),
      clip_w: Math.ceil(clip.w),
      clip_h: Math.ceil(clip.h),
    }
    const prev = this.commands[this.commands.length - 1]
    if (
      prev &&
      prev.vertex_offset + prev.vertex_count === cmd.vertex_offset &&
      prev.texture_id === cmd.texture_id &&
      prev.clip_x === cmd.clip_x &&
      prev.clip_y === cmd.clip_y &&
      prev.clip_w === cmd.clip_w &&
      prev.clip_h === cmd.clip_h
    ) {
      prev.vertex_count += cmd.vertex_count
      return
    }
    this.commands.push(cmd)
  }

  private ensure_color_panel_texture(kind: 'square' | 'value', width: number, height: number): color_panel_texture | null {
    if (!this.device) return null
    const current = kind === 'square' ? this.color_square_texture : this.color_value_texture
    if (current && current.width === width && current.height === height) return current
    current?.texture.destroy()
    const texture = this.device.createTexture({
      label: `ui.texture.color_panel.${kind}`,
      size: [width, height, 1],
      format: 'rgba8unorm',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    })
    const next: color_panel_texture = {
      texture,
      texture_id: current?.texture_id ?? this.register_external_texture(texture),
      width,
      height,
    }
    if (current) this.update_external_texture(current.texture_id, texture)
    if (kind === 'square') this.color_square_texture = next
    else this.color_value_texture = next
    return next
  }

  private white_u(): number {
    return 0.5
  }

  private white_v(): number {
    return 0.5
  }
}
