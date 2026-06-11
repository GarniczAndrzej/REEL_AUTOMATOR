# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Reels EDL Automator** — a Tauri 2 desktop app (Vite + vanilla JS frontend, Rust backend) that converts SRT subtitle files into edit timelines (EDL / FCP XML / DaVinci Resolve Lua) using an LLM. The in-app MP4 render path was removed in F-01; the bundled FFmpeg sidecar remains, now used only for Whisper audio extraction and the waveform UI. All user-facing strings are Polish.

`legacy/ReelAutomatorAI.html` and `ReelAutomatorAI.html` are the original single-file browser prototypes — kept for reference but not the active app.

## Commands

```bash
# Development (starts Vite dev server + Tauri window)
npm run tauri dev

# Production build
npm run tauri build

# Rust type-check only (fast, no link)
~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml

# Rust build only
~/.cargo/bin/cargo build --manifest-path src-tauri/Cargo.toml

# Run regression tests (parser + exporter correctness)
node --experimental-vm-modules test/regression.js

# Format (Prettier — no npm script wired up; run directly)
npx prettier --write "src/**/*.{js,css,html}"
```

Prettier is configured (`.prettierrc` → `{ "singleQuote": true }`) but there is no
lint/format npm script and no CI gate — run it manually as above. No ESLint.

## Key invariants

**Frame math** — all timeline arithmetic uses integer frames. `parseTime()` → seconds → `Math.round(seconds * fps)` → frames. Never round to seconds mid-pipeline. EDL record timecode starts at `3600 * fps` (1-hour offset, CMX 3600 convention).

**`mergeAdjacentClips` is the export span source** — it converts `reel.clip_ids` → merged `{start_frame, end_frame}` spans, consumed by the EDL/XML/Lua exporters. The merge threshold defaults to 12 frames (~0.5s at 24fps); 0 disables merging.

## Architecture

### Frontend (`src/`)

ES module app served by Vite. Entry point is `src/index.html` → `src/main.js`.

**State** lives in `src/state.js` as a single mutable object exported as `state`. Changes are broadcast via a minimal pub-sub: `emit()` notifies all `subscribe(fn)` listeners. Nothing is reactive beyond this — components read `state` directly. (The "call `emit()` after every mutation" rule lives in *Frontend state & module conventions* below.)

**Three-step pipeline** driven by `goStep(n)` in `main.js`:
1. `src/ui/step1-import.js` — SRT/video file drop/parse, Whisper transcription trigger, project save/load
2. `src/ui/step2-analyze.js` — AI analysis, reel JSON editor
3. `src/ui/step3-export.js` — EDL/XML/Lua export tabs

**Exporters** (`src/exporters/`) are pure functions: `generateEDL(opts)`, `generateXML(opts)`, `generateLua(opts)`. They read `sentences` + `reelsData` and return strings.

**Parser** (`src/parser/`):
- `srt.js` — `parseSRT(text, fps, minChars)` merges SRT cues into full sentences (punctuation-terminated), returns `sentences[]` with `{id, text, start_frame, end_frame, duration_frame, start_tc, end_tc}`.
- `segments.js` — `mergeAdjacentClips(clipIds, sentences, thresholdFrames)` collapses adjacent sentence IDs whose gap is ≤ threshold into merged spans. This is the input to the exporters.

**Selection support** (`src/selection/`) — relocated here from the removed `src/render/` in F-01:
- `fillers.js` — Polish filler word sets (`ALWAYS_FILLERS`, `CONTEXT_FILLERS`) used by step-2 selection. Also still exports `expandSpansWithFillerRemoval(mergedSpans, sentences, fps)`, retained for S-04 (currently no consumer).
- `timeline.js` — `drawTimeline(canvas, reel, sentences, fps, playheadFrame)` renders a reel's source-timeline (per-clip blocks + playhead) onto a 2D canvas. Pure draw; caller sets canvas intrinsic width first.
- `waveform.js` — in-memory RMS-peak cache (`sentenceId → Float32Array`). `loadWaveform(...)` lazily `invoke`s the `extract_waveform` backend command; `cachedPeaks` / `invalidateWaveform` manage the cache.

