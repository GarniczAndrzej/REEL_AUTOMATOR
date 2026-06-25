# Local (offline) Cohere Transcription — Native transformers 5.x Implementation Plan

## Overview

Add Cohere `cohere-transcribe-03-2026` (2B Conformer ASR, Apache-2.0, open weights on
HuggingFace) as a **downloadable, offline transcription model** running inside the existing
`whisperx-engine` sidecar via **native transformers ≥5.4.0** support (no `trust_remote_code`).
Cohere produces the raw Polish transcript; **WhisperX still performs all word-level forced
alignment** against the bundled `pl` wav2vec2 model, so the integer-frame export math and the
entire downstream pipeline (segmentation, state, exporters) are untouched.

Planned and documented as a **quality-for-speed trade**, never a speed win (Frame: the
cold-spawn cost is a packaging artifact a model swap cannot reduce and a second 2B load can
only worsen). The sole justification is potential Polish-transcription quality plus offline
operation (no Cohere key, no 25 MB cloud cap, no rate limits) — measured in the final phase.

## Current State Analysis

- **Transcription today**: `transcribe_video` (`whisper.rs:370`) extracts 16 kHz mono WAV via
  FFmpeg, then drives the `whisperx-engine` sidecar (`cmd_transcribe`, `whisperx_engine.py:366`)
  which transcribes with a faster-whisper CT2 model **and** aligns in one run, returning
  `{srt_content, words, segments, language}` (`whisper.rs:566`).
- **The align seam is transcript-source agnostic**: `_align` (`whisperx_engine.py:277`) and
  `_normalize` (`:305`) consume `{start,end,text}` segments and emit the normalized word
  payload regardless of where the transcript came from. This is the clean cut point (research
  Architecture Insights; frame Reframed Problem Statement).
- **Models are downloaded on demand**: the frontend registry (`src/transcription/model-registry.js`)
  curates `{id,label,repo,sizeBytes,files[]}`; `models.rs` streams each file into
  `whisper-models/<id>/` and marks readiness by the presence of **`model.bin`**
  (`MODEL_SENTINEL`, `models.rs:20`) — a CT2-specific assumption. `model_dir`/`is_downloaded`
  (`models.rs:47,52`) back the readiness check.
- **Caching**: `whisper-cache/v2/<hash>.json` keyed by `(video_hash, run_sig)` where `run_sig`
  already folds model id + language + diarize + advanced knobs (`whisper.rs:201-250`). A Cohere
  run differentiates automatically by model id.
- **Credentials**: weights download from a **gated** HF repo (`gated: auto`). The HF token is
  needed at fetch time; the current `download_model` reqwest client sends **no** Authorization
  header (the existing `HF_TOKEN` env is for the sidecar *spawn* only, `whisper.rs:536`).

### Key Discoveries (from the 2026-06-25 spike — see `spike-notes.md` ADDENDUM):

- **The model's full documented behavior is NATIVE to transformers ≥5.4.0**, not the
  `trust_remote_code` modules. The repo-local `CohereAsrProcessor` (remote code) is a degraded
  fallback: it ignores `language=`, has no punctuation control, no auto-chunking, no
  `audio_chunk_index` reassembly — so on the pinned transformers 4.57.6 it builds no decoder
  prompt and `generate()` crashes (`decoder_attention_mask=None`). **The original Phase 2
  (trust_remote_code @ 4.57.6 + hand-rolled chunk-and-stitch + frozen-RC packaging probe) is
  obsolete.**
- **transformers 5.x is released and mature** (PyPI latest **5.12.1**; ≥5.4.0 carries native
  `cohere_asr`). The venv is pinned at 4.57.6 only by the existing build.
- **whisperx 3.8.6 requires `transformers>=4.48.0` with NO upper cap**, so a bump to 5.12.x is
  not forbidden — but pyannote 4.0.4 (diarization) and the wav2vec2 align path must be
  re-validated on 5.x (the **hard gate**).
- **Real download manifest** (HF tree): single `model.safetensors` = **4131862976 bytes**
  (4.13 GB, LFS) + `config.json`, `generation_config.json`, `preprocessor_config.json`,
  `processor_config.json`, `special_tokens_map.json`, `tokenizer.json`, `tokenizer.model`
  (LFS, 493 KB), `tokenizer_config.json`. **On the native path the four `*_cohere_asr.py`
  remote modules are NOT needed** (transformers resolves `cohere_asr` internally).
- **`config.json` → `max_audio_clip_s: 35`** (real chunk window), `overlap_chunk_second: 5`
  (native chunker overlaps 5 s), `supported_languages` includes `pl`. The native processor
  **auto-splits** audio > 35 s and reassembles per-chunk transcriptions via `audio_chunk_index`.
