# Align Model First-Run Download Implementation Plan

## Overview

Un-bundle the ~1.2 GB Polish wav2vec2 alignment model from the macOS app so the
DMG drops from **~4.7 GB to ~400 MB** (shippable under GitHub's 2 GB single-asset
release cap). The model is downloaded **once on first use** — lazily on the first
transcription **and** via a dedicated "Pobierz model wyrównania" button in the
model manager (mirroring the transcription-model download UX) — into a writable
per-user cache (`app_cache_dir()/align_models`), then reused **offline** on every
subsequent run.

The key architectural decision: **the engine owns the per-language offline /
download decision**, not the Rust layer. The engine knows whisperx's
language→repo mapping and has a real `model_cache_only` (`local_files_only`)
parameter, so it loads offline when the model for *that language* is cached and
downloads (network) when it isn't. Rust stops force-setting `HF_HUB_OFFLINE` on
the transcribe/align spawns so the first download can proceed.

## Current State Analysis

The Rust foundation is **already half-built (uncommitted in `engine.rs`)**:

- `align_model_dir()` (`engine.rs:53`) now returns a **writable**
  `app_cache_dir()/align_models` and `create_dir_all`s it (was: the read-only
  bundled `Resource` dir).
- `align_model_present()` (`engine.rs:67`) was added — a recursive `*.safetensors`
  glob (>1 KB) to detect a downloaded model. **Language-agnostic.**

What still blocks the first-run download / makes it incomplete:

- **Offline gating is unconditional** and will block the first download:
  `run_engine` (`engine.rs:131`), the non-diarize transcribe path
  (`whisper.rs:575`), and the align-only path (`whisper.rs:806`) all force
  `HF_HUB_OFFLINE=1`/`TRANSFORMERS_OFFLINE=1` via `with_hf_offline`. With no model
  present there is no way to download.
- **The engine never downloads into the passed dir.** `_align`
  (`whisperx_engine.py:283`) passes `model_dir` to `load_align_model` only when
  the dir is **non-empty** (`os.listdir`); an empty cache silently falls back to a
  `model_dir`-less load → HF default cache, no progress, and (under forced offline)
  fails outright. There is no download-with-progress and no `PROGRESS phase=download`.
