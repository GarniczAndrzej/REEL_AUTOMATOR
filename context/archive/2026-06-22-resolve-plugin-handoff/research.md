---
date: 2026-06-26T11:06:04+0200
researcher: GarniczAndrzej
git_commit: 32f6c9bbb477d6f4029d7ff0e7701e6c118707c5
branch: master
repository: REEL_AUTOMATOR
topic: "S-09 resolve-plugin-handoff — internal codebase research backing the plan"
tags: [research, codebase, resolve, electron, workflow-integration, whisperx, exporters, bridge]
status: complete
last_updated: 2026-06-26
last_updated_by: GarniczAndrzej
---

# Research: S-09 `resolve-plugin-handoff` — internal codebase evidence

**Date**: 2026-06-26T11:06:04+0200
**Researcher**: GarniczAndrzej
**Git Commit**: 32f6c9bbb477d6f4029d7ff0e7701e6c118707c5
**Branch**: master
**Repository**: REEL_AUTOMATOR

## Research Question

Back the S-09 (`resolve-plugin-handoff`) plan with internal evidence from the existing
codebase, scoped against `context/foundation/roadmap.md` and the archived F-02 spike
(`context/archive/2026-06-10-f-02/`). S-09 embeds the existing frontend inside a DaVinci
Resolve **Workflow Integration** panel (an Electron app) and drives the Resolve scripting
API for four modes: (A) auto-collect timeline audio, (B) in-panel WhisperX transcription,
(C) push subtitles onto a Subtitles track, (D) reels → new timelines in the Media Pool.
Depth requested: **deep architectural dive**, balanced across the three risk surfaces
(Tauri→Electron bridge, Resolve API integration, WhisperX sidecar re-spawn).

## Summary

**The F-02 integration contract is the right strategy but a stale inventory.** F-02
(2026-06-11, verdict `Go-with-rework`) recommended **Strategy 2**: keep all HTML/CSS/JS
(`src/ui`, `src/exporters`, `src/parser`, `src/ai`, `src/state.js`), replace the Tauri
`invoke()` shim with an Electron `contextBridge`/`ipcRenderer` bridge, and reimplement the
backend commands in Node (Electron main). That strategy still holds. But F-02 scoped it
against a **post-F-01 surface of "6 surviving commands."** Since then S-05 (WhisperX
engine), S-11 (keychain), S-16 (auto-populate video meta), S-18/S-19 (engine readiness),
S-23/S-07 (cancel + auto-mode) all landed. **The live bridge surface is now 20 `invoke()`
commands + 3 Tauri plugin/API families** (`plugin-dialog`, `api/event` `listen`,
`api/path`), not 6.

**Three findings dominate the plan:**

1. **Bridge surface is ~3.3× larger than the contract assumes** (20 vs 6 commands). The
   delta — model manager (`list/download/delete_model`), engine readiness
   (`whisperx_engine_check/_cached/_capability`), `align_transcript`,
   `cancel_transcription`, `extract_waveform`, `probe_video_metadata`,
   `load/save_text_file`, `open_path`, `get/set_credential` — all need Node
   reimplementations or explicit out-of-scope decisions.

2. **The WhisperX sidecar is the single biggest scoping decision.** Re-driving the
   `whisperx-engine` PyInstaller onefile from Node `child_process` is mechanically
   portable (the spawn/poll/cancel/cache logic is OS-level, not Tauri-specific), but it
   means bundling a ~290 MB onefile + multi-GB align models into the Resolve plugin
   directory. Mode B may instead lean on Resolve's own audio + an upstream transcription
   path. **Decide first whether transcription lives in the panel at all.**

3. **The Lua exporter is the working blueprint for Mode D, but two frame-math traps must
   be carried over correctly.** `src/exporters/lua.js` already builds the
   `mediaPool:AppendToTimeline([{mediaPoolItem,startFrame,endFrame,recordFrame}])` batch
   the live API needs. Critically: use the **0-based** record cursor (Lua model), **not**
   the EDL `3600*fps` CMX-3600 offset, or every clip lands an hour into the timeline; and
   the project timeline must be created at `state.fps` or recordFrame frames misalign.
   Mode C (subtitle insertion) is the **least-proven** path — Resolve's scripting API has
   historically exposed no direct subtitle-item creation, so the safe fallback is
   generating our already-built 0-based `.srt` and importing it.

