import type { theme_definition, theme_slot } from './ui_types'

const slot_to_css_var: Record<theme_slot, string> = {
  bg: '--theme-slot-bg',
  panel: '--theme-slot-panel',
  panel_alt: '--theme-slot-panel-alt',
  border: '--theme-slot-border',
  border_strong: '--theme-slot-border-strong',
  text: '--theme-slot-text',
  text_dim: '--theme-slot-text-dim',
  hover: '--theme-slot-hover',
  active: '--theme-slot-active',
  selected: '--theme-slot-selected',
  accent: '--theme-slot-accent',
  accent_dim: '--theme-slot-accent-dim',
  scene_outline: '--theme-slot-scene-outline',
  gizmo_axis_x: '--theme-slot-gizmo-axis-x',
  gizmo_axis_y: '--theme-slot-gizmo-axis-y',
  gizmo_axis_z: '--theme-slot-gizmo-axis-z',
  gizmo_center: '--theme-slot-gizmo-center',
  track: '--theme-slot-track',
  overlay: '--theme-slot-overlay',
  ghost: '--theme-slot-ghost',
}

export async function load_theme(url: string): Promise<theme_definition> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`fetch ${url}: ${res.status}`)
  return res.json()
}

export function theme_color(theme: theme_definition, slot: theme_slot): string {
  return theme.palette[slot]
}

/**
 * Pack a `#rrggbb` / `#rrggbbaa` hex string into the `0xAABBGGRR` integer the
 * renderer's draw calls expect. Exported so plugin/consumer code can colour
 * raw `fill_rect` / `draw_text` calls the same way the built-in widgets do.
 */
export function pack_color(hex: string): number {
  const raw = hex.trim().replace('#', '')
  const parse = (start: number) => Number.parseInt(raw.slice(start, start + 2), 16)
  if (raw.length === 6) {
    const r = parse(0)
    const g = parse(2)
    const b = parse(4)
    return (((255 & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0
  }
  if (raw.length === 8) {
    const r = parse(0)
    const g = parse(2)
    const b = parse(4)
    const a = parse(6)
    return (((a & 255) << 24) | ((b & 255) << 16) | ((g & 255) << 8) | (r & 255)) >>> 0
  }
  return 0xffffffff
}

/** Convenience: resolve a theme slot straight to a packed `0xAABBGGRR` colour. */
export function theme_rgba(theme: theme_definition, slot: theme_slot): number {
  return pack_color(theme_color(theme, slot))
}

/** Pack four 0..1 float channels into a `0xAABBGGRR` integer. */
export function pack_rgba_floats(r: number, g: number, b: number, a = 1): number {
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)))
  return (((c(a) & 255) << 24) | ((c(b) & 255) << 16) | ((c(g) & 255) << 8) | (c(r) & 255)) >>> 0
}

export function apply_theme(theme: theme_definition): void {
  const root = document.documentElement
  for (const [name, value] of Object.entries(theme.css)) {
    root.style.setProperty(name, value)
  }
  for (const [slot, value] of Object.entries(theme.palette) as Array<[theme_slot, string]>) {
    root.style.setProperty(slot_to_css_var[slot], value)
  }

  root.style.setProperty('--app-bg', theme_color(theme, 'bg'))
  root.style.setProperty('--app-surface', theme_color(theme, 'panel'))
  root.style.setProperty('--app-surface-alt', theme_color(theme, 'panel_alt'))
  root.style.setProperty('--app-border', theme_color(theme, 'border'))
  root.style.setProperty('--app-border-strong', theme_color(theme, 'border_strong'))
  root.style.setProperty('--app-text', theme_color(theme, 'text'))
  root.style.setProperty('--app-text-dim', theme_color(theme, 'text_dim'))
  root.style.setProperty('--app-hover', theme_color(theme, 'hover'))
  root.style.setProperty('--app-active', theme_color(theme, 'active'))
  root.style.setProperty('--app-selected', theme_color(theme, 'selected'))
  root.style.setProperty('--app-accent', theme_color(theme, 'accent'))
  root.style.setProperty('--app-accent-dim', theme_color(theme, 'accent_dim'))
  root.style.setProperty('--app-scene-outline', theme_color(theme, 'scene_outline'))
  root.style.setProperty('--app-gizmo-axis-x', theme_color(theme, 'gizmo_axis_x'))
  root.style.setProperty('--app-gizmo-axis-y', theme_color(theme, 'gizmo_axis_y'))
  root.style.setProperty('--app-gizmo-axis-z', theme_color(theme, 'gizmo_axis_z'))
  root.style.setProperty('--app-gizmo-center', theme_color(theme, 'gizmo_center'))
  root.style.setProperty('--app-track', theme_color(theme, 'track'))
  root.style.setProperty('--app-overlay', theme_color(theme, 'overlay'))
  root.style.setProperty('--app-ghost', theme_color(theme, 'ghost'))
}

