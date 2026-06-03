import { clamp } from './math'
import type { dock_layout, dock_leaf, dock_node, dock_split, dock_tab } from './types'

export type dock_drop_kind = 'none' | 'tabbar' | 'split-left' | 'split-right' | 'split-top' | 'split-bottom'

export interface dock_frame_leaf {
  leaf_id: string
  x: number
  y: number
  w: number
  h: number
  tab_bar_h: number
  tabs: dock_tab[]
  active_tab_id: string
}

export interface dock_frame_split {
  split_id: string
  axis: 'horizontal' | 'vertical'
  x: number
  y: number
  w: number
  h: number
  parent_x: number
  parent_y: number
  parent_w: number
  parent_h: number
}

export interface dock_frame {
  leaves: dock_frame_leaf[]
  splits: dock_frame_split[]
}

export interface dock_drag_state {
  armed: boolean
  active: boolean
  source_leaf_id: string | null
  source_tab_id: string | null
  source_tab_index: number
  source_tab_width: number
  start_x: number
  start_y: number
  grab_dx: number
  target_leaf_id: string | null
  target_tab_index: number
  drop_kind: dock_drop_kind
}

export const dock_tab_h = 27
export const dock_splitter_w = 8
export const dock_drag_start_d = 6
export const dock_split_min_w = 96
export const dock_split_min_h = 84

function make_leaf(id: string, ox: number, oy: number, ow: number, oh: number, tabs: dock_tab[], active_tab_id: string): dock_leaf {
  return { kind: 'leaf', id, ox, oy, ow, oh, tabs, active_tab_id }
}

function make_split(id: string, axis: 'horizontal' | 'vertical', ratio: number, left: dock_node, right: dock_node): dock_split {
  return { kind: 'split', id, axis, ratio, left, right }
}

function make_empty_root_leaf(): dock_leaf {
  return make_leaf('leaf-empty', 0, 0, 1, 1, [], '')
}

export function create_default_dock_layout(): dock_layout {
  const left = make_leaf(
    'leaf-outline',
    8,
    8,
    200,
    520,
    [{ id: 'outline', title: 'Outline' }],
    'outline',
  )
  const center = make_leaf(
    'leaf-viewport',
    216,
    8,
    440,
    520,
    [{ id: 'view3d', title: 'World Editor' }],
    'view3d',
  )
  const right = make_leaf(
    'leaf-sidebar',
    664,
    8,
    200,
    520,
    [{ id: 'inspector', title: 'Inspector' }],
    'inspector',
  )
  const bottom = make_leaf(
    'leaf-bottom',
    8,
    540,
    856,
    200,
    [
      { id: 'files', title: 'Files' },
      { id: 'console', title: 'Console' },
    ],
    'files',
  )
  const top_inner = make_split('split-top-inner', 'horizontal', 0.69, center, right)
  const top = make_split('split-top', 'horizontal', 0.20, left, top_inner)
  return {
    root: make_split('split-root', 'vertical', 0.72, top, bottom),
    next_id: 10,
    last_active_leaf_id: 'leaf-viewport',
  }
}

export function clone_dock_layout(layout: dock_layout): dock_layout {
  return JSON.parse(JSON.stringify(layout)) as dock_layout
}

export function restore_dock_layout(raw: unknown): dock_layout | null {
  if (!raw || typeof raw !== 'object') return null
  const layout = raw as dock_layout
  if (!layout.root || typeof layout.next_id !== 'number') return null
  return layout
}

export function serialize_dock_layout(layout: dock_layout): string {
  return JSON.stringify(layout)
}

export function tab_width(title: string, scale: number, measured_text_width?: number): number {
  const text_width = measured_text_width ?? title.length * 12.4 * scale
  return Math.max(24 * scale, text_width + 34 * scale)
}

