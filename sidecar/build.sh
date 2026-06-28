#!/usr/bin/env bash
#
# OS-aware build of the WhisperX engine sidecar.
#
# Detects host OS/arch, installs the matching platform deps (torch CPU vs
# CUDA/Metal, CTranslate2 build), stages the per-language wav2vec2 alignment
# model, then freezes whisperx_engine.py with PyInstaller into a single
# standalone executable named with the Tauri arch-suffix convention (matching
# the FFmpeg sidecar) and copies it into src-tauri/binaries/.
#
# Usage:
#   sidecar/build.sh                # build CPU variant for the host triple
#   GPU=1 sidecar/build.sh          # build GPU/Metal variant (suffix -gpu)
#   ALIGN_LANGS="pl en" sidecar/build.sh   # which alignment models to bundle
#
# Targets produced (per the plan):
#   src-tauri/binaries/whisperx-engine-aarch64-apple-darwin            (macOS CPU)
#   src-tauri/binaries/whisperx-engine-gpu-aarch64-apple-darwin        (macOS Metal)
#   src-tauri/binaries/whisperx-engine-x86_64-pc-windows-msvc.exe      (Windows CPU)
#   src-tauri/binaries/whisperx-engine-gpu-x86_64-pc-windows-msvc.exe  (Windows CUDA)
#
# Prerequisites: Python 3.10/3.11, pip, internet (first build pulls wheels +
# the alignment model). See sidecar/README.md.

set -euo pipefail

SIDECAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SIDECAR_DIR/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
ENGINE_PKG="$SIDECAR_DIR/whisperx_engine"
ALIGN_DIR="$ENGINE_PKG/align_models"
ALIGN_LANGS="${ALIGN_LANGS:-pl}"
GPU="${GPU:-0}"

mkdir -p "$BIN_DIR"

# ── Detect target triple (Tauri/rustc convention) ──────────────────────────
uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s" in
  Darwin)
    case "$uname_m" in
      arm64|aarch64) TRIPLE="aarch64-apple-darwin" ;;
      x86_64)        TRIPLE="x86_64-apple-darwin" ;;
      *) echo "unsupported macOS arch: $uname_m" >&2; exit 1 ;;
    esac
    EXE_EXT="" ;;
  MINGW*|MSYS*|CYGWIN*|Windows_NT)
    TRIPLE="x86_64-pc-windows-msvc"; EXE_EXT=".exe" ;;
  Linux)
    TRIPLE="x86_64-unknown-linux-gnu"; EXE_EXT="" ;;
  *) echo "unsupported OS: $uname_s" >&2; exit 1 ;;
esac

# Naming: the GPU variant's `-gpu` goes BEFORE the triple so the base name is
# `whisperx-engine-gpu`. Tauri's externalBin/sidecar resolver appends the host
# triple to a base name, so only `whisperx-engine-gpu-<triple>` (not
# `whisperx-engine-<triple>-gpu`) is resolvable as its own sidecar.
BASE_NAME="whisperx-engine"
[ "$GPU" = "1" ] && BASE_NAME="whisperx-engine-gpu"
OUT_NAME="${BASE_NAME}-${TRIPLE}"
echo "==> Building $OUT_NAME (GPU=$GPU, align langs: $ALIGN_LANGS)"

# ── Python venv ─────────────────────────────────────────────────────────────
# CPU and GPU torch builds cannot co-exist in one venv (same package, different
# +cpu/+cuXXX local version), so the GPU build gets its own venv.
VENV="$SIDECAR_DIR/.venv"
[ "$GPU" = "1" ] && VENV="$SIDECAR_DIR/.venv-gpu"
if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate" 2>/dev/null || source "$VENV/Scripts/activate"
python -m pip install --upgrade pip wheel >/dev/null

