// Asset audit — drop or upload a .glb / .gltf / .fbx file (or a whole folder),
// preview the geometry in a WebGPU orbit viewport, inspect counts/bounds/
// warnings, run optimization passes (weld, degenerate/unused removal, normal
// rebuild) and download the fixed asset as a self-contained GLB.
//
// Split like the other plugins: a pure immediate-mode panel (`asset_audit`)
// that draws from host-owned state each frame, plus a DOM bridge
// (`asset_audit_dom_target`) that wires drag-and-drop and the hidden file /
// folder pickers onto the host canvas.

import { pack_color, hex_to_normalized_rgba } from '../ui_theme'
import type { theme_definition } from '../ui_types'
import { FONT_MONO, type ui_renderer } from '../ui_renderer'
import type { ui_input_snapshot, ui_scroll_state, ui_widgets } from '../ui_widgets'
import {
  compute_asset_stats,
  decode_asset_textures,
  encode_asset_glb,
  format_asset_bytes,
  recompute_mesh_normals,
  remove_degenerate_triangles,
  remove_unused_vertices,
  weld_mesh_vertices,
  type audit_asset,
  type audit_stats,
} from './ui_asset_audit_data'
import { parse_gltf_asset } from './ui_asset_audit_gltf'
import { parse_fbx_asset } from './ui_asset_audit_fbx'
import {
  asset_audit_view,
  create_orbit_camera,
  frame_orbit_camera,
  type asset_audit_view_mode,
  type orbit_camera,
} from './ui_asset_audit_view'

export interface asset_audit_log_entry {
  text: string
  color?: string
}

export interface asset_audit_state {
  assets: audit_asset[]
  active: number
  camera: orbit_camera
  wireframe: boolean
  /** Viewport shading: lit base color, base-color texture, or normals-as-RGB. */
  view_mode: asset_audit_view_mode
  /** Number of in-flight file loads (drives the spinner text). */
  loading: number
  /** True while a drag with files hovers the host element. */
  drop_hover: boolean
  log: asset_audit_log_entry[]
  /** Bumped on every data change so hosts can invalidate cached windows. */
  revision: number
  // 3D preview plumbing (owned here, fed by the IM function each frame).
  view: asset_audit_view
  texture_id: number | null
  texture: GPUTexture | null
  view_dirty: boolean
  synced_asset: audit_asset | null
  synced_version: number
  stats: audit_stats | null
  stats_asset: audit_asset | null
  stats_version: number
  // viewport interaction
  orbiting: boolean
  panning: boolean
  last_mx: number
  last_my: number
  sidebar_scroll: ui_scroll_state
  sidebar_content_h: number
  // wired by asset_audit_dom_target
  open_file_picker: (() => void) | null
  open_folder_picker: (() => void) | null
  /**
   * Preferred picker trigger: queues the request so the bridge can call the
   * hidden input's `.click()` inside the next trusted pointerup — mobile
   * browsers only show the file dialog from a user-gesture call stack, and the
   * IM button fires on the press edge from inside requestAnimationFrame.
   */
  request_picker: ((kind: 'file' | 'folder') => void) | null
  /** False on platforms without directory pickers (iOS/Android) — hides the folder buttons. */
  folder_picker_supported: boolean
  on_change: (() => void) | null
}

export function create_asset_audit_state(): asset_audit_state {
  return {
    assets: [],
    active: -1,
    camera: create_orbit_camera(),
    wireframe: false,
    view_mode: 'shaded',
    loading: 0,
    drop_hover: false,
    log: [],
    revision: 0,
    view: new asset_audit_view(),
    texture_id: null,
    texture: null,
    view_dirty: true,
    synced_asset: null,
    synced_version: -1,
    stats: null,
    stats_asset: null,
    stats_version: -1,
    orbiting: false,
    panning: false,
    last_mx: 0,
    last_my: 0,
    sidebar_scroll: { offset_y: 0 },
    sidebar_content_h: 0,
    open_file_picker: null,
    open_folder_picker: null,
    request_picker: null,
    folder_picker_supported: true,
    on_change: null,
  }
}

const LOG_LIMIT = 120

export function asset_audit_log(state: asset_audit_state, text: string, color?: string): void {
  state.log.push(color ? { text, color } : { text })
  if (state.log.length > LOG_LIMIT) state.log.splice(0, state.log.length - LOG_LIMIT)
  notify(state)
}

