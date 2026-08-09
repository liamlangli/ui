# Agent Notes

- For frontend/UI changes, do not use screenshots as the final visual check unless the user explicitly asks for screenshots. Run code-level verification such as typecheck/build, start the local dev server when useful, and leave visual inspection to the user.
- TypeScript files in `src/` and `preview/` should start with `ui_`. Keep non-TS assets/data files and required root toolchain/discovery filenames at their conventional names. except `index.ts`.
- WGSL shader code must not use `meta` as a variable, field, parameter, or struct member name; it is a reserved keyword.
- Box3D is the default 3D physics backend. Its public, engine-neutral API lives in `src/physics/`; keep Emscripten symbols and generated files internal to that module. Rebuild the checked-in WASM only through `npm run wasm:box3d` on macOS with Apple container.
