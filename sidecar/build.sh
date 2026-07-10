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
#   sidecar/build.sh                       # build CPU variant for the host triple
#   GPU=1 sidecar/build.sh                 # build GPU variant (suffix -gpu)
#   GPU=1 ENGINE_TORCH_CUDA=1 sidecar/build.sh   # build gpu-full (CUDA torch)
#   ALIGN_LANGS="pl en" sidecar/build.sh   # which alignment models to bundle
#
# NOTE: On Windows, GPU=1 alone NO LONGER implies a CUDA torch wheel. It builds
# CT2-CUDA + torch-CPU: transcription runs on CUDA via CTranslate2 (whose stock
# PyPI wheel is CUDA-capable and only needs two cuBLAS DLLs, sourced from a pinned
# nvidia-cublas-cu12 wheel), while alignment/diarization run on CPU torch. This
# freezes to ~984 MB (vs 3.08 GB for the cu128 build), under GitHub's 2 GB cap.
# The old cu128 build lives on behind GPU=1 ENGINE_TORCH_CUDA=1 as the dormant
# `whisperx-engine-gpu-full` variant (GPU alignment too, ~3.08 GB). On macOS,
# GPU=1 still builds the Metal variant (Metal torch from the lock, no cuBLAS).
#
# Targets produced (per the plan):
#   src-tauri/binaries/whisperx-engine-aarch64-apple-darwin                 (macOS CPU)
#   src-tauri/binaries/whisperx-engine-gpu-aarch64-apple-darwin             (macOS Metal)
#   src-tauri/binaries/whisperx-engine-x86_64-pc-windows-msvc.exe           (Windows CPU)
#   src-tauri/binaries/whisperx-engine-gpu-x86_64-pc-windows-msvc.exe       (Windows CT2-CUDA)
#   src-tauri/binaries/whisperx-engine-gpu-full-x86_64-pc-windows-msvc.exe  (Windows cu128, dormant)
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
ENGINE_TORCH_CUDA="${ENGINE_TORCH_CUDA:-0}"

# ── Pinned cuBLAS wheel (CT2-CUDA GPU build only) ───────────────────────────
# Supply-chain input to a signed artifact: pin the exact nvidia-cublas-cu12 wheel
# version AND its sha256 so the build is reproducible, not floating. CUDA 12.8 line
# to match the DLLs the research measured against (torch cu128). Verified on PyPI
# 2026-07-10.
#   nvidia_cublas_cu12-12.8.4.1-py3-none-win_amd64.whl
#   size 567,544,208 B
#   sha256 47e9b82132fa8d2b4944e708049229601448aaad7e6f296f630f2d1a32de35af
CUBLAS_WHEEL_VERSION="12.8.4.1"
CUBLAS_WHEEL_SHA256="47e9b82132fa8d2b4944e708049229601448aaad7e6f296f630f2d1a32de35af"

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
if [ "$GPU" = "1" ]; then
  if [ "$ENGINE_TORCH_CUDA" = "1" ]; then
    BASE_NAME="whisperx-engine-gpu-full"   # cu128 torch, GPU align (dormant)
  else
    BASE_NAME="whisperx-engine-gpu"        # CT2-CUDA + torch-CPU (shipping)
  fi
fi
OUT_NAME="${BASE_NAME}-${TRIPLE}"
echo "==> Building $OUT_NAME (GPU=$GPU, ENGINE_TORCH_CUDA=$ENGINE_TORCH_CUDA, align langs: $ALIGN_LANGS)"

