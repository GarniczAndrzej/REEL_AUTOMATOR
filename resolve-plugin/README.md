# Reels Automator — DaVinci Resolve Workflow Integration plugin (S-09)

An Electron Workflow Integration (WI) panel that embeds the existing Reels
Automator frontend (`../src/`, unchanged — single source of truth) and drives the
DaVinci Resolve scripting API. Built in phases: **1** bridge foundation (this) →
**2** Mode D (reels → timelines) → **3** Mode C (subtitles) → **4** Mode B
(WhisperX) → **5** Mode A (auto-collect audio) → **6** signing/notarization.

## Layout

```
resolve-plugin/
  manifest.xml              # Resolve reads this at boot (Id/Name/Version/FilePath)
  main.js                   # Electron main process + IPC bridge dispatch
  preload.js                # sandboxed contextBridge → window.bridge
  package.json
  backend/                  # Node reimplementations of the Tauri Rust commands
  renderer/                 # built src/ frontend (git-ignored — `npm run build:resolve`)
  WorkflowIntegration.node  # native Resolve bridge (git-ignored — see below)
```

## Restoring git-ignored artifacts after a fresh checkout

Three things are git-ignored and absent from a clean clone/worktree:

1. **`renderer/`** — the built frontend. Generate it from the repo root:
   ```bash
   npm run build:resolve   # vite build --config vite.electron.config.js
   ```
2. **`WorkflowIntegration.node`** — the native Resolve bridge. Copy the macOS
   variant from the DaVinci Resolve Developer SDK (bundled with Resolve Studio:
   `…/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/`)
   into this directory. Without it the panel still loads but reports Resolve
   unavailable and falls back to the S-08 file-export set.
3. **Sidecars** (Phase 4) — `whisperx-engine-<arch>`, `ffmpeg-<arch>`,
   `align_models/`. Restore via `sidecar/build.sh` + `sidecar/fetch-ffmpeg.sh`.

## Dev install (manual verification)

Symlink (or copy) this directory into Resolve's WI plugins dir, then restart
Resolve Studio and open **Workspace → Workflow Integrations → Reels Automator**:

```
/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/com.brave.reelsautomator
```

Build `renderer/` first (step 1 above) — `main.js` loads `renderer/index.html`.
