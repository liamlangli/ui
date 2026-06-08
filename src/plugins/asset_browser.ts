// asset_browser — compatibility wrapper for the unified file_browser plugin.
//
// New code should prefer `file_browser(...)`. This module keeps the older
// asset_browser imports working while sharing the same implementation.

import type { theme_definition } from '../types'
import { ui_renderer } from '../ui_renderer'
import type { ui_input_snapshot, ui_scroll_state } from '../ui_widgets'
import {
  create_file_browser_state,
  file_browser,
  type file_browser_entry,
  type file_browser_event,
  type file_browser_folder_node,
  type file_browser_options,
  type file_browser_state,
  type file_browser_toolbar_button,
} from './file_browser'

export type asset_folder_node = file_browser_folder_node
export type asset_entry = file_browser_entry
export type asset_toolbar_button = file_browser_toolbar_button
export type asset_browser_options = file_browser_options
export type asset_browser_event = file_browser_event

export interface asset_browser_state extends file_browser_state {
  selected_folder: string
  selected_paths: string[]
  collapsed: Set<string>
  split_ratio: number
  grid_scroll: ui_scroll_state
  tree_scroll: ui_scroll_state
  _dragging_split: boolean
  last_click_path: string | null
}

export function create_asset_browser_state(initial_folder = 'Project'): asset_browser_state {
  return create_file_browser_state(initial_folder) as asset_browser_state
}

export function asset_browser(
  ui: ui_renderer,
  theme: theme_definition,
  input: ui_input_snapshot,
  x: number,
  y: number,
  w: number,
  h: number,
  folders: asset_folder_node[],
  entries: asset_entry[],
  state: asset_browser_state,
  options?: asset_browser_options,
): asset_browser_event {
  return file_browser(ui, theme, input, x, y, w, h, folders, entries, state, options)
}
