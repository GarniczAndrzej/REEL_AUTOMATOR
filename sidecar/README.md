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
whisperx-engine --audio A.wav --model large-v3 --language pl [--diarize --hf-token T] [--align-model-dir DIR]
whisperx-engine --align-only --audio A.wav --transcript T.srt --language pl [--align-model-dir DIR]
whisperx-engine --selftest        # readiness probe (no transcription model needed)
```

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