# ── Python venv ─────────────────────────────────────────────────────────────
# CPU and CUDA torch builds cannot co-exist in one venv (same package, different
# +cpu/+cuXXX local version), so ONLY the CUDA-torch build (gpu-full) gets its own
# venv. The shipping GPU build uses torch+cpu and therefore shares the CPU .venv —
# its CUDA comes from CTranslate2 + the cuBLAS wheel, not from torch.
VENV="$SIDECAR_DIR/.venv"
[ "$ENGINE_TORCH_CUDA" = "1" ] && VENV="$SIDECAR_DIR/.venv-gpu"
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
    if [ "$ENGINE_TORCH_CUDA" = "1" ]; then
      # CUDA-torch build (gpu-full only). cu128 carries Blackwell sm_120 kernels
      # (RTX 50xx); cu121 has none and fails at runtime with "no kernel image
      # available". The shipping GPU build (GPU=1 without ENGINE_TORCH_CUDA) takes
      # the +cpu branch below — its CUDA rides on CTranslate2 + the cuBLAS wheel.
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
  elif [ "$ENGINE_TORCH_CUDA" = "1" ]; then
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

# ── cuBLAS DLLs for the shipping GPU build (CT2-CUDA + torch-CPU) ────────────
# CT2's stock wheel is CUDA-capable but links cuBLAS lazily; under torch+cpu
# nothing preloads it, so ship cublas64_12.dll + cublasLt64_12.dll (the ONLY CUDA
# DLLs CT2 4.8.0 needs — it statically links the rest). Source them from a PINNED
# nvidia-cublas-cu12 win_amd64 wheel and verify its sha256 before extracting; the
# .spec picks them up via ENGINE_CUBLAS_DIR. gpu-full skips this (its CUDA rides in
# the cu128 torch wheel), as do the CPU and macOS builds.
unset ENGINE_CUBLAS_DIR || true
if [ "$GPU" = "1" ] && [ "$ENGINE_TORCH_CUDA" != "1" ] && [ "$EXE_EXT" = ".exe" ]; then
  CUBLAS_SCRATCH="$SIDECAR_DIR/build/cublas-wheel"
  rm -rf "$CUBLAS_SCRATCH"
  mkdir -p "$CUBLAS_SCRATCH"
  echo "==> Downloading pinned nvidia-cublas-cu12==$CUBLAS_WHEEL_VERSION (win_amd64)"
  python -m pip download --no-deps --only-binary=:all: \
    --platform win_amd64 --python-version 3 --implementation py --abi none \
    -d "$CUBLAS_SCRATCH" "nvidia-cublas-cu12==$CUBLAS_WHEEL_VERSION"
  WHEEL="$(ls "$CUBLAS_SCRATCH"/nvidia_cublas_cu12-*-win_amd64.whl)"
  echo "==> Verifying wheel sha256"
  GOT_SHA="$(python -c "import hashlib,sys;print(hashlib.sha256(open(sys.argv[1],'rb').read()).hexdigest())" "$WHEEL")"
  if [ "$GOT_SHA" != "$CUBLAS_WHEEL_SHA256" ]; then
    echo "cuBLAS wheel sha256 mismatch!" >&2
    echo "  expected $CUBLAS_WHEEL_SHA256" >&2
    echo "  got      $GOT_SHA" >&2
    exit 1
  fi
  echo "==> Extracting cuBLAS DLLs from the wheel"
  CUBLAS_DIR="$CUBLAS_SCRATCH/dlls"
  rm -rf "$CUBLAS_DIR"
  mkdir -p "$CUBLAS_DIR"
  python - "$WHEEL" "$CUBLAS_DIR" <<'PY'
import sys, zipfile, os
wheel, out = sys.argv[1], sys.argv[2]
wanted = {"cublas64_12.dll", "cublasLt64_12.dll"}
with zipfile.ZipFile(wheel) as z:
    found = set()
    for info in z.infolist():
        base = os.path.basename(info.filename)
        if base in wanted:
            with z.open(info) as src, open(os.path.join(out, base), "wb") as dst:
                dst.write(src.read())
            found.add(base)
    missing = wanted - found
    if missing:
        sys.exit("cuBLAS DLLs missing from wheel: %s" % ", ".join(sorted(missing)))
print("extracted", ", ".join(sorted(found)))
PY
  export ENGINE_CUBLAS_DIR="$CUBLAS_DIR"
  echo "==> ENGINE_CUBLAS_DIR=$ENGINE_CUBLAS_DIR"
fi

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