function notify(state: asset_audit_state): void {
  state.revision += 1
  state.on_change?.()
}

function active_asset(state: asset_audit_state): audit_asset | null {
  return state.assets[state.active] ?? null
}

function select_asset(state: asset_audit_state, index: number): void {
  if (index < 0 || index >= state.assets.length || index === state.active) return
  state.active = index
  refresh_stats(state)
  frame_orbit_camera(state.camera, state.stats?.bounds ?? null)
  state.view_dirty = true
  notify(state)
}

function refresh_stats(state: asset_audit_state): void {
  const asset = active_asset(state)
  if (!asset) {
    state.stats = null
    state.stats_asset = null
    return
  }
  if (state.stats_asset === asset && state.stats_version === asset.geometry_version && state.stats) return
  state.stats = compute_asset_stats(asset)
  state.stats_asset = asset
  state.stats_version = asset.geometry_version
}

// --- loading -----------------------------------------------------------------

export interface asset_audit_file {
  name: string
  data: ArrayBuffer
}

const ASSET_EXTENSIONS = ['.glb', '.gltf', '.fbx']

function file_extension(name: string): string {
  const dot = name.lastIndexOf('.')
  return dot >= 0 ? name.slice(dot).toLowerCase() : ''
}

/**
 * Parse a batch of raw files into the audit state. Non-asset files in the
 * batch (e.g. the .bin next to a .gltf from a folder upload) become resolvable
 * external resources for the glTF importer.
 */
export async function asset_audit_load_files(state: asset_audit_state, files: asset_audit_file[]): Promise<void> {
  const externals = new Map<string, ArrayBuffer>()
  const asset_files: asset_audit_file[] = []
  for (const file of files) {
    if (ASSET_EXTENSIONS.includes(file_extension(file.name))) asset_files.push(file)
    else externals.set(file.name.split('/').pop()!.toLowerCase(), file.data)
  }
  if (asset_files.length === 0) {
    asset_audit_log(state, `no .glb / .gltf / .fbx file in the selection (${files.length} file${files.length === 1 ? '' : 's'})`, '#d8a24a')
    return
  }
  for (const file of asset_files) {
    state.loading += 1
    notify(state)
    try {
      const short = file.name.split('/').pop() ?? file.name
      const asset = file_extension(file.name) === '.fbx'
        ? await parse_fbx_asset(file.data, short)
        : parse_gltf_asset(file.data, short, { external_files: externals })
      // Decode base-color textures before publishing the asset so the viewer's
      // Texture preview mode has its bitmaps ready on the first upload.
      const decoded_textures = await decode_asset_textures(asset)
      state.assets.push(asset)
      state.active = state.assets.length - 1
      refresh_stats(state)
      frame_orbit_camera(state.camera, state.stats?.bounds ?? null)
      state.view_dirty = true
      const stats = state.stats
      asset_audit_log(
        state,
        `loaded ${short} — ${stats?.mesh_count ?? 0} mesh(es), ${stats?.vertex_count ?? 0} verts, ${stats?.triangle_count ?? 0} tris`,
        '#5fb878',
      )
      if (decoded_textures > 0) {
        asset_audit_log(state, `decoded ${decoded_textures} base color texture(s) — try the Texture view mode`, '#5fb878')
      }
      if (asset.warnings.length > 0) asset_audit_log(state, `${asset.warnings.length} import warning(s) — see Warnings`, '#d8a24a')
    } catch (err) {
      asset_audit_log(state, `failed to load ${file.name}: ${err instanceof Error ? err.message : err}`, '#d9534f')
    } finally {
      state.loading -= 1
      notify(state)
    }
  }
}

// --- download ----------------------------------------------------------------

/** Re-encode the active (possibly optimized) asset as GLB and download it. */
export function asset_audit_download_active(state: asset_audit_state): boolean {
  const asset = active_asset(state)
  if (!asset || typeof document === 'undefined') return false
  try {
    const glb = encode_asset_glb(asset)
    const stem = asset.file_name.replace(/\.[^.]+$/, '') || 'asset'
    const file_name = `${stem}.fixed.glb`
    const url = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' }))
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = file_name
    anchor.click()
    window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
    asset_audit_log(state, `exported ${file_name} (${format_asset_bytes(glb.byteLength)})`, '#5fb878')
    return true
  } catch (err) {
    asset_audit_log(state, `export failed: ${err instanceof Error ? err.message : err}`, '#d9534f')
    return false
  }
}

