# Built-in WhisperX Transcription + Word-Level Alignment + Model Manager — Implementation Plan

## Overview

Replace the PATH-dependent `whisper-cli` (whisper.cpp) transcription path with a **bundled, OS-aware WhisperX engine** that produces text + word-level **forced alignment** with no separate install. On top of the new engine, add a **model manager** (download-on-demand with progress), **word-driven gap-free segmentation** persisted at `.reelproj` schema v4, **transcript import + optional align + export**, and an **opt-in diarization** toggle.

This is roadmap slice **S-05** (PRD FR-001…FR-007). It is the heaviest slice on the quality path: word-level forced alignment is what guarantees the PRD primary criterion of **~0% mid-word cuts**. The work is phased **core-first** so the proven selection → segment → export pipeline never regresses.

## Current State Analysis

- **Transcription** (`src-tauri/src/whisper.rs`): `transcribe_video(app, video_path, model_path, language)` extracts 16 kHz mono WAV via the FFmpeg sidecar (`crate::ffmpeg::run_ffmpeg_output`), then spawns **`whisper-cli` from `$PATH`** with `-osrt -oj`, parses progress from stderr, reads the SRT + word-level token JSON, and caches results.
- **Word data**: `parse_whisper_words` flattens whisper.cpp `transcription[].tokens[]` token `offsets` (ms) into `[{text,start,end}]`. These are **coarse token timestamps**, not forced alignment.
- **Cache**: `<appCacheDir>/whisper-cache/<hash>.{srt,json}`, key = `compute_video_hash` = `SHA256(file_len ++ mtime_nanos ++ first_1MB)`. No engine/format version in the key.
- **Command registration**: `src-tauri/src/lib.rs` registers `whisper::transcribe_video` and `waveform::extract_waveform`.
- **Bundling**: `tauri.conf.json → bundle.externalBin: ["binaries/ffmpeg"]`; the FFmpeg binary is architecture-suffixed (`ffmpeg-aarch64-apple-darwin`). This is the only bundled runtime today.
- **Frontend** (`src/ui/step1-import.js`): a manual model-**path** picker (`browseWhisperModel` → file dialog for `.bin`), a video picker, language `<select>`, and `transcribeWithWhisper()` which `invoke`s `transcribe_video`, listens to `transcribe-progress`, loads the SRT via `loadSRTContent`, and stashes `result.words` in `state._pendingWhisperWords` for merging after `parseSRT`.
- **Segmentation**: `doParseBtn()` → `parseSRT`/`parseVTT` builds `sentences[]`; `mergeWordsIntoSentences()` attaches words to each sentence by time-overlap. Word data is **transient** (never persisted).
- **Project file**: `src/ui/step1-import.js writeProject()` writes schema **v3**; `applyProjectData()` loads tolerantly. `sentences` are persisted but **without** `words`.
- **Credentials helper**: `src/ai/api-key.js` exposes `getApiKey(provider)` / `setApiKey(provider, key)` (R2 refactor) — the single seam for stored secrets (used here for the diarization HF token).
- **Deps**: `Cargo.toml` has `tauri-plugin-shell`, `serde_json`, `sha2`, `tokio` — **no HTTP/download crate yet** (model download needs one).
- **No `@typedef`** for `Sentence`/`Word` exists in `src/state.js` yet (CLAUDE.md mandates them for new shapes).

## Desired End State

A user drops a local video, the app transcribes it **fully locally with bundled WhisperX** (no install), producing word-aligned segments that feed AI selection directly. They can browse a **model list** (downloaded vs missing vs ready), download a missing model with live %/speed/ETA, **import** an existing `.srt`/`.vtt` (optionally force-aligning it to the audio), **export** the transcript, and optionally enable **diarization**. Existing v3 projects keep loading; existing whisper.cpp cache entries remain valid (no forced re-transcribe).

Verify by: transcribing a real Polish clip end-to-end with the bundled engine on a machine **with no `whisper-cli` and no Python on PATH**; confirming word-level boundaries land between words; exporting a clean EDL; reloading a v4 project and seeing `words[]` survive.

### Key Discoveries:

- The engine swap touches **five interacting surfaces**: Rust backend (`whisper.rs`), packaging (`tauri.conf.json` + a new sidecar build), cache format, frontend UI (`step1-import.js`), and segmentation (`parser/` + `state.js`).
- WhisperX needs **two** model kinds: a faster-whisper CT2 **transcription** model (download-on-demand) and a per-language wav2vec2 **alignment** model (**bundled at packaging time** — see Phase 1 / user decision).
- The user chose to **segment directly from word timestamps** for engine output, but imported `.srt`/`.vtt` still flow through the existing `parseSRT`/`parseVTT`. Both paths must converge on the same `sentences[]` + `words[]` shape consumed by exporters.
- Word data becomes **primary, durable state** (not transient) once segmentation is word-driven → `.reelproj` must bump to **v4** and persist `words[]`.
- The bespoke node regression runner (`test/regression.js`) cannot run a ~1 GB Python sidecar; the new word-driven segmentation must be guarded by **JSON fixtures**, with the engine itself verified manually.

## What We're NOT Doing

- **Auto (one-click) mode** (FR-008/FR-009) — that is S-07; this slice only exposes per-run progress + a single cancel, not the staged auto pipeline.
- **Word-level boundary trim / snap-to-pause UI** (FR-021) — that is S-06; this slice only **persists** the `words[]` that S-06 will consume.
- **Per-reel metadata / `.md` export** (FR-019/FR-032) — deferred.
- **Removing the FFmpeg sidecar** — kept; still used for audio extraction and waveform.
- **Replacing the LLM selection schema** — that is S-01; untouched here.
- **A remote/hosted model catalog** — the registry is curated/in-app (user decision).

## Implementation Approach

Phase **1 first** to retire the single largest unknown (packaging a Python engine as a bundled sidecar across OSes) before any frontend/cache work depends on it. Phases 2–3 are the **must-have core** (engine drive + word-driven segmentation + persistence). Phase 4 delivers the must-have **model manager**. Phase 5 covers import/align (must-have import, nice-to-have export). Phase 6 adds the **opt-in** diarization toggle last, so its external blocker (HF token + pyannote access) never sits on the core critical path.