- **New runtime deps the native model needs**: `librosa`, `sentencepiece`, `soundfile`,
  `protobuf`, `accelerate` (installed into `sidecar/.venv` during the spike).
- **`punctuation=True/False`** is a real honored processor knob (feeds the Phase 5/4 panel).

## Desired End State

In the Step-1 transcription model list, a new **Cohere (Polski, offline)** entry sits beside
the WhisperX models. Selecting it downloads the open weights on demand into
`whisper-models/<id>/`. When chosen, the advanced panel swaps to Cohere-appropriate options
(punctuation toggle + align `device`; the WhisperX ASR-only knobs are hidden). Running
transcription with Cohere produces a Polish transcript offline via native transformers 5.x;
WhisperX aligns it to word timestamps; the result flows through the unchanged
`segments → sentences → exporters` pipeline. The **existing WhisperX path (transcribe +
align + diarize) is byte-for-byte / behaviorally unchanged on the bumped transformers**. A
documented side-by-side Polish quality comparison decides default-vs-optional.

**Verification**: `cargo check` + `cargo build` pass; the engine self-check passes on the 5.x
build; a Cohere-selected transcription of a Polish clip yields aligned `sentences` exporting to
valid EDL/XML/Lua; `node --experimental-vm-modules test/regression.js` stays green.

## What We're NOT Doing

- **No Cohere cloud API** (`api.cohere.com`), no Cohere key, no 25 MB cap / rate-limit handling.
  Offline open weights only. (There IS an HF credential + a one-time manual license-accept on
  the gated repo — "no API key" means no *Cohere* key, not zero credentials.)
- **No `trust_remote_code`.** The native transformers ≥5.4.0 path is used; the repo's remote
  `*_cohere_asr.py` modules are neither downloaded nor bundled.
- **No GO/NO-GO quality gate before the build.** The offline target is committed up front
  (privacy / no-key / no-cap / long-webinar fit). Phase 0 is a *feasibility/compat* gate (does
  native 5.x work and does the existing engine survive the bump), NOT a quality gate. Quality is
  measured at the end (Phase 5) to set default-vs-optional.
- **No change to alignment authority, frame math, exporters, segmentation, or state shape.**
  `_align`/`_normalize` and `mergeWordsIntoSentences` are reused as-is.
- **No diarization on the Cohere path** in this change (WhisperX diarization stays opt-in and
  orthogonal). Existing WhisperX diarization MUST keep working on 5.x (hard gate), but Cohere
  itself does not diarize here.
- **No second sidecar UNLESS Phase 0's hard gate trips.** The committed architecture is a single
  engine on transformers 5.x; the isolated-sidecar design is the named fallback only if the
  existing engine (esp. pyannote diarization) regresses on 5.x (see Phase 0 gate).
- **No selling this as faster.**

## Implementation Approach

Bump the single `whisperx-engine` sidecar to transformers 5.12.x and add Cohere as "just another
model in the Step-1 list," reusing download-on-demand. Generalize the model layer so a model
declares its **engine kind** and **readiness sentinel** instead of assuming CT2 `model.bin`. In
the sidecar, add a native Cohere transcription branch selected by `--engine cohere`: it loads
`CohereAsrForConditionalGeneration` + `AutoProcessor` (native, no `trust_remote_code`), lets the
processor auto-chunk long audio, and builds **one `_align` segment per chunk** from the chunk's
real `[start,end]` window (via `audio_chunk_index`), feeding the existing `_align` → `_normalize`.
Rust `transcribe_video` resolves the Cohere model dir and passes `--engine cohere`; caching and
payload are unchanged. The frontend routes the Cohere selection through the shared
`transcribeDocument` (so auto-mode inherits it) and swaps the advanced panel. Finally, measure
Polish quality to set the default.

The whole build is **gated by Phase 0**, which proves (a) native 5.x Cohere transcribes Polish
and exposes per-chunk time spans, and (b) the existing WhisperX engine survives the transformers
bump. If (b) fails, STOP and switch to the isolated-sidecar architecture before building Phases
1–5.

## Critical Implementation Details