## Detailed Findings

### Area 1 — Tauri→Electron bridge surface (the Strategy-2 rebuild)

Every frontend `invoke()` uses the lazy pattern
`const { invoke } = await import('@tauri-apps/api/core')`. There is **no** `window.__TAURI__`
/ `isTauri` / `convertFileSrc` / asset-protocol usage — Tauri-vs-browser detection is
implicit: an import failure is treated as "not in Tauri" and the layer silently degrades
(`src/ai/cache.js:22-27`, `src/ai/api-key.js:28-35`, `src/util/video-meta.js:47`). **Under
Electron those dynamic imports fail**, so `cache.js`, `api-key.js`, and `video-meta.js`
will silently no-op unless rewired to a `contextBridge` global. This is a structural item,
not just a per-command port.

**Full live `invoke()` surface (20 commands):**

| Backend command | Args | file:line | Wrapping fn |
|---|---|---|---|
| `load_project` | `{path}` | `src/ui/import/project-io.js:35` | `openProject()` |
| `save_project` | `{path,payload}` | `src/ui/import/project-io.js:97` | `writeProject()` |
| `transcribe_video` | `{videoPath,modelId,language,diarize,hfToken,...}` | `src/ui/import/transcribe.js:822` | `transcribeDocument()` |
| `align_transcript` | `{videoPath,transcript,language,isVtt,device}` | `src/ui/import/transcribe.js:664` | `alignToWords()` |
| `cancel_transcription` | — | `transcribe.js:385,805`, `auto-mode/batch.js:66`, `auto-mode/orchestrator.js:69` | cancel (4 sites) |
| `whisperx_engine_cached` | — | `src/ui/import/transcribe.js:161` | `refreshEngineReadiness()` (cache read only) |
| `whisperx_engine_check` | — | `src/ui/import/transcribe.js:190` | `fullEngineVerify()` (`--selftest`) |
| `list_models` | `{models:[{id,sentinel}]}` | `src/ui/import/transcribe.js:207` | `refreshModelStatus()` |
| `download_model` | `{modelId,repo,files,totalBytes,hfToken}` | `src/ui/import/transcribe.js:356` | `downloadModel()` |
| `delete_model` | `{modelId}` | `src/ui/import/transcribe.js:295` | `deleteModel()` |
| `extract_waveform` | `{videoPath,startS,endS,numSamples}` | `src/selection/waveform.js:22` | `loadWaveform()` |
| `probe_video_metadata` | `{path}` | `src/util/video-meta.js:39` | `populateVideoMeta()` |
| `load_text_file` | `{path}` | `src/ui/step2-preset-bar.js:214` | `importPresets()` |
| `save_text_file` | `{path,content}` | `src/util/save-file.js:29,84` | **primary export-write path** |
| `open_path` | `{path}` | `src/util/save-file.js:63` | `openPath()` (reveal in Finder) |
| `load_llm_cache` | `{hash}` | `src/ai/cache.js:30` | `withLlmCache()` |
| `save_llm_cache` | `{hash,content}` | `src/ai/cache.js:44` | `withLlmCache()` |
| `clear_llm_cache` | — | `src/ai/cache.js:55` | `clearLlmCache()` |
| `get_credential` | `{provider}` | `src/ai/api-key.js:94` | `hydrateKeys()` |
| `set_credential` | `{provider,secret}` | `src/ai/api-key.js:61,109` | `setApiKey()` |

**Plus 3 native Tauri plugin/API families** (map to Electron primitives, not custom IPC):

