// Generic desktop task queue. Any subsystem can post messages to this state;
// the host renders it once above the window workspace. Managed tasks run in
// sequence and receive an AbortSignal, while externally-managed tasks can be
// updated/completed through the same message protocol.

import { pack_color, theme_color } from './ui_theme'
import type { theme_definition, theme_slot } from './ui_types'
import { FONT_MONO, ui_renderer, type ui_rect } from './ui_renderer'
import type { ui_input_snapshot } from './ui_widgets'

export type ui_task_queue_status = 'queued' | 'running' | 'failed'
export type ui_task_queue_run = (signal: AbortSignal, update: (detail: string) => void) => Promise<void>

export interface ui_task_queue_task {
  id: number
  title: string
  detail: string
  status: ui_task_queue_status
  /** Optional producer id used for scoped clearing (for example `asset_hub`). */
  source?: string
  /** Optional #RRGGBB/#RRGGBBAA accent; defaults to the active theme accent. */
  accent?: string
  _running_detail: string
  _controller: AbortController
  _run: ui_task_queue_run | null
  _on_cancel: (() => void) | null
}

export interface ui_task_queue_state {
  tasks: ui_task_queue_task[]
  _next_id: number
  _running_id: number | null
  _on_change: (() => void) | null
}

export type ui_task_queue_message =
  | {
      type: 'enqueue'
      title: string
      detail?: string
      running_detail?: string
      accent?: string
      source?: string
      /** When present, the queue runs this task sequentially and removes it on success. */
      run?: ui_task_queue_run
      /** Called after the task's AbortController is aborted by cancel/clear. */
      on_cancel?: () => void
    }
  | { type: 'update'; id: number; title?: string; detail?: string; status?: ui_task_queue_status; accent?: string }
  | { type: 'complete'; id: number }
  | { type: 'fail'; id: number; error: unknown }
  | { type: 'cancel'; id: number }
  | { type: 'clear'; source?: string }

export interface ui_task_queue_render_options {
  title?: string
  close_label?: string
  max_visible_rows?: number
}

export function create_ui_task_queue_state(on_change?: () => void): ui_task_queue_state {
  return { tasks: [], _next_id: 1, _running_id: null, _on_change: on_change ?? null }
}

/**
 * Send one message to the queue. `enqueue` returns its new task id; every other
 * message returns null. Omitting `run` creates an externally-managed running
 * row that its owner can later update, complete, fail, or cancel by id.
 */
export function ui_task_queue_send(queue: ui_task_queue_state, message: Extract<ui_task_queue_message, { type: 'enqueue' }>): number
export function ui_task_queue_send(queue: ui_task_queue_state, message: Exclude<ui_task_queue_message, { type: 'enqueue' }>): null
export function ui_task_queue_send(queue: ui_task_queue_state, message: ui_task_queue_message): number | null {
  switch (message.type) {
    case 'enqueue': {
      const id = queue._next_id++
      const managed = !!message.run
      queue.tasks.push({
        id,
        title: message.title,
        detail: message.detail ?? (managed ? 'Waiting…' : 'Running…'),
        status: managed ? 'queued' : 'running',
        accent: message.accent,
        source: message.source,
        _running_detail: message.running_detail ?? 'Running…',
        _controller: new AbortController(),
        _run: message.run ?? null,
        _on_cancel: message.on_cancel ?? null,
      })
      notify(queue)
      void pump(queue)
      return id
    }
    case 'update': {
      const task = queue.tasks.find((candidate) => candidate.id === message.id)
      if (!task) return null
      if (message.title !== undefined) task.title = message.title
      if (message.detail !== undefined) task.detail = message.detail
      if (message.status !== undefined) task.status = message.status
      if (message.accent !== undefined) task.accent = message.accent
      notify(queue)
      if (task.status === 'queued') void pump(queue)
      return null
    }
    case 'complete':
      remove_task(queue, message.id)
      notify(queue)
      return null
    case 'fail': {
      const task = queue.tasks.find((candidate) => candidate.id === message.id)
      if (!task) return null
      task.status = 'failed'
      task.detail = message.error instanceof Error ? message.error.message : `${message.error || 'Task failed.'}`
      remove_task(queue, task.id)
      queue.tasks.push(task)
      notify(queue)
      return null
    }
    case 'cancel':
      cancel_task(queue, message.id)
      return null
    case 'clear':
      for (const task of [...queue.tasks]) {
        if (message.source === undefined || task.source === message.source) cancel_task(queue, task.id, false, false)
      }
      notify(queue)
      void pump(queue)
      return null
  }
}

