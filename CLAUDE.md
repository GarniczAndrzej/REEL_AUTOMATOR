# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

**Reels EDL Automator** — a Tauri 2 desktop app (Vite + vanilla JS frontend, Rust backend) that converts SRT subtitle files into edit timelines (EDL / FCP XML / DaVinci Resolve Lua) using an LLM, and optionally renders final MP4 reels directly via a bundled FFmpeg sidecar. All user-facing strings are Polish.

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
```

There is no linter configured.

## Architecture

### Frontend (`src/`)

ES module app served by Vite. Entry point is `src/index.html` → `src/main.js`.

**State** lives in `src/state.js` as a single mutable object exported as `state`. Changes are broadcast via a minimal pub-sub: `emit()` notifies all `subscribe(fn)` listeners. Nothing is reactive beyond this — components read `state` directly and call `emit()` after mutations.

**Three-step pipeline** driven by `goStep(n)` in `main.js`:
1. `src/ui/step1-import.js` — SRT/video file drop/parse, Whisper transcription trigger, project save/load
2. `src/ui/step2-analyze.js` — AI analysis, reel JSON editor
3. `src/ui/step3-export.js` — EDL/XML/Lua export tabs + MP4 render tab

**Exporters** (`src/exporters/`) are pure functions: `generateEDL(opts)`, `generateXML(opts)`, `generateLua(opts)`. They read `sentences` + `reelsData` and return strings.

**Parser** (`src/parser/`):
- `srt.js` — `parseSRT(text, fps, minChars)` merges SRT cues into full sentences (punctuation-terminated), returns `sentences[]` with `{id, text, start_frame, end_frame, duration_frame, start_tc, end_tc}`.
- `segments.js` — `mergeAdjacentClips(clipIds, sentences, thresholdFrames)` collapses adjacent sentence IDs whose gap is ≤ threshold into merged spans. This is the input to the FFmpeg render.

**Render support** (`src/render/`):
- `settings.js` — `defaultRenderConfig()` defines the shape stored at `state.renderConfig`.
- `queue.js` — concurrent render queue (concurrency=2). `enqueueAll(jobs)` drives `invoke('run_render', ...)` calls; `cancelJob(id)` / `cancelAll()` invoke `cancel_render`.
- `subtitles.js` — `buildReelSrt(reel, sentences, fps, mergeThreshold)` re-maps sentence timecodes to the reel's output timeline for subtitle burn-in.
- `fillers.js` — Polish filler word sets (`ALWAYS_FILLERS`, `CONTEXT_FILLERS`) and `expandSpansWithFillerRemoval(mergedSpans, sentences, fps)` which converts word-level spans into micro-spans skipping fillers.

**AI providers** (`src/ai/providers.js`) — `callGemini`, `callClaude`, `callOpenRouter` each return a raw string; the caller strips ` ```json ` fences and `JSON.parse`s. The LLM schema is fixed in `src/ai/prompt.js` — changing it requires updating every consumer. Model names are constants in `src/ai/models.js` (`GEMINI_MODEL`, `CLAUDE_MODEL`).

### Backend (`src-tauri/src/`)

Rust modules registered as Tauri commands in `lib.rs`:

| Command | Module | Purpose |
|---|---|---|
| `run_render` | `rendering.rs` | FFmpeg filter graph + optional intro/outro concat |
| `cancel_render` | `rendering.rs` | Signal cancellation for a running reel render |
| `detect_hw_encoder` | `rendering.rs` | Probe FFmpeg for h264_videotoolbox/nvenc/qsv |
| `extract_thumbnail` | `rendering.rs` | `ffmpeg -ss <t> -frames:v 1` for metadata thumbnails |
| `save_project` | `project.rs` | Write `.reelproj` JSON file |
| `load_project` | `project.rs` | Read `.reelproj` JSON file |
| `transcribe_video` | `whisper.rs` | Extract audio + run `whisper-cli`, return SRT + word timestamps |
| `detect_face_keyframes` | `face_detect.rs` | Sample frames via FFmpeg sidecar, gradient-based edge tracking, return smoothed `{t, x}` keyframes for 9:16 crop |

**FFmpeg sidecar** lives at `src-tauri/binaries/ffmpeg-aarch64-apple-darwin`. Bundled via `tauri.conf.json → bundle.externalBin`. The `ffmpeg.rs` module spawns it via `tauri-plugin-shell`, parses `frame=N` progress lines from stderr, and emits `render-progress` events with `{reel_id, percent}`.

**Cancellation** — `RenderRegistry` (managed state) holds one `Arc<Notify>` per active reel_id. `cancel_render` calls `notify_waiters()`; the ffmpeg runner polls the notifier between progress events.

**Whisper** — `transcribe_video` invokes `whisper-cli` from system PATH (not a bundled sidecar). Requires the user to install it separately (`brew install whisper-cpp` on macOS). The model path is passed from the frontend. Results (SRT + word JSON) are cached under `<appCacheDir>/whisper-cache/<hash>.{srt,json}` keyed by `(file_size + first_1MB SHA-256)`.