- `@tauri-apps/plugin-dialog` → Electron `dialog` — **12 call sites** (`open`/`save`/`ask`):
  `project-io.js:29,54`, `save-file.js:21,46`, `step2-preset-bar.js:207,298`,
  `transcribe.js:283,637,733`, `settings-modal.js:205`, `auto-mode/batch.js:85`,
  `auto-mode/index.js:63`. Note: Tauri `plugin-dialog` has **no text-input dialog**, so
  prompts already use an in-app HTML modal (`promptNative`/`openModal`,
  `step2-preset-bar.js:277`) that ports to Electron unchanged.
- `@tauri-apps/api/event` `listen` → Electron `ipcRenderer.on` + `webContents.send` — 2
  channels: `model-download-progress` (`transcribe.js:343`), `transcribe-progress`
  (`transcribe.js:659,816`). `listen` returns an `unlisten()` used in `finally` — the shim
  must too.
- `@tauri-apps/api/path` `join` → Node `path.join` (`save-file.js:81`).

**DELTA vs F-02's 6-command contract** — 14 commands F-02 omitted: `align_transcript`,
`whisperx_engine_check`, `whisperx_engine_cached`, `list_models`, `download_model`,
`delete_model`, `cancel_transcription`, `extract_waveform`, `probe_video_metadata`,
`load_text_file`, `save_text_file`, `open_path`, `get_credential`, `set_credential`. (See
`context/archive/2026-06-10-f-02/decision.md` §Kontrakt integracyjny for the original 6.)

### Area 2 — Backend command surface + WhisperX sidecar (the Node-reimpl scope)

Commands registered in `src-tauri/src/lib.rs:36-59` (22 total backend commands; 20 reached
from frontend — `delete_credential` and `whisperx_engine_capability` exist but aren't
currently invoked from `src/`).

**Port-difficulty buckets:**
- **Trivial (`fs`/`crypto` only):** `save/load_project`, `save/load_text_file`,
  `open_path` (→ Electron `shell.openPath`), `load/save/clear_llm_cache`,
  `whisperx_engine_cached`, `list_models`, `delete_model`. (`project.rs`, `models.rs`,
  `engine.rs:246`)
- **Medium (subprocess / native crate):** `download_model` (`models.rs:161` — HF stream +
  SHA-256 verify + atomic swap + progress events, no native crate needed),
  `whisperx_engine_check/_capability` (`engine.rs:216,258`), `extract_waveform`
  (`waveform.rs:10`), `probe_video_metadata` (`metadata.rs:19`), `get/set/delete_credential`
  (`keychain.rs:19,30,37` — needs a Node keychain module: `keytar` / `@napi-rs/keyring` /
  Electron `safeStorage`).
- **Hard (full subprocess pipeline):** `transcribe_video` (`whisper.rs:371`),
  `align_transcript` (`whisper.rs:737`), `cancel_transcription` (`whisper.rs:882`).

**WhisperX spawn/poll/cancel (`drive_engine`, `whisper.rs:292-368`)** — the riskiest port:
- Sidecar base name `ENGINE_SIDECAR = "whisperx-engine"` (`engine.rs:16`), FFmpeg `"ffmpeg"`
  (`ffmpeg.rs:10`), both Tauri `externalBin`; Tauri auto-resolves the arch-suffixed file via
  `app.shell().sidecar(NAME)`. **Node has no analog** — must compute the absolute path
  (packaged: `process.resourcesPath` extraResources; dev: repo-relative) and resolve the
  arch suffix manually.
- Align model ships as a Tauri **resource** (`bundle.resources: binaries/align_models`),
  resolved by `engine::align_model_dir` (`engine.rs:54-67`), passed as `--align-model-dir`.
  Node equivalent: `path.join(process.resourcesPath,'align_models')` + dev fallback.
- Single global child handle `TRANSCRIBE_CHILD: Mutex<Option<CommandChild>>`
  (`whisper.rs:13`) + `ensure_engine_free()` (`whisper.rs:19-24`) → one transcription at a
  time. Poll loop uses a **250 ms `tokio::time::timeout`** (`whisper.rs:305-353`) because a
  SIGKILL of the PyInstaller bootloader orphans the torch worker and keeps stdout open — a
  plain blocking recv would hang the UI for the whole run (`whisper.rs:285-291`). In Node
  this is *easier* — event-driven `stdout.on('data')` needs no polling — but the
  orphan-reaping discipline must be preserved.