async function pump(queue: ui_task_queue_state): Promise<void> {
  if (queue._running_id !== null) return
  const task = queue.tasks.find((candidate) => candidate.status === 'queued' && candidate._run)
  if (!task || !task._run) return

  queue._running_id = task.id
  task.status = 'running'
  task.detail = task._running_detail
  notify(queue)
  try {
    await task._run(task._controller.signal, (detail) => {
      if (!task._controller.signal.aborted && queue.tasks.includes(task)) {
        ui_task_queue_send(queue, { type: 'update', id: task.id, detail })
      }
    })
    ui_task_queue_send(queue, { type: 'complete', id: task.id })
  } catch (err) {
    if (is_abort_error(err) || task._controller.signal.aborted) remove_task(queue, task.id)
    else ui_task_queue_send(queue, { type: 'fail', id: task.id, error: err })
  } finally {
    if (queue._running_id === task.id) queue._running_id = null
    notify(queue)
    void pump(queue)
  }
}

function cancel_task(queue: ui_task_queue_state, id: number, notify_after = true, pump_after = true): void {
  const task = queue.tasks.find((candidate) => candidate.id === id)
  if (!task) return
  task._controller.abort()
  try {
    task._on_cancel?.()
  } catch (err) {
    console.error('[Task Queue] cancel handler failed', err)
  }
  remove_task(queue, id)
  if (notify_after) notify(queue)
  if (pump_after && queue._running_id !== id) void pump(queue)
}

function remove_task(queue: ui_task_queue_state, id: number): void {
  const index = queue.tasks.findIndex((task) => task.id === id)
  if (index >= 0) queue.tasks.splice(index, 1)
}

function notify(queue: ui_task_queue_state): void {
  queue._on_change?.()
}

function is_abort_error(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError'
}

const HEADER_H = 34
const ROW_H = 58
const DEFAULT_MAX_VISIBLE_ROWS = 5

export function ui_task_queue_bounds(
  queue: ui_task_queue_state,
  safe_x: number,
  safe_y: number,
  safe_w: number,
  safe_h: number,
  scale: number,
  options?: ui_task_queue_render_options,
): ui_rect | null {
  if (queue.tasks.length === 0) return null
  const margin = 10 * scale
  const width = Math.max(0, Math.min(380 * scale, safe_w - margin * 2))
  const available_rows = Math.max(1, Math.floor((safe_h - margin * 2 - HEADER_H * scale) / (ROW_H * scale)))
  const visible_rows = Math.min(queue.tasks.length, options?.max_visible_rows ?? DEFAULT_MAX_VISIBLE_ROWS, available_rows)
  const height = (HEADER_H + visible_rows * ROW_H) * scale
  return { x: safe_x + safe_w - width - margin, y: safe_y + safe_h - height - margin, w: width, h: height }
}

export function ui_task_queue_blocks_point(queue: ui_task_queue_state, point_x: number, point_y: number, bounds: ui_rect | null): boolean {
  return !!bounds && queue.tasks.length > 0 && point_x >= bounds.x && point_y >= bounds.y && point_x < bounds.x + bounds.w && point_y < bounds.y + bounds.h
}