export function compute_dock_frame(root: dock_node, x: number, y: number, w: number, h: number, scale: number): dock_frame {
  const leaves: dock_frame_leaf[] = []
  const splits: dock_frame_split[] = []
  const splitter = dock_splitter_w * scale

  const walk = (node: dock_node, nx: number, ny: number, nw: number, nh: number): void => {
    if (node.kind === 'leaf') {
      leaves.push({
        leaf_id: node.id,
        x: nx,
        y: ny,
        w: nw,
        h: nh,
        tab_bar_h: dock_tab_h * scale,
        tabs: node.tabs,
        active_tab_id: node.active_tab_id,
      })
      return
    }
    if (node.axis === 'horizontal') {
      const avail = nw - splitter
      const min_w = dock_split_min_w * scale
      const left_w = clamp(avail * node.ratio, min_w, Math.max(min_w, avail - min_w))
      const right_w = Math.max(min_w, avail - left_w)
      walk(node.left, nx, ny, left_w, nh)
      splits.push({
        split_id: node.id,
        axis: node.axis,
        x: nx + left_w,
        y: ny,
        w: splitter,
        h: nh,
        parent_x: nx,
        parent_y: ny,
        parent_w: nw,
        parent_h: nh,
      })
      walk(node.right, nx + left_w + splitter, ny, right_w, nh)
    } else {
      const avail = nh - splitter
      const min_h = dock_split_min_h * scale
      const top_h = clamp(avail * node.ratio, min_h, Math.max(min_h, avail - min_h))
      const bottom_h = Math.max(min_h, avail - top_h)
      walk(node.left, nx, ny, nw, top_h)
      splits.push({
        split_id: node.id,
        axis: node.axis,
        x: nx,
        y: ny + top_h,
        w: nw,
        h: splitter,
        parent_x: nx,
        parent_y: ny,
        parent_w: nw,
        parent_h: nh,
      })
      walk(node.right, nx, ny + top_h + splitter, nw, bottom_h)
    }
  }

  walk(root, x, y, w, h)
  return { leaves, splits }
}

export function find_leaf_by_id(layout: dock_layout, leaf_id: string): dock_leaf | null {
  let found: dock_leaf | null = null
  visit_dock_leaves(layout.root, (leaf) => {
    if (leaf.id === leaf_id) found = leaf
  })
  return found
}

export function visit_dock_leaves(node: dock_node, visit: (leaf: dock_leaf) => void): void {
  if (node.kind === 'leaf') {
    visit(node)
    return
  }
  visit_dock_leaves(node.left, visit)
  visit_dock_leaves(node.right, visit)
}

function find_parent(node: dock_node, child_id: string, parent: dock_split | null = null): dock_split | null {
  if (node.id === child_id) return parent
  if (node.kind === 'leaf') return null
  return find_parent(node.left, child_id, node) ?? find_parent(node.right, child_id, node)
}

function replace_child(node: dock_node, target_id: string, replacement: dock_node): dock_node {
  if (node.id === target_id) return replacement
  if (node.kind === 'leaf') return node
  return {
    ...node,
    left: replace_child(node.left, target_id, replacement),
    right: replace_child(node.right, target_id, replacement),
  }
}

function remove_empty_leaves(node: dock_node): dock_node | null {
  if (node.kind === 'leaf') {
    return node.tabs.length > 0 ? node : null
  }
  const left = remove_empty_leaves(node.left)
  const right = remove_empty_leaves(node.right)
  if (left && right) return { ...node, left, right }
  return left ?? right
}

function take_tab(leaf: dock_leaf, tab_id: string): dock_tab | null {
  const index = leaf.tabs.findIndex((tab) => tab.id === tab_id)
  if (index < 0) return null
  const [tab] = leaf.tabs.splice(index, 1)
  if (!leaf.tabs.find((item) => item.id === leaf.active_tab_id)) {
    leaf.active_tab_id = leaf.tabs[0]?.id ?? ''
  }
  return tab ?? null
}

export function activate_dock_tab(layout: dock_layout, leaf_id: string, tab_id: string): void {
  const leaf = find_leaf_by_id(layout, leaf_id)
  if (!leaf) return
  if (!leaf.tabs.find((tab) => tab.id === tab_id)) return
  leaf.active_tab_id = tab_id
  layout.last_active_leaf_id = leaf_id
}

