// SPDX-FileCopyrightText: 2026 @liamlangli/ui contributors
// SPDX-License-Identifier: MIT

#include "box3d/box3d.h"

#include <float.h>
#include <math.h>
#include <stdbool.h>
#include <stdint.h>

#if defined(__EMSCRIPTEN__)
#include <emscripten/emscripten.h>
#define UI_EXPORT EMSCRIPTEN_KEEPALIVE
#else
#define UI_EXPORT
#endif

#define UI_MAX_HEIGHT_FIELDS 128
#define UI_MAX_DYNAMIC_BODIES 256
#define UI_MAX_PLANES 16
#define UI_MOVE_ITERATIONS 5

static b3WorldId ui_world_id;
static bool ui_world_created;
static b3HeightFieldData* ui_height_fields[UI_MAX_HEIGHT_FIELDS];
static int ui_height_field_count;
static b3BodyId ui_dynamic_bodies[UI_MAX_DYNAMIC_BODIES];
static int ui_dynamic_body_count;

typedef struct ui_plane_context
{
  b3CollisionPlane planes[UI_MAX_PLANES];
  int count;
} ui_plane_context;

static float ui_positive(float value, float minimum)
{
  return isfinite(value) && value > minimum ? value : minimum;
}

static b3Quat ui_quaternion(float x, float y, float z, float w)
{
  float length = sqrtf(x * x + y * y + z * z + w * w);
  if (length < 0.000001f)
  {
    return b3Quat_identity;
  }
  float inverse = 1.0f / length;
  return (b3Quat){ { x * inverse, y * inverse, z * inverse }, w * inverse };
}

static bool ui_collect_planes(b3ShapeId shape_id, const b3PlaneResult* results, int count, void* context)
{
  (void)shape_id;
  ui_plane_context* target = context;
  for (int index = 0; index < count && target->count < UI_MAX_PLANES; ++index)
  {
    target->planes[target->count] = (b3CollisionPlane){
      .plane = results[index].plane,
      .pushLimit = FLT_MAX,
      .push = 0.0f,
      .clipVelocity = true,
    };
    target->count += 1;
  }
  return true;
}

static ui_plane_context ui_mover_planes(b3Pos position, const b3Capsule* capsule)
{
  ui_plane_context context = { 0 };
  b3QueryFilter filter = b3DefaultQueryFilter();
  b3World_CollideMover(ui_world_id, position, capsule, filter, ui_collect_planes, &context);
  return context;
}

UI_EXPORT int ui_box3d_create_world(void)
{
  if (ui_world_created)
  {
    return 1;
  }
  b3WorldDef definition = b3DefaultWorldDef();
  definition.gravity = b3Vec3_zero;
  definition.enableSleep = false;
  definition.workerCount = 1;
  ui_world_id = b3CreateWorld(&definition);
  ui_world_created = b3World_IsValid(ui_world_id);
  ui_dynamic_body_count = 0;
  return ui_world_created ? 1 : 0;
}

UI_EXPORT void ui_box3d_destroy_world(void)
{
  if (ui_world_created)
  {
    b3DestroyWorld(ui_world_id);
    ui_world_created = false;
  }
  ui_dynamic_body_count = 0;
  for (int index = 0; index < ui_height_field_count; ++index)
  {
    b3DestroyHeightField(ui_height_fields[index]);
    ui_height_fields[index] = NULL;
  }
  ui_height_field_count = 0;
}

UI_EXPORT void ui_box3d_set_gravity(float x, float y, float z)
{
  if (!ui_world_created || !isfinite(x) || !isfinite(y) || !isfinite(z))
  {
    return;
  }
  b3World_SetGravity(ui_world_id, (b3Vec3){ x, y, z });
}

UI_EXPORT void ui_box3d_step(float time_step, int sub_step_count)
{
  if (!ui_world_created || !isfinite(time_step) || time_step <= 0.0f)
  {
    return;
  }
  float safe_time_step = fminf(time_step, 0.1f);
  int safe_sub_steps = sub_step_count < 1 ? 1 : sub_step_count > 16 ? 16 : sub_step_count;
  b3World_Step(ui_world_id, safe_time_step, safe_sub_steps);
}

