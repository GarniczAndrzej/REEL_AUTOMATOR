#!/usr/bin/env bash
#
# OS-aware build of the WhisperX engine sidecar.
#
# Detects host OS/arch, installs the matching platform deps (torch CPU vs
# CUDA/Metal, CTranslate2 build), then freezes whisperx_engine.py with
# PyInstaller into a single standalone executable named with the Tauri
# arch-suffix convention (matching the FFmpeg sidecar) and copies it into
# src-tauri/binaries/. The per-language wav2vec2 alignment model is NOT
# staged or bundled here (S-29) — it downloads once on first use (or via the
# model manager's "Pobierz model wyrównania" button) into a writable
# per-user cache; see whisperx_engine.py's _ensure_align_model.
#
# Usage:
#   sidecar/build.sh                # build CPU variant for the host triple
#   GPU=1 sidecar/build.sh          # build GPU/Metal variant (suffix -gpu)
#
# Targets produced (per the plan):
#   src-tauri/binaries/whisperx-engine-aarch64-apple-darwin        (macOS CPU)
#   src-tauri/binaries/whisperx-engine-aarch64-apple-darwin-gpu    (macOS Metal)
#   src-tauri/binaries/whisperx-engine-x86_64-pc-windows-msvc.exe  (Windows)
#
# Prerequisites: Python 3.10/3.11, pip, internet (first build pulls wheels).
# See sidecar/README.md.

set -euo pipefail

SIDECAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SIDECAR_DIR/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
ENGINE_PKG="$SIDECAR_DIR/whisperx_engine"
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

SUFFIX=""
[ "$GPU" = "1" ] && SUFFIX="-gpu"
OUT_NAME="whisperx-engine-${TRIPLE}${SUFFIX}"
echo "==> Building $OUT_NAME (GPU=$GPU)"

# ── Python venv ─────────────────────────────────────────────────────────────
VENV="$SIDECAR_DIR/.venv"
if [ ! -d "$VENV" ]; then
  python3 -m venv "$VENV"
fi
# shellcheck disable=SC1091
source "$VENV/bin/activate" 2>/dev/null || source "$VENV/Scripts/activate"
python -m pip install --upgrade pip wheel >/dev/null

# ── Dependency install ──────────────────────────────────────────────────────
# macOS arm64 (the shipping target) installs the Phase-0-certified locked stack
# with --no-deps: whisperx 3.8.6 declares `huggingface-hub<1.0.0` but transformers
# 5.x needs `>=1.5.0`, so the gate-validated combo is NOT pip cross-resolvable. The
# lock pins every package (incl. the mac MPS torch wheel) at the runtime-proven
# versions; --no-deps tolerates whisperx's stale cap. Other platforms fall back to
# best-effort resolution from requirements.txt.
LOCK="$ENGINE_PKG/requirements.lock.txt"
if [ "$uname_s" = "Darwin" ] && [ -f "$LOCK" ]; then
  echo "==> Installing locked sidecar stack (--no-deps) from requirements.lock.txt"
  python -m pip install --no-deps -r "$LOCK"
else
  if [ "$uname_s" = "Darwin" ]; then
    # macOS without a lock: torch ships with Metal (MPS); CTranslate2 stays CPU.
    python -m pip install torch torchaudio
  elif [ "$GPU" = "1" ]; then
    # CUDA build (Linux/Windows).
    python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cu121
  else
    python -m pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu
  fi
  python -m pip install -r "$ENGINE_PKG/requirements.txt"
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

echo "==> Done: $BIN_DIR/$OUT_NAME$EXE_EXT"
echo "    Self-test it with: \"$BIN_DIR/$OUT_NAME$EXE_EXT\" --selftest"
