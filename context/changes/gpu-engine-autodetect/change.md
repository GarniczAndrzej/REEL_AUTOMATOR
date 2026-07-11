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

**Where we are:** Phase 1 is DONE except the macOS check (1.13, needs a Mac —
deferred; this is a Windows box). 1.1–1.12 all PASS/recorded. Gate A PASSED (new
GPU ~4× faster than CPU). Gate B FAILED 4.19× (CPU-torch align dominates) → decision
recorded above: activate engine-gpu-full. **Phase 2 is cleared to start.**

**Phase 2 must (per Gate B decision):** host the lightweight GPU exe on GitHub
(deps-v1.1.0) as the default GPU variant AND host+PIN gpu-full (3.08GB) on a
HuggingFace repo — fill a REAL sha256 for gpu-full (NOT the empty/dormant stub the
plan's Phase 2 §2 originally specified). gpu-full stays env-only (REEL_ENGINE_VARIANT
=gpu-full), not in the UI. Compute digests with Get-FileHash -Algorithm SHA256 on the
exes in src-tauri/binaries/ (byte sizes: gpu 1,031,465,189; gpu-full 3,302,783,700 —
reconfirm before pinning).

**Known separate defect (NOT this change, needs its own):** diarization is broken in
ALL frozen builds — `speechbrain.integrations.k2_fsa` lazy-import failure loading
`pyannote/speaker-diarization-community-1` (exit 13). Pre-existing (fails on cu128
too). Bundling gap in whisperx_engine.spec. Flag to the user / open a new change.

**Phase 1 commits:** 6a00e2a, caafeb3, b94e54a, 70b7038, 491f788.

**Three engine exes are built fresh (all from 491f788), in src-tauri/binaries/:**
- `whisperx-engine-x86_64-pc-windows-msvc.exe` — CPU (464 MB, torch+cpu)
- `whisperx-engine-gpu-x86_64-pc-windows-msvc.exe` — new CT2-CUDA (1.03 GB, torch+cpu + cuBLAS)
- `whisperx-engine-gpu-full-x86_64-pc-windows-msvc.exe` — cu128 baseline (3.08 GB, torch+cu128)
(binaries/ is git-ignored, so these persist on disk but are not in git.)

**Next action = run the measurement (needs the user's HF_TOKEN, diarization ON):**
Measurement harness (session-scratchpad, absolute path persists on disk):
`C:\Users\garni\AppData\Local\Temp\claude\C--Users-garni-Desktop-REELS-REEL-AUTOMATOR\8257be9f-b6a7-492c-b227-f4cc434fcfe2\scratchpad\measure_engines.py`
Run (PowerShell, python call on ONE line):
```
$env:HF_TOKEN = "hf_real_token"
python "<measure_engines.py path above>" --audio "C:\Users\garni\Desktop\YTDown_YouTube_Media_NFdCkkkf_5M_001_1080p.mp4" --model large-v3 --cu128-exe "C:\Users\garni\Desktop\REELS\REEL_AUTOMATOR\src-tauri\binaries\whisperx-engine-gpu-full-x86_64-pc-windows-msvc.exe" --append-research
```
The script is fixed (utf-8 stderr decode, whisperx WhisperModel subclass, stderr
tail on failure, invalid-gate warning). Gate B MUST keep --diarize on — align +
diarize move to CPU torch on the new GPU build, which is exactly the cost measured.
Preliminary (from a partial run): CPU load ~13.7 s, CPU large-v3 transcribe ~426 s.

**When the numbers come in:** append the `--append-research` table to research.md
under a "Follow-up: measured phase timings" heading (1.10); write Gate A/B verdict
+ the engine-gpu-full activate-or-dormant decision into `gate_b_decision:` above
(1.12); flip 1.10–1.12 (and 1.13 if a Mac is available); then run the Phase 1
closeout commit and proceed to Phase 2.

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
