// texture_check — upload a texture and inspect how it repeats.
//
// Drop or upload any image and the plugin renders it endlessly tiled in a
// WebGPU viewport (repeat-addressed sampler), so seams, borders and obvious
// periodic patterns stand out immediately. The view pans and zooms through the
// shared core `pan_zoom` module: drag with the mouse or one finger to pan,
// wheel or two-finger pinch to zoom — the same gestures as the graph canvases.
//
// A full mip chain is generated for every upload, and in the default `auto`
// mode the plugin enables mip sampling exactly when the texture is being
// minified on screen (zoom < 100%) and disables it otherwise. Force the mode
// to `on` / `off` to compare — zoomed out without mips, a detailed texture
// shimmers; with them it settles.
//
// Split like the other plugins: a pure immediate-mode panel (`texture_check`)
// drawing from host-owned state each frame, plus a DOM bridge
// (`texture_check_dom_target`) wiring drag-and-drop and the hidden file picker
// onto the host canvas.

import { pack_color, hex_to_normalized_rgba } from '../ui_theme'
import type { theme_definition } from '../ui_types'
import { FONT_MONO, type ui_renderer } from '../ui_renderer'
import { clamp } from '../ui_math'
import { create_pan_zoom_state, pan_zoom_apply, pan_zoom_drag, type pan_zoom_state } from '../ui_pan_zoom'
import type { ui_input_snapshot, ui_widgets } from '../ui_widgets'

export type texture_check_mip_mode = 'auto' | 'on' | 'off'

const MIN_ZOOM = 1 / 32 // px per texel
const MAX_ZOOM = 32

export interface texture_check_state {
  /** The decoded upload; null until the first image lands. */
  bitmap: ImageBitmap | null
  name: string
  width: number
  height: number
  /** Bumped per upload so the frame function re-syncs the GPU texture. */
  source_version: number
  mip_mode: texture_check_mip_mode
  /** Draw 1px guides on the tile boundaries. */
  show_grid: boolean
  /** Pan in physical px, zoom in px-per-texel. */
  cam: pan_zoom_state
  /** Number of in-flight image decodes (drives the loading text). */
  loading: number
  /** True while a drag with an image hovers the host element. */
  drop_hover: boolean
  // GPU plumbing (owned here, fed by the IM function each frame).
  view: texture_check_view
  view_dirty: boolean
  texture: GPUTexture | null
  texture_id: number | null
  synced_version: number
  reported_version: number
  /** Re-fit / re-center the camera on the next frame (set on upload). */
  fit_pending: boolean
  last_mip_active: boolean
  // wired by texture_check_dom_target
  open_file_picker: (() => void) | null
  /** Preferred picker trigger: defers the `.click()` into the next trusted
   * pointerup so mobile browsers show the dialog (see asset_audit). */
  request_picker: (() => void) | null
  on_change: (() => void) | null
}

export function create_texture_check_state(): texture_check_state {
  return {
    bitmap: null,
    name: '',
    width: 0,
    height: 0,
    source_version: 0,
    mip_mode: 'auto',
    show_grid: false,
    cam: create_pan_zoom_state(),
    loading: 0,
    drop_hover: false,
    view: new texture_check_view(),
    view_dirty: true,
    texture: null,
    texture_id: null,
    synced_version: -1,
    reported_version: 0,
    fit_pending: false,
    last_mip_active: false,
    open_file_picker: null,
    request_picker: null,
    on_change: null,
  }
}

function notify(state: texture_check_state): void {
  state.on_change?.()
}

/** Load a decoded bitmap into the state (also used by the DOM bridge). */
export function texture_check_set_image(state: texture_check_state, bitmap: ImageBitmap, name: string): void {
  state.bitmap?.close()
  state.bitmap = bitmap
  state.name = name
  state.width = bitmap.width
  state.height = bitmap.height
  state.source_version += 1
  state.fit_pending = true
  state.view_dirty = true
  notify(state)
}

// --- DOM bridge -------------------------------------------------------------

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.avif']

function is_image_file(file: File): boolean {
  if (file.type.startsWith('image/')) return true
  const dot = file.name.lastIndexOf('.')
  return dot >= 0 && IMAGE_EXTENSIONS.includes(file.name.slice(dot).toLowerCase())
}