- stdout accumulated uncapped (it is the JSON payload, `whisper.rs:317`); stderr capped at
  `STDERR_TAIL_MAX_BYTES = 64 KB` (`whisper.rs:256,323`). Progress lines `PROGRESS phase= percent=`
  parsed (`whisper.rs:329-344`) → `map_progress` bands (transcribe 5→70, align 70→95,
  diarize 95→100, `whisper.rs:58-75`) → `transcribe-progress` event.
- Cancel: `reap_engine_child` (`whisper.rs:860-874`) sends `SIGTERM`, sleeps 300 ms, then
  `SIGKILL`. `take()` under mutex ensures exactly one reaper (S-21 fix).

**Exact transcribe CLI args (`whisper.rs:519-558`):** audio first via FFmpeg
`ffmpeg -y -i <video> -ar 16000 -ac 1 -c:a pcm_s16le <wav>` (`whisper.rs:494-500`), then
`--audio <wav> --model <dir> --language <lang|auto>` + (Cohere) `--engine cohere
--punctuation`, + (opt-in) `--diarize` (HF token via **env** `HF_TOKEN`, not argv), + advanced
flags only when user-set (`--device --compute-type --beam-size --initial-prompt --vad-onset
--vad-offset --min-speakers --max-speakers`), + `--align-model-dir <dir>`. Non-diarize runs
set `HF_HUB_OFFLINE=1`/`TRANSFORMERS_OFFLINE=1` (`with_hf_offline`, `engine.rs:38-41`) to skip
~50 s of HF etag checks (cf. memory `whisperx-cold-spawn-cost`).

**Transcription cache contract (`whisper.rs:200-250,437-481`):** dir
`app_cache_dir()/whisper-cache/`. Video hash = SHA-256 of `file_size(LE) || mtime_nanos(LE)
|| first 1 MB` (`whisper.rs:35-53` — note: CLAUDE.md's "file_size + first 1MB" description
omits the mtime fold-in). v2 key = SHA-256 of `video_hash || 0x00 || run_sig`, where
`run_sig` is a JSON of model/language/diarize/beam/vad/device/speakers (`whisper.rs:441-462`)
so distinct settings → distinct entry. On-disk `whisper-cache/v2/<hash>.json` holds the full
`{srt_content, words, segments, language}`; legacy `whisper-cache/<video_hash>.srt(+.json)`
read-fallback. Cache hit emits "Z cache! ⚡" and returns early.

**Engine readiness cache (`engine.rs:157-208`):** separate `engine-readiness/<key>.json`,
key folds app version + align-model size/mtime. `whisperx_engine_cached` reads only (never
spawns — cold spawn 37-67 s, memory `whisperx-cold-spawn-cost`); `--selftest` (300 s) /
`--capability` (60 s) spawn and write the verdict. Discipline to preserve: **never put a
spawn on the launch/critical path.**

**Tauri-specific APIs with no Node analog — explicit decisions needed:**
1. `app.path().app_cache_dir()`/`app_data_dir()` (used by whisper-cache, engine-readiness,
   llm-cache, waveform-cache, whisper-models) → Electron `app.getPath`, *but* an embedded
   WI panel's path access must be confirmed; pick a stable root and (optionally) preserve
   keys so existing caches stay valid.
2. `externalBin` arch-suffix resolution → `extraResources` + `process.resourcesPath`.
3. `BaseDirectory::Resource` (`align_models`) → manual `path.join` + dev fallback.
4. Tauri event bus (`app.emit`) → Electron `webContents.send` (emit sites `whisper.rs:340,475,484,512,610`, `models.rs:264,313`).
5. `tauri_plugin_dialog`/`tauri_plugin_fs` → Electron `dialog`.

**Likely droppable under Resolve's host APIs:** `extract_waveform` (trim-UI waveform only)
and possibly `probe_video_metadata` (fps/resolution come from the Resolve timeline/clip).

