# F-01: Render-path removal + regression fence — Implementation Plan

## Overview

Reels Automator is pivoting away from in-app MP4 rendering. This change deletes the entire FFmpeg render path and every in-app video-editor concern (9:16 crop, logo overlay, subtitle burn-in, codec matrix, render queue, hardware-encoder detection, face-tracking keyframes) plus the deferred Metadata/thumbnail feature, while **keeping the bundled FFmpeg sidecar** (still used by Whisper audio extraction and the waveform UI). Selection-side survivors move out of the now-misnamed `src/render/` into `src/selection/`. The `.reelproj` schema bumps to v3 to shed dead `renderConfig`/`reelsMetadata` blobs. The regression suite (parser + EDL/XML/Lua exporters) is the fence: green before and after, plus one new back-compat case proving an old project still exports cleanly.

This is roadmap slice **F-01** (PRD **FR-038**). It unblocks **S-01** (shrinks the schema-change surface — no `renderConfig` to thread `virality_score` through) and **S-05** (slims `lib.rs` so the WhisperX engine swap rebases cleanly).

## Current State Analysis

The render path is woven across both the Rust backend and the vanilla-JS frontend:

**Backend (`src-tauri/src/`):**
- `rendering.rs` (21 KB) — `run_render`, `cancel_render`, `detect_hw_encoder`, `extract_thumbnail`, `RenderRegistry`. All render except `extract_thumbnail` (used by the Metadata feature, also being removed).
- `face_detect.rs` — `detect_face_keyframes` (9:16 face-tracking crop). Render-only.
- `ffmpeg.rs` — sidecar spawn helpers. `run_ffmpeg_output` is used by `whisper.rs`; `run_ffmpeg_cancellable` emits `render-progress` and polls cancellation (render-only).
- `lib.rs` — registers all commands and `.manage(RenderRegistry)`.
- `project.rs` — **schema-agnostic**: `save_project(payload: Value)` / `load_project() -> Value`. No typed `renderConfig`, no version field. Needs **no change** for F-01.
- `waveform.rs`, `whisper.rs` — keep; both spawn the sidecar.

**Frontend (`src/`):**
- `src/render/` — `queue.js` (render queue), `settings.js` (`defaultRenderConfig` + `PLATFORM_PRESETS`), `subtitles.js` (burn-in `buildReelSrt`) are render-only → delete. `fillers.js` (Polish filler sets, used by step2 `isFiller` + step3 span-building; **S-04 depends on it**), `timeline.js` (review canvas), `waveform.js` (clip-trim cache) are selection-side → keep + relocate.
- `state.js` — `renderConfig: defaultRenderConfig()` (40), `detectedHwEncoder` (43), `reelsMetadata` (52), `namedPresets` (55, holds `RenderConfig` presets). `mergeThreshold` (30) is top-level and **stays** (export-span source).
- `step2-analyze.js` (1408 LoC) — undo/redo snapshot includes `renderConfig` + `reelsMetadata`; line 194 reads `renderConfig.aspect` for `isVertical` in the timeline draw; imports `isFiller` from render/fillers, `buildMetadataPrompt` from prompt; `renderMetadataList` + metadata-gen handlers.
- `step3-export.js` (1229 LoC) — EDL/XML/Lua export tabs (keep) + Render tab (delete) + Meta tab (delete). Imports `buildReelSrt`, `expandSpansWithFillerRemoval`, queue functions, `PLATFORM_PRESETS`.
- `step1-import.js` — `.reelproj` save/load threads `renderConfig`, `reelsMetadata`, `mergeThreshold`.
- `main.js:110` — lazy `import('./render/queue.js')`.
- `index.html` — Render tab (`tabBtnRender`/`tabRender`), Meta tab (`tabBtnMeta`/metadata panels), `genMetaBtn`, `metadataCard`.

**The only automated guard** is `node --experimental-vm-modules test/regression.js` (parser + exporters, pure JS). It does not currently exercise project load.

## Desired End State

