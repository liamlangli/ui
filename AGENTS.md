# Agent Notes

- For frontend/UI changes, do not use screenshots as the final visual check unless the user explicitly asks for screenshots. Run code-level verification such as typecheck/build, start the local dev server when useful, and leave visual inspection to the user.
- TypeScript files in `src/` and `preview/` should start with `ui_`. Keep non-TS assets/data files and required root toolchain/discovery filenames at their conventional names.
