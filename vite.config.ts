import { defineConfig } from 'vite'

declare const process: { env: Record<string, string | undefined> }

// The preview is deployed to GitHub Pages at https://<user>.github.io/ui/, so
// assets must be served from the `/ui/` sub-path in production. Locally
// (`vite dev`) the base stays `/`. Override with `BASE_PATH` if the repo /
// Pages path ever changes.
export default defineConfig(({ command }) => ({
  base: process.env.BASE_PATH ?? (command === 'build' ? '/ui/' : '/'),
  build: {
    outDir: 'dist',
    target: 'es2022',
    // The PingFang SC atlas is ~6.6 MB; keep it as an emitted file, not inlined.
    assetsInlineLimit: 0,
  },
}))
