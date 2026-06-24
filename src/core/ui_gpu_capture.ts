export type ui_metal_gpu_capture_scope = 'frame'

export interface ui_metal_gpu_capture_options {
  /** Directory resolved by the native host. Defaults to the host current folder. */
  directory?: string
  /** Suggested capture name; native hosts may adjust for platform conventions. */
  filename?: string
  /** Currently only frame-scoped capture is supported. */
  scope?: ui_metal_gpu_capture_scope
  label?: string
}

export interface ui_metal_gpu_capture_bridge {
  begin_frame_capture(options: Required<ui_metal_gpu_capture_options>): unknown
  end_frame_capture(token?: unknown): void
}

type webkit_message_handler = { postMessage(message: unknown): void }

declare global {
  interface Window {
    ui_metal_gpu_capture?: ui_metal_gpu_capture_bridge
    webkit?: {
      messageHandlers?: {
        uiMetalGpuCapture?: webkit_message_handler
        ui_metal_gpu_capture?: webkit_message_handler
      }
    }
  }
}

export type ui_active_metal_gpu_capture = {
  bridge?: ui_metal_gpu_capture_bridge
  handler?: webkit_message_handler
  token?: unknown
}

let pending_metal_frame_capture: Required<ui_metal_gpu_capture_options> | null = null

export function ui_has_metal_gpu_capture_bridge(): boolean {
  return Boolean(resolve_metal_gpu_capture_bridge() || resolve_webkit_metal_gpu_capture_handler())
}

export function ui_queue_metal_frame_capture(options: ui_metal_gpu_capture_options = {}): boolean {
  if (!ui_has_metal_gpu_capture_bridge()) return false
  pending_metal_frame_capture = normalize_metal_capture_options(options)
  return true
}

export function ui_has_pending_metal_frame_capture(): boolean {
  return pending_metal_frame_capture !== null
}

export function ui_consume_metal_frame_capture_request(): Required<ui_metal_gpu_capture_options> | null {
  const request = pending_metal_frame_capture
  pending_metal_frame_capture = null
  return request
}

export function ui_begin_metal_frame_capture(options: Required<ui_metal_gpu_capture_options>): ui_active_metal_gpu_capture | null {
  const bridge = resolve_metal_gpu_capture_bridge()
  if (bridge) {
    try {
      return { bridge, token: bridge.begin_frame_capture(options) }
    } catch (err) {
      console.warn('Metal GPU capture begin_frame_capture failed:', err)
      return null
    }
  }

  const handler = resolve_webkit_metal_gpu_capture_handler()
  if (handler) {
    try {
      handler.postMessage({ type: 'begin_frame_capture', options })
      return { handler }
    } catch (err) {
      console.warn('Metal GPU capture WebKit begin_frame_capture failed:', err)
      return null
    }
  }

  console.warn('Metal GPU capture requested, but no native bridge is installed.')
  return null
}

export function ui_end_metal_frame_capture(capture: ui_active_metal_gpu_capture | null): void {
  if (!capture) return
  if (capture.bridge) {
    try {
      capture.bridge.end_frame_capture(capture.token)
    } catch (err) {
      console.warn('Metal GPU capture end_frame_capture failed:', err)
    }
    return
  }
  if (capture.handler) {
    try {
      capture.handler.postMessage({ type: 'end_frame_capture' })
    } catch (err) {
      console.warn('Metal GPU capture WebKit end_frame_capture failed:', err)
    }
  }
}

function normalize_metal_capture_options(options: ui_metal_gpu_capture_options): Required<ui_metal_gpu_capture_options> {
  return {
    directory: options.directory ?? '.',
    filename: options.filename ?? `ui-frame-${new Date().toISOString().replace(/[:.]/g, '-')}.gputrace`,
    scope: 'frame',
    label: options.label ?? 'ui.frame',
  }
}

function resolve_metal_gpu_capture_bridge(): ui_metal_gpu_capture_bridge | null {
  return window.ui_metal_gpu_capture ?? null
}

function resolve_webkit_metal_gpu_capture_handler(): webkit_message_handler | null {
  return window.webkit?.messageHandlers?.uiMetalGpuCapture ?? window.webkit?.messageHandlers?.ui_metal_gpu_capture ?? null
}