The new engine is invoked as a frozen CLI sidecar (like FFmpeg) that emits a **single normalized JSON** (`{ segments:[{start,end,text,words:[{text,start,end,score?,speaker?}]}], language }`) on stdout and progress on stderr. The Rust layer parses that one contract; the SRT is derived, not the source of truth.

## Critical Implementation Details

- **Two segmentation entry points must converge.** Engine output is segmented directly from word timestamps (new logic); imported `.srt`/`.vtt` keep using `parseSRT`/`parseVTT`. Both must emit the same `sentences[]` shape (with `start_frame`/`end_frame`/`start_tc`/… per the frame-math invariant) and attach `words[]` the same way, or exporters and the v4 schema will diverge.
- **Cache key must carry an engine/format version.** Old whisper.cpp `<hash>.{srt,json}` entries must stay readable for projects that already have them; the new engine writes entries under a versioned namespace so the two coexist. The word schema read back from either must be **normalized** to one shape before it reaches `mergeWordsIntoSentences`/segmentation.
- **Sidecar process lifecycle.** A transcription run is multi-minute; cancel must kill the child process **and** clean up the temp WAV + any partial output, reusing the existing `WHISPER_CALL` seq / temp-path pattern in `whisper.rs`.
- **Frame-math invariant is untouchable.** All new segmentation still goes seconds → `Math.round(seconds * fps)` → frames; no mid-pipeline rounding; EDL record TC keeps the `3600 * fps` offset. Run `test/regression.js` before and after Phase 3.

---

## Phase 1: WhisperX Sidecar Packaging

### Overview

Produce an OS-aware, frozen WhisperX CLI bundled as a Tauri `externalBin` sidecar — the "no separate install" foundation. The build bundles the per-language wav2vec2 **alignment model** so the core align path works offline immediately; large transcription models are downloaded later (Phase 4).

### Changes Required:

#### 1. WhisperX sidecar CLI

**File**: `sidecar/whisperx_engine/` (new — Python entry script + PyInstaller spec)

**Intent**: A thin Python CLI wrapping `whisperx` (load audio → transcribe with faster-whisper → forced-align → optional diarize) that takes `--audio --model --language [--diarize --hf-token]` and prints one normalized JSON to stdout plus parseable progress lines to stderr. Frozen with PyInstaller into a single standalone executable per target.

**Contract**: stdout JSON = `{ "language": str, "segments": [ { "start": float, "end": float, "text": str, "words": [ { "text": str, "start": float, "end": float, "score": float?, "speaker": str? } ] } ] }`. stderr progress lines = a stable, greppable prefix (e.g. `PROGRESS phase=<transcribe|align|diarize> percent=<0-100>`). Exit non-zero with a machine-distinguishable code/message for: model-not-found, audio-decode-fail, align-fail.

#### 2. OS-aware PyInstaller build script

**File**: `sidecar/build.sh` + `sidecar/whisperx_engine.spec` (new)

**Intent**: Detect the host OS/arch and build the matching sidecar, pulling the correct platform dependencies (CTranslate2 build, torch CPU vs GPU/Metal). On macOS produce **CPU and GPU (Metal)** variants; produce a **Windows** build as well. Ship the per-language wav2vec2 alignment model **beside** the frozen binary as a Tauri bundled resource (NOT baked into the onefile — see `lessons.md`: a multi-GB onefile fails to load under macOS dyld, fixed in a31fdbf); the engine receives its path at runtime via `--align-model-dir`. Emit binaries with the Tauri arch-suffix naming used for FFmpeg.

**Contract**: Outputs `src-tauri/binaries/whisperx-engine-<target-triple>[-gpu]` for `aarch64-apple-darwin` (CPU + Metal) and the Windows `x86_64-pc-windows-msvc` triple, plus the alignment model dir shipped as a separate bundled resource. A short README documents prerequisites + how to regenerate. (No snippet — this is a build-script task; the implementer owns PyInstaller specifics.)

#### 3. Register the sidecar with Tauri

**File**: `tauri.conf.json`

**Intent**: Add the WhisperX engine binaries to `bundle.externalBin` alongside FFmpeg so they ship inside the app and resolve via the shell plugin.

**Contract**: `bundle.externalBin` gains the `binaries/whisperx-engine` base name; Tauri resolves the arch-suffixed file per platform. Confirm `tauri-plugin-shell` scope permits spawning it.

#### 4. Engine self-check command

**File**: `src-tauri/src/whisper.rs` (or a new `src-tauri/src/engine.rs`) + `src-tauri/src/lib.rs`

**Intent**: A `whisperx_engine_check()` Tauri command that spawns the sidecar with a `--version`/`--selftest` flag and returns `{ ok, version, gpu, alignment_model_ready }` so the frontend (Phase 4) can show readiness without a full transcription.

**Contract**: New command registered in `generate_handler!`; returns a small serde struct. Selftest must not require a downloaded transcription model.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Sidecar build script runs and emits the expected arch-suffixed binaries: `ls src-tauri/binaries/whisperx-engine-*`
- `whisperx_engine_check` returns `ok: true` on a machine with **no `whisper-cli` and no system Python on PATH**

#### Manual Verification:

- Frozen sidecar runs standalone (double-click / direct exec) and prints valid JSON on a sample WAV
- macOS GPU (Metal) variant is selected and is faster than the CPU variant on a capable machine
- Windows build runs on a clean Windows box with no Python installed
- Alignment model shipped beside the binary (via `--align-model-dir`) performs forced alignment offline (no network)

**Implementation Note**: Pause for human manual confirmation (especially Windows + GPU variant) before proceeding to Phase 2.

---

## Phase 2: Backend Engine Swap + Cache Versioning

### Overview

Rewrite `transcribe_video` to drive the sidecar instead of PATH `whisper-cli`, parse the normalized JSON, emit progress, support cancellation, and version the cache so old entries stay valid.

### Changes Required:

#### 1. Drive the sidecar

**File**: `src-tauri/src/whisper.rs`

