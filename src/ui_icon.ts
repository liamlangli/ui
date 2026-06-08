// @liamlangli/ui — ui_icon
//
// A small set of vector icons (file, folder, folder_open, chevrons, …) drawn
// purely from the renderer's own immediate-mode commands (stroke_line,
// stroke_round_rect, fill_triangle, fill_circle, …) and baked once into a single
// cached atlas texture. By default the atlas is 512×512 with each icon occupying
// a 32×32 cell, so up to 16×16 = 256 icons fit in one texture.
//
// Icons are baked in white, so a draw call can tint them to any colour for free
// (the textured quad is multiplied by the vertex colour). Typical use:
//
//   const icons = new ui_icons(renderer)
//   icons.draw('folder_open', x, y, 16, theme_rgba(theme, 'accent'))
//
// The bake runs once in the constructor (the device must already be initialised,
// i.e. after `await renderer.init()`); call `bake()` again to refresh it.

import { ui_renderer } from './ui_renderer'

/** Default atlas edge length in texels. */
export const ICON_ATLAS_SIZE = 512
/** Default per-icon cell edge length in texels. */
export const ICON_CELL_SIZE = 32
/** The grid the icon paths are authored on; cells scale paths by `cell / 32`. */
const ICON_DESIGN_GRID = 32

/** Every built-in icon name. */
export type ui_icon_name =
  | 'file'
  | 'file_text'
  | 'folder'
  | 'folder_open'
  | 'chevron_right'
  | 'chevron_down'
  | 'chevron_up'
  | 'chevron_left'
  | 'plus'
  | 'minus'
  | 'close'
  | 'check'
  | 'search'
  | 'settings'
  | 'trash'
  | 'image'
  | 'code'
  | 'star'
  | 'circle'
  | 'dot'
  | 'home'

export interface ui_icons_options {
  /** Atlas edge length in texels. Defaults to {@link ICON_ATLAS_SIZE} (512). */
  atlas_size?: number
  /** Per-icon cell edge length in texels. Defaults to {@link ICON_CELL_SIZE} (32). */
  cell_size?: number
}

/**
 * A drawing pen handed to each icon path. It maps the 32-unit design grid onto
 * the icon's actual cell rectangle and forwards to the renderer's primitives, so
 * an icon path reads as plain `pen.line(...)` / `pen.ring(...)` calls regardless
 * of where (or at what scale) it is baked.
 */
class icon_pen {
  /** Scale from a design-grid unit to a texel. */
  private readonly k: number

  constructor(
    private readonly r: ui_renderer,
    private readonly ox: number,
    private readonly oy: number,
    cell: number,
    private readonly color: number,
  ) {
    this.k = cell / ICON_DESIGN_GRID
  }

  private x(g: number): number {
    return this.ox + g * this.k
  }

  private y(g: number): number {
    return this.oy + g * this.k
  }

  private feather(): number {
    // Roughly a half-texel soft edge keeps the baked shapes crisp but anti-aliased.
    return 0.6 * this.k
  }

  /** A straight stroke between two design-grid points. */
  line(x0: number, y0: number, x1: number, y1: number, thickness = 2): void {
    this.r.stroke_line(this.x(x0), this.y(y0), this.x(x1), this.y(y1), thickness * this.k, this.color, this.feather())
  }

  /** A connected open polyline through design-grid points `[x0,y0, x1,y1, …]`. */
  polyline(points: number[], thickness = 2): void {
    for (let i = 0; i + 3 < points.length; i += 2) {
      this.line(points[i] ?? 0, points[i + 1] ?? 0, points[i + 2] ?? 0, points[i + 3] ?? 0, thickness)
    }
  }

  /** A closed polyline through design-grid points `[x0,y0, …]`. */
  polygon(points: number[], thickness = 2): void {
    const n = points.length / 2
    for (let i = 0; i < n; i += 1) {
      const j = (i + 1) % n
      this.line(points[i * 2] ?? 0, points[i * 2 + 1] ?? 0, points[j * 2] ?? 0, points[j * 2 + 1] ?? 0, thickness)
    }
  }

  /** A (optionally rounded) rectangle outline in design-grid units. */
  rect(x: number, y: number, w: number, h: number, radius = 0, thickness = 2): void {
    this.r.stroke_round_rect(this.x(x), this.y(y), w * this.k, h * this.k, radius * this.k, thickness * this.k, this.color, this.feather())
  }

  /** A filled (optionally rounded) rectangle in design-grid units. */
  fill(x: number, y: number, w: number, h: number, radius = 0): void {
    this.r.fill_round_rect(this.x(x), this.y(y), w * this.k, h * this.k, radius * this.k, this.color, this.feather())
  }

