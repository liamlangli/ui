// asset_market — Draco geometry worker.
//
// Runs {@link encode_draco_geometry} / {@link decode_draco_geometry} off the
// main thread so compressing or unpacking a scene never stalls the UI frame.
// The main-thread client lives in ui_asset_market_scene.ts and talks to this
// module over a tiny request/response protocol; this file is referenced only
// by URL (never re-exported from the plugin barrel) so importing the plugin
// never registers a message handler on the window.

import { decode_draco_geometry, encode_draco_geometry } from './ui_asset_market_draco'
import type { draco_encode_options, scene_geometry } from './ui_asset_market_draco'

export type draco_worker_request =
  | { id: number; op: 'encode'; geo: scene_geometry; options?: draco_encode_options }
  | { id: number; op: 'decode'; bytes: Uint8Array }

export type draco_worker_response =
  | { id: number; ok: true; op: 'encode'; bytes: Uint8Array }
  | { id: number; ok: true; op: 'decode'; geo: scene_geometry }
  | { id: number; ok: false; error: string }

// The worker global, typed structurally so this file needs no "webworker" lib.
interface worker_scope {
  onmessage: ((event: { data: draco_worker_request }) => void) | null
  postMessage(message: draco_worker_response, transfer?: ArrayBufferLike[]): void
}

const ctx = globalThis as unknown as worker_scope

ctx.onmessage = (event) => {
  const msg = event.data
  try {
    if (msg.op === 'encode') {
      const bytes = encode_draco_geometry(msg.geo, msg.options)
      ctx.postMessage({ id: msg.id, ok: true, op: 'encode', bytes }, [bytes.buffer])
    } else if (msg.op === 'decode') {
      const geo = decode_draco_geometry(msg.bytes)
      const transfer = [geo.positions.buffer, geo.indices.buffer]
      if (geo.normals) transfer.push(geo.normals.buffer)
      if (geo.uvs) transfer.push(geo.uvs.buffer)
      ctx.postMessage({ id: msg.id, ok: true, op: 'decode', geo }, transfer)
    }
  } catch (err) {
    ctx.postMessage({ id: msg.id, ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}
