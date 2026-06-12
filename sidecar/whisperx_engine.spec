# -*- mode: python ; coding: utf-8 -*-
#
# PyInstaller spec for the WhisperX engine sidecar.
#
# Produces a single standalone executable. The per-language wav2vec2 alignment
# model(s) staged under sidecar/whisperx_engine/align_models/ at build time are
# bundled as data so forced alignment works offline immediately (Phase 1 user
# decision). Large faster-whisper transcription models are NOT bundled — those
# are downloaded on demand (Phase 4).
#
# Driven by sidecar/build.sh, which sets ENGINE_OUT_NAME to the Tauri
# arch-suffixed binary name (e.g. whisperx-engine-aarch64-apple-darwin).

import os
from PyInstaller.utils.hooks import collect_submodules, collect_data_files

block_cipher = None

HERE = os.path.abspath(os.getcwd())
SRC = os.path.join(HERE, "whisperx_engine", "whisperx_engine.py")
ALIGN_DIR = os.path.join(HERE, "whisperx_engine", "align_models")

datas = []
if os.path.isdir(ALIGN_DIR):
    datas.append((ALIGN_DIR, "align_models"))

# WhisperX / pyannote / faster-whisper pull in models + assets dynamically.
datas += collect_data_files("whisperx")
datas += collect_data_files("faster_whisper")
datas += collect_data_files("pyannote", include_py_files=False)
datas += collect_data_files("lightning_fabric", include_py_files=False)
datas += collect_data_files("speechbrain", include_py_files=False)

hiddenimports = []
for pkg in ("whisperx", "faster_whisper", "pyannote.audio", "speechbrain", "torchaudio"):
    try:
        hiddenimports += collect_submodules(pkg)
    except Exception:
        pass

OUT_NAME = os.environ.get("ENGINE_OUT_NAME", "whisperx-engine")

a = Analysis(
    [SRC],
    pathex=[HERE],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[],
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name=OUT_NAME,
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
