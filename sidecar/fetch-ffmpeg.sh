#!/usr/bin/env bash
#
# Fetch the bundled FFmpeg sidecar for the host platform.
#
# The FFmpeg sidecar is git-ignored (a ~52 MB static binary doesn't belong in
# git history), so a fresh clone must run this once before `cargo check` /
# `npm run tauri build` — Tauri hard-fails if a registered externalBin is
# missing for the host triple. The binary MUST be statically linked (no
# Homebrew dylib dependency) or it won't run on machines without that exact
# Homebrew ffmpeg version.
#
# Usage:
#   sidecar/fetch-ffmpeg.sh
#
# Produces:
#   src-tauri/binaries/ffmpeg-<target-triple>
#
set -euo pipefail

SIDECAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SIDECAR_DIR/.." && pwd)"
BIN_DIR="$REPO_ROOT/src-tauri/binaries"
mkdir -p "$BIN_DIR"

# Static-build sources (osxexperts.net publishes self-contained mac builds).
# Bump the version slug when upgrading; verify the result has NO external dylib
# deps via `otool -L`.
uname_s="$(uname -s)"
uname_m="$(uname -m)"
case "$uname_s" in
  Darwin)
    case "$uname_m" in
      arm64|aarch64)
        TRIPLE="aarch64-apple-darwin"
        URL="https://www.osxexperts.net/ffmpeg81arm.zip" ;;
      x86_64)
        TRIPLE="x86_64-apple-darwin"
        URL="https://www.osxexperts.net/ffmpeg80intel.zip" ;;
      *) echo "unsupported macOS arch: $uname_m" >&2; exit 1 ;;
    esac ;;
  *)
    echo "fetch-ffmpeg.sh currently provides macOS static builds only." >&2
    echo "For $uname_s, supply a statically-linked ffmpeg at" >&2
    echo "  $BIN_DIR/ffmpeg-<target-triple>" >&2
    exit 1 ;;
esac

OUT="$BIN_DIR/ffmpeg-${TRIPLE}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "==> Downloading static ffmpeg for $TRIPLE"
curl -sSL -o "$TMP/ffmpeg.zip" "$URL"
unzip -o "$TMP/ffmpeg.zip" -d "$TMP" >/dev/null
# The zip contains a bare `ffmpeg` executable.
mv "$TMP/ffmpeg" "$OUT"
chmod +x "$OUT"
xattr -d com.apple.quarantine "$OUT" 2>/dev/null || true
# Ad-hoc sign so Gatekeeper lets it run.
codesign --force -s - "$OUT" >/dev/null 2>&1 || true

echo "==> Verifying it runs and is self-contained"
"$OUT" -version | head -1
EXTERNAL_DEPS="$(otool -L "$OUT" 2>/dev/null | grep -vE '/usr/lib|/System|:' || true)"
if [ -n "$EXTERNAL_DEPS" ]; then
  echo "WARNING: binary has external dylib deps (not self-contained):" >&2
  echo "$EXTERNAL_DEPS" >&2
  exit 1
fi
echo "==> OK: $OUT"
