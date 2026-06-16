// dashboard — a full-screen app launcher over the installed-app registry.
//
// Covers the whole rect it is given (the host passes the entire screen) with a
// grid of every installed app: a rounded icon tile with the app name under it.
// It is the UI face of `app_registry`:
//
//   • click an app          → `launched` (host opens the app, hides the dashboard)
//   • right-click an app    → context menu: Open / Check for Updates /
//                             Update to vX (when one is pending) / Uninstall
//   • drag a description    → `dashboard_drop_target` installs dropped `.json`
//     .json onto the page     manifests (or dragged manifest URLs) into the
//                             registry and the grid lights up as a drop zone
//   • Escape / empty click  → `dismissed`
//
// Tiles show a badge while an update is available (found by re-fetching the
// manifest from the app's shipping path) and a spinner-dot while checking.
//
// Usage (once per frame, drawn last so it covers everything):
//
//   const ev = dashboard(ui, theme, input, x, y, w, h, registry.apps, state, { icons })
//   if (ev.launched) open_app(ev.launched)
//   if (ev.uninstall_requested) registry.uninstall(ev.uninstall_requested.manifest.id)
//   if (ev.check_updates_requested) registry.check_update(...)
//   if (ev.update_requested) registry.apply_update(...)
//   if (ev.dismissed) hide_dashboard()

import { pack_color } from '../../core/ui_theme'
import type { theme_definition, theme_slot } from '../../core/ui_types'
import { FONT_MONO, type ui_renderer } from '../../core/ui_renderer'
import type { ui_input_snapshot } from '../../core/ui_widgets'
import type { ui_icons, ui_icon_name } from '../../core/ui_icon'
import type { app_registry, installed_app } from '../../core/ui_app_registry'

export interface dashboard_state {
  scroll_y: number
  /** Open context menu: the target app id plus its anchor point (physical px). */
  menu: { app_id: string; x: number; y: number } | null
  /** Set while a drag with installable payload hovers the page (see `dashboard_drop_target`). */
  drop_active: boolean
}

export function create_dashboard_state(): dashboard_state {
  return { scroll_y: 0, menu: null, drop_active: false }
}

export interface dashboard_options {
  /** Icon atlas used to draw `manifest.icon`; tiles fall back to the name's initial. */
  icons?: ui_icons
  /** Header title. Defaults to 'Applications'. */
  title?: string
  /** Allow the context menu to uninstall apps marked `builtin`. Defaults to false. */
  allow_uninstall_builtin?: boolean
}

export interface dashboard_events {
  /** An app tile was clicked (or "Open" picked from its menu). */
  launched: installed_app | null
  /** "Uninstall" was picked — host removes it from the registry. */
  uninstall_requested: installed_app | null
  /** "Update to vX" was picked — host applies the pending update. */
  update_requested: installed_app | null
  /** "Check for Updates" was picked — host re-fetches the manifest. */
  check_updates_requested: installed_app | null
  /** Escape, the close button, or a click on empty backdrop. */
  dismissed: boolean
}

interface menu_item {
  id: 'open' | 'check' | 'update' | 'uninstall'
  label: string
  disabled: boolean
  danger?: boolean
}

