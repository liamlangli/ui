import latin_mono_font_json_url from '../../assets/latin_mono.json?url'
import latin_mono_font_image_url from '../../assets/latin_mono.webp?url'
import ping_fang_font_json_url from '../../assets/ping_fang_sc_regular.json?url'
import ping_fang_font_image_url from '../../assets/ping_fang_sc_regular.webp?url'
import ui_shader_url from '../../assets/ui.wgsl?url'
import { ui_begin_metal_frame_capture, ui_consume_metal_frame_capture_request, ui_end_metal_frame_capture, ui_has_pending_metal_frame_capture } from './ui_gpu_capture'
import { clamp } from './ui_math'
import { memory } from './ui_memory'

export interface ui_draw_command {
  vertex_offset: number
  vertex_count: number
  texture_id: number
  kind?: ui_draw_command_kind
  clip_x: number
  clip_y: number
  clip_w: number
  clip_h: number
}

export type ui_draw_command_kind = 'image' | 'sdf' | 'msdf'

/**
 * A retained slice of geometry captured between {@link ui_renderer.begin_layer}
 * and {@link ui_renderer.end_layer}: the raw vertex bytes plus the draw commands
 * that reference them (rebased to a zero vertex offset). Replaying a layer with
 * {@link ui_renderer.replay_layer} re-emits that geometry into the current frame
 * — optionally translated — without re-running the (possibly expensive) code
 * that produced it. This is how callers cache the body of an inactive panel /
 * window and skip its layout + text shaping on frames where it hasn't changed.
 */
export interface ui_layer {
  vertices: ArrayBuffer
  vertex_count: number
  commands: ui_draw_command[]
  /** Origin the layer was captured at (so callers can compute a move delta). */
  origin_x: number
  origin_y: number
}

export interface ui_rect {
  x: number
  y: number
  w: number
  h: number
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
  baseline: number
  glyphs: Map<number, glyph_metric>
}

export const FONT_MAIN = 'FONT_MAIN' as const
export const FONT_ZH = 'FONT_ZH' as const
export const FONT_MONO = 'FONT_MONO' as const

export type ui_font_primitive = typeof FONT_MAIN | typeof FONT_ZH | typeof FONT_MONO
export type ui_text_msdf_value = number | ((ch: string, index: number) => number)

export interface ui_text_msdf_options {
  font?: ui_font_primitive
  /** Atlas distance range in texels. The bundled atlases use 5 by default. */
  range?: ui_text_msdf_value
  /** Positive values embolden, negative values lighten, in screen pixels. */
  weight?: ui_text_msdf_value
  /** Edge ramp width in screen pixels. Values above 1 soften the glyph. */
  softness?: ui_text_msdf_value
  shadow?: {
    dx: number
    dy: number
    color: number
    weight?: ui_text_msdf_value
    softness?: ui_text_msdf_value
  }
}

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

// A scissor rect plus an optional rounded-corner region (physical px). The
// scissor clips rectangularly as always; the rounded region lets axis-aligned
// fills round whichever corners coincide with it, so panel/body backgrounds
// drawn with fill_rect don't poke past a window's rounded frame. The region is
// inherited by nested rectangular clips. round_r 0 means "no rounding".
type clip_rect = {
  x: number
  y: number
  w: number
  h: number
  round_x: number
  round_y: number
  round_w: number
  round_h: number
  round_r: number
}

function make_clip(x: number, y: number, w: number, h: number): clip_rect {
  return { x, y, w, h, round_x: 0, round_y: 0, round_w: 0, round_h: 0, round_r: 0 }
}

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

const vertex_stride = 36
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
enable f16;

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

fn hsv_to_rgb(h : f16, s : f16, v : f16) -> vec3<f16> {
  let hh = ((h % 360.0) + 360.0) % 360.0;
  let ss = clamp(s, 0.0, 1.0);
  let vv = clamp(v, 0.0, 1.0);
  let c = vv * ss;
  let x = c * (1.0 - abs(((hh / 60.0) % 2.0) - 1.0));
  let m = vv - c;
  if (hh < 60.0) { return vec3<f16>(c + m, x + m, m); }
  if (hh < 120.0) { return vec3<f16>(x + m, c + m, m); }
  if (hh < 180.0) { return vec3<f16>(m, c + m, x + m); }
  if (hh < 240.0) { return vec3<f16>(m, x + m, c + m); }
  if (hh < 300.0) { return vec3<f16>(x + m, m, c + m); }
  return vec3<f16>(c + m, m, x + m);
}

