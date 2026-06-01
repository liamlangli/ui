export type theme_slot =
  | 'bg'
  | 'panel'
  | 'panel_alt'
  | 'border'
  | 'border_strong'
  | 'text'
  | 'text_dim'
  | 'hover'
  | 'active'
  | 'selected'
  | 'accent'
  | 'accent_dim'
  | 'scene_outline'
  | 'gizmo_axis_x'
  | 'gizmo_axis_y'
  | 'gizmo_axis_z'
  | 'gizmo_center'
  | 'track'
  | 'overlay'
  | 'ghost'

export interface theme_definition {
  css: Record<string, string>
  palette: Record<theme_slot, string>
}

export interface dock_tab {
  id: string
  title: string
  dirty?: boolean
}

export interface dock_leaf {
  kind: 'leaf'
  id: string
  tabs: dock_tab[]
  active_tab_id: string
  ox: number
  oy: number
  ow: number
  oh: number
}

export interface dock_split {
  kind: 'split'
  id: string
  axis: 'horizontal' | 'vertical'
  ratio: number
  left: dock_node
  right: dock_node
}

export type dock_node = dock_leaf | dock_split

export interface dock_layout {
  root: dock_node
  next_id: number
  last_active_leaf_id: string | null
}