**Face detection** — `detect_face_keyframes` dumps frames at 2fps via the FFmpeg sidecar as grayscale raw video, applies a sliding-window gradient-energy heuristic to find the most-edge-dense column (proxy for face location), and smooths with EMA (alpha=0.15). Cached under `<appCacheDir>/face-cache/<hash>.json` keyed by `(size + mtime + first_1MB SHA-256)`.

### Render pipeline (`rendering.rs`)

**Fast path** — `eligible_for_stream_copy` is true when `stream_copy=true` + `aspect=source` + no logo/intro/outro + no subtitles + no loudness normalize. Runs per-span `-ss/-to -c copy` then ffmpeg concat, skipping re-encode entirely.

**Normal path** — `build_args(req, out_path)` builds a single `-filter_complex` string chaining in order:
1. Per-span `trim`/`atrim` + `setpts`/`asetpts` → `[vi][ai]` labels
2. `concat=n=N:v=1:a=1[vc][ac]`
3. If `aspect == "vertical_9_16"`: `crop=ih*9/16:ih:<x>:0,scale=1080:1920[vcrop]` — `<x>` is either a piecewise-linear face-tracking expression (when `face_keyframes` provided) or center `(iw-ih*9/16)/2`
4. If `logo`: `scale=<output_w*pct/100>:-1,format=rgba,colorchannelmixer=aa=<opacity>[lg]` → `overlay[vlogo]`; logo is input `[1:v]`, source is `[0:v]`
5. If `burn_subtitles`: `subtitles='<escaped_path>':force_style='...'[vsub]`; temp `.srt` written to `<tmpdir>/reel_<id>_<aspect>.srt`
6. If `preview`: `scale=-2:480[vprev]`
7. If `loudness_normalize` (skipped for preview): `[ac]loudnorm=I=-14:LRA=11:TP=-1.5[an]`

Video codec selected by `video_codec` field: `h264_videotoolbox`, `h264_nvenc` (adds `-rc vbr -cq 19`), `h264_qsv` (adds `-look_ahead 1`), or `libx264` (default, adds `-preset medium`). Preview always uses `libx264 -preset veryfast -crf 28`.

`run_render` wraps `build_args` with a two-pass strategy when intro/outro are present: body renders to `<out>_body.mp4`, then `concat_with_bookends` tries stream-copy (`-c copy`), falls back to re-encode on failure, then deletes the temp files.

`aspect: "both"` is handled entirely in JS by calling `run_render` twice per reel.

### Project file (`.reelproj`)

Plain JSON written by `save_project` / read by `load_project`. Current schema version: 2. Contains the full `state` snapshot: `srtContent`, `sentences`, `reelsData`, `renderConfig`, and metadata. `renderConfig` uses serde defaults so v1 files (missing Phase 2 fields) load cleanly.

## Key invariants

**Frame math** — all timeline arithmetic uses integer frames. `parseTime()` → seconds → `Math.round(seconds * fps)` → frames. Never round to seconds mid-pipeline. EDL record timecode starts at `3600 * fps` (1-hour offset, CMX 3600 convention).

**`mergeAdjacentClips` is the render span source** — it converts `reel.clip_ids` → merged `{start_frame, end_frame}` spans → `{in_s, out_s}` for the Rust `Span` struct. The merge threshold defaults to 12 frames (~0.5s at 24fps); 0 disables merging.

**Logo input index** — the logo PNG must be the second `-i` input (`[1:v]`). If a logo is present, it is inserted before `-filter_complex` in the args array. Audio and loudnorm always reference `[ac]`/`[an]`, never the video chain.

**`output_w` must be passed from JS** — Rust doesn't probe the source video. For `aspect=source`, `output_w` comes from `state.videoResolution` (parsed as integer width). For `aspect=vertical_9_16`, it is always `1080`.

**Subtitle temp file naming** — includes both `reel_id` and `aspect` (`reel_<id>_<aspect>.srt`) to avoid collisions when `aspect: "both"` triggers two concurrent renders of the same reel.

## Things to know before editing

- Model names live in `src/ai/models.js` (`CLAUDE_MODEL = 'claude-opus-4-5'`, `GEMINI_MODEL = 'gemini-2.0-flash'`). Update there when new models ship.
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
  (`Sentence`, `Reel`, `RenderConfig`) once as `@typedef` blocks in `src/state.js` and
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
- Timeline math is integer-frame only: seconds → `Math.round(s * fps)` → frames. Never round
  to seconds mid-pipeline. EDL record TC keeps the CMX-3600 1-hour offset (`3600 * fps`).

## Tests (bespoke runner — no CI gate exists)

- Run the regression suite with: `node --experimental-vm-modules test/regression.js`.
  It covers SRT parsing + exporter (EDL / XML / Lua) correctness.
- This suite is the only automated guard. Run it before considering any change to
  `src/parser/`, `src/exporters/`, or the frame-math invariants complete.
- When you change parser or exporter behavior, ADD a regression case in the same change —
  follow the existing structure in `test/regression.js`; do not invent a new test framework.
- High-risk now: the render-path removal (FR-038) is a large deletion. Run the suite before
  and after to prove the selection → segment → export pipeline still works (PRD guardrail).