**Intent**: Replace the `whisper-cli` spawn with a shell-plugin spawn of the bundled `whisperx-engine` sidecar (GPU variant when available, else CPU). Keep the FFmpeg audio-extraction step. Parse the new stderr `PROGRESS phase=… percent=…` lines into the existing `transcribe-progress` event (mapping align/diarize phases into the bar). Parse the stdout JSON into the normalized word/segment structure.

**Contract**: `transcribe_video` signature gains what the engine needs (e.g. `model_id` instead of a raw `model_path`, kept back-compatible for the frontend transition). Returns `{ srt_content, words, segments }` where `segments` is the new word-driven structure (Phase 3 consumes it). Progress event payload shape (`phase`/`label`/`percent`) is unchanged so existing listeners keep working.

#### 2. Cancellable run

**File**: `src-tauri/src/whisper.rs` + `src-tauri/src/lib.rs`

**Intent**: Track the spawned child so a new `cancel_transcription()` command can kill it; on cancel/error, remove the temp WAV and any partial engine output. Reuse the `WHISPER_CALL`/pid+seq temp-naming pattern.

**Contract**: New `cancel_transcription` command registered in `generate_handler!`; killing mid-run leaves no orphan process and no temp files. Returns a clean cancelled-state error string (Polish) the frontend can distinguish from a real failure.

#### 3. Versioned, coexisting cache

**File**: `src-tauri/src/whisper.rs`

**Intent**: Add an engine/format version to the cache namespace so WhisperX entries don't collide with whisper.cpp entries, and old `<hash>.{srt,json}` files still resolve for projects that already have them. Normalize the word shape read from either format before returning.

**Contract**: Cache path becomes version-scoped (e.g. `whisper-cache/v2/<hash>.json` for the new engine while legacy `whisper-cache/<hash>.{srt,json}` is still read). Document the key derivation; `compute_video_hash` is unchanged.

#### 4. Distinct Polish error messages

**File**: `src-tauri/src/whisper.rs`

**Intent**: Map the sidecar's distinguishable exit conditions to specific Polish user messages: missing/not-yet-downloaded transcription model, corrupt model, audio-decode failure, alignment failure, engine-missing. All strings Polish.

**Contract**: Each failure returns a distinct `Err(String)`; no generic catch-all for the cases the engine can distinguish.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Rust build passes: `~/.cargo/bin/cargo build --manifest-path src-tauri/Cargo.toml`
- A legacy `whisper-cache/<hash>.srt` fixture still loads (cache-hit path returns it without invoking the engine)

#### Manual Verification:

- Transcribing a real clip drives the bundled engine and shows transcribe → align progress
- Cancel mid-run stops the engine, leaves no temp WAV / orphan process, and shows the cancelled (not failed) state
- Each error path shows its specific Polish message
- An existing project with a legacy cache entry does **not** re-transcribe

**Implementation Note**: Pause for human manual confirmation before Phase 3.

---

## Phase 3: Word-Driven Segmentation + Persistence (v4)

### Overview

Build numbered, gap-free segments directly from word timestamps; persist `words[]` on sentences; bump `.reelproj` to v4 (v3 tolerant); add regression fixtures. Imported `.srt`/`.vtt` keep using `parseSRT`/`parseVTT`.

### Changes Required:

#### 1. Word-driven segmenter

**File**: `src/parser/segments.js` (extend) or new `src/parser/word-segments.js`

**Intent**: Convert the engine's `segments[]` + `words[]` into the app's `sentences[]` (numbered, gap-free, punctuation-terminated where possible, honoring `minChars`), with each sentence carrying its `words[]`. Output the same shape `parseSRT` produces so exporters and the reel editor are unchanged.

**Contract**: Pure function `segmentFromWords(engineSegments, fps, minChars) → Sentence[]`, each `{id, text, start_frame, end_frame, duration_frame, start_tc, end_tc, words:[{text,start_frame,end_frame}]}`. Frame math via `Math.round(seconds * fps)`; no gaps between consecutive sentence spans. Keep it pure (no DOM/state/I/O) so regression tests stay simple.

#### 2. Wire the new path in import flow

**File**: `src/ui/step1-import.js`

**Intent**: When transcription returns `segments`, build `sentences` via the word-driven segmenter instead of writing an intermediate SRT and re-parsing. Keep `parseSRT`/`parseVTT` for imported transcripts (Phase 5). Persist `words[]` onto sentences in `state`.

**Contract**: `transcribeWithWhisper()` routes engine `segments` → `segmentFromWords` → `state.sentences`; `_pendingWhisperWords`/`mergeWordsIntoSentences` is retired for the engine path (still used for the imported-align path in Phase 5). `emit()` after mutation.

#### 3. Persist words + bump schema to v4

**File**: `src/ui/step1-import.js` (`writeProject`/`applyProjectData`) + `src-tauri/src/project.rs`

**Intent**: Write `version: 4` and include `sentences[].words`. Load v4 fully; load v3 tolerantly (no `words` → word-trim simply unavailable until re-aligned).

**Contract**: `.reelproj` schema v4 = v3 + per-sentence `words[]`. `applyProjectData` reads `words` when present, ignores absence. `project.rs` round-trips the larger payload unchanged (it is schema-agnostic JSON I/O — confirm no field whitelist drops `words`).

#### 4. Define shared `Word` typedef

**File**: `src/state.js`

**Intent**: Add `@typedef` blocks for `Word` and (if absent) `Sentence` so the new fields are documented per CLAUDE.md type discipline.

**Contract**: `/** @typedef {{text:string,start_frame:number,end_frame:number}} Word */` and a `Sentence` typedef referencing `Word[]`; reference by name from new functions.

#### 5. Regression fixtures

**File**: `test/regression.js` (+ a fixture JSON)

**Intent**: Add cases feeding a recorded WhisperX-shaped `segments`/`words` fixture through `segmentFromWords`, asserting gap-free coverage, correct frame math, and that the EDL/XML/Lua exporters still produce correct output from the result.

**Contract**: New cases follow the existing `test/regression.js` structure; no new test framework. Assert no inter-segment gaps and stable exporter output.