/** A named theme, ready to be offered in a picker / dropdown. */
export interface theme_preset {
  name: string
  theme: theme_definition
}

/** Parse a `#rrggbb` / `#rrggbbaa` string into 0..255 channels. */
function parse_hex_channels(hex: string): { r: number; g: number; b: number; a: number } {
  const raw = hex.trim().replace('#', '')
  const parse = (start: number) => Number.parseInt(raw.slice(start, start + 2), 16)
  if (raw.length === 6) return { r: parse(0), g: parse(2), b: parse(4), a: 255 }
  if (raw.length === 8) return { r: parse(0), g: parse(2), b: parse(4), a: parse(6) }
  return { r: 0, g: 0, b: 0, a: 255 }
}

/**
 * Linearly interpolate between two `#rrggbb(aa)` colours, returning a hex
 * string. `t` is clamped to 0..1 (0 → `a`, 1 → `b`).
 */
export function lerp_hex(a: string, b: string, t: number): string {
  const k = t <= 0 ? 0 : t >= 1 ? 1 : t
  const ca = parse_hex_channels(a)
  const cb = parse_hex_channels(b)
  const mix = (x: number, y: number) => Math.round(x + (y - x) * k)
  const to2 = (n: number) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0')
  const alpha = mix(ca.a, cb.a)
  const base = `#${to2(mix(ca.r, cb.r))}${to2(mix(ca.g, cb.g))}${to2(mix(ca.b, cb.b))}`
  return alpha >= 255 ? base : `${base}${to2(alpha)}`
}

/**
 * Linearly interpolate every palette slot between two themes, producing an
 * intermediate theme suitable for an animated transition. CSS variables (font,
 * radius, …) are not numeric colours, so they swap at the midpoint. Returns the
 * `from`/`to` reference directly at the extremes so callers can cheaply detect a
 * settled transition by identity.
 */
export function lerp_theme(from: theme_definition, to: theme_definition, t: number): theme_definition {
  if (t <= 0) return from
  if (t >= 1) return to
  const palette = {} as Record<theme_slot, string>
  for (const slot of Object.keys(from.palette) as theme_slot[]) {
    palette[slot] = lerp_hex(from.palette[slot], to.palette[slot] ?? from.palette[slot], t)
  }
  return { css: t < 0.5 ? from.css : to.css, palette }
}

const base_css: Record<string, string> = {
  '--app-radius': '6px',
  '--app-font': 'Lato, system-ui, sans-serif',
}

/**
 * A handful of built-in themes, ready to drop into a theme picker. The first
 * entry ("Midnight") matches the default `preview/theme.json` palette.
 */
