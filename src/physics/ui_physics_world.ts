import create_box3d_module, { type ui_box3d_module } from './wasm/ui_box3d.js'

/** The 3D physics implementation bundled by @liamlangli/ui. */
export const default_physics_engine = 'box3d' as const

export interface physics_vector3 {
  x: number
  y: number
  z: number
}

export interface physics_quaternion extends physics_vector3 {
  w: number
}

export interface physics_transform {
  position: physics_vector3
  rotation: physics_quaternion
}

export interface capsule_move_result {
  position: physics_vector3
  delta: physics_vector3
  grounded: boolean
  support_y: number
  ceiling_y: number
}

export interface physics_world_options {
  /** Override the emitted WASM URL, primarily for non-Vite hosts and tests. */
  wasm_url?: string | URL
}

export function quaternion_from_euler(rotation: physics_vector3): physics_quaternion {
  const sx = Math.sin(rotation.x * 0.5)
  const cx = Math.cos(rotation.x * 0.5)
  const sy = Math.sin(rotation.y * 0.5)
  const cy = Math.cos(rotation.y * 0.5)
  const sz = Math.sin(rotation.z * 0.5)
  const cz = Math.cos(rotation.z * 0.5)
  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  }
}

/**
 * Isolated Box3D world used for rigid-body simulation, static scene collision,
 * and swept character movement. Each instance owns its own Emscripten module,
 * so worlds do not share Box3D state.
 */
export class physics_world {
  readonly engine = default_physics_engine
  private active = false
  private transform_pointer = 0

  private constructor(private readonly module: ui_box3d_module) {}

  static async create(options: physics_world_options = {}): Promise<physics_world> {
    const wasm_url = options.wasm_url
      ? String(options.wasm_url)
      : new URL('./wasm/ui_box3d.wasm', import.meta.url).href
    const module = await create_box3d_module({
      locateFile: (path) => path.endsWith('.wasm') ? wasm_url : path,
    })
    return new physics_world(module)
  }

  /** Clears the old state and starts an empty physics world. */
  reset(): void {
    if (this.active) this.module._ui_box3d_destroy_world()
    this.active = this.module._ui_box3d_create_world() !== 0
    if (!this.active) throw new Error('Box3D world creation failed')
  }

  /** Releases all bodies while keeping the loaded WASM module reusable. */
  clear(): void {
    if (!this.active) return
    this.module._ui_box3d_destroy_world()
    this.active = false
  }

  dispose(): void {
    this.clear()
    if (this.transform_pointer) {
      this.module._free(this.transform_pointer)
      this.transform_pointer = 0
    }
  }

  set_gravity(gravity: physics_vector3): void {
    if (this.active) this.module._ui_box3d_set_gravity(gravity.x, gravity.y, gravity.z)
  }

  step(time_step: number, sub_step_count = 4): void {
    if (this.active) this.module._ui_box3d_step(time_step, sub_step_count)
  }

  add_box(position: physics_vector3, rotation: physics_quaternion, half_size: physics_vector3): boolean {
    return this.active && this.module._ui_box3d_add_box(
      position.x, position.y, position.z,
      rotation.x, rotation.y, rotation.z, rotation.w,
      half_size.x, half_size.y, half_size.z,
    ) !== 0
  }

  add_sphere(position: physics_vector3, radius: number): boolean {
    return this.active && this.module._ui_box3d_add_sphere(position.x, position.y, position.z, radius) !== 0
  }

  add_dynamic_box(position: physics_vector3, rotation: physics_quaternion, half_size: physics_vector3): number {
    if (!this.active) return 0
    return this.module._ui_box3d_add_dynamic_box(
      position.x, position.y, position.z,
      rotation.x, rotation.y, rotation.z, rotation.w,
      half_size.x, half_size.y, half_size.z,
    )
  }

  add_dynamic_sphere(position: physics_vector3, radius: number): number {
    if (!this.active) return 0
    return this.module._ui_box3d_add_dynamic_sphere(position.x, position.y, position.z, radius)
  }

  body_transform(handle: number): physics_transform | null {
    const output_count = 7
    const pointer = this.transform_pointer || this.module._malloc(output_count * Float32Array.BYTES_PER_ELEMENT)
    if (!pointer) throw new Error('Box3D transform allocation failed')
    this.transform_pointer = pointer
    if (!this.active || this.module._ui_box3d_get_body_transform(handle, pointer) === 0) return null
    const output = this.module.HEAPF32.subarray(pointer >>> 2, (pointer >>> 2) + output_count)
    return {
      position: { x: output[0]!, y: output[1]!, z: output[2]! },
      rotation: { x: output[3]!, y: output[4]!, z: output[5]!, w: output[6]! },
    }
  }

  add_height_field(
    position: physics_vector3,
    extent_x: number,
    height_scale: number,
    extent_z: number,
    side: number,
    heights: Float32Array,
  ): boolean {
    if (!this.active || heights.length !== side * side) return false
    const pointer = this.module._malloc(heights.byteLength)
    if (!pointer) return false
    try {
      this.module.HEAPF32.set(heights, pointer >>> 2)
      return this.module._ui_box3d_add_height_field(
        position.x, position.y, position.z,
        extent_x, height_scale, extent_z,
        side, side, pointer,
      ) !== 0
    } finally {
      this.module._free(pointer)
    }
  }

  move_capsule(
    position: physics_vector3,
    bottom_center: number,
    top_center: number,
    radius: number,
    translation: physics_vector3,
  ): capsule_move_result {
    const output_count = 9
    const pointer = this.module._malloc(output_count * Float32Array.BYTES_PER_ELEMENT)
    if (!pointer) throw new Error('Box3D result allocation failed')
    try {
      const moved = this.active && this.module._ui_box3d_move_capsule(
        position.x, position.y, position.z,
        bottom_center, top_center, radius,
        translation.x, translation.y, translation.z,
        pointer,
      ) !== 0
      if (!moved) {
        return {
          position: {
            x: position.x + translation.x,
            y: position.y + translation.y,
            z: position.z + translation.z,
          },
          delta: { ...translation },
          grounded: false,
          support_y: 0,
          ceiling_y: 0,
        }
      }
      const output = this.module.HEAPF32.subarray(pointer >>> 2, (pointer >>> 2) + output_count)
      return {
        position: { x: output[0]!, y: output[1]!, z: output[2]! },
        delta: { x: output[3]!, y: output[4]!, z: output[5]! },
        grounded: output[6]! > 0.5,
        support_y: output[7]!,
        ceiling_y: output[8]!,
      }
    } finally {
      this.module._free(pointer)
    }
  }
}