export interface texture_check_dom_options {
  on_change?: () => void
  on_error?: (message: string) => void
}

/**
 * Wire drag-and-drop and a hidden file picker for image uploads onto `target`
 * (usually the host canvas). Returns a cleanup function.
 */
export function texture_check_dom_target(target: HTMLElement, state: texture_check_state, options?: texture_check_dom_options): () => void {
  state.on_change = options?.on_change ?? null

  const ingest = (file: File | null): void => {
    if (!file || !is_image_file(file)) return
    state.loading += 1
    notify(state)
    createImageBitmap(file)
      .then((bitmap) => texture_check_set_image(state, bitmap, file.name))
      .catch(() => options?.on_error?.(`texture check: could not decode ${file.name}`))
      .finally(() => {
        state.loading -= 1
        notify(state)
      })
  }

  // `display:none` inputs ignore programmatic .click() on iOS Safari — park
  // it rendered-but-invisible offscreen instead.
  const file_input = document.createElement('input')
  file_input.type = 'file'
  file_input.accept = 'image/*'
  file_input.style.position = 'fixed'
  file_input.style.left = '0'
  file_input.style.top = '0'
  file_input.style.width = '1px'
  file_input.style.height = '1px'
  file_input.style.opacity = '0'
  file_input.style.pointerEvents = 'none'
  file_input.tabIndex = -1
  file_input.setAttribute('aria-hidden', 'true')
  file_input.addEventListener('change', () => {
    ingest(file_input.files?.[0] ?? null)
    file_input.value = ''
  })
  document.body.appendChild(file_input)
  state.open_file_picker = () => file_input.click()

  // Gesture relay: the IM Upload button fires on the press edge from inside
  // requestAnimationFrame, where mobile browsers refuse to open a file dialog.
  // Queue the request and `.click()` inside the trusted pointerup instead.
  let pending_picker_at = 0
  let pointer_held = false
  const PICKER_REQUEST_TTL_MS = 3000
  const fulfill_picker = (): void => {
    const at = pending_picker_at
    pending_picker_at = 0
    if (at && performance.now() - at <= PICKER_REQUEST_TTL_MS) file_input.click()
  }
  state.request_picker = () => {
    pending_picker_at = performance.now()
    if (!pointer_held) fulfill_picker()
  }
  const pointer_down = (): void => {
    pointer_held = true
  }
  const pointer_up = (): void => {
    pointer_held = false
    fulfill_picker()
  }
  const pointer_cancel = (): void => {
    pointer_held = false
    pending_picker_at = 0 // a cancelled gesture (e.g. scroll) shouldn't pop the dialog
  }
  target.addEventListener('pointerdown', pointer_down)
  window.addEventListener('pointerup', pointer_up)
  window.addEventListener('pointercancel', pointer_cancel)

  const set_hover = (hover: boolean): void => {
    if (state.drop_hover === hover) return
    state.drop_hover = hover
    notify(state)
  }
  const drag_over = (e: DragEvent): void => {
    const dt = e.dataTransfer
    if (!dt?.types.includes('Files')) return
    // Only claim drags that carry an image — leave .glb/.json drags to the
    // asset_audit / dashboard targets sharing the same canvas.
    const items = [...dt.items]
    if (!items.some((item) => item.kind === 'file' && item.type.startsWith('image/'))) return
    e.preventDefault()
    e.stopImmediatePropagation()
    dt.dropEffect = 'copy'
    set_hover(true)
  }
  const drag_leave = (): void => set_hover(false)
  const drop = (e: DragEvent): void => {
    const dt = e.dataTransfer
    if (!dt) return
    set_hover(false)
    const file = [...dt.files].find(is_image_file)
    if (!file) return // not ours — let the other drop targets take it
    e.preventDefault()
    e.stopImmediatePropagation()
    ingest(file)
  }
  target.addEventListener('dragover', drag_over)
  target.addEventListener('dragleave', drag_leave)
  target.addEventListener('drop', drop)

  return () => {
    target.removeEventListener('dragover', drag_over)
    target.removeEventListener('dragleave', drag_leave)
    target.removeEventListener('drop', drop)
    target.removeEventListener('pointerdown', pointer_down)
    window.removeEventListener('pointerup', pointer_up)
    window.removeEventListener('pointercancel', pointer_cancel)
    file_input.remove()
    state.open_file_picker = null
    state.request_picker = null
    state.on_change = null
  }
}