### Area 3 — Resolve export + reels→timeline data model (Modes A/C/D)

**Lua exporter is the Mode D blueprint (`src/exporters/lua.js`).**
`generateLua({reelsData,sentences,fps,gapFrames,videoPath,projectName,mergeThreshold})`
builds the exact batch the live API needs: per span, one
`{mediaPoolItem=sourceClip, startFrame, endFrame, recordFrame=cursor}`
(`lua.js:154-155`), committed in a single `mediaPool:AppendToTimeline(allClips)`
(`lua.js:185`). `mediaPoolItem` is a single shared imported clip
(`ImportMedia({VIDEO_PATH})[1]`, `lua.js:48-54`). **No `trackIndex`** is set (defaults
V1/A1). Timeline creation: free-name scan → `mediaPool:CreateEmptyTimeline(name)` +
`project:SetCurrentTimeline` (`lua.js:87-107`).

**`mergeAdjacentClips` is the reusable span input (`src/parser/segments.js:1`).** Output
spans: `{start_frame, end_frame, ids[], text, source_idx, duration_frame}`. Merges a clip
into the previous span only if gap `<= thresholdFrames` AND same `source_idx`
(`segments.js:22-27`); `0` disables merging; default 12 (~0.5 s @ 24 fps). Overlapping/out-of-order
clips emit as separate spans (`segments.js:17-21`). The live API path reuses this verbatim
and builds clipInfo per span.

**Frame-math traps to carry over:**
- Time→frame: `Math.round(seconds*fps)` at ingest (`src/parser/srt.js:103-104,155-156`);
  integer frames throughout; never round to seconds mid-pipeline.
- **CMX-3600 offset is EDL-only** (`src/exporters/edl.js:15`, starts `3600*fps`). The **Lua
  record cursor starts at 0** (`lua.js:112`). Resolve `AppendToTimeline.recordFrame` is a
  0-based timeline frame → **use the 0-based model; carrying the 1-hour offset pushes every
  clip an hour into the timeline (import-breaker).**
- **One timeline per reel** (Mode D) vs. current Lua's single shared timeline → drop
  inter-reel `gapFrames` and restart cursor at 0 per timeline.
- **Project fps must match `state.fps`** (default 25, `src/state.js:96`) when creating the
  empty timeline, or recordFrame frames misalign.
- **Markers:** `timeline:AddMarker(recFrame, color, label,...)` after append
  (`lua.js:171`); colors `{hook:Green, body:Blue, punchline:Red}` (`lua.js:6`); marker
  frame `= cursor + (sentence.start_frame - span.start_frame)` (`lua.js:144-150`). Maps 1:1
  to the live `AddMarker` API; preserve the formula.

**Data shapes (`src/state.js`):** Reel (`:78-89`) = `reel_name, clip_ids[],
virality_score?, scores?{hook,flow,value,trend}, reason?, markers?{hook,body,punchline},
ai_order?`. Sentence (`:11-25`) = `id, text, start_frame, end_frame, duration_frame,
start_tc, end_tc, source_idx?, words?[]`. Word (`:1-9`) = `text, start_frame, end_frame,
speaker?`. Mode D needs only `clip_ids`→spans + `reel_name` + `markers`. Mode C needs
per-cue `text` + start/end frames (sentence- or word-level).

**Mode C subtitle insertion (`src/exporters/transcript.js`) — least-proven path.**
`generateTranscriptSRT(sentences,fps,{includeWords})` (`:35-53`) = sentence-level cues;
`generateWordSRT(sentences,fps)` (`:72-106`) = word-level karaoke (onset-pinned, gapless
fill, 4-frame floor). Both consume integer `start_frame`/`end_frame` and emit 0-based
(media-relative) timestamps via `frameToStamp` (`:13-21`). **Resolve's
`CreateSubtitlesFromAudio` re-transcribes audio and ignores our text** — it fits Mode A/B
auto-collect, not pushing *our* transcript. Resolve's scripting API has historically
exposed **no direct subtitle-item creation**, so the safe Mode C path is **generating our
`.srt` (already built, 0-based) and importing it** (e.g. `timeline:ImportIntoTimeline` /
media-pool SRT import). Verify the API version at implementation time. (Diarization
`speaker` exists on words but is intentionally never surfaced in SRT/VTT/UI — memory
`diarization-data-only`.)

