# PyInstaller runtime hook: preload the two cuBLAS DLLs before CTranslate2 first
# touches CUDA.
#
# CT2 4.8.0 resolves CUDA lazily with a plain LoadLibrary and has zero static CUDA
# imports, so nothing pulls cuBLAS into the process on its own under a CPU-torch
# build (unlike the old cu128 build, where `import torch` loaded it first). We must
# preload it by absolute path from sys._MEIPASS.
#
# Order is load-bearing: cublas64_12.dll depends on cublasLt64_12.dll, so cuBLASLt
# MUST load first. os.add_dll_directory() does NOT help — it only affects
# LoadLibraryEx with LOAD_LIBRARY_SEARCH_USER_DIRS, and CT2's plain LoadLibrary
# ignores it.
#
# This is a silent no-op off Windows or when the DLLs are absent (the CPU build
# ships without them and must still boot cleanly). It records the outcome in
# REEL_CUBLAS_PRELOAD so cmd_capability can report `cublas`.
import os
import sys


def _preload_cublas():
    if sys.platform != "win32":
        return
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
    # cuBLASLt FIRST — cublas64_12.dll depends on it.
    names = ("cublasLt64_12.dll", "cublas64_12.dll")
    paths = [os.path.join(base, n) for n in names]
    if not all(os.path.isfile(p) for p in paths):
        # CPU build: no cuBLAS shipped. Leave REEL_CUBLAS_PRELOAD unset.
        return
    try:
        import ctypes

        for p in paths:
            ctypes.WinDLL(p)
        os.environ["REEL_CUBLAS_PRELOAD"] = "ok"
    except Exception as e:  # never raise from a runtime hook
        os.environ["REEL_CUBLAS_PRELOAD"] = "fail:%s" % e


_preload_cublas()