// --- offscreen GPU view -----------------------------------------------------

const tile_shader = /* wgsl */ `
struct params {
  view_size : vec2f,
  origin : vec2f,
  texel_per_px : f32,
  grid : f32,
  tex_size : vec2f,
  clear : vec4f,
}

@group(0) @binding(0) var<uniform> u : params;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var tex : texture_2d<f32>;

@vertex fn vs_main(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[vi], 0.0, 1.0);
}

@fragment fn fs_main(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let texel = (pos.xy - u.origin) * u.texel_per_px;
  let uv = texel / u.tex_size;
  let sampled = textureSample(tex, samp, uv);
  // Composite over the panel color so transparent textures stay readable.
  var color = vec4f(mix(u.clear.rgb, sampled.rgb, sampled.a), 1.0);
  if (u.grid > 0.5) {
    // Distance (px) to the nearest tile boundary; paint a 1px guide line.
    let tile_px = u.tex_size / u.texel_per_px;
    let t = fract(uv) * tile_px;
    let d = min(min(t.x, tile_px.x - t.x), min(t.y, tile_px.y - t.y));
    color = mix(vec4f(1.0, 0.45, 0.2, 1.0), color, clamp(d, 0.0, 1.0));
  }
  return color;
}
`

const mip_blit_shader = /* wgsl */ `
struct v_out {
  @builtin(position) pos : vec4f,
  @location(0) uv : vec2f,
}

@group(0) @binding(0) var samp : sampler;
@group(0) @binding(1) var tex : texture_2d<f32>;

@vertex fn vs_main(@builtin(vertex_index) vi : u32) -> v_out {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var o : v_out;
  o.pos = vec4f(p[vi], 0.0, 1.0);
  o.uv = vec2f(p[vi].x * 0.5 + 0.5, 0.5 - p[vi].y * 0.5);
  return o;
}

@fragment fn fs_main(in : v_out) -> @location(0) vec4f {
  return textureSampleLevel(tex, samp, in.uv, 0.0);
}
`

export interface texture_check_render_params {
  /** Target-px position of texel (0, 0). */
  origin_x: number
  origin_y: number
  /** Source texels per target px (1 / zoom). */
  texel_per_px: number
  /** Sample through the mip chain (trilinear) instead of level 0 only. */
  mip: boolean
  /** Draw tile-boundary guide lines. */
  grid: boolean
  /** Backdrop composited behind transparent texels, normalized RGBA. */
  clear: { r: number; g: number; b: number; a: number }
}

/** Owns the tiled-preview GPU pass: the mip-chained source texture, the
 * repeat samplers and the offscreen color target the UI composites. */
export class texture_check_view {
  private device: GPUDevice | null = null
  private pipeline: GPURenderPipeline | null = null
  private bind_layout: GPUBindGroupLayout | null = null
  private blit_pipeline: GPURenderPipeline | null = null
  private blit_layout: GPUBindGroupLayout | null = null
  private blit_sampler: GPUSampler | null = null
  private uniform: GPUBuffer | null = null
  private sampler_mip: GPUSampler | null = null
  private sampler_flat: GPUSampler | null = null
  private source: GPUTexture | null = null
  private bind_mip: GPUBindGroup | null = null
  private bind_flat: GPUBindGroup | null = null
  private target: GPUTexture | null = null
  /** Mip levels of the current source (1 = no chain). */
  mip_levels = 1