**UI hook point (`src/ui/export-popover.js`).** Each format has a `gen*()` wrapper
(`genEDL:105`, `genXML:116`, `genLua:130`, `genFCPXML:149`) assembling `opts` from `state`;
`FORMATS` map (`:170-190`); the write chokepoint is `saveFormat(key)` (`:192-207`):
guard `state.reelsData.length` → `f.gen()` → store in `state[f.store]` → `emit()` →
`await saveTextToPath({...})`. **A new "Resolve" mode is a sibling of `saveFormat`** — same
guard + same `state`-derived opts, but instead of `saveTextToPath` it calls a new
bridge/command that issues `CreateEmptyTimeline` / `AppendToTimeline` / `AddMarker`. Reuse
`mergeAdjacentClips` + the `lua.js:142-160` cursor/`recordFrameById` logic directly.

### Area 4 — Runtime, packaging, and historical context (from F-02)

From `context/archive/2026-06-10-f-02/research-notes.md` + `decision.md`:

- **WI plugin = a full Electron app**, not a webview embedded in Resolve. Resolve Studio
  scans the "Workflow Integration Plugins" dir at boot, reads each `manifest.xml`, adds a
  `Workspace → Workflow Integrations` menu entry; clicking loads the plugin's `index.html`
  in a separate Chromium window. From v19.0.2: enforced **sandbox + context isolation**; DR
  20.1 → **Electron 36.3.2** + promise-based API. Recommended bridge: `preload.js`
  `contextBridge.exposeInMainWorld` + `ipcRenderer.invoke` ⇄ `ipcMain.handle`. Native
  `WorkflowIntegration.node` loaded in `main.js` talks to Resolve **in-process** — it does
  **not** require the user's "External scripting" preference (verified: external
  `DaVinciResolveScript` returned `no Resolve app handle` while the in-process bridge worked
  live).
- **Live proof:** a commercial plugin (Snap-Captions, `com.mediable.SnapCaptions`) was
  found loaded in the running Studio install, mutating the project through this same
  in-process bridge — empirically closing the "will the panel even load?" risk (F-02
  criterion 2.2 ✓). The F-02 PoC `com.reels.edl.spike` passed `node --check`; only a direct
  operator button-click confirmation remained pending (low residual risk).
- **Resolve API "create folder + timeline" sequence (from `SamplePlugin/main.js`):**
  `Initialize(PLUGIN_ID) → GetResolve → GetProjectManager → GetCurrentProject → GetMediaPool
  → GetRootFolder → AddSubFolder(root,name) → SetCurrentFolder → GetMediaStorage()
  .AddItemListToMediaPool([paths]) → CreateEmptyTimeline(name) / CreateTimelineFromClips /
  AppendToTimeline([{clipInfo}]) → SetCurrentTimeline`. `AppendToTimeline` clipInfo:
  `mediaPoolItem, startFrame, endFrame, recordFrame` (+ optional `mediaType, trackIndex`).
  `ImportTimelineFromFile(path,{opts})` accepts AAF/EDL/XML/FCPXML/DRT/OTIO — a possible
  shortcut for Mode D (reuse the existing exporters) if direct API construction proves
  fiddly.
