# WhisperX engine sidecar

A frozen Python CLI wrapping [`whisperx`](https://github.com/m-bain/whisperX) that
the Rust backend drives as a Tauri `externalBin` sidecar — the "no separate
install" transcription + word-level forced-alignment engine for Reels EDL
Automator. It replaces the PATH-dependent `whisper-cli` (whisper.cpp) path.

## Layout

| Path | Purpose |
|---|---|
| `whisperx_engine/whisperx_engine.py` | The CLI entry script (the contract). |
| `whisperx_engine/requirements.txt` | Build-time Python deps. |
| `whisperx_engine/align_models/<lang>/` | Staged wav2vec2 alignment model(s) (downloaded by `build.sh`, git-ignored). Copied **beside** the binary — NOT baked into it. |
| `whisperx_engine.spec` | PyInstaller spec (single-file freeze). |
| `build.sh` | OS-aware build → `src-tauri/binaries/whisperx-engine-<triple>[-gpu]`. |

## CLI contract (stable — parsed by `src-tauri/src/whisper.rs`)

```
whisperx-engine --audio A.wav --model large-v3 --language pl [--diarize --hf-token T] [--align-model-dir DIR] [ADVANCED]
whisperx-engine --align-only --audio A.wav --transcript T.srt --language pl [--align-model-dir DIR] [--device cpu]
whisperx-engine --selftest        # readiness probe (no transcription model needed)
```

### Advanced tuning flags (Phase 7 — all optional)

Surfaced by the in-app "Ustawienia zaawansowane WhisperX" modal. **Every flag is
optional and omitting it keeps whisperx's own default** — so an untouched modal
reproduces the engine's prior behavior (no regression). Each maps to a real,
version-verified whisperx/faster-whisper option:

| Flag | Effect | Applied via |
|---|---|---|
| `--device cpu` | Force CPU (skip GPU/Metal; also affects the torch align stage) | `load_model(device=…)` |
| `--compute-type T` | CT2 precision: `float16` / `int8` / `int8_float16` / `float32` | `load_model(compute_type=…)` |
| `--beam-size N` | Decoding beam size (default 5) | `asr_options` |
| `--initial-prompt S` | Decoding initial prompt | `asr_options` |
| `--vad-onset F` | VAD onset threshold (default 0.5) | `vad_options` |
| `--vad-offset F` | VAD offset threshold (default 0.363) | `vad_options` |
| `--min-speakers N` / `--max-speakers N` | Diarization speaker bounds (only with `--diarize`) | `DiarizationPipeline(...)` |

`--device` is the only advanced flag honored by `--align-only` (it drives the
torch wav2vec2 align stage); `--compute-type`/`--beam-size`/VAD are
transcription-only and have no effect there.

> **Hidden quality defaults:** the long tail of faster-whisper knobs
> (`best_of`, `patience`, temperature fallback, `condition_on_previous_text`,
> `no_speech_threshold`, `log_prob_threshold`, `compression_ratio_threshold`,
> `suppress_numerals`, …) is **not** surfaced in the modal. The engine currently
> inherits whisperx's own defaults for them (so the untouched-modal/no-regression
> guarantee holds); they can be promoted to pinned tuned values or to the modal
> later without a contract break (adding a flag is additive). Unknown
> `asr_options`/`vad_options` keys are rejected loudly (the engine exits
> `14` transcribe-fail rather than silently ignoring a dead control).

> **Contract bump:** adding these flags changes the engine CLI surface. After
> editing `whisperx_engine.py`, **rebuild the sidecar (CPU + GPU + Windows)** and
> re-run `--selftest` before shipping — see *Build / regenerate* below.

- `--align-model-dir DIR` points at the alignment-model directory (`DIR/<lang>/`).
  The Rust layer passes the bundled-resource path here. When omitted, the engine
  auto-resolves: env `ENGINE_ALIGN_DIR` → next to the executable
  (`<exe-dir>/align_models`) → legacy `_MEIPASS` → next to the script.

> **Why the model is not baked into the binary:** PyInstaller can embed the
> ~2.4 GB alignment model as `datas`, but the resulting multi-GB onefile Mach-O
> **fails to load on macOS** (`dyld: syscall to map cache into shared region
> failed`, aborts before `main`). So `build.sh` keeps the executable small
> (~280 MB) and copies `align_models/` **beside** it; Tauri ships that dir via
> `bundle.resources` and the Rust layer passes `--align-model-dir`.

- **stdout** (success): one JSON document
  `{ "language": str, "segments": [ { "start", "end", "text", "words": [ { "text","start","end","score","speaker" } ] } ] }`
- **stderr**: greppable progress lines `PROGRESS phase=<transcribe|align|diarize> percent=<0-100>` plus human logs.
- **exit codes**: `0` ok · `10` model-not-found · `11` audio-decode-fail · `12` align-fail · `13` diarize-fail · `14` transcribe-fail · `1` internal · `2` usage. The Rust layer maps each to a specific Polish message.
- `--selftest` prints `{ ok, version, gpu, device, alignment_model_ready }` and must work **before** any transcription model is downloaded.

## Prerequisites

- Python 3.10 or 3.11, `pip`, `python3-venv`.
- Internet for the first build (pulls torch/whisperx wheels + the alignment model).
- macOS GPU (Metal) variant: an Apple-silicon Mac. CUDA variant: an NVIDIA box with CUDA 12.x.

## Build / regenerate

```bash
# macOS CPU variant (host triple)
sidecar/build.sh

# macOS Metal / CUDA variant (adds the -gpu suffix)
GPU=1 sidecar/build.sh

# bundle extra alignment languages (default: pl)
ALIGN_LANGS="pl en" sidecar/build.sh
```

Outputs land in `src-tauri/binaries/` with the Tauri arch-suffix naming used by
the FFmpeg sidecar, e.g.:

- `whisperx-engine-aarch64-apple-darwin` (macOS CPU)
- `whisperx-engine-aarch64-apple-darwin-gpu` (macOS Metal)
- `whisperx-engine-x86_64-pc-windows-msvc.exe` (Windows)

`tauri.conf.json → bundle.externalBin` references the base name
`binaries/whisperx-engine`; Tauri resolves the arch-suffixed file per platform.
`build.sh` also writes `src-tauri/binaries/align_models/` (the model, copied
beside the binary), shipped via `tauri.conf.json → bundle.resources`.

## Verify a build

```bash
src-tauri/binaries/whisperx-engine-aarch64-apple-darwin --selftest
# → {"ok": true, "version": "...", "gpu": true, "device": "mps", "alignment_model_ready": true}
```

> The frozen binary (~280 MB) and `align_models/` (~2.4 GB) are large and are
> **not** committed — they are produced by `build.sh` on each packaging machine
> and covered by `.gitignore` (`src-tauri/binaries/whisperx-engine-*`,
> `src-tauri/binaries/align_models/`).