export function dashboard(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  apps: installed_app[],
  state: dashboard_state,
  options?: dashboard_options,
): dashboard_events {
  const scale = window.devicePixelRatio || 1
  const slot = (s: theme_slot) => pack_color(theme.palette[s])
  const events: dashboard_events = {
    launched: null,
    uninstall_requested: null,
    update_requested: null,
    check_updates_requested: null,
    dismissed: false,
  }
  const inside = (px: number, py: number, rx: number, ry: number, rw: number, rh: number) =>
    px >= rx && px < rx + rw && py >= ry && py < ry + rh

  // Backdrop: a solid sheet so the dashboard truly covers the desktop.
  ui.fill_rect(x, y, w, h, slot('bg'))
  ui.fill_rect(x, y, w, h, slot('overlay'))

  // Header: title + summary on the left, a close button on the right.
  const pad = 28 * scale
  const title = options?.title ?? 'Applications'
  ui.draw_text(x + pad, y + 24 * scale, title, 20 * scale, slot('text'))
  const summary = `${apps.length} installed · click to open · right-click to manage · drop a description .json to install`
  ui.draw_text(x + pad, y + 52 * scale, summary, 11 * scale, slot('text_dim'))

  const close_s = 26 * scale
  const close_x = x + w - pad - close_s
  const close_y = y + 22 * scale
  const close_hover = inside(input.mouse_x, input.mouse_y, close_x, close_y, close_s, close_s)
  ui.fill_round_rect(close_x, close_y, close_s, close_s, 6 * scale, close_hover ? slot('hover') : slot('panel_alt'))
  ui.stroke_round_rect(close_x, close_y, close_s, close_s, 6 * scale, 1, slot('border'))
  const cr = 7 * scale
  const ccx = close_x + close_s / 2
  const ccy = close_y + close_s / 2
  ui.stroke_line(ccx - cr / 2, ccy - cr / 2, ccx + cr / 2, ccy + cr / 2, 1.4 * scale, slot('text'))
  ui.stroke_line(ccx - cr / 2, ccy + cr / 2, ccx + cr / 2, ccy - cr / 2, 1.4 * scale, slot('text'))

  // Grid viewport below the header.
  const grid_y = y + 84 * scale
  const grid_h = Math.max(1, y + h - grid_y - 16 * scale)
  const tile_w = 108 * scale
  const tile_h = 118 * scale
  const gap = 18 * scale
  const usable_w = Math.max(tile_w, w - pad * 2)
  const columns = Math.max(1, Math.floor((usable_w + gap) / (tile_w + gap)))
  const grid_w = columns * (tile_w + gap) - gap
  const grid_x = x + (w - grid_w) / 2
  const rows = Math.ceil(apps.length / columns)
  const content_h = rows > 0 ? rows * (tile_h + gap) - gap : 0

  const max_scroll = Math.max(0, content_h - grid_h)
  if (!state.menu && input.wheel_y !== 0 && inside(input.mouse_x, input.mouse_y, x, grid_y, w, grid_h)) {
    state.scroll_y -= input.wheel_y * 48 * scale
  }
  state.scroll_y = Math.max(0, Math.min(max_scroll, state.scroll_y))

  // While the menu is open it owns the pointer: tiles see neutered input so a
  // click that closes the menu doesn't also launch the app underneath.
  const menu_open = state.menu !== null
  let hover_app: installed_app | null = null

  ui.push_clip(x, grid_y, w, grid_h)
  const icon_s = 56 * scale
  const name_font = 11 * scale
  const meta_font = 9 * scale
  for (let i = 0; i < apps.length; i += 1) {
    const app = apps[i]!
    const col = i % columns
    const row = Math.floor(i / columns)
    const tx = grid_x + col * (tile_w + gap)
    const ty = grid_y + row * (tile_h + gap) - state.scroll_y
    if (ty + tile_h < grid_y || ty > grid_y + grid_h) continue // cull off-screen rows

    const hover = !menu_open && inside(input.mouse_x, input.mouse_y, tx, Math.max(grid_y, ty), tile_w, Math.min(ty + tile_h, grid_y + grid_h) - Math.max(grid_y, ty))
    if (hover) hover_app = app
    if (hover) ui.fill_round_rect(tx, ty, tile_w, tile_h, 10 * scale, slot('hover'))

    // Icon plate: accent-tinted rounded square with the baked icon (or initial).
    const ix = tx + (tile_w - icon_s) / 2
    const iy = ty + 10 * scale
    const plate = app.manifest.accent ? pack_color(app.manifest.accent) : slot('accent_dim')
    ui.fill_round_rect(ix, iy, icon_s, icon_s, 12 * scale, plate)
    ui.stroke_round_rect(ix, iy, icon_s, icon_s, 12 * scale, 1, slot('border_strong'))
    const icons = options?.icons
    const icon_name = app.manifest.icon as ui_icon_name | undefined
    if (icons && icon_name && icons.has(icon_name)) {
      const glyph = icon_s * 0.56
      icons.draw(icon_name, ix + (icon_s - glyph) / 2, iy + (icon_s - glyph) / 2, glyph, slot('text'))
    } else {
      const initial = (app.manifest.name[0] ?? '?').toUpperCase()
      const ifont = icon_s * 0.46
      const iw = ui.text_width(initial, ifont)
      ui.draw_text(ix + (icon_s - iw) / 2, ui.text_v_center_y(iy, icon_s, ifont), initial, ifont, slot('text'))
    }

    // Update badge (pending update) / checking dot, riding the icon's corner.
    if (app.update_available || app.checking) {
      const br = 6.5 * scale
      const bx = ix + icon_s - 3 * scale
      const by = iy + 3 * scale
      ui.fill_circle(bx, by, br, app.update_available ? slot('accent') : slot('ghost'))
      ui.stroke_circle(bx, by, br, 1, slot('bg'))
      if (app.update_available) {
        // Tiny up arrow: shaft + chevron.
        ui.stroke_line(bx, by + 3 * scale, bx, by - 3 * scale, 1.2 * scale, slot('bg'))
        ui.stroke_line(bx - 2.4 * scale, by - 0.4 * scale, bx, by - 3 * scale, 1.2 * scale, slot('bg'))
        ui.stroke_line(bx + 2.4 * scale, by - 0.4 * scale, bx, by - 3 * scale, 1.2 * scale, slot('bg'))
      }
    }

    // Name under the icon, version under the name.
    ui.push_clip(tx + 3 * scale, ty, tile_w - 6 * scale, tile_h)
    const name = app.manifest.name
    const nw = ui.text_width(name, name_font)
    ui.draw_text(tx + Math.max(3 * scale, (tile_w - nw) / 2), iy + icon_s + 9 * scale, name, name_font, hover ? slot('text') : slot('text_dim'))
    const meta = `v${app.manifest.version}`
    const mw = ui.text_width(meta, meta_font, FONT_MONO)
    ui.draw_text(tx + (tile_w - mw) / 2, iy + icon_s + 25 * scale, meta, meta_font, app.update_available ? slot('accent') : slot('ghost'), FONT_MONO)
    ui.pop_clip()

    if (hover && !menu_open) {
      if (input.mouse_pressed) events.launched = app
      if (input.mouse_right_pressed) state.menu = { app_id: app.manifest.id, x: input.mouse_x, y: input.mouse_y }
    }
  }
  ui.pop_clip()

  if (apps.length === 0) {
    const msg = 'No apps installed — drop an app description .json anywhere on this screen.'
    const mw = ui.text_width(msg, 12 * scale)
    ui.draw_text(x + (w - mw) / 2, grid_y + grid_h * 0.4, msg, 12 * scale, slot('text_dim'))
  }

  if (max_scroll > 0) {
    const sb_w = 5 * scale
    const thumb_h = Math.max(24 * scale, (grid_h / content_h) * grid_h)
    const thumb_y = grid_y + (state.scroll_y / max_scroll) * (grid_h - thumb_h)
    ui.fill_round_rect(x + w - sb_w - 4 * scale, thumb_y, sb_w, thumb_h, sb_w / 2, slot('ghost'))
  }

  // Context menu (drawn last so it overlays the grid).
  if (state.menu) {
    const app = apps.find((a) => a.manifest.id === state.menu!.app_id) ?? null
    if (!app) {
      state.menu = null
    } else {
      const items: menu_item[] = [
        { id: 'open', label: 'Open', disabled: false },
        app.update_available
          ? { id: 'update', label: `Update to v${app.update_available.version}`, disabled: app.checking }
          : { id: 'check', label: app.checking ? 'Checking…' : 'Check for Updates', disabled: app.checking || !app.shipping_path },
        { id: 'uninstall', label: 'Uninstall', disabled: app.builtin && options?.allow_uninstall_builtin !== true, danger: true },
      ]
      const item_h = 26 * scale
      const menu_font = 11 * scale
      let menu_w = 150 * scale
      for (const item of items) menu_w = Math.max(menu_w, ui.text_width(item.label, menu_font) + 28 * scale)
      const menu_h = items.length * item_h + 8 * scale
      const mx = Math.min(state.menu.x, x + w - menu_w - 6 * scale)
      const my = Math.min(state.menu.y, y + h - menu_h - 6 * scale)

      ui.fill_round_rect(mx, my, menu_w, menu_h, 7 * scale, slot('panel'))
      ui.stroke_round_rect(mx, my, menu_w, menu_h, 7 * scale, 1, slot('border_strong'))
      let iy2 = my + 4 * scale
      let clicked: menu_item | null = null
      for (const item of items) {
        const ih = inside(input.mouse_x, input.mouse_y, mx, iy2, menu_w, item_h)
        if (ih && !item.disabled) ui.fill_round_rect(mx + 3 * scale, iy2, menu_w - 6 * scale, item_h, 5 * scale, slot('hover'))
        const color = item.disabled ? slot('ghost') : item.danger ? pack_color('#d9534f') : slot('text')
        ui.draw_text(mx + 14 * scale, ui.text_v_center_y(iy2, item_h, menu_font), item.label, menu_font, color)
        if (ih && !item.disabled && input.mouse_pressed) clicked = item
        iy2 += item_h
      }

      if (clicked) {
        if (clicked.id === 'open') events.launched = app
        else if (clicked.id === 'check') events.check_updates_requested = app
        else if (clicked.id === 'update') events.update_requested = app
        else if (clicked.id === 'uninstall') events.uninstall_requested = app
        state.menu = null
      } else if ((input.mouse_pressed || input.mouse_right_pressed) && !inside(input.mouse_x, input.mouse_y, mx, my, menu_w, menu_h)) {
        state.menu = null
      } else if (input.key_escape) {
        state.menu = null
      }
    }
  }

  // Drop-zone highlight while a drag hovers the page.
  if (state.drop_active) {
    const inset = 10 * scale
    ui.fill_round_rect(x + inset, y + inset, w - inset * 2, h - inset * 2, 14 * scale, slot('overlay'))
    ui.stroke_round_rect(x + inset, y + inset, w - inset * 2, h - inset * 2, 14 * scale, 2 * scale, slot('accent'))
    const msg = 'Drop app description (.json) to install'
    const font = 15 * scale
    const mw = ui.text_width(msg, font)
    ui.fill_round_rect(x + (w - mw) / 2 - 16 * scale, y + h / 2 - 22 * scale, mw + 32 * scale, 44 * scale, 10 * scale, slot('panel'))
    ui.draw_text(x + (w - mw) / 2, y + h / 2 - font / 2, msg, font, slot('accent'))
  }

  // Dismissal: close button, Escape (when no menu just swallowed it), or a
  // press on empty backdrop — but never while a drop is being aimed.
  if (close_hover && input.mouse_pressed) events.dismissed = true
  else if (!menu_open && input.key_escape) events.dismissed = true
  else if (!menu_open && !state.drop_active && input.mouse_pressed && !hover_app && !close_hover && !events.launched && inside(input.mouse_x, input.mouse_y, x, y, w, h)) {
    events.dismissed = true
  }
  return events
}

