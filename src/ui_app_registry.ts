// app_registry — installable "apps" described by a small JSON manifest.
//
// An app ships as a description JSON (its *manifest*): id, name, version, an
// optional icon / accent / description, and a `shipping_path` — the URL the
// manifest itself is served from. The registry keeps the installed set,
// (de)serializes it for persistence, and uses each app's shipping path to
// check for and apply updates: it re-fetches the manifest from that URL and
// compares versions, so publishing a new manifest at the same path is all a
// vendor needs to do to ship an update.
//
//   const registry = new app_registry(localStorage.getItem(KEY))
//   registry.on_change = () => localStorage.setItem(KEY, serialize_app_registry(registry))
//
//   registry.install_from_json(dropped_file_text)       // drag-to-install
//   registry.uninstall('notes')                          // right-click → uninstall
//   await registry.check_update('notes')                 // fetch shipping_path, compare versions
//   await registry.apply_update('notes')                 // adopt the newer manifest

/** The description JSON an app ships with. */
export interface app_manifest {
  /** Stable identifier — installing the same id again replaces the entry. */
  id: string
  /** Display name shown under the dashboard icon. */
  name: string
  /** Dotted version string (`1.2.0`); compared numerically per segment. */
  version: string
  /** Optional one-line description. */
  description?: string
  /** Optional baked icon name (see `ui_icon_name`); falls back to the name's initial. */
  icon?: string
  /** Optional tile accent colour (`#rrggbb`). */
  accent?: string
  /**
   * URL this manifest is served from (absolute, or relative to the page /
   * the URL it was installed from). The registry fetches it again to check
   * for updates, so it is the app's update channel.
   */
  shipping_path?: string
}

/** A registry entry: the manifest plus install/update bookkeeping. */
export interface installed_app {
  manifest: app_manifest
  /** Resolved shipping path used for update checks, or null when the app has none. */
  shipping_path: string | null
  /** Built-in apps ship with the host and cannot be uninstalled by default. */
  builtin: boolean
  installed_at: number
  updated_at: number
  /** The newer manifest found by the last update check, if any. */
  update_available: app_manifest | null
  /** True while an update check / apply fetch is in flight. */
  checking: boolean
  last_checked: number | null
  last_error: string | null
}

/** Parse + validate a manifest from JSON text or an already-parsed object. Throws on bad input. */
export function parse_app_manifest(source: unknown): app_manifest {
  const raw = typeof source === 'string' ? JSON.parse(source) : source
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('app manifest must be a JSON object')
  const m = raw as Record<string, unknown>
  const text = (key: string): string => (typeof m[key] === 'string' ? (m[key] as string).trim() : '')
  const id = text('id')
  const name = text('name')
  const version = text('version')
  if (!id) throw new Error("app manifest is missing 'id'")
  if (!name) throw new Error("app manifest is missing 'name'")
  if (!version) throw new Error("app manifest is missing 'version'")
  const manifest: app_manifest = { id, name, version }
  if (text('description')) manifest.description = text('description')
  if (text('icon')) manifest.icon = text('icon')
  if (text('accent')) manifest.accent = text('accent')
  if (text('shipping_path')) manifest.shipping_path = text('shipping_path')
  return manifest
}

/** Compare dotted version strings segment by segment: negative when a < b, positive when a > b. */
export function compare_app_versions(a: string, b: string): number {
  const pa = a.split('.')
  const pb = b.split('.')
  const len = Math.max(pa.length, pb.length)
  for (let i = 0; i < len; i += 1) {
    const na = parseInt(pa[i] ?? '0', 10)
    const nb = parseInt(pb[i] ?? '0', 10)
    const va = Number.isNaN(na) ? 0 : na
    const vb = Number.isNaN(nb) ? 0 : nb
    if (va !== vb) return va - vb
  }
  return 0
}

/** Resolve a (possibly relative) shipping path against `base` or the page URL. */
export function resolve_shipping_path(path: string, base?: string): string {
  try {
    const fallback = typeof document !== 'undefined' ? document.baseURI : undefined
    return new URL(path, base ?? fallback).toString()
  } catch {
    return path
  }
}

export interface app_install_options {
  /** Mark the entry as shipped with the host (uninstall is gated on this). */
  builtin?: boolean
  /** URL the manifest was loaded from — relative shipping paths resolve against it. */
  source_url?: string
}

interface serialized_app {
  manifest: app_manifest
  shipping_path: string | null
  builtin: boolean
  installed_at: number
  updated_at: number
}

/** Snapshot the installed set as a JSON string (transient check state is dropped). */
export function serialize_app_registry(registry: app_registry): string {
  const apps: serialized_app[] = registry.apps.map((app) => ({
    manifest: app.manifest,
    shipping_path: app.shipping_path,
    builtin: app.builtin,
    installed_at: app.installed_at,
    updated_at: app.updated_at,
  }))
  return JSON.stringify({ apps })
}

