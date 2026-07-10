// asset_hub drive browser — a read-only viewer over the user's own cloud
// drive, rendered entirely with the immediate-mode GPU toolkit.
//
// The panel shows the contents of the user's `asset_hub/` folder (Google
// Drive first; the folder is chosen through the provider's picker, with
// read-only Drive access plus per-file write access for uploads).
// It only talks to the `cloud_storage_provider` abstraction — no provider API
// call lives in this file — so Dropbox / iCloud / local-folder backends slot
// in without touching the UI. All work (OAuth, listing, previews) happens in
// the browser; file bytes never leave the user's machine except to the
// storage provider itself.
//
// Image previews are decoded to RGBA in the browser and uploaded to renderer
// textures (the GPU equivalent of an <img> object URL); textures and download
// object URLs are released when the folder changes or the user signs out.

import { theme_color } from '../../core/ui_theme'
import type { theme_definition, theme_slot } from '../../core/ui_types'
import { FONT_MONO, ui_renderer } from '../../core/ui_renderer'
import type { ui_input_snapshot, ui_scroll_state } from '../../core/ui_widgets'
import { create_ui_task_queue_state, ui_task_queue_send, type ui_task_queue_state } from '../../core/ui_task_queue'
import { as_cloud_error, cloud_file_kind_of, type cloud_file, type cloud_file_kind } from '../../storage/ui_cloud_types'
import type { cloud_storage_provider } from '../../storage/ui_cloud_storage_provider'
import { is_uploadable_asset_name, upload_local_files } from './ui_asset_hub_upload'

export type asset_hub_drive_status =
  | 'config_error' // no provider — the OAuth client id is not configured
  | 'disconnected'
  | 'authorizing'
  | 'auth_error'
  | 'locating_root'
  | 'root_needed' // no root granted yet — the provider offers a folder picker
  | 'root_missing' // pickerless provider found no asset hub folder
  | 'loading'
  | 'ready'
  | 'load_error'
  | 'auth_expired'

/** Decoded image preview: RGBA until the panel uploads it to a GPU texture. */
interface hub_thumbnail {
  status: 'loading' | 'ready' | 'failed'
  width: number
  height: number
  rgba: Uint8ClampedArray | null
  texture_id: number
}

interface hub_text_preview {
  status: 'loading' | 'ready' | 'failed'
  lines: string[]
  truncated: boolean
  error?: string
}

export interface asset_hub_drive_state {
  provider: cloud_storage_provider | null
  root_folder_name: string
  status: asset_hub_drive_status
  /** Human-readable detail for error statuses (drawn under the status title). */
  status_detail: string
  /** Folder trail from the asset hub root down to the open folder. */
  breadcrumb: cloud_file[]
  files: cloud_file[]
  selected_id: string | null
  grid_scroll: ui_scroll_state
  detail_scroll: ui_scroll_state
  /** Host callback fired whenever async work changes the state. */
  on_change: (() => void) | null
  /** Internal: monotonically increasing token that cancels stale responses. */
  _seq: number
  /** Internal: true while the provider's folder picker dialog is open. */
  _picking: boolean
  /** Global, host-rendered upload/download queue. */
  task_queue: ui_task_queue_state
  _thumbnails: Map<string, hub_thumbnail>
  _text_previews: Map<string, hub_text_preview>
  /** Internal: texture ids queued for destruction on the next frame. */
  _dispose_textures: number[]
  _press_consumed: boolean
  // wired by asset_hub_drive_dom_target
  open_upload_picker: (() => void) | null
  /** Preferred upload trigger: relays the click into the next trusted pointerup (mobile file dialogs need a real gesture). */
  request_upload_picker: (() => void) | null
}

export interface asset_hub_drive_options {
  font_px?: number
  card_w?: number
  card_h?: number
  detail_w?: number
}

export interface asset_hub_drive_event {
  connect_requested?: boolean
  signed_out?: boolean
  refreshed?: boolean
  pick_requested?: boolean
  folder_opened?: cloud_file
  selected?: cloud_file
  download_requested?: cloud_file
  open_requested?: cloud_file
  upload_requested?: boolean
}

const THUMBNAIL_MAX_DIM = 256
const TEXT_PREVIEW_MAX_BYTES = 512 * 1024
const TEXT_PREVIEW_MAX_LINES = 500
const TEXT_PREVIEW_MAX_COLS = 400

export function create_asset_hub_drive_state(
  provider: cloud_storage_provider | null,
  options?: { root_folder_name?: string; on_change?: () => void; task_queue?: ui_task_queue_state },
): asset_hub_drive_state {
  return {
    provider,
    root_folder_name: options?.root_folder_name ?? 'asset_hub',
    status: provider ? 'disconnected' : 'config_error',
    status_detail: '',
    breadcrumb: [],
    files: [],
    selected_id: null,
    grid_scroll: { offset_y: 0 },
    detail_scroll: { offset_y: 0 },
    on_change: options?.on_change ?? null,
    _seq: 0,
    _picking: false,
    task_queue: options?.task_queue ?? create_ui_task_queue_state(options?.on_change),
    _thumbnails: new Map(),
    _text_previews: new Map(),
    _dispose_textures: [],
    _press_consumed: false,
    open_upload_picker: null,
    request_upload_picker: null,
  }
}

// --- async actions ------------------------------------------------------------
// Triggered by the panel's buttons; each bumps `_seq` before awaiting so a
// stale response (superseded by navigation / refresh / sign-out) is dropped.

function notify(state: asset_hub_drive_state): void {
  state.on_change?.()
}

function set_status(state: asset_hub_drive_state, status: asset_hub_drive_status, detail = ''): void {
  state.status = status
  state.status_detail = detail
}

function fail_action(state: asset_hub_drive_state, operation: string, err: unknown): void {
  console.error(`[Asset Hub] ${operation} failed`, err)
  const e = as_cloud_error(err)
  if (e?.kind === 'auth_expired') set_status(state, 'auth_expired', e.message)
  else if (e?.kind === 'auth') set_status(state, 'auth_error', e.message)
  else if (e?.kind === 'config') set_status(state, 'config_error', e.message)
  else set_status(state, 'load_error', e?.message ?? (err instanceof Error ? err.message : 'Unexpected error.'))
}