- **The transformers 4→5 bump is the load-bearing risk, not the Cohere ASR logic.** The Cohere
  branch mirrors `cmd_transcribe`'s contract; the real danger is regressing the shipping WhisperX
  transcribe/align/**diarize** path on a major version jump. Phase 0 hard-gates this; Phase 2's
  build must re-confirm the default `--engine whisperx` path is unchanged on a control clip.
- **Per-chunk align windows, not one full-audio segment.** The native processor stitches a flat
  transcript, but `audio_chunk_index` carries which chunk each piece came from; build one
  `_align` segment per chunk using the chunk's real audio `[start,end]` (35 s windows, 5 s
  overlap). A single `{0, audio_len, text}` segment recreates the unbounded-window problem
  research §F flags as slow / memory-heavy / lower-quality on long (>13-min) webinars — the core
  content. Phase 0 confirms `audio_chunk_index` exposes per-chunk spans; if it does not, fall
  back to sentence-split pseudo-cues (research §F option 2).
- **Cold-spawn discipline.** The Cohere branch must never be on launch or any critical path —
  only on an explicit transcription action (memory `whisperx-cold-spawn-cost`). The 4.13 GB
  `model.safetensors` stays OUT of the PyInstaller onefile (download-on-demand beside the binary),
  per the `never-bake-multi-GB-into-onefile` lesson.
- **Gated download needs Bearer auth (new code).** The repo is `gated: auto`; the download client
  currently sends no Authorization header, so a gated `resolve/main/<file>` returns 401/403.
  `download_model` must send `Authorization: Bearer <hf_token>` and surface a Polish error naming
  the two prerequisites (accept license once on the HF page; provide an HF token).

---

## Phase 0: Transformers 5.x coexistence + native Cohere feasibility gate

### Overview

Before any production code, prove the two load-bearing unknowns in a **recoverable** env (a
throwaway clone of `sidecar/.venv`, or the dev venv with a documented restore-from-requirements
step): (1) **native** transformers ≥5.4.0 loads and transcribes `cohere-transcribe-03-2026` in
Polish **without `trust_remote_code`**, honoring `language`/`punctuation` and auto-chunking long
audio, and exposing per-chunk time spans via `audio_chunk_index`; and (2) the **hard gate** — the
existing WhisperX engine (transcribe + align + **diarize**) still passes on transformers 5.12.x.
This is a feasibility/compat gate, not a quality gate.

### Changes Required:

#### 1. Native 5.x Cohere load + transcribe (no source change; record in `spike-notes.md`)

**File**: scratch only; findings → `context/changes/local-cohere-transcription/spike-notes.md`.

**Intent**: Confirm the committed native path works end-to-end on transformers 5.12.x and yields
the data the build depends on (real max-input window already known = 35 s; per-chunk span
exposure; which generation/processor kwargs are honored).

**Contract**: In a recoverable env upgraded to `transformers==5.12.x` (record exact version),
with `HF_HUB_OFFLINE=1 TRANSFORMERS_OFFLINE=1`, load
`CohereAsrForConditionalGeneration.from_pretrained(model_dir)` +
`AutoProcessor.from_pretrained(model_dir)` **without `trust_remote_code`**, and transcribe the
Polish clip (`~/Desktop/LOVELETTER.mov` → 16 kHz mono WAV via the bundled ffmpeg sidecar).
Record: non-empty Polish text; that `language='pl'` and `punctuation=True/False` are honored;
that audio > 35 s auto-chunks and `processor.decode(..., audio_chunk_index=…)` reassembles
continuous text; and **whether `audio_chunk_index` (or the processor output) exposes per-chunk
`[start,end]` time spans** (decides the Phase 2 align-window strategy). Also record a one-line
Polish-quality read (feeds Phase 5).

#### 2. Hard gate — existing WhisperX engine survives transformers 5.x

**File**: scratch / the rebuilt-in-place engine sources run from the upgraded venv; record in
`spike-notes.md`.

**Intent**: Prove the major version bump does not regress the shipping WhisperX path before
committing to it.

**Contract**: In the same upgraded (5.12.x) env, run the engine's `--selftest`
(`whisperx_engine_check` path), a control **transcribe** of a short clip, an **align** of a
transcript, and a **diarization** run (the riskiest — pyannote 4.0.4 on transformers 5.x).
Record pass/fail for each. **Gate**: if any of transcribe/align/diarize regresses on 5.x (esp.
diarization), STOP and switch to the **isolated-sidecar** architecture (keep WhisperX on 4.57.6;
add a separate transformers-5.x Cohere ASR sidecar feeding the existing align-only path via a new
plain-text mode) — re-plan Phases 2–5 for that shape. Otherwise proceed with the single-engine
bump.

### Success Criteria:

#### Automated Verification:

- Native load+transcribe script prints non-empty Polish text for the clip with
  `transformers==5.12.x` and **no `trust_remote_code`** (command recorded in `spike-notes.md`).

#### Manual Verification:

- `spike-notes.md` records: exact transformers 5.x version; that native CohereAsr loads without
  `trust_remote_code`; that `language`/`punctuation` are honored; that long-audio auto-chunk +
  `audio_chunk_index` reassembly works and **whether per-chunk time spans are exposed**; and a
  one-line Polish-quality read.
- `spike-notes.md` records the **hard-gate** result: existing WhisperX `--selftest` + transcribe
  + align + **diarize** all pass on transformers 5.12.x. If diarization (or any) fails → the
  isolated-sidecar fallback is triggered and Phases 2–5 are re-planned before proceeding.

**Implementation Note**: This phase exists to fail cheap and to protect the shipping engine. Do
not start Phase 1 until both the native-Cohere criterion and the hard gate pass. Keep the env
restore command (`pip install -r requirements.txt`) recorded so the dev venv can be reverted.

---

## Phase 1: Model registry & gated download-on-demand for Cohere weights

### Overview

Make the model layer engine-agnostic so Cohere's open weights can be listed, downloaded,
verified, and marked ready like a WhisperX CT2 model — without the `model.bin` assumption — and
authenticate the gated download.

### Changes Required:

#### 1. Frontend model registry

**File**: `src/transcription/model-registry.js`

**Intent**: Add a Cohere model entry and extend the model typedef so each model declares its
engine kind and the file that marks it "downloaded," instead of every model implicitly being CT2.

**Contract**: Extend `TranscriptionModel` with `kind: 'whisperx-ct2' | 'cohere-transformers'`
(default `'whisperx-ct2'` for existing entries) and `sentinel: string` (the file whose presence
means ready — `'model.bin'` for CT2, `'model.safetensors'` for Cohere). Add the Cohere entry:
`{ id: 'cohere-pl', label: 'Cohere (Polski, offline)', repo:
'CohereLabs/cohere-transcribe-03-2026', kind: 'cohere-transformers', sentinel:
'model.safetensors', sizeBytes: 4131862976, files: [...] }`. The manifest is the **native** set
(NO `*_cohere_asr.py`): `model.safetensors` (sha256 on this LFS weight), `config.json`,
`generation_config.json`, `preprocessor_config.json`, `processor_config.json`,
`special_tokens_map.json`, `tokenizer.json`, `tokenizer.model` (LFS), `tokenizer_config.json`.
The repo is **gated** (`gated: auto`) — the download loop must send the HF token (Phase 1 §3) and
the user must accept the license once on the HF page. Exact per-file `sha256`/sizes come from the
HF tree API during implementation (weights size verified = 4131862976).

#### 2. Rust model manager — per-model sentinel

**File**: `src-tauri/src/models.rs`

**Intent**: Replace the hardcoded `model.bin` readiness sentinel with a per-model sentinel from
the registry, so `is_downloaded`/`model_dir` work for Cohere.

**Contract**: `is_downloaded` (`:52`) takes the sentinel filename (threaded from the registry
through the `download_model`/`list_models` command params) instead of the `MODEL_SENTINEL` const;
`list_models` reports readiness per model using each model's declared sentinel. The
download/verify/stream loop is otherwise unchanged (it already iterates an arbitrary `files[]`
manifest with optional per-file sha256). Keep `MODEL_SENTINEL` as the CT2 default when a model
omits a sentinel. **Caller blast radius**: both `#[tauri::command]` signatures change — update the
two frontend invoke sites in lockstep (`list_models` `transcribe.js:207`, `download_model` `:350`).
**Third caller — the Rust readiness gate**: `transcribe_video` calls `is_downloaded(&dir)`
(`whisper.rs:400`) before spawning the engine; it must now pass the selected model's sentinel too
(wired in Phase 3 §1), else a fully-downloaded Cohere model (sentinel `model.safetensors`, no
`model.bin`) wrongly fails the gate with "Wybrany model nie został pobrany."

#### 3. Gated-repo download authentication

**File**: `src-tauri/src/models.rs`, `src/ui/import/transcribe.js`

**Intent**: Authenticate the gated weights download (the current client sends no Authorization
header → 401/403 on a gated repo).

**Contract**: `download_model` (`models.rs:141`) accepts a new `hf_token: Option<String>` param;
when present, each per-file `client.get(url)` sets `Authorization: Bearer <token>` (mirroring how
`callOpenRouter` builds its header). On 401/403 from the gated repo, return a clear **Polish**
error naming the two prerequisites: accept the model license once on the HF page, and provide an
HF token. The frontend `download_model` invoke (`transcribe.js:350`) passes the stored HF token
(reuse the existing diarization HF-token input value). CT2 (public) downloads pass `None` / omit
the header and are byte-for-byte unchanged.

### Success Criteria:

#### Automated Verification:

- Rust type-checks: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite passes: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- The Cohere entry appears in the Step-1 model list with correct label/size.
- Downloading Cohere streams all files, verifies the weights sha256, and shows "ready" via its
  own sentinel (`model.safetensors`).
- Existing WhisperX models still download and report readiness unchanged.
- The gated download sends `Authorization: Bearer`; a missing token / unaccepted license (401/403)
  surfaces a clear Polish error naming both prerequisites.

**Implementation Note**: After this phase and all automated verification passes, pause for manual
confirmation before proceeding.

---

## Phase 2: Engine — native Cohere producer + transformers 5.x build

### Overview

Add a native (no `trust_remote_code`) Cohere transcription branch to the sidecar, selected by
`--engine cohere`, that lets the processor auto-chunk long audio and builds per-chunk `_align`
segments, then bump the sidecar to transformers 5.x and rebuild. Re-confirm the default WhisperX
path is unchanged on the bumped runtime.

### Changes Required:

#### 1. Cohere transcribe command

**File**: `sidecar/whisperx_engine/whisperx_engine.py`

**Intent**: Add a transformers-native Cohere producer that mirrors `cmd_transcribe`'s contract
(audio in → aligned, normalized payload out) but swaps the ASR stage; reuse `_align` and
`_normalize` verbatim so timing stays WhisperX's job.

**Contract**: New `cmd_transcribe_cohere(args)` that loads the Cohere model/processor from the
local `--model` dir via **native** transformers
(`CohereAsrForConditionalGeneration.from_pretrained(model_dir)` +
`AutoProcessor.from_pretrained(model_dir)`, NO `trust_remote_code`), runs the processor on the
loaded `audio` (`_load_audio`, `:266`) with `language` (concrete — error `EXIT_USAGE` if missing,
matching `cmd_align_only`) and the `punctuation` flag, lets the processor **auto-chunk** audio
> `max_audio_clip_s` (35 s, 5 s overlap), generates, and decodes with `audio_chunk_index`.
Build **one `_align` segment per chunk** `{start: chunk_start, end: chunk_end, text: chunk_text}`
from the per-chunk spans the processor exposes (confirmed in Phase 0) — NOT a single full-audio
segment (see Critical Implementation Details / research §F). If Phase 0 found per-chunk spans are
**not** exposed, fall back to sentence-split pseudo-cues over the audio duration. Then call
`_align(whisperx, segments, audio, language, device)` → `_normalize(language, aligned)` →
`_write_result`. Emit `PROGRESS phase=transcribe percent=…` across chunks so the existing progress
UI works.

#### 2. Engine flag + dispatch

**File**: `sidecar/whisperx_engine/whisperx_engine.py`

**Intent**: Route to the Cohere producer via a new flag without disturbing the default WhisperX
path.

**Contract**: Add `--engine {whisperx,cohere}` (default `whisperx`) to `build_parser` (`:485`);
in `main` dispatch, `--engine cohere` → `cmd_transcribe_cohere`, else current behavior.
`--align-only` is unaffected. Add a `--punctuation`/`--no-punctuation` arg consumed by
`cmd_transcribe_cohere` (carrier for the Phase 4 panel toggle).

#### 3. Build / packaging — transformers 5.x bump

**File**: `sidecar/whisperx_engine/requirements.txt`, `sidecar/whisperx_engine.spec`,
`sidecar/build.sh`

**Intent**: Move the sidecar to transformers ≥5.4.0 (native Cohere) and add the Cohere runtime
deps, while keeping the 4.13 GB weights OUT of the onefile.

**Contract**: `requirements.txt`: bump the `transformers` floor to `>=5.4.0` (pin the exact 5.x
proven in Phase 0, e.g. `5.12.1`) and add `librosa`, `sentencepiece`, `soundfile`, `protobuf`,
`accelerate`. Update `whisperx_engine.spec` hidden-imports / `collect-submodules` as needed for
the native `cohere_asr` model + librosa/numba/sentencepiece (resolve any `ModuleNotFoundError`
from the frozen binary). Rebuild via `sidecar/build.sh`. Confirm the onefile size delta is
**code-only** — `model.safetensors` is never baked in. **Because this bumps the shared engine,
re-confirm the default WhisperX path** (transcribe/align/diarize) on the rebuilt binary.

### Success Criteria:

#### Automated Verification:

- Sidecar builds: `sidecar/build.sh` completes without error.
- Engine self-check passes: `whisperx_engine_check` (`--selftest`) succeeds with the rebuilt 5.x
  binary.
- Engine help lists the new flag: `whisperx-engine --help` shows `--engine` (and `--punctuation`).

#### Manual Verification:

- With a downloaded Cohere model dir, `--engine cohere --audio <short pl clip> --model <dir>
  --language pl` returns a normalized `{srt_content, words, segments, language}` payload with sane
  Polish text and word timings.
- A >13-min webinar transcribes via the processor's native chunking without OOM and produces
  continuous text with per-chunk align windows (no single unbounded segment).
- `--punctuation` toggles punctuation/casing in the Cohere output.
- **Default `--engine whisperx` (transcribe + align + diarize) is unchanged** on a control clip
  with the rebuilt transformers-5.x binary (the bump did not regress the shipping path).

**Implementation Note**: After this phase and all automated verification passes, pause for manual
confirmation before proceeding.

---

## Phase 3: Rust routing — `transcribe_video` drives the Cohere engine

### Overview

Teach `transcribe_video` to resolve the Cohere model dir and pass `--engine cohere`, reusing the
existing cache and payload contract.

### Changes Required:

#### 1. Engine-kind-aware transcription

**File**: `src-tauri/src/whisper.rs`

**Intent**: When the selected model is the Cohere kind, drive the engine with `--engine cohere`
against the downloaded model dir; otherwise keep the current CT2 path. Payload parsing and caching
unchanged.

**Contract**: In `transcribe_video` (`:370`), determine engine kind for the requested `model_id`
(passed from the frontend) and add `--engine cohere` (+ the `--punctuation` flag from the advanced
bag) to the sidecar args when applicable; the local `--model` path comes from `models::model_dir`.
**Sentinel-aware readiness gate**: the command also accepts the selected model's `sentinel` (the
registry string, passed from the frontend with `model_id`/engine kind) and uses it in
`is_downloaded(&dir, &sentinel)` at `whisper.rs:400` instead of the CT2 `model.bin` default — so a
downloaded Cohere model passes the gate. CT2 models pass `model.bin` and behave exactly as today.
Confirm the engine kind is folded into `run_sig` (`:201-250`) so two engines on the same model id
differentiate in cache. The return payload (`:566`) and `drive_engine` cancel/reaper discipline
are untouched.

### Success Criteria:

#### Automated Verification:

- Rust type-checks: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Rust builds: `~/.cargo/bin/cargo build --manifest-path src-tauri/Cargo.toml`

#### Manual Verification:

- Invoking `transcribe_video` with the Cohere model runs the Cohere engine path end-to-end and
  returns aligned words.
- Re-running the same clip hits the `whisper-cache/v2` cache (no second engine spawn).
- Switching back to a WhisperX model still routes to the CT2 path.

**Implementation Note**: After this phase and all automated verification passes, pause for manual
confirmation before proceeding.

---

## Phase 4: Frontend — model-aware routing & advanced-settings swap

### Overview

Route the Cohere model selection through the shared transcription unit (so auto-mode inherits it)
and present Cohere-appropriate advanced settings.

### Changes Required:

#### 1. Transcription trigger routing

**File**: `src/ui/import/transcribe.js`

**Intent**: When the selected model is the Cohere kind, run transcription via the engine-aware
`transcribe_video` invoke and ensure `language` is concrete before the call.

**Contract**: Thread Cohere-awareness through the **shared** `transcribeDocument` unit (`:728`),
**not** the DOM orchestrator `transcribeWithWhisper` (`:807`) — because auto-mode drives
transcription through the same `transcribeDocument` (`src/ui/auto-mode/orchestrator.js:233`,
`src/ui/auto-mode/batch.js:210`), so a shared-unit placement makes manual Step-1 **and** both
auto-mode paths Cohere-aware. In `transcribeDocument`: look up `getModel(modelId)`
(`model-registry.js:118`), derive `kind` + `sentinel`, and pass **both** into
`invoke('transcribe_video', {…})` (`:765`) alongside `modelId` — the Rust readiness gate (Phase 3,
`whisper.rs:400`) needs the `sentinel`. When `kind === 'cohere-transformers'`, map
`whisperLanguage === 'auto'` → `pl` before the invoke (Cohere has no auto-detect). The downstream
`segmentFromWords` → `state.sentences` merge is unchanged.

#### 2. Advanced-settings swap

**File**: `src/index.html` (`#whisperAdvancedModal` markup + `adv*` inputs, ~`:547`) and
`src/ui/import/transcribe.js` (`:448-541` panel render/read logic + `whisperAdvancedArgs()` at
`:533`). *(NOT `settings-modal.js`, which only references the modal in a comment.)*

**Intent**: When Cohere is chosen, show Cohere-relevant controls and hide the WhisperX ASR-only
knobs.

**Contract**: Gate the advanced panel by the selected model's `kind`. WhisperX kind → current
knobs (beam_size, vad_onset/offset, initial_prompt, compute_type, device). Cohere kind → the align
`device` override **plus a `punctuation` on/off toggle** (the one Phase-0-confirmed honored Cohere
knob); hide the rest. Carry `punctuation` end-to-end: it rides the `whisperAdvancedArgs()` bag
(`transcribe.js:533`) → `invoke('transcribe_video')` → Rust forwards `--punctuation` (Phase 3 §1)
→ `cmd_transcribe_cohere` (Phase 2 §2). All new strings Polish. No exporter/state shape change.

### Success Criteria:

#### Automated Verification:

- Prettier clean: `npx prettier --check "src/**/*.{js,css,html}"`
- Regression suite passes: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- Selecting Cohere swaps the advanced panel to Cohere controls (device + punctuation); selecting a
  WhisperX model restores the full WhisperX knob set.