The app contains no render code, no Render tab, no Metadata tab, no `renderConfig`/`reelsMetadata`/face-tracking. The FFmpeg sidecar remains bundled and functional for Whisper + waveform. Selection-side modules live under `src/selection/`. Old v2 `.reelproj` files load cleanly (dead blobs silently dropped); new saves are v3. The full pipeline — SRT/transcript import → AI selection → segment merge → EDL/XML/Lua export — works end-to-end, and the regression suite (including a new back-compat case) is green.

**Verify:** `cargo check` green; `npm run tauri build` succeeds; `node --experimental-vm-modules test/regression.js` green; the app boots, imports an SRT, and exports EDL/XML/Lua; an old `.reelproj` (with `renderConfig`) loads and exports without error; no reference to `run_render`, `detect_hw_encoder`, `detect_face_keyframes`, `extract_thumbnail`, `renderConfig`, `src/render/` remains in the tree.

### Key Discoveries:

- `project.rs` stores raw JSON `Value` — schema/version logic is JS-side (`step1-import.js`), so v3 migration touches no Rust (`src-tauri/src/project.rs:6-14`).
- `mergeThreshold` is `state.mergeThreshold` (top-level), **not** in `renderConfig` — the export-span source is decoupled from render and survives untouched (`src/state.js:30`, `src/ui/step3-export.js:5`).
- `ffmpeg.rs` is shared: `run_ffmpeg_output` feeds `whisper.rs:68`; only `run_ffmpeg_cancellable` (the `render-progress` emitter) is render-only (`src-tauri/src/ffmpeg.rs:40,76`).
- `fillers.js` is selection logic, not render — streams.md flags it as a mandatory keep for S-04 (`context/foundation/streams.md:57-59`).
- `extract_thumbnail` sits inside the deleted `rendering.rs` but is only consumed by the Metadata feature (also being removed), so it goes — no relocation needed (`src/ui/step3-export.js:1008`).

## What We're NOT Doing

- **Not removing the FFmpeg sidecar** or its bundling in `tauri.conf.json` — Whisper + waveform need it.
- **Not touching `mergeAdjacentClips`** or the exporters (`edl.js`/`xml.js`/`lua.js`) — they remain the export-span source and output, unchanged.
- **Not rewriting `prompt.js`'s main selection schema** (the `title/hook/description` shape). That is S-01's owned file; F-01 only removes the metadata-specific `buildMetadataPrompt`. If `thumbnailTimestamp` is entangled in the main selection schema, leave the schema field for S-01 and only remove its UI consumers.
- **Not splitting `step2-analyze.js`** (the R1 refactor) — that is S-01's opening move.
- **Not changing `project.rs`** (Rust) — schema work is JS-side only.
- **Not migrating or re-transcribing** Whisper/waveform caches.

## Implementation Approach

Four phases ordered to keep the app working and verifiable at every boundary, each ending with the regression fence:

1. **Rust first** — remove backend render so `cargo check` proves the backend compiles without the render commands, before the frontend stops calling them.
2. **Frontend render + relocation** — delete the render UI/state and move survivors to `src/selection/` in one coherent frontend pass.
3. **Metadata feature removal** — a self-contained surface, kept as its own phase so it can be reverted independently if it proves entangled with `prompt.js`.
4. **Schema v3 + fence** — tie off back-compat and add the regression case that guards the actual new risk (project load dropping `renderConfig`).

## Phase 1: Backend render teardown (Rust)

### Overview

Delete the render and face-detection backend, prune the shared FFmpeg helper to its surviving callers, and deregister every render command so the backend compiles cleanly with the sidecar intact.

### Changes Required:

#### 1. Delete render modules

**File**: `src-tauri/src/rendering.rs` (delete), `src-tauri/src/face_detect.rs` (delete)

**Intent**: Remove the entire FFmpeg filter-graph render, render registry, hw-encoder probe, thumbnail extraction, and face-tracking keyframe detection.

**Contract**: Files removed wholesale. All four `rendering::*` commands and `face_detect::detect_face_keyframes` cease to exist.

