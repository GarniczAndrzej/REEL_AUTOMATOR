#!/usr/bin/env bash
#
# Build a self-contained macOS installer (.pkg) for the Reels Automator DaVinci
# Resolve Workflow Integration plugin — the distributable sibling of
# `install-resolve-plugin.sh` (which is a dev install that SYMLINKS the repo's
# sidecars and so only works on the machine holding the checkout).
#
# The .pkg installs a plain-folder WI plugin into Resolve's WI plugins dir with
# the sidecars COPIED in (`<plugin>/binaries/` — candidate #2 of
# `backend/paths.js binariesDir()`, the same slot the dev symlink occupies):
#
#   /Library/Application Support/Blackmagic Design/DaVinci Resolve/
#     Workflow Integration Plugins/Reels-Automator/
#       main.js preload.js manifest.xml package.json WorkflowIntegration.node
#       backend/ renderer/ presets/
#       binaries/whisperx-engine-<arch>  binaries/ffmpeg-<arch>
#
# `align_models/` (~2.7 GB) is deliberately NOT bundled: the plugin downloads the
# alignment + transcription models on first use into the user's userData dir
# (the installed `binaries/` is root-owned, so `alignModelDownloadDir()` falls
# back to `<userData>/align_models`). Same first-run model story as the DMG.
#
# Unsigned by default (Phase 6 signing/notarization is descoped). Set
# PKG_SIGN_IDENTITY="Developer ID Installer: …" to sign with productbuild.
#
# Prereqs: `sidecar/build.sh` + `sidecar/fetch-ffmpeg.sh` (sidecars) and
# `resolve-plugin/WorkflowIntegration.node` copied from the Resolve Developer SDK.
#
# Usage:
#   sidecar/build-resolve-plugin-pkg.sh
#
# Produces:
#   dist/Reels-Automator-Resolve-<version>.pkg
#
set -euo pipefail

SIDECAR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SIDECAR_DIR/.." && pwd)"
PLUGIN_SRC="$REPO_ROOT/resolve-plugin"
BIN_SRC="$REPO_ROOT/src-tauri/binaries"
WI_DIR="/Library/Application Support/Blackmagic Design/DaVinci Resolve/Workflow Integration Plugins"
PLUGIN_DIRNAME="Reels-Automator"
PKG_ID="com.brave.reelsautomator.resolveplugin"
ARCH="aarch64-apple-darwin"   # Apple Silicon only (see README "Obsługiwane platformy")

VERSION="$(sed -n 's:.*<Version>\(.*\)</Version>.*:\1:p' "$PLUGIN_SRC/manifest.xml" | head -1)"
[ -n "$VERSION" ] || { echo "ERROR: no <Version> in manifest.xml" >&2; exit 1; }

OUT_DIR="$REPO_ROOT/dist"
OUT_PKG="$OUT_DIR/Reels-Automator-Resolve-$VERSION.pkg"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# ── Preflight: a release installer must be complete — fail hard, never ship a
#    plugin that silently reports Resolve/transcription unavailable.
missing=0
for f in "$PLUGIN_SRC/WorkflowIntegration.node" \
         "$BIN_SRC/whisperx-engine-$ARCH" \
         "$BIN_SRC/ffmpeg-$ARCH"; do
  if [ ! -f "$f" ]; then
    echo "ERROR: missing $f" >&2
    missing=1
  fi
done
if [ "$missing" -ne 0 ]; then
  echo "  Sidecars: sidecar/build.sh + sidecar/fetch-ffmpeg.sh" >&2
  echo "  WorkflowIntegration.node: copy from …/DaVinci Resolve/Developer/Workflow Integrations/Examples/SamplePlugin/" >&2
  exit 1
fi

echo "==> Building the renderer (npm run build:resolve)"
( cd "$REPO_ROOT" && npm run build:resolve )

# ── Stage the payload: <root>/Reels-Automator/… installed under $WI_DIR.
ROOT="$WORK/root"
DEST="$ROOT/$PLUGIN_DIRNAME"
mkdir -p "$DEST/binaries"

echo "==> Staging plugin files"
for item in main.js preload.js manifest.xml package.json WorkflowIntegration.node \
            backend renderer presets README.md; do
  rsync -a --exclude '.DS_Store' "$PLUGIN_SRC/$item" "$DEST/"
done

echo "==> Staging sidecars (align_models excluded — downloaded on first use)"
cp "$BIN_SRC/whisperx-engine-$ARCH" "$BIN_SRC/ffmpeg-$ARCH" "$DEST/binaries/"

# Dirs 755, files 644, sidecars 755 (repo files are 700 — normalise for a
# root-owned install). Best-effort xattr strip; pkgbuild still sees protected
# ones (com.apple.provenance), so COPYFILE_DISABLE below keeps `._*` AppleDouble
# files out of the payload.
find "$DEST" -type d -exec chmod 755 {} +
find "$DEST" -type f -exec chmod 644 {} +
chmod 755 "$DEST/binaries/"*
xattr -cr "$DEST" 2>/dev/null || true

# ── Install scripts.
SCRIPTS="$WORK/scripts"
mkdir -p "$SCRIPTS"

# preinstall: drop any previous install (incl. a dev install whose `binaries` is
# a symlink into a repo — `rm -rf` removes the link, never its target) and the
# legacy `com.brave.reelsautomator` dir name, so two copies with the same plugin
# Id never coexist.
cat > "$SCRIPTS/preinstall" <<EOF
#!/bin/bash
WI_DIR="$WI_DIR"
rm -rf "\$WI_DIR/$PLUGIN_DIRNAME" "\$WI_DIR/com.brave.reelsautomator"
exit 0
EOF

