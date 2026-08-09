import assert from 'node:assert/strict'
import fs from 'node:fs'

import create_box3d_module from '../src/physics/wasm/ui_box3d.js'

const wasm_url = new URL('../src/physics/wasm/ui_box3d.wasm', import.meta.url)
const module = await create_box3d_module({ wasmBinary: fs.readFileSync(wasm_url) })
const output_count = 9
const output_pointer = module._malloc(output_count * Float32Array.BYTES_PER_ELEMENT)

function result() {
  return Array.from(module.HEAPF32.subarray(
    output_pointer >>> 2,
    (output_pointer >>> 2) + output_count,
  ))
}

function move(px, py, pz, move_x, move_y, move_z) {
  assert.equal(module._ui_box3d_move_capsule(
    px, py, pz,
    -0.7, 0.7, 0.3,
    move_x, move_y, move_z,
    output_pointer,
  ), 1)
  return result()
}

try {
  assert.equal(module._ui_box3d_create_world(), 1)
  assert.equal(module._ui_box3d_add_box(0, 0, 0, 0, 0, 0, 1, 5, 0.5, 5), 1)
  const floor = move(0, 2, 0, 0, -3, 0)
  assert.ok(Math.abs(floor[1] - 1.495) < 0.001, `unexpected box floor y: ${floor[1]}`)
  assert.equal(floor[6], 1)

  assert.equal(module._ui_box3d_add_box(2, 1.5, 0, 0, 0, 0, 1, 0.25, 2, 5), 1)
  const wall = move(0, 1.5, 0, 4, -0.01, 1)
  assert.ok(wall[0] > 1.4 && wall[0] < 1.5, `unexpected wall stop x: ${wall[0]}`)
  assert.ok(Math.abs(wall[2] - 1) < 0.001, `wall sweep did not preserve slide: ${wall[2]}`)

  module._ui_box3d_destroy_world()
  assert.equal(module._ui_box3d_create_world(), 1)
  const heights = new Float32Array(9)
  const heights_pointer = module._malloc(heights.byteLength)
  try {
    module.HEAPF32.set(heights, heights_pointer >>> 2)
    assert.equal(module._ui_box3d_add_height_field(0, 0, 0, 4, 1, 4, 3, 3, heights_pointer), 1)
  } finally {
    module._free(heights_pointer)
  }
  const height_field = move(0, 2, 0, 0, -3, 0)
  assert.ok(Math.abs(height_field[1] - 0.995) < 0.001, `unexpected height-field y: ${height_field[1]}`)
  assert.equal(height_field[6], 1)

  module._ui_box3d_destroy_world()
  assert.equal(module._ui_box3d_create_world(), 1)
  module._ui_box3d_set_gravity(0, -9.81, 0)
  assert.equal(module._ui_box3d_add_box(0, -0.5, 0, 0, 0, 0, 1, 5, 0.5, 5), 1)
  const sphere_handle = module._ui_box3d_add_dynamic_sphere(0, 3, 0, 0.5)
  assert.ok(sphere_handle > 0)
  for (let i = 0; i < 240; i += 1) module._ui_box3d_step(1 / 60, 4)
  assert.equal(module._ui_box3d_get_body_transform(sphere_handle, output_pointer), 1)
  const body = result()
  assert.ok(body[1] > 0.48 && body[1] < 0.55, `unexpected resting sphere y: ${body[1]}`)
  assert.ok(Math.abs(body[0]) < 0.01 && Math.abs(body[2]) < 0.01, `sphere drifted: ${body[0]}, ${body[2]}`)
} finally {
  module._free(output_pointer)
  module._ui_box3d_destroy_world()
}

console.log('Box3D WASM smoke test passed')
