# DaVinci Resolve Embedded Plugin (S-09 `resolve-plugin-handoff`) Implementation Plan

## Overview

Build a **macOS DaVinci Resolve Workflow Integration (WI) plugin** — an Electron app — that
embeds the existing Reels Automator frontend unchanged and drives the Resolve scripting API
for four modes: **D** reels → timelines, **C** transcript → subtitles track, **B** in-panel
WhisperX transcription, **A** auto-collect current-timeline audio. The plugin lives in a new
`/resolve-plugin` directory in this repo and **imports the existing `src/` frontend** (single
source of truth — no fork). Every backend call routes through one **platform adapter** that
detects the host and dispatches to Tauri `invoke` or the Electron `contextBridge`/`ipcRenderer`
bridge. When the Resolve API is unavailable (Resolve Free / non-Studio), the panel auto-falls
back to the S-08 file-export set.

This is the roadmap's headline differentiator (FR-030, FR-031, US-02) and its single largest
technical risk. F-02 returned `Go-with-rework`: runtime viability is proven (Electron WI panel
hosting confirmed live in Studio via the commercial Snap-Captions plugin running the same
in-process bridge), and the reuse strategy is settled (**Strategy 2** — keep HTML/CSS/JS,
rebuild the IPC layer). This plan executes that rework at the now-correct scale: **20 `invoke()`
commands + 3 Tauri plugin/API families**, not F-02's stale 6-command contract.

## Current State Analysis

**What exists today (the reusable frontend boundary):**

- `src/ui`, `src/exporters`, `src/parser`, `src/ai`, `src/selection`, `src/util`, `src/state.js`
  — a Vite-served ES-module app. Exporters are pure `(sentences, reelsData) → string`. The Lua
  exporter (`src/exporters/lua.js`) already encodes the Resolve `AppendToTimeline` batch + marker
  model. `mergeAdjacentClips` (`src/parser/segments.js`) is the export-span source.
- **Every backend call uses the lazy pattern** `const { invoke } = await import('@tauri-apps/api/core')`.
  There is **no** `window.__TAURI__` / `isTauri` probe — host detection is implicit: an import
  failure is treated as "not in Tauri" and the layer silently degrades
  (`src/ai/cache.js:22-27`, `src/ai/api-key.js:28-35`, `src/util/video-meta.js:47`). **Under
  Electron those dynamic imports fail**, so `cache.js`, `api-key.js`, and `video-meta.js` will
  silently no-op unless rewired to an explicit capability check. This is the structural risk, not
  just a per-command port.
- **Live `invoke()` surface = 20 commands** (`research.md` Area 1 table): `load/save_project`,
  `transcribe_video`, `align_transcript`, `cancel_transcription`, `whisperx_engine_cached`,
  `whisperx_engine_check`, `list_models`, `download_model`, `delete_model`, `extract_waveform`,
  `probe_video_metadata`, `load_text_file`, `save_text_file`, `open_path`,
  `load/save/clear_llm_cache`, `get_credential`, `set_credential`.
- **Plus 3 Tauri plugin/API families**: `@tauri-apps/plugin-dialog` (12 call sites),
  `@tauri-apps/api/event` `listen` (2 channels: `model-download-progress`, `transcribe-progress`),
  `@tauri-apps/api/path` `join` (1 site). Text-input prompts already use an in-app HTML modal
  (`promptNative`/`openModal`) because Tauri `plugin-dialog` has no text-input dialog — that ports
  to Electron unchanged.
- **Backend** (`src-tauri/src/`): 22 registered commands (`lib.rs:36-59`). The WhisperX sidecar
  (`whisper.rs` `drive_engine`) is the riskiest port — spawn/poll/cancel of the `whisperx-engine`
  PyInstaller onefile, with orphan-reaping discipline (SIGKILL of the bootloader orphans the torch
  worker), `transcribe-progress` event emission, a SHA-256-keyed disk cache, and offline env vars.

**What's missing:** the entire Electron WI host (manifest/main/preload/`WorkflowIntegration.node`),
the platform adapter, Node reimplementations of the backend commands, the Resolve-API drive code
for the four modes, and a signed/notarized distributable.

**Key constraints discovered (from `research.md` + `context/foundation/lessons.md`):**

- **Frame-math fence**: integer frames throughout; `Math.round(s*fps)` at ingest; never round to
  seconds mid-pipeline. The **CMX-3600 `3600*fps` offset is EDL-only** (`edl.js:15`); the Resolve
  record cursor is **0-based** (`lua.js:112`). Carrying the 1-hour offset pushes every clip an hour
  into the timeline (import-breaker). The project timeline must be created at `state.fps`
  (default 25, `state.js:96`) or `recordFrame` frames misalign.
- **Never bake multi-GB assets into a PyInstaller onefile** (lessons.md; commit a31fdbf): the align
  models ship **beside** the binary and are passed via `--align-model-dir`. The plugin's
  `extraResources` must preserve that split.
- **Regression suite hard-codes prompt markers** (lessons.md): `test/regression.js` asserts on
  `DEFAULT_*_GUIDANCE` strings. This plan does not touch prompts, but any incidental edit there must
  re-green the suite.
- All user-facing strings are **Polish**. Keep them Polish.

## Desired End State

An editor opens **Workspace → Workflow Integrations → Reels Automator** in DaVinci Resolve Studio
(macOS) and gets a single panel covering the full pipeline without leaving Resolve:

- On open, the panel **auto-collects the active timeline's audio** (Mode A) and offers in-panel
  **WhisperX transcription** (Mode B) — or accepts an imported `.srt`.
