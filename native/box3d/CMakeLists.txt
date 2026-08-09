cmake_minimum_required(VERSION 3.22)

project(ui_box3d_wasm LANGUAGES C)

if(NOT EMSCRIPTEN)
  message(FATAL_ERROR "This target must be configured with emcmake")
endif()

include(FetchContent)

set(BOX3D_SAMPLES OFF CACHE BOOL "" FORCE)
set(BOX3D_UNIT_TESTS OFF CACHE BOOL "" FORCE)
set(BOX3D_BENCHMARKS OFF CACHE BOOL "" FORCE)
set(BOX3D_DOCS OFF CACHE BOOL "" FORCE)

# Pin the source used by the checked-in WASM artifact. Update this and rebuild
# deliberately so an upstream API change cannot silently alter the controller.
FetchContent_Declare(
  box3d
  GIT_REPOSITORY https://github.com/erincatto/box3d.git
  GIT_TAG 3fc20f5b453ba9e14cdf54ecafa87a2a4bcdf53c
  GIT_SHALLOW FALSE
)
FetchContent_MakeAvailable(box3d)

add_executable(ui_box3d ui_box3d.c)
target_link_libraries(ui_box3d PRIVATE box3d::box3d)
set_target_properties(ui_box3d PROPERTIES SUFFIX ".js")

target_link_options(ui_box3d PRIVATE
  "-sMODULARIZE=1"
  "-sEXPORT_ES6=1"
  "-sEXPORT_NAME=create_box3d_module"
  "-sENVIRONMENT=web"
  "-sALLOW_MEMORY_GROWTH=1"
  "-sFILESYSTEM=0"
  "-sASSERTIONS=0"
  "-sMALLOC=emmalloc"
  "-sEXPORTED_RUNTIME_METHODS=['HEAPF32']"
  "-sEXPORTED_FUNCTIONS=['_malloc','_free','_ui_box3d_create_world','_ui_box3d_destroy_world','_ui_box3d_set_gravity','_ui_box3d_step','_ui_box3d_add_box','_ui_box3d_add_sphere','_ui_box3d_add_dynamic_box','_ui_box3d_add_dynamic_sphere','_ui_box3d_get_body_transform','_ui_box3d_add_height_field','_ui_box3d_move_capsule']"
)