- A full Step-1 Cohere transcription (pick model → transcribe → align) populates `sentences` and
  the timeline; export to EDL/XML/Lua produces valid output.
- `auto` language with Cohere resolves to `pl` and succeeds; the punctuation toggle changes output.
- **Auto-mode** (single-clip pipeline *and* batch) with Cohere runs end-to-end: the readiness gate
  passes (sentinel threaded through shared `transcribeDocument`), `auto`→`pl` applied, `sentences`
  populate.

**Implementation Note**: After this phase and all automated verification passes, pause for manual
confirmation before proceeding.

---

## Phase 5: Quality validation & regression

### Overview

Measure Cohere's Polish transcription quality against current WhisperX on representative content
and decide whether Cohere becomes the default model or stays optional. Confirm no pipeline
regressions.

### Changes Required:

#### 1. Side-by-side Polish comparison

**File**: `context/changes/local-cohere-transcription/quality-comparison.md` (new artifact; no
source change)

**Intent**: Produce the measured evidence the Frame flagged as the missing premise, on the real
shipping path (offline native Cohere), and record the default-provider decision.

**Contract**: On 1–2 representative Polish webinar clips, transcribe with both the current best
WhisperX model and offline Cohere. Read both Polish outputs side-by-side (diacritics, named
entities, domain jargon, punctuation/casing) and compute WER against a hand-corrected reference for
at least one clip. Record outputs, the WER number, the qualitative read, and a GO/optional
decision: if Cohere clearly wins → make it the default model selection; otherwise keep it as an
optional list entry. No "faster" claim anywhere.

