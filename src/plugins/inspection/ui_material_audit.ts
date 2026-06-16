// material_audit — upload a material's maps and inspect how they hold up.
//
// Drop or upload a base color map and/or a tangent-space normal map, then
// validate the material on three preview shapes:
//
//   - grid:   the maps tiled endlessly on a flat plane (repeat-addressed
//             sampler) — seams, borders and periodic patterns stand out, and a
//             normal map lights the plane so bump seams show too
//   - sphere: a UV sphere — pole pinching, UV stretch and normal-map shading
//   - cube:   a rounded cube — flat faces with beveled edges, the classic
//             trim/material check
//
// The grid pans and zooms through the shared core `pan_zoom` module (drag with
// the mouse or one finger, wheel or two-finger pinch); the 3D shapes orbit on
// drag and dolly on wheel / pinch. A full mip chain is generated for every
// upload, and in the default `auto` mode mip sampling is enabled while the
// texture is minified (grid zoom < 100%, and always on the 3D shapes, which
// perspective-minify) — force it `on` / `off` to compare the shimmer.
//
// Split like the other plugins: a pure immediate-mode panel (`material_audit`)
// drawing from host-owned state each frame, plus a DOM bridge
// (`material_audit_dom_target`) wiring drag-and-drop and the hidden file
// picker onto the host canvas. Dropped files route by filename: names that
// look like a normal map (`*_normal*`, `*_nrm*`, `*_n.*`, …) land in the
// normal slot, everything else in base color.

import { pack_color, hex_to_normalized_rgba } from '../../ui_theme'
import type { theme_definition } from '../../ui_types'
import { FONT_MONO, type ui_renderer } from '../../ui_renderer'
import { clamp } from '../../ui_math'
import { create_pan_zoom_state, pan_zoom_apply, pan_zoom_drag, type pan_zoom_state } from '../../ui_pan_zoom'
import type { ui_input_snapshot, ui_widgets } from '../../ui_widgets'

export type material_audit_mip_mode = 'auto' | 'on' | 'off'
export type material_audit_map_slot = 'base' | 'normal'
export type material_audit_shape = 'grid' | 'sphere' | 'cube'

const MIN_ZOOM = 1 / 32 // grid: px per texel
const MAX_ZOOM = 32
const MIN_DISTANCE = 1.6
const MAX_DISTANCE = 12
const UV_REPEATS = [1, 2, 4, 8]

/** One uploaded map: the decoded bitmap plus identity for the status line. */
export interface material_audit_map {
  bitmap: ImageBitmap
  name: string
  width: number
  height: number
  /** Bumped per upload so the frame function re-syncs the GPU texture. */
  version: number
}

export interface material_audit_state {
  maps: { base: material_audit_map | null; normal: material_audit_map | null }
  shape: material_audit_shape
  mip_mode: material_audit_mip_mode
  /** Draw 1px guides on the tile boundaries (grid shape only). */
  show_guides: boolean
  /** UV tiling on the 3D shapes. */
  uv_repeat: number
  /** Grid camera: pan in physical px, zoom in px-per-texel. */
  cam: pan_zoom_state
  /** 3D camera: orbit angles + dolly distance around the origin. */
  orbit: { yaw: number; pitch: number; distance: number }
  orbiting: boolean
  last_mx: number
  last_my: number
  /** Bumped on any map upload (latest map.version). */
  source_version: number
  /** Number of in-flight image decodes (drives the loading text). */
  loading: number
  /** True while a drag with an image hovers the host element. */
  drop_hover: boolean
  // GPU plumbing (owned here, fed by the IM function each frame).
  view: material_audit_view
  view_dirty: boolean
  texture: GPUTexture | null
  texture_id: number | null
  synced: { base: number; normal: number }
  reported_version: number
  last_upload: { slot: material_audit_map_slot; name: string; width: number; height: number } | null
  /** Re-fit / re-center the grid camera on the next frame (set on upload). */
  fit_pending: boolean
  last_mip_active: boolean
  // wired by material_audit_dom_target
  open_file_picker: ((slot: material_audit_map_slot) => void) | null
  /** Preferred picker trigger: defers the `.click()` into the next trusted
   * pointerup so mobile browsers show the dialog (see asset_audit). */
  request_picker: ((slot: material_audit_map_slot) => void) | null
  on_change: (() => void) | null
}

export function create_material_audit_state(): material_audit_state {
  return {
    maps: { base: null, normal: null },
    shape: 'grid',
    mip_mode: 'auto',
    show_guides: false,
    uv_repeat: 2,
    cam: create_pan_zoom_state(),
    orbit: { yaw: 0.6, pitch: 0.35, distance: 3.4 },
    orbiting: false,
    last_mx: 0,
    last_my: 0,
    source_version: 0,
    loading: 0,
    drop_hover: false,
    view: new material_audit_view(),
    view_dirty: true,
    texture: null,
    texture_id: null,
    synced: { base: -1, normal: -1 },
    reported_version: 0,
    last_upload: null,
    fit_pending: false,
    last_mip_active: false,
    open_file_picker: null,
    request_picker: null,
    on_change: null,
  }
}

function notify(state: material_audit_state): void {
  state.on_change?.()
}