// --- optimization passes -------------------------------------------------------

export type asset_audit_optimization = 'weld' | 'degenerate' | 'unused' | 'normals'

export function asset_audit_optimize(state: asset_audit_state, pass: asset_audit_optimization): void {
  const asset = active_asset(state)
  if (!asset) return
  let total = 0
  for (const mesh of asset.meshes) {
    switch (pass) {
      case 'weld': total += weld_mesh_vertices(mesh); break
      case 'degenerate': total += remove_degenerate_triangles(mesh); break
      case 'unused': total += remove_unused_vertices(mesh); break
      case 'normals': recompute_mesh_normals(mesh); total += 1; break
    }
  }
  asset.geometry_version += 1
  refresh_stats(state)
  state.view_dirty = true
  switch (pass) {
    case 'weld':
      asset_audit_log(state, total > 0 ? `weld: merged ${total} duplicate vertices` : 'weld: no duplicate vertices', total > 0 ? '#5fb878' : undefined)
      break
    case 'degenerate':
      asset_audit_log(state, total > 0 ? `removed ${total} degenerate triangle(s)` : 'no degenerate triangles', total > 0 ? '#5fb878' : undefined)
      break
    case 'unused':
      asset_audit_log(state, total > 0 ? `removed ${total} unused vertex(es)` : 'no unused vertices', total > 0 ? '#5fb878' : undefined)
      break
    case 'normals':
      asset_audit_log(state, `recomputed smooth normals for ${asset.meshes.length} mesh(es)`, '#5fb878')
      break
  }
  notify(state)
}

// --- DOM bridge ----------------------------------------------------------------

export interface asset_audit_dom_options {
  /** Called whenever async work changes the state — wake your renderer here. */
  on_change?: () => void
}

interface webkit_entry {
  isFile: boolean
  isDirectory: boolean
  file(success: (file: File) => void, error?: (err: unknown) => void): void
  createReader(): { readEntries(success: (entries: webkit_entry[]) => void, error?: (err: unknown) => void): void }
}

async function collect_entry_files(entry: webkit_entry, out: File[], depth = 0): Promise<void> {
  if (depth > 24) return
  if (entry.isFile) {
    const file = await new Promise<File | null>((resolve) => entry.file(resolve, () => resolve(null)))
    if (file) out.push(file)
    return
  }
  if (entry.isDirectory) {
    const reader = entry.createReader()
    // readEntries returns results in chunks — drain until empty.
    for (;;) {
      const batch = await new Promise<webkit_entry[]>((resolve) => reader.readEntries(resolve, () => resolve([])))
      if (batch.length === 0) break
      for (const child of batch) await collect_entry_files(child, out, depth + 1)
    }
  }
}

async function files_to_payloads(files: File[]): Promise<asset_audit_file[]> {
  const out: asset_audit_file[] = []
  for (const file of files) out.push({ name: file.name, data: await file.arrayBuffer() })
  return out
}

/**
 * Attach drag-and-drop plus hidden file/folder pickers to a host element
 * (typically the WebGPU canvas). Returns a cleanup function. The panel's
 * Upload buttons call back through `state.open_file_picker` /
 * `state.open_folder_picker`, which this bridge installs.
 */
