#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
container_bin=${CONTAINER_BIN:-container}
image=${BOX3D_EMSDK_IMAGE:-docker.io/emscripten/emsdk:4.0.13}
build_dir="$repo_root/build/box3d-wasm"
output_dir="$repo_root/src/physics/wasm"

if ! command -v "$container_bin" >/dev/null 2>&1 && [[ ! -x "$container_bin" ]]; then
  echo "Apple container CLI not found. Install it from https://github.com/apple/container and run 'container system start'." >&2
  exit 1
fi

mkdir -p "$build_dir" "$output_dir"

"$container_bin" run --rm --rosetta --platform linux/amd64 --cpus 4 --memory 4g \
  --volume "$repo_root:/workspace" \
  --workdir /workspace \
  "$image" \
  bash -lc 'emcmake cmake -S native/box3d -B build/box3d-wasm -DCMAKE_BUILD_TYPE=MinSizeRel && cmake --build build/box3d-wasm --target ui_box3d --parallel 2'

cp "$build_dir/ui_box3d.js" "$output_dir/ui_box3d.js"
cp "$build_dir/ui_box3d.wasm" "$output_dir/ui_box3d.wasm"

echo "Built $output_dir/ui_box3d.js and $output_dir/ui_box3d.wasm"