# ── Dependency install ──────────────────────────────────────────────────────
# Every platform installs the Phase-0-certified locked stack with --no-deps:
# whisperx 3.8.6 declares `huggingface-hub<1.0.0` but transformers 5.x needs
# `>=1.5.0`, so the gate-validated combo is NOT pip cross-resolvable on ANY
# platform (a plain `pip install -r requirements.txt` hits ResolutionImpossible —
# confirmed on Windows). The lock pins every package at the runtime-proven
# versions; --no-deps tolerates whisperx's stale cap.
#
# torch is platform-specific, so on non-macOS we install the torch trio FIRST
# from the correct wheel index (CPU or CUDA) at the EXACT versions pinned in the
# lock; the lock's `torch==2.8.0` etc. then resolve as already-satisfied by the
# local +cpu/+cuXXX build (PEP 440: `==2.8.0` permits `2.8.0+cpu`). macOS skips
# this and takes torch (the MPS wheel) straight from the lock.
#
# NOTE (torchcodec): the lock includes torchcodec==0.7.0, whose native libs need
# *shared* FFmpeg libraries to decode. Our bundled ffmpeg is a static .exe (no
# DLLs), so torchcodec fails to load — but it is only used by pyannote (opt-in
# diarization) and degrades gracefully (in-memory waveform fallback). Core
# transcription + forced alignment use whisperx.load_audio (ffmpeg subprocess),
# not torchcodec, so the CPU/GPU --selftest and the main path are unaffected.
TORCH_TRIO="torch==2.8.0 torchvision==0.23.0 torchaudio==2.8.0"  # MUST match requirements.lock.txt
LOCK="$ENGINE_PKG/requirements.lock.txt"
if [ -f "$LOCK" ]; then
  if [ "$uname_s" != "Darwin" ]; then
    if [ "$GPU" = "1" ]; then
      # CUDA build (Linux/Windows). cu128 carries Blackwell sm_120 kernels (RTX 50xx);
      # cu121 has none and fails at runtime with "no kernel image available".
      TORCH_INDEX="https://download.pytorch.org/whl/${CUDA:-cu128}"
    else
      TORCH_INDEX="https://download.pytorch.org/whl/cpu"
    fi
    echo "==> Installing torch trio from $TORCH_INDEX ($TORCH_TRIO)"
    python -m pip install --index-url "$TORCH_INDEX" $TORCH_TRIO
  fi
  echo "==> Installing locked sidecar stack (--no-deps) from requirements.lock.txt"
  python -m pip install --no-deps -r "$LOCK"
  # PyInstaller's Windows bootloader build needs pefile + pywin32-ctypes. These are
  # win32-only deps NOT in the macOS lock, and --no-deps skipped pyinstaller's own
  # deps, so install them explicitly when freezing on Windows.
  if [ "$EXE_EXT" = ".exe" ]; then
    echo "==> Installing Windows PyInstaller deps (pefile, pywin32-ctypes)"
    python -m pip install "pefile>=2022.5.30" pywin32-ctypes
  fi
else
  # No lock present — best-effort resolution (will likely fail the whisperx/
  # transformers cross-resolve; keep a lock checked in to avoid this path).
  if [ "$uname_s" = "Darwin" ]; then
    python -m pip install torch torchaudio
  elif [ "$GPU" = "1" ]; then
    python -m pip install torch torchaudio --index-url "https://download.pytorch.org/whl/${CUDA:-cu128}"
  else
    python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
  fi
  python -m pip install -r "$ENGINE_PKG/requirements.txt"
fi

# ── Stage alignment model(s) ────────────────────────────────────────────────
# Pre-download the per-language wav2vec2 alignment model into align_models/<lang>.
# NOT baked into the binary (a multi-GB onefile Mach-O won't load on macOS) — it
# is copied BESIDE the sidecar below for offline-ready forced alignment.
mkdir -p "$ALIGN_DIR"
for lang in $ALIGN_LANGS; do
  echo "==> Staging alignment model for '$lang'"
  ENGINE_ALIGN_OUT="$ALIGN_DIR/$lang" python - "$lang" <<'PY'
import os, sys
import whisperx
lang = sys.argv[1]
out = os.environ["ENGINE_ALIGN_OUT"]
os.makedirs(out, exist_ok=True)
# Downloads to the HF cache and (when supported) into model_dir.
try:
    whisperx.load_align_model(language_code=lang, device="cpu", model_dir=out)
except TypeError:
    # Older whisperx without model_dir kwarg — fall back to HF cache; the spec
    # also collects whisperx data files so alignment still resolves at runtime.
    whisperx.load_align_model(language_code=lang, device="cpu")
print("staged", lang)
PY
done

# ── Freeze ──────────────────────────────────────────────────────────────────
echo "==> Freezing with PyInstaller"
( cd "$SIDECAR_DIR" && ENGINE_OUT_NAME="$OUT_NAME" python -m PyInstaller \
    --noconfirm --clean --distpath "$SIDECAR_DIR/dist" --workpath "$SIDECAR_DIR/build" \
    whisperx_engine.spec )

FROZEN="$SIDECAR_DIR/dist/$OUT_NAME$EXE_EXT"
if [ ! -f "$FROZEN" ]; then
  echo "build failed: $FROZEN not produced" >&2
  exit 1
fi
cp "$FROZEN" "$BIN_DIR/$OUT_NAME$EXE_EXT"
chmod +x "$BIN_DIR/$OUT_NAME$EXE_EXT" 2>/dev/null || true

# ── Ship alignment model BESIDE the binary (not baked in) ───────────────────
# Tauri bundles src-tauri/binaries/align_models via bundle.resources; the Rust
# layer passes its resolved path to the engine with --align-model-dir. The
# engine also finds it next-to-exe for a local `--selftest`.
if [ -d "$ALIGN_DIR" ]; then
  echo "==> Copying alignment model(s) beside the binary: $BIN_DIR/align_models"
  rm -rf "$BIN_DIR/align_models"
  cp -R "$ALIGN_DIR" "$BIN_DIR/align_models"
fi

echo "==> Done: $BIN_DIR/$OUT_NAME$EXE_EXT"
echo "    Self-test it with: \"$BIN_DIR/$OUT_NAME$EXE_EXT\" --selftest"
