import type { theme_definition, theme_slot } from './types'

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
