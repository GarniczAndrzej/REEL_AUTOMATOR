import { defineConfig } from 'vite';

// Second Vite build target (S-09): the existing `src/` frontend built for the
// DaVinci Resolve Workflow Integration panel's Electron renderer. It builds the
// SAME `src/` as the Tauri target (vite.config.js) — single source of truth, no
// fork. Only the output dir + base differ:
//   - `base: './'` so assets resolve relative to index.html under `file://`
//     (the panel is loaded via `mainWindow.loadFile(...)`).
//   - output goes into `resolve-plugin/renderer/` (git-ignored build artifact),
//     which `resolve-plugin/main.js` points the BrowserWindow at.
// The Tauri build is untouched.
export default defineConfig({
  root: 'src',
  base: './',
  build: {
    // Relative to `root: 'src'` (mirrors vite.config.js's `../dist`).
    outDir: '../resolve-plugin/renderer',
    emptyOutDir: true,
    // DaVinci Resolve 20.1 ships a modern Electron (Chromium) — no legacy target.
    target: 'chrome120',
    minify: 'esbuild',
  },
});