/** Load a decoded bitmap into a map slot (also used by the DOM bridge). */
export function material_audit_set_map(state: material_audit_state, slot: material_audit_map_slot, bitmap: ImageBitmap, name: string): void {
  state.maps[slot]?.bitmap.close()
  state.source_version += 1
  state.maps[slot] = { bitmap, name, width: bitmap.width, height: bitmap.height, version: state.source_version }
  state.last_upload = { slot, name, width: bitmap.width, height: bitmap.height }
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

/** Route a dropped file by filename: `brick_normal.png`, `rock_nrm.jpg`,
 * `wall_n.png`, … land in the normal slot, everything else in base color. */
function classify_map(name: string): material_audit_map_slot {
  const dot = name.lastIndexOf('.')
  const stem = (dot >= 0 ? name.slice(0, dot) : name).toLowerCase()
  return /normal|_nrm|_nor$|[_-]n$/.test(stem) ? 'normal' : 'base'
}

export interface material_audit_dom_options {
  on_change?: () => void
  on_error?: (message: string) => void
}

/**
 * Wire drag-and-drop and a hidden file picker for map uploads onto `target`
 * (usually the host canvas). Returns a cleanup function.
 */
export function material_audit_dom_target(target: HTMLElement, state: material_audit_state, options?: material_audit_dom_options): () => void {
  state.on_change = options?.on_change ?? null

  const ingest = (file: File, slot: material_audit_map_slot): void => {
    state.loading += 1
    notify(state)
    createImageBitmap(file)
      .then((bitmap) => material_audit_set_map(state, slot, bitmap, file.name))
      .catch(() => options?.on_error?.(`material audit: could not decode ${file.name}`))
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
  let picker_slot: material_audit_map_slot = 'base'
  file_input.addEventListener('change', () => {
    const file = file_input.files?.[0]
    if (file && is_image_file(file)) ingest(file, picker_slot)
    file_input.value = ''
  })
  document.body.appendChild(file_input)
  state.open_file_picker = (map_slot) => {
    picker_slot = map_slot
    file_input.click()
  }

  // Gesture relay: the IM Upload buttons fire on the press edge from inside
  // requestAnimationFrame, where mobile browsers refuse to open a file dialog.
  // Queue the request and `.click()` inside the trusted pointerup instead.
  let pending_picker: { slot: material_audit_map_slot; at: number } | null = null
  let pointer_held = false
  const PICKER_REQUEST_TTL_MS = 3000
  const fulfill_picker = (): void => {
    const request = pending_picker
    pending_picker = null
    if (!request || performance.now() - request.at > PICKER_REQUEST_TTL_MS) return
    picker_slot = request.slot
    file_input.click()
  }
  state.request_picker = (map_slot) => {
    pending_picker = { slot: map_slot, at: performance.now() }
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
    pending_picker = null // a cancelled gesture (e.g. scroll) shouldn't pop the dialog
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
    const files = [...dt.files].filter(is_image_file)
    if (files.length === 0) return // not ours — let the other drop targets take it
    e.preventDefault()
    e.stopImmediatePropagation()
    // Drop a base + normal pair at once and each lands in its slot.
    for (const file of files) ingest(file, classify_map(file.name))
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

const grid_shader = /* wgsl */ `
struct params {
  view_size : vec2f,
  origin : vec2f,
  texel_per_px : f32,
  guides : f32,
  tex_size : vec2f,
  clear : vec4f,
  // x = light through the normal map (1 when a normal map is loaded).
  flags : vec4f,
}

@group(0) @binding(0) var<uniform> u : params;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var base_tex : texture_2d<f32>;
@group(0) @binding(3) var normal_tex : texture_2d<f32>;

@vertex fn vs_main(@builtin(vertex_index) vi : u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[vi], 0.0, 1.0);
}

@fragment fn fs_main(@builtin(position) pos : vec4f) -> @location(0) vec4f {
  let texel = (pos.xy - u.origin) * u.texel_per_px;
  let uv = texel / u.tex_size;
  let base = textureSample(base_tex, samp, uv);
  let n_ts = textureSample(normal_tex, samp, uv).xyz * 2.0 - vec3f(1.0);
  // Composite over the panel color so transparent textures stay readable.
  var rgb = mix(u.clear.rgb, base.rgb, base.a);
  if (u.flags.x > 0.5) {
    // Light the flat plane through the normal map (tangent frame = texture
    // axes), so bump seams show on the tiling grid too.
    let n = normalize(vec3f(n_ts.x, -n_ts.y, max(n_ts.z, 0.05)));
    let l = normalize(vec3f(0.45, 0.55, 0.7));
    let diffuse = max(dot(n, l), 0.0);
    let spec = pow(max(dot(n, normalize(l + vec3f(0.0, 0.0, 1.0))), 0.0), 24.0) * 0.25;
    rgb = rgb * (0.25 + diffuse * 0.85) + vec3f(spec);
  }
  var color = vec4f(rgb, 1.0);
  if (u.guides > 0.5) {
    // Distance (px) to the nearest tile boundary; paint a 1px guide line.
    let tile_px = u.tex_size / u.texel_per_px;
    let t = fract(uv) * tile_px;
    let d = min(min(t.x, tile_px.x - t.x), min(t.y, tile_px.y - t.y));
    color = mix(vec4f(1.0, 0.45, 0.2, 1.0), color, clamp(d, 0.0, 1.0));
  }
  return color;
}
`

const mesh_shader = /* wgsl */ `
struct params {
  mvp : mat4x4f,
  eye : vec4f,
  light : vec4f,
  // x = uv repeat, y = light through the normal map.
  misc : vec4f,
}

@group(0) @binding(0) var<uniform> u : params;
@group(0) @binding(1) var samp : sampler;
@group(0) @binding(2) var base_tex : texture_2d<f32>;
@group(0) @binding(3) var normal_tex : texture_2d<f32>;

struct v_out {
  @builtin(position) pos : vec4f,
  @location(0) world_pos : vec3f,
  @location(1) normal : vec3f,
  @location(2) tangent : vec3f,
  @location(3) uv : vec2f,
}

@vertex fn vs_main(
  @location(0) pos : vec3f,
  @location(1) normal : vec3f,
  @location(2) tangent : vec3f,
  @location(3) uv : vec2f,
) -> v_out {
  var o : v_out;
  o.pos = u.mvp * vec4f(pos, 1.0);
  o.world_pos = pos;
  o.normal = normal;
  o.tangent = tangent;
  o.uv = uv;
  return o;
}

@fragment fn fs_main(in : v_out) -> @location(0) vec4f {
  let uv = in.uv * u.misc.x;
  let base = textureSample(base_tex, samp, uv);
  let n_ts = textureSample(normal_tex, samp, uv).xyz * 2.0 - vec3f(1.0);
  var n = normalize(in.normal);
  if (u.misc.y > 0.5) {
    let t = normalize(in.tangent - n * dot(in.tangent, n));
    let b = cross(n, t);
    n = normalize(t * n_ts.x - b * n_ts.y + n * max(n_ts.z, 0.05));
  }
  let l = normalize(u.light.xyz);
  let v = normalize(u.eye.xyz - in.world_pos);
  let diffuse = max(dot(n, l), 0.0);
  let fill = max(dot(n, vec3f(-l.x, -0.2, -l.z)), 0.0) * 0.18;
  let spec = pow(max(dot(n, normalize(l + v)), 0.0), 32.0) * 0.3;
  let lit = base.rgb * (0.22 + diffuse * 0.85 + fill) + vec3f(spec);
  return vec4f(lit, 1.0);
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

// --- preview meshes (pos 3 + normal 3 + tangent 3 + uv 2, stride 44) ---------

function build_uv_sphere(segments = 64, rings = 48): { vertices: Float32Array; indices: Uint32Array } {
  const vertices = new Float32Array((rings + 1) * (segments + 1) * 11)
  let vi = 0
  for (let r = 0; r <= rings; r += 1) {
    const theta = (r / rings) * Math.PI
    const st = Math.sin(theta)
    const ct = Math.cos(theta)
    for (let s = 0; s <= segments; s += 1) {
      const phi = (s / segments) * Math.PI * 2
      const sp = Math.sin(phi)
      const cp = Math.cos(phi)
      const nx = st * cp
      const ny = ct
      const nz = st * sp
      vertices[vi++] = nx; vertices[vi++] = ny; vertices[vi++] = nz // position (radius 1)
      vertices[vi++] = nx; vertices[vi++] = ny; vertices[vi++] = nz // normal
      vertices[vi++] = -sp; vertices[vi++] = 0; vertices[vi++] = cp // tangent = d pos / d phi
      vertices[vi++] = s / segments; vertices[vi++] = r / rings // uv
    }
  }
  const indices = new Uint32Array(rings * segments * 6)
  let ii = 0
  for (let r = 0; r < rings; r += 1) {
    for (let s = 0; s < segments; s += 1) {
      const a = r * (segments + 1) + s
      const b = a + segments + 1
      indices[ii++] = a; indices[ii++] = b; indices[ii++] = a + 1
      indices[ii++] = a + 1; indices[ii++] = b; indices[ii++] = b + 1
    }
  }
  return { vertices, indices }
}

function build_rounded_cube(segments = 28, half = 1, radius = 0.3): { vertices: Float32Array; indices: Uint32Array } {
  // Each face is a grid on the box surface; positions are rounded by clamping
  // to the inner box and pushing back out by `radius`, which also yields the
  // exact normal. Tangents are the face's U axis re-orthogonalized against it.
  const faces: { n: number[]; u: number[]; v: number[] }[] = [
    { n: [1, 0, 0], u: [0, 0, -1], v: [0, 1, 0] },
    { n: [-1, 0, 0], u: [0, 0, 1], v: [0, 1, 0] },
    { n: [0, 1, 0], u: [1, 0, 0], v: [0, 0, -1] },
    { n: [0, -1, 0], u: [1, 0, 0], v: [0, 0, 1] },
    { n: [0, 0, 1], u: [1, 0, 0], v: [0, 1, 0] },
    { n: [0, 0, -1], u: [-1, 0, 0], v: [0, 1, 0] },
  ]
  const verts_per_face = (segments + 1) * (segments + 1)
  const vertices = new Float32Array(faces.length * verts_per_face * 11)
  const indices = new Uint32Array(faces.length * segments * segments * 6)
  const inner = half - radius
  let vi = 0
  let ii = 0
  for (let f = 0; f < faces.length; f += 1) {
    const { n, u, v } = faces[f]!
    const face_base = f * verts_per_face
    for (let gv = 0; gv <= segments; gv += 1) {
      const tv = (gv / segments) * 2 - 1
      for (let gu = 0; gu <= segments; gu += 1) {
        const tu = (gu / segments) * 2 - 1
        const px = n[0]! * half + u[0]! * tu * half + v[0]! * tv * half
        const py = n[1]! * half + u[1]! * tu * half + v[1]! * tv * half
        const pz = n[2]! * half + u[2]! * tu * half + v[2]! * tv * half
        const cx = clamp(px, -inner, inner)
        const cy = clamp(py, -inner, inner)
        const cz = clamp(pz, -inner, inner)
        const dx = px - cx
        const dy = py - cy
        const dz = pz - cz
        const len = Math.hypot(dx, dy, dz) || 1
        const nx = dx / len
        const ny = dy / len
        const nz = dz / len
        // Gram-Schmidt the face U axis against the rounded normal.
        const dot_un = u[0]! * nx + u[1]! * ny + u[2]! * nz
        let tx = u[0]! - nx * dot_un
        let ty = u[1]! - ny * dot_un
        let tz = u[2]! - nz * dot_un
        const tlen = Math.hypot(tx, ty, tz) || 1
        tx /= tlen
        ty /= tlen
        tz /= tlen
        vertices[vi++] = cx + nx * radius; vertices[vi++] = cy + ny * radius; vertices[vi++] = cz + nz * radius
        vertices[vi++] = nx; vertices[vi++] = ny; vertices[vi++] = nz
        vertices[vi++] = tx; vertices[vi++] = ty; vertices[vi++] = tz
        vertices[vi++] = gu / segments; vertices[vi++] = 1 - gv / segments
      }
    }
    for (let gv = 0; gv < segments; gv += 1) {
      for (let gu = 0; gu < segments; gu += 1) {
        const a = face_base + gv * (segments + 1) + gu
        const b = a + segments + 1
        indices[ii++] = a; indices[ii++] = b; indices[ii++] = a + 1
        indices[ii++] = a + 1; indices[ii++] = b; indices[ii++] = b + 1
      }
    }
  }
  return { vertices, indices }
}

// --- column-major mat4 helpers (same layout as the asset_audit viewer) -------

function mat4_perspective(fov: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fov / 2)
  const out = new Float32Array(16)
  out[0] = f / Math.max(1e-6, aspect)
  out[5] = f
  out[10] = far / (near - far)
  out[11] = -1
  out[14] = (near * far) / (near - far)
  return out
}

function mat4_look_at(eye: [number, number, number], target: [number, number, number], up: [number, number, number]): Float32Array {
  let zx = eye[0] - target[0], zy = eye[1] - target[1], zz = eye[2] - target[2]
  let len = Math.hypot(zx, zy, zz) || 1
  zx /= len; zy /= len; zz /= len
  let xx = up[1] * zz - up[2] * zy
  let xy = up[2] * zx - up[0] * zz
  let xz = up[0] * zy - up[1] * zx
  len = Math.hypot(xx, xy, xz) || 1
  xx /= len; xy /= len; xz /= len
  const yx = zy * xz - zz * xy
  const yy = zz * xx - zx * xz
  const yz = zx * xy - zy * xx
  const out = new Float32Array(16)
  out[0] = xx; out[1] = yx; out[2] = zx
  out[4] = xy; out[5] = yy; out[6] = zy
  out[8] = xz; out[9] = yz; out[10] = zz
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2])
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2])
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2])
  out[15] = 1
  return out
}

function mat4_multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16)
  for (let col = 0; col < 4; col += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0
      for (let k = 0; k < 4; k += 1) sum += a[k * 4 + row]! * b[col * 4 + k]!
      out[col * 4 + row] = sum
    }
  }
  return out
}

export interface material_audit_grid_params {
  /** Target-px position of texel (0, 0). */
  origin_x: number
  origin_y: number
  /** Layout texels per target px (1 / zoom). */
  texel_per_px: number
  /** Draw tile-boundary guide lines. */
  guides: boolean
  /** Backdrop composited behind transparent texels, normalized RGBA. */
  clear: { r: number; g: number; b: number; a: number }
}

export interface material_audit_mesh_params {
  shape: 'sphere' | 'cube'
  orbit: { yaw: number; pitch: number; distance: number }
  uv_repeat: number
  /** Viewport backdrop, normalized RGBA. */
  clear: { r: number; g: number; b: number; a: number }
}

type mesh_buffers = { vertex_buffer: GPUBuffer; index_buffer: GPUBuffer; index_count: number }

/** Owns the material-preview GPU passes: the mip-chained map textures, the
 * repeat samplers, the preview meshes and the offscreen color target the UI
 * composites. */
export class material_audit_view {
  private device: GPUDevice | null = null
  private grid_pipeline: GPURenderPipeline | null = null
  private mesh_pipeline: GPURenderPipeline | null = null
  private bind_layout: GPUBindGroupLayout | null = null
  private blit_pipeline: GPURenderPipeline | null = null
  private blit_layout: GPUBindGroupLayout | null = null
  private blit_sampler: GPUSampler | null = null
  private uniform: GPUBuffer | null = null
  private sampler_mip: GPUSampler | null = null
  private sampler_flat: GPUSampler | null = null
  private default_base: GPUTexture | null = null
  private default_normal: GPUTexture | null = null
  private map_textures: { base: GPUTexture | null; normal: GPUTexture | null } = { base: null, normal: null }
  private bind_mip: GPUBindGroup | null = null
  private bind_flat: GPUBindGroup | null = null
  private meshes = new Map<'sphere' | 'cube', mesh_buffers>()
  private target: GPUTexture | null = null
  private depth: GPUTexture | null = null

  init(device: GPUDevice): void {
    if (this.device === device && this.grid_pipeline) return
    this.device = device
    this.bind_layout = device.createBindGroupLayout({
      label: 'material_audit.bind_layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: {} },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    const layout = device.createPipelineLayout({ label: 'material_audit.pipeline_layout', bindGroupLayouts: [this.bind_layout] })
    const grid_module = device.createShaderModule({ label: 'material_audit.grid_shader', code: grid_shader })
    this.grid_pipeline = device.createRenderPipeline({
      label: 'material_audit.grid_pipeline',
      layout,
      vertex: { module: grid_module, entryPoint: 'vs_main' },
      fragment: { module: grid_module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    const mesh_module = device.createShaderModule({ label: 'material_audit.mesh_shader', code: mesh_shader })
    this.mesh_pipeline = device.createRenderPipeline({
      label: 'material_audit.mesh_pipeline',
      layout,
      vertex: {
        module: mesh_module,
        entryPoint: 'vs_main',
        buffers: [{
          arrayStride: 44,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x3' },
            { shaderLocation: 3, offset: 36, format: 'float32x2' },
          ],
        }],
      },
      fragment: { module: mesh_module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth24plus', depthWriteEnabled: true, depthCompare: 'less' },
    })
    // One uniform buffer shared by both passes (the larger mesh struct wins).
    this.uniform = device.createBuffer({
      label: 'material_audit.uniform',
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
    })
    // Repeat addressing is the whole point: UVs run far outside [0, 1] so the
    // maps tile forever. `flat` clamps sampling to mip level 0.
    this.sampler_mip = device.createSampler({
      label: 'material_audit.sampler_mip',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      mipmapFilter: 'linear',
    })
    this.sampler_flat = device.createSampler({
      label: 'material_audit.sampler_flat',
      addressModeU: 'repeat',
      addressModeV: 'repeat',
      magFilter: 'linear',
      minFilter: 'linear',
      lodMaxClamp: 0,
    })

    const blit_module = device.createShaderModule({ label: 'material_audit.mip_blit_shader', code: mip_blit_shader })
    this.blit_layout = device.createBindGroupLayout({
      label: 'material_audit.blit_layout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, texture: {} },
      ],
    })
    this.blit_pipeline = device.createRenderPipeline({
      label: 'material_audit.blit_pipeline',
      layout: device.createPipelineLayout({ label: 'material_audit.blit_pipeline_layout', bindGroupLayouts: [this.blit_layout] }),
      vertex: { module: blit_module, entryPoint: 'vs_main' },
      fragment: { module: blit_module, entryPoint: 'fs_main', targets: [{ format: 'rgba8unorm' }] },
      primitive: { topology: 'triangle-list' },
    })
    this.blit_sampler = device.createSampler({ label: 'material_audit.blit_sampler', magFilter: 'linear', minFilter: 'linear' })

    // Slot fallbacks: 1×1 white base color, 1×1 flat (+Z) normal.
    const make_default = (label: string, rgba: [number, number, number, number]): GPUTexture => {
      const texture = device.createTexture({
        label,
        size: [1, 1, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
      })
      device.queue.writeTexture({ texture }, new Uint8Array(rgba), { bytesPerRow: 4 }, [1, 1, 1])
      return texture
    }
    this.default_base = make_default('material_audit.default_base', [255, 255, 255, 255])
    this.default_normal = make_default('material_audit.default_normal', [128, 128, 255, 255])
    this.rebuild_bind_groups()
  }

  /** Upload a map bitmap into a texture with a full mip chain (generated by
   * blitting each level from the one above); null restores the slot fallback. */
  set_map(slot: material_audit_map_slot, bitmap: ImageBitmap | null): void {
    const device = this.device
    if (!device || !this.blit_layout || !this.blit_pipeline || !this.blit_sampler) return
    this.map_textures[slot]?.destroy()
    this.map_textures[slot] = null
    if (bitmap) {
      const mip_levels = 1 + Math.floor(Math.log2(Math.max(bitmap.width, bitmap.height)))
      const texture = device.createTexture({
        label: `material_audit.map.${slot}`,
        size: [bitmap.width, bitmap.height, 1],
        format: 'rgba8unorm',
        mipLevelCount: mip_levels,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT,
      })
      device.queue.copyExternalImageToTexture({ source: bitmap }, { texture }, [bitmap.width, bitmap.height])
      const encoder = device.createCommandEncoder({ label: `material_audit.mipgen.${slot}` })
      for (let level = 1; level < mip_levels; level += 1) {
        const bind = device.createBindGroup({
          label: `material_audit.mipgen.bind.${level}`,
          layout: this.blit_layout,
          entries: [
            { binding: 0, resource: this.blit_sampler },
            { binding: 1, resource: texture.createView({ baseMipLevel: level - 1, mipLevelCount: 1 }) },
          ],
        })
        const pass = encoder.beginRenderPass({
          label: `material_audit.mipgen.pass.${level}`,
          colorAttachments: [{
            view: texture.createView({ baseMipLevel: level, mipLevelCount: 1 }),
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
      this.map_textures[slot] = texture
    }
    this.rebuild_bind_groups()
  }

  private rebuild_bind_groups(): void {
    const device = this.device
    if (!device || !this.bind_layout || !this.uniform || !this.sampler_mip || !this.sampler_flat || !this.default_base || !this.default_normal) return
    const base_view = (this.map_textures.base ?? this.default_base).createView()
    const normal_view = (this.map_textures.normal ?? this.default_normal).createView()
    const make = (label: string, sampler: GPUSampler) => device.createBindGroup({
      label,
      layout: this.bind_layout!,
      entries: [
        { binding: 0, resource: { buffer: this.uniform! } },
        { binding: 1, resource: sampler },
        { binding: 2, resource: base_view },
        { binding: 3, resource: normal_view },
      ],
    })
    this.bind_mip = make('material_audit.bind.mip', this.sampler_mip)
    this.bind_flat = make('material_audit.bind.flat', this.sampler_flat)
  }

  private ensure_targets(width: number, height: number, with_depth: boolean): void {
    const device = this.device!
    if (!this.target || this.target.width !== width || this.target.height !== height) {
      this.target?.destroy()
      this.target = device.createTexture({
        label: 'material_audit.color_target',
        size: [width, height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
    }
    if (with_depth && (!this.depth || this.depth.width !== width || this.depth.height !== height)) {
      this.depth?.destroy()
      this.depth = device.createTexture({
        label: 'material_audit.depth_target',
        size: [width, height, 1],
        format: 'depth24plus',
        usage: GPUTextureUsage.RENDER_ATTACHMENT,
      })
    }
  }

  private mesh_for(shape: 'sphere' | 'cube'): mesh_buffers {
    let mesh = this.meshes.get(shape)
    if (mesh) return mesh
    const device = this.device!
    const { vertices, indices } = shape === 'sphere' ? build_uv_sphere() : build_rounded_cube()
    const vertex_buffer = device.createBuffer({
      label: `material_audit.${shape}.vertices`,
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(vertex_buffer, 0, vertices as unknown as GPUAllowSharedBufferSource)
    const index_buffer = device.createBuffer({
      label: `material_audit.${shape}.indices`,
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST,
    })
    device.queue.writeBuffer(index_buffer, 0, indices as unknown as GPUAllowSharedBufferSource)
    mesh = { vertex_buffer, index_buffer, index_count: indices.length }
    this.meshes.set(shape, mesh)
    return mesh
  }

  /** Render the endlessly tiled flat plane into the offscreen target. */
  render_grid(width: number, height: number, mip: boolean, has_normal: boolean, layout_w: number, layout_h: number, p: material_audit_grid_params): GPUTexture | null {
    const device = this.device
    const bind = mip ? this.bind_mip : this.bind_flat
    if (!device || !this.grid_pipeline || !this.uniform || !bind) return null
    this.ensure_targets(width, height, false)
    device.queue.writeBuffer(this.uniform, 0, new Float32Array([
      width, height,
      p.origin_x, p.origin_y,
      p.texel_per_px, p.guides ? 1 : 0,
      layout_w, layout_h,
      p.clear.r, p.clear.g, p.clear.b, p.clear.a,
      has_normal ? 1 : 0, 0, 0, 0,
    ]))
    const encoder = device.createCommandEncoder({ label: 'material_audit.grid_encoder' })
    const pass = encoder.beginRenderPass({
      label: 'material_audit.grid_pass',
      colorAttachments: [{
        view: this.target!.createView(),
        loadOp: 'clear',
        clearValue: { r: 0, g: 0, b: 0, a: 1 },
        storeOp: 'store',
      }],
    })
    pass.setPipeline(this.grid_pipeline)
    pass.setBindGroup(0, bind)
    pass.draw(3)
    pass.end()
    device.queue.submit([encoder.finish()])
    return this.target
  }

  /** Render the UV sphere / rounded cube into the offscreen target. */
  render_mesh(width: number, height: number, mip: boolean, has_normal: boolean, p: material_audit_mesh_params): GPUTexture | null {
    const device = this.device
    const bind = mip ? this.bind_mip : this.bind_flat
    if (!device || !this.mesh_pipeline || !this.uniform || !bind) return null
    this.ensure_targets(width, height, true)
    const mesh = this.mesh_for(p.shape)
    const pitch = clamp(p.orbit.pitch, -1.55, 1.55)
    const cp = Math.cos(pitch)
    const eye: [number, number, number] = [
      p.orbit.distance * cp * Math.sin(p.orbit.yaw),
      p.orbit.distance * Math.sin(pitch),
      p.orbit.distance * cp * Math.cos(p.orbit.yaw),
    ]
    const mvp = mat4_multiply(
      mat4_perspective(Math.PI / 4, width / Math.max(1, height), 0.1, 60),
      mat4_look_at(eye, [0, 0, 0], [0, 1, 0]),
    )
    const data = new Float32Array(28)
    data.set(mvp, 0)
    data.set([eye[0], eye[1], eye[2], 0], 16)
    data.set([0.55, 0.65, 0.52, 0], 20) // key light direction, world space
    data.set([p.uv_repeat, has_normal ? 1 : 0, 0, 0], 24)
    device.queue.writeBuffer(this.uniform, 0, data)
    const encoder = device.createCommandEncoder({ label: 'material_audit.mesh_encoder' })
    const pass = encoder.beginRenderPass({
      label: 'material_audit.mesh_pass',
      colorAttachments: [{
        view: this.target!.createView(),
        loadOp: 'clear',
        clearValue: { r: p.clear.r, g: p.clear.g, b: p.clear.b, a: 1 },
        storeOp: 'store',
      }],
      depthStencilAttachment: {
        view: this.depth!.createView(),
        depthLoadOp: 'clear',
        depthClearValue: 1,
        depthStoreOp: 'discard',
      },
    })
    pass.setPipeline(this.mesh_pipeline)
    pass.setBindGroup(0, bind)
    pass.setVertexBuffer(0, mesh.vertex_buffer)
    pass.setIndexBuffer(mesh.index_buffer, 'uint32')
    pass.drawIndexed(mesh.index_count)
    pass.end()
    device.queue.submit([encoder.finish()])
    return this.target
  }
}

// --- the immediate-mode panel -------------------------------------------------

export interface material_audit_options {
  /** Device-pixel scale; defaults to `window.devicePixelRatio`. */
  scale?: number
}

export interface material_audit_event {
  /** Set on the first frame after an upload finished decoding. */
  loaded?: { slot: material_audit_map_slot; name: string; width: number; height: number }
  /** The effective mip state flipped this frame (auto crossing 100% zoom, or a mode click). */
  mip_changed?: boolean
}

function point_in(x: number, y: number, rx: number, ry: number, rw: number, rh: number): boolean {
  return x >= rx && x < rx + rw && y >= ry && y < ry + rh
}

/** Open the picker via the bridge's gesture relay (mobile-safe), or directly. */
function trigger_picker(state: material_audit_state, slot: material_audit_map_slot): void {
  if (state.request_picker) state.request_picker(slot)
  else state.open_file_picker?.(slot)
}

function map_status(label: string, map: material_audit_map | null): string {
  if (!map) return `${label}: —`
  const pot = (map.width & (map.width - 1)) === 0 && (map.height & (map.height - 1)) === 0
  return `${label}: ${map.name} ${map.width}×${map.height}${pot ? '' : ' (non-POT)'}`
}

export function material_audit(
  ui: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  state: material_audit_state,
  options?: material_audit_options,
): material_audit_event {
  const scale = options?.scale ?? (window.devicePixelRatio || 1)
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const event: material_audit_event = {}
  const m = 10 * scale

  if (state.last_upload && state.reported_version !== state.source_version) {
    state.reported_version = state.source_version
    event.loaded = state.last_upload
  }

  // --- toolbar (two rows): uploads + shape, then mipmap + shape extras ------
  const row_h = 26 * scale
  const row_gap = 6 * scale
  const bar_y = y + m
  const seg_gap = 4 * scale
  const label_px = 10 * scale

  let cx = x + m
  if (widgets.button('ma_upload_base', cx, bar_y, 92 * scale, row_h, 'Base Color', { active: !!state.maps.base })) trigger_picker(state, 'base')
  cx += 92 * scale + seg_gap
  if (widgets.button('ma_upload_normal', cx, bar_y, 92 * scale, row_h, 'Normal Map', { active: !!state.maps.normal })) trigger_picker(state, 'normal')
  cx += 92 * scale + 14 * scale
  const shapes: material_audit_shape[] = ['grid', 'sphere', 'cube']
  const shape_labels = ['Grid', 'Sphere', 'Cube']
  for (let i = 0; i < shapes.length; i += 1) {
    if (widgets.button(`ma_shape_${shapes[i]}`, cx, bar_y, 58 * scale, row_h, shape_labels[i]!, { active: state.shape === shapes[i] }) && state.shape !== shapes[i]) {
      state.shape = shapes[i]!
      state.view_dirty = true
    }
    cx += 58 * scale + seg_gap
  }

  const row2_y = bar_y + row_h + row_gap
  cx = x + m
  ui.draw_text(cx, ui.text_v_center_y(row2_y, row_h, label_px), 'mipmap', label_px, slot('text_dim'))
  cx += ui.text_width('mipmap', label_px) + 6 * scale
  const modes: material_audit_mip_mode[] = ['auto', 'on', 'off']
  const mode_labels = ['Auto', 'On', 'Off']
  for (let i = 0; i < modes.length; i += 1) {
    if (widgets.button(`ma_mip_${modes[i]}`, cx, row2_y, 46 * scale, row_h, mode_labels[i]!, { active: state.mip_mode === modes[i] })) {
      state.mip_mode = modes[i]!
      state.view_dirty = true
    }
    cx += 46 * scale + seg_gap
  }
  cx += 10 * scale
  if (state.shape === 'grid') {
    const next_guides = widgets.toggle('ma_guides', cx, row2_y + (row_h - 18 * scale) / 2, state.show_guides, 'tile guides')
    if (next_guides !== state.show_guides) {
      state.show_guides = next_guides
      state.view_dirty = true
    }
  } else {
    ui.draw_text(cx, ui.text_v_center_y(row2_y, row_h, label_px), 'repeat', label_px, slot('text_dim'))
    cx += ui.text_width('repeat', label_px) + 6 * scale
    for (const repeat of UV_REPEATS) {
      if (widgets.button(`ma_repeat_${repeat}`, cx, row2_y, 40 * scale, row_h, `×${repeat}`, { active: state.uv_repeat === repeat }) && state.uv_repeat !== repeat) {
        state.uv_repeat = repeat
        state.view_dirty = true
      }
      cx += 40 * scale + seg_gap
    }
  }

  // --- viewport -------------------------------------------------------------
  const vp_x = x + m
  const vp_y = row2_y + row_h + m
  const vp_w = Math.max(40 * scale, w - m * 2)
  const vp_h = Math.max(40 * scale, y + h - m - vp_y)
  const radius = 6 * scale
  ui.fill_round_rect(vp_x, vp_y, vp_w, vp_h, radius, slot('panel_alt'))

  const has_material = !!state.maps.base || !!state.maps.normal
  if (has_material) {
    const inside = point_in(input.mouse_x, input.mouse_y, vp_x, vp_y, vp_w, vp_h)
    // The grid lays tiles out by the base color map; with only a normal map
    // loaded, the normal map defines the tile size instead.
    const layout_map = state.maps.base ?? state.maps.normal!

    if (state.shape === 'grid') {
      const cam = state.cam
      if (state.fit_pending) {
        // Fit ~3×3 tiles centered in the viewport so repetition is visible at once.
        state.fit_pending = false
        cam.zoom = clamp(Math.min(vp_w / (3 * layout_map.width), vp_h / (3 * layout_map.height)), MIN_ZOOM, MAX_ZOOM)
        cam.pan_x = vp_w / 2 - 1.5 * layout_map.width * cam.zoom
        cam.pan_y = vp_h / 2 - 1.5 * layout_map.height * cam.zoom
      }
      // Pan + zoom: wheel / pinch through the shared core handler, plus a
      // left-button or single-finger drag pan. Pan is kept in physical px
      // relative to the viewport origin, zoom is px-per-texel.
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
    } else {
      // (fit_pending stays armed: the grid re-fits when next shown.)
      // Orbit on drag (mouse or one finger), dolly on wheel / pinch.
      const orbit = state.orbit
      if (inside && input.mouse_pressed && !state.orbiting) {
        state.orbiting = true
        state.last_mx = input.mouse_x
        state.last_my = input.mouse_y
      }
      if (state.orbiting) {
        if (input.mouse_down) {
          const dx = input.mouse_x - state.last_mx
          const dy = input.mouse_y - state.last_my
          if (dx || dy) {
            orbit.yaw -= dx * 0.0085
            orbit.pitch = clamp(orbit.pitch + dy * 0.0085, -1.55, 1.55)
            state.last_mx = input.mouse_x
            state.last_my = input.mouse_y
            state.view_dirty = true
          }
          ui.set_cursor('grabbing')
        } else {
          state.orbiting = false
        }
      }
      if (inside && input.wheel_y) {
        orbit.distance = clamp(orbit.distance * Math.exp(-input.wheel_y * 0.08), MIN_DISTANCE, MAX_DISTANCE)
        state.view_dirty = true
      }
      if (inside && input.zoom_factor && input.zoom_factor !== 1) {
        orbit.distance = clamp(orbit.distance / input.zoom_factor, MIN_DISTANCE, MAX_DISTANCE)
        state.view_dirty = true
      }
    }

    // Auto mipmap: on the grid, sample through the chain exactly while
    // minified on screen; the 3D shapes perspective-minify, so auto = on.
    const grid_minified = state.cam.zoom < 1
    const mip_active = state.mip_mode === 'on' || (state.mip_mode === 'auto' && (state.shape !== 'grid' || grid_minified))
    if (mip_active !== state.last_mip_active) {
      state.last_mip_active = mip_active
      state.view_dirty = true
      event.mip_changed = true
    }

    // --- offscreen pass (only when something changed) -----------------------
    const { device } = ui.gpu()
    if (device) {
      state.view.init(device)
      if (state.synced.base !== (state.maps.base?.version ?? 0)) {
        state.view.set_map('base', state.maps.base?.bitmap ?? null)
        state.synced.base = state.maps.base?.version ?? 0
        state.view_dirty = true
      }
      if (state.synced.normal !== (state.maps.normal?.version ?? 0)) {
        state.view.set_map('normal', state.maps.normal?.bitmap ?? null)
        state.synced.normal = state.maps.normal?.version ?? 0
        state.view_dirty = true
      }
      const px_w = Math.max(1, Math.floor(vp_w))
      const px_h = Math.max(1, Math.floor(vp_h))
      if (state.texture && (state.texture.width !== px_w || state.texture.height !== px_h)) state.view_dirty = true
      if (state.view_dirty) {
        const clear = hex_to_normalized_rgba(theme.palette.panel_alt)
        const has_normal = !!state.maps.normal
        const texture = state.shape === 'grid'
          ? state.view.render_grid(px_w, px_h, mip_active, has_normal, layout_map.width, layout_map.height, {
              origin_x: state.cam.pan_x,
              origin_y: state.cam.pan_y,
              texel_per_px: 1 / state.cam.zoom,
              guides: state.show_guides,
              clear,
            })
          : state.view.render_mesh(px_w, px_h, mip_active, has_normal, {
              shape: state.shape,
              orbit: state.orbit,
              uv_repeat: state.uv_repeat,
              clear,
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

    // Status: both map slots and the live view / mip decision.
    const mip_label = state.mip_mode === 'auto'
      ? `${mip_active ? 'on' : 'off'} (auto${state.shape === 'grid' ? (grid_minified ? ' · minified' : '') : ' · 3d'})`
      : state.mip_mode
    const view_label = state.shape === 'grid'
      ? `zoom ${(state.cam.zoom * 100).toFixed(0)}%`
      : `${state.shape} · repeat ×${state.uv_repeat}`
    const status = `${map_status('base', state.maps.base)} · ${map_status('normal', state.maps.normal)} · ${view_label} · mipmap ${mip_label}`
    ui.draw_text(vp_x + 10 * scale, vp_y + vp_h - 32 * scale, status, 9 * scale, slot('text'), FONT_MONO)
    const hint = state.shape === 'grid'
      ? 'drag pan · wheel zoom · pinch / two-finger pan on touch'
      : 'drag orbit · wheel / pinch zoom'
    ui.draw_text(vp_x + 10 * scale, vp_y + vp_h - 18 * scale, hint, 9 * scale, slot('text_dim'), FONT_MONO)
  } else {
    // Empty state: drop hint + inline upload buttons.
    const ecx = vp_x + vp_w / 2
    const ecy = vp_y + vp_h / 2
    const title = state.loading > 0 ? 'Decoding image…' : 'Drop a base color / normal map here to audit a material'
    const tf = 13 * scale
    ui.draw_text(ecx - ui.text_width(title, tf) / 2, ecy - 34 * scale, title, tf, slot('text'))
    if (state.loading === 0) {
      const sub = 'tile it on a grid or wrap it on a sphere / rounded cube to hunt for seams'
      const sf = 10 * scale
      ui.draw_text(ecx - ui.text_width(sub, sf) / 2, ecy - 12 * scale, sub, sf, slot('text_dim'))
      const bw = 110 * scale
      const bh = 28 * scale
      if (widgets.button('ma_empty_base', ecx - bw - 5 * scale, ecy + 12 * scale, bw, bh, 'Base Color', { active: true })) trigger_picker(state, 'base')
      if (widgets.button('ma_empty_normal', ecx + 5 * scale, ecy + 12 * scale, bw, bh, 'Normal Map')) trigger_picker(state, 'normal')
    }
  }

  if (state.drop_hover) {
    ui.stroke_round_rect(vp_x + 2 * scale, vp_y + 2 * scale, vp_w - 4 * scale, vp_h - 4 * scale, radius, 2 * scale, slot('accent'))
  }

  return event
}