/** Restore a `serialize_app_registry` snapshot. Throws on malformed input. */
export function restore_app_registry_apps(raw: string): installed_app[] {
  const data = JSON.parse(raw) as { apps?: unknown }
  if (!data || !Array.isArray(data.apps)) throw new Error('app registry snapshot: missing apps array')
  return data.apps.map((entry) => {
    const e = entry as serialized_app
    const manifest = parse_app_manifest(e.manifest)
    return {
      manifest,
      shipping_path: typeof e.shipping_path === 'string' ? e.shipping_path : null,
      builtin: e.builtin === true,
      installed_at: typeof e.installed_at === 'number' ? e.installed_at : Date.now(),
      updated_at: typeof e.updated_at === 'number' ? e.updated_at : Date.now(),
      update_available: null,
      checking: false,
      last_checked: null,
      last_error: null,
    }
  })
}

export class app_registry {
  apps: installed_app[] = []
  /** Fired after any mutation (install, uninstall, update, check result). */
  on_change: (() => void) | null = null

  /** Optionally restore a `serialize_app_registry` snapshot; bad blobs start empty. */
  constructor(saved?: string | null) {
    if (saved) {
      try {
        this.apps = restore_app_registry_apps(saved)
      } catch {
        this.apps = []
      }
    }
  }

  get(id: string): installed_app | null {
    return this.apps.find((app) => app.manifest.id === id) ?? null
  }

  /** Install (or replace, keyed by manifest id) an app. */
  install(manifest: app_manifest, options?: app_install_options): installed_app {
    const shipping = manifest.shipping_path ? resolve_shipping_path(manifest.shipping_path, options?.source_url) : options?.source_url ?? null
    const existing = this.get(manifest.id)
    const now = Date.now()
    if (existing) {
      existing.manifest = { ...manifest }
      existing.shipping_path = shipping
      existing.updated_at = now
      existing.update_available = null
      existing.last_error = null
      this.changed()
      return existing
    }
    const app: installed_app = {
      manifest: { ...manifest },
      shipping_path: shipping,
      builtin: options?.builtin === true,
      installed_at: now,
      updated_at: now,
      update_available: null,
      checking: false,
      last_checked: null,
      last_error: null,
    }
    this.apps.push(app)
    this.changed()
    return app
  }

  /** Install from raw description-JSON text (e.g. a dropped `.json` file). Throws on bad manifests. */
  install_from_json(text: string, source_url?: string): installed_app {
    return this.install(parse_app_manifest(text), { source_url })
  }

  /** Fetch a description JSON and install it; the URL becomes the default shipping path. */
  async install_from_url(url: string): Promise<installed_app> {
    const resolved = resolve_shipping_path(url)
    const res = await fetch(resolved, { cache: 'no-store' })
    if (!res.ok) throw new Error(`fetch ${resolved}: HTTP ${res.status}`)
    return this.install_from_json(await res.text(), resolved)
  }

  /** Remove an app. Built-ins are kept unless `force` is set. */
  uninstall(id: string, force = false): boolean {
    const index = this.apps.findIndex((app) => app.manifest.id === id)
    if (index < 0) return false
    if (this.apps[index]!.builtin && !force) return false
    this.apps.splice(index, 1)
    this.changed()
    return true
  }

  /**
   * Re-fetch the app's manifest from its shipping path and compare versions.
   * Resolves with the newer manifest (also stored on `update_available`), or
   * null when the app is current / has no shipping path / the fetch failed
   * (see `last_error`).
   */
  async check_update(id: string): Promise<app_manifest | null> {
    const app = this.get(id)
    if (!app) return null
    if (!app.shipping_path) {
      app.last_error = 'no shipping path'
      app.last_checked = Date.now()
      this.changed()
      return null
    }
    app.checking = true
    app.last_error = null
    this.changed()
    try {
      const res = await fetch(app.shipping_path, { cache: 'no-store' })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const remote = parse_app_manifest(await res.text())
      if (remote.id !== app.manifest.id) throw new Error(`manifest id mismatch (${remote.id})`)
      app.update_available = compare_app_versions(remote.version, app.manifest.version) > 0 ? remote : null
      return app.update_available
    } catch (err) {
      app.last_error = err instanceof Error ? err.message : String(err)
      return null
    } finally {
      app.checking = false
      app.last_checked = Date.now()
      this.changed()
    }
  }

  /** Run `check_update` across every app that has a shipping path. */
  async check_all_updates(): Promise<void> {
    await Promise.all(this.apps.filter((app) => app.shipping_path).map((app) => this.check_update(app.manifest.id)))
  }

  /**
   * Adopt the newer manifest found by `check_update` (running a check first if
   * none is pending). Resolves true when the app actually changed version.
   */
  async apply_update(id: string): Promise<boolean> {
    const app = this.get(id)
    if (!app) return false
    if (!app.update_available) await this.check_update(id)
    if (!app.update_available) return false
    const next = app.update_available
    app.manifest = { ...next }
    if (next.shipping_path) app.shipping_path = resolve_shipping_path(next.shipping_path, app.shipping_path ?? undefined)
    app.update_available = null
    app.updated_at = Date.now()
    this.changed()
    return true
  }

  private changed(): void {
    this.on_change?.()
  }
}