export function ui_task_queue_render(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  queue: ui_task_queue_state,
  bounds: ui_rect | null,
  scale: number,
  options?: ui_task_queue_render_options,
): void {
  if (!bounds || queue.tasks.length === 0) return
  const col = (slot: theme_slot) => pack_color(theme_color(theme, slot))
  const header_h = HEADER_H * scale
  const row_h = ROW_H * scale
  const pad = 10 * scale
  const close_w = 48 * scale

  ui.fill_round_rect(bounds.x, bounds.y, bounds.w, bounds.h, 7 * scale, with_alpha(col('panel_alt'), 0.96))
  ui.stroke_round_rect(bounds.x, bounds.y, bounds.w, bounds.h, 7 * scale, 1, col('border_strong'))
  ui.draw_text(bounds.x + pad, ui.text_v_center_y(bounds.y, header_h, 12 * scale), options?.title ?? 'Tasks', 12 * scale, col('text'))
  const count = `${queue.tasks.length}`
  ui.draw_text(bounds.x + bounds.w - pad - ui.text_width(count, 10.5 * scale, FONT_MONO), ui.text_v_center_y(bounds.y, header_h, 10.5 * scale), count, 10.5 * scale, col('text_dim'), FONT_MONO)
  ui.fill_rect(bounds.x, bounds.y + header_h - 1, bounds.w, 1, col('border'))

  const visible_rows = Math.floor((bounds.h - header_h) / row_h)
  for (let i = 0; i < Math.min(visible_rows, queue.tasks.length); i += 1) {
    const task = queue.tasks[i]!
    const row_y = bounds.y + header_h + i * row_h
    const close_x = bounds.x + bounds.w - pad - close_w
    const close_y = row_y + (row_h - 24 * scale) * 0.5
    const close_h = 24 * scale
    const close_hover = point_in(input, close_x, close_y, close_w, close_h)
    const accent = task.status === 'failed' ? pack_color('#d9534f') : task.accent ? pack_color(task.accent) : col('accent')

    if (i > 0) ui.fill_rect(bounds.x + pad, row_y, bounds.w - pad * 2, 1, col('border'))
    ui.fill_round_rect(bounds.x + pad, row_y + 10 * scale, 4 * scale, row_h - 20 * scale, 2 * scale, accent)
    const text_x = bounds.x + pad + 12 * scale
    const text_w = Math.max(0, close_x - text_x - 8 * scale)
    ui.push_clip(text_x, row_y, text_w, row_h)
    ui.draw_text(text_x, row_y + 8 * scale, task.title, 10.5 * scale, col('text'), FONT_MONO)
    ui.draw_text(text_x, row_y + 31 * scale, task.detail, 10 * scale, task.status === 'failed' ? accent : col('text_dim'), FONT_MONO)
    ui.pop_clip()

    ui.fill_round_rect(close_x, close_y, close_w, close_h, 3 * scale, close_hover ? col('hover') : col('selected'))
    ui.stroke_round_rect(close_x, close_y, close_w, close_h, 3 * scale, 1, col('border_strong'))
    const close_label = options?.close_label ?? 'Close'
    const close_font = 10 * scale
    ui.draw_text(close_x + (close_w - ui.text_width(close_label, close_font)) * 0.5, ui.text_v_center_y(close_y, close_h, close_font), close_label, close_font, col('text'))
    if (close_hover && input.mouse_pressed) ui_task_queue_send(queue, { type: 'cancel', id: task.id })

    if (task.status === 'running') {
      const track_x = text_x
      const track_y = row_y + row_h - 7 * scale
      const track_w = Math.max(24 * scale, text_w)
      const segment_w = Math.max(28 * scale, track_w * 0.28)
      const phase = (performance.now() * 0.00055) % 1
      ui.fill_round_rect(track_x, track_y, track_w, 2 * scale, 1 * scale, col('track'))
      ui.push_clip(track_x, track_y, track_w, 2 * scale)
      ui.fill_round_rect(track_x - segment_w + phase * (track_w + segment_w), track_y, segment_w, 2 * scale, 1 * scale, accent)
      ui.pop_clip()
      ui.request_render()
    }
  }
}

function point_in(input: ui_input_snapshot, x: number, y: number, w: number, h: number): boolean {
  return input.mouse_x >= x && input.mouse_y >= y && input.mouse_x < x + w && input.mouse_y < y + h
}

function with_alpha(color: number, alpha: number): number {
  const a = Math.max(0, Math.min(255, Math.round(alpha * 255)))
  return ((color & 0x00ffffff) | (a << 24)) >>> 0
}
