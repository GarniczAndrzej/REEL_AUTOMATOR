---
change_id: gpu-engine-autodetect
title: Autodetect GPU hardware and provision a matching WhisperX engine without self-hosting it
status: implementing
created: 2026-07-10
updated: 2026-07-10
archived_at: null
gate_b_decision: pending — engine-gpu-full stays dormant until Phase 1 Gate B measurement (real reel on RTX 5070 Ti) says otherwise
---

## Notes

Full end-to-end GPU path. Because everyone has different GPU, someone has Radeons
and it's good to auto-detect the hardware and base of it download all dependencies
needed to run GPU engine and build that engine. I don't want to host it. Somehow you
helped me to download GPU engine and build it, so app should do the same based on the
user's hardware.

See `research.md` (2026-07-10) + its Follow-up Research section.

**Measured, not estimated.** The 3.3 GB artifact size is driven by the CUDA torch wheel,
which transcription does not need — CTranslate2's stock PyPI wheel is already CUDA-capable
and only misses cuBLAS. A CT2-CUDA + torch-CPU engine was built and freezes to
**983.7 MB** (vs 3.08 GB today), under GitHub's 2 GB cap with ~1 GB headroom. So the GPU
artifact can be hosted and SHA-256-pinned through the **existing** S-29 downloader, with the
trust anchor intact. Local Python provisioning is NOT needed — the constraint was the 2 GB
cap, per user 2026-07-10.

Scope for the plan:
- Ship `cublas64_12.dll` + `cublasLt64_12.dll` (752 MB raw) beside/in the engine; drop the
  cu128 torch wheel from the GPU build.
- `_detect_device()` must probe `ctranslate2.get_cuda_device_count()`, not
  `torch.cuda.is_available()`; decouple the CT2 device from the torch device (VAD/align).
- Fix `gpu_sidecar_present()` — it ignores the staged deps root, so a staged GPU engine is
  spawned as GPU while the badge reports CPU.
- Fix the two auto-open bugs (variant-agnostic `transcription_ready`, never-expiring
  `edl_deps_setup_dismissed`).
- Open trade-off to time first: align + diarize move to CPU torch.
- AMD/Intel: out of reach with this stack — detect, say so in Polish, install CPU.

## Phase 1 deviation (2026-07-11): ct2_device gated on cuBLAS, not raw enumeration

Plan §1 defined `ct2_device = "cuda" if get_cuda_device_count() > 0`. Running the
frozen CPU build on the RTX 5070 Ti dev box revealed this reports `device:cuda`
even for the CPU variant, because CUDA *enumeration* needs only the driver, not
cuBLAS — so the cuBLAS-less CPU engine would claim CUDA and fail at the first
matmul. Per user decision, `_ct2_cuda_available()` now also requires cuBLAS to be
usable (`_cublas_usable()`: `REEL_CUBLAS_PRELOAD == "ok"` on the shipping GPU
build, or a by-name/`_MEIPASS` cuBLAS load for the dormant gpu-full build). The CPU
build now correctly reports `gpu:false, device:cpu` (criterion 1.1 verified).
Phase 4's runtime net is still required — it catches the *different* failure of a
loaded cuBLAS with no kernel image for the GPU's architecture.
