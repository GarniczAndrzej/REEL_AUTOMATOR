# UI/UX Redesign — Simpler, Decluttered Flow (S-16) Implementation Plan

## Overview

Rewrite the three-step `goStep(n)` wizard (`import → analyze → export`) into **one progressive single working surface** where import/transcribe, scored-reel review + segment tuning, and export read as one continuous task. App-level configuration (API key, model, merge-gap, project defaults) moves into a **settings modal**; export becomes a **quick-export popover**; project settings auto-populate from the imported video; the proposed-reels list is decluttered (no in-list playback, no per-reel timeline, component scores surfaced); and dead controls + dead CSS are pruned.

This is **almost entirely a presentation/orchestration rewrite**. No exporter or frame-math changes. All user-facing strings stay Polish. There are two pieces of net-new plumbing: (a) a `localStorage` settings bag + consolidation of duplicated state keys (with a tolerant `.reelproj` schema bump), and (b) **one small backend command** that probes an imported video for fps + resolution so the project-settings auto-populate (#4/#5) is backed by real detection rather than left at hard-coded defaults. The FFmpeg sidecar already exists; this command reuses it.

## Current State Analysis

- **`goStep(n)` (`src/main.js:8-14`) is the entire step switch** — 7 lines that toggle `.active` on three permanently-rendered panels with **zero gating**. Forward nav is asymmetric (step 2→3 has a button, step 1→2 has none); jumping to an empty step 3 produces `alert('Brak danych reelsów!')` (`step3-export.js:128`).
- **The pub-sub is vestigial** (`state.js:99-106`): ~30 `emit()` calls but only **two subscribers** (sidebar status `main.js:66-70`, preview src `step2-reel-list.js:206`). UI updates are imperative DOM mutation.
- **State encodes duplication**: `videoFilename` (`state.js:44`) vs `videoFilename2` (`state.js:61`) are separate keys kept in sync by hand (`step1-import.js:140-143`); `mergeThreshold` is a global field **and** a per-reel "Próg" slider (`reel-list:392`).
- **`step1-import.js` is 1122 LOC** — S-17 explicitly deferred splitting it here (`context/archive/2026-06-15-s-17/plan.md:28`) because S-16 rewrites the shell anyway. `step2-*` is already split into orchestrator (`step2-analyze.js`) + submodules (`prompt-panel`, `reel-list`, `segment-ops`) — the pattern to follow.
- **No toast system**: 20+ blocking native `alert()`/`confirm()` calls; `showStatus` (`main.js:111-119`) writes only to `#apiStatus`.
- **`.reelproj` writer is at v4** (`step1-import.js:363`) with tolerant `if (data.x != null)` load guards (`:393-411`). CLAUDE.md says v3 (stale doc); the writer is the source of truth.
- **Visual layer is clean & token-based** (`styles.css:11-28` `:root` palette, dark-only, Syne + DM Mono). Colors are tokenized; **spacing/type-scale/radii are hard-coded**. ~80 lines of dead render-queue CSS (`styles.css:955-1027`, F-01 orphans) are unreferenced.

### Key Discoveries:

- **S-17 remnants are NOT removed (research/roadmap #9 was wrong).** The compare modal and AI-cache control are still live: `index.html:419` (`Porównaj dostawców`), `:426-429` (`clearLlmCacheBtn`/`Cache AI`), `:971-984` (`#compareModal`); handlers at `step2-prompt-panel.js:22-25,47,258,267`. **S-16 owns removing them.**
- **Load-bearing hooks a restyle must preserve**: canvas `data-reel-idx`/`data-clip-idx`/`data-sentence-id` (`reel-list`, `segment-ops`), `.clip-waveform` (waveform trim UI), modal overlay IDs, `.export-tab`/`.export-panel` pairing, `#previewVideo` fixed positioning. The per-reel **timeline** canvas (`reel-list:238-268`) and `tl-play-btn` (`:271-296`) are being removed (#14) — confirm the waveform-trim path (`selection/waveform.js`) does not depend on the per-reel timeline canvas (it keys off `clip-waveform`/`data-sentence-id`, which stay).
- **`localStorage` settings precedent exists**: `edl_whisper_advanced` (per-machine perf knobs, `state.js:83`), `edl_apikey_openrouter`, `edl_or_models_cache`. The settings bag reuses this pattern.
- **Component scores already exist in the schema**: `Reel.scores {hook, flow, value, trend}` (`state.js:34`) — #14 surfaces existing data, no new AI/schema work.

## Desired End State

A first-time editor opens the app to a single working surface. They add a video (and optionally an `.srt`); project settings (fps, EDL filename, resolution) auto-populate. When no SRT is present they start transcription from the import section (manual `transcribeBtn` as today — auto-start-on-import is deferred to S-05/S-07, see *What We're NOT Doing*). As data arrives, the review section reveals itself; the reel list shows compact Hook/Flow/Value/Trend badges with no per-reel timeline or play button. They click "Analizuj z OpenRouter", review reels, and export via a quick-export popover (EDL/XML/Lua up front; SRT/VTT/`.md`/prompt-copy behind a "more" expander). API key, model, and merge-gap live in a settings modal reachable from the header; merge-gap persists across sessions. Non-blocking feedback appears as toasts; only genuinely destructive actions still use native `confirm()`. No dead controls (compare/cache/`minChars`/add-another-video) remain.

**Verification**: the full manual acceptance checklist (Phase 4) passes — happy path, every export format, save/load round-trip including an old-schema file, and settings persistence across restart — and `node --experimental-vm-modules test/regression.js` stays green throughout (parser/exporters untouched).

## What We're NOT Doing

- **No exporter or frame-math changes.** `src/exporters/*`, `src/parser/*`, the integer-frame invariant, and the CMX-3600 offset are untouched.
- **No deeper slice work**: not building the full S-08 export set, S-04 threshold-tuning UX, or S-02 scoring-first ranking — S-16 builds the *homes* (popover, settings modal, decluttered list) wired to **existing** exporter fns / threshold / `Reel.scores`. Those slices land into these homes later.
- **#13 (WhisperX transcription queue + audio-file input)** — out of scope, separate slice off S-05.
- **Auto-start transcription on video-add** — out of scope. Transcription stays manual (`transcribeBtn`); wiring video-add → auto-transcribe-when-SRT-absent is coordinated with S-05/S-07, not built here.
- **No light-mode / ground-up reskin** — the token palette stays; Phase 4 regularizes spacing/scale only.
- **No "fixing" of intentional behavior**: speaker labels stay data-only (not shown in SRT/UI); saves always prompt for a location (no silent auto-save).
- **No custom async confirm modal** — destructive actions keep native `confirm()`.

## Implementation Approach

Bottom-up, lowest-risk-first. Phase 1 lands the risky state/schema plumbing and the shared primitives (settings store, toast) behind a save/load round-trip, plus all pure-deletion cleanup. Phase 2 replaces the orchestration shell with a state-driven progressive surface and the settings modal. Phase 3 is split to keep the large refactor bisectable on a manual-only guard: Phase 3a does the behavior-neutral `step1-import.js` extraction (orchestrator+submodule pattern, no behavior change) and Phase 3b layers the declutters/auto-populate/popover on top. Phase 4 is the visual regularization pass + manual acceptance. Each phase ends green on `regression.js` and a manual check.

## Critical Implementation Details

- **State sequencing — consolidate before re-homing.** The duplicated keys (`videoFilename2`, per-reel threshold) must be collapsed in Phase 1 so Phase 3's auto-populate (#4) and decluttered list write to a single source of truth. Re-homing UI onto still-duplicated state would bake the duplication into the new shell.
- **Tolerant load is the migration.** Bump the `.reelproj` writer to v5 writing only consolidated keys; keep the `if (data.x != null)` guard pattern (`step1-import.js:393-411`) and map any legacy `videoFilename2` to the consolidated key only when the primary is absent. Old v3/v4 files must still load (round-trip test gates this).
- **Section gating replaces `goStep`, not the pub-sub.** The progressive surface reveals/enables sections from real state (`srtContent`/`sentences.length`/`reelsData.length`). Drive it through a single render-on-change controller subscribing to `emit()` — do not assume `emit()` re-renders anything today beyond the two existing subscribers.

## Phase 1: Foundation — state consolidation, settings store, toast, cleanup

### Overview

Land the net-new state plumbing and shared primitives, and do every pure deletion, before any layout changes. Nothing user-visible should regress; the surface still uses the old `goStep` shell at the end of this phase.

### Changes Required:

#### 1. Consolidate duplicated state keys

**File**: `src/state.js`, `src/ui/step1-import.js`, `src/ui/step2-prompt-panel.js`

**Intent**: Remove `videoFilename2` as a separate key so video metadata has one source of truth; route the merge-gap (`mergeThreshold`) through a single value. Drop the `minChars` **UI control + `state.minChars`** (pruned, #7) — note this is the UI knob only, not the parser parameter (see below).

**Contract**: `state.videoFilename2` removed; all readers (`prompt-panel.js:107,288,430`) and the sync writers (`step1-import.js:140-143`) point at `state.videoFilename`. `state.minChars` and the `#minChars` input removed. `mergeThreshold` remains a single key, fed by the settings bag (item 2). No change to `gapFrames` (separate SRT-parse concern, not the merge-gap).

**`minChars` is a parser parameter, not just a knob.** `parseSRT`/`parseVTT` (`src/parser/srt.js:122,59`) and `segmentFromWords` (`src/parser/word-segments.js:22`) take `minChars` as a required argument and `src/parser/*` is in the no-touch zone. So removing the UI control must **not** touch the parser signatures: introduce a single module-level `const MIN_CHARS = 20;` in `step1-import.js` (matching the current `state.minChars: 20` default) and pass it at every call site (`step1-import.js:183,197,213,229,984`). The "no dead identifiers" greps below are therefore **scoped to UI surfaces** — they must exclude `src/parser/`, where `minChars` legitimately remains.

#### 2. `localStorage` settings bag

**File**: `src/settings.js` (new)

**Intent**: A small persisted app-settings store mirroring the `edl_whisper_advanced` precedent, holding the merge-gap (#6) and project defaults; survives sessions.

**Contract**: `loadSettings()` / `saveSettings(partial)` reading/writing one JSON blob under key `edl_app_settings`. On boot, `state.mergeThreshold` is seeded from the bag (falling back to the current `12` default). JSDoc-typed boundaries.

#### 3. `.reelproj` schema bump to v5 with tolerant load

**File**: `src/ui/step1-import.js` (`writeProject` `:362`, `applyProjectData` `:392`)

**Intent**: Stop writing the removed/duplicated keys; keep reading old files tolerantly.

**Contract**: `version: 5`; payload drops `videoFilename2` and `minChars` now. The writer also stops emitting `sources` and the per-reel `reelsData[ri].mergeThreshold` **in lockstep with the feature removals in Phase 3b** (so v5 never carries dead plumbing once those land). `applyProjectData` keeps `if (data.x != null)` guards and stays tolerant of legacy `videoFilename2`/`minChars`/`sources`/per-reel-threshold in old files (mapped or ignored, never erroring); legacy `videoFilename2` maps to `state.videoFilename` only when `data.videoFilename` is absent. v3/v4 files load without error.

#### 4. Toast helper

**File**: `src/ui/toast.js` (new), `src/styles.css`

**Intent**: One lightweight non-blocking feedback primitive (success/error/info) to replace informational `alert()`s; destructive `confirm()`s stay native.

**Contract**: `toast(message, type)` appends a transient, auto-dismissing, stacking element to a fixed container; Polish-string callers. Minimal CSS using existing color tokens (`--green`/`--red`/`--accent`). Migrate informational `alert()` call sites (e.g. cache-cleared, export-done) to `toast`; leave `confirm()` for destructive choices.

#### 5. Remove dead CSS and live S-17 remnants

**File**: `src/styles.css` (`:955-1027`), `src/index.html` (`:419,426-429,971-984`), `src/ui/step2-prompt-panel.js` (`:22-25,47,258,267`)

**Intent**: Delete the ~80 lines of F-01 dead render-queue CSS and the still-live compare-modal + AI-cache controls (the #9 remnants research wrongly believed gone).

**Contract**: `.render-reel-row`/`.render-progress-*`/`.status-pill`/`.status-*`/`.aspect-badge` CSS removed; `#compareModal`, `Porównaj dostawców` trigger, `clearLlmCacheBtn`/`Cache AI` button and their JS handlers removed. `grep` for each identifier returns nothing in `src/`.

#### 6. Backend video-metadata probe command (`probe_video_metadata`)

**File**: `src-tauri/src/ffmpeg.rs` (or a small new `metadata.rs`), `src-tauri/src/lib.rs` (command registration)

**Intent**: Provide real fps + resolution detection for the auto-populate (#4/#5), so the source-file card can become read-only without locking every project to the hard-coded `1920x1080` default that the XML exporter (`src/exporters/xml.js:13`) depends on. This is the one backend addition; it reuses the existing FFmpeg sidecar (no new external binary).

**Contract**: New Tauri command `probe_video_metadata(path) -> { fps: f64, width: u32, height: u32 }` spawning the bundled FFmpeg sidecar via the existing `run_ffmpeg_output` helper (parse `ffmpeg -i` stderr for stream `fps` and `WxH`; tolerate missing fields by returning `None`/falling back, never erroring the import). Registered in `lib.rs`. Frontend consumes it in Phase 3 (import section); on probe failure the fields fall back to the current editable defaults rather than blocking import.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- No dead identifiers remain in UI surfaces: `grep -rn "videoFilename2\|minChars\|compareModal\|clearLlmCacheBtn\|render-reel-row\|aspect-badge" src/ --exclude-dir=parser` returns empty (`minChars` legitimately stays in `src/parser/` as a function parameter — excluded by design)
- Prettier clean: `npx prettier --check "src/**/*.{js,css,html}"`

#### Manual Verification:

- App boots; existing happy path (import → analyze → export) still works under the old shell
- Save a project, reload it, and load an older (v3/v4) `.reelproj` — all fields restore, no errors
- Merge-gap value set in this session persists after an app restart
- An informational notice now appears as a toast (not a blocking dialog)
- `probe_video_metadata` returns plausible fps + WxH for a test video (and falls back without erroring on a file it can't parse)

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Shell + gating — progressive single surface & settings modal

### Overview

Replace `goStep(n)` with a state-driven progressive surface and move app config into a settings modal. The header API/model bar moves into the modal; the sidebar stepper becomes a progress/orientation cue with gated states.

### Changes Required:

#### 1. Progressive single-surface layout

**File**: `src/index.html`, `src/main.js`, `src/ui/surface.js` (new)

**Intent**: Lay out import → review → export as one scrolling surface; reveal/enable later sections from real state instead of toggling three panels.

**Contract**: `index.html` restructured from three `.active`-toggled panels into one continuous surface with section regions. A `surface.js` controller subscribes to `emit()` and reveals/gates sections on `state.srtContent`/`sentences.length`/`reelsData.length`. `goStep(n)` and its `reel:goStep` bridge are removed from `main.js`; the `reel:goStep:3` dispatch (`step2-analyze.js:23-25`) is replaced by a scroll/reveal call. Load-bearing hooks (canvas `data-*`, modal IDs, `.export-tab`/`.export-panel`, `#previewVideo`) preserved.

#### 2. Settings modal

**File**: `src/index.html`, `src/ui/settings-modal.js` (new), `src/main.js`

**Intent**: House API key + OpenRouter model picker + merge-gap + project defaults in a modal reusing the existing `.modal-overlay`/`.modal-box` pattern; remove the dense header API bar.

**Contract**: New `#settingsModal` (mirrors `#whisperAdvancedModal` structure) with a header trigger button. API key input + `orModelWrap` picker move here from the header (`index.html:22-49`); `saveApiKey`/`loadApiKey` (`main.js:88-109`) rewire to the modal. Merge-gap control reads/writes the settings bag (Phase 1 item 2). Polish labels.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- No `goStep`/`reel:goStep` references remain: `grep -rn "goStep" src/` returns empty
- Prettier clean: `npx prettier --check "src/**/*.{js,css,html}"`

#### Manual Verification:

- Sections reveal/gate correctly: export is not reachable with no reels (no more after-the-fact `alert`)
- Settings modal opens, saves API key + model, persists merge-gap; header is decluttered
- Full happy path still completes on the new surface
- Preview video and all canvas-backed surfaces still render

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3a: Structural split — `step1-import.js` (behavior-neutral)

### Overview

Extract the 1158-LOC `step1-import.js` monolith into an orchestrator + submodules following the `step2-analyze.js` pattern, **with zero behavior change**. No control is pruned, moved, or re-homed in this phase — code moves files only. This isolates the large mechanical refactor so that the manual acceptance pass (the only UI guard) can attribute any regression to the split alone, before the declutters in 3b layer behavior changes on top.

### Changes Required:

#### 1. `step1-import.js` orchestrator + submodule extraction

**File**: `src/ui/step1-import.js` → orchestrator + submodules (e.g. `src/ui/import/transcribe.js`, `import/project-io.js`, `import/segments.js`), `src/index.html` (only if import markup needs re-parenting)

**Intent**: Split the monolith following the `step2-analyze.js` orchestrator + submodule pattern. Pure code movement — every control, handler, and state interaction behaves identically before and after.

**Contract**: `step1-import.js` becomes a thin orchestrator delegating to focused submodules (transcription, project I/O, segment preview). No identifiers pruned, no fields made read-only, no diarization move — those are 3b. The import section's runtime behavior is byte-for-byte equivalent; the only diff is module boundaries.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- Prettier clean: `npx prettier --check "src/**/*.{js,css,html}"`

#### Manual Verification:

- The full import → analyze → export happy path behaves **exactly** as before the split (no visible change) — this is the control for 3b
- Transcription, project save/load, and segment preview all still work unchanged

**Implementation Note**: Pause for manual confirmation before proceeding — confirm the split is behavior-neutral before layering declutters.

---

## Phase 3b: Re-home & declutter

### Overview

Apply the per-section declutters (#4, #5, #7, #10, #11, #12, #14, diarization) on top of the now-split import module: auto-populate project settings, prune dead controls, re-home diarization, declutter the reel list, and replace the export step with the quick-export popover.

### Changes Required:

#### 1. Import section — auto-populate, prune, re-home diarization

**File**: `src/ui/import/*` (the submodules from 3a), `src/index.html`

**Intent**: Auto-populate fps / EDL filename / resolution from the added video (#4, #5); prune `minChars` (#7) and add-another-video (#12); move the diarization cluster into the WhisperX advanced modal.

**Contract**: `minChars` field and the "Dodaj kolejne źródło wideo" control (`step1:129`) removed from HTML + JS. Project-settings fields become auto-populated/read-only, written from the `probe_video_metadata` result (Phase 1 item 6) on import — `state.fps`/`state.videoResolution`/`state.videoFilename` set from the probe; on probe failure they retain editable defaults. Diarization toggle + HF token + min/max speakers move into `#whisperAdvancedModal`. `sources[]` multi-source repeater removed.

#### 2. Review section — declutter reel list

**File**: `src/ui/step2-reel-list.js`, `src/ui/step2-prompt-panel.js`, `src/index.html`

**Intent**: Drop in-list playback + per-reel timeline (#14); surface Hook/Flow/Value/Trend badges; rename "Analizuj z AI" → "Analizuj z OpenRouter" (#10); demote paste-JSON, make copy-prompt-as-`.md` the primary action (#11); drop the per-reel "Próg" slider in favor of the single settings merge-gap.

**Contract**: `tl-play-btn` (`reel-list:271-296`) and per-reel timeline canvas (`reel-list:238-268`) removed; reel header renders `Reel.scores` axes as compact badges beside `virality_score`. Per-reel threshold slider (`reel-list:392`) removed. **The per-reel override is removed end-to-end, not just its UI**: drop the `reel.mergeThreshold ?? state.mergeThreshold` read fallback at the merge-span computation (`reel-list:114,314`) so every reel uses the single settings merge-gap, stop writing `reelsData[ri].mergeThreshold`, and stop emitting it in the v5 writer. Old `.reelproj` files that carry per-reel overrides load tolerantly — the saved field is simply ignored. This is a deliberate **export-span behavior change** for any project that relied on a per-reel override (now folded into the global gap); recorded in Migration Notes. `analyzeBtn` label (`html:415`) → "Analizuj z OpenRouter". Copy-prompt button copies `.md`; paste-JSON panel moved behind an optional/secondary affordance; file export of the prompt demoted to secondary. Preserve `.clip-waveform` + `data-sentence-id` hooks (waveform trim path).

#### 3. Export quick-export popover

**File**: `src/ui/step3-export.js` → `src/ui/export-popover.js`, `src/index.html`

**Intent**: Replace the export step with a popover: EDL/XML/Lua up front, SRT/VTT/`.md`/prompt-copy behind a "more" expander; the "Plik wideo źródłowy" card becomes read-only/auto-detected (#5).

**Contract**: Popover reuses the existing `generateEDL/XML/Lua` fns (unchanged) and existing transcript/prompt exporters; per-format generate + copy/download. Source-file card (`step3:21-42`: `videoFilename2`/`videoPath`/`resolutionSelect`/`projectName`) becomes non-editable display sourced from the `probe_video_metadata`-populated state (Phase 1 item 6 / Phase 3 item 1) — `videoResolution` shown read-only but real, so XML export keeps the correct dimensions. `updateSummary` wiring preserved or folded into the popover open.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- No pruned-control references remain in UI surfaces: `grep -rn "minChars\|tl-play-btn\|Analizuj z AI\|Dodaj kolejne" src/ --exclude-dir=parser` returns empty (`minChars` stays in `src/parser/` by design)
- Prettier clean: `npx prettier --check "src/**/*.{js,css,html}"`

#### Manual Verification:

- Import auto-populates fps / filename / resolution; no manual project-settings entry needed
- Reel list shows component-score badges, no timeline/play button; preview still works via floating player
- "Analizuj z OpenRouter" runs; copy-prompt yields `.md`; paste-JSON still reachable as secondary
- Quick-export popover produces correct EDL/XML/Lua and (via expander) SRT/VTT/`.md`/prompt-copy
- Diarization controls now live in the advanced modal and still function

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Restyle + acceptance

### Overview

Visual regularization (spacing/type-scale/radii) and the full manual acceptance pass — the only guard for a UI rewrite with no automated UI coverage.

### Changes Required:

#### 1. Spacing / scale / radius regularization

**File**: `src/styles.css`

**Intent**: Tokenize and regularize the hard-coded spacing, type scale, and radii flagged in research; tighten visual hierarchy (one clear primary action per section state, secondary controls demoted) without changing the palette.

**Contract**: Add spacing/radius/type-scale custom properties to `:root` and apply them across the new surface components; no color-token changes; dark-mode-only preserved. Load-bearing structural hooks untouched.

#### 2. Acceptance pass + doc sync

**File**: `CLAUDE.md` (schema version note), `context/changes/s-16/` (acceptance log)

**Intent**: Run the full manual checklist; correct the stale CLAUDE.md schema-version line (v3 → v5) and the architecture description of the shell.

**Contract**: CLAUDE.md "Project file" section updated to schema v5 and the `goStep` 3-step description replaced with the progressive-surface description. Acceptance results recorded.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- Prettier clean: `npx prettier --check "src/**/*.{js,css,html}"`

#### Manual Verification (full acceptance checklist):

- Happy path: add video (+ optional `.srt`) → transcribe manually when SRT absent → analyze → review/declutter list → export
- Every export format verified: EDL, XML, Lua, SRT, VTT, `.md`, AI-prompt copy
- Save → load `.reelproj` round-trip restores all state; an older v3/v4 file loads cleanly
- Settings (API key, model, merge-gap) persist across an app restart
- All strings are Polish; no blocking dialogs for informational notices; destructive actions still confirm
- Visual hierarchy reads as one continuous flow; no orphaned/dead controls

**Implementation Note**: Final phase — confirm full acceptance with the human before closing the change.

---

## Testing Strategy

### Unit / Regression Tests:

- `test/regression.js` (parser + EDL/XML/Lua exporters) must stay green at every phase boundary — it is the only automated guard and the exporters are intentionally untouched, so any failure means an accidental pipeline regression.

### Manual Testing Steps:

1. Fresh import of a video without SRT → start transcription manually → segments appear; project settings auto-populated.
2. Import a video **with** an `.srt` → no transcription; segments parsed.
3. Run "Analizuj z OpenRouter" → reels appear with component-score badges; no per-reel timeline/play.
4. Open quick-export popover → generate + copy/download each of EDL/XML/Lua, then SRT/VTT/`.md`/prompt-copy via "more".
5. Save project → reload → all state restored. Load a pre-existing v3/v4 `.reelproj` → loads without error.
6. Set merge-gap in settings → restart app → value persists.
7. Trigger an informational action (e.g. export done) → toast, not blocking dialog. Trigger a destructive action → native confirm still appears.

## Performance Considerations

The progressive single surface renders all sections in one DOM; gating is visibility/enablement, not unmounting. This is acceptable at current data volumes (the old shell already kept all three panels in the DOM permanently). The `emit()`-driven controller should batch/guard re-renders so a burst of mutations doesn't thrash the surface.

## Migration Notes

`.reelproj` schema bumps v4 → v5; old files load via the existing tolerant `if (data.x != null)` guards, with legacy `videoFilename2` mapped to `videoFilename` only when the primary is absent. Legacy per-reel `reelsData[ri].mergeThreshold` values are **ignored on load** (the override is removed end-to-end, item Phase 3.2): such projects now merge spans with the single global settings gap instead — a deliberate, one-way behavior change, not a regression. No data migration tool needed — read-tolerance is the migration. CLAUDE.md's schema-version note (currently says v3) is corrected in Phase 4.

## References

- Internal research: `context/changes/s-16/research.md`
- Roadmap S-16 contract: `context/foundation/roadmap.md:277-311`
- step2 orchestrator+submodule pattern to mirror: `src/ui/step2-analyze.js` + `step2-prompt-panel.js` / `step2-reel-list.js` / `step2-segment-ops.js`
- Tolerant load precedent: `src/ui/step1-import.js:392-411`
- Settings-store precedent: `edl_whisper_advanced` (`src/state.js:83`)
- Dead CSS: `src/styles.css:955-1027`
- S-17 deferral of the step1 split: `context/archive/2026-06-15-s-17/plan.md:28`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Foundation — state consolidation, settings store, toast, cleanup

#### Automated

- [x] 1.1 Rust type-check passes — ce66347
- [x] 1.2 Regression suite passes — ce66347
- [x] 1.3 No dead identifiers remain (grep empty) — ce66347
- [x] 1.4 Prettier clean — ce66347

#### Manual

- [x] 1.5 App boots; old-shell happy path still works — ce66347
- [x] 1.6 Save/reload + old v3/v4 `.reelproj` load with no errors — ce66347
- [x] 1.7 Merge-gap persists across restart — ce66347
- [x] 1.8 Informational notice appears as a toast — ce66347
- [x] 1.9 `probe_video_metadata` returns fps + WxH for a test video; falls back without error on unparseable input — ce66347

### Phase 2: Shell + gating — progressive single surface & settings modal

#### Automated

- [x] 2.1 Rust type-check passes — 4ab16f7
- [x] 2.2 Regression suite passes — 4ab16f7
- [x] 2.3 No `goStep`/`reel:goStep` references remain — 4ab16f7
- [x] 2.4 Prettier clean — 4ab16f7

#### Manual

- [x] 2.5 Sections reveal/gate correctly; export unreachable without reels — 4ab16f7
- [x] 2.6 Settings modal saves key+model, persists merge-gap; header decluttered — 4ab16f7
- [x] 2.7 Full happy path completes on new surface — 4ab16f7
- [x] 2.8 Preview + canvas surfaces still render — 4ab16f7

### Phase 3a: Structural split — `step1-import.js` (behavior-neutral)

#### Automated

- [x] 3a.1 Rust type-check passes — fd2c6f7
- [x] 3a.2 Regression suite passes — fd2c6f7
- [x] 3a.3 Prettier clean — fd2c6f7

#### Manual

- [x] 3a.4 Import → analyze → export happy path behaves exactly as before the split (control for 3b) — fd2c6f7
- [x] 3a.5 Transcription, save/load, segment preview unchanged — fd2c6f7

### Phase 3b: Re-home & declutter

#### Automated

- [x] 3b.1 Rust type-check passes
- [x] 3b.2 Regression suite passes
- [x] 3b.3 No pruned-control references remain (UI surfaces; `--exclude-dir=parser`)
- [x] 3b.4 Prettier clean

#### Manual

- [x] 3b.5 Import auto-populates fps/filename/resolution
- [x] 3b.6 Reel list shows score badges, no timeline/play; preview works
- [x] 3b.7 "Analizuj z OpenRouter" runs; copy-prompt `.md`; paste-JSON secondary
- [x] 3b.8 Quick-export popover produces all formats correctly
- [x] 3b.9 Diarization controls work from the advanced modal

### Phase 4: Restyle + acceptance

#### Automated

- [ ] 4.1 Rust type-check passes
- [ ] 4.2 Regression suite passes
- [ ] 4.3 Prettier clean

#### Manual

- [ ] 4.4 Full happy path (video ± SRT → export) verified
- [ ] 4.5 Every export format verified (EDL/XML/Lua/SRT/VTT/.md/prompt)
- [ ] 4.6 Save/load round-trip + old-schema file load
- [ ] 4.7 Settings persist across restart
- [ ] 4.8 All strings Polish; no blocking informational dialogs; destructive still confirm
- [ ] 4.9 Visual hierarchy reads as one continuous flow; no dead controls
- [ ] 4.10 CLAUDE.md schema/shell description corrected
