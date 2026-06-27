#!/usr/bin/env bash
#
# Build + install the Reels Automator DaVinci Resolve Workflow Integration plugin
# into Resolve's WI plugins dir (personal / cross-device use — S-09 Phase 6).
#
# Phase 6 (Apple Developer ID signing + notarization) is DESCOPED: this build is
# for the author's own machines, not the Mac App Store / public distribution. A
# WI plugin is just a PLAIN FOLDER Resolve hosts (HTML/JS + the native
# `WorkflowIntegration.node` + the Node backend) — Resolve provides the Electron
# runtime, so there is no standalone .app to sign. Locally-built files carry no
# `com.apple.quarantine` flag; only files moved via AirDrop/iCloud/download do.
# This script clears quarantine at the end so a freshly-rsynced copy launches
# without a Gatekeeper prompt.
#
# Sidecars (`whisperx-engine-<arch>`, `ffmpeg-<arch>`, `align_models/`) are NOT
# copied (~400 MB). Instead a `<plugin>/binaries` symlink points at the repo's
# `src-tauri/binaries` — `backend/paths.js binariesDir()` probes `<plugin>/../binaries`
# as candidate #2, so the sidecars resolve through the link. Restore the sidecars
# themselves with `sidecar/build.sh` + `sidecar/fetch-ffmpeg.sh` first.
#
# Usage:
#   sidecar/install-resolve-plugin.sh
#
# Produces:
#   <WI plugins dir>/Reels-Automator/   (built plugin + binaries symlink)
#
set -euo pipefail

SIDECAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SIDECAR_DIR/.." && pwd)"
PLUGIN_SRC="$REPO_ROOT/resolve-plugin"
WI_DIR="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins"
DEST="$WI_DIR/Reels-Automator"

echo "==> Building the renderer (npm run build:resolve)"
( cd "$REPO_ROOT" && npm run build:resolve )

if [ ! -f "$PLUGIN_SRC/WorkflowIntegration.node" ]; then
  echo "WARNING: $PLUGIN_SRC/WorkflowIntegration.node is missing." >&2
  echo "  Copy the macOS variant from the DaVinci Resolve Developer SDK first" >&2
  echo "  (…/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/)." >&2
  echo "  Without it the panel loads but reports Resolve unavailable." >&2
fi

echo "==> Installing into $DEST"
mkdir -p "$DEST"

# Plain-folder plugin: copy the renderer + backend + the host files. Sidecars are
# linked separately (below), never rsynced.
for item in main.js preload.js manifest.xml package.json WorkflowIntegration.node \
            backend renderer presets README.md; do
  if [ -e "$PLUGIN_SRC/$item" ]; then
    rsync -a --delete "$PLUGIN_SRC/$item" "$DEST/"
  else
    echo "  (skipping absent $item)"
  fi
done

# Refresh the binaries symlink → repo sidecars (absolute). paths.js binariesDir()
# resolves the sidecars + align_models through this link without a 400 MB copy.
LINK_TARGET="$REPO_ROOT/src-tauri/binaries"
echo "==> Linking $DEST/binaries -> $LINK_TARGET"
rm -f "$DEST/binaries"
ln -s "$LINK_TARGET" "$DEST/binaries"

# Clear quarantine so a rsynced/AirDropped copy launches without a Gatekeeper
# prompt (Phase 6 descope — no notarization).
echo "==> Clearing quarantine"
xattr -dr com.apple.quarantine "$DEST" 2>/dev/null || true

echo "==> Done. Restart DaVinci Resolve and open"
echo "    Workspace → Workflow Integrations → Reels Automator"