### Success Criteria:

#### Automated Verification:

- Regression suite passes (incl. new word-segmentation cases): `node --experimental-vm-modules test/regression.js`
- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- A v3 `.reelproj` fixture loads without error (no `words`); a v4 fixture round-trips `words[]`

#### Manual Verification:

- Transcribed segments are gap-free, numbered, and read as sentences
- Word boundaries land between words (spot-check several cuts → no mid-word)
- Save → reload a v4 project preserves `words[]`
- Exported EDL imports cleanly into the NLE (no regression vs the SRT path)

**Implementation Note**: Run `test/regression.js` before and after this phase; pause for human confirmation before Phase 4.

---

## Phase 4: Model Manager UI + Download-on-Demand

### Overview

Replace the manual model-**path** picker with a model manager: a curated registry of faster-whisper transcription models, download-on-demand with %/speed/ETA into the app data dir, SHA-256 verification, and a readiness status list (downloaded / missing / ready) that also reflects the bundled alignment model.

### Changes Required:

#### 1. Curated model registry

**File**: `src/ai/models.js` (extend) or new `src/transcription/model-registry.js`

**Intent**: A small hardcoded list of supported faster-whisper CT2 models (e.g. small / medium / large-v3) with display name, size, download URL, and expected SHA-256. The per-language alignment model is shown as a bundled/ready entry (not downloaded by the user).

**Contract**: `MODEL_REGISTRY: { id, label, sizeBytes, url, sha256 }[]`; a separate descriptor for the bundled alignment model surfaced as status-only.

#### 2. Download command with progress

**File**: `src-tauri/src/whisper.rs` (or new `src-tauri/src/models.rs`) + `src-tauri/src/lib.rs` + `Cargo.toml`

**Intent**: A `download_model(model_id, ...)` command that streams the file into the app data dir, emitting a progress event (bytes, %, speed, ETA), then verifies SHA-256 before marking it ready. Add a streaming HTTP capability (a download crate or `tauri-plugin-upload`) since none exists today.

**Contract**: New command + a `model-download-progress` event (`{percent, bytesPerSec, etaSec}`). On checksum mismatch, delete the partial file and return a distinct Polish error. New dependency added to `Cargo.toml`. A companion `list_models()`/status command reports each model's `downloaded|missing` plus engine readiness (reuses Phase 1 self-check).

#### 3. Model manager UI

**File**: `src/ui/step1-import.js` (+ markup in `src/index.html`)

**Intent**: Replace `browseWhisperModel` (raw `.bin` path picker) with a list showing each model's status, a download button wired to `download_model` + progress bar/ETA, and an overall "ready to run" indicator. Selecting a downloaded model sets the active model used by `transcribe_video`. Default destination is the app data dir (no per-file path picker).

**Contract**: New UI section replacing the model-path input; `state` tracks the selected `model_id` (migrating off raw `whisperModelPath`); all strings Polish. `emit()` after mutations.

### Success Criteria:

#### Automated Verification:

- Rust type-check + build pass: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- SHA-256 mismatch path deletes the partial download and returns an error (unit-level check in Rust or a manual corrupt-URL test)
- Frontend formats with Prettier cleanly: `npx prettier --check "src/**/*.{js,css,html}"`

#### Manual Verification:

- Model list shows downloaded vs missing vs ready correctly on first run
- Downloading a missing model shows live %/speed/ETA and verifies before becoming usable
- A corrupt/interrupted download is rejected with a clear Polish message
- Transcription uses the selected downloaded model end-to-end

**Implementation Note**: Pause for human confirmation before Phase 5.

---

## Phase 5: Transcript Import + Optional Align + Export

### Overview

Unify `.srt`/`.vtt` import, offer a one-click "align to audio" pass when a video is present (force-align an imported transcript to get word timestamps), and export the transcript (`.srt` incl. word-level, `.vtt`).

### Changes Required:

#### 1. Optional align-only engine mode

**File**: `sidecar/whisperx_engine/` + `src-tauri/src/whisper.rs` + `src-tauri/src/lib.rs`

**Intent**: Add an align-only entry to the sidecar (transcript + audio → word timestamps, skipping transcription) and an `align_transcript(video_path, transcript)` command. The frontend offers this when an imported transcript and a video are both loaded.

**Contract**: New `align_transcript` command returning the same normalized `segments`/`words` shape as `transcribe_video`. Sidecar gains an `--align-only --transcript <file>` mode.

#### 2. Import flow wiring

**File**: `src/ui/step1-import.js`

**Intent**: Keep the existing `.srt`/`.vtt` import (text-only `sentences` via `parseSRT`/`parseVTT`); when a video is also present, surface an "align to audio" button that runs `align_transcript` and merges the resulting `words[]` onto the imported sentences (via the existing `mergeWordsIntoSentences`).

**Contract**: Imported transcripts load immediately without words; the align button is shown only when `state.videoPath`/`_whisperVideoPath` is set; after align, sentences carry `words[]` and persist at v4. All strings Polish.

#### 3. Transcript export

**File**: `src/ui/step1-import.js` (+ a small exporter helper) and/or `src/exporters/`

**Intent**: Export the current transcript as `.srt` (including word-level data where available) and `.vtt`, using a save dialog.

**Contract**: Two export actions producing valid `.srt`/`.vtt` from `state.sentences` (+ `words`). If placed under `src/exporters/`, keep it a pure function of `sentences` → string per the exporter rule.

> **Addendum (impl-review 2026-06-13)**: Word-level SRT export is implemented but
> **opt-in and currently dormant** — `generateTranscriptSRT` embeds per-word timing
> as a non-standard `NOTE WORDS:` line only behind `{ includeWords: true }`; the UI
> export path calls it without the flag, so the exported `.srt` is clean caption
> text (the right default for NLE re-import). Word data is not lost — it persists in
> the `.reelproj` v4 `words[]`. Promote to an explicit "z czasami słów" export
> option later if needed.

### Success Criteria:

#### Automated Verification:

- If a transcript exporter is added under `src/exporters/`, add a regression case: `node --experimental-vm-modules test/regression.js`
- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`

#### Manual Verification:

- Importing a `.srt`/`.vtt` (no video) loads text-only segments and feeds selection
- With a video present, "align to audio" attaches word timestamps to imported segments
- Exported `.srt`/`.vtt` re-imports cleanly and matches the on-screen transcript

**Implementation Note**: Pause for human confirmation before Phase 6.

---

## Phase 6: Opt-In Diarization Toggle

### Overview

Add an off-by-default diarization toggle. Enabling prompts for a Hugging Face token (stored via the credentials helper) and fetches the pyannote model on first use; speaker labels flow into the segment schema. The core path is never blocked by diarization setup.

### Changes Required:

#### 1. Diarization in the engine pass

**File**: `sidecar/whisperx_engine/` + `src-tauri/src/whisper.rs`

**Intent**: When the toggle is on, pass `--diarize --hf-token <token>` to the sidecar so diarization runs in the same pass; attach `speaker` to each word/segment in the normalized JSON.

**Contract**: `transcribe_video` gains a `diarize: bool` (+ token) input; engine emits `speaker` per word/segment; the `diarize` progress phase maps into the existing progress bar.

#### 2. Toggle + HF token UX

**File**: `src/ui/step1-import.js` (+ markup) + `src/ai/api-key.js`

**Intent**: A diarization checkbox (default off); enabling reveals an HF-token input stored via `setApiKey('huggingface', …)` / read via `getApiKey('huggingface')`. First diarized run downloads the pyannote model (progress reuses the model-download surface). Clear Polish messaging if the token is missing/unauthorized.

**Contract**: Token persisted through the existing helper (not a new store); toggle state in `state`; `emit()` after mutation. Missing/invalid token → distinct Polish error, core transcription still available with the toggle off.

#### 3. Persist speaker labels

**File**: `src/parser/word-segments.js` + `src/state.js` + `.reelproj` writer

**Intent**: Carry an optional `speaker` on `Word`/`Sentence` and persist it (still schema v4; the field is additive/optional).

**Contract**: `Word` typedef gains optional `speaker?: string`; segmentation and project round-trip preserve it when present.

### Success Criteria:

#### Automated Verification:

- Regression suite passes with optional `speaker` present and absent: `node --experimental-vm-modules test/regression.js`
- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`

#### Manual Verification:

- With the toggle **off**, transcription runs with zero HF/diarization involvement
- Enabling + a valid HF token produces speaker-labeled segments
- A missing/invalid token shows a clear Polish error and does not block core transcription
- Speaker labels survive save → reload

**Implementation Note**: Final phase of the FR-001…FR-007 core — confirm that surface manually. Phase 7 below is a post-core enhancement added after GUI verification.

---

## Phase 7: Model Manager Enhancements (post-core, added 2026-06-13)

### Overview

Three follow-on improvements requested after the 4.4–4.6 GUI verification: (1) add a
**large-v3-turbo** model to the registry, (2) replace the vertical card **list**
with a compact **dropdown** picker, and (3) a **WhisperX advanced-settings modal**
exposing the engine's tuning flags (force CPU, compute precision, decoding/VAD/align
knobs, …). Enhancement scope — outside the original FR-001…FR-007 core. Changes 1–2
reuse the Phase-4 download/verify/status backend (`models.rs`,
`download_model`/`list_models`) **unchanged**; change 3 is the heavy one — it bumps
the **engine CLI contract** and therefore needs a **sidecar rebuild** (CPU + GPU +
Windows) and re-verification.

### Changes Required:

#### 1. Add large-v3-turbo to the registry

**File**: `src/transcription/model-registry.js`

**Intent**: Add a `large-v3-turbo` entry — the distilled large-v3 variant (4-layer
decoder, near-large-v3 quality at roughly 2× speed, ~1.6 GB). Candidate CT2 repo
`deepdml/faster-whisper-large-v3-turbo-ct2` (verified reachable 2026-06-13; file
set `config.json`, `model.bin`, `preprocessor_config.json`, `tokenizer.json`,
`vocabulary.json` — same layout as large-v3).

**Contract**: New `TranscriptionModel` with `repo`, real per-file `sizeBytes` (from
the HF tree API) and the `model.bin` LFS `sha256` (small JSON/txt files carry `''`),
following the exact pattern of the existing entries. Implementer resolves/confirms
the repo + pulls the manifest the same way the Systran entries were built. No
backend change.

#### 2. Dropdown model picker

**File**: `src/ui/step1-import.js` (`renderModelManager` + helpers) + `src/index.html` (`#modelManagerList` markup)

**Intent**: Replace the vertical card list with a single `<select>` dropdown listing
every registry model, each option annotated with size + status (e.g. `Small
(~480 MB) — Pobrany` / `— Brak`). Selecting a **downloaded** model sets
`state.modelId`; selecting a **not-downloaded** model surfaces a download
affordance (a `⬇ Pobierz` button beside the dropdown) that drives the existing
`download_model` flow. The live `%/MB·s/ETA` readout and the engine-readiness badge
stay; the in-progress state disables the dropdown.