UI_EXPORT int ui_box3d_add_box(
  float px, float py, float pz,
  float qx, float qy, float qz, float qw,
  float half_x, float half_y, float half_z)
{
  if (!ui_world_created)
  {
    return 0;
  }
  b3BodyDef body_definition = b3DefaultBodyDef();
  body_definition.position = (b3Pos){ px, py, pz };
  body_definition.rotation = ui_quaternion(qx, qy, qz, qw);
  b3BodyId body_id = b3CreateBody(ui_world_id, &body_definition);
  b3ShapeDef shape_definition = b3DefaultShapeDef();
  b3BoxHull box = b3MakeBoxHull(
    ui_positive(fabsf(half_x), 0.0001f),
    ui_positive(fabsf(half_y), 0.0001f),
    ui_positive(fabsf(half_z), 0.0001f));
  b3ShapeId shape_id = b3CreateHullShape(body_id, &shape_definition, &box.base);
  return b3Shape_IsValid(shape_id) ? 1 : 0;
}

UI_EXPORT int ui_box3d_add_sphere(float px, float py, float pz, float radius)
{
  if (!ui_world_created)
  {
    return 0;
  }
  b3BodyDef body_definition = b3DefaultBodyDef();
  body_definition.position = (b3Pos){ px, py, pz };
  b3BodyId body_id = b3CreateBody(ui_world_id, &body_definition);
  b3ShapeDef shape_definition = b3DefaultShapeDef();
  b3Sphere sphere = { b3Vec3_zero, ui_positive(fabsf(radius), 0.0001f) };
  b3ShapeId shape_id = b3CreateSphereShape(body_id, &shape_definition, &sphere);
  return b3Shape_IsValid(shape_id) ? 1 : 0;
}

UI_EXPORT int ui_box3d_add_dynamic_box(
  float px, float py, float pz,
  float qx, float qy, float qz, float qw,
  float half_x, float half_y, float half_z)
{
  if (!ui_world_created || ui_dynamic_body_count >= UI_MAX_DYNAMIC_BODIES)
  {
    return 0;
  }
  b3BodyDef body_definition = b3DefaultBodyDef();
  body_definition.type = b3_dynamicBody;
  body_definition.position = (b3Pos){ px, py, pz };
  body_definition.rotation = ui_quaternion(qx, qy, qz, qw);
  b3BodyId body_id = b3CreateBody(ui_world_id, &body_definition);
  b3ShapeDef shape_definition = b3DefaultShapeDef();
  b3BoxHull box = b3MakeBoxHull(
    ui_positive(fabsf(half_x), 0.0001f),
    ui_positive(fabsf(half_y), 0.0001f),
    ui_positive(fabsf(half_z), 0.0001f));
  b3ShapeId shape_id = b3CreateHullShape(body_id, &shape_definition, &box.base);
  if (!b3Shape_IsValid(shape_id))
  {
    b3DestroyBody(body_id);
    return 0;
  }
  ui_dynamic_bodies[ui_dynamic_body_count] = body_id;
  ui_dynamic_body_count += 1;
  return ui_dynamic_body_count;
}

UI_EXPORT int ui_box3d_add_dynamic_sphere(float px, float py, float pz, float radius)
{
  if (!ui_world_created || ui_dynamic_body_count >= UI_MAX_DYNAMIC_BODIES)
  {
    return 0;
  }
  b3BodyDef body_definition = b3DefaultBodyDef();
  body_definition.type = b3_dynamicBody;
  body_definition.position = (b3Pos){ px, py, pz };
  b3BodyId body_id = b3CreateBody(ui_world_id, &body_definition);
  b3ShapeDef shape_definition = b3DefaultShapeDef();
  b3Sphere sphere = { b3Vec3_zero, ui_positive(fabsf(radius), 0.0001f) };
  b3ShapeId shape_id = b3CreateSphereShape(body_id, &shape_definition, &sphere);
  if (!b3Shape_IsValid(shape_id))
  {
    b3DestroyBody(body_id);
    return 0;
  }
  ui_dynamic_bodies[ui_dynamic_body_count] = body_id;
  ui_dynamic_body_count += 1;
  return ui_dynamic_body_count;
}

UI_EXPORT int ui_box3d_get_body_transform(int handle, float* output)
{
  int index = handle - 1;
  if (!ui_world_created || output == NULL || index < 0 || index >= ui_dynamic_body_count)
  {
    return 0;
  }
  b3BodyId body_id = ui_dynamic_bodies[index];
  if (!b3Body_IsValid(body_id))
  {
    return 0;
  }
  b3Pos position = b3Body_GetPosition(body_id);
  b3Quat rotation = b3Body_GetRotation(body_id);
  output[0] = position.x;
  output[1] = position.y;
  output[2] = position.z;
  output[3] = rotation.v.x;
  output[4] = rotation.v.y;
  output[5] = rotation.v.z;
  output[6] = rotation.s;
  return 1;
}