fn hash12(p : vec2f) -> f32 {
  // Kept in f32: the large multiplier and sin() argument lose all entropy in f16.
  let h = dot(p, vec2f(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

@fragment
fn fs_main(v : v_out) -> @location(0) vec4f {
  let uv = clamp(v.uv, vec2f(0.0), vec2f(1.0));
  var color = vec3<f16>(0.0);
  var alpha : f16 = 1.0;
  if (u.mode < 0.5) {
    color = hsv_to_rgb(f16(uv.x) * 360.0, 1.0 - f16(uv.y), f16(u.data.x));
  } else {
    color = hsv_to_rgb(f16(u.data.x), f16(u.data.y), 1.0 - f16(uv.y));
    alpha = clamp(f16(u.data.z), 0.0, 1.0);
  }
  let noise = (hash12(floor(uv * u.size)) - 0.5) / 255.0;
  color = clamp(color + vec3<f16>(f16(noise)), vec3<f16>(0.0), vec3<f16>(1.0));
  return vec4f(vec3f(color), f32(alpha));
}
`

// The shaders are authored with f16 (half) types to cut GPU ALU/bandwidth.
// When the device lacks the `shader-f16` feature, downgrade every f16 type back
// to f32 so the same source compiles. All numeric literals are written without
// the `h` suffix (relying on abstract-float conversion), so the only tokens to
// rewrite are the `f16` type names and the `enable f16;` directive.
function apply_f16(code: string, enabled: boolean): string {
  if (enabled) return code
  return code.replace(/^[ \t]*enable[ \t]+f16[ \t]*;[ \t]*\r?\n?/m, '').replace(/\bf16\b/g, 'f32')
}

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

// Estimated bytes per texel for the formats the UI touches; unknown formats
// assume 4 (every 8-bit RGBA swapchain format).
const texture_format_bytes: Partial<Record<GPUTextureFormat, number>> = {
  r8unorm: 1,
  rg8unorm: 2,
  rgba8unorm: 4,
  'rgba8unorm-srgb': 4,
  bgra8unorm: 4,
  'bgra8unorm-srgb': 4,
  rgba16float: 8,
  rgba32float: 16,
}

function gpu_texture_bytes(texture: GPUTexture): number {
  return texture.width * texture.height * Math.max(1, texture.depthOrArrayLayers) * (texture_format_bytes[texture.format] ?? 4)
}

// Rough per-glyph CPU footprint of a font atlas table: 7 numbers + map entry overhead.
const glyph_table_bytes_per_entry = 88

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

const baseline_reference_codepoints = [72, 77, 78, 73, 76, 69, 88, 84]

function detect_baseline(glyphs: Map<number, glyph_metric>, font_size: number): number {
  for (const code of baseline_reference_codepoints) {
    const g = glyphs.get(code)
    if (g && g.height > 0) return g.y_offset + g.height
  }
  return Math.round(font_size * 0.8)
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
    baseline: detect_baseline(glyphs, doc.size),
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

// Intersect scissor bounds while inheriting the parent's rounded region, so a
// plain push_clip nested inside a rounded clip still rounds the right corners.
function clip_intersect(a: clip_rect, b: { x: number; y: number; w: number; h: number }): clip_rect {
  const x0 = Math.max(a.x, b.x)
  const y0 = Math.max(a.y, b.y)
  const x1 = Math.min(a.x + a.w, b.x + b.w)
  const y1 = Math.min(a.y + a.h, b.y + b.h)
  return {
    x: x0,
    y: y0,
    w: Math.max(0, x1 - x0),
    h: Math.max(0, y1 - y0),
    round_x: a.round_x,
    round_y: a.round_y,
    round_w: a.round_w,
    round_h: a.round_h,
    round_r: a.round_r,
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
  private pipeline_msdf: GPURenderPipeline | null = null
  private color_panel_pipeline: GPURenderPipeline | null = null
  private bind_group_white: GPUBindGroup | null = null
  private readonly font_bind_groups = new Map<number, GPUBindGroup>()
  private readonly extra_bind_groups = new Map<number, GPUBindGroup>()
  private vertex_buffer: GPUBuffer | null = null
  private vertex_data = new ArrayBuffer(4096 * vertex_stride)
  private view = new DataView(this.vertex_data)
  private vertex_count = 0
  private need_enlarge = false
  private commands: ui_draw_command[] = []
  private clip_stack: clip_rect[] = []
  private current_texture_id = white_texture_id
  // Retained-layer recording (see begin_layer / end_layer / replay_layer).
  private layer_start_vertex = 0
  private layer_start_command = 0
  private layer_origin_x = 0
  private layer_origin_y = 0
  // Forces the next emit_command to start a fresh command instead of merging
  // into the previous one, so a captured layer never straddles its boundary.
  private break_command_merge = false
  private readonly font_atlases = new Map<ui_font_primitive, font_atlas>()
  private chinese_font_load: Promise<void> | null = null
  private canvas_width = 1
  private canvas_height = 1
  private bind_group_layout: GPUBindGroupLayout | null = null
  private color_panel_bind_group_layout: GPUBindGroupLayout | null = null
  private sampler: GPUSampler | null = null
  private sampler_nearest: GPUSampler | null = null
  private readonly data_textures = new Map<number, data_texture>()
  private readonly external_texture_names = new Map<number, string>()
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

  constructor(private readonly canvas: HTMLCanvasElement) {
    memory.track('ui.primitive_buffer', 'geometry', 'cpu', this.vertex_data.byteLength, 'frame vertex staging')
  }

  async init(options?: ui_renderer_init_options): Promise<void> {
    this.render_mode_ = options?.mode ?? 'adaptive'
    this.pending_render_frames = adaptive_render_burst_frames
    if (!('gpu' in navigator)) throw new Error('WebGPU not supported')
    const adapter = await navigator.gpu.requestAdapter()
    if (!adapter) throw new Error('WebGPU adapter unavailable')
    const requiredFeatures: GPUFeatureName[] = adapter.features.has('shader-f16') ? ['shader-f16'] : []
    const requiredLimits: Record<string, number> = {}
    const storageLimit = adapter.limits.maxStorageBufferBindingSize
    const bufferLimit = adapter.limits.maxBufferSize
    if (storageLimit > 128 * 1024 * 1024) requiredLimits.maxStorageBufferBindingSize = storageLimit
    if (bufferLimit > 256 * 1024 * 1024) requiredLimits.maxBufferSize = bufferLimit
    this.device = await adapter.requestDevice({
      requiredFeatures,
      ...(Object.keys(requiredLimits).length > 0 ? { requiredLimits } : {}),
    })
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
    memory.track('ui.screen_buffer', 'buffer', 'gpu', 8, 'screen-size uniform')
    this.track_glyph_tables()

    const f16 = this.device.features.has('shader-f16')
    const shader_module = this.device.createShaderModule({ label: 'ui.shader_module', code: apply_f16(shader_code, f16) })
    const color_panel_module = this.device.createShaderModule({ label: 'ui.shader_module.color_panel', code: apply_f16(color_panel_shader, f16) })
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
        { shaderLocation: 3, offset: 20, format: 'float32x4' },
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
    this.pipeline_msdf = this.device.createRenderPipeline({
      label: 'ui.pipeline.msdf',
      layout: pipeline_layout,
      vertex: { module: shader_module, entryPoint: 'vs_main', buffers: [vertex] },
      fragment: { module: shader_module, entryPoint: 'fs_msdf_var', targets: [color_target] },
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
    memory.track('ui.white_texture', 'texture', 'gpu', 4, '1×1 rgba8')
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
    memory.track('ui.buffer.color_panel', 'buffer', 'gpu', 32, 'color panel uniform')
    this.resize()

    // The Chinese atlas is large, so load it off the critical path. The CJK
    // slot keeps its transparent placeholder until the real atlas arrives.
    if (options?.chinese_font ?? true) void this.load_chinese_font()
  }

  async init_with_device(device: GPUDevice, format: GPUTextureFormat, options?: ui_renderer_init_options): Promise<void> {
    this.render_mode_ = options?.mode ?? 'adaptive'
    this.pending_render_frames = adaptive_render_burst_frames
    this.device = device
    this.context = null
    this.format = format

    const [shader_code, latin_mono_font_doc] = await Promise.all([
      load_text(ui_shader_url),
      load_json<font_bundle_doc>(latin_mono_font_json_url),
    ])
    const latin_mono_font_image = await load_image_bitmap_asset(font_image_url(latin_mono_font_doc, 'latin_mono'))
    this.font_atlases.set(FONT_MAIN, glyph_map(font_face(latin_mono_font_doc, FONT_MAIN), latin_mono_font_doc.width, latin_mono_font_doc.height))
    this.font_atlases.set(FONT_MONO, glyph_map(font_face(latin_mono_font_doc, FONT_MONO), latin_mono_font_doc.width, latin_mono_font_doc.height))
    this.screen_buffer = this.device.createBuffer({ label: 'ui.screen_buffer', size: 8, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST })
    memory.track('ui.screen_buffer', 'buffer', 'gpu', 8, 'screen-size uniform')
    this.track_glyph_tables()

    const f16 = this.device.features.has('shader-f16')
    const shader_module = this.device.createShaderModule({ label: 'ui.shader_module', code: apply_f16(shader_code, f16) })
    const color_panel_module = this.device.createShaderModule({ label: 'ui.shader_module.color_panel', code: apply_f16(color_panel_shader, f16) })
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
        { shaderLocation: 3, offset: 20, format: 'float32x4' },
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
    this.pipeline_msdf = this.device.createRenderPipeline({
      label: 'ui.pipeline.msdf',
      layout: pipeline_layout,
      vertex: { module: shader_module, entryPoint: 'vs_main', buffers: [vertex] },
      fragment: { module: shader_module, entryPoint: 'fs_msdf_var', targets: [color_target] },
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
    memory.track('ui.white_texture', 'texture', 'gpu', 4, '1×1 rgba8')
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
    memory.track('ui.buffer.color_panel', 'buffer', 'gpu', 32, 'color panel uniform')
    this.resize_to(this.canvas.width || 1, this.canvas.height || 1)

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
    memory.untrack('ui.font_texture.cjk.placeholder')
    this.track_glyph_tables()
  }

  /** Report the CPU-side glyph metric tables of every loaded font atlas. */
  private track_glyph_tables(): void {
    for (const [type, atlas] of this.font_atlases) {
      const label = type === FONT_MAIN ? 'main' : type === FONT_MONO ? 'mono' : 'cjk'
      memory.track(`ui.font_glyphs.${label}`, 'font', 'cpu', atlas.glyphs.size * glyph_table_bytes_per_entry, `${atlas.glyphs.size} glyphs`)
    }
  }

  resize(): void {
    if (!this.device || !this.context || !this.format || !this.screen_buffer) return
    const dpr = window.devicePixelRatio || 1
    // `clientWidth/clientHeight` already exclude the device safe area: the
    // canvas element is inset via `env(safe-area-inset-*)` CSS, so its own box
    // never covers the notch / rounded corners / home indicator. Everything the
    // renderer reports (canvas_size / safe_rect) is therefore the corrected,
    // safe drawable surface, and no draw-time clipping is needed.
    this.canvas_width = Math.max(1, Math.floor(this.canvas.clientWidth * dpr))
    this.canvas_height = Math.max(1, Math.floor(this.canvas.clientHeight * dpr))
    this.canvas.width = this.canvas_width
    this.canvas.height = this.canvas_height
    this.context.configure({ device: this.device, format: this.format, alphaMode: 'opaque' })
    this.device.queue.writeBuffer(this.screen_buffer, 0, new Float32Array([this.canvas_width, this.canvas_height]))
    this.request_render()
  }

  resize_to(width: number, height: number): void {
    if (!this.device || !this.screen_buffer) return
    this.canvas_width = Math.max(1, Math.floor(width))
    this.canvas_height = Math.max(1, Math.floor(height))
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
    this.clip_stack = [make_clip(0, 0, this.canvas_width, this.canvas_height)]
    this.current_texture_id = white_texture_id
    this.break_command_merge = false
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
    this.track_external_texture(id, texture)
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
    this.track_external_texture(texture_id, texture)
  }

  private track_external_texture(texture_id: number, texture: GPUTexture): void {
    const prev_name = this.external_texture_names.get(texture_id)
    const name = texture.label || prev_name || `ui.external_texture.${texture_id}`
    if (prev_name && prev_name !== name) memory.untrack(prev_name)
    this.external_texture_names.set(texture_id, name)
    memory.track(name, 'texture', 'gpu', gpu_texture_bytes(texture), `${texture.width}×${texture.height} ${texture.format}`)
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
    memory.track(`ui.data_texture.${id}`, 'texture', 'gpu', w * h * 4, `${w}×${h} rgba8`)
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
      memory.track(`ui.data_texture.${texture_id}`, 'texture', 'gpu', w * h * 4, `${w}×${h} rgba8`)
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
    memory.untrack(`ui.data_texture.${texture_id}`)
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

  draw_texture_round_rect(texture_id: number, x: number, y: number, w: number, h: number, radius: number, options?: { filter?: ui_texture_filter }): void {
    if (w <= 0 || h <= 0) return
    if (radius <= 0) {
      this.draw_texture(texture_id, x, y, w, h, options)
      return
    }
    if (options?.filter) {
      const entry = this.data_textures.get(texture_id)
      if (entry && entry.filter !== options.filter) {
        entry.filter = options.filter
        this.extra_bind_groups.set(texture_id, this.create_data_texture_bind_group(texture_id, entry.texture, entry.filter))
      }
    }
    const pts = this.round_rect_points
    const r = Math.min(Math.max(0, radius), Math.min(w, h) * 0.5)
    const n = compact_closed_polyline_points(pts, build_round_rect_points(pts, x, y, w, h, r, r, r, r))
    if (n < 3) return

    this.current_texture_id = texture_id
    const cx = x + w * 0.5
    const cy = y + h * 0.5
    const cu = 0.5
    const cv = 0.5
    const inv_w = 1 / w
    const inv_h = 1 / h
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n
      const x1 = pts[i * 2]!
      const y1 = pts[i * 2 + 1]!
      const x2 = pts[j * 2]!
      const y2 = pts[j * 2 + 1]!
      this.push_tri_textured(
        cx,
        cy,
        cu,
        cv,
        x1,
        y1,
        (x1 - x) * inv_w,
        (y1 - y) * inv_h,
        x2,
        y2,
        (x2 - x) * inv_w,
        (y2 - y) * inv_h,
        0xffffffff,
      )
    }
  }

  draw_texture_region(texture_id: number, x: number, y: number, w: number, h: number, u0: number, v0: number, u1: number, v1: number, color = 0xffffffff): void {
    if (w <= 0 || h <= 0) return
    this.current_texture_id = texture_id
    this.push_quad(x, y, x + w, y + h, u0, v0, u1, v1, color)
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

  /**
   * Push a clip that also marks (x, y, w, h) as a rounded-corner region with the
   * given corner `radius`. The scissor is still rectangular, but {@link fill_rect}
   * (and other axis-aligned fills) automatically round whichever of their corners
   * land on this region's corners — so a panel/body background drawn with a plain
   * rect stays inside a window's rounded frame instead of poking past it. The
   * region carries through nested {@link push_clip} calls. Balance with
   * {@link pop_clip}.
   */
  push_clip_round(x: number, y: number, w: number, h: number, radius: number): void {
    const next = clip_intersect(this.current_clip(), { x, y, w, h })
    next.round_x = x
    next.round_y = y
    next.round_w = w
    next.round_h = h
    next.round_r = Math.max(0, radius)
    this.clip_stack.push(next)
  }

  pop_clip(): void {
    if (this.clip_stack.length > 1) this.clip_stack.pop()
  }

  /**
   * True when the axis-aligned rect (x, y, w, h) lies fully outside the current
   * clip rectangle, so nothing drawn within it could be visible. Callers can use
   * this to cull widgets on the CPU and early-return before doing any layout,
   * text shaping, or geometry work for fully scrolled-out / off-screen content.
   * Mirrors the per-primitive clip test used by {@link push_quad}/{@link push_tri}.
   */
  rect_clipped(x: number, y: number, w: number, h: number): boolean {
    const clip = this.current_clip()
    return x + w <= clip.x || y + h <= clip.y || x >= clip.x + clip.w || y >= clip.y + clip.h
  }

  set_cursor(cursor: string | null): void {
    this.canvas.style.cursor = cursor ?? ''
  }

  /**
   * Begin recording a retained layer. Geometry emitted until {@link end_layer}
   * is also drawn into the current frame as usual; `end_layer` additionally
   * returns a {@link ui_layer} copy you can stash and {@link replay_layer} on
   * later frames to skip re-running the producing code.
   *
   * `origin_x`/`origin_y` are remembered on the layer so callers can later pass
   * `replay_layer(layer, now_x - layer.origin_x, ...)` to move a cached panel.
   * Layers are flat captures — do not nest begin_layer calls.
   */
  begin_layer(origin_x = 0, origin_y = 0): void {
    this.layer_start_vertex = this.vertex_count
    this.layer_start_command = this.commands.length
    this.layer_origin_x = origin_x
    this.layer_origin_y = origin_y
    // The first command of the layer must not coalesce into a pre-layer command.
    this.break_command_merge = true
  }

  /** Finish recording and return the captured layer (vertex offsets rebased to 0). */
  end_layer(): ui_layer {
    const v0 = this.layer_start_vertex
    const vertex_count = this.vertex_count - v0
    const vertices = this.vertex_data.slice(v0 * vertex_stride, this.vertex_count * vertex_stride)
    const commands: ui_draw_command[] = []
    for (let i = this.layer_start_command; i < this.commands.length; i += 1) {
      const c = this.commands[i]
      commands.push({ ...c, vertex_offset: c.vertex_offset - v0 })
    }
    return { vertices, vertex_count, commands, origin_x: this.layer_origin_x, origin_y: this.layer_origin_y }
  }

  /**
   * Re-emit a captured {@link ui_layer} into the current frame, optionally
   * translated by (dx, dy) in pixels. Commands are re-clipped against the live
   * clip stack, so replaying inside a `push_clip` confines the cached geometry.
   */
  replay_layer(layer: ui_layer, dx = 0, dy = 0): void {
    if (layer.vertex_count <= 0) return
    this.ensure_vertices(layer.vertex_count)
    const base = this.vertex_count
    const base_byte = base * vertex_stride
    const span = layer.vertex_count * vertex_stride
    new Uint8Array(this.vertex_data, base_byte, span).set(new Uint8Array(layer.vertices, 0, span))
    if (dx !== 0 || dy !== 0) {
      for (let i = 0; i < layer.vertex_count; i += 1) {
        const o = base_byte + i * vertex_stride
        this.view.setFloat32(o + 0, this.view.getFloat32(o + 0, true) + dx, true)
        this.view.setFloat32(o + 4, this.view.getFloat32(o + 4, true) + dy, true)
      }
    }
    this.vertex_count += layer.vertex_count
    const clip = this.current_clip()
    // A replayed run is contiguous but pre-built, so never merge the first
    // command into whatever the live frame emitted just before it.
    let merge = false
    for (const c of layer.commands) {
      const cc = clip_intersect(clip, { x: c.clip_x + dx, y: c.clip_y + dy, w: c.clip_w, h: c.clip_h })
      if (cc.w <= 0 || cc.h <= 0) {
        merge = false
        continue
      }
      const cmd: ui_draw_command = {
        vertex_offset: base + c.vertex_offset,
        vertex_count: c.vertex_count,
        texture_id: c.texture_id,
        kind: c.kind,
        clip_x: Math.floor(cc.x),
        clip_y: Math.floor(cc.y),
        clip_w: Math.ceil(cc.w),
        clip_h: Math.ceil(cc.h),
      }
      const prev = merge ? this.commands[this.commands.length - 1] : undefined
      if (
        prev &&
        prev.vertex_offset + prev.vertex_count === cmd.vertex_offset &&
        prev.texture_id === cmd.texture_id &&
        prev.kind === cmd.kind &&
        prev.clip_x === cmd.clip_x &&
        prev.clip_y === cmd.clip_y &&
        prev.clip_w === cmd.clip_w &&
        prev.clip_h === cmd.clip_h
      ) {
        prev.vertex_count += cmd.vertex_count
      } else {
        this.commands.push(cmd)
      }
      merge = true
    }
    // Keep the next live command from merging into the replayed tail.
    this.break_command_merge = true
  }

  fill_rect(x: number, y: number, w: number, h: number, rgba: number, feather = 0): void {
    if (w <= 0 || h <= 0) return
    // Under a rounded clip region, round whichever corners of this rect sit on
    // the region's corners so backgrounds honor the (e.g. window) rounded frame.
    const clip = this.current_clip()
    if (clip.round_r > 0) {
      const eps = 0.5
      const left = x <= clip.round_x + eps
      const right = x + w >= clip.round_x + clip.round_w - eps
      const top = y <= clip.round_y + eps
      const bottom = y + h >= clip.round_y + clip.round_h - eps
      const r = clip.round_r
      const rtl = left && top ? r : 0
      const rtr = right && top ? r : 0
      const rbl = left && bottom ? r : 0
      const rbr = right && bottom ? r : 0
      if (rtl > 0 || rtr > 0 || rbl > 0 || rbr > 0) {
        this.fill_round_rect_per_corner(x, y, w, h, rtl, rtr, rbl, rbr, rgba, Math.max(feather, default_round_rect_feather))
        return
      }
    }
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

  stroke_circle(cx: number, cy: number, radius: number, thickness: number, rgba: number, feather = 0): void {
    if (radius <= 0) return
    const t = Math.max(1, thickness)
    const inner_r = Math.max(0, radius - t * 0.5)
    const outer_r = radius + t * 0.5
    const f = Math.max(0, feather)
    const steps = circle_sector_count(outer_r + f)
    if (steps <= 0) return
    this.current_texture_id = white_texture_id
    const u = this.white_u()
    const v = this.white_v()
    const transparent = transparent_color(rgba)
    const fin_r = Math.max(0, inner_r - f)
    const fout_r = outer_r + f
    let p_in_x = cx + inner_r
    let p_in_y = cy
    let p_out_x = cx + outer_r
    let p_out_y = cy
    let p_fin_x = cx + fin_r
    let p_fin_y = cy
    let p_fout_x = cx + fout_r
    let p_fout_y = cy
    for (let i = 1; i <= steps; i += 1) {
      const a = (i / steps) * Math.PI * 2
      const ca = Math.cos(a)
      const sa = Math.sin(a)
      const in_x = cx + ca * inner_r
      const in_y = cy + sa * inner_r
      const out_x = cx + ca * outer_r
      const out_y = cy + sa * outer_r
      this.push_quad_points_colored(p_in_x, p_in_y, in_x, in_y, out_x, out_y, p_out_x, p_out_y, u, v, rgba, rgba, rgba, rgba)
      if (f > 0) {
        const fin_x = cx + ca * fin_r
        const fin_y = cy + sa * fin_r
        const fout_x = cx + ca * fout_r
        const fout_y = cy + sa * fout_r
        this.push_quad_points_colored(p_fin_x, p_fin_y, fin_x, fin_y, in_x, in_y, p_in_x, p_in_y, u, v, transparent, transparent, rgba, rgba)
        this.push_quad_points_colored(p_out_x, p_out_y, out_x, out_y, fout_x, fout_y, p_fout_x, p_fout_y, u, v, rgba, rgba, transparent, transparent)
        p_fin_x = fin_x
        p_fin_y = fin_y
        p_fout_x = fout_x
        p_fout_y = fout_y
      }
      p_in_x = in_x
      p_in_y = in_y
      p_out_x = out_x
      p_out_y = out_y
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

  /**
   * Stroke an open polyline as a single continuous ribbon. Interior vertices use
   * a miter join (clamped) so segments meet without the overlap/gap a sequence of
   * independent `stroke_line` quads produces, and the optional feather skirt runs
   * along the whole outline for clean antialiased edges. `points` is a flat
   * [x0, y0, x1, y1, ...] array of `point_count` vertices.
   */
  stroke_polyline(points: ArrayLike<number>, point_count: number, thickness: number, rgba: number, feather = 0): void {
    if (point_count < 2) return
    const half = Math.max(0.5, thickness * 0.5)
    const f = Math.max(0, feather)
    const has_feather = f > 0
    const outer = new Float32Array(point_count * 2)
    const inner = new Float32Array(point_count * 2)
    const feather_outer = has_feather ? new Float32Array(point_count * 2) : null
    const feather_inner = has_feather ? new Float32Array(point_count * 2) : null

    for (let i = 0; i < point_count; i += 1) {
      const px = points[i * 2 + 0] ?? 0
      const py = points[i * 2 + 1] ?? 0
      // Per-segment unit normals on either side of this vertex (perp = (-dy, dx)).
      let n0x = 0
      let n0y = 0
      let has0 = false
      if (i > 0) {
        const dx = px - (points[(i - 1) * 2 + 0] ?? px)
        const dy = py - (points[(i - 1) * 2 + 1] ?? py)
        const l = Math.hypot(dx, dy)
        if (l > 0.0001) {
          n0x = -dy / l
          n0y = dx / l
          has0 = true
        }
      }
      let n1x = 0
      let n1y = 0
      let has1 = false
      if (i < point_count - 1) {
        const dx = (points[(i + 1) * 2 + 0] ?? px) - px
        const dy = (points[(i + 1) * 2 + 1] ?? py) - py
        const l = Math.hypot(dx, dy)
        if (l > 0.0001) {
          n1x = -dy / l
          n1y = dx / l
          has1 = true
        }
      }
      // Join direction: miter (bisector) on interior vertices, butt cap on the ends.
      let mx: number
      let my: number
      let scale = 1
      if (has0 && has1) {
        mx = n0x + n1x
        my = n0y + n1y
        const ml = Math.hypot(mx, my)
        if (ml > 0.0001) {
          mx /= ml
          my /= ml
          const denom = Math.max(0.2, mx * n1x + my * n1y)
          scale = Math.min(1 / denom, 4)
        } else {
          mx = n1x
          my = n1y
        }
      } else if (has1) {
        mx = n1x
        my = n1y
      } else {
        mx = n0x
        my = n0y
      }
      const ox = mx * half * scale
      const oy = my * half * scale
      outer[i * 2 + 0] = px + ox
      outer[i * 2 + 1] = py + oy
      inner[i * 2 + 0] = px - ox
      inner[i * 2 + 1] = py - oy
      if (feather_outer && feather_inner) {
        const fx = mx * (half + f) * scale
        const fy = my * (half + f) * scale
        feather_outer[i * 2 + 0] = px + fx
        feather_outer[i * 2 + 1] = py + fy
        feather_inner[i * 2 + 0] = px - fx
        feather_inner[i * 2 + 1] = py - fy
      }
    }

    this.current_texture_id = white_texture_id
    const u = this.white_u()
    const v = this.white_v()
    const transparent = transparent_color(rgba)
    for (let i = 0; i < point_count - 1; i += 1) {
      const j = i + 1
      const ox0 = outer[i * 2 + 0] ?? 0
      const oy0 = outer[i * 2 + 1] ?? 0
      const ox1 = outer[j * 2 + 0] ?? 0
      const oy1 = outer[j * 2 + 1] ?? 0
      const ix0 = inner[i * 2 + 0] ?? 0
      const iy0 = inner[i * 2 + 1] ?? 0
      const ix1 = inner[j * 2 + 0] ?? 0
      const iy1 = inner[j * 2 + 1] ?? 0
      this.push_tri(ox0, oy0, ox1, oy1, ix0, iy0, u, v, rgba)
      this.push_tri(ix0, iy0, ox1, oy1, ix1, iy1, u, v, rgba)
      if (feather_outer && feather_inner) {
        const fox0 = feather_outer[i * 2 + 0] ?? 0
        const foy0 = feather_outer[i * 2 + 1] ?? 0
        const fox1 = feather_outer[j * 2 + 0] ?? 0
        const foy1 = feather_outer[j * 2 + 1] ?? 0
        const fix0 = feather_inner[i * 2 + 0] ?? 0
        const fiy0 = feather_inner[i * 2 + 1] ?? 0
        const fix1 = feather_inner[j * 2 + 0] ?? 0
        const fiy1 = feather_inner[j * 2 + 1] ?? 0
        this.push_quad_points_colored(ox0, oy0, ox1, oy1, fox1, foy1, fox0, foy0, u, v, rgba, rgba, transparent, transparent)
        this.push_quad_points_colored(ix1, iy1, ix0, iy0, fix0, fiy0, fix1, fiy1, u, v, rgba, rgba, transparent, transparent)
      }
    }
  }

  draw_text(x: number, y: number, text: string, font_px: number, rgba: number, font_type: ui_font_primitive = FONT_MAIN): void {
    if (!text || !this.font_atlases.size) return
    // CPU cull: text advances rightward and downward from (x, y), so a run whose
    // top-left starts past the clip's right/bottom edge can never be visible, and
    // a single line ending above the clip's top is fully clipped too. Skip the
    // whole shaping loop in those cases; partial overlap still relies on the
    // per-glyph clip test in push_quad.
    const clip = this.current_clip()
    if (x >= clip.x + clip.w || y >= clip.y + clip.h) return
    if (text.indexOf('\n') < 0 && y + this.text_line_height(font_px, font_type) <= clip.y) return
    const effective_font_px = font_px * default_font_scale
    const primary = this.font_atlases.get(font_type) ?? this.font_atlases.get(FONT_MAIN)
    let cx = x
    let cy = y
    let baseline_y = primary ? cy + primary.baseline * (effective_font_px / primary.font_size) : cy
    for (const ch of text) {
      if (ch === '\n') {
        cx = x
        cy += this.text_line_height(font_px, font_type)
        baseline_y = primary ? cy + primary.baseline * (effective_font_px / primary.font_size) : cy
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
      const y0 = baseline_y - (font.atlas.baseline - glyph.y_offset) * scale
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

  draw_text_msdf(x: number, y: number, text: string, font_px: number, rgba: number, options?: ui_text_msdf_options): void {
    if (!text || !this.font_atlases.size) return
    const font_type = options?.font ?? FONT_MAIN
    if (options?.shadow) {
      const sh = options.shadow
      this.draw_text_msdf_run(
        x + sh.dx,
        y + sh.dy,
        text,
        font_px,
        sh.color,
        font_type,
        options.range ?? 5,
        sh.weight ?? options.weight ?? 0,
        sh.softness ?? options.softness ?? 1,
      )
    }
    this.draw_text_msdf_run(
      x,
      y,
      text,
      font_px,
      rgba,
      font_type,
      options?.range ?? 5,
      options?.weight ?? 0,
      options?.softness ?? 1,
    )
  }

  private draw_text_msdf_run(
    x: number,
    y: number,
    text: string,
    font_px: number,
    rgba: number,
    font_type: ui_font_primitive,
    range: ui_text_msdf_value,
    weight: ui_text_msdf_value,
    softness: ui_text_msdf_value,
  ): void {
    const clip = this.current_clip()
    if (x >= clip.x + clip.w || y >= clip.y + clip.h) return
    if (text.indexOf('\n') < 0 && y + this.text_line_height(font_px, font_type) <= clip.y) return
    const effective_font_px = font_px * default_font_scale
    const primary = this.font_atlases.get(font_type) ?? this.font_atlases.get(FONT_MAIN)
    let cx = x
    let cy = y
    let glyph_index = 0
    let baseline_y = primary ? cy + primary.baseline * (effective_font_px / primary.font_size) : cy
    for (const ch of text) {
      if (ch === '\n') {
        cx = x
        cy += this.text_line_height(font_px, font_type)
        baseline_y = primary ? cy + primary.baseline * (effective_font_px / primary.font_size) : cy
        continue
      }
      const char_index = glyph_index
      glyph_index += 1
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
      const y0 = baseline_y - (font.atlas.baseline - glyph.y_offset) * scale
      const x1 = x0 + glyph.width * scale
      const y1 = y0 + glyph.height * scale
      this.current_texture_id = font.texture_id
      this.push_quad_msdf(
        x0,
        y0,
        x1,
        y1,
        glyph.atlas_x * inv_w,
        glyph.atlas_y * inv_h,
        (glyph.atlas_x + glyph.width) * inv_w,
        (glyph.atlas_y + glyph.height) * inv_h,
        rgba,
        this.resolve_text_msdf_value(range, ch, char_index),
        this.resolve_text_msdf_value(weight, ch, char_index),
        this.resolve_text_msdf_value(softness, ch, char_index),
      )
      cx += glyph.x_advance * scale
    }
  }

  private resolve_text_msdf_value(value: ui_text_msdf_value, ch: string, index: number): number {
    return typeof value === 'function' ? value(ch, index) : value
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
    if (!this.device || !this.context || !this.pipeline_image || !this.pipeline_sdf || !this.pipeline_msdf || !this.bind_group_white) return
    const vertex_byte_length = this.vertex_count * vertex_stride
    const byte_length = Math.max(vertex_byte_length, vertex_stride)
    const should_render = this.render_mode_ !== 'adaptive' || this.pending_render_frames > 0 || ui_has_pending_metal_frame_capture()
    if (should_render) {
      if (this.render_mode_ === 'adaptive' && this.pending_render_frames > 0) this.pending_render_frames -= 1
      const capture_request = ui_consume_metal_frame_capture_request()
      const capture = capture_request ? ui_begin_metal_frame_capture(capture_request) : null
      // Grow the GPU vertex buffer only here, right before we render. The CPU
      // side buffer is grown per primitive during the frame, never per vertex.
      try {
        this.ensure_vertex_buffer(byte_length)
        this.last_frame_stats = this.capture_stats(byte_length)
        this.device.queue.writeBuffer(this.vertex_buffer, 0, this.vertex_data, 0, vertex_byte_length)
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
        this.encode_render_pass(pass)
        pass.end()
        this.device.queue.submit([encoder.finish()])
      } finally {
        ui_end_metal_frame_capture(capture)
      }
    } else {
      this.last_frame_stats = this.capture_stats(this.vertex_buffer?.size ?? byte_length)
    }
    // Reset the frame buffers regardless of whether we rendered, so a skipped
    // frame never leaves stale geometry behind for the next one.
    this.vertex_count = 0
    this.commands = []
    this.enlarge_if_needed()
  }

  render(pass: GPURenderPassEncoder): void {
    if (!this.device || !this.pipeline_image || !this.pipeline_sdf || !this.pipeline_msdf || !this.bind_group_white) return
    const vertex_byte_length = this.vertex_count * vertex_stride
    const byte_length = Math.max(vertex_byte_length, vertex_stride)
    this.ensure_vertex_buffer(byte_length)
    this.last_frame_stats = this.capture_stats(byte_length)
    this.device.queue.writeBuffer(this.vertex_buffer, 0, this.vertex_data, 0, vertex_byte_length)
    this.encode_render_pass(pass)
    this.vertex_count = 0
    this.commands = []
    this.enlarge_if_needed()
  }

  /**
   * Render `draw` into an offscreen `target` texture sized `width`x`height`
   * texels, using the very same immediate-mode primitives as on-screen drawing.
   * The pixel→NDC mapping is temporarily rebased to the target's size, so
   * geometry emitted over (0,0)..(width,height) covers the target exactly.
   *
   * The shared vertex / command buffers and clip stack are saved and restored
   * around the call, so this is safe to invoke at any time without disturbing an
   * in-progress frame. `target` must be created with
   * `GPUTextureUsage.RENDER_ATTACHMENT` and the renderer's colour `format`
   * (see {@link gpu}). When `clear` is omitted the target's existing contents
   * are preserved (`loadOp: 'load'`); pass a colour to clear it first. This is
   * how the icon module bakes a vector-drawn icon atlas into a single texture.
   */
  render_to_texture(target: GPUTexture, width: number, height: number, draw: () => void, clear?: GPUColorDict): void {
    if (!this.device || !this.screen_buffer || !this.pipeline_image || !this.pipeline_sdf || !this.pipeline_msdf || !this.bind_group_white) return
    const w = Math.max(1, Math.floor(width))
    const h = Math.max(1, Math.floor(height))

    // Stash the live frame so the bake never clobbers in-progress geometry.
    const saved_commands = this.commands
    const saved_vertex_count = this.vertex_count
    const saved_clip = this.clip_stack
    const saved_texture_id = this.current_texture_id
    const saved_break = this.break_command_merge

    this.commands = []
    this.clip_stack = [make_clip(0, 0, w, h)]
    this.current_texture_id = white_texture_id
    this.break_command_merge = true
    // draw() accumulates into this.commands / this.vertex_data, which
    // encode_render_pass then consumes directly below.
    draw()
    const vertex_byte_length = this.vertex_count * vertex_stride

    if (vertex_byte_length > 0) {
      const byte_length = Math.max(vertex_byte_length, vertex_stride)
      this.ensure_vertex_buffer(byte_length)
      this.device.queue.writeBuffer(this.vertex_buffer, 0, this.vertex_data, 0, vertex_byte_length)
      // Rebase pixel→NDC onto the target's size for the duration of the pass.
      this.device.queue.writeBuffer(this.screen_buffer, 0, new Float32Array([w, h]))
      const encoder = this.device.createCommandEncoder({ label: 'ui.command_encoder.render_to_texture' })
      const pass = encoder.beginRenderPass({
        label: 'ui.render_pass.render_to_texture',
        colorAttachments: [
          {
            view: target.createView({ label: 'ui.render_to_texture_view' }),
            clearValue: clear ?? { r: 0, g: 0, b: 0, a: 0 },
            loadOp: clear ? 'clear' : 'load',
            storeOp: 'store',
          },
        ],
      })
      this.encode_render_pass(pass)
      pass.end()
      this.device.queue.submit([encoder.finish()])
      // Restore the on-screen pixel→NDC mapping.
      this.device.queue.writeBuffer(this.screen_buffer, 0, new Float32Array([this.canvas_width, this.canvas_height]))
    } else if (clear) {
      // Nothing was drawn but a clear was requested — still clear the target.
      const encoder = this.device.createCommandEncoder({ label: 'ui.command_encoder.render_to_texture' })
      const pass = encoder.beginRenderPass({
        label: 'ui.render_pass.render_to_texture',
        colorAttachments: [{ view: target.createView({ label: 'ui.render_to_texture_view' }), clearValue: clear, loadOp: 'clear', storeOp: 'store' }],
      })
      pass.end()
      this.device.queue.submit([encoder.finish()])
    }

    this.commands = saved_commands
    this.vertex_count = saved_vertex_count
    this.clip_stack = saved_clip
    this.current_texture_id = saved_texture_id
    this.break_command_merge = saved_break
    this.enlarge_if_needed()
  }

  /** Grow (power-of-two) the GPU vertex buffer to hold at least `byte_length` bytes. */
  private ensure_vertex_buffer(byte_length: number): void {
    if (!this.device) return
    if (this.vertex_buffer && this.vertex_buffer.size >= byte_length) return
    let next_size = Math.max(this.vertex_buffer?.size ?? 0, 4096)
    while (next_size < byte_length) next_size *= 2
    this.vertex_buffer?.destroy()
    this.vertex_buffer = this.device.createBuffer({
      label: 'ui.vertex_buffer',
      size: next_size,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    memory.track('ui.vertex_buffer', 'geometry', 'gpu', next_size, 'frame vertex buffer')
  }

  private encode_render_pass(pass: GPURenderPassEncoder): void {
    if (!this.vertex_buffer || !this.pipeline_image || !this.pipeline_sdf || !this.pipeline_msdf || !this.bind_group_white) return
    pass.setVertexBuffer(0, this.vertex_buffer)
    for (const cmd of this.commands) {
      if (cmd.clip_w <= 0 || cmd.clip_h <= 0) continue
      pass.setScissorRect(cmd.clip_x, cmd.clip_y, cmd.clip_w, cmd.clip_h)
      const font_bind_group = this.font_bind_groups.get(cmd.texture_id)
      const bind_group = font_bind_group ?? (cmd.texture_id === white_texture_id ? this.bind_group_white : this.extra_bind_groups.get(cmd.texture_id))
      if (!bind_group) continue
      if (font_bind_group && cmd.kind === 'msdf') {
        pass.setPipeline(this.pipeline_msdf)
        pass.setBindGroup(0, bind_group)
      } else if (font_bind_group) {
        pass.setPipeline(this.pipeline_sdf)
        pass.setBindGroup(0, bind_group)
      } else {
        pass.setPipeline(this.pipeline_image)
        pass.setBindGroup(0, bind_group)
      }
      pass.draw(cmd.vertex_count, 1, cmd.vertex_offset)
    }
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
    memory.track(label, 'font', 'gpu', 4, '1×1 rgba8')
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
    memory.track(label, 'font', 'gpu', gpu_texture_bytes(texture), `${image.width}×${image.height} rgba8`)
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

  /**
   * The safe drawable rect, in physical pixels, that all systems should lay out
   * within. The canvas element is inset to the device safe area via
   * `env(safe-area-inset-*)` CSS, so its own box never covers the notch /
   * rounded corners / home indicator — meaning the corrected canvas *is* the
   * safe area. Origin is therefore `(0, 0)` and the size matches the canvas.
   * Exposed as a named rect (with x/y) so layout code can reference the safe
   * surface explicitly rather than the raw viewport.
   */
  safe_rect(): ui_rect {
    return { x: 0, y: 0, w: this.canvas_width, h: this.canvas_height }
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
    return this.clip_stack[this.clip_stack.length - 1] ?? make_clip(0, 0, this.canvas_width, this.canvas_height)
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
    memory.track('ui.primitive_buffer', 'geometry', 'cpu', this.vertex_data.byteLength, 'frame vertex staging')
  }

  private enlarge_if_needed(): void {
    if (!this.need_enlarge) return
    this.need_enlarge = false
    const next_buffer = new ArrayBuffer(this.vertex_data.byteLength * 2)
    new Uint8Array(next_buffer).set(new Uint8Array(this.vertex_data))
    this.vertex_data = next_buffer
    this.view = new DataView(this.vertex_data)
    memory.track('ui.primitive_buffer', 'geometry', 'cpu', this.vertex_data.byteLength, 'frame vertex staging')
  }

  private push_vertex(x: number, y: number, u: number, v: number, color: number): boolean {
    return this.push_vertex_params(x, y, u, v, color, 0, 0, 0, 0)
  }

  private push_vertex_params(x: number, y: number, u: number, v: number, color: number, p0: number, p1: number, p2: number, p3: number): boolean {
    if ((this.vertex_count + 1) * vertex_stride > this.vertex_data.byteLength) {
      this.need_enlarge = true
      return false
    }
    const offset = this.vertex_count * vertex_stride
    this.view.setFloat32(offset + 0, x, true)
    this.view.setFloat32(offset + 4, y, true)
    this.view.setFloat32(offset + 8, u, true)
    this.view.setFloat32(offset + 12, v, true)
    this.view.setUint32(offset + 16, color, true)
    this.view.setFloat32(offset + 20, p0, true)
    this.view.setFloat32(offset + 24, p1, true)
    this.view.setFloat32(offset + 28, p2, true)
    this.view.setFloat32(offset + 32, p3, true)
    this.vertex_count += 1
    return true
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
    if (
      !this.push_vertex(x0, y0, u, v, c0) ||
      !this.push_vertex(x1, y1, u1, v, c1) ||
      !this.push_vertex(x2, y2, u1, v1, c2)
    ) {
      this.vertex_count = base
      return
    }
    this.emit_command(base, 3)
  }

  private push_tri_textured(
    x0: number,
    y0: number,
    u0: number,
    v0: number,
    x1: number,
    y1: number,
    u1: number,
    v1: number,
    x2: number,
    y2: number,
    u2: number,
    v2: number,
    color: number,
  ): void {
    const clip = this.current_clip()
    const min_x = Math.min(x0, x1, x2)
    const min_y = Math.min(y0, y1, y2)
    const max_x = Math.max(x0, x1, x2)
    const max_y = Math.max(y0, y1, y2)
    if (max_x <= clip.x || max_y <= clip.y || min_x >= clip.x + clip.w || min_y >= clip.y + clip.h) return
    const base = this.vertex_count
    if (
      !this.push_vertex(x0, y0, u0, v0, color) ||
      !this.push_vertex(x1, y1, u1, v1, color) ||
      !this.push_vertex(x2, y2, u2, v2, color)
    ) {
      this.vertex_count = base
      return
    }
    this.emit_command(base, 3)
  }

  private push_quad_msdf(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    u0: number,
    v0: number,
    u1: number,
    v1: number,
    color: number,
    range: number,
    weight: number,
    softness: number,
  ): void {
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
    if (
      !this.push_vertex_params(cx0, cy0, cu0, cv0, color, range, weight, softness, 0) ||
      !this.push_vertex_params(cx1, cy0, cu1, cv0, color, range, weight, softness, 0) ||
      !this.push_vertex_params(cx1, cy1, cu1, cv1, color, range, weight, softness, 0) ||
      !this.push_vertex_params(cx0, cy0, cu0, cv0, color, range, weight, softness, 0) ||
      !this.push_vertex_params(cx1, cy1, cu1, cv1, color, range, weight, softness, 0) ||
      !this.push_vertex_params(cx0, cy1, cu0, cv1, color, range, weight, softness, 0)
    ) {
      this.vertex_count = base
      return
    }
    this.emit_command(base, 6, 'msdf')
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
    if (
      !this.push_vertex(cx0, cy0, cu0, cv0, color) ||
      !this.push_vertex(cx1, cy0, cu1, cv0, color) ||
      !this.push_vertex(cx1, cy1, cu1, cv1, color) ||
      !this.push_vertex(cx0, cy0, cu0, cv0, color) ||
      !this.push_vertex(cx1, cy1, cu1, cv1, color) ||
      !this.push_vertex(cx0, cy1, cu0, cv1, color)
    ) {
      this.vertex_count = base
      return
    }
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
    if (
      !this.push_vertex(x0, y0, u, v, color) ||
      !this.push_vertex(x1, y1, u, v, color) ||
      !this.push_vertex(x2, y2, u, v, color)
    ) {
      this.vertex_count = base
      return
    }
    this.emit_command(base, 3)
  }

  private emit_command(vertex_offset: number, vertex_count: number, kind: ui_draw_command_kind = 'image'): void {
    const clip = this.current_clip()
    if (clip.w <= 0 || clip.h <= 0) return
    const cmd: ui_draw_command = {
      vertex_offset,
      vertex_count,
      texture_id: this.current_texture_id,
      kind,
      clip_x: Math.floor(clip.x),
      clip_y: Math.floor(clip.y),
      clip_w: Math.ceil(clip.w),
      clip_h: Math.ceil(clip.h),
    }
    const prev = this.break_command_merge ? undefined : this.commands[this.commands.length - 1]
    this.break_command_merge = false
    if (
      prev &&
      prev.vertex_offset + prev.vertex_count === cmd.vertex_offset &&
      prev.texture_id === cmd.texture_id &&
      prev.kind === cmd.kind &&
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