- The transcript can be **pushed onto a Subtitles track** in one click (Mode C).
- After AI scoring, one click creates a **dated folder with each reel as its own timeline** plus
  source media in the Media Pool (Mode D).
- On Resolve Free / non-Studio (no API), the panel **silently falls back to the S-08 file-export
  set** with a Polish notice.

**Verification of end state:** the unsigned dev build loads and drives a live Resolve Studio
project through all four modes (scripted manual checklist per phase); `node --experimental-vm-modules
test/regression.js` stays green throughout; the final signed + notarized bundle loads from the WI
plugins dir on a clean machine.

### Key Discoveries:

- **Strategy 2 is sound but underscoped by F-02** — size against 20 commands + 3 plugin families
  (`research.md` Area 1), not 6.
- **The implicit "import fails ⇒ no backend" probe is the structural trap** — replace with an
  explicit `window.bridge` capability check (`research.md` Open Q7) routed through one adapter.
- **The Lua exporter encodes the Mode D data contract** (`lua.js:6,44-185`) — Mode D drives the
  live API with the **same call-by-call sequence** (`ImportMedia` → `CreateEmptyTimeline` →
  `AppendToTimeline` → `AddMarker`), via a pure `buildResolveReels` payload builder. recordFrame is
  **0-based** — the EDL-only `3600*fps` CMX offset (`edl.js:15`) is never used (it would push every
  clip an hour into the timeline).
