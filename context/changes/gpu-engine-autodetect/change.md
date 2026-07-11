---
change_id: gpu-engine-autodetect
title: Autodetect GPU hardware and provision a matching WhisperX engine without self-hosting it
status: implementing
created: 2026-07-10
updated: 2026-07-11
archived_at: null
gate_b_decision: "FAIL 4.19x (CPU-torch alignment dominates: 107.7s vs 14.3s CUDA). Per user 2026-07-11: ACTIVATE engine-gpu-full. Ship lightweight GPU (984MB, GitHub) as the default GPU variant AND host+PIN gpu-full (3.08GB) on HuggingFace, reachable only via REEL_ENGINE_VARIANT=gpu-full. Phase 2 §2 MUST fill the gpu-full sha256 (real digest, not the empty/dormant stub) and give it a real HF repo+files entry."
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

## RESUME STATE (2026-07-11) — read this first

**Where we are:** Phase 1 DONE (except macOS 1.13, deferred — needs a Mac). Phase 2
DONE + committed **e833dd6**. **Phase 3 is next** (honest hardware detection).

**Phase 2 outcome (all hosting live + verified reachable):**
- `engine-gpu` hosted on GitHub release **deps-v1.1.0** (GarniczAndrzej/reel-automator-deps).
  URL pinned; HEAD → 200, Content-Length 1,031,465,189 (matches). sha256
  `cc45a73ce68dc64956e9da3b3a7d1f900b99ab43d5bbf9d6ea8db51d54339c9e`. version 1.1.0.
- `engine-gpu-full` (3.08GB) hosted on a **public HuggingFace bucket** —
  `Vndrew/ReelAutomatorGPUfull`. URL is the bucket shape:
  `https://huggingface.co/buckets/Vndrew/ReelAutomatorGPUfull/resolve/whisperx-engine-gpu-full-x86_64-pc-windows-msvc.exe?download=true`
  (302 → public Xet CDN; HEAD final 200, Content-Length 3,302,783,700 matches). sha256
  `3c43ee37ea69a0902d4a481547569a2bce066d62f08c773528ee51cd966f4965`. version 1.1.0.
- **DEVIATION (user-ratified):** gpu-full uses the **`url` shape**, NOT the plan's
  literal `repo`+`files[]`. Reason: `files[]` routes through `download_dir` which stages
  a DIRECTORY, breaking single-file engine spawn (`resolve_engine_variant` needs
  `is_file()`). url-shape stages a spawnable file via `download_single`, zero downloader
  changes. gpu-full stays env-only (`REEL_ENGINE_VARIANT=gpu-full`); `resolve_variant`
  accepts it from the **env override only** (never UI/hardware). specVersion 1→2.
- 2.1–2.7 green + committed. **2.8–2.11 are live app-download checks, deliberately
  DEFERRED** to Phase 5's end-to-end first-run flow (user chose "defer app checks").
- `roadmap.md` was staged into e833dd6 per user (it's Phase 5 doc work, carried early).

**Known separate defect (NOT this change, needs its own):** diarization is broken in
ALL frozen builds — `speechbrain.integrations.k2_fsa` lazy-import failure loading
`pyannote/speaker-diarization-community-1` (exit 13). Pre-existing (fails on cu128
too). Bundling gap in whisperx_engine.spec. Flag to the user / open a new change.

**Phase 1 commits:** 6a00e2a, caafeb3, b94e54a, 70b7038, 491f788. **Phase 2:** e833dd6.

**Three engine exes remain on disk in src-tauri/binaries/ (git-ignored):**
- `whisperx-engine-x86_64-pc-windows-msvc.exe` — CPU (torch+cpu)
- `whisperx-engine-gpu-x86_64-pc-windows-msvc.exe` — CT2-CUDA (1.03 GB, torch+cpu + cuBLAS) [hosted]
- `whisperx-engine-gpu-full-x86_64-pc-windows-msvc.exe` — cu128 baseline (3.08 GB) [hosted on HF]

**Next action = Phase 3 (honest hardware detection).** Resume:
`/10x-implement gpu-engine-autodetect phase 3`. Read plan.md Phase 3 (§1 nvidia_query
profiling, §2 DXGI enumeration + `windows` crate dep, §3 `gpu_info` command, §4 persisted
`gpuUnusable`, §5 delete `gpu_sidecar_present` / drop the `engine_sidecar()` OnceLock /
add `variant_satisfied` + `engine_bin_resolved`). NOTE: `engine_sidecar()` was left
argless in Phase 2 (still returns CPU for a gpu-full selection — Phase 3 §5 reworks it to
consult the staged deps root via `resolve_engine_variant`). The plan.md SHA write-back
for 2.1–2.7 + this resume-state update land in the pre-clear chore commit below.

**Phase 4 TODO (don't lose this):** `gpu-full`'s `--capability` reports
`cublas:false` (its CUDA comes from torch, not our bundled DLLs) while still
running on CUDA. Phase 4's plan demotes a `gpu`/`gpu-full` engine when
`cublas==false` — that would WRONGLY demote a working gpu-full. Scope the cuBLAS
demotion check to the `gpu` variant only (gpu-full judged by `gpu==false` alone).

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