export function move_dock_tab(layout: dock_layout, source_leaf_id: string, source_tab_id: string, target_leaf_id: string, target_index: number): void {
  const source_leaf = find_leaf_by_id(layout, source_leaf_id)
  const target_leaf = find_leaf_by_id(layout, target_leaf_id)
  if (!source_leaf || !target_leaf) return
  const tab = take_tab(source_leaf, source_tab_id)
  if (!tab) return

  let insert_index = clamp(target_index, 0, target_leaf.tabs.length)
  if (source_leaf.id === target_leaf.id) {
    const old_index = target_leaf.tabs.findIndex((item) => item.id === source_tab_id)
    if (old_index >= 0 && insert_index > old_index) insert_index -= 1
  }
  target_leaf.tabs.splice(insert_index, 0, tab)
  target_leaf.active_tab_id = tab.id
  layout.last_active_leaf_id = target_leaf.id

  const pruned = remove_empty_leaves(layout.root)
  if (pruned) layout.root = pruned
}

export function close_dock_tab(layout: dock_layout, leaf_id: string, tab_id: string): void {
  const leaf = find_leaf_by_id(layout, leaf_id)
  if (!leaf) return
  take_tab(leaf, tab_id)
  const pruned = remove_empty_leaves(layout.root)
  if (pruned) {
    layout.root = pruned
  } else {
    layout.root = make_empty_root_leaf()
    layout.last_active_leaf_id = null
  }
  if (layout.last_active_leaf_id && !find_leaf_by_id(layout, layout.last_active_leaf_id)) {
    let fallback_leaf_id: string | null = null
    visit_dock_leaves(layout.root, (item) => {
      if (!fallback_leaf_id) fallback_leaf_id = item.id
    })
    layout.last_active_leaf_id = fallback_leaf_id
  }
}

function insert_split(layout: dock_layout, target_leaf_id: string, new_leaf: dock_leaf, drop_kind: dock_drop_kind): void {
  const target_leaf = find_leaf_by_id(layout, target_leaf_id)
  if (!target_leaf) return
  const axis = drop_kind === 'split-left' || drop_kind === 'split-right' ? 'horizontal' : 'vertical'
  const new_split: dock_split = {
    kind: 'split',
    id: `split-${layout.next_id++}`,
    axis,
    ratio: drop_kind === 'split-left' || drop_kind === 'split-top' ? 0.38 : 0.62,
    left: drop_kind === 'split-left' || drop_kind === 'split-top' ? new_leaf : target_leaf,
    right: drop_kind === 'split-left' || drop_kind === 'split-top' ? target_leaf : new_leaf,
  }

  if (layout.root.id === target_leaf_id) {
    layout.root = new_split
    return
  }
  layout.root = replace_child(layout.root, target_leaf_id, new_split)
}

export function split_dock_tab(layout: dock_layout, source_leaf_id: string, source_tab_id: string, target_leaf_id: string, drop_kind: dock_drop_kind): void {
  const source_leaf = find_leaf_by_id(layout, source_leaf_id)
  const target_leaf = find_leaf_by_id(layout, target_leaf_id)
  if (!source_leaf || !target_leaf) return
  if (source_leaf_id === target_leaf_id && source_leaf.tabs.length <= 1) return
  const tab = take_tab(source_leaf, source_tab_id)
  if (!tab) return
  const new_leaf: dock_leaf = {
    kind: 'leaf',
    id: `leaf-${layout.next_id++}`,
    tabs: [tab],
    active_tab_id: tab.id,
    ox: target_leaf.ox,
    oy: target_leaf.oy,
    ow: target_leaf.ow,
    oh: target_leaf.oh,
  }
  insert_split(layout, target_leaf_id, new_leaf, drop_kind)
  layout.last_active_leaf_id = new_leaf.id
  const pruned = remove_empty_leaves(layout.root)
  if (pruned) layout.root = pruned
}