### Success Criteria:

#### Automated Verification:

- Full regression suite green: `node --experimental-vm-modules test/regression.js`
- Rust builds clean: `~/.cargo/bin/cargo build --manifest-path src-tauri/Cargo.toml`

#### Manual Verification:

- `quality-comparison.md` records both transcripts, a WER figure for ≥1 clip, the qualitative
  Polish read, and an explicit default-vs-optional decision.
- The chosen default reflects the measurement (no "faster" claim anywhere in copy).
- End-to-end on a real webinar: Cohere transcribe → align → segment → export works.

**Implementation Note**: Terminal phase; after validation, update `change.md` status and consider
archiving via `/10x-archive`.

---

## Testing Strategy

### Unit / Regression Tests:

- `test/regression.js` (parser + EDL/XML/Lua exporters) must stay green throughout — the Cohere
  path changes the *source* of `segments`/`words`, not their shape.

### Integration Tests (manual):

- Phase 0 hard gate: existing WhisperX transcribe + align + diarize pass on transformers 5.x.
- Cohere model download → readiness → transcribe (short clip) → align → segment → export, macOS arm64.
- Long webinar (>13 min) native chunking without OOM; per-chunk align windows.
- WhisperX control path unchanged (default engine, existing models) on the 5.x build.
- Cache hit on re-run; no Cohere/WhisperX cache collision on the same clip.