#### 2. Prune the shared FFmpeg helper

**File**: `src-tauri/src/ffmpeg.rs`

**Intent**: Keep the sidecar-spawn helpers that surviving commands use (Whisper audio extraction); drop the render-only cancellable runner and its `render-progress` emission.

**Contract**: Retain `run_ffmpeg_output` (used by `whisper.rs:68`) and any helper still referenced by `waveform.rs`/`whisper.rs`. Remove `run_ffmpeg_cancellable` and the `frame=`/`render-progress` event block. After pruning, `grep render-progress src-tauri/` returns nothing.

#### 3. Deregister commands

**File**: `src-tauri/src/lib.rs`

**Intent**: Remove the deleted modules, the render command registrations, and the render registry managed state.

**Contract**: Remove `mod rendering;` and `mod face_detect;`; remove `.manage(rendering::RenderRegistry::new())`; remove `run_render`, `cancel_render`, `detect_hw_encoder`, `extract_thumbnail`, `detect_face_keyframes` from `generate_handler!`. Keep `project`, `whisper`, `waveform`, `ffmpeg` wiring.

#### 4. Bundle config

**File**: `src-tauri/tauri.conf.json`

**Intent**: Remove render-specific config if present; **keep** the `externalBin` FFmpeg sidecar entry.

**Contract**: `bundle.externalBin` retains the `ffmpeg` sidecar. Remove only render-specific permissions/config if any exist. Likely a no-op beyond verification.

### Success Criteria:

#### Automated Verification:

- Rust type-checks: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- No render references remain: `grep -rn "run_render\|detect_hw_encoder\|detect_face_keyframes\|render-progress\|RenderRegistry" src-tauri/src/` returns nothing
- Sidecar entry intact: `grep -n "externalBin\|ffmpeg" src-tauri/tauri.conf.json` still shows the ffmpeg sidecar

#### Manual Verification:

- App still launches via `npm run tauri dev` (backend boots without the render commands)
- Whisper transcription path still invokes the sidecar (audio extraction works)

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding to Phase 2.

---

## Phase 2: Frontend render removal + relocate survivors

### Overview

Delete the render-only frontend modules and the Render tab, strip `renderConfig` and its dependents from state/undo-redo/save-load, and relocate the selection-side survivors into `src/selection/`, leaving `src/render/` gone.

### Changes Required:

#### 1. Delete render-only modules

**File**: `src/render/queue.js` (delete), `src/render/settings.js` (delete), `src/render/subtitles.js` (delete)

**Intent**: Remove the render queue, render config/preset shapes, and subtitle burn-in builder.

**Contract**: Files removed. `defaultRenderConfig`, `PLATFORM_PRESETS`, `buildReelSrt`, and the queue API (`enqueueAll`/`cancelJob`/`cancelAll`/`setRerenderFn`) no longer exist.

#### 2. Relocate survivors

**File**: `src/render/fillers.js` → `src/selection/fillers.js`, `src/render/timeline.js` → `src/selection/timeline.js`, `src/render/waveform.js` → `src/selection/waveform.js` (then delete empty `src/render/`)

**Intent**: Move selection-side code to an honestly-named directory; `src/render/` ceases to exist.