export interface dashboard_drop_options {
  /** Fired for each manifest successfully installed from the drop. */
  on_installed?: (app: installed_app) => void
  /** Fired when a dropped payload fails to parse / fetch / validate. */
  on_error?: (message: string) => void
  /** Fired when a drag enters/leaves the target (e.g. open the dashboard and request a render). */
  on_drag_state?: (active: boolean) => void
}

/**
 * Wire drag-to-install onto a DOM element (usually the canvas): dropping app
 * description `.json` files installs them into the registry, and dropping a
 * dragged URL fetches the manifest from it (the URL becomes the shipping
 * path). While a drag hovers the target, `state.drop_active` is set so the
 * dashboard renders its drop-zone highlight. Returns a detach function.
 */
export function dashboard_drop_target(
  target: HTMLElement,
  registry: app_registry,
  state: dashboard_state,
  options?: dashboard_drop_options,
): () => void {
  const set_active = (active: boolean) => {
    if (state.drop_active === active) return
    state.drop_active = active
    options?.on_drag_state?.(active)
  }
  const drag_over = (e: DragEvent) => {
    e.preventDefault()
    if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    set_active(true)
  }
  const drag_leave = () => set_active(false)
  const drop = (e: DragEvent) => {
    e.preventDefault()
    set_active(false)
    const dt = e.dataTransfer
    if (!dt) return
    const files = [...dt.files].filter((f) => f.type === 'application/json' || f.name.toLowerCase().endsWith('.json'))
    if (files.length > 0) {
      for (const file of files) {
        file
          .text()
          .then((text) => options?.on_installed?.(registry.install_from_json(text)))
          .catch((err) => options?.on_error?.(`install ${file.name}: ${err instanceof Error ? err.message : err}`))
      }
      return
    }
    const url = (dt.getData('text/uri-list') || dt.getData('text/plain')).split('\n')[0]?.trim()
    if (!url) return
    registry
      .install_from_url(url)
      .then((app) => options?.on_installed?.(app))
      .catch((err) => options?.on_error?.(`install ${url}: ${err instanceof Error ? err.message : err}`))
  }
  target.addEventListener('dragenter', drag_over)
  target.addEventListener('dragover', drag_over)
  target.addEventListener('dragleave', drag_leave)
  target.addEventListener('drop', drop)
  return () => {
    target.removeEventListener('dragenter', drag_over)
    target.removeEventListener('dragover', drag_over)
    target.removeEventListener('dragleave', drag_leave)
    target.removeEventListener('drop', drop)
  }
}
