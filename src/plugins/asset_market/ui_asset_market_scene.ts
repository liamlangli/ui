// asset_market — scene catalogue model and the main-thread Draco worker client.
//
// The marketplace deals in whole scenes only, and every scene ships as a single
// binary glTF (.glb). A listing carries its raw glb size next to the size of its
// Draco-compressed geometry so the storefront can show the saving. The worker
// client here spins up {@link ui_asset_market_worker} and exposes a small
// promise API; when workers are unavailable (older host, unit test) it degrades
// to running the codec inline so callers never special-case the environment.

import { decode_draco_geometry, encode_draco_geometry } from './ui_asset_market_draco'
import type { draco_encode_options, scene_geometry } from './ui_asset_market_draco'
import type { draco_worker_response } from './ui_asset_market_worker'

/** A purchasable whole scene. Only the .glb container is supported. */
export interface scene_market_item {
  id: string
  name: string
  /** Author or studio credit. */
  author?: string
  /** Always `glb` — the storefront sells nothing else. */
  format: 'glb'
  /** Total triangles across the packed scene. */
  triangle_count: number
  /** Size of the raw .glb container in bytes. */
  raw_bytes: number
  /** Size of the Draco-compressed geometry payload in bytes. */
  draco_bytes: number
  /** Price in cents; omit or 0 for free scenes. */
  price_cents?: number
  /** Packed `0xAABBGGRR` seed color for the card's fallback art. */
  thumbnail_color?: number
  /** Short one-line blurb shown under the title. */
  subtitle?: string
}

/** Fraction (0–1) of bytes saved by Draco compression, clamped to [0,1]. */
export function scene_draco_saving(item: scene_market_item): number {
  if (item.raw_bytes <= 0 || item.draco_bytes <= 0) return 0
  const saving = 1 - item.draco_bytes / item.raw_bytes
  return saving < 0 ? 0 : saving > 1 ? 1 : saving
}

/** Promise API over the Draco worker (or an inline fallback). */
export interface draco_worker {
  /** Compress geometry into the Draco-style container. */
  encode(geo: scene_geometry, options?: draco_encode_options): Promise<Uint8Array>
  /** Decompress a container back into geometry. */
  decode(bytes: Uint8Array): Promise<scene_geometry>
  /** Terminate the underlying worker (no-op for the inline fallback). */
  dispose(): void
}

function create_inline_worker(): draco_worker {
  // No worker available — run the codec on the calling thread. Still async so
  // callers see one API. `Promise.resolve().then` defers past the current frame.
  return {
    encode: (geo, options) => Promise.resolve().then(() => encode_draco_geometry(geo, options)),
    decode: (bytes) => Promise.resolve().then(() => decode_draco_geometry(bytes)),
    dispose: () => {},
  }
}

/**
 * Start a Draco worker. Falls back to inline execution when the Worker API is
 * missing or the worker fails to construct (e.g. a bundler without worker-URL
 * support), so the marketplace keeps compressing/decompressing regardless.
 */
export function create_draco_worker(): draco_worker {
  if (typeof Worker === 'undefined') return create_inline_worker()
  let worker: Worker
  try {
    worker = new Worker(new URL('./ui_asset_market_worker.ts', import.meta.url), { type: 'module' })
  } catch {
    return create_inline_worker()
  }

  let next_id = 1
  const pending = new Map<number, { resolve: (msg: draco_worker_response) => void; reject: (err: Error) => void }>()

  worker.onmessage = (event: MessageEvent<draco_worker_response>) => {
    const msg = event.data
    const entry = pending.get(msg.id)
    if (!entry) return
    pending.delete(msg.id)
    if (msg.ok) entry.resolve(msg)
    else entry.reject(new Error((msg as Extract<draco_worker_response, { ok: false }>).error))
  }
  worker.onerror = (event) => {
    const err = new Error(event.message || 'draco worker error')
    for (const entry of pending.values()) entry.reject(err)
    pending.clear()
  }

  const call = (
    request: { id: number } & Record<string, unknown>,
  ): Promise<draco_worker_response> =>
    new Promise((resolve, reject) => {
      pending.set(request.id, { resolve, reject })
      worker.postMessage(request)
    })

  return {
    encode(geo, options) {
      const id = next_id++
      return call({ id, op: 'encode', geo, options }).then((msg) =>
        msg.ok && msg.op === 'encode' ? msg.bytes : Promise.reject(new Error('unexpected encode reply')),
      )
    },
    decode(bytes) {
      const id = next_id++
      return call({ id, op: 'decode', bytes }).then((msg) =>
        msg.ok && msg.op === 'decode' ? msg.geo : Promise.reject(new Error('unexpected decode reply')),
      )
    },
    dispose() {
      worker.terminate()
    },
  }
}