export function asset_audit_dom_target(target: HTMLElement, state: asset_audit_state, options?: asset_audit_dom_options): () => void {
  state.on_change = options?.on_change ?? null

  const ingest = (files: File[]): void => {
    if (files.length === 0) return
    void files_to_payloads(files).then((payloads) => asset_audit_load_files(state, payloads))
  }

  const ua = navigator.userAgent
  const is_ios = /iPad|iPhone|iPod/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1)
  const is_android = /Android/.test(ua)
  // Mobile platforms have no directory picker — the panel hides the folder buttons.
  state.folder_picker_supported = !(is_ios || is_android)

  // `display:none` inputs ignore programmatic .click() on iOS Safari — park
  // them rendered-but-invisible offscreen instead.
  const style_offscreen = (input: HTMLInputElement): void => {
    input.style.position = 'fixed'
    input.style.left = '0'
    input.style.top = '0'
    input.style.width = '1px'
    input.style.height = '1px'
    input.style.opacity = '0'
    input.style.pointerEvents = 'none'
    input.tabIndex = -1
    input.setAttribute('aria-hidden', 'true')
  }

  const file_input = document.createElement('input')
  file_input.type = 'file'
  file_input.multiple = true
  // iOS treats unknown extensions in `accept` as "nothing selectable" — skip it there.
  if (!is_ios) file_input.accept = '.glb,.gltf,.fbx,.bin'
  style_offscreen(file_input)
  file_input.addEventListener('change', () => {
    ingest([...(file_input.files ?? [])])
    file_input.value = ''
  })

  const folder_input = document.createElement('input')
  folder_input.type = 'file'
  style_offscreen(folder_input)
  folder_input.setAttribute('webkitdirectory', '')
  folder_input.addEventListener('change', () => {
    ingest([...(folder_input.files ?? [])])
    folder_input.value = ''
  })

  document.body.appendChild(file_input)
  document.body.appendChild(folder_input)
  state.open_file_picker = () => file_input.click()
  state.open_folder_picker = () => folder_input.click()

  // Gesture relay: the IM Upload buttons fire on the press edge from inside
  // requestAnimationFrame, where mobile browsers refuse to show a file dialog
  // (no transient user activation until the finger lifts). So the panel queues
  // a request and the `.click()` happens synchronously inside the trusted
  // pointerup. If the release already happened (very fast tap processed in one
  // frame), the activation from that pointerup is still fresh — click directly.
  let pending_picker: { kind: 'file' | 'folder'; at: number } | null = null
  let pointer_held = false
  const PICKER_REQUEST_TTL_MS = 3000
  const fulfill_picker = (): void => {
    const request = pending_picker
    pending_picker = null
    if (!request || performance.now() - request.at > PICKER_REQUEST_TTL_MS) return
    const input = request.kind === 'folder' && state.folder_picker_supported ? folder_input : file_input
    input.click()
  }
  state.request_picker = (kind) => {
    pending_picker = { kind, at: performance.now() }
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
    // Leave pure-JSON drags (e.g. dashboard app manifests) to other targets.
    const items = [...dt.items]
    const claim = items.length === 0 || items.some((item) => item.kind === 'file' && item.type !== 'application/json')
    if (!claim) return
    e.preventDefault()
    e.stopImmediatePropagation()
    dt.dropEffect = 'copy'
    set_hover(true)
  }
  const drag_leave = (): void => set_hover(false)
  const drop = (e: DragEvent): void => {
    const dt = e.dataTransfer
    if (!dt) return
    const items = [...dt.items]
    const has_asset_or_dir = items.some((item) => {
      const entry = (item as unknown as { webkitGetAsEntry?: () => webkit_entry | null }).webkitGetAsEntry?.()
      if (entry?.isDirectory) return true
      const file = item.getAsFile?.()
      return !!file && ASSET_EXTENSIONS.includes(file_extension(file.name))
    })
    set_hover(false)
    if (!has_asset_or_dir) return // not ours — let other drop targets (e.g. the dashboard) take it
    e.preventDefault()
    e.stopImmediatePropagation()
    const collect = async (): Promise<File[]> => {
      const out: File[] = []
      for (const item of items) {
        const entry = (item as unknown as { webkitGetAsEntry?: () => webkit_entry | null }).webkitGetAsEntry?.()
        if (entry) await collect_entry_files(entry, out)
        else {
          const file = item.getAsFile?.()
          if (file) out.push(file)
        }
      }
      return out
    }
    void collect().then(ingest)
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
    folder_input.remove()
    state.open_file_picker = null
    state.open_folder_picker = null
    state.request_picker = null
    state.on_change = null
  }
}

// --- the immediate-mode panel ---------------------------------------------------

export interface asset_audit_options {
  /** Device-pixel scale; defaults to `window.devicePixelRatio`. */
  scale?: number
}

export interface asset_audit_event {
  /** Set when the Download button exported a GLB this frame. */
  downloaded?: boolean
}

function point_in(x: number, y: number, rx: number, ry: number, rw: number, rh: number): boolean {
  return x >= rx && x < rx + rw && y >= ry && y < ry + rh
}