### Manual Testing Steps:

1. Pick the Cohere model in Step-1; download it; confirm "ready" via its sentinel.
2. Transcribe a short Polish clip; verify aligned words and timeline; toggle punctuation.
3. Transcribe a >13-min webinar; verify continuous text and no crash.
4. Switch to a WhisperX model; verify advanced panel and behavior revert; diarize still works.
5. Export EDL/XML/Lua from a Cohere-sourced timeline; verify validity.

## Performance Considerations

- **Slower than WhisperX, by design.** Eager-PyTorch 2B inference + a second model load on top of
  the WhisperX align spawn; documented as a quality trade. Keep the Cohere branch strictly off
  launch/critical paths (cache-read only at boot).
- **Chunk size is the memory lever** — the native processor sizes windows to `max_audio_clip_s`
  (35 s); long webinars stream chunk-by-chunk so memory stays bounded.

## Migration Notes

- No `.reelproj` schema change: a Cohere-sourced project stores the same `sentences`/`reelsData`;
  the persisted `modelId` references the Cohere model; older projects unaffected.
- Sidecar + weights remain git-ignored and download/build on demand (no repo bloat).
- The transformers 4→5 bump changes `requirements.txt`; a fresh sidecar build picks it up via
  `sidecar/build.sh`. Record the env restore command in `spike-notes.md`.

