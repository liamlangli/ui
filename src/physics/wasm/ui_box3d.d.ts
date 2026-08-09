export interface ui_box3d_module {
  HEAPF32: Float32Array
  _malloc(bytes: number): number
  _free(pointer: number): void
  _ui_box3d_create_world(): number
  _ui_box3d_destroy_world(): void
  _ui_box3d_set_gravity(x: number, y: number, z: number): void
  _ui_box3d_step(time_step: number, sub_step_count: number): void
  _ui_box3d_add_box(
    px: number, py: number, pz: number,
    qx: number, qy: number, qz: number, qw: number,
    half_x: number, half_y: number, half_z: number,
  ): number
  _ui_box3d_add_sphere(px: number, py: number, pz: number, radius: number): number
  _ui_box3d_add_dynamic_box(
    px: number, py: number, pz: number,
    qx: number, qy: number, qz: number, qw: number,
    half_x: number, half_y: number, half_z: number,
  ): number
  _ui_box3d_add_dynamic_sphere(px: number, py: number, pz: number, radius: number): number
  _ui_box3d_get_body_transform(handle: number, output: number): number
  _ui_box3d_add_height_field(
    px: number, py: number, pz: number,
    extent_x: number, height_scale: number, extent_z: number,
    count_x: number, count_z: number, heights: number,
  ): number
  _ui_box3d_move_capsule(
    px: number, py: number, pz: number,
    bottom_center: number, top_center: number, radius: number,
    move_x: number, move_y: number, move_z: number,
    output: number,
  ): number
}

export interface ui_box3d_module_options {
  locateFile?: (path: string) => string
}

export default function create_box3d_module(options?: ui_box3d_module_options): Promise<ui_box3d_module>