export const default_themes: theme_preset[] = [
  {
    name: 'Midnight',
    theme: {
      css: base_css,
      palette: {
        bg: '#16181d', panel: '#1d2026', panel_alt: '#23272f', border: '#2c313a', border_strong: '#3a414d',
        text: '#e6e9ef', text_dim: '#9aa3b0', hover: '#2a2f38', active: '#323845', selected: '#2f3744',
        accent: '#4c8bf5', accent_dim: '#2f4d7a', scene_outline: '#4c8bf5',
        gizmo_axis_x: '#e0698b', gizmo_axis_y: '#5fb878', gizmo_axis_z: '#5b9bd5', gizmo_center: '#d8a24a',
        track: '#15171b', overlay: '#0b0d10', ghost: '#3a414d',
      },
    },
  },
  {
    name: 'Daylight',
    theme: {
      css: base_css,
      palette: {
        bg: '#f5f6f8', panel: '#ffffff', panel_alt: '#eef0f3', border: '#d7dbe0', border_strong: '#c0c6cf',
        text: '#1d2026', text_dim: '#5c6470', hover: '#e8ebef', active: '#dde1e7', selected: '#e3ebfa',
        accent: '#2f6fed', accent_dim: '#aac4f7', scene_outline: '#2f6fed',
        gizmo_axis_x: '#d6446b', gizmo_axis_y: '#3a9d57', gizmo_axis_z: '#3f7fc4', gizmo_center: '#c08a2e',
        track: '#e9ebee', overlay: '#c9ced6', ghost: '#c0c6cf',
      },
    },
  },
  {
    name: 'Nord',
    theme: {
      css: base_css,
      palette: {
        bg: '#2e3440', panel: '#3b4252', panel_alt: '#434c5e', border: '#4c566a', border_strong: '#5b6678',
        text: '#eceff4', text_dim: '#9aa1b0', hover: '#434c5e', active: '#4c566a', selected: '#434c5e',
        accent: '#88c0d0', accent_dim: '#4c6f78', scene_outline: '#88c0d0',
        gizmo_axis_x: '#bf616a', gizmo_axis_y: '#a3be8c', gizmo_axis_z: '#81a1c1', gizmo_center: '#ebcb8b',
        track: '#272c36', overlay: '#20242c', ghost: '#4c566a',
      },
    },
  },
  {
    name: 'Dracula',
    theme: {
      css: base_css,
      palette: {
        bg: '#282a36', panel: '#21222c', panel_alt: '#343746', border: '#44475a', border_strong: '#565a73',
        text: '#f8f8f2', text_dim: '#8b91b4', hover: '#343746', active: '#44475a', selected: '#3a3d4d',
        accent: '#bd93f9', accent_dim: '#5b4a86', scene_outline: '#bd93f9',
        gizmo_axis_x: '#ff5555', gizmo_axis_y: '#50fa7b', gizmo_axis_z: '#8be9fd', gizmo_center: '#f1fa8c',
        track: '#1e1f29', overlay: '#14151c', ghost: '#44475a',
      },
    },
  },
  {
    name: 'Solarized',
    theme: {
      css: base_css,
      palette: {
        bg: '#002b36', panel: '#073642', panel_alt: '#0a4250', border: '#104b59', border_strong: '#1b5e6e',
        text: '#93a1a1', text_dim: '#657b83', hover: '#0a4250', active: '#104b59', selected: '#0d4c5a',
        accent: '#268bd2', accent_dim: '#1c5e8a', scene_outline: '#268bd2',
        gizmo_axis_x: '#dc322f', gizmo_axis_y: '#859900', gizmo_axis_z: '#268bd2', gizmo_center: '#b58900',
        track: '#00212b', overlay: '#001b22', ghost: '#104b59',
      },
    },
  },
  {
    name: 'Rosé Pine',
    theme: {
      css: base_css,
      palette: {
        bg: '#191724', panel: '#1f1d2e', panel_alt: '#26233a', border: '#2f2b43', border_strong: '#403d57',
        text: '#e0def4', text_dim: '#908caa', hover: '#26233a', active: '#2f2b43', selected: '#312f44',
        accent: '#c4a7e7', accent_dim: '#6e5c8a', scene_outline: '#ebbcba',
        gizmo_axis_x: '#eb6f92', gizmo_axis_y: '#9ccfd8', gizmo_axis_z: '#31748f', gizmo_center: '#f6c177',
        track: '#14121f', overlay: '#100e1a', ghost: '#403d57',
      },
    },
  },
]

export function hex_to_normalized_rgba(color: string): GPUColorDict {
  const value = color.trim()
  if (!value.startsWith('#')) {
    return { r: 0, g: 0, b: 0, a: 1 }
  }
  const hex = value.slice(1)
  const parse = (start: number) => Number.parseInt(hex.slice(start, start + 2), 16) / 255
  if (hex.length === 6) {
    return { r: parse(0), g: parse(2), b: parse(4), a: 1 }
  }
  if (hex.length === 8) {
    return { r: parse(0), g: parse(2), b: parse(4), a: parse(6) }
  }
  return { r: 0, g: 0, b: 0, a: 1 }
}