- **Packaging layout:** plugin dir `com.<co>.<plugin>/` under
  macOS `/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration
  Plugins/` (Windows `%PROGRAMDATA%\Blackmagic Design\DaVinci Resolve\Support\Workflow
  Integration Plugins\`), containing `manifest.xml` (Id/Name/Version/FilePath=main.js) +
  `main.js` + `preload.js` + `index.html` + `package.json` + bundled
  `WorkflowIntegration.node` (per-OS) + `node_modules/`. **WI plugins = macOS + Windows
  only, Studio only.** Snap-Captions ships per-OS/per-arch/per-DR variants of the `.node`
  and bytecode-compiled+obfuscated JS — a signal that mature distribution is non-trivial.
- **Signing/notarization of the bundled native `.node` + Electron off the dev machine is
  unproven** (F-02 time-box) and is explicitly deferred to S-09 (`decision.md` §Ryzyka).

**Roadmap open unknowns for S-09** (`roadmap.md:260-264`): `CreateSubtitlesFromAudio`
availability via the WI runtime; whether the API exposes a render-to-file
(`project:RenderSingleClip()`) to extract timeline audio in-plugin (Mode A) vs. an FFmpeg
sidecar against media-pool source; and the S-05 engine bridge as a Node child process.

## Code References

- `src/ai/cache.js:22-55` — LLM cache invoke (`load/save/clear_llm_cache`) + import-failure degrade
- `src/ai/api-key.js:28-35,61,94,109` — keychain bridge (`get/set_credential`) + import-failure degrade
- `src/util/save-file.js:21,29,46,63,81,84` — export-write chokepoint, dialogs, `open_path`, `path.join`
- `src/util/video-meta.js:39,47` — `probe_video_metadata` + import-failure degrade
- `src/selection/waveform.js:22` — `extract_waveform` (likely droppable in panel)
- `src/ui/import/project-io.js:29,35,54,97` — project load/save + dialogs
- `src/ui/import/transcribe.js:161,190,207,283,295,343,356,385,637,659,664,733,805,816,822` — transcription/model/engine bridge + events + dialogs
- `src/ui/auto-mode/{batch,index,orchestrator}.js` — cancel sites + dialogs
- `src/main.js:15,50` — boot awaits `hydrateKeys()` (keychain must be live before first render)
- `src-tauri/src/lib.rs:36-59` — command registration (22 commands)
- `src-tauri/src/whisper.rs:13,19-24,35-53,200-250,256,285-368,371-620,737-849,860-889` — sidecar spawn/poll/cancel/cache
- `src-tauri/src/engine.rs:16,38-67,157-258` — sidecar name, offline env, align-model-dir, readiness cache
- `src-tauri/src/{ffmpeg,models,metadata,waveform,keychain}.rs` — FFmpeg spawn, model manager, video probe, waveform, keychain
- `src/exporters/lua.js:6,48-54,87-107,112,132,142-185` — AppendToTimeline batch + markers (Mode D blueprint)
- `src/parser/segments.js:1-46` — `mergeAdjacentClips` spans (reusable timeline input)
- `src/parser/srt.js:103-104,155-156` + `src/exporters/edl.js:15` — frame math + CMX-3600 offset (EDL-only)
- `src/exporters/transcript.js:13-21,35-53,72-106` — SRT/word-SRT cue builders (Mode C data)
- `src/ui/export-popover.js:105-220` — `gen*()` wrappers + `saveFormat` chokepoint (Resolve-mode hook point)
- `src/state.js:1-25,78-96` — Reel/Sentence/Word typedefs + fps default

## Architecture Insights

- **Strategy 2 is sound but underscoped by F-02.** The reuse boundary (UI/exporters/parser/ai
  intact; swap the IPC layer) is correct, but the plan must size against **20 commands + 3
  plugin families**, not 6. The single highest-leverage prep step is replacing the implicit
  "dynamic import fails ⇒ no backend" probe with an explicit `window.bridge` capability check
  so `cache.js`/`api-key.js`/`video-meta.js` don't silently no-op under Electron.
- **Transcription is the scope fork.** Everything FFmpeg/sidecar-bound (`transcribe_video`,
  `align_transcript`, `extract_waveform`, `probe_video_metadata`, model manager, engine
  readiness) is the bulk of the port effort. If Mode B transcription is deferred or moved
  upstream, the bridge collapses toward the trivial `fs`/`crypto` commands + the Resolve API
  + keychain — a dramatically smaller surface. **This decision should gate the plan.**
- **The Lua exporter already encodes the Mode D data contract.** Reuse it rather than
  re-deriving: same `mergeAdjacentClips` spans, same clipInfo shape, same marker formula —
  with the 0-based cursor (not EDL offset) and per-reel timelines.
- **`ImportTimelineFromFile` is a credible Mode D shortcut.** The API ingests EDL/FCPXML/XML
  directly, so Mode D could reuse the existing (regression-fenced) exporters and import the
  file via the API rather than constructing timelines call-by-call — lower risk, less new
  surface. Worth a spike against direct `AppendToTimeline`.
- **Mode C is the riskiest sub-feature.** No proven direct subtitle-item API; plan around
  SRT-import fallback and verify the Resolve version's scripting scope before committing.

## Historical Context (from prior changes)

- `context/archive/2026-06-10-f-02/decision.md` — verdict `Go-with-rework`; Strategy 2;
  integration contract (the now-stale 6-command app bridge + 4-method Resolve bridge);
  packaging + signing risk flagged.
- `context/archive/2026-06-10-f-02/research-notes.md` — full 3-strategy evaluation, WI
  runtime/hosting model, exact Resolve API sequence, packaging layout, Snap-Captions live
  evidence.
- `context/archive/2026-06-10-f-02/plan.md` / `plan-brief.md` — spike method; S-09 was
  `blocked` on Open Question #2; S-08 is the committed fallback.
- `context/archive/2026-06-22-timeline-export-set/` (S-08) — built the Lua exporter +
  marker emission; the frame-math/`AppendToTimeline` reference for Mode D.
- `context/foundation/prd.md` — FR-030 (embedded WI plugin: one-click folder + reels-as-
  timelines via Resolve API, no script-paste/file-import), FR-031 (standalone + file-export
  fallback when no API access), US-02 (hand reels into Resolve from inside Resolve).
- `context/foundation/lessons.md` — "Never bake multi-GB assets into a PyInstaller onefile"
  (directly relevant to bundling the WhisperX sidecar + align models into the plugin dir);
  "Synchronous JS dialogs crash Tauri's WKWebView" (Tauri-specific; Electron modal handling
  differs, but the in-app modal pattern already in place ports cleanly).

## Related Research

- `context/archive/2026-06-10-f-02/research-notes.md` — the canonical prior research for
  this slice (runtime viability + reuse strategy).
- `context/archive/2026-06-22-timeline-export-set/research.md` — exporter + frame-math
  research that S-09's Mode D builds on.

## Open Questions

1. **Does in-panel transcription (Mode B) ship at all, or does it lean on Resolve's audio +
   an upstream transcription path?** This is the scope fork — it determines whether ~12 of
   the 20 commands need a Node port. (Owner: user.)
2. **Mode D construction: direct `AppendToTimeline` vs. `ImportTimelineFromFile`?** The
   latter reuses regression-fenced exporters and lowers risk. Spike both. (Owner: team.)
3. **Mode C subtitle insertion: is there any direct subtitle-track scripting API in the
   target Resolve version, or is SRT-import the only path?** Verify against the live WI
   scripting scope. (Owner: team.)
4. **Mode A timeline-audio extraction: does `project:RenderSingleClip()` / a render-to-file
   API work in-panel, or must an FFmpeg sidecar decode media-pool source?** (Owner: team.)
5. **Cache/data root inside the WI panel sandbox** — where do the 5 cache namespaces +
   models dir live, and are writes permitted there? Can existing caches be preserved by
   keeping keys/format byte-identical? (Owner: team.)
6. **Packaging: signing/notarization of the bundled native `.node` + Electron off the dev
   machine** — unproven in F-02; the per-OS/arch/DR `.node` variant matrix (per Snap-Captions)
   needs scoping. (Owner: user/team.)
7. **Bridge bootstrap** — replace the implicit "dynamic import fails ⇒ not in Tauri" probe
   in `cache.js`/`api-key.js`/`video-meta.js` with an explicit `contextBridge` capability
   check so those layers don't silently no-op under Electron. (Owner: team.)