- **Packaging still ships the model:** `tauri.conf.json:40` bundles
  `binaries/align_models` via `bundle.resources`, and `build.sh` stages it (the
  "Stage alignment model(s)" block) then copies it beside the binary (the "Ship
  alignment model BESIDE the binary" block).

### Key Discoveries:

- **`whisperx.load_align_model(language_code, device, model_name, model_dir, model_cache_only)`**
  (`whisperx/alignment.py:80`) has two backends:
  - **HF backend** (Polish `pl` → `jonatasgrosman/wav2vec2-large-xlsr-53-polish`,
    in `DEFAULT_ALIGN_MODELS_HF`): `Wav2Vec2Processor/ForCTC.from_pretrained(model_name, cache_dir=model_dir, local_files_only=model_cache_only)`
    (`alignment.py:101-102`). So `model_dir` is the **HF cache dir** → standard
    `models--org--repo/snapshots/<sha>/…` layout with `*.safetensors`. This is why
    `align_model_present`'s safetensors glob works, and why offline reuse is just
    `model_cache_only=True`.
  - **torchaudio backend** (English `en` → `WAV2VEC2_ASR_BASE_960H`, in
    `DEFAULT_ALIGN_MODELS_TORCH`): `bundle.get_model(dl_kwargs={"model_dir": model_dir})`
    (`alignment.py:96`) → a `.pt` file, **not** safetensors, **not** HF layout. So a
    language-agnostic safetensors glob can never detect a torchaudio model. (Polish
    is the shipping scope; torchaudio languages are a documented limitation.)
- **Progress rendering is free.** `drive_engine` (`whisper.rs:329`) parses
  `PROGRESS phase=… percent=…` from engine stderr and emits `transcribe-progress`;
  the frontend just renders `{label, percent}` (`transcribe.js:732`). Adding a
  `"download"` arm to `map_progress` (`whisper.rs:58`) + emitting the line from
  Python is all the lazy-path UI needs.
- **The model-manager download UX is a clean template.** `download_model`
  (`models.rs:download_model`) streams files emitting `model-download-progress`
  (`percent`/`bytesPerSec`/`etaSec`/`downloaded`/`total`); the frontend
  `downloadModel()` (`transcribe.js:397`) renders `N% · MB/s · ETA` into
  `#modelDlProgress`. The proactive align download mirrors this with its own
  `align-download-progress` event.
- **Cold-spawn cost is preserved.** Forcing offline saved ~50 s of HF etag checks
  per spawn ([[whisperx-cold-spawn-cost]]). Passing `model_cache_only=True` to
  `from_pretrained` at the call site gives the **same** no-network benefit
  deterministically and per-language — so dropping the blanket Rust offline env
  does not regress the cold path.
- **The selftest already reports presence honestly.** `_selftest_align_runs`
  (`whisperx_engine.py:174`) checks `os.listdir(model_dir)` then runs a tiny real
  align under forced offline → returns `False` on a fresh install (no download
  attempted). The badge already keys on `alignment_model_ready` (`transcribe.js:223`).

## Desired End State

- `npm run tauri build` produces a macOS DMG of **~400 MB** with **no**
  `align_models/` inside the bundle.
- On a fresh install, the first transcription (or pressing "Pobierz model
  wyrównania") downloads the Polish model once into `app_cache_dir()/align_models`
  with a Polish progress bar; the second transcription runs fully offline with no
  re-download and identical word-level alignment + EDL/XML/Lua export.
- If the first run has no network, the user sees a **specific** Polish message
  ("pierwsze uruchomienie wymaga internetu, aby pobrać model wyrównania…"), not a
  generic alignment-failure.
- Picking a different language downloads that language's model on demand without
  being blocked by a cached Polish model (per-language gating).

Verify: build size + bundle contents; fresh-install download; offline re-run; an
align + export round-trip; `node --experimental-vm-modules test/regression.js`
green before/after; `~/.cargo/bin/cargo check` clean.

## What We're NOT Doing

- **No Windows / multi-platform build** in this change (S-24 owns that). The
  un-bundling makes the model platform-agnostic, which *helps* S-24, but we only
  ship/verify macOS arm64 here.
- **No SHA-256 verification** of the align-model download (the transcription-model
  path verifies the LFS `model.bin`; the HF `snapshot_download` for the align model
  relies on HF's own integrity + the `from_pretrained(local_files_only=True)` load
  succeeding as the readiness gate).
- **No change to the cohere engine path** beyond the shared `_align`/
  `_ensure_align_model` it already calls (it reuses the same wav2vec2 alignment).
- **No parser / exporter / frame-math / selection changes.** The regression suite
  stays green by construction.
- **No torchaudio-language presence accuracy** in the UI card (the card reflects
  the Polish/HF safetensors case; non-HF languages are a documented limitation).

## Implementation Approach

Engine first (so the download path exists), then Rust (gating + commands), then
the frontend affordance, then packaging last (so removing the bundled model never
leaves dev/builds without a working alignment path mid-change).

A single engine helper, `_ensure_align_model(language, model_dir, allow_download)`,
is the one place that decides offline-load-vs-download. It is called by `_align`
(lazy, `allow_download=True`) and by the new `--fetch-align-model` mode (proactive,
`allow_download=True`); the selftest path stays `allow_download=False` (report
only). On download failure it exits `EXIT_ALIGN_MODEL_DOWNLOAD_FAIL=15`.

## Critical Implementation Details

- **Ordering / lifecycle.** In `cmd_transcribe` the download happens at the *start
  of the align stage* (after transcribe 0–100 → bar 5..70). The `"download"`
  progress arm must therefore park the overall bar around the align-start point
  (~70) while the **label** carries the live download percent — the bar must never
  jump backward.
- **Offline determinism (BOTH loads).** The blanket Rust `HF_HUB_OFFLINE` forced
  the **whole** spawn offline — it covered two HF-gated loads, not one:
  `whisperx.load_align_model` **and** `whisperx.load_model` (`asr.py:315`, which
  threads `local_files_only` → `WhisperModel` at `asr.py:362`, default `False`).
  Removing the blanket env therefore requires restoring offline determinism on
  **both** or the cold path regresses on *every* transcription, not just the first
  ([[whisperx-cold-spawn-cost]]). So: pass `model_cache_only=True` to
  `load_align_model` on every non-downloading load **and** pass
  `local_files_only=True` to `whisperx.load_model` in `cmd_transcribe` (the
  transcription model dir is always local — `EXIT_MODEL_NOT_FOUND` already guards
  absence, so this cannot wrongly block a needed fetch). Only the explicit align
  download call runs with network allowed. (VAD load is torch-hub/local, not HF —
  unaffected.)
- **safetensors-only download.** Use `huggingface_hub.snapshot_download(repo_id,
  cache_dir=model_dir, allow_patterns=[…])` excluding `pytorch_model.bin` so only
  the safetensors weights + configs/tokenizer are pulled (the redundant `.bin` is
  what doubled the footprint). The frozen sidecar must be able to import
  `huggingface_hub.snapshot_download` — add it to the spec `hiddenimports`.
- **Progress aggregation guard.** Aggregate the download percent against the
  dominant (>50 MB) weight file only, so the small config/tokenizer files don't
  spam the bar to 100% early.

---

## Phase 1: Engine — download-on-demand + per-language gating

### Overview

Give the engine a single `_ensure_align_model` helper that loads the per-language
alignment model offline when cached and downloads it (with progress) when not, a
`--fetch-align-model` mode for the proactive button, a distinct exit code for a
failed download, and the PyInstaller hiddenimport for `snapshot_download`.

### Changes Required:

#### 1. Ensure-align-model helper + `_align` rewrite

**File**: `sidecar/whisperx_engine/whisperx_engine.py`

**Intent**: Centralize the load-or-download decision so both the lazy transcribe
path and the proactive fetch mode share one implementation, and so offline reuse
is deterministic per language.

**Contract**: New `_ensure_align_model(whisperx, language, model_dir, allow_download) -> (align_model, metadata)`:
- First attempt `whisperx.load_align_model(language_code=language, device="cpu"or device, model_dir=model_dir, model_cache_only=True)`. On success → cached, return.
- On failure (not cached): if `not allow_download` → re-raise / signal not-ready.
  If `allow_download` → emit `PROGRESS phase=download percent=0`; for an HF-backed
  language resolve the repo id from `whisperx.alignment.DEFAULT_ALIGN_MODELS_HF`
  and `snapshot_download(repo_id, cache_dir=model_dir, allow_patterns=["*.safetensors","*.json","*.txt","vocab*","tokenizer*","preprocessor*"], tqdm_class=ProgressTqdm)`
  (no `pytorch_model.bin`). **`ProgressTqdm`** is a small subclass of
  `huggingface_hub.utils.tqdm` defined in this module: its `update()` ignores any
  bar whose `total` is < 50 MB (the config/tokenizer files — the aggregation
  guard) and, for the dominant weight bar, writes
  `PROGRESS phase=download percent=<int(self.n*100/self.total)>` to **stderr**
  (same channel `drive_engine` already parses). This is the one network-allowed
  call. For a
  torchaudio-backed language fall back to a plain
  `load_align_model(model_cache_only=False)` download. Then load
  `model_cache_only=True` and return. On any download error → `sys.exit(EXIT_ALIGN_MODEL_DOWNLOAD_FAIL)`.
- `_align` (`whisperx_engine.py:277`) replaces its inline `load_align_model`
  block (lines 281–285) with `_ensure_align_model(whisperx, language, _alignment_model_dir(language)`-or-the-override`, allow_download=True)`. Keep the existing
  `_emit_progress("align", …)` + `whisperx.align(...)` flow unchanged.

#### 1b. Keep the transcription `load_model` offline-deterministic

**File**: `sidecar/whisperx_engine/whisperx_engine.py`

**Intent**: The blanket Rust `HF_HUB_OFFLINE` (dropped in Phase 2) also covered
`whisperx.load_model`, not just the align load. Restore that load's no-network
cold-path behavior so removing the env doesn't re-add etag latency on every run.

**Contract**: In `cmd_transcribe` (`whisperx_engine.py:381`), add
`local_files_only=True` to the `load_model` `load_kwargs` (the transcription model
dir is always local; `EXIT_MODEL_NOT_FOUND` already handles an absent model, so
this never blocks a legitimate fetch). The cohere path (`cmd_transcribe_cohere`)
gets the same treatment if it loads a whisperx model. This is the load_model half
of the **Offline determinism (BOTH loads)** rule above — without it the cold path
regresses ([[whisperx-cold-spawn-cost]]).

#### 2. `EXIT_ALIGN_MODEL_DOWNLOAD_FAIL` exit code

**File**: `sidecar/whisperx_engine/whisperx_engine.py`

**Intent**: Distinguish "couldn't download the model on first run" from a generic
alignment failure so Rust can show the offline-retry message.

**Contract**: Add `EXIT_ALIGN_MODEL_DOWNLOAD_FAIL = 15` to the exit-code block
(`whisperx_engine.py:51-59`); keep the in-file comment "kept in sync with
src-tauri/src/whisper.rs error mapping".

#### 3. `--fetch-align-model` mode

**File**: `sidecar/whisperx_engine/whisperx_engine.py`

**Intent**: A non-transcribing entry point the proactive Rust command drives to
pre-download a language's model with progress.

**Contract**: New `--fetch-align-model` flag (`build_parser`, ~line 667) +
`cmd_fetch_align_model(args)` that imports whisperx, resolves the model dir from
`--align-model-dir`/`--language` (default `pl`), calls
`_ensure_align_model(..., allow_download=True)`, and exits `EXIT_OK` (or 15 on
failure). Wire it in `main()` (`whisperx_engine.py:691-706`) before the transcribe
branch. It must NOT require `--audio`/`--model`. Reuses the `_emit_progress`/
download-progress emission.

#### 4. Keep selftest/capability report-only

**File**: `sidecar/whisperx_engine/whisperx_engine.py`

**Intent**: Verification must never trigger a 1.2 GB download.

**Contract**: `_selftest_align_runs` (line 174) stays as-is (file-presence check +
real align under forced offline → `False` when absent). No `allow_download` there.

#### 5. PyInstaller hiddenimport for snapshot_download

**File**: `sidecar/whisperx_engine.spec`

**Intent**: The frozen sidecar now calls `huggingface_hub.snapshot_download` at
runtime; PyInstaller's static analysis won't pull it from the lazy import.

**Contract**: Add `"huggingface_hub"` to the `collect_submodules` loop
(`whisperx_engine.spec:91-109`). `copy_metadata("huggingface_hub")` already exists
(line 67) and stays.

### Success Criteria:

#### Automated Verification:

- Python syntax/import sanity: `python -m py_compile sidecar/whisperx_engine/whisperx_engine.py`
- (After a sidecar rebuild) frozen selftest still runs: `"$PWD/src-tauri/binaries/whisperx-engine-aarch64-apple-darwin" --selftest` returns valid JSON with `ok:true`

#### Manual Verification:

- With an empty cache dir, `whisperx-engine … --fetch-align-model --language pl --align-model-dir <tmp>` downloads only safetensors (no `pytorch_model.bin`) and emits `PROGRESS phase=download percent=…` lines, exiting 0; the dir then holds `models--jonatasgrosman--wav2vec2-large-xlsr-53-polish/…/*.safetensors`
- Re-running `--fetch-align-model` against the populated dir is a no-op (no re-download)
- With an empty cache **and no network**, the fetch mode exits with code 15

**Implementation Note**: After completing this phase and all automated verification
passes, pause for manual confirmation before proceeding.

---

## Phase 2: Rust — gating, progress band, proactive command, error mapping

### Overview

Stop forcing HF offline on the spawns that may need to download, surface the
download phase on the transcribe bar, add the proactive `download_align_model` +
`align_model_status` commands, and map exit 15 to a clear Polish message.

### Changes Required:

#### 1. Drop forced offline on the download-capable paths

**File**: `src-tauri/src/whisper.rs`

**Intent**: Allow the engine to reach HF on first run; rely on the engine's
per-call `model_cache_only=True` for the offline cold-path benefit afterward.

**Contract**: In `transcribe_video` (`whisper.rs:571-576`) remove the
`with_hf_offline(sidecar)` wrap on the **non-diarize** branch (keep the diarize
branch's `HF_TOKEN` env). In `align_transcript` (`whisper.rs:806`) remove the
`with_hf_offline(...)` wrap. Both keep passing `--align-model-dir`. Leave
`run_engine`/selftest/capability (`engine.rs:131`) **with** `with_hf_offline`
(report-only, must not download). Update the now-stale "force HF offline" comments.

#### 2. `download` arm in `map_progress`

**File**: `src-tauri/src/whisper.rs`

**Intent**: Render the one-time lazy download on the existing transcribe bar.

**Contract**: Add to `map_progress` (`whisper.rs:58`):
`"download" => (format!("Pobieranie modelu wyrównania (jednorazowo)… {}%", p as u32), 70.0)` —
label carries the live percent; overall bar parks at the align-start point so it
never moves backward.

#### 3. `download_align_model` command + driver

**File**: `src-tauri/src/whisper.rs` (or a small addition to `engine.rs`)

**Intent**: Drive the engine's `--fetch-align-model` mode for the proactive button,
relaying progress to the model-manager UI in the same shape as model downloads.

**Contract**: New `#[tauri::command] async fn download_align_model(app, language: Option<String>) -> Result<(), String>`:
resolve `align_model_dir`, spawn the sidecar with `--fetch-align-model --language <lang|pl> --align-model-dir <dir>` **without** `with_hf_offline`, drive its stderr
parsing `PROGRESS phase=download percent=…`, and `app.emit("align-download-progress", { language, percent })`. The engine emits **percent only** (no byte counts), so do **not** fabricate `bytesPerSec` in Rust — the frontend derives MB/s and ETA from `percent` against the known `ALIGN_MODEL.sizeBytes` descriptor (see Phase 3 §2). On exit 15 return the Polish offline message; on other non-zero return `engine_error_message`.

#### 4. `align_model_status` command

**File**: `src-tauri/src/engine.rs`

**Intent**: Let the frontend card show Pobrany/Brak + size without spawning.

**Contract**: New `#[tauri::command] async fn align_model_status(app) -> Result<serde_json::Value, String>`
returning `{ downloaded: align_model_present(&app), size_bytes: <dir size or 0> }`.
(Polish/HF-safetensors oriented per the documented limitation.)

#### 5. Map exit 15 + register commands

**File**: `src-tauri/src/whisper.rs`, `src-tauri/src/lib.rs`

**Intent**: User-facing offline message + make the new commands invokable.

**Contract**: Add `Some(15) => "Pierwsze uruchomienie wymaga połączenia z internetem, aby pobrać model wyrównania (~1,2 GB). Połącz się z siecią i spróbuj ponownie.".to_string(),`
to `engine_error_message` (`whisper.rs:182`). Register `download_align_model` and
`align_model_status` in the `invoke_handler` in `lib.rs`.

### Success Criteria:

#### Automated Verification:

- Rust type-check: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- With an empty cache, `invoke('download_align_model', { language: 'pl' })` emits `align-download-progress` and lands the model in `app_cache_dir()/align_models`
- A first transcription on an empty cache shows "Pobieranie modelu wyrównania (jednorazowo)… N%" on the progress bar, then completes alignment
- A first transcription **offline** surfaces the exit-15 Polish message (not the generic alignment error)
- A second transcription performs no re-download (offline, fast cold path)

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: Frontend — align-model card + progress + badge wording

### Overview

Add a dedicated alignment-model entry to the model manager with size, status, a
"Pobierz" button, and a progress line mirroring the transcription-model download;
soften the readiness badge when the align model isn't downloaded yet.

### Changes Required:

#### 1. Align-model registry entry

**File**: `src/transcription/model-registry.js`

**Intent**: A single source for the card's label + approximate size (no `files[]` —
the engine, not Rust streaming, performs this download).

**Contract**: Export an `ALIGN_MODEL` descriptor (e.g. `{ language: 'pl', label: 'Model wyrównania (polski, ~1,2 GB)', sizeBytes: 1_200_000_000 }`). Keep `formatBytes` reuse.

#### 2. Align-model card in the model manager

**File**: `src/ui/import/transcribe.js`

**Intent**: Discoverable proactive download, consistent with the model dropdown.

**Contract**: In/after `renderModelManager` (`transcribe.js:300-353`) render an
align-model row: status from `invoke('align_model_status')` (Pobrany/Brak +
`formatBytes`), a "Pobierz model wyrównania" button when not downloaded, and a
hidden progress line. Add `downloadAlignModel(language)` mirroring `downloadModel`
(`transcribe.js:397-449`): `listen('align-download-progress', …)` receives
`{ language, percent }` and computes the display line **frontend-side** —
`MB/s` from the `percent` delta × `ALIGN_MODEL.sizeBytes` over wall-clock, `ETA`
from the percent rate — rendering `N% · MB/s · ETA` (the engine sends percent only;
do not expect byte fields). Then `invoke('download_align_model', { language })`,
refresh on completion,
`toast` on error. Use the in-app patterns (no `window.*` dialogs — [[lessons]]).

#### 3. Badge wording when align model absent

**File**: `src/ui/import/transcribe.js`

**Intent**: Don't imply full readiness when alignment must still be downloaded.

**Contract**: In `renderEngineBadge` (`transcribe.js:218-234`), gate the hint on
the **cheap** presence signal, not only the expensive selftest: append the Polish
download hint (e.g. "— pobierz model wyrównania") when `status.ok && authoritative
&& !alignment_model_ready && !alignModelDownloaded`, where `alignModelDownloaded`
comes from `align_model_status.downloaded` (the `align_model_present` glob — no
spawn). Otherwise the badge keeps telling the user to download a model they just
downloaded until a full re-selftest. In `downloadAlignModel`'s completion handler,
re-render the badge so the hint clears immediately after a successful download. All
strings Polish.

### Success Criteria:

#### Automated Verification:

- Prettier clean: `npx prettier --check "src/**/*.{js,css,html}"`
- Regression suite green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- Model manager shows the align-model card with size + correct Pobrany/Brak status
- Clicking "Pobierz model wyrównania" shows `N% · MB/s · ETA` progress and flips to Pobrany on completion
- The readiness badge shows the download hint on a fresh install and the normal "model dopasowania wbudowany"/ready text after download + full verify

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Packaging — un-bundle the model

### Overview

Remove the alignment model from the app bundle and from the build pipeline. Done
last so the download path is fully working before the model disappears.

### Changes Required:

#### 1. Drop the bundled resource

**File**: `src-tauri/tauri.conf.json`

**Intent**: Stop shipping the ~2.4 GB (→ ~4.7 GB dereferenced) model in the DMG.

**Contract**: Remove `"binaries/align_models"` from `bundle.resources`
(`tauri.conf.json:40`) — set `"resources": []` (or drop the key). `externalBin`
(line 39) is unchanged.

#### 2. Drop build-time staging + copy-beside

**File**: `sidecar/build.sh`

**Intent**: The build no longer pre-downloads or stages the model.

**Contract**: Remove the "Stage alignment model(s)" block (the `ALIGN_LANGS` loop)
and the "Ship alignment model BESIDE the binary" block (`rm -rf`/`cp -R
align_models`). Remove the now-unused `ALIGN_LANGS`/`ALIGN_DIR` vars. Update the
header comment to state the model is downloaded at first use. Keep the spec
freeze + binary copy steps.

#### 3. Doc-comment cleanup (no behavior)

**File**: `sidecar/whisperx_engine/whisperx_engine.py`, `src-tauri/src/engine.rs`

**Intent**: Comments still say "ships beside the sidecar / bundle.resources" — make
them describe the first-run-download cache.

**Contract**: Update the `_align_models_base`/`ALIGN_MODEL_SUBDIR` doc comments
(`whisperx_engine.py:63-85`) and any stale `engine.rs` mentions of the bundled
resource. The `ENGINE_ALIGN_DIR` override (passed `--align-model-dir`) remains the
primary resolution path; next-to-exe/`_MEIPASS` fallbacks stay as harmless legacy.

### Success Criteria:

#### Automated Verification:

- `cargo check` clean: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- `tauri.conf.json` is valid JSON (build parses it)

#### Manual Verification:

- Full rebuild: `sidecar/build.sh` then `npm run tauri build` produces a DMG of **~400 MB** with **no** `align_models/` inside `.app/Contents/Resources`
- Fresh-install run downloads the model once (progress bar), lands it in `~/Library/Caches/com.reelautomator.app/align_models/`
- A second run is fully offline (no network), produces identical word-level alignment, and EDL/XML/Lua exports verify

**Implementation Note**: This is the heavy verification gate — it requires a full
sidecar build + Tauri build + a real 1.2 GB download and an offline re-run.

---

## Testing Strategy

### Unit / automated:

- `node --experimental-vm-modules test/regression.js` (parser + EDL/XML/Lua) green
  before and after every phase — no parser/exporter/frame-math is touched, so this
  is a guardrail, not a target.
- `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml` after the Rust phase.
- `python -m py_compile` on the engine script after the Python phase.

### Manual (the real verification, only on a full rebuild):

1. `sidecar/build.sh` + `npm run tauri build`; confirm DMG ~400 MB and no
   `align_models/` in the bundle.
2. Fresh launch → first transcription → Polish download progress → model lands in
   the app cache.
3. Second transcription → no re-download, fully offline, fast cold path.
4. Word-level alignment + EDL/XML/Lua export round-trip correct.
5. Offline first run → exit-15 Polish "needs internet" message.
6. Proactive "Pobierz model wyrównania" button → `N% · MB/s · ETA`, then Pobrany.

## Performance Considerations

- The one-time download is ~1.2 GB (safetensors only; `pytorch_model.bin` skipped).
- Offline reuse via `model_cache_only=True` preserves the ~50 s etag-check saving
  that the blanket offline env previously provided ([[whisperx-cold-spawn-cost]]).
- Cold sidecar spawn remains 37–67 s (onefile extraction + torch) — unchanged; the
  download adds to the **first** run only.

## Migration Notes

- Existing dev checkouts may still have `src-tauri/binaries/align_models/` from a
  prior `build.sh`; it becomes unreferenced and harmless (no longer bundled or
  passed). It can be deleted but isn't required to be.
- Users who installed a prior bundled build keep working; on the next build the
  model simply moves to the first-run download cache.
- Both sidecars + the (now downloaded) model dir remain git-ignored — restore the
  sidecars via the S-05 build scripts ([[whisperx-sidecar-build]]).

## References

- Roadmap stream: `context/foundation/roadmap.md` → S-29
- whisperx align backends: `sidecar/.venv/.../whisperx/alignment.py:80-110`
- Transcription-model download template: `src-tauri/src/models.rs` (`download_model`),
  `src/ui/import/transcribe.js:397-449`
- Lessons: never bake multi-GB into onefile; ship beside / download
  ([[whisperx-sidecar-build]], [[whisperx-cold-spawn-cost]])

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Engine — download-on-demand + per-language gating

#### Automated

- [x] 1.1 Python syntax/import sanity (`py_compile`) — 3672449
- [x] 1.2 Frozen selftest returns valid `ok:true` JSON (after rebuild) — 3672449

#### Manual

- [x] 1.3 `--fetch-align-model` downloads the model, emits progress, exits 0; HF layout present — 3672449
- [x] 1.4 Re-run `--fetch-align-model` on a populated dir is a no-op — 3672449
- [x] 1.5 Empty cache + no network → exit code 15 — 3672449

### Phase 2: Rust — gating, progress band, proactive command, error mapping

#### Automated

- [x] 2.1 `cargo check` clean — c9cfcd4
- [x] 2.2 Regression suite green — c9cfcd4

#### Manual

- [x] 2.3 `download_align_model` emits `align-download-progress`, lands the model — c9cfcd4
- [x] 2.4 First transcription on empty cache shows the download band then aligns — c9cfcd4
- [x] 2.5 First transcription offline → exit-15 Polish message — c9cfcd4
- [x] 2.6 Second transcription performs no re-download (offline) — c9cfcd4

### Phase 3: Frontend — align-model card + progress + badge wording

#### Automated

- [x] 3.1 Prettier clean — f286223
- [x] 3.2 Regression suite green — f286223

#### Manual

- [x] 3.3 Align-model card shows size + correct Pobrany/Brak — e1e43cd
- [x] 3.4 "Pobierz model wyrównania" shows `N% · MB/s · ETA`, flips to Pobrany — e1e43cd
- [x] 3.5 Badge shows download hint on fresh install, ready text after download — e1e43cd

### Phase 4: Packaging — un-bundle the model

#### Automated

- [x] 4.1 `cargo check` clean — 31ab4f7
- [x] 4.2 `tauri.conf.json` valid JSON — 31ab4f7

#### Manual

- [x] 4.3 Full rebuild → DMG ~400 MB, no `align_models/` in bundle — 31ab4f7
- [x] 4.4 Fresh-install run downloads model once into the app cache — 2cb98d2
- [x] 4.5 Second run fully offline, identical alignment + exports verify — 2cb98d2