export function set_dock_split_ratio(layout: dock_layout, split_id: string, ratio: number): void {
  const walk = (node: dock_node): void => {
    if (node.kind === 'leaf') return
    if (node.id === split_id) {
      node.ratio = clamp(ratio, 0.2, 0.8)
      return
    }
    walk(node.left)
    walk(node.right)
  }
  walk(layout.root)
}

export function count_dock_leaves(node: dock_node): number {
  if (node.kind === 'leaf') return 1
  return count_dock_leaves(node.left) + count_dock_leaves(node.right)
}

export function count_dock_tabs(node: dock_node): number {
  if (node.kind === 'leaf') return node.tabs.length
  return count_dock_tabs(node.left) + count_dock_tabs(node.right)
}

export function spawn_dock_tab(layout: dock_layout, tab: dock_tab): boolean {
  const target_leaf_id = layout.last_active_leaf_id
  let target_leaf = target_leaf_id ? find_leaf_by_id(layout, target_leaf_id) : null
  if (!target_leaf) {
    visit_dock_leaves(layout.root, (leaf) => {
      if (!target_leaf) target_leaf = leaf
    })
  }
  if (!target_leaf) return false
  if (target_leaf.tabs.some((item) => item.id === tab.id)) {
    target_leaf.active_tab_id = tab.id
    layout.last_active_leaf_id = target_leaf.id
    return true
  }
  target_leaf.tabs.push(tab)
  target_leaf.active_tab_id = tab.id
  layout.last_active_leaf_id = target_leaf.id
  return true
}

export function tab_insert_index(frame_leaf: dock_frame_leaf, x: number, scale: number, measure_tab_width?: (title: string) => number): number {
  let cursor = frame_leaf.x + 4 * scale
  for (let index = 0; index < frame_leaf.tabs.length; index += 1) {
    const title = frame_leaf.tabs[index].title
    const w = tab_width(title, scale, measure_tab_width?.(title))
    if (x < cursor + w * 0.5) return index
    cursor += w + 4 * scale
  }
  return frame_leaf.tabs.length
}

export function resolve_dock_drop(
  frame: dock_frame,
  x: number,
  y: number,
  scale: number,
  measure_tab_width?: (title: string) => number,
): { target_leaf_id: string | null; target_tab_index: number; drop_kind: dock_drop_kind } {
  for (const leaf of frame.leaves) {
    if (x < leaf.x || x > leaf.x + leaf.w || y < leaf.y || y > leaf.y + leaf.h) continue
    if (y <= leaf.y + leaf.tab_bar_h) {
      return { target_leaf_id: leaf.leaf_id, target_tab_index: tab_insert_index(leaf, x, scale, measure_tab_width), drop_kind: 'tabbar' }
    }
    const body_y = leaf.y + leaf.tab_bar_h
    const body_h = leaf.h - leaf.tab_bar_h
    const edge_x = leaf.w * 0.25
    const edge_y = body_h * 0.25
    if (x < leaf.x + edge_x) return { target_leaf_id: leaf.leaf_id, target_tab_index: leaf.tabs.length, drop_kind: 'split-left' }
    if (x > leaf.x + leaf.w - edge_x) return { target_leaf_id: leaf.leaf_id, target_tab_index: leaf.tabs.length, drop_kind: 'split-right' }
    if (y < body_y + edge_y) return { target_leaf_id: leaf.leaf_id, target_tab_index: leaf.tabs.length, drop_kind: 'split-top' }
    if (y > body_y + body_h - edge_y) return { target_leaf_id: leaf.leaf_id, target_tab_index: leaf.tabs.length, drop_kind: 'split-bottom' }
    return { target_leaf_id: leaf.leaf_id, target_tab_index: leaf.tabs.length, drop_kind: 'tabbar' }
  }
  return { target_leaf_id: null, target_tab_index: -1, drop_kind: 'none' }
}