/** Open a picker via the bridge's gesture relay (mobile-safe), or directly. */
function trigger_picker(state: asset_audit_state, kind: 'file' | 'folder'): void {
  if (state.request_picker) state.request_picker(kind)
  else if (kind === 'folder') state.open_folder_picker?.()
  else state.open_file_picker?.()
}

export function asset_audit(
  ui: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  state: asset_audit_state,
  options?: asset_audit_options,
): asset_audit_event {
  const scale = options?.scale ?? (typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1)
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const event: asset_audit_event = {}
  const m = 8 * scale

  ui.fill_rect(x, y, w, h, slot('panel'))
  refresh_stats(state)
  const asset = active_asset(state)

  // --- toolbar ---------------------------------------------------------------
  const bar_h = 30 * scale
  const btn_h = 26 * scale
  const bar_y = y + m
  let bx = x + m
  const button = (id: string, label: string, width: number, opts?: { active?: boolean }): boolean => {
    const hit = widgets.button(id, bx, bar_y + (bar_h - btn_h) / 2, width, btn_h, label, opts)
    bx += width + 6 * scale
    return hit
  }
  if (button('aa_upload_file', 'Upload File', 92 * scale)) trigger_picker(state, 'file')
  if (state.folder_picker_supported && button('aa_upload_folder', 'Upload Folder', 104 * scale)) trigger_picker(state, 'folder')
  const next_wire = widgets.toggle('aa_wire', bx, bar_y + (bar_h - 18 * scale) / 2, state.wireframe, 'Wireframe')
  if (next_wire !== state.wireframe) {
    state.wireframe = next_wire
    state.view_dirty = true
  }
  bx += 110 * scale
  if (asset) {
    // Shading mode: lit base color / base-color texture / normals-as-RGB.
    const mode_button = (id: string, label: string, width: number, mode: asset_audit_view_mode): void => {
      if (button(id, label, width, { active: state.view_mode === mode }) && state.view_mode !== mode) {
        state.view_mode = mode
        state.view_dirty = true
      }
    }
    mode_button('aa_mode_shaded', 'Shaded', 62 * scale, 'shaded')
    mode_button('aa_mode_texture', 'Texture', 62 * scale, 'texture')
    mode_button('aa_mode_normal', 'Normal', 60 * scale, 'normal')
    if (button('aa_reset_view', 'Reset View', 88 * scale)) {
      frame_orbit_camera(state.camera, state.stats?.bounds ?? null)
      state.view_dirty = true
    }
  }
  const dl_w = 120 * scale
  if (asset) {
    if (widgets.button('aa_download', x + w - m - dl_w, bar_y + (bar_h - btn_h) / 2, dl_w, btn_h, 'Download GLB', { active: true })) {
      event.downloaded = asset_audit_download_active(state)
    }
  }

  // --- layout: viewport + sidebar ---------------------------------------------
  const body_y = bar_y + bar_h + m
  const body_h = Math.max(40 * scale, y + h - m - body_y)
  const sidebar_w = w >= 460 * scale ? Math.min(290 * scale, Math.floor(w * 0.4)) : 0
  const vp_x = x + m
  const vp_y = body_y
  const vp_w = Math.max(40 * scale, w - m * 2 - (sidebar_w > 0 ? sidebar_w + m : 0))
  const vp_h = body_h

  draw_viewport(ui, widgets, theme, input, vp_x, vp_y, vp_w, vp_h, state, scale)
  if (sidebar_w > 0) draw_sidebar(ui, widgets, theme, input, x + m + vp_w + m, body_y, sidebar_w, body_h, state, scale)

  return event
}

// --- viewport -------------------------------------------------------------------