  /** A filled triangle through three design-grid points. */
  tri(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): void {
    this.r.fill_triangle(this.x(x0), this.y(y0), this.x(x1), this.y(y1), this.x(x2), this.y(y2), this.color, this.feather())
  }

  /** A circle outline centred on a design-grid point. */
  ring(cx: number, cy: number, radius: number, thickness = 2): void {
    const d = radius * 2
    this.r.stroke_round_rect(this.x(cx - radius), this.y(cy - radius), d * this.k, d * this.k, radius * this.k, thickness * this.k, this.color, this.feather())
  }

  /** A filled disc centred on a design-grid point. */
  disc(cx: number, cy: number, radius: number): void {
    this.r.fill_circle(this.x(cx), this.y(cy), radius * this.k, this.color, this.feather())
  }
}

type icon_path = (p: icon_pen) => void

// All paths are authored on a 32×32 grid (origin top-left) with a small margin,
// so they tint cleanly and never touch the cell border (which would otherwise
// bleed under linear filtering when scaled up).
const ICON_PATHS: Record<ui_icon_name, icon_path> = {
  file: (p) => {
    p.polygon([8, 5, 20, 5, 24, 9, 24, 27, 8, 27])
    p.polyline([20, 5, 20, 9, 24, 9])
  },
  file_text: (p) => {
    p.polygon([8, 5, 20, 5, 24, 9, 24, 27, 8, 27])
    p.polyline([20, 5, 20, 9, 24, 9])
    p.line(11, 15, 21, 15, 1.6)
    p.line(11, 19, 21, 19, 1.6)
    p.line(11, 23, 18, 23, 1.6)
  },
  folder: (p) => {
    p.polygon([5, 24, 5, 9, 12, 9, 14, 11, 27, 11, 27, 24])
  },
  folder_open: (p) => {
    // Back panel.
    p.polyline([5, 22, 5, 9, 12, 9, 14, 11, 26, 11, 26, 15])
    // Front flap (a trapezoid that splays toward the bottom).
    p.polygon([8, 14, 28, 14, 24, 25, 4, 25])
  },
  chevron_right: (p) => p.polyline([13, 9, 20, 16, 13, 23]),
  chevron_down: (p) => p.polyline([9, 13, 16, 20, 23, 13]),
  chevron_up: (p) => p.polyline([9, 19, 16, 12, 23, 19]),
  chevron_left: (p) => p.polyline([19, 9, 12, 16, 19, 23]),
  plus: (p) => {
    p.line(16, 8, 16, 24)
    p.line(8, 16, 24, 16)
  },
  minus: (p) => p.line(8, 16, 24, 16),
  close: (p) => {
    p.line(9, 9, 23, 23)
    p.line(23, 9, 9, 23)
  },
  check: (p) => p.polyline([8, 17, 14, 23, 24, 9], 2.4),
  search: (p) => {
    p.ring(14, 14, 6)
    p.line(18.3, 18.3, 24, 24, 2.4)
  },
  settings: (p) => {
    const cx = 16
    const cy = 16
    p.ring(cx, cy, 5)
    p.disc(cx, cy, 1.6)
    for (let i = 0; i < 6; i += 1) {
      const a = (i / 6) * Math.PI * 2
      const dx = Math.cos(a)
      const dy = Math.sin(a)
      p.line(cx + dx * 6, cy + dy * 6, cx + dx * 9, cy + dy * 9, 2.2)
    }
  },
  trash: (p) => {
    p.line(7, 9, 25, 9, 2.2)
    p.polyline([13, 9, 13, 6.5, 19, 6.5, 19, 9])
    p.polygon([10, 9, 22, 9, 21, 26, 11, 26])
    p.line(14, 13, 14, 23, 1.6)
    p.line(18, 13, 18, 23, 1.6)
  },
  image: (p) => {
    p.rect(6, 7, 20, 18, 3)
    p.disc(12, 13, 1.8)
    p.polyline([8, 24, 14, 16, 19, 21, 26, 12])
  },
  code: (p) => {
    p.polyline([13, 10, 7, 16, 13, 22], 2.2)
    p.polyline([19, 10, 25, 16, 19, 22], 2.2)
  },
  star: (p) => {
    const cx = 16
    const cy = 16.5
    const outer = 10
    const inner = 4.2
    const pts: number[] = []
    for (let i = 0; i < 10; i += 1) {
      const a = -Math.PI / 2 + (i / 10) * Math.PI * 2
      const r = i % 2 === 0 ? outer : inner
      pts.push(cx + Math.cos(a) * r, cy + Math.sin(a) * r)
    }
    p.polygon(pts, 2)
  },
  circle: (p) => p.ring(16, 16, 9),
  dot: (p) => p.disc(16, 16, 4.5),
  home: (p) => {
    p.polyline([6, 16, 16, 6, 26, 16], 2.2)
    p.polygon([9, 16, 23, 16, 23, 26, 9, 26])
    p.polygon([13, 26, 13, 20, 18, 20, 18, 26])
  },
}