## References

- Frame brief: `context/changes/local-cohere-transcription/frame.md`
- Research: `context/changes/local-cohere-transcription/research.md`
- Spike findings (native 5.x gate): `context/changes/local-cohere-transcription/spike-notes.md`
- Engine seam: `sidecar/whisperx_engine/whisperx_engine.py:266,277,305,366,485`
- Model manager: `src-tauri/src/models.rs:20,47,52`; `src/transcription/model-registry.js`
- Transcription driver: `src-tauri/src/whisper.rs:370,201-250,400,566`
- Frontend trigger: `src/ui/import/transcribe.js:728,807,448-541,533`; auto-mode
  `src/ui/auto-mode/orchestrator.js:233`, `src/ui/auto-mode/batch.js:210`
- Prior packaging lesson: `context/archive/2026-06-12-builtin-whisperx-transcription/`;
  memory `whisperx-cold-spawn-cost`, `whisperx-sidecar-build`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 0: Transformers 5.x coexistence + native Cohere feasibility gate

#### Automated

- [x] 0.1 Native 5.x load+transcribe prints non-empty Polish text (no trust_remote_code) — dd72867

#### Manual

- [x] 0.2 spike-notes records transformers 5.x version, native load, language/punctuation honored — dd72867
- [x] 0.3 spike-notes records long-audio auto-chunk + audio_chunk_index reassembly + per-chunk span exposure — dd72867
- [x] 0.4 spike-notes records one-line Polish-quality read (feeds Phase 5) — dd72867
- [x] 0.5 HARD GATE: existing WhisperX selftest + transcribe + align + diarize pass on transformers 5.x — dd72867