async function action_connect(state: asset_hub_drive_state): Promise<void> {
  const provider = state.provider
  if (!provider || state.status === 'authorizing') return
  const seq = ++state._seq
  set_status(state, 'authorizing')
  try {
    await provider.sign_in()
  } catch (err) {
    if (seq === state._seq) fail_action(state, 'Connect', err)
    notify(state)
    return
  }
  if (seq !== state._seq) return
  await action_locate_root(state)
}

async function action_locate_root(state: asset_hub_drive_state): Promise<void> {
  const provider = state.provider
  if (!provider) return
  const seq = ++state._seq
  set_status(state, 'locating_root')
  notify(state)
  let root: cloud_file | null = null
  try {
    root = await provider.find_asset_hub_root()
  } catch (err) {
    if (seq === state._seq) {
      fail_action(state, 'Locate root folder', err)
      notify(state)
    }
    return
  }
  if (seq !== state._seq) return
  if (!root) {
    // With a picker-based provider the user selects the folder; pickerless
    // providers can only report that the folder doesn't exist.
    set_status(state, provider.pick_asset_hub_root ? 'root_needed' : 'root_missing')
    notify(state)
    return
  }
  state.breadcrumb = [root]
  await action_load_folder(state)
}

/** Open the provider's folder picker; on a pick, make it the new hub root. */
async function action_pick_root(state: asset_hub_drive_state): Promise<void> {
  const provider = state.provider
  if (!provider?.pick_asset_hub_root || state._picking) return
  state._picking = true
  let root: cloud_file | null = null
  try {
    root = await provider.pick_asset_hub_root()
  } catch (err) {
    state._picking = false
    fail_action(state, 'Pick root folder', err)
    notify(state)
    return
  }
  state._picking = false
  if (!root) {
    notify(state) // cancelled — keep whatever was on screen
    return
  }
  state.breadcrumb = [root]
  clear_caches(state)
  await action_load_folder(state)
}

async function action_load_folder(state: asset_hub_drive_state): Promise<void> {
  const provider = state.provider
  const folder = state.breadcrumb[state.breadcrumb.length - 1]
  if (!provider || !folder) return
  const seq = ++state._seq
  set_status(state, 'loading')
  notify(state)
  let files: cloud_file[] = []
  try {
    files = await provider.list_folder(folder.id)
  } catch (err) {
    if (seq === state._seq) {
      fail_action(state, `Load folder "${folder.name}"`, err)
      notify(state)
    }
    return
  }
  if (seq !== state._seq) return
  state.files = files
  state.selected_id = files.find((file) => !file.is_folder)?.id ?? null
  state.grid_scroll.offset_y = 0
  state.detail_scroll.offset_y = 0
  prune_caches(state)
  set_status(state, 'ready')
  notify(state)
}

function action_open_folder(state: asset_hub_drive_state, folder: cloud_file): void {
  state.breadcrumb = [...state.breadcrumb, folder]
  void action_load_folder(state)
}

function action_breadcrumb_to(state: asset_hub_drive_state, index: number): void {
  if (index < 0 || index >= state.breadcrumb.length - 1) return
  state.breadcrumb = state.breadcrumb.slice(0, index + 1)
  void action_load_folder(state)
}

/** Re-pull the current directory, dropping every cached preview for it. */
function action_refresh(state: asset_hub_drive_state): void {
  clear_caches(state)
  if (state.breadcrumb.length > 0) void action_load_folder(state)
  else void action_locate_root(state)
}

async function action_sign_out(state: asset_hub_drive_state): Promise<void> {
  const provider = state.provider
  if (!provider) return
  state._seq += 1 // cancel anything in flight
  ui_task_queue_send(state.task_queue, { type: 'clear', source: 'asset_hub' })
  clear_caches(state)
  state.breadcrumb = []
  state.files = []
  state.selected_id = null
  set_status(state, 'disconnected')
  notify(state)
  await provider.sign_out()
}

/** Open the upload picker via the DOM bridge's gesture relay (mobile-safe), or directly. */
function trigger_upload_picker(state: asset_hub_drive_state): void {
  if (state.request_upload_picker) state.request_upload_picker()
  else state.open_upload_picker?.()
}

/** Upload local files into the currently open folder, then refresh the listing. */
function action_upload_files(state: asset_hub_drive_state, files: File[]): void {
  const provider = state.provider
  const folder = state.breadcrumb[state.breadcrumb.length - 1]
  if (!provider?.upload_file || !folder || files.length === 0) return
  for (const file of files) {
    ui_task_queue_send(state.task_queue, {
      type: 'enqueue',
      source: 'asset_hub',
      title: `UPLOAD · ${file.name}`,
      detail: 'Waiting to upload',
      running_detail: 'Uploading…',
      accent: '#5fb878',
      run: async (signal, update) => {
        try {
          const { uploaded, errors } = await upload_local_files(provider, folder.id, [file], update, signal)
          if (errors.length > 0) throw new Error(errors.join(' '))
          if (uploaded.length > 0) await action_load_folder(state)
        } catch (err) {
          reflect_transfer_error(state, err)
          throw err
        }
      },
    })
  }
}

function trigger_download(state: asset_hub_drive_state, file: cloud_file): void {
  const provider = state.provider
  if (!provider) return
  ui_task_queue_send(state.task_queue, {
    type: 'enqueue',
    source: 'asset_hub',
    title: `DOWNLOAD · ${file.name}`,
    detail: 'Waiting to download',
    running_detail: 'Downloading…',
    run: async (signal) => {
      try {
        const url = await provider.get_file_download_url(file, signal)
        if (signal.aborted) {
          URL.revokeObjectURL(url)
          throw new DOMException('Transfer cancelled.', 'AbortError')
        }
        const anchor = document.createElement('a')
        anchor.href = url
        anchor.download = file.name
        anchor.click()
        // Give the browser time to pick up the blob, then release the object URL.
        window.setTimeout(() => URL.revokeObjectURL(url), 30_000)
      } catch (err) {
        if (is_abort_error(err)) throw err
        console.error(`[Asset Hub] Download "${file.name}" failed`, err)
        reflect_transfer_error(state, err)
        throw err
      }
    },
  })
}

function reflect_transfer_error(state: asset_hub_drive_state, err: unknown): void {
  const e = as_cloud_error(err)
  if (e?.kind === 'auth_expired') set_status(state, 'auth_expired', e.message)
  notify(state)
}