const ICON_NAMES = Object.keys(ICON_PATHS) as ui_icon_name[]

/**
 * Draw a built-in icon straight from its vector path using the renderer's
 * immediate-mode commands — no baked atlas texture required. Use this where a
 * cached {@link ui_icons} atlas isn't available (e.g. inside a plugin that only
 * has the renderer), at the cost of a few extra draw calls per icon.
 *
 * The icon fills a `size`×`size` box whose top-left is (x, y) and is tinted by
 * `color` (packed `0xAABBGGRR`; defaults to opaque white).
 */
export function draw_icon(
  renderer: ui_renderer,
  name: ui_icon_name,
  x: number,
  y: number,
  size = ICON_CELL_SIZE,
  color = 0xffffffff,
): void {
  const path = ICON_PATHS[name]
  if (!path) return
  path(new icon_pen(renderer, x, y, size, color))
}

/**
 * Bakes the built-in {@link ui_icon_name} set into one cached atlas texture and
 * draws (tinted) icons from it. Construct after `renderer.init()` has resolved.
 */
export class ui_icons {
  private readonly atlas_size: number
  private readonly cell_size: number
  private readonly columns: number
  private readonly cells = new Map<ui_icon_name, number>()
  private texture: GPUTexture | null = null
  private texture_id_ = -1

  constructor(private readonly renderer: ui_renderer, options?: ui_icons_options) {
    this.atlas_size = Math.max(1, Math.floor(options?.atlas_size ?? ICON_ATLAS_SIZE))
    this.cell_size = Math.max(1, Math.floor(options?.cell_size ?? ICON_CELL_SIZE))
    this.columns = Math.max(1, Math.floor(this.atlas_size / this.cell_size))
    const capacity = this.columns * this.columns
    ICON_NAMES.forEach((name, index) => {
      if (index < capacity) this.cells.set(name, index)
    })
    this.bake()
  }

  /** The renderer texture id of the icon atlas, or -1 if baking failed. */
  get texture_id(): number {
    return this.texture_id_
  }

  /** All icon names this instance knows how to draw. */
  names(): ui_icon_name[] {
    return [...this.cells.keys()]
  }

  /** Whether `name` is a known, baked icon. */
  has(name: ui_icon_name): boolean {
    return this.cells.has(name)
  }

  /**
   * Draw `name` at (x, y) sized `size`×`size` (defaults to the cell size),
   * tinted by `color` (packed `0xAABBGGRR`; defaults to opaque white — i.e. the
   * icon's baked colour untouched).
   */
  draw(name: ui_icon_name, x: number, y: number, size = this.cell_size, color = 0xffffffff): void {
    const cell = this.cells.get(name)
    if (cell === undefined || this.texture_id_ < 0) return
    const col = cell % this.columns
    const row = Math.floor(cell / this.columns)
    const inv = 1 / this.atlas_size
    const u0 = col * this.cell_size * inv
    const v0 = row * this.cell_size * inv
    const u1 = (col + 1) * this.cell_size * inv
    const v1 = (row + 1) * this.cell_size * inv
    this.renderer.draw_texture_region(this.texture_id_, x, y, size, size, u0, v0, u1, v1, color)
  }

  /**
   * (Re)bake every icon into the atlas texture. Safe to call again to refresh,
   * e.g. after a device reset. No-op until the renderer device is initialised.
   */
  bake(): void {
    const { device, format } = this.renderer.gpu()
    if (!device || !format) return

    if (!this.texture) {
      this.texture = device.createTexture({
        label: 'ui.icon_atlas',
        size: [this.atlas_size, this.atlas_size, 1],
        format,
        usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
      })
      this.texture_id_ = this.renderer.register_external_texture(this.texture)
    }

    // One pass: clear the whole atlas to transparent, then paint each icon white
    // into its cell so callers can tint it at draw time.
    this.renderer.render_to_texture(
      this.texture,
      this.atlas_size,
      this.atlas_size,
      () => {
        for (const [name, cell] of this.cells) {
          const col = cell % this.columns
          const row = Math.floor(cell / this.columns)
          const ox = col * this.cell_size
          const oy = row * this.cell_size
          const pen = new icon_pen(this.renderer, ox, oy, this.cell_size, 0xffffffff)
          ICON_PATHS[name](pen)
        }
      },
      { r: 0, g: 0, b: 0, a: 0 },
    )
  }
}