**Contract**: All strings Polish; `emit()` after mutation. Reuse `download_model` +
the `model-download-progress` event (don't re-implement). Preserve the await-render
fix — the progress node must persist across re-render. Keep `transcribe` gated on a
downloaded+selected model.

#### 3. WhisperX advanced-settings modal

**Files**: `src/ui/step1-import.js` (+ a modal in `src/index.html`) → `src-tauri/src/whisper.rs` → `sidecar/whisperx_engine/whisperx_engine.py` + `whisperx_engine.spec`/`build.sh` + `sidecar/README.md`

**Intent**: A separate pop-up window ("Ustawienia zaawansowane WhisperX") opened from
the transcription card, surfacing a **minimal high-value subset** of WhisperX/
faster-whisper tuning knobs so the modal stays optional. Settings flow frontend →
`invoke` params → `whisper.rs` engine args → new engine CLI flags →
`whisperx.load_model` (`asr_options`/`vad_options`) / `transcribe` / `align` /
diarize. The long tail of knobs is **not** surfaced in the UI — instead the engine
pins them to **quality-optimized fixed defaults** (better than bare whisperx
defaults; see "Hidden quality defaults" below). Exposed groups (real whisperx
options — confirmed via docs 2026-06-13):

- **Compute / performance**: force **CPU** (device override — note CTranslate2
  transcription is CPU-only on Apple Silicon today; device mainly affects the torch
  align stage + CUDA boxes), **compute precision** `compute_type`
  (`float16`/`int8`/`int8_float16`/`float32`).
- **Decoding / quality**: `beam_size`, `initial_prompt`.
- **VAD**: `vad_onset`, `vad_offset`.
- **Diarization** (extends the Phase-6 toggle): `min_speakers`, `max_speakers`
  (HF token already handled).

**Hidden quality defaults** (set fixed in the engine, NOT exposed in the modal):
the remaining knobs (`best_of`, `patience`, temperature fallback `temperatures`,
`condition_on_previous_text`, `suppress_numerals`, `suppress_tokens`,
`no_speech_threshold`, `compression_ratio_threshold`, `log_prob_threshold`,
`max_new_tokens`, `hotwords`, `chunk_size`, `threads`, `batch_size`,
`interpolate_method`, `return_char_alignments`, `no_align`) are hardcoded in the
engine at **values tuned for best transcription quality** — e.g. enable temperature
fallback, keep `condition_on_previous_text`, conservative `no_speech`/`log_prob`
thresholds, always align. These are documented in `sidecar/README.md` and can be
promoted to the modal later without a contract break (adding a flag is additive).

**Contract**: New optional settings object on the `transcribe_video` invoke (and
mirrored on `align_transcript` where relevant); each **exposed** knob maps to a new
engine CLI flag (`--device`, `--compute-type`, `--beam-size`, `--initial-prompt`,
`--vad-onset`, `--vad-offset`, `--min-speakers`, `--max-speakers`). The engine
applies them via `asr_options`/`vad_options`; **omitted flags fall back to the
engine's quality-tuned defaults** (no behavior change when the modal is untouched).
This **bumps the engine contract** → update `sidecar/README.md`, **rebuild the
sidecar** (CPU + GPU + Windows) and re-run `--selftest`. Persist the chosen
settings: **perf/device knobs (`device`, `compute_type`) in localStorage
(per-machine), NOT in `.reelproj`**; live values in `state`; all strings Polish;
`emit()` after mutation. (See F3 — persistence-location decision.)

**Verify the option set before wiring.** Before building the engine flags, confirm
each exposed knob (and each hidden quality default) is actually accepted by the
**pinned** whisperx/faster-whisper version — check the installed source or Context7,
not assumptions. The engine must **log/reject unknown `asr_options`/`vad_options`
keys** rather than silently swallow them, so a knob that doesn't map can't ship as a
dead control that looks wired but changes nothing.

### Success Criteria:

#### Automated Verification:

- Frontend formats with Prettier cleanly: `npx prettier --check "src/**/*.{js,css,html}"`
- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Rebuilt sidecar `--selftest` still returns `ok: true` (new flags don't break the engine)

#### Manual Verification:

- Dropdown lists all models incl. large-v3-turbo with correct per-option status
- Selecting a downloaded model sets it active; selecting a missing one offers download
- Downloading large-v3-turbo shows live progress, verifies sha256, becomes selectable
- Transcription runs end-to-end with large-v3-turbo selected
- Advanced-settings modal opens, persists values, and an untouched modal reproduces
  current default behavior (no regression)
- Forcing CPU + a non-default `compute_type` measurably changes a real run, and the
  flags reach the engine (verify via the engine command line / stderr)

---

## Post-core fixes (found during GUI verification, 2026-06-13)

Bugs surfaced while exercising the real transcription path in `tauri dev`;
fixed outside the original FR-001…FR-007 scope but on the same change.

- **FFmpeg sidecar couldn't launch (audio extraction failed).** The bundled
  `src-tauri/binaries/ffmpeg-aarch64-apple-darwin` was a 412 KB *dynamic* copy of
  a Homebrew `ffmpeg 7.1.1_3` build; that Cellar is gone (host now has 8.1.1,
  `libav*.62`), so the sidecar aborted in dyld before extracting audio and every
  transcription failed with "Nie udało się wyekstrahować audio z wideo".
  **Fix:** replaced it with a **self-contained static ffmpeg 8.1 arm64**
  (osxexperts.net), 52 MB, ad-hoc signed, zero external dylib deps. A bundled
  sidecar must always be statically linked.
- **Cache ignored the model/settings.** `transcribe_video`'s cache key was the
  video hash only, so re-transcribing the same clip with a *different model*
  returned the previous model's SRT. **Fix:** `variant_key` folds the full run
  signature (model, language, diarize, beam/VAD/compute/device/speakers) into the
  v2 cache key; the plain video hash is kept for the legacy whisper.cpp fallback.
  Derived transcript name now carries the model id (`_small` vs `_large-v3-turbo`)
  so runs don't collide.
- **Cancel left the run unrestartable.** SIGKILL of the PyInstaller-onefile
  bootloader orphaned its Python worker, which held the stdout pipe open so the
  driver's `rx.recv().await` never returned and the UI stuck on "Anulowano".
  **Fix:** driver loop polls the cancel flag every 250 ms (`tokio::time::timeout`)
  and breaks promptly; `cancel_transcription` now sends SIGTERM (forwarded to the
  worker) then SIGKILL fallback after 300 ms (new unix-only `libc` dep); the
  frontend resets the UI immediately on cancel.
- **Saves now always prompt for a location.** Per user direction, every export
  routes through `src/util/save-file.js` `saveTextToPath` (dialog `save()` + new
  `save_text_file` Rust command) — nothing auto-downloads to ~/Downloads. Covers
  EDL/XML/Lua (step3), the AI prompt (step2), and the transcript
  `.srt`/`.vtt`/`.md`/`segments.json` (step1).
- **Transcript export moved to the WhisperX card** (revealed once a transcript
  exists) and a Polish note clarifies that "🎯 Dopasuj do audio" is only for
  imported external `.srt`/`.vtt` (WhisperX transcription auto-aligns).

---

## Testing Strategy

### Unit / Regression Tests (`test/regression.js`):

- `segmentFromWords` on a recorded WhisperX JSON fixture → gap-free, correct frame math, numbered sentences.
- Exporters (EDL/XML/Lua) produce correct output from word-driven segments (no regression vs the SRT path).
- v3 (no `words`) and v4 (`words[]`, optional `speaker`) project fixtures round-trip.

### Integration / Manual:

1. On a machine with **no `whisper-cli` and no Python on PATH**, transcribe a real Polish clip end-to-end; confirm word-level boundaries and a clean EDL import.
2. macOS GPU vs CPU variant selection; Windows clean-box run.
3. Cancel mid-run; verify no orphan process / temp files.
4. Download a model (progress + checksum); reject a corrupted download.
5. Import `.srt`/`.vtt`, then align-to-audio with a video present.
6. Enable diarization with a valid HF token; verify speaker labels and that the off path is untouched.
7. Legacy whisper.cpp cache entry does not force a re-transcribe.

## Performance Considerations

- Transcription is multi-minute and local — GPU/Metal variant on macOS materially helps; the cancel path is the user's escape hatch.
- The versioned cache prevents re-transcription on reload and on engine swap for already-processed media.
- Bundling the alignment model (vs downloading at runtime) keeps the core align path instant and offline at the cost of a larger installer.

### Engine readiness cost (found during 4.4–4.6 GUI verification, 2026-06-13)

The readiness badge runs the engine `--selftest`, which spawns the cold frozen
sidecar fresh each time (onefile self-extraction + torch/whisperx import + load
the bundled 2.4 GB wav2vec2 align model + run one real forced-align). Measured on
Apple Silicon: **127 s wall** but only ~11 s CPU — the rest was *blocking network*
(huggingface_hub etag/HEAD checks against huggingface.co for the bundled align
model on every spawn). The model-manager UI also waited on this probe before
rendering.

**Applied fixes:**

- **Force HF offline on local-only engine spawns.** `engine.rs::with_hf_offline`
  sets `HF_HUB_OFFLINE=1`/`TRANSFORMERS_OFFLINE=1`; applied to the self-test,
  align-only, and non-diarize transcription spawns (all use bundled/local models).
  **NOT** applied when diarizing — pyannote may still need fetching. Cut the cold
  self-test from **127 s → 74 s** (the residual is genuine extraction + model load
  + the real align run).
- **Decouple the model UI from the probe.** `initModelManager` now renders the
  model list first and fires `refreshEngineReadiness()` without awaiting, so the
  badge ("Sprawdzanie silnika…") fills in asynchronously instead of blocking the
  list.

**Optional follow-ups (not done — candidates if the ~74 s badge still bothers):**

- **Cache the self-test result** (persist `alignment_model_ready` + version/mtime
  key) so it runs once, not on every launch / Krok-1 entry.
- **Lighter readiness probe** — re-introduce a files-present + import-only check
  (no full forced-align), trading the e907bba "truthful align" guarantee for speed,
  or run the full align only on first launch and the light check thereafter.
- **PyInstaller onedir instead of onefile** — eliminates the ~290 MB
  self-extraction on every spawn (faster cold start; larger install footprint).
- **Warm/resident engine** — keep one sidecar process alive across calls instead
  of cold-spawning per transcription/probe.

### Dev-environment notes (found during 2026-06-13 GUI verification)

- **`reel-wt-whisperx` is a git worktree with no `node_modules`.** Run `npm install`
  there before `npm run tauri dev`, or the `beforeDevCommand` aborts with
  `vite: command not found`.
- **`src-tauri/.taurignore` (containing `binaries/`) is required for `tauri dev`.**
  Without it the dev watcher rebuild-loops: the engine self-test touches the bundled
  HF align cache (`binaries/align_models/**/.no_exist/*`) on every launch, the
  watcher sees `binaries/` change → rebuild → relaunch → touch → … and the window
  never settles (looks like a frozen/blank UI). Dev-only; `tauri build` is
  unaffected. Do not delete it.

## Migration Notes

- **Cache**: legacy `whisper-cache/<hash>.{srt,json}` stays readable; new engine writes a version-scoped namespace. No forced re-transcribe.
- **Project schema**: v3 → v4 (adds `sentences[].words`, optional `speaker`). v3 loads tolerantly; v4 is written going forward.
- **Model path**: the raw `whisperModelPath`/`.bin` picker is replaced by a managed `model_id`; migrate `state`/`.reelproj` to prefer `model_id`, ignoring stale `whisperModelPath`.

## References

- Roadmap slice: `context/foundation/roadmap.md` → S-05
- PRD: `context/foundation/prd.md` → FR-001…FR-007 (+ success criteria, Cut accuracy)
- Current engine: `src-tauri/src/whisper.rs`
- Import/segmentation: `src/ui/step1-import.js`, `src/parser/srt.js`, `src/parser/segments.js`
- Credentials helper: `src/ai/api-key.js`
- Bundling precedent: `tauri.conf.json` (`externalBin`), `src-tauri/binaries/ffmpeg-*`
- Lessons: `context/foundation/lessons.md` (plan-brief.md in Polish)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: WhisperX Sidecar Packaging

#### Automated

- [x] 1.1 Rust type-check passes (`cargo check`) — cb94e36
- [x] 1.2 Sidecar build script emits arch-suffixed binaries (`ls src-tauri/binaries/whisperx-engine-*`) — 4b4f522
- [x] 1.3 `whisperx_engine_check` returns `ok: true` with no `whisper-cli`/Python on PATH — 8dd6d31

#### Manual

- [ ] 1.4 Frozen sidecar runs standalone and prints valid JSON on a sample WAV
- [ ] 1.5 macOS GPU (Metal) variant selected and faster than CPU
- [ ] 1.6 Windows build runs on a clean box with no Python
- [ ] 1.7 Bundled alignment model performs forced alignment offline

### Phase 2: Backend Engine Swap + Cache Versioning

#### Automated

- [x] 2.1 Rust type-check passes (`cargo check`) — f65f737
- [x] 2.2 Rust build passes (`cargo build`) — f65f737
- [x] 2.3 Legacy `whisper-cache/<hash>.srt` fixture still loads (cache hit, no engine) — f65f737

#### Manual

- [x] 2.4 Real clip drives the engine with transcribe → align progress — GUI verified 2026-06-13: real clip transcribed end-to-end after fixing the bundled FFmpeg sidecar (it was a dynamic Homebrew 7.1.1_3 copy whose dylibs are gone; replaced with a self-contained static ffmpeg 8.1 arm64) — ac479ba
- [x] 2.5 Cancel mid-run: no temp WAV / orphan process, shows cancelled state — GUI verified 2026-06-13: cancel→restart now works. Root cause: SIGKILL of the PyInstaller bootloader orphaned its worker (held stdout open → driver promise never resolved). Fixed: driver loop polls the cancel flag every 250 ms; cancel sends SIGTERM (bootloader forwards → worker exits) then SIGKILL fallback; temp WAV removed on exit — ac479ba
- [ ] 2.6 Each error path shows its specific Polish message
- [ ] 2.7 Existing project with legacy cache does not re-transcribe

### Phase 3: Word-Driven Segmentation + Persistence (v4)

#### Automated

- [x] 3.1 Regression suite passes incl. new word-segmentation cases — 8738e85
- [x] 3.2 Rust type-check passes (`cargo check`) — 8738e85
- [x] 3.3 v3 fixture loads without `words`; v4 fixture round-trips `words[]` — 8738e85

#### Manual

- [ ] 3.4 Segments are gap-free, numbered, read as sentences
- [ ] 3.5 Word boundaries land between words (no mid-word cuts)
- [ ] 3.6 Save → reload a v4 project preserves `words[]`
- [ ] 3.7 Exported EDL imports cleanly (no regression vs SRT path)

### Phase 4: Model Manager UI + Download-on-Demand

#### Automated

- [x] 4.1 Rust type-check + build pass — a44d6cf
- [x] 4.2 SHA-256 mismatch deletes partial download and errors — a44d6cf
- [x] 4.3 Frontend passes Prettier check — 4603f46

#### Manual

- [x] 4.4 Model list shows downloaded/missing/ready correctly on first run — GUI verified 2026-06-13 (clean first-run: alignment model "wbudowany/gotowy", small/medium/large-v3 all "Brak" + Pobierz, transcribe disabled)
- [x] 4.5 Download shows live %/speed/ETA and verifies before use — GUI verified 2026-06-13: small (486 MB) downloaded with live %/MB·s/ETA readout (after fixing an un-awaited renderModelManager() that detached the progress node — step1-import.js downloadModel), model.bin sha256 matched registry (3e30…d671), all 4 files present, atomic .part→small/ rename, row flips to ✓ Pobrany/Wybrany
- [x] 4.6 Corrupt/interrupted download rejected with clear Polish message — GUI verified 2026-06-13: injected a wrong model.bin sha256, re-download streamed full model.bin then failed verify; alert showed the distinct Polish error ("Suma kontrolna … nie zgadza się (oczekiwano deadbeefdead, otrzymano 3e305921506d). Pobieranie odrzucone."), small.part/ removed, no small/ left, row stayed Brak; real sha restored after
- [x] 4.7 Transcription uses the selected downloaded model end-to-end — GUI verified 2026-06-13: transcribed a real clip with a downloaded managed model; SRT + word-aligned segments produced. Also fixed a cache bug found here — the cache was keyed by the video only, so re-transcribing with a DIFFERENT model returned the old SRT; key now folds the full run signature (model/language/diarize/advanced) — ac479ba

### Phase 5: Transcript Import + Optional Align + Export

#### Automated

- [x] 5.1 Transcript-exporter regression case passes (if added under `src/exporters/`) — 86cf1d8
- [x] 5.2 Rust type-check passes (`cargo check`) — 86cf1d8

#### Manual

- [ ] 5.3 Import `.srt`/`.vtt` (no video) loads text-only segments and feeds selection
- [ ] 5.4 "Align to audio" attaches word timestamps to imported segments
- [ ] 5.5 Exported `.srt`/`.vtt` re-imports cleanly and matches the transcript

### Phase 6: Opt-In Diarization Toggle

#### Automated

- [x] 6.1 Regression suite passes with `speaker` present and absent — 9809e45
- [x] 6.2 Rust type-check passes (`cargo check`) — 9809e45

#### Manual

- [ ] 6.3 Toggle off → zero HF/diarization involvement
- [ ] 6.4 Valid HF token → speaker-labeled segments
- [ ] 6.5 Missing/invalid token → clear Polish error, core transcription still works
- [ ] 6.6 Speaker labels survive save → reload

### Phase 7: Model Manager Enhancements (post-core, added 2026-06-13)

#### Automated

- [x] 7.1 Frontend passes Prettier check — ac479ba
- [x] 7.2 Rust type-check passes (`cargo check`) — ac479ba
- [x] 7.3 Rebuilt sidecar `--selftest` returns `ok: true` after the new CLI flags — ac479ba; **corrected 2026-06-14**: the binary in place was actually STALE (frozen before the Phase 7 flags) — `--selftest` passed only because selftest doesn't exercise `--device`/`--compute-type`, so the missing flags slipped through (advanced modal failed at runtime with exit 2 "unrecognized arguments"). Rebuilt via `sidecar/build.sh`; now `--device cpu --compute-type float32 --selftest` is accepted (exit 0). Lesson: verify the rebuilt argparse accepts the new flags, not just that selftest is green.

#### Manual

- [x] 7.4 Dropdown lists all models incl. large-v3-turbo with correct per-option status
- [x] 7.5 Selecting a downloaded model sets it active; selecting a missing one offers download
- [x] 7.6 large-v3-turbo downloads with live progress, verifies sha256, becomes selectable
- [ ] 7.7 Transcription runs end-to-end with large-v3-turbo selected
- [x] 7.8 Advanced-settings modal opens, persists values; untouched modal = current default behavior
- [ ] 7.9 Force CPU + non-default compute precision reach the engine and change a real run
