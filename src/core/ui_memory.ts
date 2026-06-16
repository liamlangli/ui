// ui_memory — runtime CPU/GPU resource memory tracking (core).
//
// A tiny registry that records every named resource an app keeps alive —
// GPU textures and buffers, CPU-side typed arrays, font/glyph tables — with
// its type, residency and byte size. The collection side lives in core so
// the renderer, icon atlas and host apps can all report allocations; the
// inspection UI ships as the `profiler_panel` plugin's Memory tab, which
// shows the registry as a treemap grouped by resource type plus a sortable,
// searchable table.
//
// Entries are keyed by name: tracking an existing name updates it in place
// (the natural shape for resources that get reallocated or resized, like a
// growing vertex buffer), so call sites never need to hold on to handles:
//
//   memory.track('ui.vertex_buffer', 'geometry', 'gpu', size)   // create or resize
//   memory.untrack('ui.vertex_buffer')                          // release
//
// A shared default instance (`memory`) is exported so call sites don't need
// plumbing; hosts that want isolated registries can construct their own
// `ui_memory`.

/** Where a resource's bytes live. */
export type memory_device = 'gpu' | 'cpu'

/** One tracked allocation. */
export interface memory_resource {
  /** Unique name (also the registry key), e.g. `ui.font_texture.cjk`. */
  name: string
  /** Grouping category, e.g. `'texture' | 'buffer' | 'font' | 'geometry'`. Free-form. */
  kind: string
  device: memory_device
  size_bytes: number
  /** Optional human-readable extra, e.g. `512×512 rgba8` or `1.2k glyphs`. */
  detail?: string
  /** Monotonic registration order — a stable tiebreaker for sorting. */
  order: number
}

export class ui_memory {
  /** Bumped on every mutation so views can cheaply detect change. */
  generation = 0

  private readonly by_name = new Map<string, memory_resource>()
  private next_order = 0
  private cache: memory_resource[] | null = null

  /** Record (or update, when `name` is already tracked) a resource. */
  track(name: string, kind: string, device: memory_device, size_bytes: number, detail?: string): void {
    const existing = this.by_name.get(name)
    const size = Math.max(0, size_bytes)
    if (existing) {
      if (existing.kind === kind && existing.device === device && existing.size_bytes === size && existing.detail === detail) return
      existing.kind = kind
      existing.device = device
      existing.size_bytes = size
      existing.detail = detail
    } else {
      this.by_name.set(name, { name, kind, device, size_bytes: size, detail, order: this.next_order++ })
    }
    this.generation += 1
    this.cache = null
  }

  /** Forget a resource. Unknown names are ignored. */
  untrack(name: string): void {
    if (!this.by_name.delete(name)) return
    this.generation += 1
    this.cache = null
  }

  get(name: string): memory_resource | null {
    return this.by_name.get(name) ?? null
  }

  /** Every tracked resource, in registration order. The array is cached — do not mutate. */
  list(): readonly memory_resource[] {
    if (!this.cache) this.cache = [...this.by_name.values()].sort((a, b) => a.order - b.order)
    return this.cache
  }

  /** Total tracked bytes, optionally restricted to one residency. */
  total_bytes(device?: memory_device): number {
    let total = 0
    for (const res of this.by_name.values()) {
      if (!device || res.device === device) total += res.size_bytes
    }
    return total
  }

  /** Drop every entry. */
  clear(): void {
    if (this.by_name.size === 0) return
    this.by_name.clear()
    this.generation += 1
    this.cache = null
  }
}

/** `1536 → "1.5 KB"` — compact byte formatting for memory UIs. */
export function format_bytes(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${Math.round(bytes)} B`
}

/** Shared default instance — report allocations anywhere without plumbing a registry through. */
export const memory = new ui_memory()