### Phase 1: Model registry & gated download-on-demand for Cohere weights

#### Automated

- [x] 1.1 Rust type-checks (`cargo check`)
- [x] 1.2 Regression suite passes

#### Manual

- [x] 1.3 Cohere entry appears in Step-1 list with correct label/size
- [x] 1.4 Cohere download streams + verifies + reports ready via its sentinel
- [x] 1.5 Existing WhisperX models still download/report readiness unchanged
- [x] 1.6 Gated download sends `Authorization: Bearer` HF token; 401/403 yields a Polish license-accept error

### Phase 2: Engine — native Cohere producer + transformers 5.x build

#### Automated

- [ ] 2.1 Sidecar builds (`sidecar/build.sh`)
- [ ] 2.2 Engine self-check (`--selftest`) passes with rebuilt 5.x binary
- [ ] 2.3 `--engine` (and `--punctuation`) listed in engine help

#### Manual

- [ ] 2.4 Cohere run on short pl clip returns sane normalized payload
- [ ] 2.5 >13-min webinar transcribes via native chunking without OOM; per-chunk align windows
- [ ] 2.6 `--punctuation` toggles punctuation/casing in Cohere output
- [ ] 2.7 Default `--engine whisperx` (transcribe+align+diarize) unchanged on the 5.x build

### Phase 3: Rust routing — `transcribe_video` drives the Cohere engine

#### Automated

- [ ] 3.1 Rust type-checks (`cargo check`)
- [ ] 3.2 Rust builds (`cargo build`)

#### Manual

- [ ] 3.3 Cohere model selection runs the Cohere engine path end-to-end
- [ ] 3.4 Re-run hits `whisper-cache/v2` (no second spawn)
- [ ] 3.5 WhisperX model still routes to the CT2 path

### Phase 4: Frontend — model-aware routing & advanced-settings swap

#### Automated

- [ ] 4.1 Prettier clean
- [ ] 4.2 Regression suite passes

#### Manual

- [ ] 4.3 Advanced panel swaps Cohere↔WhisperX by selected model (device + punctuation)
- [ ] 4.4 Full Step-1 Cohere transcription populates sentences + exports valid
- [ ] 4.5 `auto` language with Cohere resolves to `pl`; punctuation toggle changes output
- [ ] 4.6 Auto-mode (single + batch) with Cohere runs end-to-end (gate passes, auto→pl applied)

### Phase 5: Quality validation & regression

#### Automated

- [ ] 5.1 Full regression suite green
- [ ] 5.2 Rust builds clean

#### Manual

- [ ] 5.3 `quality-comparison.md` records transcripts, WER, read, and default decision
- [ ] 5.4 Chosen default reflects the measurement (no "faster" claim)
- [ ] 5.5 End-to-end Cohere transcribe→align→segment→export on a real webinar