**AI providers** (`src/ai/providers.js`) — `callGemini`, `callClaude`, `callOpenRouter` each return a raw string; the caller strips ` ```json ` fences and `JSON.parse`s. The LLM schema is fixed in `src/ai/prompt.js` — changing it requires updating every consumer. Model names are constants in `src/ai/models.js` (`GEMINI_MODEL`, `CLAUDE_MODEL = 'claude-opus-4-7'`).

**LLM disk cache** (`src/ai/cache.js`) — `withLlmCache(cacheKey, callFn)` wraps any provider call with a Tauri-backed disk cache keyed by SHA-256 of `cacheKey`, returning `{ result, fromCache, hashShort }`. Outside Tauri it falls through and calls `callFn` directly (no cache).

**OpenRouter model picker** (`src/ai/openrouter-picker.js`) — searchable dropdown UI for the OpenRouter model list; loads/filters models and writes the selection back to `state`. Model list cached under `edl_or_models_cache`.

### Backend (`src-tauri/src/`)

Rust modules registered as Tauri commands in `lib.rs`:

| Command | Module | Purpose |
|---|---|---|
| `save_project` | `project.rs` | Write `.reelproj` JSON file |
| `load_project` | `project.rs` | Read `.reelproj` JSON file |
| `transcribe_video` | `whisper.rs` | Extract audio + run `whisper-cli`, return SRT + word timestamps |
| `extract_waveform` | `waveform.rs` | Decode a span to mono PCM via FFmpeg sidecar, return `Vec<f32>` RMS peaks (`num_samples` buckets) for the clip-trim waveform UI; disk-cached as `<key>.bin` |

**FFmpeg sidecar** lives at `src-tauri/binaries/ffmpeg-aarch64-apple-darwin`. Bundled via `tauri.conf.json → bundle.externalBin`. After F-01 it is used only by `whisper.rs` (audio extraction) and `waveform.rs` (PCM decode); the `ffmpeg.rs` module spawns it via `tauri-plugin-shell` (`run_ffmpeg_output`).

**Whisper** — `transcribe_video` invokes `whisper-cli` from system PATH (not a bundled sidecar). Requires the user to install it separately (`brew install whisper-cpp` on macOS). The model path is passed from the frontend. Results (SRT + word JSON) are cached under `<appCacheDir>/whisper-cache/<hash>.{srt,json}` keyed by `(file_size + first_1MB SHA-256)`.

### Project file (`.reelproj`)

Plain JSON written by `save_project` / read by `load_project`. Current schema version: 3. Contains the `state` snapshot: `srtContent`, `sentences`, `reelsData`, `mergeThreshold`, and core metadata. F-01 dropped the dead `renderConfig`/`reelsMetadata` blobs; older v2 files load tolerantly (those keys are simply ignored, never assigned to state).

## Things to know before editing

- Model names live in `src/ai/models.js` (`CLAUDE_MODEL = 'claude-opus-4-7'`, `GEMINI_MODEL = 'gemini-2.0-flash'`). Update there when new models ship.
- `callClaude` calls `api.anthropic.com` directly from the browser (CORS is allowed by Anthropic).
- XML output targets FCP7 xmeml v4 (`<sequence>` per reel, shared `<file>` reference). The structure is fragile — test imports in Premiere/Resolve when changing it.
- Lua output uses `mediaPool:AppendToTimeline()` in a single batch call, meant to be pasted into DaVinci Resolve's Console.
- API keys are stored in `localStorage` as `edl_apikey_<provider>`. OpenRouter model list is cached under `edl_or_models_cache`.
- All user-facing strings are Polish. Keep them Polish.
- The FFmpeg binary at `src-tauri/binaries/` is architecture-suffixed. Adding support for other platforms requires placing the matching binary and updating `tauri.conf.json`.
- `whisper-cli` is NOT bundled — it must be installed on the host system. The frontend passes the model path explicitly.
- `cargo audit` reports ~17 `unmaintained` gtk-rs/GTK3 advisories (`atk`, `gdk`, `gtk`, `webkit2gtk`, …). These are Linux-only transitive Tauri deps; this is a macOS-only app, so they never ship. Safe to ignore — do not chase them.

## Type discipline (frontend is untyped JS — compensate explicitly)

- All new frontend functions must carry JSDoc type annotations at their boundaries,
  e.g. `/** @param {Sentence[]} sentences @returns {string} */`. Define shared shapes
  (`Sentence`, `Reel`) once as `@typedef` blocks in `src/state.js` and
  reference them by name.
- Validate every LLM response against the expected schema BEFORE use. Parse the JSON,
  then check required fields (`clip_ids`, `reel_name`, `virality_score`, `hook/body/punchline`)
  and types; on mismatch, surface the retry / manual-paste-and-fix path (FR-018) — never
  feed an unvalidated object into the export pipeline.
- When you change the LLM schema in `src/ai/prompt.js`, update EVERY consumer in the same
  change: `src/ai/providers.js`, the step-2 reel editor, and every exporter that reads the
  new field. Grep for the field name before considering the change complete.

## Frontend state & module conventions (no framework — these ARE the rules)

- State is the single mutable object in `src/state.js`. After ANY mutation, call `emit()` —
  components are not reactive and will not see the change otherwise.
- Components read `state` directly; they must NOT mutate another component's DOM. UI lives
  under `src/ui/stepN-*.js`, one file per pipeline step.
- Exporters in `src/exporters/` are PURE functions of (`sentences`, `reelsData`) → string.
  No DOM access, no `state` import, no I/O. Keep them pure so regression tests stay simple.
- Timeline math is integer-frame only — see **Key invariants → Frame math** (top of file) for
  the canonical rule (`Math.round(s * fps)`, no mid-pipeline rounding, CMX-3600 offset).

## Tests (bespoke runner — no CI gate exists)

- Run the regression suite with: `node --experimental-vm-modules test/regression.js`.
  It covers SRT parsing + exporter (EDL / XML / Lua) correctness.
- This suite is the only automated guard. Run it before considering any change to
  `src/parser/`, `src/exporters/`, or the frame-math invariants complete.
- When you change parser or exporter behavior, ADD a regression case in the same change —
  follow the existing structure in `test/regression.js`; do not invent a new test framework.
- High-risk now: the render-path removal (FR-038) is a large deletion. Run the suite before
  and after to prove the selection → segment → export pipeline still works (PRD guardrail).