function draw_viewport(
  ui: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  input: ui_input_snapshot,
  vx: number,
  vy: number,
  vw: number,
  vh: number,
  state: asset_audit_state,
  scale: number,
): void {
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const radius = 6 * scale
  ui.fill_round_rect(vx, vy, vw, vh, radius, slot('panel_alt'))

  const asset = active_asset(state)
  const inside = point_in(input.mouse_x, input.mouse_y, vx, vy, vw, vh)

  // Orbit / pan / zoom. Any change marks the offscreen 3D pass dirty.
  if (asset) {
    const cam = state.camera
    if (input.mouse_pressed && inside) {
      state.orbiting = !input.shift
      state.panning = input.shift
      state.last_mx = input.mouse_x
      state.last_my = input.mouse_y
    }
    if ((input.mouse_right_down || input.mouse_middle_down) && inside && !state.panning && !state.orbiting) {
      state.panning = true
      state.last_mx = input.mouse_x
      state.last_my = input.mouse_y
    }
    const dragging = (state.orbiting && input.mouse_down) || (state.panning && (input.mouse_down || input.mouse_right_down || input.mouse_middle_down))
    if (dragging) {
      const dx = input.mouse_x - state.last_mx
      const dy = input.mouse_y - state.last_my
      if (dx !== 0 || dy !== 0) {
        if (state.orbiting) {
          cam.yaw -= dx * 0.0085
          cam.pitch = Math.min(1.55, Math.max(-1.55, cam.pitch + dy * 0.0085))
        } else {
          // Pan in camera space: one pixel ≈ one pixel of the framed model.
          const per_px = (2 * cam.distance * Math.tan(cam.fov / 2)) / Math.max(1, vh)
          const right: [number, number, number] = [Math.cos(cam.yaw), 0, -Math.sin(cam.yaw)]
          const sp = Math.sin(cam.pitch), cp = Math.cos(cam.pitch)
          const up: [number, number, number] = [-Math.sin(cam.yaw) * sp, cp, -Math.cos(cam.yaw) * sp]
          cam.target[0] += (-dx * right[0] + dy * up[0]) * per_px
          cam.target[1] += (-dx * right[1] + dy * up[1]) * per_px
          cam.target[2] += (-dx * right[2] + dy * up[2]) * per_px
        }
        state.last_mx = input.mouse_x
        state.last_my = input.mouse_y
        state.view_dirty = true
      }
    } else {
      state.orbiting = false
      state.panning = false
    }
    if (inside && input.wheel_y !== 0) {
      cam.distance = Math.max(1e-4, cam.distance * Math.exp(input.wheel_y * 0.0012))
      state.view_dirty = true
    }
    if (inside && input.zoom_factor && input.zoom_factor !== 1) {
      cam.distance = Math.max(1e-4, cam.distance / input.zoom_factor)
      state.view_dirty = true
    }
  }

  // --- offscreen 3D pass (only when something changed) ------------------------
  if (asset) {
    const { device } = ui.gpu()
    if (device) {
      state.view.init(device)
      if (state.synced_asset !== asset || state.synced_version !== asset.geometry_version) {
        state.view.set_meshes(asset.meshes)
        state.synced_asset = asset
        state.synced_version = asset.geometry_version
        state.view_dirty = true
      }
      const px_w = Math.max(1, Math.floor(vw))
      const px_h = Math.max(1, Math.floor(vh))
      if (state.texture && (state.texture.width !== px_w || state.texture.height !== px_h)) state.view_dirty = true
      if (state.view_dirty) {
        const bounds = state.stats?.bounds ?? null
        const bounds_radius = bounds
          ? Math.max(1e-4, Math.hypot(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1], bounds.max[2] - bounds.min[2]) / 2)
          : state.camera.distance
        const clear = hex_to_normalized_rgba(theme.palette.panel_alt)
        const texture = state.view.render(px_w, px_h, state.camera, { wireframe: state.wireframe, mode: state.view_mode, clear, bounds_radius })
        if (texture) {
          if (state.texture_id === null) state.texture_id = ui.register_external_texture(texture)
          else if (texture !== state.texture) ui.update_external_texture(state.texture_id, texture)
          state.texture = texture
        }
        state.view_dirty = false
      }
      if (state.texture_id !== null) {
        ui.push_clip(vx, vy, vw, vh)
        ui.draw_texture(state.texture_id, vx, vy, vw, vh)
        ui.pop_clip()
      }
    } else {
      ui.draw_text(vx + 12 * scale, vy + 12 * scale, 'WebGPU device not ready…', 11 * scale, slot('text_dim'))
    }
    const hint = 'drag orbit · shift-drag / right-drag pan · wheel zoom'
    ui.draw_text(vx + 10 * scale, vy + vh - 18 * scale, hint, 9 * scale, slot('text_dim'), FONT_MONO)
  } else {
    // Empty state: drop hint + inline upload buttons.
    const cx = vx + vw / 2
    const cy = vy + vh / 2
    const title = state.loading > 0
      ? 'Loading asset…'
      : state.folder_picker_supported
        ? 'Drop a .glb / .gltf / .fbx file or folder here'
        : 'Upload a .glb / .gltf / .fbx file'
    const tf = 13 * scale
    ui.draw_text(cx - ui.text_width(title, tf) / 2, cy - 34 * scale, title, tf, slot('text'))
    if (state.loading === 0) {
      const sub = 'meshes render in a WebGPU viewport with audit info alongside'
      const sf = 10 * scale
      ui.draw_text(cx - ui.text_width(sub, sf) / 2, cy - 12 * scale, sub, sf, slot('text_dim'))
      const bw = 110 * scale
      const bh = 28 * scale
      if (state.folder_picker_supported) {
        if (widgets.button('aa_empty_file', cx - bw - 5 * scale, cy + 12 * scale, bw, bh, 'Upload File', { active: true })) trigger_picker(state, 'file')
        if (widgets.button('aa_empty_folder', cx + 5 * scale, cy + 12 * scale, bw, bh, 'Upload Folder')) trigger_picker(state, 'folder')
      } else if (widgets.button('aa_empty_file', cx - bw / 2, cy + 12 * scale, bw, bh, 'Upload File', { active: true })) {
        trigger_picker(state, 'file')
      }
    }
  }

  if (state.loading > 0 && asset) {
    ui.draw_text(vx + 12 * scale, vy + 12 * scale, `loading ${state.loading} file(s)…`, 10.5 * scale, slot('accent'))
  }
  ui.stroke_round_rect(vx, vy, vw, vh, radius, 1, slot('border'))
  if (state.drop_hover) {
    ui.stroke_round_rect(vx + scale, vy + scale, vw - 2 * scale, vh - 2 * scale, radius, 2 * scale, slot('accent'))
    const drop_label = 'release to load'
    const df = 11 * scale
    ui.draw_text(vx + vw / 2 - ui.text_width(drop_label, df) / 2, vy + 14 * scale, drop_label, df, slot('accent'))
  }
}