UI_EXPORT int ui_box3d_add_height_field(
  float px, float py, float pz,
  float extent_x, float height_scale, float extent_z,
  int count_x, int count_z,
  float* heights)
{
  if (!ui_world_created || heights == NULL || count_x < 2 || count_z < 2 ||
      ui_height_field_count >= UI_MAX_HEIGHT_FIELDS)
  {
    return 0;
  }
  b3HeightFieldDef height_definition = {
    .heights = heights,
    .materialIndices = NULL,
    .scale = {
      ui_positive(fabsf(extent_x) / (float)(count_x - 1), 0.0001f),
      ui_positive(fabsf(height_scale), 0.0001f),
      ui_positive(fabsf(extent_z) / (float)(count_z - 1), 0.0001f),
    },
    .countX = count_x,
    .countZ = count_z,
    .globalMinimumHeight = -1.0f,
    .globalMaximumHeight = 1.0f,
    .clockwiseWinding = false,
  };
  b3HeightFieldData* height_field = b3CreateHeightField(&height_definition);
  if (height_field == NULL)
  {
    return 0;
  }
  b3BodyDef body_definition = b3DefaultBodyDef();
  body_definition.position = (b3Pos){ px - 0.5f * fabsf(extent_x), py, pz - 0.5f * fabsf(extent_z) };
  b3BodyId body_id = b3CreateBody(ui_world_id, &body_definition);
  b3ShapeDef shape_definition = b3DefaultShapeDef();
  b3ShapeId shape_id = b3CreateHeightFieldShape(body_id, &shape_definition, height_field);
  if (!b3Shape_IsValid(shape_id))
  {
    b3DestroyBody(body_id);
    b3DestroyHeightField(height_field);
    return 0;
  }
  ui_height_fields[ui_height_field_count] = height_field;
  ui_height_field_count += 1;
  return 1;
}

/**
 * Sweeps and resolves a vertical capsule. `output` receives position xyz,
 * actual delta xyz, grounded (0/1), and the strongest supporting normal y.
 */
UI_EXPORT int ui_box3d_move_capsule(
  float px, float py, float pz,
  float bottom_center, float top_center, float radius,
  float move_x, float move_y, float move_z,
  float* output)
{
  if (!ui_world_created || output == NULL)
  {
    return 0;
  }
  float safe_radius = ui_positive(fabsf(radius), 0.0001f);
  float low = fminf(bottom_center, top_center);
  float high = fmaxf(bottom_center, top_center);
  b3Capsule capsule = {
    { 0.0f, low, 0.0f },
    { 0.0f, high, 0.0f },
    safe_radius,
  };
  b3Pos start = { px, py, pz };
  b3Pos position = start;
  b3Pos target = { px + move_x, py + move_y, pz + move_z };
  b3QueryFilter filter = b3DefaultQueryFilter();

  for (int iteration = 0; iteration < UI_MOVE_ITERATIONS; ++iteration)
  {
    ui_plane_context planes = ui_mover_planes(position, &capsule);
    b3Vec3 target_delta = {
      target.x - position.x,
      target.y - position.y,
      target.z - position.z,
    };
    b3PlaneSolverResult solved = b3SolvePlanes(target_delta, planes.planes, planes.count);
    float fraction = b3World_CastMover(ui_world_id, position, &capsule, solved.delta, filter, NULL, NULL);
    b3Vec3 delta = b3MulSV(fraction, solved.delta);
    position = b3OffsetPos(position, delta);
    if (b3LengthSquared(delta) < 0.00000001f)
    {
      break;
    }
  }

  // A final zero-target solve removes any residual overlap and gives the
  // supporting planes used for grounded state.
  ui_plane_context support = ui_mover_planes(position, &capsule);
  b3PlaneSolverResult correction = b3SolvePlanes(b3Vec3_zero, support.planes, support.count);
  position = b3OffsetPos(position, correction.delta);
  float support_y = 0.0f;
  float ceiling_y = 0.0f;
  for (int index = 0; index < support.count; ++index)
  {
    support_y = fmaxf(support_y, support.planes[index].plane.normal.y);
    ceiling_y = fminf(ceiling_y, support.planes[index].plane.normal.y);
  }

  output[0] = position.x;
  output[1] = position.y;
  output[2] = position.z;
  output[3] = position.x - start.x;
  output[4] = position.y - start.y;
  output[5] = position.z - start.z;
  output[6] = support_y >= 0.55f ? 1.0f : 0.0f;
  output[7] = support_y;
  output[8] = ceiling_y;
  return 1;
}