# postinstall: belt-and-braces quarantine clear + exec bits on the sidecars.
cat > "$SCRIPTS/postinstall" <<EOF
#!/bin/bash
P="$WI_DIR/$PLUGIN_DIRNAME"
xattr -dr com.apple.quarantine "\$P" 2>/dev/null || true
chmod 755 "\$P/binaries/"* 2>/dev/null || true
exit 0
EOF
chmod 755 "$SCRIPTS/preinstall" "$SCRIPTS/postinstall"

# ── Component package. No .app bundles in the payload, so no relocation plist.
echo "==> pkgbuild"
COPYFILE_DISABLE=1 pkgbuild \
  --root "$ROOT" \
  --install-location "$WI_DIR" \
  --identifier "$PKG_ID" \
  --version "$VERSION" \
  --scripts "$SCRIPTS" \
  --ownership recommended \
  "$WORK/component-raw.pkg" >/dev/null 2>&1

# pkgbuild always turns xattrs into `._*` AppleDouble payload entries, and
# `com.apple.provenance` can't be stripped from freshly written files. Rebuild
# the Payload + Bom ourselves — bsdtar odc cpio with no mac metadata, root:wheel
# — and keep pkgbuild's PackageInfo/Scripts.
echo "==> Repacking payload without AppleDouble files"
EXP="$WORK/component-exp"
pkgutil --expand "$WORK/component-raw.pkg" "$EXP"
rm -f "$EXP/Payload"
tar --format odc --uid 0 --gid 0 --no-mac-metadata --no-xattrs --no-acls \
  -czf "$EXP/Payload" -C "$ROOT" .
# pkgbuild's Bom already carries root ownership — just drop its `._*` rows.
lsbom "$EXP/Bom" | grep -v '/\._' > "$WORK/bom.txt"
rm -f "$EXP/Bom"
mkbom -i "$WORK/bom.txt" "$EXP/Bom"
NFILES="$(cd "$ROOT" && find . | wc -l | tr -d ' ')"
sed -i '' "s/numberOfFiles=\"[0-9]*\"/numberOfFiles=\"$NFILES\"/" "$EXP/PackageInfo"
if tar -tzf "$EXP/Payload" | grep -q '/\._'; then
  echo "ERROR: AppleDouble entries still in payload" >&2
  exit 1
fi
pkgutil --flatten "$EXP" "$WORK/component.pkg"

# ── Product archive: Polish welcome/conclusion + Apple Silicon gate.
RES="$WORK/resources"
mkdir -p "$RES"

cat > "$RES/welcome.html" <<'EOF'
<html><body style="font-family: -apple-system, sans-serif; font-size: 13px;">
<h2>Reels Automator — wtyczka do DaVinci Resolve</h2>
<p>Ten instalator dodaje panel <b>Reels Automator</b> do DaVinci Resolve Studio
(Workspace → Workflow Integrations).</p>
<p><b>Wymagania:</b></p>
<ul>
  <li>DaVinci Resolve <b>Studio</b> (panele Workflow Integration nie działają w darmowej wersji),</li>
  <li>Mac z procesorem Apple Silicon.</li>
</ul>
<p>Jeśli DaVinci Resolve jest uruchomiony, zamknij go (⌘Q) przed instalacją.</p>
</body></html>
EOF

cat > "$RES/conclusion.html" <<'EOF'
<html><body style="font-family: -apple-system, sans-serif; font-size: 13px;">
<h2>Gotowe</h2>
<ol>
  <li>Uruchom (ponownie) DaVinci Resolve Studio — wtyczki są wczytywane tylko przy starcie.</li>
  <li>Otwórz <b>Workspace → Workflow Integrations → Reels Automator</b>.</li>
  <li>Przed pierwszą transkrypcją pobierz modele (transkrypcji i wyrównania) w sekcji
      „Transkrypcja wideo (WhisperX)” — jednorazowo, wymaga internetu.</li>
</ol>
</body></html>
EOF

cat > "$WORK/distribution.xml" <<EOF
<?xml version="1.0" encoding="utf-8"?>
<installer-gui-script minSpecVersion="2">
  <title>Reels Automator — wtyczka DaVinci Resolve</title>
  <welcome file="welcome.html"/>
  <conclusion file="conclusion.html"/>
  <options customize="never" require-scripts="false" hostArchitectures="arm64"/>
  <domains enable_localSystem="true" enable_anywhere="false" enable_currentUserHome="false"/>
  <choices-outline>
    <line choice="default"/>
  </choices-outline>
  <choice id="default" title="Reels Automator">
    <pkg-ref id="$PKG_ID"/>
  </choice>
  <pkg-ref id="$PKG_ID" version="$VERSION" onConclusion="none">component.pkg</pkg-ref>
</installer-gui-script>
EOF

mkdir -p "$OUT_DIR"
rm -f "$OUT_PKG"
SIGN_ARGS=()
if [ -n "${PKG_SIGN_IDENTITY:-}" ]; then
  SIGN_ARGS=(--sign "$PKG_SIGN_IDENTITY")
fi

echo "==> productbuild"
productbuild \
  --distribution "$WORK/distribution.xml" \
  --resources "$RES" \
  --package-path "$WORK" \
  ${SIGN_ARGS[@]+"${SIGN_ARGS[@]}"} \
  "$OUT_PKG" >/dev/null

echo "==> Done: $OUT_PKG ($(du -h "$OUT_PKG" | cut -f1))"
if [ -z "${PKG_SIGN_IDENTITY:-}" ]; then
  echo "    (unsigned — on another Mac: right-click → Open, or System Settings → Privacy & Security → Open Anyway)"
fi