  init(device: GPUDevice): void {
    if (this.device === device && this.pipeline) return
    this.device = device
    const module = device.createShaderModule({ label: 'texture_check.tile_shader', code: tile_shader })
    this.bind_layout = device.createBindGroupLayout({
      label: 'texture_check.bind_layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    this.pipeline = device.createRenderPipeline({
      label: 'texture_check.pipeline',
      layout: device.createPipelineLayout({ label: 'texture_check.pipeline_layout', bindGroupLayouts: [this.bind_layout] }),
      vertex: { module, entryPoint: 'vs_main' },
      fragment: { module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    this.uniform = device.createBuffer({
      label: 'texture_check.uniform',
      size: 48,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    // Repeat addressing is the whole point: UVs run far outside [0, 1] so the
    // texture tiles forever. `flat` clamps sampling to mip level 0.
    this.sampler_mip = device.createSampler({
      label: 'texture_check.sampler_mip',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    })
    this.sampler_flat = device.createSampler({
      label: 'texture_check.sampler_flat',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      lodMaxClamp: 0,
    })

    const blit_module = device.createShaderModule({ label: 'texture_check.mip_blit_shader', code: mip_blit_shader })
    this.blit_layout = device.createBindGroupLayout({
      label: 'texture_check.blit_layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    this.blit_pipeline = device.createRenderPipeline({
      label: 'texture_check.blit_pipeline',
      layout: device.createPipelineLayout({ label: 'texture_check.blit_pipeline_layout', bindGroupLayouts: [this.blit_layout] }),
      vertex: { module: blit_module, entryPoint: 'vs_main' },
      fragment: { module: blit_module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    this.blit_sampler = device.createSampler({ label: 'texture_check.blit_sampler', magFilter: 'linear', minFilter: 'linear' })
  }

  /** Upload the bitmap into a texture with a full mip chain and generate the
   * chain by blitting each level from the one above. */
  set_source(bitmap: ImageBitmap): void {
    const device = this.device
    if (!device || !this.bind_layout || !this.blit_layout || !this.blit_pipeline || !this.uniform || !this.sampler_mip || !this.sampler_flat || !this.blit_sampler) return
    this.source?.destroy()
    this.mip_levels = 1 + Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height)))
    this.source = device.createTexture({
      label: 'texture_check.source',
      size: [bitmap.width, bitmap.height, 1],
      format: 'rgba8unorm',
      mipLevelCount: this.mip_levels,
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
    })
    device.queue.copyExternalImageToTexture({ source: bitmap }, { texture: this.source }, [bitmap.width, bitmap.height])

    const encoder = device.createCommandEncoder({ label: 'texture_check.mipgen' })
    for (let level = 1; level < this.mip_levels; level += 1) {
      const bind = device.createBindGroup({
        label: `texture_check.mipgen.bind.${level}`,
        layout: this.blit_layout,
        entries: [
          { binding: 0, resource: this.blit_sampler },
          { binding: 1, resource: this.source.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
        ],
      })
      const pass = encoder.beginRenderPass({
        label: `texture_check.mipgen.pass.${level}`,
        colorAttachments: [{
          view: this.source.createView({ baseMipLevel: level, mipLevelCount: 1 }),
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 0 },
          storeOp: 'store',
        }],
      })
      pass.setPipeline(this.blit_pipeline)
      pass.setBindGroup(0, bind)
      pass.draw(3)
      pass.end()
    }
    device.queue.submit([encoder.finish()])

    const view = this.source.createView()
    const make_bind = (label: string, sampler: GPUSampler) => device.createBindGroup({
      label,
      layout: this.bind_layout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniform! } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: view },
      ],
    })
    this.bind_mip = make_bind('texture_check.bind.mip', this.sampler_mip)
    this.bind_flat = make_bind('texture_check.bind.flat', this.sampler_flat)
  }

  /** Render the tiled view into the offscreen target and return it. */
  render(width: number, height: number, p: texture_check_render_params): GPUTexture | null {
    const device = this.device
    if (!device || !this.pipeline || !this.uniform || !this.source) return null
    const bind = p.mip ? this.bind_mip : this.bind_flat
    if (!bind) return null
    if (!this.target || this.target.width !== width || this.target.height !== height) {
      this.target?.destroy()
      this.target = device.createTexture({
        label: 'texture_check.color_target',
        size: [width, height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
    }
    device.queue.writeBuffer(this.uniform, 0, new Float32Array([
      width, height,
      p.origin_x, p.origin_y,
      p.texel_per_px, p.grid ? 1 : 0,
      this.source.width, this.source.height,
      p.clear.r, p.clear.g, p.clear.b, p.clear.a,
    ]))
    const encoder = device.createCommandEncoder({ label: 'texture_check.encoder' })
    const pass = encoder.beginRenderPass({
      label: 'texture_check.pass',
      colorAttachments: [{
        view: this.target.createView(),
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp: 'store',
      }],
    })
    pass.setPipeline(this.pipeline)
    pass.setBindGroup(0, bind)
    pass.draw(3)
    pass.end()
    device.queue.submit([encoder.finish()])
    return this.target
  }
}

// --- the immediate-mode panel -------------------------------------------------

export interface texture_check_options {
  /** Device-pixel scale; defaults to `window.devicePixelRatio`. */
  scale?: number
}

export interface texture_check_event {
  /** Set on the first frame after an upload finished decoding. */
  loaded?: { name: string; width: number; height: number }
  /** The effective mip state flipped this frame (auto crossing 100% zoom, or a mode click). */
  mip_changed?: boolean
}

function point_in(x: number, y: number, rx: number, ry: number, rw: number, rh: number): boolean {
  return x >= rx && x < rx + rw && y >= ry && y < ry + rh
}

/** Open the picker via the bridge's gesture relay (mobile-safe), or directly. */
function trigger_picker(state: texture_check_state): void {
  if (state.request_picker) state.request_picker()
  else state.open_file_picker?.()
}

export function texture_check(
  ui: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  state: texture_check_state,
  options?: texture_check_options,
): texture_check_event {
  const scale = options?.scale ?? (window.devicePixelRatio || 1)
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const event: texture_check_event = {}
  const m = 10 * scale

  if (state.bitmap && state.reported_version !== state.source_version) {
    state.reported_version = state.source_version
    event.loaded = { name: state.name, width: state.width, height: state.height }
  }

  // --- top bar: upload, mip mode, tile guides ------------------------------
  const bar_y = y + m
  const bar_h = 30 * scale
  const btn_h = 24 * scale
  const btn_y = bar_y + (bar_h - btn_h) / 2
  let cx = x + m
  if (widgets.button('tc_upload', cx, btn_y, 86 * scale, btn_h, 'Upload', { active: true })) trigger_picker(state)
  cx += 86 * scale + 8 * scale

  const seg_w = 46 * scale
  const modes: texture_check_mip_mode[] = ['auto', 'on', 'off']
  const labels = ['Auto', 'On', 'Off']
  ui.draw_text(cx, ui.text_v_center_y(bar_y, bar_h, 10 * scale), 'mipmap', 10 * scale, slot('text_dim'))
  cx += ui.text_width('mipmap', 10 * scale) + 6 * scale
  for (let i = 0; i < modes.length; i += 1) {
    if (widgets.button(`tc_mip_${modes[i]}`, cx, btn_y, seg_w, btn_h, labels[i]!, { active: state.mip_mode === modes[i] })) {
      state.mip_mode = modes[i]!
      state.view_dirty = true
    }
    cx += seg_w + 4 * scale
  }
  cx += 8 * scale
  const next_grid = widgets.toggle('tc_grid', cx, bar_y + (bar_h - 18 * scale) / 2, state.show_grid, 'tile guides')
  if (next_grid !== state.show_grid) {
    state.show_grid = next_grid
    state.view_dirty = true
  }

  // --- viewport -------------------------------------------------------------
  const vp_x = x + m
  const vp_y = bar_y + bar_h + m
  const vp_w = Math.max(40 * scale, w - m * 2)
  const vp_h = Math.max(40 * scale, y + h - m - vp_y)
  const radius = 6 * scale
  ui.fill_round_rect(vp_x, vp_y, vp_w, vp_h, radius, slot('panel_alt'))

  if (state.bitmap) {
    const cam = state.cam
    if (state.fit_pending) {
      // Fit ~3×3 tiles centered in the viewport so repetition is visible at once.
      state.fit_pending = false
      cam.zoom = clamp(Math.min(vp_w / (3 * state.width), vp_h / (3 * state.height)), MIN_ZOOM, MAX_ZOOM)
      cam.pan_x = vp_w / 2 - 1.5 * state.width * cam.zoom
      cam.pan_y = vp_h / 2 - 1.5 * state.height * cam.zoom
    }

    // Pan + zoom: wheel / pinch through the shared core handler, plus a
    // left-button or single-finger drag pan. Pan is kept in physical px
    // relative to the viewport origin, zoom is px-per-texel.
    const inside = point_in(input.mouse_x, input.mouse_y, vp_x, vp_y, vp_w, vp_h)
    let changed = pan_zoom_apply(cam, input, inside, {
      base_x: vp_x,
      base_y: vp_y,
      pan_scale: 1,
      px_per_unit: (z) => z,
      min_zoom: MIN_ZOOM,
      max_zoom: MAX_ZOOM,
    })
    changed = pan_zoom_drag(cam, input, inside && input.mouse_pressed, input.mouse_down, 1) || changed
    if (changed) state.view_dirty = true
    if (cam._pz_drag) ui.set_cursor('grabbing')

    // Auto mipmap: sample through the chain exactly while minified on screen.
    const minified = cam.zoom < 1
    const mip_active = state.mip_mode === 'on' || (state.mip_mode === 'auto' && minified)
    if (mip_active !== state.last_mip_active) {
      state.last_mip_active = mip_active
      state.view_dirty = true
      event.mip_changed = true
    }

    // --- offscreen tiled pass (only when something changed) ----------------
    const { device } = ui.gpu()
    if (device) {
      state.view.init(device)
      if (state.synced_version !== state.source_version) {
        state.view.set_source(state.bitmap)
        state.synced_version = state.source_version
        state.view_dirty = true
      }
      const px_w = Math.max(1, Math.floor(vp_w))
      const px_h = Math.max(1, Math.floor(vp_h))
      if (state.texture && (state.texture.width !== px_w || state.texture.height !== px_h)) state.view_dirty = true
      if (state.view_dirty) {
        const texture = state.view.render(px_w, px_h, {
          origin_x: cam.pan_x,
          origin_y: cam.pan_y,
          texel_per_px: 1 / cam.zoom,
          mip: mip_active,
          grid: state.show_grid,
          clear: hex_to_normalized_rgba(theme.palette.panel_alt),
        })
        if (texture) {
          if (state.texture_id === null) state.texture_id = ui.register_external_texture(texture)
          else if (texture !== state.texture) ui.update_external_texture(state.texture_id, texture)
          state.texture = texture
        }
        state.view_dirty = false
      }
      if (state.texture_id !== null) {
        ui.push_clip(vp_x, vp_y, vp_w, vp_h)
        ui.draw_texture(state.texture_id, vp_x, vp_y, vp_w, vp_h)
        ui.pop_clip()
      }
    } else {
      ui.draw_text(vp_x + 12 * scale, vp_y + 12 * scale, 'WebGPU device not ready…', 11 * scale, slot('text_dim'))
    }

    // Status line: size, POT-ness, zoom and the live mip decision.
    const pot = (state.width & (state.width - 1)) === 0 && (state.height & (state.height - 1)) === 0
    const mip_label = state.mip_mode === 'auto' ? `${mip_active ? 'on' : 'off'} (auto${minified ? ' · minified' : ''})` : state.mip_mode
    const status = `${state.name} · ${state.width}×${state.height}${pot ? '' : ' · non-POT'} · zoom ${(cam.zoom * 100).toFixed(0)}% · mipmap ${mip_label}`
    ui.draw_text(vp_x + 10 * scale, vp_y + vp_h - 32 * scale, status, 9 * scale, slot('text'), FONT_MONO)
    ui.draw_text(vp_x + 10 * scale, vp_y + vp_h - 18 * scale, 'drag pan · wheel zoom · pinch / two-finger pan on touch', 9 * scale, slot('text_dim'), FONT_MONO)
  } else {
    // Empty state: drop hint + inline upload button.
    const ecx = vp_x + vp_w / 2
    const ecy = vp_y + vp_h / 2
    const title = state.loading > 0 ? 'Decoding image…' : 'Drop an image here to check how it tiles'
    const tf = 13 * scale
    ui.draw_text(ecx - ui.text_width(title, tf) / 2, ecy - 34 * scale, title, tf, slot('text'))
    if (state.loading === 0) {
      const sub = 'the texture repeats endlessly — pan and pinch to hunt for seams'
      const sf = 10 * scale
      ui.draw_text(ecx - ui.text_width(sub, sf) / 2, ecy - 12 * scale, sub, sf, slot('text_dim'))
      const bw = 110 * scale
      if (widgets.button('tc_empty_upload', ecx - bw / 2, ecy + 12 * scale, bw, 28 * scale, 'Upload Image', { active: true })) trigger_picker(state)
    }
  }

  if (state.drop_hover) {
    ui.stroke_round_rect(vp_x + 2 * scale, vp_y + 2 * scale, vp_w - 4 * scale, vp_h - 4 * scale, radius, 2 * scale, slot('accent'))
  }

  return event
}