function is_abort_error(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

// --- preview caches -------------------------------------------------------------

function request_thumbnail(state: asset_hub_drive_state, file: cloud_file): void {
  const provider = state.provider
  if (!provider || state._thumbnails.has(file.id)) return
  const entry: hub_thumbnail = { status: 'loading', width: 0, height: 0, rgba: null, texture_id: -1 }
  state._thumbnails.set(file.id, entry)
  void provider
    .get_file_content(file)
    .then((blob) => decode_image_blob(blob, THUMBNAIL_MAX_DIM))
    .then((image) => {
      entry.rgba = image.data
      entry.width = image.width
      entry.height = image.height
      entry.status = 'ready'
    })
    .catch((err) => {
      console.error(`[Asset Hub] Thumbnail "${file.name}" failed`, err)
      entry.status = 'failed'
      const e = as_cloud_error(err)
      if (e?.kind === 'auth_expired') set_status(state, 'auth_expired', e.message)
    })
    .finally(() => notify(state))
}

function request_text_preview(state: asset_hub_drive_state, file: cloud_file): void {
  const provider = state.provider
  if (!provider || state._text_previews.has(file.id)) return
  if ((file.size_bytes ?? 0) > TEXT_PREVIEW_MAX_BYTES) {
    state._text_previews.set(file.id, {
      status: 'failed',
      lines: [],
      truncated: false,
      error: `Too large for inline preview (${format_bytes(file.size_bytes ?? 0)}) — download instead.`,
    })
    return
  }
  const entry: hub_text_preview = { status: 'loading', lines: [], truncated: false }
  state._text_previews.set(file.id, entry)
  void provider
    .get_file_content(file)
    .then((blob) => blob.text())
    .then((content) => {
      const raw_lines = content.split(/\r?\n/)
      entry.truncated = raw_lines.length > TEXT_PREVIEW_MAX_LINES
      entry.lines = raw_lines
        .slice(0, TEXT_PREVIEW_MAX_LINES)
        .map((line) => (line.length > TEXT_PREVIEW_MAX_COLS ? `${line.slice(0, TEXT_PREVIEW_MAX_COLS)}…` : line))
      entry.status = 'ready'
    })
    .catch((err) => {
      console.error(`[Asset Hub] Text preview "${file.name}" failed`, err)
      entry.status = 'failed'
      const e = as_cloud_error(err)
      entry.error = e?.message ?? 'Failed to load file content.'
      if (e?.kind === 'auth_expired') set_status(state, 'auth_expired', e.message)
    })
    .finally(() => notify(state))
}

async function decode_image_blob(blob: Blob, max_dim: number): Promise<ImageData> {
  const bitmap = await createImageBitmap(blob)
  const fit = Math.min(1, max_dim / Math.max(bitmap.width, bitmap.height, 1))
  const w = Math.max(1, Math.round(bitmap.width * fit))
  const h = Math.max(1, Math.round(bitmap.height * fit))
  const canvas = new OffscreenCanvas(w, h)
  const ctx = canvas.getContext('2d')
  if (!ctx) {
    bitmap.close()
    throw new Error('2D canvas context unavailable')
  }
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return ctx.getImageData(0, 0, w, h)
}

/** Drop cached previews for files no longer in the current listing. */
function prune_caches(state: asset_hub_drive_state): void {
  const keep = new Set(state.files.map((file) => file.id))
  for (const [id, thumb] of state._thumbnails) {
    if (keep.has(id)) continue
    if (thumb.texture_id >= 0) state._dispose_textures.push(thumb.texture_id)
    state._thumbnails.delete(id)
  }
  for (const id of state._text_previews.keys()) {
    if (!keep.has(id)) state._text_previews.delete(id)
  }
}

function clear_caches(state: asset_hub_drive_state): void {
  for (const thumb of state._thumbnails.values()) {
    if (thumb.texture_id >= 0) state._dispose_textures.push(thumb.texture_id)
  }
  state._thumbnails.clear()
  state._text_previews.clear()
}

/** Upload a decoded thumbnail to the GPU on first use, then drop the RGBA copy. */
function ensure_thumbnail_texture(ui: ui_renderer, thumb: hub_thumbnail): number {
  if (thumb.status !== 'ready') return -1
  if (thumb.texture_id < 0 && thumb.rgba) {
    thumb.texture_id = ui.create_texture(thumb.width, thumb.height)
    ui.update_texture(thumb.texture_id, thumb.rgba)
    thumb.rgba = null
  }
  return thumb.texture_id
}

// --- upload DOM bridge -----------------------------------------------------------

export interface asset_hub_drive_dom_options {
  on_change?: () => void
}

/**
 * Wire a hidden `.glb` / `.zip` file input onto a host element so the panel's
 * Upload button (and any host-added drag/drop target) can hand files to
 * `action_upload_files`. Mirrors `asset_audit_dom_target`'s gesture relay:
 * mobile browsers only honor a file-dialog request inside a trusted pointer
 * event, not one raised from inside a render loop, so the button queues a
 * request and this bridge fulfills it on the next real pointerup.
 */
export function asset_hub_drive_dom_target(target: HTMLElement, state: asset_hub_drive_state, options?: asset_hub_drive_dom_options): () => void {
  state.on_change = options?.on_change ?? state.on_change

  const input = document.createElement('input')
  input.type = 'file'
  input.multiple = true
  const ua = navigator.userAgent
  const is_ios = /iPad|iPhone|iPod/.test(ua) || (/Mac/.test(ua) && navigator.maxTouchPoints > 1)
  // iOS treats unknown extensions in `accept` as "nothing selectable" — skip it there.
  if (!is_ios) input.accept = '.glb,.zip'
  input.style.position = 'fixed'
  input.style.left = '0'
  input.style.top = '0'
  input.style.width = '1px'
  input.style.height = '1px'
  input.style.opacity = '0'
  input.style.pointerEvents = 'none'
  input.tabIndex = -1
  input.setAttribute('aria-hidden', 'true')
  input.addEventListener('change', () => {
    const files = [...(input.files ?? [])].filter((file) => is_uploadable_asset_name(file.name))
    input.value = ''
    if (files.length > 0) void action_upload_files(state, files)
  })
  document.body.appendChild(input)
  state.open_upload_picker = () => input.click()

  let pending = false
  let pointer_held = false
  const PICKER_REQUEST_TTL_MS = 3000
  let requested_at = 0
  const fulfill = (): void => {
    if (!pending || performance.now() - requested_at > PICKER_REQUEST_TTL_MS) {
      pending = false
      return
    }
    pending = false
    input.click()
  }
  state.request_upload_picker = () => {
    pending = true
    requested_at = performance.now()
    if (!pointer_held) fulfill()
  }
  const pointer_down = (): void => {
    pointer_held = true
  }
  const pointer_up = (): void => {
    pointer_held = false
    fulfill()
  }
  const pointer_cancel = (): void => {
    pointer_held = false
    pending = false // a cancelled gesture (e.g. scroll) shouldn't pop the dialog
  }
  target.addEventListener('pointerdown', pointer_down)
  window.addEventListener('pointerup', pointer_up)
  window.addEventListener('pointercancel', pointer_cancel)

  return () => {
    target.removeEventListener('pointerdown', pointer_down)
    window.removeEventListener('pointerup', pointer_up)
    window.removeEventListener('pointercancel', pointer_cancel)
    input.remove()
    state.open_upload_picker = null
    state.request_upload_picker = null
  }
}

// --- panel ----------------------------------------------------------------------

export function asset_hub_drive(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  state: asset_hub_drive_state,
  options?: asset_hub_drive_options,
): asset_hub_drive_event {
  const scale = window.devicePixelRatio || 1
  const font_px = (options?.font_px ?? 12.5) * scale
  const col = (slot: theme_slot) => pack(theme_color(theme, slot))
  const event: asset_hub_drive_event = {}

  // Destroy textures orphaned by navigation / refresh / sign-out.
  for (const texture_id of state._dispose_textures) ui.destroy_texture(texture_id)
  state._dispose_textures.length = 0

  if (!input.mouse_down) state._press_consumed = false

  // A same-tab reload keeps the provider session (see google_drive_provider) —
  // resume straight into the folder lookup instead of asking to connect again.
  if (state.status === 'disconnected' && state.provider?.is_signed_in()) {
    void action_locate_root(state)
  }

  const pad = 10 * scale
  const header_h = 36 * scale
  const has_breadcrumb = state.breadcrumb.length > 0 && (state.status === 'ready' || state.status === 'loading')
  const crumb_h = has_breadcrumb ? 26 * scale : 0

  ui.fill_rect(x, y, w, h, col('panel'))
  draw_header(ui, input, x + pad, y, Math.max(0, w - pad * 2), header_h, state, font_px, scale, col, event)
  if (has_breadcrumb) {
    draw_breadcrumb(ui, input, x + pad, y + header_h, Math.max(0, w - pad * 2), crumb_h, state, scale, col)
  }

  const body = { x: x + pad, y: y + header_h + crumb_h, w: Math.max(0, w - pad * 2), h: Math.max(0, h - header_h - crumb_h - pad) }

  if (state.status !== 'ready') {
    draw_status_message(ui, input, body, state, font_px, scale, col, event)
    return event
  }

  const side_by_side = w >= 620 * scale
  const detail_w = side_by_side ? Math.min((options?.detail_w ?? 292) * scale, Math.max(220 * scale, w * 0.38)) : body.w
  const detail_h = side_by_side ? body.h : Math.min(230 * scale, Math.max(170 * scale, body.h * 0.46))
  const gap = 8 * scale
  const grid_rect = side_by_side
    ? { x: body.x, y: body.y, w: Math.max(0, body.w - detail_w - pad), h: body.h }
    : { x: body.x, y: body.y, w: body.w, h: Math.max(0, body.h - detail_h - gap) }
  const detail_rect = side_by_side
    ? { x: body.x + body.w - detail_w, y: body.y, w: detail_w, h: detail_h }
    : { x: body.x, y: body.y + body.h - detail_h, w: body.w, h: detail_h }

  draw_grid(ui, input, grid_rect, state, font_px, scale, col, options, event)
  draw_details(ui, input, detail_rect, state, font_px, scale, col, event)
  return event
}

// --- header + breadcrumb ---------------------------------------------------------

function draw_header(
  ui: ui_renderer,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  state: asset_hub_drive_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  event: asset_hub_drive_event,
): void {
  const provider = state.provider
  ui.draw_text(x, ui.text_v_center_y(y, h, font_px + 2 * scale), 'Asset Hub', font_px + 2 * scale, col('text'))
  const title_w = ui.text_width('Asset Hub', font_px + 2 * scale)
  const sub = provider ? provider.label : 'cloud storage'
  ui.draw_text(x + title_w + 10 * scale, ui.text_v_center_y(y, h, 10.5 * scale), sub, 10.5 * scale, col('text_dim'), FONT_MONO)

  // Right-aligned actions. Buttons are laid out right → left.
  const button_h = 24 * scale
  const button_y = y + (h - button_h) * 0.5
  let right = x + w
  const place = (label: string): { bx: number; bw: number } => {
    const bw = ui.text_width(label, font_px) + 20 * scale
    right -= bw
    const bx = right
    right -= 8 * scale
    return { bx, bw }
  }

  const signed_in = provider?.is_signed_in() ?? false
  if (signed_in) {
    const sign_out = place('Sign Out')
    if (button(ui, input, sign_out.bx, button_y, sign_out.bw, button_h, 'Sign Out', false, font_px, scale, col) && !state._press_consumed) {
      state._press_consumed = true
      event.signed_out = true
      void action_sign_out(state)
    }
    const refresh = place('Refresh')
    const busy = state.status === 'loading' || state.status === 'locating_root'
    if (button(ui, input, refresh.bx, button_y, refresh.bw, button_h, 'Refresh', false, font_px, scale, col, busy) && !state._press_consumed) {
      state._press_consumed = true
      event.refreshed = true
      action_refresh(state)
    }
    if (provider?.upload_file && state.breadcrumb.length > 0) {
      const label = 'Upload'
      const upload = place(label)
      if (button(ui, input, upload.bx, button_y, upload.bw, button_h, label, false, font_px, scale, col) && !state._press_consumed) {
        state._press_consumed = true
        event.upload_requested = true
        trigger_upload_picker(state)
      }
    }
    if (provider?.pick_asset_hub_root && state.breadcrumb.length > 0) {
      const change = place('Change Folder')
      if (button(ui, input, change.bx, button_y, change.bw, button_h, 'Change Folder', false, font_px, scale, col, state._picking) && !state._press_consumed) {
        state._press_consumed = true
        event.pick_requested = true
        void action_pick_root(state)
      }
    }
  } else if (provider && state.status !== 'authorizing') {
    const label = state.status === 'auth_expired' ? 'Sign In Again' : 'Connect Google Drive'
    const connect = place(label)
    if (button(ui, input, connect.bx, button_y, connect.bw, button_h, label, true, font_px, scale, col) && !state._press_consumed) {
      state._press_consumed = true
      event.connect_requested = true
      void action_connect(state)
    }
  }

}

function draw_breadcrumb(
  ui: ui_renderer,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  state: asset_hub_drive_state,
  scale: number,
  col: (slot: theme_slot) => number,
): void {
  const font = 11 * scale
  const sep = ' / '
  const sep_w = ui.text_width(sep, font, FONT_MONO)
  let cx = x
  ui.push_clip(x, y, w, h)
  for (let i = 0; i < state.breadcrumb.length; i += 1) {
    const segment = state.breadcrumb[i]!
    const last = i === state.breadcrumb.length - 1
    const seg_w = ui.text_width(segment.name, font, FONT_MONO)
    const hover = !last && point_in(input, cx - 3 * scale, y, seg_w + 6 * scale, h)
    if (hover) ui.fill_round_rect(cx - 3 * scale, y + 3 * scale, seg_w + 6 * scale, h - 6 * scale, 3 * scale, col('hover'))
    ui.draw_text(cx, ui.text_v_center_y(y, h, font), segment.name, font, last ? col('text') : col('accent'), FONT_MONO)
    if (hover && input.mouse_pressed && !state._press_consumed) {
      state._press_consumed = true
      action_breadcrumb_to(state, i)
    }
    cx += seg_w
    if (!last) {
      ui.draw_text(cx, ui.text_v_center_y(y, h, font), sep, font, col('text_dim'), FONT_MONO)
      cx += sep_w
    }
  }
  ui.pop_clip()
}

// --- status message -----------------------------------------------------------

interface status_view {
  title: string
  lines: string[]
  action_label?: string
  action?: (state: asset_hub_drive_state, event: asset_hub_drive_event) => void
}

function status_view_of(state: asset_hub_drive_state): status_view {
  const root = state.root_folder_name
  switch (state.status) {
    case 'config_error':
      return {
        title: 'Cloud storage is not configured',
        lines: [
          state.status_detail || 'Set VITE_GOOGLE_CLIENT_ID in your build environment to enable',
          'the Google Drive viewer. See the README for setup steps.',
        ],
      }
    case 'disconnected':
      return {
        title: 'Not connected',
        lines: [
          `Connect your Google Drive to browse the ${root}/ folder in its root.`,
          'The viewer is read-only and runs entirely in this browser.',
        ],
        action_label: 'Connect Google Drive',
        action: (s, e) => {
          e.connect_requested = true
          void action_connect(s)
        },
      }
    case 'authorizing':
      return { title: 'Waiting for Google authorization…', lines: ['Complete the sign-in in the Google popup window.'] }
    case 'auth_error':
      return {
        title: 'Google sign-in failed',
        lines: [state.status_detail || 'The authorization was cancelled or rejected.'],
        action_label: 'Try Again',
        action: (s, e) => {
          e.connect_requested = true
          void action_connect(s)
        },
      }
    case 'locating_root':
      return { title: `Looking for the ${root} folder…`, lines: [] }
    case 'root_needed':
      return {
        title: `Choose your ${root} folder`,
        lines: [
          'Pick the Google Drive folder that holds your assets.',
          'The app can only ever read the folder you select — nothing else in your Drive.',
        ],
        action_label: 'Choose Folder',
        action: (s, e) => {
          e.pick_requested = true
          void action_pick_root(s)
        },
      }
    case 'root_missing':
      return {
        title: `No ${root} folder found in your Google Drive root.`,
        lines: [`Please create a folder named ${root} in your Drive root`, 'and put assets inside it.'],
        action_label: 'Check Again',
        action: (s) => void action_locate_root(s),
      }
    case 'loading':
      return { title: 'Loading files…', lines: [] }
    case 'load_error':
      return {
        title: 'Failed to load files',
        lines: [state.status_detail || 'The request to the storage provider failed.'],
        action_label: 'Retry',
        action: (s, e) => {
          e.refreshed = true
          action_refresh(s)
        },
      }
    case 'auth_expired':
      return {
        title: 'Google Drive session expired',
        lines: [state.status_detail || 'Your access token expired or was revoked.'],
        action_label: 'Sign In Again',
        action: (s, e) => {
          e.connect_requested = true
          void action_connect(s)
        },
      }
    default:
      return { title: '', lines: [] }
  }
}

function draw_status_message(
  ui: ui_renderer,
  input: ui_input_snapshot,
  rect: { x: number; y: number; w: number; h: number },
  state: asset_hub_drive_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  event: asset_hub_drive_event,
): void {
  ui.fill_rect(rect.x, rect.y, rect.w, rect.h, col('panel_alt'))
  ui.stroke_rect(rect.x, rect.y, rect.w, rect.h, 1, col('border'))
  const view = status_view_of(state)
  const title_font = font_px + 1.5 * scale
  const line_font = 11 * scale
  const line_h = 18 * scale
  const button_h = view.action_label ? 28 * scale : 0
  const total_h = 22 * scale + view.lines.length * line_h + (button_h ? button_h + 16 * scale : 0)
  let cy = rect.y + Math.max(12 * scale, (rect.h - total_h) * 0.5)

  ui.push_clip(rect.x, rect.y, rect.w, rect.h)
  const title_w = ui.text_width(view.title, title_font)
  ui.draw_text(rect.x + (rect.w - title_w) * 0.5, cy, view.title, title_font, col('text'))
  cy += 26 * scale
  for (const line of view.lines) {
    const lw = ui.text_width(line, line_font)
    ui.draw_text(rect.x + (rect.w - lw) * 0.5, cy, line, line_font, col('text_dim'))
    cy += line_h
  }
  if (view.action_label && view.action) {
    cy += 8 * scale
    const bw = Math.max(120 * scale, ui.text_width(view.action_label, font_px) + 28 * scale)
    const bx = rect.x + (rect.w - bw) * 0.5
    if (button(ui, input, bx, cy, bw, button_h, view.action_label, true, font_px, scale, col) && !state._press_consumed) {
      state._press_consumed = true
      view.action(state, event)
    }
  }
  ui.pop_clip()
}

// --- file grid -------------------------------------------------------------------

function draw_grid(
  ui: ui_renderer,
  input: ui_input_snapshot,
  rect: { x: number; y: number; w: number; h: number },
  state: asset_hub_drive_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  options: asset_hub_drive_options | undefined,
  event: asset_hub_drive_event,
): void {
  const pad = 8 * scale
  const card_w = (options?.card_w ?? 136) * scale
  const card_h = (options?.card_h ?? 150) * scale
  const gap = 10 * scale
  const files = state.files
  const cols = Math.max(1, Math.floor((rect.w - pad * 2 + gap) / (card_w + gap)))
  const rows = Math.ceil(files.length / cols)
  const content_h = pad * 2 + Math.max(0, rows * (card_h + gap) - gap)
  const max_off = Math.max(0, content_h - rect.h)
  const over = point_in(input, rect.x, rect.y, rect.w, rect.h)

  if (over && input.wheel_y) state.grid_scroll.offset_y = clamp(state.grid_scroll.offset_y - input.wheel_y * 28 * scale, 0, max_off)
  state.grid_scroll.offset_y = clamp(state.grid_scroll.offset_y, 0, max_off)

  ui.fill_rect(rect.x, rect.y, rect.w, rect.h, col('panel'))
  ui.stroke_rect(rect.x, rect.y, rect.w, rect.h, 1, col('border'))
  ui.push_clip(rect.x, rect.y, rect.w, rect.h)

  if (files.length === 0) {
    const message = 'This folder is empty.'
    const mw = ui.text_width(message, font_px)
    ui.draw_text(rect.x + (rect.w - mw) * 0.5, rect.y + rect.h * 0.42, message, font_px, col('text_dim'))
  }

  for (let i = 0; i < files.length; i += 1) {
    const file = files[i]!
    const cx = i % cols
    const cy = Math.floor(i / cols)
    const ax = rect.x + pad + cx * (card_w + gap)
    const ay = rect.y + pad + cy * (card_h + gap) - state.grid_scroll.offset_y
    if (ay + card_h < rect.y || ay > rect.y + rect.h) continue
    draw_file_card(ui, input, ax, ay, card_w, card_h, file, state, font_px, scale, col, event)
  }

  ui.pop_clip()
  draw_scrollbar(ui, rect, state.grid_scroll.offset_y, content_h, scale, col)
}

function draw_file_card(
  ui: ui_renderer,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  file: cloud_file,
  state: asset_hub_drive_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  event: asset_hub_drive_event,
): void {
  const kind = cloud_file_kind_of(file)
  const selected = state.selected_id === file.id
  const hover = point_in(input, x, y, w, h)
  const bg = selected ? col('selected') : hover ? col('hover') : col('panel_alt')

  ui.fill_round_rect(x, y, w, h, 4 * scale, bg)
  ui.stroke_round_rect(x, y, w, h, 4 * scale, 1, selected ? col('scene_outline') : col('border'))

  const thumb_x = x + 8 * scale
  const thumb_y = y + 8 * scale
  const thumb_w = w - 16 * scale
  const thumb_h = 84 * scale
  draw_preview_block(ui, file, kind, state, thumb_x, thumb_y, thumb_w, thumb_h, scale, col)

  const label_y = thumb_y + thumb_h + 7 * scale
  ui.push_clip(x + 8 * scale, label_y, w - 16 * scale, 18 * scale)
  ui.draw_text(x + 8 * scale, label_y, file.name, font_px, col('text'))
  ui.pop_clip()

  const meta = file.is_folder
    ? 'Folder'
    : `${kind.toUpperCase()}${file.size_bytes !== undefined ? ` · ${format_bytes(file.size_bytes)}` : ''}`
  ui.push_clip(x + 8 * scale, label_y + 19 * scale, w - 16 * scale, 15 * scale)
  ui.draw_text(x + 8 * scale, label_y + 19 * scale, meta, 10.5 * scale, col('text_dim'), FONT_MONO)
  ui.pop_clip()

  if (hover && input.mouse_pressed && !state._press_consumed) {
    state._press_consumed = true
    if (file.is_folder) {
      event.folder_opened = file
      action_open_folder(state, file)
    } else {
      state.selected_id = file.id
      state.detail_scroll.offset_y = 0
      event.selected = file
    }
  }
}

/** Thumbnail area of a card / the detail preview: image texture, folder glyph, or a kind badge. */
function draw_preview_block(
  ui: ui_renderer,
  file: cloud_file,
  kind: cloud_file_kind,
  state: asset_hub_drive_state,
  x: number,
  y: number,
  w: number,
  h: number,
  scale: number,
  col: (slot: theme_slot) => number,
): void {
  ui.fill_round_rect(x, y, w, h, 4 * scale, col('track'))
  if (kind === 'folder') {
    const gw = Math.min(w * 0.42, h * 0.62)
    const gx = x + (w - gw) * 0.5
    const gy = y + (h - gw * 0.78) * 0.5
    const accent = kind_color(kind)
    ui.fill_round_rect(gx, gy, gw * 0.44, gw * 0.16, 2 * scale, accent)
    ui.fill_round_rect(gx, gy + gw * 0.1, gw, gw * 0.68, 3 * scale, with_alpha(accent, 0.82))
    return
  }
  if (kind === 'image') {
    request_thumbnail(state, file)
    const thumb = state._thumbnails.get(file.id)
    const texture_id = thumb ? ensure_thumbnail_texture(ui, thumb) : -1
    if (thumb && texture_id >= 0) {
      // Fit the decoded image inside the block, preserving aspect.
      const fit = Math.min(w / thumb.width, h / thumb.height)
      const dw = thumb.width * fit
      const dh = thumb.height * fit
      ui.push_clip(x, y, w, h)
      ui.draw_texture_round_rect(texture_id, x + (w - dw) * 0.5, y + (h - dh) * 0.5, dw, dh, 3 * scale)
      ui.pop_clip()
      ui.stroke_round_rect(x, y, w, h, 4 * scale, 1, with_alpha(col('border_strong'), 0.72))
      return
    }
    const hint = !thumb || thumb.status === 'loading' ? 'loading…' : 'preview failed'
    const hint_w = ui.text_width(hint, 10 * scale, FONT_MONO)
    ui.draw_text(x + (w - hint_w) * 0.5, y + h * 0.5 - 5 * scale, hint, 10 * scale, col('text_dim'), FONT_MONO)
    return
  }
  // Non-image files: a tinted badge with the kind / extension.
  const accent = kind_color(kind)
  const badge = kind_badge_label(file, kind)
  const badge_font = 12 * scale
  const bw = ui.text_width(badge, badge_font, FONT_MONO)
  ui.fill_round_rect(x + 8 * scale, y + h - 5 * scale, Math.max(0, w - 16 * scale), 2 * scale, 1 * scale, with_alpha(accent, 0.7))
  ui.draw_text(x + (w - bw) * 0.5, y + (h - badge_font) * 0.5, badge, badge_font, with_alpha(accent, 0.95), FONT_MONO)
}

// --- details ---------------------------------------------------------------------

function draw_details(
  ui: ui_renderer,
  input: ui_input_snapshot,
  rect: { x: number; y: number; w: number; h: number },
  state: asset_hub_drive_state,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  event: asset_hub_drive_event,
): void {
  const pad = 10 * scale
  const title_h = 30 * scale
  const footer_h = 52 * scale
  const list_y = rect.y + title_h
  const list_h = Math.max(0, rect.h - title_h - footer_h)
  const file = state.files.find((f) => f.id === state.selected_id) ?? null
  const kind = file ? cloud_file_kind_of(file) : 'other'

  ui.fill_rect(rect.x, rect.y, rect.w, rect.h, col('panel_alt'))
  ui.stroke_rect(rect.x, rect.y, rect.w, rect.h, 1, col('border'))
  ui.draw_text(rect.x + pad, ui.text_v_center_y(rect.y, title_h, font_px), 'Preview', font_px, col('text'))
  if (file) {
    const tag = kind.toUpperCase()
    const tag_w = ui.text_width(tag, 10.5 * scale, FONT_MONO)
    ui.draw_text(rect.x + rect.w - pad - tag_w, ui.text_v_center_y(rect.y, title_h, 10.5 * scale), tag, 10.5 * scale, kind_color(kind), FONT_MONO)
  }

  // Kick preview loads for the selected file before measuring content.
  if (file && kind === 'text') request_text_preview(state, file)
  if (file && kind === 'image') request_thumbnail(state, file)

  const px = rect.x + pad
  const pw = rect.w - pad * 2
  const mono_line_h = 15 * scale
  const rows = file ? detail_rows(file, kind) : []
  let preview_h = 90 * scale
  const thumb = file ? state._thumbnails.get(file.id) : undefined
  const text = file ? state._text_previews.get(file.id) : undefined
  if (file && kind === 'image') {
    preview_h = thumb && thumb.status === 'ready' && thumb.width > 0
      ? Math.min(170 * scale, (pw * thumb.height) / thumb.width)
      : 120 * scale
  } else if (file && kind === 'text') {
    preview_h = text && text.status === 'ready'
      ? Math.min(4000 * scale, (text.lines.length + (text.truncated ? 1 : 0)) * mono_line_h + 12 * scale)
      : 40 * scale
  }
  const content_h = file ? preview_h + 36 * scale + rows.length * 21 * scale + pad * 2 : 40 * scale
  const max_off = Math.max(0, content_h - list_h)
  const over_list = point_in(input, rect.x, list_y, rect.w, list_h)
  if (over_list && input.wheel_y) state.detail_scroll.offset_y = clamp(state.detail_scroll.offset_y - input.wheel_y * 26 * scale, 0, max_off)
  state.detail_scroll.offset_y = clamp(state.detail_scroll.offset_y, 0, max_off)

  ui.push_clip(rect.x, list_y, rect.w, list_h)
  if (!file) {
    ui.draw_text(px, list_y + pad, 'Select a file to preview it', font_px, col('text_dim'))
  } else {
    let cy = list_y + pad - state.detail_scroll.offset_y

    if (kind === 'image' && thumb && ensure_thumbnail_texture(ui, thumb) >= 0) {
      const fit = Math.min(pw / thumb.width, preview_h / thumb.height)
      const dw = thumb.width * fit
      const dh = thumb.height * fit
      ui.fill_round_rect(px, cy, pw, preview_h, 4 * scale, col('track'))
      ui.push_clip(px, cy, pw, preview_h)
      ui.draw_texture_round_rect(thumb.texture_id, px + (pw - dw) * 0.5, cy + (preview_h - dh) * 0.5, dw, dh, 3 * scale)
      ui.pop_clip()
      ui.stroke_round_rect(px, cy, pw, preview_h, 4 * scale, 1, with_alpha(col('border_strong'), 0.72))
    } else if (kind === 'text') {
      if (!text || text.status === 'loading') {
        ui.draw_text(px, cy, 'Loading preview…', 10.5 * scale, col('text_dim'), FONT_MONO)
      } else if (text.status === 'failed') {
        ui.draw_text(px, cy, text.error ?? 'Preview failed.', 10.5 * scale, pack('#d9534f'), FONT_MONO)
      } else {
        ui.fill_round_rect(px, cy, pw, preview_h, 4 * scale, col('track'))
        ui.push_clip(px + 6 * scale, cy + 6 * scale, pw - 12 * scale, preview_h - 12 * scale)
        let ly = cy + 6 * scale
        for (const line of text.lines) {
          ui.draw_text(px + 6 * scale, ly, line, 10.5 * scale, col('text'), FONT_MONO)
          ly += mono_line_h
        }
        if (text.truncated) ui.draw_text(px + 6 * scale, ly, `… truncated at ${TEXT_PREVIEW_MAX_LINES} lines`, 10.5 * scale, col('text_dim'), FONT_MONO)
        ui.pop_clip()
      }
    } else {
      draw_preview_block(ui, file, kind, state, px, cy, pw, preview_h, scale, col)
      if (kind !== 'image') {
        const hint = 'No inline preview — download or open in Drive.'
        const hint_w = ui.text_width(hint, 10 * scale, FONT_MONO)
        ui.draw_text(px + Math.max(0, (pw - hint_w) * 0.5), cy + preview_h - 20 * scale, hint, 10 * scale, col('text_dim'), FONT_MONO)
      }
    }
    cy += preview_h + 10 * scale

    ui.push_clip(px, cy, pw, 22 * scale)
    ui.draw_text(px, cy, file.name, font_px + 1 * scale, col('text'))
    ui.pop_clip()
    cy += 26 * scale

    for (const row of rows) {
      draw_detail_row(ui, px, cy, pw, row.label, row.value, scale, col)
      cy += 21 * scale
    }
  }
  ui.pop_clip()
  draw_scrollbar(ui, { x: rect.x, y: list_y, w: rect.w, h: list_h }, state.detail_scroll.offset_y, content_h, scale, col)

  const footer_y = rect.y + rect.h - footer_h
  ui.fill_rect(rect.x, footer_y, rect.w, footer_h, col('panel'))
  ui.stroke_rect(rect.x, footer_y, rect.w, 1, 1, col('border'))
  const download_w = Math.min(118 * scale, Math.max(86 * scale, (rect.w - pad * 3) * 0.5))
  const open_w = Math.min(112 * scale, Math.max(76 * scale, rect.w - pad * 3 - download_w))
  const download_pressed = button(ui, input, rect.x + pad, footer_y + 13 * scale, download_w, 28 * scale, 'Download', false, font_px, scale, col, !file)
  const open_pressed = button(ui, input, rect.x + pad * 2 + download_w, footer_y + 13 * scale, open_w, 28 * scale, 'Open', false, font_px, scale, col, !file?.web_view_url)
  if (file && download_pressed && !state._press_consumed) {
    state._press_consumed = true
    event.download_requested = file
    trigger_download(state, file)
  }
  if (file?.web_view_url && open_pressed && !state._press_consumed) {
    state._press_consumed = true
    event.open_requested = file
    window.open(file.web_view_url, '_blank', 'noopener')
  }
}

function detail_rows(file: cloud_file, kind: cloud_file_kind): { label: string; value: string }[] {
  return [
    { label: 'KIND', value: kind },
    { label: 'MIME', value: file.mime_type },
    { label: 'SIZE', value: file.size_bytes !== undefined ? format_bytes(file.size_bytes) : '—' },
    { label: 'MODIFIED', value: file.modified_time ? format_time(file.modified_time) : '—' },
  ]
}

function draw_detail_row(
  ui: ui_renderer,
  x: number,
  y: number,
  w: number,
  label: string,
  value: string,
  scale: number,
  col: (slot: theme_slot) => number,
): void {
  const label_w = Math.min(78 * scale, w * 0.34)
  ui.draw_text(x, y, label, 10.5 * scale, col('text_dim'), FONT_MONO)
  ui.push_clip(x + label_w, y, Math.max(0, w - label_w), 16 * scale)
  ui.draw_text(x + label_w, y, value, 10.5 * scale, col('text'))
  ui.pop_clip()
}

// --- small shared pieces -----------------------------------------------------------

function kind_color(kind: cloud_file_kind): number {
  switch (kind) {
    case 'folder': return pack('#d8a24a')
    case 'image': return pack('#5fb878')
    case 'text': return pack('#4c8bf5')
    case 'model': return pack('#8f72d8')
    case 'audio': return pack('#49a6a6')
    case 'video': return pack('#e0698b')
    default: return pack('#8f96a3')
  }
}

function kind_badge_label(file: cloud_file, kind: cloud_file_kind): string {
  const dot = file.name.lastIndexOf('.')
  const ext = dot >= 0 ? file.name.slice(dot + 1).toUpperCase() : ''
  if (ext && ext.length <= 6) return `.${ext}`
  return kind.toUpperCase()
}

function button(
  ui: ui_renderer,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  label: string,
  active: boolean,
  font_px: number,
  scale: number,
  col: (slot: theme_slot) => number,
  disabled = false,
): boolean {
  const hover = !disabled && point_in(input, x, y, w, h)
  const bg = disabled ? col('ghost') : active ? col('active') : hover ? col('hover') : col('selected')
  ui.fill_round_rect(x, y, w, h, 3 * scale, bg)
  ui.stroke_round_rect(x, y, w, h, 3 * scale, 1, active ? col('accent') : col('border_strong'))
  const text_color = disabled ? col('text_dim') : col('text')
  const tw = ui.text_width(label, font_px)
  ui.push_clip(x + 3 * scale, y, Math.max(0, w - 6 * scale), h)
  ui.draw_text(x + Math.max(3 * scale, (w - tw) * 0.5), ui.text_v_center_y(y, h, font_px), label, font_px, text_color)
  ui.pop_clip()
  return hover && input.mouse_pressed
}

function draw_scrollbar(
  ui: ui_renderer,
  rect: { x: number; y: number; w: number; h: number },
  offset_y: number,
  content_h: number,
  scale: number,
  col: (slot: theme_slot) => number,
): void {
  if (content_h <= rect.h) return
  const scrollbar_w = 6 * scale
  const max_off = Math.max(1, content_h - rect.h)
  const thumb_h = Math.max(20 * scale, rect.h * (rect.h / content_h))
  const thumb_y = rect.y + (offset_y / max_off) * Math.max(1, rect.h - thumb_h)
  ui.fill_rect(rect.x + rect.w - scrollbar_w, rect.y, scrollbar_w, rect.h, col('track'))
  ui.fill_round_rect(rect.x + rect.w - scrollbar_w + 1, thumb_y, scrollbar_w - 2, thumb_h, 3 * scale, col('border_strong'))
}

function format_bytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function format_time(iso: string): string {
  const time = new Date(iso)
  if (Number.isNaN(time.getTime())) return iso
  const p = (v: number) => `${v}`.padStart(2, '0')
  return `${time.getFullYear()}-${p(time.getMonth() + 1)}-${p(time.getDate())} ${p(time.getHours())}:${p(time.getMinutes())}`
}

function point_in(input: ui_input_snapshot, x: number, y: number, w: number, h: number): boolean {
  return input.mouse_x >= x && input.mouse_y >= y && input.mouse_x < x + w && input.mouse_y < y + h
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

function pack(hex: string): number {
  const raw = hex.trim().replace('#', '')
  const p = (s: number) => Number.parseInt(raw.slice(s, s + 2), 16)
  if (raw.length === 6) return (((255 << 24) | (p(4) << 16) | (p(2) << 8) | p(0)) >>> 0)
  if (raw.length === 8) return (((p(6) << 24) | (p(4) << 16) | (p(2) << 8) | p(0)) >>> 0)
  return 0xffffffff
}

function with_alpha(color: number, alpha: number): number {
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)))
  return ((color & 0x00ffffff) | (a << 24)) >>> 0
}