**Contract**: Use `git mv` to preserve history. Update every importer: `src/ui/step2-analyze.js` (`isFiller`, `waveform.js`, `timeline.js`), `src/ui/step3-export.js` (`expandSpansWithFillerRemoval` — see #4, removed with render code). After the move, `grep -rn "render/" src/` returns nothing.

#### 3. Strip renderConfig from state + undo/redo

**File**: `src/state.js`, `src/ui/step2-analyze.js`

**Intent**: Remove `renderConfig`, `detectedHwEncoder`, `namedPresets` fields and the `defaultRenderConfig` import; drop them from the undo/redo snapshot and the `isVertical` timeline read.

**Contract**: `src/state.js` — remove the `import { defaultRenderConfig }` line and the three fields. `src/ui/step2-analyze.js` — remove `renderConfig` from the snapshot/restore (lines ~31/49-50/64-65); replace the `state.renderConfig?.aspect === 'vertical_9_16'` read (line ~194) so the timeline always draws horizontal (no vertical branch).

#### 4. Remove Render tab logic

**File**: `src/ui/step3-export.js`

**Intent**: Remove the Render tab handler, all `renderConfig` mutations, hw-encoder detection, queue wiring, subtitle/filler render imports, and the render functions — keeping the EDL/XML/Lua export tabs and their generators untouched.

**Contract**: Remove the `tabBtnRender` switch + `'Render'` case, `invoke('detect_hw_encoder')`, queue imports, `buildReelSrt`/`expandSpansWithFillerRemoval`/`PLATFORM_PRESETS` imports, and every `state.renderConfig.*` handler block. Keep `mergeAdjacentClips` import and `doGenerateEDL`/`doGenerateXML`/`doGenerateLua`.

#### 5. Remove render save/load + lazy import

**File**: `src/ui/step1-import.js`, `src/main.js`

**Intent**: Stop persisting `renderConfig` and stop lazy-loading the deleted queue.

**Contract**: `step1-import.js` — remove `renderConfig` from the save payload (line ~342) and load (line ~370). `main.js` — remove `await import('./render/queue.js')` (line ~110).

#### 6. Remove Render tab markup

**File**: `src/index.html`

**Intent**: Remove the Render tab button and panel.

**Contract**: Remove `#tabBtnRender` (lines ~363-367) and the `#tabRender` export panel (the render-settings cards). Leave EDL/XML/Lua tabs.

### Success Criteria:

#### Automated Verification:

- Production build succeeds: `npm run tauri build` (or at minimum `npx vite build`)
- Regression suite green: `node --experimental-vm-modules test/regression.js`
- No render references remain: `grep -rn "renderConfig\|render/\|detect_hw_encoder\|defaultRenderConfig\|PLATFORM_PRESETS\|buildReelSrt" src/` returns nothing
- `src/render/` no longer exists: `ls src/render/ 2>/dev/null` is empty/error; `ls src/selection/` shows the 3 survivors

#### Manual Verification:

- App boots via `npm run tauri dev`; no console errors about missing modules
- Import an SRT, run through to step 3, and the EDL/XML/Lua tabs each generate output
- The export tabs show no Render tab; timeline canvas in step 2 still draws (horizontal)

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding to Phase 3.

---

## Phase 3: Remove the Metadata feature

### Overview

Remove the Metadata/thumbnail feature surface end-to-end: generation button, metadata card, Meta export tab, thumbnail UI, `reelsMetadata` state, and the metadata prompt builder — leaving the main AI selection schema for S-01.

### Changes Required:

#### 1. Remove metadata state + undo/redo + save/load

**File**: `src/state.js`, `src/ui/step2-analyze.js`, `src/ui/step1-import.js`

**Intent**: Drop `reelsMetadata` from state, the undo/redo snapshot, and `.reelproj` persistence.

**Contract**: `state.js` — remove `reelsMetadata` (line ~52). `step2-analyze.js` — remove `reelsMetadata` from snapshot/restore (lines ~32/48/63). `step1-import.js` — remove `reelsMetadata` save (line ~341), load (line ~369), and the `renderMetadataList()` call (lines ~412-414).

#### 2. Remove metadata generation + prompt builder

**File**: `src/ui/step2-analyze.js`, `src/ai/prompt.js`

**Intent**: Remove the "Generuj metadane" handler, `renderMetadataList`, and the metadata prompt builder.

**Contract**: `step2-analyze.js` — remove `buildMetadataPrompt` import, the `genMetaBtn` handler, the metadata-generation flow, `renderMetadataList` (exported — also imported by step3, removed in #3), and the `thumbnailTimestamp` display (line ~1197). `prompt.js` — remove `buildMetadataPrompt`. **Do not** alter `buildPrompt` / the main selection schema; if `thumbnailTimestamp` is part of the main schema, leave the field and only drop its UI consumers (grep `thumbnailTimestamp` to confirm scope before deleting).

#### 3. Remove Meta export tab + thumbnail extraction

**File**: `src/ui/step3-export.js`

**Intent**: Remove the Meta tab handler, `initMetadataTab`, metadata export, thumbnail extraction, and `syncMetadataExportBtn`.

**Contract**: Remove the `tabBtnMeta` switch + `'Meta'` case, `renderMetadataList` import, `initMetadataTab`/`downloadMetadataJSON`/`extractAllThumbnails`/`syncMetadataExportBtn` (lines ~41, 311-312, 401-403, 944-1015), and the `invoke('extract_thumbnail')` call.

#### 4. Remove metadata markup

**File**: `src/index.html`

**Intent**: Remove the metadata button, card, Meta tab, and metadata/thumbnail panels.

**Contract**: Remove `#genMetaBtn` (line ~242), `#metadataCard`/`#metadataList` (lines ~246-249), `#tabBtnMeta` (lines ~368-372), and the Meta panel (`#metadataTabList`/`#downloadMetadataBtn`, lines ~661-663).

### Success Criteria:

#### Automated Verification:

- Production build succeeds: `npm run tauri build` (or `npx vite build`)
- Regression suite green: `node --experimental-vm-modules test/regression.js`
- No metadata references remain: `grep -rn "reelsMetadata\|renderMetadataList\|buildMetadataPrompt\|tabBtnMeta\|extract_thumbnail\|metadataCard\|genMetaBtn" src/` returns nothing

#### Manual Verification:

- App boots; AI selection still runs and produces reels (selection unaffected)
- No Metadata tab or "Generuj metadane" button remains; no console errors
- Undo/redo in step 2 still works after edits

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding to Phase 4.

---

## Phase 4: `.reelproj` v3 migration + regression fence

### Overview

Bump the project schema to v3, strip the dead `renderConfig`/`reelsMetadata` blobs on save, keep v2 load tolerant, and add a regression case proving an old project still exports cleanly.

### Changes Required:

#### 1. Schema v3 save + tolerant load

**File**: `src/ui/step1-import.js`

**Intent**: Write v3 projects without the removed fields and load v2 files without choking on their leftover blobs.

**Contract**: Bump the save payload's version to `3`. The save no longer emits `renderConfig`/`reelsMetadata` (already removed in Phases 2-3). On load, ignore any `renderConfig`/`reelsMetadata` keys present in a v2 file (do not assign them to state). `mergeThreshold`, `sentences`, `reelsData`, and core fields load as before.

#### 2. Back-compat regression case

**File**: `test/regression.js`

**Intent**: Guard the new risk — that loading/normalizing an old project still yields valid exports.

**Contract**: Add a case following the file's existing structure: construct a v2-shaped project object (containing `renderConfig` + `reelsMetadata` blobs plus valid `sentences` + `reelsData`), run it through the load-normalization path (or assert the exporters consume the normalized result), and assert `generateEDL`/`generateXML`/`generateLua` produce valid, non-empty output. Append-only — do not modify existing cases.

### Success Criteria:

#### Automated Verification:

- Regression suite green including the new case: `node --experimental-vm-modules test/regression.js`
- Production build succeeds: `npm run tauri build`
- Version stamped: saved `.reelproj` shows `"version": 3` and contains no `renderConfig`/`reelsMetadata` keys

#### Manual Verification:

- Load a pre-existing v2 `.reelproj` (one with a `renderConfig` blob) — it loads without error
- Export EDL, XML, and Lua from that loaded project — each generates and (spot-check) imports cleanly into the NLE
- Save the project — the new file is v3 with the dead blobs gone

**Implementation Note**: This is the final phase. After automated + manual verification passes, the regression fence is green end-to-end and F-01 is complete.

---

## Testing Strategy

### Unit / Regression Tests:

- Existing `test/regression.js` parser + EDL/XML/Lua cases must stay green at every phase boundary (the fence).
- New case (Phase 4): v2-shaped project with `renderConfig`/`reelsMetadata` → load-normalize → valid EDL/XML/Lua output.

### Integration / Manual Testing Steps:

1. `npm run tauri dev` — app boots after each phase, no missing-module/console errors.
2. Import an SRT → step 2 AI selection produces reels → step 3 generate EDL, XML, Lua.
3. Confirm no Render tab, no Meta tab, no "Generuj metadane" button.
4. Load an old v2 `.reelproj` with a `renderConfig` blob → exports work → re-save → file is v3.
5. Confirm Whisper transcription still extracts audio via the sidecar (sidecar survives).
6. Spot-check one exported timeline imports cleanly into Resolve/Premiere (guardrail: exporters un-regressed).

## Performance Considerations

Pure deletion — strictly reduces bundle size, command surface, and backend binary. No new hot paths. The kept sidecar usage (Whisper, waveform) is unchanged.

## Migration Notes

- `.reelproj` v2 → v3: no data migration needed; the removed fields are simply dropped. v2 files load via tolerant load (ignore unknown blobs); first save rewrites as v3. No re-transcription; Whisper/waveform caches untouched.
- `src/render/` → `src/selection/`: use `git mv` so history follows the 3 survivors.

## References

- Roadmap slice: `context/foundation/roadmap.md` §F-01 (lines 79-90)
- Worktree footprint + keep-fillers flag: `context/foundation/streams.md` (lines 37-59)
- PRD: `context/foundation/prd.md` FR-038 (line 154), guardrails (lines 61-64, 164-169)
- Frame math + invariants: `CLAUDE.md` §Key invariants
- Regression fence: `test/regression.js`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Backend render teardown (Rust)

#### Automated

- [x] 1.1 Rust type-checks: `cargo check --manifest-path src-tauri/Cargo.toml` — 6640609
- [x] 1.2 No render references remain in `src-tauri/src/` (grep clean) — 6640609
- [x] 1.3 Sidecar `externalBin` entry intact in `tauri.conf.json` — 6640609

#### Manual

- [x] 1.4 App launches via `npm run tauri dev` (backend boots without render commands) — 6640609
- [x] 1.5 Whisper path still invokes the sidecar (audio extraction works) — 6640609

### Phase 2: Frontend render removal + relocate survivors

#### Automated

- [x] 2.1 Production build succeeds: `npm run tauri build` (or `npx vite build`)
- [x] 2.2 Regression suite green: `node --experimental-vm-modules test/regression.js`
- [x] 2.3 No render references remain in `src/` (grep clean)
- [x] 2.4 `src/render/` gone; `src/selection/` holds fillers/timeline/waveform

#### Manual

- [x] 2.5 App boots, no missing-module console errors
- [x] 2.6 SRT import → EDL/XML/Lua tabs each generate output
- [x] 2.7 No Render tab; step-2 timeline canvas still draws (horizontal)

### Phase 3: Remove the Metadata feature

#### Automated

- [ ] 3.1 Production build succeeds
- [ ] 3.2 Regression suite green
- [ ] 3.3 No metadata references remain in `src/` (grep clean)

#### Manual

- [ ] 3.4 App boots; AI selection still produces reels
- [ ] 3.5 No Metadata tab / "Generuj metadane" button; no console errors
- [ ] 3.6 Undo/redo in step 2 still works

### Phase 4: `.reelproj` v3 migration + regression fence

#### Automated

- [ ] 4.1 Regression suite green incl. new back-compat case
- [ ] 4.2 Production build succeeds
- [ ] 4.3 Saved `.reelproj` is `version: 3` with no `renderConfig`/`reelsMetadata`

#### Manual

- [ ] 4.4 Old v2 `.reelproj` (with `renderConfig`) loads without error
- [ ] 4.5 EDL/XML/Lua export from the loaded project; spot-check NLE import
- [ ] 4.6 Re-saved project is v3 with dead blobs gone