- **`ImportTimelineFromFile` (FCPXML file import) was tried and rejected** (2026-06-27): it returns
  `errorCode:6 "Unable to import a timeline"` in the WI scripting scope regardless of `importOptions`.
  Direct `AppendToTimeline` construction is the working path. (Resolves research Open Question #2.)
- **Mode C has no reliable direct subtitle-item API historically** (`research.md` Area 3) →
  SRT-import is primary; verify a direct API in-phase.
- **WI native bridge runs in-process and does NOT require the "External scripting" preference**
  (F-02, verified live) — `WorkflowIntegration.node` loaded in `main.js` is the integration point.
- **Cold WhisperX spawn costs 37–67 s** (memory `whisperx-cold-spawn-cost`) — never put a spawn on
  the launch/critical path; `whisperx_engine_cached` reads only.

## What We're NOT Doing

- **No Windows build this slice.** macOS-only; Windows parity is a follow-up (the path is mapped in
  `context/foundation/windows-port-guide.md`).
- **No fork of `src/`.** The Electron app imports the existing frontend; we do not copy or diverge
  it. Any UI/exporter change stays single-source.
- **No changes to the Tauri app's behavior.** `src-tauri/` and the Tauri build are untouched except
  where the platform adapter requires routing existing `invoke()` sites through it (behavior-neutral
  under Tauri).
- **No cache migration from the Tauri app.** The panel uses a fresh Electron cache namespace
  (`app.getPath`); first-run caches are cold by design.
- **No `keytar`/`@napi-rs/keyring` native module.** Credentials use Electron `safeStorage` — no
  extra native `.node` to sign.
- **No prompt/schema changes** (`src/ai/prompt.js`). The LLM contract is frozen for this slice.
- **No automated Resolve-API integration harness.** Resolve has no supported headless/CI mode;
  verification is the regression suite (pure pipeline) + a scripted manual checklist in live Studio.
- **No `CreateSubtitlesFromAudio`** for Mode C — it re-transcribes and discards our WhisperX
  transcript.

## Implementation Approach

Phase 1 stands up the Electron WI host and the **one structural fix** that everything depends on:
a single platform-adapter module with an explicit capability check, replacing the implicit
import-failure probe. It also ports the trivial `fs`/`crypto`/`safeStorage` commands the Mode D
path needs and wires the Resolve bootstrap + availability probe + S-08 fallback. Once the panel
loads live and the adapter routes cleanly, the modes layer on in **value-first, risk-managed order**:
D (headline, lowest-risk via exporter reuse) → C (SRT-import) → B (the heavy sidecar port) → A
(timeline-audio source feeding B). Signing/notarization is isolated as the final phase so it can't
block feature work — but the dev-loadable plugin proves functionality from Phase 1 onward.

The reuse boundary stays exactly where F-02 drew it: UI/exporters/parser/ai/state intact; only the
IPC layer and the backend implementations are new. Mode D reuses the regression-fenced
`mergeAdjacentClips` spans + Lua frame-math through a pure `buildResolveReels` builder, and drives the
timeline directly via `AppendToTimeline` (the `ImportTimelineFromFile`/FCPXML shortcut was rejected
live — errorCode 6).

## Critical Implementation Details

- **Frame-math (Modes C/D):** the Resolve record cursor is **0-based** — never carry the EDL
  `3600*fps` offset into Resolve. Timelines are created at `state.fps`, which is seeded from the
  live Resolve timeline on panel open (Phase 1) — not the default 25 (`state.js:95`). Mode D builds
  timelines by **direct `AppendToTimeline` construction** (the S-08 Lua blueprint, `lua.js:142-185`):
  per-reel `recordFrame` cursor restarts at 0, no inter-reel gaps, marker frame = span record cursor +
  (`sentence.start_frame` − `span.start_frame`). The **EDL exporter is excluded** (`edl.js:15` bakes
  the 1-hour offset). `ImportTimelineFromFile`/FCPXML is **not** used (rejected live, errorCode 6).
- **WhisperX orphan-reaping (Mode B):** a SIGKILL of the PyInstaller bootloader orphans the torch
  worker and keeps stdout open. The Tauri loop uses a 250 ms `tokio` timeout to avoid hanging; in
  Node this is *easier* (event-driven `stdout.on('data')` needs no polling), but the SIGTERM →
  300 ms → SIGKILL reaper discipline (`whisper.rs:860-874`) and the single-global-child mutex
  (one transcription at a time) must be preserved or a cancelled run leaks a torch process.
- **Sidecar path resolution (Mode B):** Tauri auto-resolves the arch-suffixed `externalBin`; Node
  has no analog. Compute the absolute path manually (packaged: `process.resourcesPath`
  extraResources; dev: repo-relative) and resolve the arch suffix. Align models resolve to
  `path.join(process.resourcesPath,'align_models')` with a dev fallback, passed as
  `--align-model-dir`.
- **Offline env (Mode B):** non-diarize runs set `HF_HUB_OFFLINE=1`/`TRANSFORMERS_OFFLINE=1`
  (`engine.rs:38-41`) to skip ~50 s of HF etag checks. Preserve this — it's load-bearing for cold
  spawn cost.
- **Event channels:** `model-download-progress` and `transcribe-progress` map to
  `webContents.send` → `ipcRenderer.on`; the `listen()`→`unlisten()` contract used in `finally`
  blocks must be reproduced by the shim or progress listeners leak.

## Phase 1: Electron Shell + Bridge Foundation

### Overview

Stand up the WI plugin host, the platform adapter with explicit capability detection, the trivial
Node command reimplementations the Mode D path needs, the plugin/API-family shims, and the Resolve
bootstrap + availability probe + S-08 fallback. Exit criterion: the panel loads live in Resolve
Studio (dev install) and the existing frontend renders and routes backend calls through the adapter.

### Changes Required:

#### 1. Electron WI plugin scaffold

**File**: `resolve-plugin/manifest.xml`, `resolve-plugin/main.js`, `resolve-plugin/preload.js`,
`resolve-plugin/index.html`, `resolve-plugin/package.json`, `resolve-plugin/WorkflowIntegration.node`

**Intent**: Create the WI plugin bundle Resolve scans at boot. `main.js` loads
`WorkflowIntegration.node` in-process (the bridge that does NOT need the External-scripting pref),
creates the BrowserWindow with sandbox + context isolation (DR ≥19.0.2 enforced), and points it at
the built frontend. `index.html` is the Vite Electron-target output.

**Contract**: `manifest.xml` carries `Id`/`Name`/`Version`/`FilePath=main.js` (per F-02 packaging
layout, `research.md` Area 4). `WorkflowIntegration.node` is the macOS variant bundled per-OS.
`main.js` calls `WorkflowIntegration.Initialize(PLUGIN_ID)` and creates the window with
`webPreferences: { preload, sandbox: true, contextIsolation: true }`.

#### 2. Vite second build target

**File**: `vite.config.js` (or a sibling `vite.electron.config.js`), `resolve-plugin/index.html`

**Intent**: Build the existing `src/` frontend a second time for the Electron renderer, with no
source duplication. Single source of truth for UI/exporters/parser/ai.

**Contract**: a build target whose entry imports `src/main.js` and emits into the plugin dir.
Tauri's existing target is untouched.

#### 3. Platform adapter + explicit capability check

**File**: `src/platform/adapter.js` (new), `src/ai/cache.js`, `src/ai/api-key.js`,
`src/util/video-meta.js`, and the 20 `invoke()` call sites (`research.md` Area 1 table)

**Intent**: Introduce ONE module that detects the host via an explicit `window.bridge` capability
check and dispatches every backend call to Tauri `invoke` or the Electron bridge — replacing the
implicit "dynamic import fails ⇒ not in Tauri" probe that silently no-ops `cache.js`/`api-key.js`/
`video-meta.js` under Electron. Route all existing `invoke()` sites through the adapter. Behavior
under Tauri is unchanged.

**Contract**: `adapter.invoke(command, args)` returns the same shapes the current `invoke()` calls
return. Host detection reads a `window.bridge` global exposed by `preload.js`
(`contextBridge.exposeInMainWorld`); absence ⇒ Tauri path. The 3 plugin families get sibling
adapter helpers: `dialog` (→ Electron `dialog`), `event` (→ `ipcRenderer.on`/`webContents.send`
with a working `unlisten()`), `path.join` (→ Node `path.join`). The in-app HTML modal
(`promptNative`/`openModal`) is host-agnostic and stays.

#### 4. preload.js bridge surface

**File**: `resolve-plugin/preload.js`, `resolve-plugin/main.js` (ipcMain handlers)

**Intent**: Expose `window.bridge.invoke(command, args)` and the event/dialog primitives over
`contextBridge` + `ipcRenderer.invoke` ⇄ `ipcMain.handle`. This is the Electron side the adapter
dispatches into.

**Contract**: `window.bridge = { invoke, on, removeListener, dialog: { open, save, ask } }`.
`ipcMain.handle(command, handler)` per ported command. Progress events flow
`webContents.send(channel, payload)` → `ipcRenderer.on`.

#### 5. Trivial Node command reimplementations (Mode D path)

**File**: `resolve-plugin/backend/` (e.g. `project.js`, `text-file.js`, `llm-cache.js`,
`credentials.js`, `open-path.js`)

**Intent**: Reimplement the `fs`/`crypto`/`safeStorage` commands Mode D and the core UI need:
`save/load_project`, `save/load_text_file`, `open_path` (→ `shell.openPath`),
`load/save/clear_llm_cache` (SHA-256 keyed, Electron `app.getPath('userData')` cache root, fresh
namespace), `get/set_credential` (→ Electron `safeStorage`). No native module.

**Contract**: each handler matches the Rust command's input args and return shape exactly
(`research.md` Area 1/2). Cache files live under an Electron app-paths root; keys need not match the
Tauri app's (fresh namespace by decision).

#### 6. Resolve bootstrap + availability probe + S-08 fallback

**File**: `resolve-plugin/backend/resolve.js`, `resolve-plugin/main.js`, `src/ui/export-popover.js`
(fallback wiring), `src/platform/adapter.js`

**Intent**: On panel open, attempt `WorkflowIntegration` → `GetResolve` → `GetProjectManager` →
`GetCurrentProject`. On success, expose Resolve-API capability to the renderer; on failure (Resolve
Free / non-Studio), the renderer **silently switches the UI to the S-08 file-export set** with a
Polish notice. One detection point.

**Contract**: a `resolve_available` capability flag readable by the renderer through the adapter.
The export UI reads it to choose API-drive vs file-write. Polish fallback string. **On panel open,
when `resolve_available`, seed `state.fps` from the live Resolve project/timeline frame rate** (e.g.
`project:GetSetting('timelineFrameRate')`) so Modes C/D have the authoritative fps before any export
— not the default 25 (`state.js:95`). This removes Mode D's frame-math dependency on the Phase-4
`probe_video_metadata` port (verify the exact setting key against the live WI scripting scope).

### Success Criteria:

#### Automated Verification:

- Regression suite green: `node --experimental-vm-modules test/regression.js`
- Electron main process passes `node --check resolve-plugin/main.js` and `preload.js`
- Vite Electron target builds without error
- Tauri app still builds: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Prettier clean on changed files: `npx prettier --check "src/platform/**/*.js" "resolve-plugin/**/*.js"`

#### Manual Verification:

- Plugin appears under Workspace → Workflow Integrations and the panel window opens in live Resolve Studio (macOS, dev install)
- The existing frontend renders inside the panel; no console errors from failed dynamic imports
- An LLM/cache/credential round-trip works through the adapter (no silent no-op)
- With a Studio project open, `resolve_available` is true; with Resolve Free (or API unreachable), the UI auto-switches to file-export with the Polish notice
- With a Studio project open, `state.fps` is seeded from the live timeline (not the default 25) before any export

**Implementation Note**: After Phase 1 automated verification passes, pause for human confirmation
that the panel loads and routes correctly in live Resolve before starting Mode D.

---

## Phase 2: Mode D — Reels → Timelines

### Overview

Add a "Resolve" export mode that creates a dated folder with a **single timeline holding every
reel** — separated by the inter-reel `gapFrames` setting, the same layout as the Lua export — plus
source media in the Media Pool, by **directly driving the Resolve API** (`ImportMedia` →
`CreateEmptyTimeline` → `AppendToTimeline` → `AddMarker`). This is the headline FR-030 value.

> **2026-06-27 layout change (user-directed, post-live-test).** The plan originally created **one
> timeline per reel**; tested live, the user preferred the Lua-export layout: **all reels on one
> timeline** with the inter-reel `gapFrames` setting between them. Mode D now builds a single
> `buildResolveTimeline` payload (continuous record cursor + `gapFrames` gaps) and the backend
> creates one timeline. Markers from every reel land on the one timeline at their continuous record
> frames.

> **2026-06-27 approach change (empirical).** The original plan built each timeline by writing a
> per-reel FCPXML and calling `ImportTimelineFromFile`. Tested live in Resolve Studio, that path
> **fails with `errorCode:6 "Unable to import a timeline"`** for every reel — including with explicit
> `importOptions` (`importSourceClips:false`+`sourceClipsFolders`, `importSourceClips:true`+
> `sourceClipsPath`, and bare default). The failure is Resolve rejecting the **FCPXML itself** in the
> WI scripting scope, not media-link resolution. Mode D therefore uses **direct `AppendToTimeline`
> construction** — the proven S-08 Lua-exporter sequence — instead of file import. (Resolves
> research Open Question #2.) `ImportTimelineFromFile` / FCPXML is **not** used for Mode D.

### Changes Required:

#### 1. Resolve export mode (sibling of `saveFormat`)

**File**: `src/ui/export-popover.js`, `src/platform/adapter.js`, `src/exporters/resolve-payload.js` (new)

**Intent**: Add a Resolve-mode sibling to `saveFormat(key)` — same `state.reelsData.length` guard,
same `state`-derived inputs, but instead of `saveTextToPath` it builds a single-timeline clip+marker
payload and calls a new bridge command that drives the Resolve API. Gated on `resolve_available`.

**Contract**: a **pure** builder
`buildResolveTimeline({reelsData, sentences, mergeThreshold, gapFrames, name})`
(`src/exporters/resolve-payload.js`) reuses `mergeAdjacentClips` spans + the `lua.js:131-182`
continuous cursor/`recordFrameById` frame-math (0-based; **all reels on one timeline** — the cursor
runs continuously with `gapFrames` of empty timeline between consecutive reels) and returns a single
`{ name, clips:[{startFrame,endFrame,recordFrame}], markers:[{frame,color,label}] }` (colors
hook=Green/body=Blue/punchline=Red, `lua.js:6`). `export-popover.js` assembles
`{ folderName (dated), mediaPaths:[videoPath], fps, timeline }` (with `name = state.projectName`,
`gapFrames = state.gapFrames`) and calls `adapter.resolveCreateReels(payload)` → bridge command
`resolve_create_reels`. recordFrame stays **0-based** — never the EDL `3600*fps` offset (`edl.js:15`).

#### 2. Mode D Resolve-drive backend

**File**: `resolve-plugin/backend/resolve.js`

**Intent**: Create the dated subfolder, import the source media once, then **build the single
timeline directly via the live API** (no temp files, no FCPXML). One timeline holding every reel.

**Contract**: sequence (S-08 Lua blueprint `lua.js:44-185`, `research.md` Area 3/4) —
`GetCurrentProject` → `GetMediaPool` → `GetRootFolder` → `AddSubFolder(root, folderName)` →
`SetCurrentFolder` → `ImportMedia([videoPath])` (capture the returned `MediaPoolItem`) →
`CreateEmptyTimeline(uniqueName)` → `SetCurrentTimeline` →
`AppendToTimeline([{mediaPoolItem, startFrame, endFrame, recordFrame}])` (one entry per
`timeline.clips` span across all reels) → per marker `AddMarker(frame, color, label, "", 1, "")`.
**Name collisions:** `CreateEmptyTimeline` returns null if the name exists — append `_2`, `_3`, …
until free (mirror `lua.js:87-98`). Timeline fps inherits the project setting, which Phase 1 seeded
from the live timeline = `state.fps` (no `SetSetting` needed). No `trackIndex` (defaults V1/A1). Every
Resolve call is async — `await` each.

### Success Criteria:

#### Automated Verification:

- Regression suite green incl. a **new `buildResolveTimeline` frame-math case** (0-based recordFrames,
  continuous cursor + `gapFrames` between reels, marker frames):
  `node --experimental-vm-modules test/regression.js`
- `node --check resolve-plugin/backend/resolve.js`

#### Manual Verification:

- One click creates a dated folder with a single timeline holding all reels (separated by the
  `gapFrames` setting) in a live Resolve project
- Source media lands in the Media Pool; clips reference it correctly
- Clip frames land at the expected timeline positions (NOT offset by 1 hour) — frame-math confirmed
- Markers appear at the correct frames with the correct colors
- Timeline fps matches `state.fps`

**Implementation Note**: Pause for human confirmation in live Resolve before starting Mode C.

---

## Phase 3: Mode C — Subtitles Track

### Overview

Push the transcript onto a Resolve Subtitles track in one click by generating our already-built
0-based `.srt` and importing it; verify whether the target Resolve version exposes a direct
subtitle API and upgrade if so.

### Changes Required:

#### 1. Subtitle push UI + bridge call

**File**: `src/ui/export-popover.js` (or the transcript surface), `src/platform/adapter.js`

**Intent**: Add a "push subtitles to timeline" action gated on `resolve_available` + a present
transcript. Calls a new bridge command with the generated SRT.

**Contract**: reuses `generateTranscriptSRT`/`generateWordSRT` (`transcript.js:35-106`, 0-based,
sentence- or word-level). New command e.g. `resolve_import_subtitles({srt})`.

#### 2. Mode C Resolve-drive backend

**File**: `resolve-plugin/backend/resolve.js`

**Intent**: Write the SRT to a temp file and import it onto the current timeline's subtitle track.
Probe for a direct subtitle-item API in the live Resolve version; if present and reliable, use it,
else keep SRT-import.

**Contract**: SRT-import is the guaranteed path (`research.md` Area 3). Do **not** use
`CreateSubtitlesFromAudio` (re-transcribes, discards our text). Diarization `speaker` stays
unsurfaced (memory `diarization-data-only`).

### Success Criteria:

#### Automated Verification:

- Regression suite green: `node --experimental-vm-modules test/regression.js`
- `node --check resolve-plugin/backend/resolve.js`

#### Manual Verification:

- The transcript appears on a Subtitles track in the current timeline, one click
- Subtitle timings align with the media (0-based, no 1-hour offset)
- Word-level and sentence-level variants both import correctly
- Documented whether a direct subtitle API exists in the target Resolve version

**Implementation Note**: Pause for human confirmation before starting Mode B.

---

## Phase 4: Mode B — WhisperX Sidecar Port (In-Panel Transcription)

### Overview

Port the WhisperX transcription pipeline to Node `child_process` and bundle the engine onefile +
align models + ffmpeg as `extraResources`, giving in-panel transcription fed (initially) by an
imported file. This is the heaviest port; the orphan-reaping and offline-env disciplines are
load-bearing.

### Changes Required:

#### 1. WhisperX drive in Node

**File**: `resolve-plugin/backend/whisper.js`

**Intent**: Reimplement `transcribe_video`, `align_transcript`, and `cancel_transcription` as Node
child-process drivers mirroring `whisper.rs` `drive_engine`. Extract audio via the bundled FFmpeg
(`ffmpeg -y -i <video> -ar 16000 -ac 1 -c:a pcm_s16le <wav>`), spawn the engine with the exact CLI
args (`whisper.rs:519-558`), stream stdout (the JSON payload) and capped stderr, parse `PROGRESS`
lines into `transcribe-progress` events, and preserve the single-global-child mutex + SIGTERM→300ms→
SIGKILL reaper.

**Contract**: event-driven `stdout.on('data')` (no polling needed). Sidecar path resolved manually
(`process.resourcesPath` extraResources; dev: repo-relative; arch suffix resolved). Align models via
`--align-model-dir path.join(process.resourcesPath,'align_models')` + dev fallback. Non-diarize runs
set `HF_HUB_OFFLINE=1`/`TRANSFORMERS_OFFLINE=1`; diarize passes the HF token via `HF_TOKEN` **env**
(not argv). Progress bands: transcribe 5→70, align 70→95, diarize 95→100 (`engine.rs:58-75`).

#### 2. Model manager + engine readiness + waveform + video-probe ports

**File**: `resolve-plugin/backend/models.js`, `resolve-plugin/backend/engine.js`,
`resolve-plugin/backend/waveform.js`, `resolve-plugin/backend/metadata.js`

**Intent**: Port `list/download/delete_model` (HF stream + SHA-256 verify + atomic swap + progress
events), `whisperx_engine_cached`/`whisperx_engine_check`/`_capability` (readiness cache, read-only
on the launch path — never spawn cold), `extract_waveform`, `probe_video_metadata`.

**Contract**: `download_model` emits `model-download-progress`. `whisperx_engine_cached` reads the
`engine-readiness/<key>.json` cache only (cold spawn 37–67 s — memory `whisperx-cold-spawn-cost`).
`--selftest` (300 s) / `--capability` (60 s) spawn and write the verdict. Fresh Electron cache
namespace.

#### 3. Transcription disk cache

**File**: `resolve-plugin/backend/whisper.js` (cache helpers)

**Intent**: Reproduce the v2 cache contract — video hash = SHA-256 of `file_size(LE) ||
mtime_nanos(LE) || first 1MB`; v2 key = SHA-256 of `video_hash || 0x00 || run_sig`; on-disk
`<root>/whisper-cache/v2/<hash>.json` holding `{srt_content, words, segments, language}`.

**Contract**: per `whisper.rs:35-53,441-481`. Fresh Electron cache root (no legacy read-fallback
required). Cache hit returns early with the "Z cache! ⚡" Polish marker.

#### 4. Engine + ffmpeg + align-models bundling

**File**: `resolve-plugin/package.json` / electron-builder config

**Intent**: Bundle `whisperx-engine-<arch>`, `ffmpeg-<arch>`, and `align_models/` as
`extraResources` — engine onefile small, models **beside** it (never baked in — lessons.md).

**Contract**: `extraResources` maps to `process.resourcesPath`. Binaries git-ignored, restored via
`sidecar/build.sh` + `sidecar/fetch-ffmpeg.sh` (memory `whisperx-sidecar-build`).

### Success Criteria:

#### Automated Verification:

- Regression suite green: `node --experimental-vm-modules test/regression.js`
- `node --check` on all `resolve-plugin/backend/*.js`
- Engine self-check passes via the ported readiness path (cached read returns a verdict)

#### Manual Verification:

- In-panel transcription of an imported file produces SRT + word timestamps; progress shows inline
- Word-level alignment is correct (≈0% mid-word cuts) — the quality guarantee holds
- Cancel mid-run terminates the engine and leaves no orphaned torch process
- A second identical run hits the cache and returns instantly
- Model download/delete works with progress; opt-in diarization runs when an HF token is set

**Implementation Note**: Pause for human confirmation before starting Mode A.

---

## Phase 5: Mode A — Auto-Collect Timeline Audio

### Overview

On demand (a **"Z osi czasu Resolve" button**, not on panel open), read the active timeline and
extract its audio via a Resolve render-to-file call — feeding the Phase-4 transcription engine with
no manual file picker. Render-to-file is the only path (it captures the actual timeline mix); when
it is unavailable the user keeps the manual file-import picker.

> **2026-06-27 trigger change (user-directed, post-live-test).** The plan originally auto-collected
> the timeline audio on **panel open**. Tested live, the user preferred a **manual button trigger** —
> auto-rendering on every open is intrusive (it queues a render job each time) and the user wants
> control over when the mix is rendered. Mode A is now a **"Z osi czasu Resolve" button** beside
> "Przeglądaj" (shown only inside the Resolve WI panel when the scripting API is available); clicking
> it renders the active timeline's audio mix. Nothing happens automatically on open.

### Changes Required:

#### 1. Timeline-audio extraction backend

**File**: `resolve-plugin/backend/resolve.js`, `resolve-plugin/backend/whisper.js` (input wiring)

**Intent**: Read `currentTimeline:GetName()/GetStartFrame()/GetEndFrame()`, render the timeline
audio to a wav via the Resolve API (e.g. `project:RenderSingleClip()` / render-to-file). **If
render-to-file is unavailable in the WI runtime, do NOT silently decode Media-Pool source clips** —
on an edited/multi-clip timeline that yields source audio, not the timeline mix (wrong/partial
transcription), and the clip-selection/order is ambiguous. Instead degrade to the existing **manual
file-import** path with a Polish notice that auto-collect is unavailable. Feed the resulting wav
into the Phase-4 engine input.

**Contract**: render-to-file is the **only** auto-collect path (it captures the actual timeline
mix). When it fails or is unavailable, Mode A degrades to manual file import (not a blind FFmpeg
decode of source media) with a Polish caveat — a single-clip FFmpeg decode only matches the timeline
when the timeline is one unedited clip, so it is not used as an automatic fallback. The extracted wav
replaces the manual file-import input for transcription only when render-to-file succeeds. **The
render honors the user's timeline In/Out marks** (`GetMarkInOut` → absolute render `MarkIn`/`MarkOut`,
`SelectAllFrames:false`); with no In/Out set it renders the whole timeline (`SelectAllFrames:true`).
`GetMarkInOut` may report 0-based or absolute frames depending on the Resolve version, so the basis is
normalized against `GetStartFrame`/`GetEndFrame` (verified live).

#### 2. Button-triggered collect wiring

**File**: `src/ui/import/transcribe.js` (input source), `src/index.html` (the button),
`src/platform/adapter.js`

**Intent**: Add a **"Z osi czasu Resolve" button** beside "Przeglądaj", shown only inside the
Resolve WI panel when `resolve_available`. On click, render the active timeline's audio mix and
present it as the transcription input — no file picker step. Nothing runs on panel open.

**Contract**: button visibility gated on `isElectron()` + `resolve_available`; on click it calls
`resolveCollectTimelineAudio()` and feeds the resulting wav into `state._whisperVideoPath`. On
unavailability/failure it leaves the manual file-import picker untouched with a Polish notice. The
button never appears under Tauri/browser or on Resolve Free.

### Success Criteria:

#### Automated Verification:

- Regression suite green: `node --experimental-vm-modules test/regression.js`
- `node --check resolve-plugin/backend/resolve.js`

#### Manual Verification:

- The "Z osi czasu Resolve" button appears only inside the Resolve WI panel (hidden under Tauri/browser and on Resolve Free); clicking it collects the timeline audio with no manual file picker
- The render-to-file path captures the timeline mix (verified against an edited/arranged timeline) and honors the In/Out range (only the marked range is rendered; whole timeline when no marks)
- When render-to-file is unavailable, the user keeps the manual file-import picker with a Polish notice (no silent source-clip decode)
- The collected audio feeds Mode B transcription end-to-end inside the panel

**Implementation Note**: Pause for human confirmation that the full A→B→(selection)→C/D pipeline
runs inside Resolve before starting packaging.

---

## Phase 6: Packaging — Signing + Notarization (macOS)

### Overview

Sign the Electron app + the native `WorkflowIntegration.node` + the bundled sidecars, notarize the
bundle, and prove the signed plugin loads from the WI plugins dir on a clean machine. F-02 left this
unproven and explicitly deferred it here.

### Changes Required:

#### 1. Codesign + notarize pipeline

**File**: `resolve-plugin/` electron-builder / signing config, a build script

**Intent**: Hardened-runtime codesign of the Electron binary, the `.node`, and the
`whisperx-engine`/`ffmpeg` sidecars; notarize + staple; place the bundle in
`/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins/`.

**Contract**: per the F-02 packaging layout (`research.md` Area 4). All embedded executables and the
native module must be individually signed before notarization succeeds.

### Success Criteria:

#### Automated Verification:

- `codesign --verify --deep --strict` passes on the bundle
- `spctl -a -vv` / notarization staple validates
- Regression suite green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- The signed + notarized plugin loads from the WI plugins dir on a clean macOS machine (no dev tooling)
- All four modes still function under the signed/sandboxed build
- Gatekeeper raises no warning on first launch

**Implementation Note**: Final phase — after this passes, the slice is distributable on macOS.

---

## Testing Strategy

### Unit Tests:

- The existing `test/regression.js` (SRT parse + EDL/XML/Lua exporter correctness) is the only
  automated guard and must stay green across every phase — Mode D reuses the exporters and the
  frame-math invariants, so a regression here is the highest-likelihood silent break.
- Add no new test framework; if any parser/exporter behavior changes, add a regression case in the
  same phase (none is currently planned — the exporters are reused as-is).

### Integration Tests:

- None automated — Resolve has no supported headless/CI mode. Integration is verified by the
  per-phase manual checklist against a live Resolve Studio project.

### Manual Testing Steps (scripted checklist, per phase):

1. **Phase 1**: panel loads in Workspace → Workflow Integrations; frontend renders; adapter
   round-trip (cache/credential) works; availability probe flips correctly between Studio and Free.
2. **Phase 2**: one-click reels → dated folder + per-reel timelines; frames/markers/fps correct; no
   1-hour offset.
3. **Phase 3**: transcript → subtitles track, one click; timings aligned.
4. **Phase 4**: in-panel transcription of an imported file; word alignment correct; cancel leaves no
   orphan; cache hit on re-run.
5. **Phase 5**: panel-open auto-collect with no file picker; render-to-file captures timeline mix;
   when render-to-file is unavailable, Mode A degrades to manual file import + Polish notice.
6. **Phase 6**: signed/notarized bundle loads on a clean machine; all modes still work.

## Performance Considerations

- **Never put a WhisperX spawn on the launch/critical path** (cold spawn 37–67 s, memory
  `whisperx-cold-spawn-cost`): `whisperx_engine_cached` reads the readiness cache only at boot;
  `--selftest`/`--capability` spawn only on explicit user action.
- **Offline env vars** (`HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE`) shave ~50 s off non-diarize runs —
  preserve them.
- Mode D issues one `AppendToTimeline` batch + N `AddMarker` calls per reel; all in-process API
  round-trips, no temp files or file import.

## Migration Notes

- **No cache migration.** The Electron panel uses a fresh `app.getPath`-rooted cache namespace;
  first-run caches are cold by design. The Tauri app's caches are untouched.
- **No `.reelproj` schema change.** Project save/load reuses the existing JSON contract via the Node
  `project.js` reimplementation.
- **Sidecars** (`whisperx-engine-<arch>`, `ffmpeg-<arch>`, `align_models/`) are git-ignored and
  absent from a fresh checkout — restore via `sidecar/build.sh` + `sidecar/fetch-ffmpeg.sh` before
  building the plugin (memory `whisperx-sidecar-build`).

## References

- Internal research: `context/changes/resolve-plugin-handoff/research.md`
- F-02 viability + Strategy 2 contract: `context/archive/2026-06-10-f-02/decision.md`,
  `context/archive/2026-06-10-f-02/research-notes.md`
- Mode D blueprint: `src/exporters/lua.js:6,48-54,87-185`; span source `src/parser/segments.js:1-46`
- Bridge surface: `research.md` Area 1 table; backend `src-tauri/src/lib.rs:36-59`,
  `whisper.rs:13,19-24,35-53,200-250,285-368,860-889`, `engine.rs:16,38-67,157-258`
- Frame math: `src/parser/srt.js:103-104,155-156`, `src/exporters/edl.js:15` (CMX-3600, EDL-only)
- Roadmap slice: `context/foundation/roadmap.md:237-266` (S-09); PRD FR-030/FR-031/US-02
- Lessons priors: `context/foundation/lessons.md` (PyInstaller onefile, WKWebView dialogs,
  regression markers, Prettier churn)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Electron Shell + Bridge Foundation

#### Automated

- [x] 1.1 Regression suite green: `node --experimental-vm-modules test/regression.js` — 5091709
- [x] 1.2 Electron main process passes `node --check` (main.js + preload.js) — 5091709
- [x] 1.3 Vite Electron target builds without error — 5091709
- [x] 1.4 Tauri app still builds: `cargo check --manifest-path src-tauri/Cargo.toml` — 5091709
- [x] 1.5 Prettier clean on changed files — 5091709

#### Manual

- [x] 1.6 Plugin appears under Workspace → Workflow Integrations and the panel opens in live Resolve Studio — 5091709
- [x] 1.7 Existing frontend renders inside the panel; no failed-import console errors — 5091709
- [x] 1.8 LLM/cache/credential round-trip works through the adapter (no silent no-op) — 5091709
- [x] 1.9 Availability probe flips correctly between Studio (API) and Free (file-export fallback) — 5091709
- [x] 1.10 `state.fps` is seeded from the live Resolve timeline (not default 25) before any export — 5091709

### Phase 2: Mode D — Reels → Timelines

#### Automated

- [x] 2.1 Regression suite green — 09112bc
- [x] 2.2 `node --check resolve-plugin/backend/resolve.js` — 09112bc

#### Manual

- [x] 2.3 One click creates a dated folder with a single timeline holding all reels, separated by the `gapFrames` setting, in a live project — 09112bc
- [x] 2.4 Source media lands in the Media Pool; clips reference it correctly — 09112bc
- [x] 2.5 Clip frames land at expected positions (no 1-hour offset) — frame-math confirmed — 09112bc
- [x] 2.6 Markers appear at correct frames with correct colors — 09112bc
- [x] 2.7 Timeline fps matches `state.fps` — 09112bc

### Phase 3: Mode C — Subtitles Track

#### Automated

- [x] 3.1 Regression suite green — caa5d5a
- [x] 3.2 `node --check resolve-plugin/backend/resolve.js` — caa5d5a

#### Manual

- [x] 3.3 Transcript appears on a Subtitles track in one click — caa5d5a
- [x] 3.4 Subtitle timings align with media (0-based, no offset) — caa5d5a
- [x] 3.5 Word-level and sentence-level variants both import correctly — 61757eb
- [x] 3.6 Documented whether a direct subtitle API exists in the target Resolve version — 61757eb

### Phase 4: Mode B — WhisperX Sidecar Port (In-Panel Transcription)

#### Automated

- [x] 4.1 Regression suite green — a89a09d
- [x] 4.2 `node --check` on all `resolve-plugin/backend/*.js` — a89a09d
- [x] 4.3 Engine readiness cached-read returns a verdict — a89a09d

#### Manual

- [x] 4.4 In-panel transcription of an imported file produces SRT + word timestamps with inline progress — a89a09d
- [x] 4.5 Word-level alignment correct (≈0% mid-word cuts) — a89a09d
- [x] 4.6 Cancel mid-run terminates the engine, no orphaned torch process — a89a09d
- [x] 4.7 Second identical run hits the cache and returns instantly — a89a09d
- [x] 4.8 Model download/delete works with progress; opt-in diarization runs with an HF token — a89a09d

### Phase 5: Mode A — Auto-Collect Timeline Audio

#### Automated

- [x] 5.1 Regression suite green
- [x] 5.2 `node --check resolve-plugin/backend/resolve.js`

#### Manual

- [x] 5.3 "Z osi czasu Resolve" button (Resolve panel only) collects timeline audio on click, no file picker
- [x] 5.4 Render-to-file captures the timeline mix (edited timeline) and honors the In/Out range
- [x] 5.5 Render-to-file unavailable → user keeps manual file import + Polish notice (no source-clip decode)
- [x] 5.6 Collected audio feeds Mode B transcription end-to-end inside the panel

### Phase 6: Packaging — Signing + Notarization (macOS)

#### Automated

- [ ] 6.1 `codesign --verify --deep --strict` passes on the bundle
- [ ] 6.2 `spctl -a -vv` / notarization staple validates
- [ ] 6.3 Regression suite green

#### Manual

- [ ] 6.4 Signed + notarized plugin loads from the WI plugins dir on a clean macOS machine
- [ ] 6.5 All four modes function under the signed/sandboxed build
- [ ] 6.6 Gatekeeper raises no warning on first launch
