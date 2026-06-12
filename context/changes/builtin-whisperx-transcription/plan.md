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

**Intent**: Detect the host OS/arch and build the matching sidecar, pulling the correct platform dependencies (CTranslate2 build, torch CPU vs GPU/Metal). On macOS produce **CPU and GPU (Metal)** variants; produce a **Windows** build as well. Bundle the per-language wav2vec2 alignment model into the frozen artifact at build time. Emit binaries with the Tauri arch-suffix naming used for FFmpeg.

**Contract**: Outputs `src-tauri/binaries/whisperx-engine-<target-triple>[-gpu]` for `aarch64-apple-darwin` (CPU + Metal) and the Windows `x86_64-pc-windows-msvc` triple. A short README documents prerequisites + how to regenerate. (No snippet — this is a build-script task; the implementer owns PyInstaller specifics.)

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
- Bundled alignment model performs forced alignment offline (no network)

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

**Implementation Note**: Final phase — confirm the full FR-001…FR-007 surface manually before closing the change.

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
- [ ] 1.2 Sidecar build script emits arch-suffixed binaries (`ls src-tauri/binaries/whisperx-engine-*`)
- [ ] 1.3 `whisperx_engine_check` returns `ok: true` with no `whisper-cli`/Python on PATH

#### Manual

- [ ] 1.4 Frozen sidecar runs standalone and prints valid JSON on a sample WAV
- [ ] 1.5 macOS GPU (Metal) variant selected and faster than CPU
- [ ] 1.6 Windows build runs on a clean box with no Python
- [ ] 1.7 Bundled alignment model performs forced alignment offline

### Phase 2: Backend Engine Swap + Cache Versioning

#### Automated

- [x] 2.1 Rust type-check passes (`cargo check`)
- [x] 2.2 Rust build passes (`cargo build`)
- [x] 2.3 Legacy `whisper-cache/<hash>.srt` fixture still loads (cache hit, no engine)

#### Manual

- [ ] 2.4 Real clip drives the engine with transcribe → align progress
- [ ] 2.5 Cancel mid-run: no temp WAV / orphan process, shows cancelled state
- [ ] 2.6 Each error path shows its specific Polish message
- [ ] 2.7 Existing project with legacy cache does not re-transcribe

### Phase 3: Word-Driven Segmentation + Persistence (v4)

#### Automated

- [ ] 3.1 Regression suite passes incl. new word-segmentation cases
- [ ] 3.2 Rust type-check passes (`cargo check`)
- [ ] 3.3 v3 fixture loads without `words`; v4 fixture round-trips `words[]`

#### Manual

- [ ] 3.4 Segments are gap-free, numbered, read as sentences
- [ ] 3.5 Word boundaries land between words (no mid-word cuts)
- [ ] 3.6 Save → reload a v4 project preserves `words[]`
- [ ] 3.7 Exported EDL imports cleanly (no regression vs SRT path)

### Phase 4: Model Manager UI + Download-on-Demand

#### Automated

- [ ] 4.1 Rust type-check + build pass
- [ ] 4.2 SHA-256 mismatch deletes partial download and errors
- [ ] 4.3 Frontend passes Prettier check

#### Manual

- [ ] 4.4 Model list shows downloaded/missing/ready correctly on first run
- [ ] 4.5 Download shows live %/speed/ETA and verifies before use
- [ ] 4.6 Corrupt/interrupted download rejected with clear Polish message
- [ ] 4.7 Transcription uses the selected downloaded model end-to-end

### Phase 5: Transcript Import + Optional Align + Export

#### Automated

- [ ] 5.1 Transcript-exporter regression case passes (if added under `src/exporters/`)
- [ ] 5.2 Rust type-check passes (`cargo check`)

#### Manual

- [ ] 5.3 Import `.srt`/`.vtt` (no video) loads text-only segments and feeds selection
- [ ] 5.4 "Align to audio" attaches word timestamps to imported segments
- [ ] 5.5 Exported `.srt`/`.vtt` re-imports cleanly and matches the transcript

### Phase 6: Opt-In Diarization Toggle

#### Automated

- [ ] 6.1 Regression suite passes with `speaker` present and absent
- [ ] 6.2 Rust type-check passes (`cargo check`)

#### Manual

- [ ] 6.3 Toggle off → zero HF/diarization involvement
- [ ] 6.4 Valid HF token → speaker-labeled segments
- [ ] 6.5 Missing/invalid token → clear Polish error, core transcription still works
- [ ] 6.6 Speaker labels survive save → reload