// --- sidebar ---------------------------------------------------------------------

function draw_sidebar(
  ui: ui_renderer,
  widgets: ui_widgets,
  theme: theme_definition,
  input: ui_input_snapshot,
  sx: number,
  sy: number,
  sw: number,
  sh: number,
  state: asset_audit_state,
  scale: number,
): void {
  const slot = (name: keyof theme_definition['palette']) => pack_color(theme.palette[name])
  const radius = 6 * scale
  ui.fill_round_rect(sx, sy, sw, sh, radius, slot('panel_alt'))
  ui.stroke_round_rect(sx, sy, sw, sh, radius, 1, slot('border'))

  const pad = 10 * scale
  widgets.handle_scroll_area(sx, sy, sw, sh, state.sidebar_scroll, state.sidebar_content_h)
  const max_off = Math.max(0, state.sidebar_content_h - sh)
  state.sidebar_scroll.offset_y = Math.max(0, Math.min(max_off, state.sidebar_scroll.offset_y))

  ui.push_clip(sx, sy, sw, sh)
  const inner_w = sw - pad * 2
  let cy = sy + pad - state.sidebar_scroll.offset_y
  const section_font = 9.5 * scale
  const row_font = 10.5 * scale

  const section = (label: string): void => {
    ui.draw_text(sx + pad, cy, label, section_font, slot('accent'), FONT_MONO)
    cy += 16 * scale
  }
  const row = (label: string, value: string, color = slot('text')): void => {
    ui.draw_text(sx + pad, cy, label, row_font, slot('text_dim'))
    const vw = ui.text_width(value, row_font, FONT_MONO)
    ui.draw_text(sx + sw - pad - vw, cy, value, row_font, color, FONT_MONO)
    cy += 16 * scale
  }

  const asset = active_asset(state)

  if (state.assets.length > 1) {
    section(`ASSETS · ${state.assets.length}`)
    for (let i = 0; i < state.assets.length; i += 1) {
      const entry = state.assets[i]!
      const rh = 20 * scale
      const hover = point_in(input.mouse_x, input.mouse_y, sx + pad - 4 * scale, cy - 3 * scale, inner_w + 8 * scale, rh)
      if (i === state.active || hover) {
        ui.fill_round_rect(sx + pad - 4 * scale, cy - 3 * scale, inner_w + 8 * scale, rh, 4 * scale, i === state.active ? slot('selected') : slot('hover'))
      }
      if (hover && input.mouse_pressed) select_asset(state, i)
      ui.push_clip(sx + pad, cy, inner_w - 36 * scale, rh)
      ui.draw_text(sx + pad, cy, entry.file_name, row_font, slot('text'))
      ui.pop_clip()
      const tag = entry.format.toUpperCase()
      ui.draw_text(sx + sw - pad - ui.text_width(tag, 9 * scale, FONT_MONO), cy + scale, tag, 9 * scale, slot('text_dim'), FONT_MONO)
      cy += rh + 2 * scale
    }
    cy += 8 * scale
  }

  if (!asset) {
    section('INFO')
    cy += ui.draw_text_wrapped(sx + pad, cy, inner_w, 'No asset loaded yet. Drop a file on the viewport or use the Upload buttons.', row_font, slot('text_dim')) + 8 * scale
  } else {
    const stats = state.stats
    section('INFO')
    ui.push_clip(sx + pad, cy, inner_w, 16 * scale)
    ui.draw_text(sx + pad, cy, asset.file_name, row_font, slot('text'))
    ui.pop_clip()
    cy += 18 * scale
    row('Format', asset.format.toUpperCase())
    row('File size', format_asset_bytes(asset.file_bytes))
    row('Meshes', `${stats?.mesh_count ?? 0}`)
    row('Vertices', `${stats?.vertex_count ?? 0}`)
    row('Triangles', `${stats?.triangle_count ?? 0}`)
    row('Geometry', format_asset_bytes(stats?.geometry_bytes ?? 0))
    row('Nodes', `${asset.source.node_count}`)
    row('Materials', `${asset.source.material_count}`)
    row('Textures', `${asset.source.texture_count}`)
    row('Animations', `${asset.source.animation_count}`)
    row('Skins', `${asset.source.skin_count}`)
    if (stats?.bounds) {
      const b = stats.bounds
      const fmt = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : v.toPrecision(3))
      row('Bounds', `${fmt(b.max[0] - b.min[0])} × ${fmt(b.max[1] - b.min[1])} × ${fmt(b.max[2] - b.min[2])}`)
    }
    cy += 6 * scale

    if (asset.warnings.length > 0) {
      section(`WARNINGS · ${asset.warnings.length}`)
      const warn = pack_color('#d8a24a')
      for (const warning of asset.warnings) {
        cy += ui.draw_text_wrapped(sx + pad, cy, inner_w, `• ${warning}`, 9.5 * scale, warn) + 4 * scale
      }
      cy += 8 * scale
    }

    section('OPTIMIZE')
    const ob_h = 24 * scale
    const opt_button = (id: string, label: string, pass: asset_audit_optimization): void => {
      if (widgets.button(id, sx + pad, cy, inner_w, ob_h, label)) asset_audit_optimize(state, pass)
      cy += ob_h + 5 * scale
    }
    opt_button('aa_opt_weld', 'Weld duplicate vertices', 'weld')
    opt_button('aa_opt_degen', 'Remove degenerate triangles', 'degenerate')
    opt_button('aa_opt_unused', 'Remove unused vertices', 'unused')
    opt_button('aa_opt_normals', 'Recompute smooth normals', 'normals')
    if (widgets.button('aa_opt_download', sx + pad, cy, inner_w, ob_h, 'Download fixed GLB', { active: true })) {
      asset_audit_download_active(state)
    }
    cy += ob_h + 8 * scale
  }

  if (state.log.length > 0) {
    section('LOG')
    for (let i = Math.max(0, state.log.length - 24); i < state.log.length; i += 1) {
      const entry = state.log[i]!
      const color = entry.color ? pack_color(entry.color) : slot('text_dim')
      cy += ui.draw_text_wrapped(sx + pad, cy, inner_w, entry.text, 9.5 * scale, color) + 3 * scale
    }
  }

  state.sidebar_content_h = cy + state.sidebar_scroll.offset_y - sy + pad
  ui.pop_clip()
  if (state.sidebar_content_h > sh) {
    const sb_w = 6 * scale
    widgets.scrollbar('aa_sidebar_sb', sx + sw - sb_w - 2 * scale, sy + 2 * scale, sb_w, sh - 4 * scale, state.sidebar_scroll, state.sidebar_content_h)
  }
}
