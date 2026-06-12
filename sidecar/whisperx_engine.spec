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
from PyInstaller.utils.hooks import collect_submodules, collect_data_files, copy_metadata

block_cipher = None

HERE = os.path.abspath(os.getcwd())
SRC = os.path.join(HERE, "whisperx_engine", "whisperx_engine.py")

# The per-language wav2vec2 alignment model is deliberately NOT baked in: a
# multi-GB onefile Mach-O fails to load on macOS (dyld aborts before main).
# build.sh stages it BESIDE the sidecar binary instead, and the Rust layer passes
# its path via --align-model-dir. Keep this freeze model-free (small + loadable).
datas = []

# WhisperX / pyannote / faster-whisper pull in models + assets dynamically.
datas += collect_data_files("whisperx")
datas += collect_data_files("faster_whisper")
datas += collect_data_files("pyannote", include_py_files=False)
datas += collect_data_files("lightning_fabric", include_py_files=False)
datas += collect_data_files("speechbrain", include_py_files=False)
datas += collect_data_files("transformers")

# transformers uses lazy `_LazyModule` loading PyInstaller can't follow, and
# checks each backend via importlib.metadata.version(...). Without the wav2vec2
# submodules AND the dist-info metadata of torch & friends, the frozen engine
# can't load Wav2Vec2ForCTC → forced alignment fails (exit 12,
# "Could not import module 'Wav2Vec2ForCTC'"). Bundle both explicitly.
#
# `torchcodec` is the subtle one: transformers' audio_utils.py runs
# `importlib.metadata.version("torchcodec")` at *import* time whenever the package
# is merely find_spec-able (PyInstaller bundles it), so its dist-info metadata
# MUST ship too or the whole wav2vec2 import chain dies with PackageNotFoundError.
# (transformers never actually imports torchcodec on our align path, so its
# broken @rpath dylib is irrelevant — only the metadata version read matters.)
for _pkg in (
    "transformers",
    "torch",
    "torchaudio",
    "torchcodec",
    "tokenizers",
    "safetensors",
    "huggingface_hub",
    "numpy",
    "regex",
    "tqdm",
    "packaging",
    "filelock",
    "pyyaml",
    "requests",
):
    try:
        datas += copy_metadata(_pkg)
    except Exception:
        pass

hiddenimports = []
for pkg in (
    "whisperx",
    "faster_whisper",
    "pyannote.audio",
    "speechbrain",
    "torchaudio",
    "transformers",
):
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
