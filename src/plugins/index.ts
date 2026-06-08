// @liamlangli/ui plugins — higher-level, drop-in components built on top of the
// renderer + widgets + dock engine, packaged so other projects can opt into
// them individually.
//
//   import { code_editor, dock_system, file_browser, im_dialog } from '@liamlangli/ui/plugins'
//
// Each plugin is self-contained: it owns its drawing and input handling and
// takes the host's `ui_renderer` (+ `ui_widgets` where needed), a
// `theme_definition`, and an `ui_input_snapshot`.

export * from './code_editor'
export * from './dock_system'
export * from './file_browser'
export * from './graph'
export * from './hori_split_view'
export * from './im_dialog'
export * from './ui_main_menu'
export * from './window_system'
