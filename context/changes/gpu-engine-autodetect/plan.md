# GPU Engine Autodetect — Implementation Plan

## Overview

Make the Windows GPU transcription path real and reachable. Today `engine-gpu-windows-x86_64` sits in `src/deps/deps-spec.json` with a placeholder `RELEASE_HOST` URL and an empty `sha256`, which the downloader deliberately fail-closes on — so no machine has ever run the GPU engine.

The research (`research.md`, Follow-up 2026-07-10) measured the way out on real hardware: the 3.08 GB artifact is an accident of packaging. CTranslate2 — which actually transcribes — is CUDA-capable in its stock PyPI wheel and needs only two cuBLAS DLLs. Torch is needed solely for wav2vec2 alignment and pyannote diarization. Freezing **CT2-CUDA + torch-CPU + cuBLAS** produces a **983.7 MB** executable, under GitHub Releases' 2 GB per-asset cap with ~1 GB of headroom.

That means the artifact can be hosted and SHA-256-pinned through the **existing** S-29 downloader, with the trust anchor (`validate_hashes()`, `deps.rs:809`) fully intact. No local Python provisioning, no local builds, no weakened supply chain.

Alongside that, this change makes hardware detection honest (NVIDIA *and* AMD/Intel), and fixes the two bugs that keep the ZALEŻNOŚCI window from ever opening on a machine that needs it.

## Current State Analysis

**The engine cannot see its own CUDA.** `_detect_device()` (`sidecar/whisperx_engine/whisperx_engine.py:131`) gates on `torch.cuda.is_available()`, permanently `False` under a CPU torch build. The research's frozen 983.7 MB exe self-reported `{"gpu": false, "device": "cpu"}` while holding a working CUDA CTranslate2 inside. That one function feeds `cmd_selftest` (`:226`), `cmd_capability` (`:251`), and `_resolve_device_compute` (`:146`) — so it drives the readiness badge, the readiness cache key, *and* the transcription device.

**Device is a single value where two are needed.** `cmd_transcribe` passes one `device` to `whisperx.load_model` (`:399-403`), which forwards it to the torch-based VAD (`whisperx/vads/pyannote.py:46`), and the same value to `_align` (`:426`) and `_diarize` (`:437`). Under CPU torch, `device="cuda"` would break VAD before transcription started.

**Detection is a single bool.** `nvidia_gpu_present()` (`deps.rs:219`) memoizes `nvidia-smi -L` → `bool`. Every failure collapses to `false` (fail-safe to CPU). It cannot see an AMD or Intel card at all, cannot report which card, and cannot distinguish "NVIDIA card present" from "usable CUDA driver present".

**The badge and the spawn resolver disagree.** `engine_bin_path()` (`engine.rs:201`) resolves staged-deps-root → beside-exe → repo `binaries/`. But `gpu_sidecar_present()` (`engine.rs:30`), which `engine_sidecar()` (`:65`) uses to key the readiness cache and paint the badge, checks only repo `binaries/` and beside-exe — **never the staged deps root**. A GPU engine staged only into `deps_root/engine/gpu/` is spawned as GPU while the badge reports CPU. This change stages exactly such an engine, so it trips this bug on day one.

**Two bugs keep the ZALEŻNOŚCI window shut.** `transcription_ready` (`deps.rs:651`) is variant-agnostic — true as soon as *any* engine resolves — so a GPU machine holding only the CPU engine is judged ready and never offered the GPU engine (`first-run-deps.js:108-121`). And `edl_deps_setup_dismissed` (`first-run-deps.js:21`) is written on "Pomiń na razie" and **never expires**, permanently muting the auto-open even after the dep set or the hardware changes underneath it.

**What already works and must not be disturbed:** the download → SHA-256 verify → atomic stage pipeline (`deps.rs:954`), the embedded-spec trust anchor and `merge_specs` URL-only re-pointing rule (`deps.rs:108`), the `staged_path` slot contract (`deps.rs:327`), the three-way spawn precedence (`engine.rs:159`), and `crate::proc` raw-`Command` spawning (S-29 Phase 3).

## Desired End State

On a Windows machine with an NVIDIA GPU and a driver at or above the CUDA 12.x floor, first launch opens the ZALEŻNOŚCI window, which states in Polish which card was detected, how much VRAM it has, which driver is installed, and that the GPU engine variant was chosen because of it. The user downloads a ~984 MB SHA-256-verified engine. A cheap post-stage probe confirms CUDA initializes and cuBLAS loads. Transcription then runs on the GPU, with alignment and diarization on CPU torch.

On a machine with a Radeon or Intel card, the same window says so explicitly in Polish — naming the card — and explains that the transcription engine does not support it, so the CPU variant was installed. On a machine with no GPU, it says that instead.

If CUDA fails at the first real transcription despite the probe passing (a driver/architecture mismatch no cheap probe can catch), the app retries once on CPU, persists "GPU unusable on this machine", and says so — the user never hits a dead end.

Verification: a real reel transcribes end-to-end through the staged GPU exe on the RTX 5070 Ti with `device: "cuda"` in the payload; a wiped deps root re-downloads and re-verifies ~984 MB; `node --experimental-vm-modules test/regression.js` stays green.

### Key Discoveries:

- **The measured artifact is 983.7 MB** (`research.md` Follow-up) — CPU 464,628,987 B, new GPU 1,031,463,399 B, old GPU 3,302,778,914 B. Frozen, booted, `--selftest` exit 0 in 26.7 s.
- **Only two DLLs are needed.** Bisected on real hardware: `cublas64_12.dll` alone fails (cuBLAS needs cuBLASLt); `cublas64_12.dll` + `cublasLt64_12.dll` (751.9 MB raw) → CUDA inference works. **No cuDNN, no `cudart64_12.dll`** — CT2 4.8.0 statically links the rest.
- **`ctranslate2.dll` has zero static CUDA imports** — it resolves CUDA lazily via a plain `LoadLibrary`. `os.add_dll_directory()` does **not** help (it only affects `LoadLibraryEx` with `LOAD_LIBRARY_SEARCH_USER_DIRS`). The DLLs must be on `PATH` or preloaded by absolute path via `ctypes.WinDLL`.
- **`nvidia-cublas-cu12` publishes a `win_amd64` wheel** (verified 2026-07-10, e.g. `nvidia_cublas_cu12-12.9.2.10-py3-none-win_amd64.whl`, 553 MB) containing exactly those two DLLs. The GPU build no longer needs the 3.5 GB torch cu128 wheel merely to harvest them — **`.venv-gpu` disappears from the default build**.
- **CUDA 12.x minor-version compatibility floor on Windows is driver `527.41`** (CUDA Toolkit release notes, Table 2's `>= 525 && < 580` band; the `575.51.03` figure is CUDA 12.9's *bundled* driver, not its floor). This is the only defensible number to gate on — the CT2 wheel documents no compute-capability floor, so gating on one would be inventing a constraint.
- **Enumeration is a false pass.** `WhisperModel(..., device="cuda")` *constructs* successfully without cuBLAS; the failure surfaces at the first matmul inside `encode`. A probe that merely builds the model reports a false green.
- **`whisperx.load_model` has a `model=` seam** (`whisperx/asr.py:357` — `model = model or WhisperModel(...)`), which is what lets CT2 sit on CUDA while VAD stays on CPU torch.
- **The GPU build is a safe superset** (`engine.rs:60`) — a CUDA build on a CPU-only machine self-falls-back. Preserved by this design: CT2 falls back when `get_cuda_device_count() == 0`.
- **macOS today runs VAD on CPU and alignment on MPS.** `cmd_transcribe` passes `device if device != "mps" else "cpu"` to `load_model` (`:401`) but the raw `device` (`"mps"`) to `_align` (`:426`). This asymmetry must be preserved exactly, or the refactor silently changes macOS behavior.

## What We're NOT Doing

- **Not building anything on the user's machine.** No Python provisioning, no `uv`, no local PyInstaller freeze. Open Question #1 is answered: hosting is viable, so the trust anchor survives. The entire "local build" branch of the research is closed.
- **Not shipping ROCm/AMD acceleration.** CT2 issues #2016 (Windows HIP SDK caps at 7.1.1 vs wheels built against ROCm 7.2, `libhipblas.dll` → `hipblas.dll` rename ⇒ crash on load) and #2021 (gfx1201 memory fault) are upstream and unowned, on hardware nobody on the team has. AMD/Intel are **detected and reported**, then given the CPU engine.
- **Not replacing the ASR engine.** whisper.cpp + Vulkan would cover every vendor but has no facility to force-align an *external* transcript, which `align_transcript` (`whisper.rs:827`) requires. FR-002's word-level forced alignment is not negotiable here.
- **Not hosting `engine-gpu-full` in this change.** Its spec entry, staging slot, variant key, and build flag ship — fail-closed, unpinned, unreachable. Phase 1's measurement decides whether it ever gets a URL.
- **Not exposing `gpu-full` in the UI.** It is reachable only via `REEL_ENGINE_VARIANT=gpu-full`, to keep the dropdown honest about what is actually downloadable.
- **Not making `transcription_ready` variant-aware.** It keeps gating the transcribe button on "any engine + FFmpeg resolvable". A new `variant_satisfied` drives auto-open alone.
- **Not implementing HTTP-range resume.** Deferred by S-29 and still deferred; the artifact drops from 3.3 GB to ~984 MB, which materially softens the F4 "restart from zero" finding. An explicit retry button lands instead.
- **Not touching the parser, exporters, selection, or frame math.** `test/regression.js` is the fence that proves it.
- **Not changing macOS.** It still bundles via `tauri.conf.json → bundle.externalBin`, and its device behavior (VAD on CPU, align on MPS) is preserved byte-for-byte.

## Implementation Approach

Five phases, front-loaded on the one number nobody has.

Phase 1 changes the Python engine and the build so a GPU artifact can exist at all, then **measures** the cost of moving alignment and diarization to CPU torch. That measurement is the design's load-bearing assumption, and it gates everything after it. Phase 2 hosts and pins the artifact. Phase 3 makes Rust-side detection honest and fixes the variant-resolution inconsistency that staging a GPU engine would otherwise expose. Phase 4 adds verification in depth — a cheap post-stage probe plus a runtime fallback net for what no cheap probe can catch. Phase 5 surfaces all of it in the ZALEŻNOŚCI window and fixes the two auto-open bugs.

The ordering is deliberate: nothing after Phase 1 is worth building if the measurement says CPU alignment is untenable, and nothing after Phase 2 can be exercised without a real pinned artifact to stage.

## Critical Implementation Details

**Device decoupling is two values, not one flipped value.** The engine currently has one `device`, used for CT2, VAD, alignment, and diarization. After this change CT2's device is probed from `ctranslate2.get_cuda_device_count()` while torch's is probed from `torch.cuda.is_available()` / `torch.backends.mps`, and they may legitimately differ (`cuda` / `cpu` on the shipping GPU build). `--device` overrides the **CT2** device only. The consequence worth stating: the dormant `engine-gpu-full` build gets GPU alignment for free from this same source, because inside it `torch.cuda.is_available()` is simply true. One code path serves all three variants.

**cuBLASLt must be preloaded before cuBLAS.** `cublas64_12.dll` depends on `cublasLt64_12.dll`; loading them in the wrong order fails. Under the current cu128 build this is invisible because `import torch` pulls cuBLAS into the process first and CT2's later `LoadLibrary`-by-name hits the already-loaded module. With CPU torch nothing preloads it, so a PyInstaller runtime hook must `ctypes.WinDLL` them, cuBLASLt first, by absolute path from `sys._MEIPASS`.

**`engine_sidecar()` is argless and memoized, and cannot stay that way.** Fixing `gpu_sidecar_present()` to consult the staged deps root requires an `AppHandle`. Its signature change ripples to the readiness-cache key and the badge; grep every caller before considering Phase 3 complete.

**The cheap probe cannot prove CUDA works.** `get_cuda_device_count() > 0` proves a driver; a successful cuBLAS preload proves the DLLs load. Neither proves the driver has kernel images for this card's architecture — that surfaces only at the first real matmul, as `no kernel image available`. This is why Phase 4 pairs the probe with a runtime fallback net rather than trusting either alone.

**The fallback net must never fight cancellation.** `whisper.rs` already owns `TRANSCRIBE_CHILD` / `TRANSCRIBE_CANCELLED` statics (`:14-15`) and a SIGTERM→300 ms→SIGKILL reaper (`:909`). A cancelled transcription exits non-zero and must **not** be retried on CPU. Check the cancellation flag before the retry decision, and cap the retry at one.

---

## Phase 1: Engine device decoupling, cuBLAS packaging, and the measurement gate

### Overview

Teach the engine to find CUDA through CTranslate2 rather than torch, split the CT2 device from the torch device, and package the two cuBLAS DLLs into the GPU freeze from a pinned PyPI wheel. Then build the artifact and measure what moving alignment and diarization to CPU torch actually costs.

### Changes Required:

#### 1. Device detection and decoupling

**File**: `sidecar/whisperx_engine/whisperx_engine.py`

**Intent**: Replace the torch-only device probe with an independent probe per subsystem, so CT2 can run on CUDA while torch runs on CPU. This is the change the research proved load-bearing — the frozen exe already contains working CUDA and reports `"gpu": false` purely because of this function.

**Contract**: `_detect_device()` (`:131`) is replaced by `_detect_devices() -> (ct2_device, torch_device, gpu, compute_type)`.

- `ct2_device` = `"cuda"` if `ctranslate2.get_cuda_device_count() > 0` else `"cpu"`. Any import or call failure ⇒ `"cpu"`.
- `torch_device` = `"cuda"` if `torch.cuda.is_available()`, else `"mps"` if `torch.backends.mps.is_available()`, else `"cpu"`. Import failure ⇒ `"cpu"`.
- `gpu` = `ct2_device == "cuda" or torch_device in ("cuda", "mps")`.
- `compute_type` = `"float16"` if `ct2_device == "cuda"` else `"int8"`.

`_resolve_device_compute(args)` (`:146`) becomes `_resolve_devices(args)`, returning the same 4-tuple. `--device` overrides **`ct2_device` only** (this is the escape hatch Phase 4's fallback net drives, and it must not be able to push torch onto a CUDA it doesn't have). `--compute-type` overrides `compute_type`. Update the `--device` help text accordingly (`:659`).

**`compute_type` derives from the post-override `ct2_device`**, not the detected one. Today's ordering (`:149-157`) computes `compute_type` from the detected device and only then applies `--device`, so `--device cpu` on a CUDA box leaves `compute_type="float16"`; CTranslate2 silently falls back to `float32` on CPU, materially slower than the `int8` the CPU build uses. That misfires for both consumers of the override — Phase 4's CPU retry, and the existing "Wymuś CPU" checkbox (`transcribe.js:671`). Apply `--device` first, then derive `compute_type` from the result, and let an explicit `--compute-type` still win over both.

#### 2. Transcription call site

**File**: `sidecar/whisperx_engine/whisperx_engine.py`

**Intent**: Put CTranslate2 on the GPU while VAD, alignment, and diarization stay on torch's device, using the `model=` seam whisperx already provides.

**Contract**: at `cmd_transcribe` (`:399-403`), construct `faster_whisper.WhisperModel(args.model, device=ct2_device, compute_type=compute_type)` and pass it as `model=` to `whisperx.load_model`. `load_model`'s positional `device` argument — which it forwards to `VoiceActivitySegmentation(..., device=torch.device(device))` — receives `vad_device`, **not** `ct2_device`.

`vad_device` preserves today's exact behavior: it equals `torch_device`, except `"mps"` collapses to `"cpu"` (mirroring the current `device if device != "mps" else "cpu"` at `:401`). `_align` (`:426`) and `_diarize` (`:437`) receive `torch_device` unchanged — so macOS keeps aligning on MPS and Windows-GPU aligns on CPU.

The same substitution applies to `cmd_align_only` (`:506`) and `cmd_transcribe_cohere` (`:613`), which both call `_resolve_device_compute` and pass the result into `_align`.

#### 3. Readiness probes report the real device

**File**: `sidecar/whisperx_engine/whisperx_engine.py`

**Intent**: Make `--selftest` and `--capability` truthful about CUDA now that the ASR device is no longer torch's device.

**Contract**: `cmd_selftest` (`:226`) and `cmd_capability` (`:251`) both report `gpu` per the `_detect_devices` definition above, plus **two** new explicit fields — `ct2_device` and `torch_device` — and keep the existing `device` key as an alias of `ct2_device` so no consumer breaks on a missing field. `cmd_capability` gains a `cublas` boolean: it reads `os.environ["REEL_CUBLAS_PRELOAD"]` (set by the §4 runtime hook) and emits `true` iff it equals `"ok"`. Absent ⇒ `false` on a GPU build; the field is meaningless on a CPU build. `_selftest_align_runs` keeps running on CPU — its failure mode was an import error, which is device-agnostic.

**Why two fields and not one.** Collapsing to `device = ct2_device` silently regresses macOS: CT2 has no MPS backend, so `ct2_device` is always `"cpu"` there, and the readiness badge — which renders `` `${status.device || 'cpu'}${status.gpu ? ', GPU' : ''}` `` (`src/ui/import/transcribe.js:261`) — would fall from `"mps, GPU"` to `"cpu, GPU"`, contradicting this plan's own "not changing macOS" guarantee. Reporting the pair is truthful for all three variants at once: macOS `cpu`/`mps`, the shipping Windows GPU build `cuda`/`cpu`, `gpu-full` `cuda`/`cuda`. Phase 5 renders both.

#### 4. cuBLAS preload runtime hook

**File**: `sidecar/rthook_cublas.py` *(new)*

**Intent**: Load the two cuBLAS DLLs into the process by absolute path before CTranslate2 first touches CUDA, and record whether it worked so `--capability` can report it.

**Contract**: a PyInstaller runtime hook that is a silent no-op off Windows or when the DLLs are absent (the CPU build ships without them). Order is load-bearing and counterintuitive, and `os.add_dll_directory` is a trap here — CT2 uses a plain `LoadLibrary`, which ignores it:

```python
# cuBLASLt FIRST — cublas64_12.dll depends on it. sys._MEIPASS, not add_dll_directory:
# CT2 resolves CUDA via a plain LoadLibrary, which ignores the user-dirs search path.
base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__)))
for name in ("cublasLt64_12.dll", "cublas64_12.dll"):
    ctypes.WinDLL(os.path.join(base, name))
```

On success set `os.environ["REEL_CUBLAS_PRELOAD"] = "ok"`; on any failure set `"fail:<reason>"`. Never raise — a CPU build has no DLLs and must boot cleanly.

#### 5. PyInstaller spec

**File**: `sidecar/whisperx_engine.spec`

**Intent**: Bundle the cuBLAS DLLs into the GPU freeze only, and register the preload hook.

**Contract**: `binaries=` (`:120`) is populated from an `ENGINE_CUBLAS_DIR` environment variable — every `*.dll` in that directory, targeted at the bundle root `"."`. Unset ⇒ `binaries=[]`, which is exactly today's CPU build. `runtime_hooks=` (`:124`) gains `rthook_cublas.py`. Nothing else changes; the existing `datas`, `hiddenimports`, and `copy_metadata` blocks are untouched.

#### 6. Build script

**File**: `sidecar/build.sh`

**Intent**: Make `GPU=1` produce the CT2-CUDA + torch-CPU build from the **CPU** venv, sourcing cuBLAS from a pinned PyPI wheel — and keep the old cu128 path alive behind a separate flag for the dormant `engine-gpu-full` variant.

**Contract**: three build modes, selected by env:

| Env | Output base name | venv | torch | cuBLAS |
|---|---|---|---|---|
| *(none)* | `whisperx-engine` | `.venv` | `+cpu` | none |
| `GPU=1` | `whisperx-engine-gpu` | `.venv` | `+cpu` | from wheel |
| `GPU=1 ENGINE_TORCH_CUDA=1` | `whisperx-engine-gpu-full` | `.venv-gpu` | `+cu128` | from torch |

Under `GPU=1` (without `ENGINE_TORCH_CUDA`), `build.sh` downloads a **pinned** `nvidia-cublas-cu12` win_amd64 wheel into a scratch dir, extracts `nvidia/cublas/bin/{cublas64_12.dll,cublasLt64_12.dll}`, and exports `ENGINE_CUBLAS_DIR` to that dir before the freeze. Pin to the wheel release on the **CUDA 12.8 line** (matching the DLLs the research actually measured against), and record the exact version *and* the wheel's SHA-256 as a comment in `build.sh` — this is a supply-chain input to a signed artifact and must be reproducible, not floating.

The `TORCH_INDEX` cu128 branch (`:100-105`) now fires only under `ENGINE_TORCH_CUDA=1`; the `CUDA` env override rides along with it. The `.venv` / `.venv-gpu` split (`:67-68`) is likewise keyed on `ENGINE_TORCH_CUDA`, not `GPU`. Note in the header comment that `GPU=1` no longer implies a CUDA torch wheel.

#### 7. Measurement harness

**File**: scratchpad (not committed)

**Intent**: Produce the number this design rests on. The research proved GPU inference **in-venv** and proved the frozen exe boots, but never proved GPU inference **through the frozen exe** — because reaching it required exactly the changes above.

**Contract**: run one representative reel (real speech, ≥ 2 minutes, Polish, diarization on) three ways and record per-phase wall clock by timestamping the `PROGRESS phase=<transcribe|align|diarize>` lines the engine already emits on stderr (`whisperx_engine.py:115`, parsed at `whisper.rs:352`):

1. today's CPU exe (`whisperx-engine-*.exe`, torch+cpu),
2. today's GPU exe (`whisperx-engine-gpu-*.exe`, torch+cu128) — the baseline being traded away,
3. the new GPU exe (CT2-CUDA + torch-CPU).

Append the resulting table to `research.md` under a new "Follow-up: measured phase timings" heading.

**The gate**, evaluated against that table:

- **Gate A (must pass, else the whole design fails):** the new GPU exe's total wall clock is meaningfully below the CPU exe's. If GPU transcription doesn't beat CPU end-to-end, there is no GPU path.
- **Gate B (escalation trigger):** the new GPU exe's total wall clock is **≤ 1.3× the cu128 GPU exe's**. If it exceeds that, CPU alignment dominates, and `engine-gpu-full` must be activated rather than left dormant. It **cannot** go where the CPU engine lives: at 3.08 GiB it exceeds GitHub Releases' 2 GB per-asset cap — the exact constraint this whole design exists to route around. Its host is a HuggingFace model repo, staged through `deps.rs`'s existing `repo` + `files` dependency shape (`Dependency.repo`/`Dependency.files`, `download_dir`), which `validate_hashes()` (`deps.rs:809`) fail-closes on identically. Phase 2 ships the entry in that shape, unpinned; activating it means filling in the digest, not inventing a mechanism.

Also confirm `--capability` on the new exe now reports `{"gpu": true, "device": "cuda", "cublas": true}` — the research's build reported `"gpu": false`, and flipping that is the proof these code changes are load-bearing.

### Success Criteria:

#### Automated Verification:

- The CPU build still freezes and boots: `sidecar/build.sh` then `"src-tauri/binaries/whisperx-engine-$(triple).exe" --selftest` exits 0 with `"gpu": false, "device": "cpu"`
- The GPU build freezes: `GPU=1 sidecar/build.sh` produces `whisperx-engine-gpu-<triple>.exe`
- The GPU exe's `--capability` reports `"gpu": true`, `"device": "cuda"`, `"cublas": true`
- The GPU exe's `--selftest` exits 0 with `alignment_model_ready: true`
- The frozen GPU artifact is under 2 GB (`ls -l`, expect ~1.03 GB)
- The GPU build's venv contains `torch+cpu`, not `torch+cu128` (`python -c "import torch; print(torch.__version__)"`)
- `--device cpu --capability` on the GPU exe reports `ct2_device: "cpu"` and a `compute_type` of `int8`, not `float16` — the override-ordering fix
- Regression fence unaffected: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- A real reel transcribes end-to-end through the frozen GPU exe with `device: "cuda"` in the result payload — GPU inference proven **through the exe**, not just in-venv
- Per-phase timings recorded for all three builds and appended to `research.md`
- Gate A passes: new GPU exe beats the CPU exe on total wall clock
- Gate B evaluated and the `engine-gpu-full` activate/dormant decision recorded in `change.md`
- macOS unaffected: `sidecar/build.sh` on arm64 still runs alignment on MPS and VAD on CPU, and `--capability` reports `ct2_device: "cpu"`, `torch_device: "mps"`, `gpu: true` — so the readiness badge still names `mps` for alignment, exactly as before this change

**Implementation Note**: This phase ends at a hard decision gate. Do not start Phase 2 until Gate A passes and Gate B's verdict is written down — hosting a gigabyte is not something to undo. Pause for manual confirmation.

---

## Phase 2: Host, pin, and extend the spec

### Overview

Upload the measured artifact, pin its digest into the embedded spec, and add the dormant `engine-gpu-full` entry with its variant plumbing.

### Changes Required:

#### 1. Artifact hosting

**File**: *(release infrastructure, not the repo)*

**Intent**: Publish the GPU engine at a stable versioned URL alongside the CPU engine and FFmpeg, which already live on `GarniczAndrzej/reel-automator-deps`.

**Contract**: a new release tag `deps-v1.1.0` on that repo carries `whisperx-engine-gpu-x86_64-pc-windows-msvc.exe`. The existing `deps-v1.0.0` assets (CPU engine, FFmpeg) stay where they are and keep their `1.0.0` dep `version` — nothing about them changed, and re-pointing them would mark every installed copy stale. Compute the digest with `Get-FileHash -Algorithm SHA256`.

#### 2. Embedded spec

**File**: `src/deps/deps-spec.json`

**Intent**: Turn the stubbed GPU entry into a real, pinned, downloadable dependency; add the dormant escape-hatch entry; invalidate stale dismissals.

**Contract**:

- `engine-gpu-windows-x86_64`: real `url` (the `deps-v1.1.0` asset), real lowercase-hex `sha256`, `sizeBytes` = the measured byte count, `version` → `"1.1.0"`. `sentinel` and `stageTo` unchanged.
- New `engine-gpu-full-windows-x86_64`: `variantPredicate: "gpu-full"`, `stageTo: "engine-bin"`, `sentinel: "whisperx-engine-gpu-full-x86_64-pc-windows-msvc.exe"`, `sizeBytes: 3302778914`. Because 3.08 GiB exceeds GitHub's 2 GB per-asset cap, this entry uses the **HF shape**, not the `url` shape: a `repo` (a HuggingFace model repo under the project's account) plus a one-element `files[]` naming the exe with **`sha256: ""`**. The empty per-file digest makes `validate_hashes()` (`deps.rs:809`) refuse to stage it via its `files` branch (`deps.rs:810-822`) — that is the point, and it is the same mechanism protecting the GPU entry today. Activating it later is a digest fill-in, no schema or downloader change.
- `specVersion`: `1` → `2`. Phase 5 keys dismissal to this, so bumping it re-opens the window once for everyone.
- Rewrite `_note` so the dormant entry reads as **deliberate, not abandoned**: say that `engine-gpu-full` is an opt-in CUDA-torch build reachable only via `REEL_ENGINE_VARIANT=gpu-full`; that it lives on HuggingFace rather than GitHub Releases because 3.08 GiB exceeds the 2 GB per-asset cap; that it is intentionally unpinned until Phase 1's Gate B demands it; and that the downloader therefore fail-closes on it by design. Drop the stale sentence claiming the *GPU* entry is unpinnable for lack of a no-cap host — Phase 1 shrank it to ~984 MB and Phase 2 pins it on GitHub.

#### 3. Variant plumbing for `gpu-full`

**Files**: `src-tauri/src/deps.rs`, `src-tauri/src/engine.rs`

**Intent**: Let the third variant key resolve, stage, and spawn — without it being auto-selectable.

**Contract**:

- `staged_path` (`deps.rs:327`), `"engine-bin"` arm: variant `"gpu-full"` maps to base name `whisperx-engine-gpu-full` under `root/engine/gpu-full/`. The existing `gpu` / else-`cpu` branching becomes a three-way match.
- `resolve_variant` (`deps.rs:271`) accepts `"gpu-full"` from the **env override only** — never from hardware detection, and not from the persisted UI override: `set_variant_override` (`deps.rs:635`) normalizes anything outside `gpu`/`cpu` to `""`, and keeping `gpu-full` out of the UI is deliberate (see "What We're NOT Doing"). Hardware can yield `gpu` or `cpu`, nothing else.
- `engine.rs` gains `ENGINE_SIDECAR_GPU_FULL: &str = "whisperx-engine-gpu-full"`, and `resolve_engine_variant` (`engine.rs:159`) maps the variant string to it.
- `engine_bin_path` (`engine.rs:201`) fallback chain: a `gpu-full` selection that resolves nowhere falls back to `gpu`, then to `cpu`. Never spawn a missing exe.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- The embedded spec parses: the existing `embedded_spec()` unit test stays green
- `validate_hashes_fails_closed_on_empty` (`deps.rs:1137`) still passes — now with a *real* dormant entry exercising it
- New unit test: `validate_hashes` rejects the `engine-gpu-full` entry through its `files[]` branch (empty per-file `sha256`), not only the top-level `sha256` branch
- New unit test: `required_deps(spec, "windows", "x86_64", "gpu")` yields the GPU engine and FFmpeg, and **excludes** `engine-gpu-full`
- New unit test: `staged_path(root, "engine-bin", "gpu-full", triple)` ends in `engine/gpu-full/whisperx-engine-gpu-full-<triple>.exe`
- New unit test: `resolve_variant(Some("gpu-full"), None, false) == "gpu-full"`, `resolve_variant(None, Some("gpu-full"), false) == "cpu"` (the UI override cannot select it), and `resolve_variant(None, None, true) == "gpu"` (hardware can never yield `gpu-full`)

#### Manual Verification:

- The published asset's `Get-FileHash` output matches the `sha256` committed to the spec, byte for byte
- Downloading the GPU engine through the ZALEŻNOŚCI window succeeds and stages to `deps_root/engine/gpu/`
- Corrupting one byte of the staged artifact and re-running the download makes the checksum gate reject it
- `REEL_ENGINE_VARIANT=gpu-full` surfaces the dormant dep as required, and attempting to download it fails closed with a Polish error rather than staging anything

**Implementation Note**: Pause for manual confirmation that the real download + verify path works against the live host before moving on.

---

## Phase 3: Honest hardware detection

### Overview

Replace the single `nvidia-smi -L` bool with a hardware profile that can name the card, read its VRAM and driver, gate on a real driver floor, and see AMD and Intel adapters. Fix the variant-resolver inconsistency that staging a GPU engine exposes.

### Changes Required:

#### 1. NVIDIA profiling

**File**: `src-tauri/src/deps.rs`

**Intent**: Learn *which* NVIDIA card is present and whether its driver clears the CUDA 12.x floor, at the same cost as today's probe.

**Contract**: a new memoized `nvidia_query()` spawns `nvidia-smi --query-gpu=name,memory.total,compute_cap,driver_version --format=csv,noheader,nounits` and parses the first row. The parser is **tolerant**: any missing field, unexpected column count, non-numeric value, or non-zero exit yields `None`, and `None` fails safe to CPU — exactly as `nvidia_gpu_present()` does today (`deps.rs:227`). `memory.total` is reported in MiB by `nvidia-smi`; convert to bytes.

Gate: `driver_version` parsed as `major.minor` and compared against `DRIVER_FLOOR_WINDOWS = 527.41`. Below the floor ⇒ `cuda_usable = false` with a Polish reason naming the installed and required versions. `compute_cap` and VRAM are **reported, never gated** — the CT2 wheel documents no compute-capability floor, and Phase 4's probe plus the runtime net adjudicate everything above the driver floor.

Keep `nvidia_gpu_present()` as a thin wrapper over `nvidia_query().is_some()` so no existing caller breaks mid-phase.

#### 2. DXGI adapter enumeration

**Files**: `src-tauri/Cargo.toml`, `src-tauri/src/deps.rs`

**Intent**: See AMD and Intel cards, so the app can tell a Radeon owner what it found instead of only what it didn't.

**Contract**: add `windows` under `[target.'cfg(windows)'.dependencies]` with the `Win32_Graphics_Dxgi`, `Win32_Graphics_Dxgi_Common`, and `Win32_Foundation` features. A `#[cfg(windows)] fn dxgi_adapters() -> Vec<Adapter>` calls `CreateDXGIFactory1` → `EnumAdapters1` → `GetDesc1`, yielding `(vendor_id, description, dedicated_video_memory)`.

Skip the Microsoft Basic Render Driver (`vendor_id == 0x1414`, or a description containing `Basic Render`) — it is a software adapter present on every machine and would otherwise read as a GPU. Map `0x10DE` → nvidia, `0x1002` → amd, `0x8086` → intel, anything else → unknown. Never read VRAM from WMI's `Win32_VideoController.AdapterRAM`: it is a signed 32-bit field that saturates near 4 GB.

DXGI is a **reporting signal only**. It must never influence variant selection — a card existing is not a runtime working. Non-Windows builds get a stub returning an empty vector.

#### 3. The hardware profile command

**Files**: `src-tauri/src/deps.rs`, `src-tauri/src/lib.rs`

**Intent**: Give the UI one spawn-free (S-18) call that answers "what is in this box, what did you pick, and why", in Polish.

**Contract**: a memoized `#[tauri::command] pub fn gpu_info() -> GpuInfo`, serialized camelCase:

```rust
struct GpuInfo {
    vendor: String,            // "nvidia" | "amd" | "intel" | "none" | "unknown"
    name: String,              // adapter description, e.g. "NVIDIA GeForce RTX 5070 Ti"
    vram_bytes: u64,           // 0 when unknown
    compute_cap: Option<String>,
    driver_version: Option<String>,
    cuda_usable: bool,         // NVIDIA + driver >= floor
    variant: String,           // the resolved variant, from detect_variant()
    reason: String,            // one Polish sentence: what was found, what was picked, why
}
```

`reason` is the only user-facing string and covers at minimum: NVIDIA above floor; NVIDIA below floor (name both versions); AMD present; Intel present; no GPU; a persisted `gpuUnusable` verdict overriding a present NVIDIA. Keep the sentences Polish.

#### 4. Persisted unusable-GPU verdict

**File**: `src-tauri/src/deps.rs`

**Intent**: Let Phase 4's probe and fallback net durably demote a machine to CPU without the user fighting auto-detection every launch.

**Contract**: `deps-settings.json` gains `gpuUnusable: "1"` (written through the existing `write_settings_field`, `deps.rs:465`). `detect_variant()` (`:291`) reads it and folds it into the hardware term.

`resolve_variant` stays pure and unit-testable — its third parameter changes meaning from `gpu_present` to `gpu_usable`, computed by the caller as `nvidia_query().map_or(false, |q| q.cuda_usable) && !gpu_unusable`. Precedence is unchanged: env override → UI override → `gpu_usable` → cpu. An explicit override still wins over the verdict, so a user who fixes their driver can force `gpu` back on without editing JSON.

**Flipping the variant string is not sufficient to demote.** A GPU box downloads only the GPU engine (`required_deps` for variant `gpu` excludes the CPU entry), so after `gpuUnusable` is written `detect_variant()` returns `cpu` while `engine_bin_path` still resolves — and spawns — the GPU exe, which re-detects CUDA through `get_cuda_device_count()` and fails exactly as before. The verdict must therefore also reach the **engine's device selection**: `pub fn gpu_unusable() -> bool` (a `read_settings_field("gpuUnusable")` reader) is consulted at the `whisper.rs` spawn sites, and when it is true — and the caller passed no explicit `--device` — `--device cpu` is appended. That is what actually demotes the machine, and it works regardless of which exe `engine_bin_resolved` handed back.

#### 5. Variant-aware presence, and the `gpu_sidecar_present` fix

**Files**: `src-tauri/src/engine.rs`, `src-tauri/src/deps.rs`, `src-tauri/src/lib.rs`

**Intent**: Close the latent bug where a staged-only GPU engine is spawned as GPU while the badge reports CPU — which this change triggers on day one — and give the UI the signal that drives auto-open.

**Contract**:

- Delete `gpu_sidecar_present()` (`engine.rs:30`). `engine_sidecar()` (`:65`) becomes `engine_sidecar(app: &AppHandle) -> &'static str` and applies its presence guard via `resolve_engine_variant(app, variant, triple).is_some()` — the same resolver the spawn path uses, staged deps root included. **Drop the `OnceLock` memoization.** It is safe today only because the guard reads repo `binaries/` and beside-exe, which cannot change while the process runs; once it reads the staged deps root it is memoizing a value Phase 5 mutates mid-session (download → `verify_staged_engine` in the same launch). A frozen answer makes `readiness_cache_key` (`engine.rs:300-307`, which folds `engine_sidecar()` into the hash) file the fresh GPU verdict under the pre-download CPU key, so the badge reads stale until relaunch. The guard is two or three `is_file()` stats — well inside the S-18 spawn-free budget — and `detect_variant()` is already deliberately un-memoized for exactly this reason. `nvidia_gpu_present()` / `nvidia_query()` stay memoized: host hardware genuinely does not change within a run.
- **Grep every caller** of `engine_sidecar()` (`whisperx_engine_cached`, `readiness_cache_key`, the badge) and thread the `AppHandle` through; this signature change is the phase's main ripple.
- New `#[tauri::command] pub fn variant_satisfied(app: AppHandle) -> bool`: true when the **resolved** variant's engine resolves anywhere in the three-way precedence *and* FFmpeg resolves. Spawn-free. This is what Phase 5's auto-open consults.
- **The spawned exe's variant must be knowable to callers.** `engine_bin_path` (`engine.rs:201`) cross-falls-back in *both* directions — a `gpu` selection with no GPU binary spawns the CPU exe, and (via the `if !want_gpu` branch, `engine.rs:212-216`) a `cpu` selection with no CPU binary spawns the **GPU** exe. So `detect_variant()` is not a reliable answer to "what is actually running". Add `pub fn engine_bin_resolved(app: &AppHandle) -> Result<(PathBuf, &'static str), String>` returning the path **and** the variant that path belongs to; reimplement `engine_bin_path` as a thin wrapper over it (`.map(|(p, _)| p)`) so no existing caller changes. Phase 4's demotion and retry gate both consult this, never `detect_variant()`.
- `transcription_ready` (`deps.rs:651`) is **unchanged**. Extend its doc comment to state the split explicitly: it answers "can this machine transcribe at all" and gates the button; `variant_satisfied` answers "is it running the engine its hardware deserves" and drives only the nag. Conflating them would disable transcription on a working CPU engine and gate off every `tauri dev` checkout.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Rust build passes: `~/.cargo/bin/cargo build --manifest-path src-tauri/Cargo.toml`
- New unit test: the `nvidia-smi` CSV parser handles a well-formed row, a truncated row, a non-numeric VRAM, an empty string, and a trailing-newline row — every malformed case yielding `None`
- New unit test: driver floor comparison — `527.41` passes, `527.40` fails, `576.02` passes, an unparseable string fails
- New unit test: `vendor_from_id` maps `0x10DE`/`0x1002`/`0x8086` and rejects `0x1414`
- New unit test: `resolve_variant(None, None, false) == "cpu"` when `gpu_usable` is false because of a persisted `gpuUnusable`, and `resolve_variant(Some("gpu"), None, false) == "gpu"` (explicit override beats the verdict)
- Regression fence: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- `gpu_info()` on the RTX 5070 Ti reports vendor `nvidia`, the real card name, real VRAM, a compute cap, a driver version, `cudaUsable: true`, and a sensible Polish `reason`
- On the same machine with `REEL_ENGINE_VARIANT=cpu`, `reason` explains the override rather than the hardware
- A staged-only GPU engine (deps root populated, repo `binaries/` empty) now makes the readiness badge report GPU — the bug this phase fixes
- `variant_satisfied` returns false on a GPU box holding only the CPU engine, while `transcription_ready` still returns true
- `tauri dev` from a checkout with only the CPU binary in `binaries/`, **on the NVIDIA dev box**, reports `transcription_ready: true` — the transcribe button is not gated
- The same checkout reports `variant_satisfied: false` (resolved variant is `gpu`, no GPU binary anywhere), so the ZALEŻNOŚCI window auto-opens. This is correct, not a bug: the dev nag is suppressed by dismissing once (the `{ specVersion, variant }` record) or by `REEL_ENGINE_VARIANT=cpu`. Do **not** weaken `variant_satisfied` to make it green

**Implementation Note**: Pause for manual confirmation. The AMD/Intel branch cannot be exercised on real hardware — its unit tests are the only proof, so read the vendor-id constants twice.

---

## Phase 4: Post-stage verification and the runtime fallback net

### Overview

Prove CUDA works as far as a cheap probe can, then catch what it cannot. Verification in depth: the probe rejects a broken cuBLAS load; the net rejects a driver that has no kernel image for this card.

### Changes Required:

#### 1. Rust reads the engine's cuBLAS + device-pair fields

**File**: `src-tauri/src/engine.rs`

**Intent**: Surface the Phase 1 sidecar fields — `cublas`, `ct2_device`, `torch_device` — through the Rust readiness type so `verify_staged_engine` can act on them. The Python side already emits them (Phase 1 §3/§4; criterion 1.3 asserts `cublas: true`), so nothing in `whisperx_engine.py` changes here.

`EngineStatus` (`engine.rs:274`) gains three fields, each `#[serde(default)]` so every pre-existing cached readiness verdict on disk stays readable, exactly as `authoritative` did: `pub cublas: Option<bool>`, `pub ct2_device: String`, `pub torch_device: String` (the device pair from Phase 1 §3). The legacy `device` field stays and continues to carry `ct2_device`.

**`serde(default)` alone is not enough here, and this is the trap.** Unlike `authoritative` — which the Rust command stamps and never reads back from the sidecar — `cublas` originates in the engine's JSON. But `EngineStatus` is *never* deserialized from that JSON: `parse_engine_status` (`engine.rs:274`) hand-maps each field out of a `serde_json::Value`. The derive only governs the disk-cache read. So `parse_engine_status` must **also** gain `cublas: v["cublas"].as_bool()`, alongside `ct2_device` / `torch_device` read the same way. Without that line the field is `None` on every live probe, `cublas == Some(false)` never matches, and `verify_staged_engine` silently green-lights the one failure mode it exists to catch (preload failed, yet CT2 still sees a device ⇒ `gpu: true`).

#### 2. Post-stage verification command

**Files**: `src-tauri/src/engine.rs`, `src-tauri/src/lib.rs`

**Intent**: Immediately after a GPU engine is staged — off the launch path, on an explicit user action — confirm it can actually see CUDA, and durably demote the machine if it cannot.

**Contract**: `#[tauri::command] pub async fn verify_staged_engine(app: AppHandle) -> Result<EngineStatus, String>` runs the existing `--capability` path (bounded by `CAPABILITY_TIMEOUT`, `engine.rs:77`). When the resolved variant is `gpu` (or `gpu-full`) and the reply has `gpu == false` or `cublas == Some(false)`, write `gpuUnusable = "1"` via `deps.rs`'s settings writer and return the status so the UI can explain it in Polish.

This is invoked by the frontend after a successful engine download — never at boot. S-18's rule holds: nothing spawns the engine on the launch path.

All three new commands — `gpu_info` and `variant_satisfied` (Phase 3), `verify_staged_engine` (here) — must be added to `tauri::generate_handler![]` in `lib.rs`. An unregistered command fails only at `invoke()` time, i.e. in Phase 5, far from where it was written.

#### 3. Runtime fallback net

**File**: `src-tauri/src/whisper.rs`

**Intent**: A driver that passes the probe but has no kernel image for this card fails at the first matmul inside `encode`. Catch it, retry on CPU once, and remember.

**Contract**: in the `drive_engine` callers (`transcribe_video` at `:558`, `align_transcript` at `:827`), when the engine exits with `EXIT_TRANSCRIBE_FAIL` (14) **and** stderr matches a CUDA marker (case-insensitive `cublas`, `no kernel image`, or `CUDA`), **and** the exe that was actually spawned is a GPU build — the second element of `engine_bin_resolved` (Phase 3 §5), **not** `detect_variant()` — **and** the caller did not pass an explicit `--device`:

Keying on the spawned exe rather than the variant string is load-bearing. `engine_bin_path` falls back to the GPU exe when a `cpu` selection has no CPU binary staged (`engine.rs:212-216`), so a `REEL_ENGINE_VARIANT=cpu` box holding only the GPU engine runs CUDA under a `cpu` variant label. Gating on the label would leave that user with a CUDA crash and no retry — the dead end this phase exists to prevent.

1. Check `TRANSCRIBE_CANCELLED` (`whisper.rs:15`) first — a cancelled run exits non-zero and must **never** be retried.
2. Persist `gpuUnusable = "1"`.
3. Re-spawn **once** with `--device cpu` appended. The `--device` override targets the CT2 device only (Phase 1 contract), so torch is unaffected.
4. Emit a Polish notice through the existing `transcribe-progress` channel or a toast: the GPU turned out unusable, the transcription continued on CPU, and the app will use CPU from now on.

Cap the retry at one via a local flag; a second failure surfaces the original error through `engine_error_message` (`whisper.rs:182`). The retry must reuse the existing cancellation plumbing, not a second mechanism.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- New unit test: the CUDA-marker matcher fires on `Library cublas64_12.dll is not found or cannot be loaded`, on `no kernel image is available for execution on the device`, and does **not** fire on a plain `model not found` or an out-of-memory message
- New unit test: the retry decision returns false when the cancellation flag is set, regardless of exit code or stderr
- New unit test: the retry decision fires when the **spawned exe** is a GPU build even though `detect_variant()` returned `cpu`, and does not fire when a CPU exe was spawned
- New unit test: `engine_bin_resolved` returns the `gpu` variant tag when only the GPU binary is present and `detect_variant()` is `cpu`
- New unit test: `EngineStatus` deserializes from a cached JSON verdict lacking the `cublas` field
- Regression fence: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- `verify_staged_engine` on the RTX 5070 Ti returns `gpu: true, cublas: true` and writes no `gpuUnusable`
- Deliberately break the probe — rename `cublasLt64_12.dll` inside a copy of the staged exe's extraction, or run with a doctored `REEL_CUBLAS_PRELOAD` — and confirm `gpuUnusable` is persisted and the Polish explanation appears
- Force the net: run a transcription with a simulated CUDA failure and confirm exactly one CPU retry, a persisted verdict, a Polish notice, and a correct result payload
- Cancel a GPU transcription mid-run and confirm **no** CPU retry fires and no `gpuUnusable` is written
- After a demotion, with **only the GPU engine staged**, the next transcription spawns that same GPU exe but passes `--device cpu` and succeeds on the first attempt — no failed run, no second retry. `gpu_info().reason` explains the demotion in Polish
- With `REEL_ENGINE_VARIANT=cpu` and only the GPU engine staged, a CUDA failure still triggers exactly one CPU retry (the mirror case the variant label hides)

**Implementation Note**: Pause for manual confirmation. The cancel-vs-retry interaction is the highest-risk logic in this change — exercise it explicitly.

---

## Phase 5: ZALEŻNOŚCI window — hardware panel, variant-aware auto-open, dismissal scoping

### Overview

Surface the hardware profile in Polish, make the window open when — and only when — the machine needs it, and give the user the retry affordance plan-review F4 asked for.

### Changes Required:

#### 1. Hardware panel markup

**File**: `src/index.html`

**Intent**: A place to state what was detected and why the variant was chosen, above the override dropdown that lets the user disagree.

**Contract**: a `#depsHardwareInfo` block inserted before the "Wariant sprzętowy" heading (`:645`), rendering the card name, VRAM, driver version, and the Polish `reason`. The existing `#depsVariantSelect` (`:659-663`) and `#depsVariantNote` are unchanged. Follow the surrounding inline-style conventions rather than introducing a stylesheet.

#### 2. Render the profile

**File**: `src/ui/first-run-deps.js`

**Intent**: Paint the hardware panel from the new backend command.

**Contract**: `refreshDepsView()` (`:145`) adds `gpu_info` to its existing fan-out (`load_deps_spec`, `deps_status`, `get_deps_root`, `deps_root_space`, `get_variant`, `get_variant_override`) and a `renderHardware(info)` writes it into `#depsHardwareInfo`. `depLabel()` (`:261`) gains a `gpu-full` case → `'Silnik WhisperX (GPU / CUDA + torch)'`. All strings Polish; every function carries JSDoc types per the repo's type-discipline rule.

#### 3. Variant-aware auto-open and scoped dismissal

**File**: `src/ui/first-run-deps.js`

**Intent**: Fix both bugs the roadmap bundles into this slice.

**Contract**:

- `maybeAutoOpen()` (`:108-121`) consults **`variant_satisfied`**, not `transcription_ready`. A GPU box holding only the CPU engine now opens the window — while its transcribe button stays enabled, because that is still gated by `transcription_ready`.
- `DISMISS_LS_KEY` (`:21`) stores JSON `{ specVersion, variant }` instead of `'1'`. Auto-open is suppressed only when the stored record matches the *current* `specVersion` (from `load_deps_spec`) **and** the *current* resolved variant. Either changing re-opens the window exactly once.
- **Legacy migration**: a stored literal `'1'` is a dismissal for an unknown state. Treat it as `{ specVersion: 0, variant: '' }`, which never matches, so the window re-opens once after upgrade and is then re-stored in the new shape. This is intentional — `specVersion` bumps to 2 in Phase 2 precisely so every existing install re-evaluates once.

#### 4. Post-download verification and retry

**File**: `src/ui/first-run-deps.js`

**Intent**: Run the probe at the only moment it is useful, and stop losing a ~984 MB download to a transient network error.

**Contract**:

- `downloadDep()` (`:296`), on success for a dependency of `kind === 'engine'`, invokes `verify_staged_engine` and toasts the verdict in Polish — confirming CUDA, or explaining the demotion to CPU.
- On failure, the dep row's button becomes an explicit **"Ponów"** (retry) rather than an auto-silent restart — plan-review F4, still unimplemented. Keep the `_downloadingId` single-flight guard (`:28`).
- The per-dep progress line (`:244`) gains a determinate bar alongside the existing `%· MB/s · ETA` text, mirroring `#whisperProgressBox` (`src/index.html:272`).

#### 5. Readiness badge renders the device pair

**File**: `src/ui/import/transcribe.js`

**Intent**: Show which device transcribes and which device aligns, now that they can differ.

**Contract**: the badge line (`:261`) reads `status.ct2Device` / `status.torchDevice` instead of the single `status.device`, falling back to `status.device` when the pair is absent (a verdict cached by an older build). Render them distinctly — e.g. `transkrypcja: cuda · dopasowanie: cpu` — so a Mac still reads `mps` for alignment and a Windows GPU box reads `cuda` for transcription. Update the JSDoc `@param` on `:251` to carry the two new optional fields. Polish, per the repo rule.

#### 6. Documentation

**Files**: `CLAUDE.md`, `context/foundation/roadmap.md`, `context/changes/gpu-engine-autodetect/change.md`

**Intent**: Keep the repo's own guidance true.

**Contract**: `CLAUDE.md`'s backend command table gains `gpu_info`, `variant_satisfied`, and `verify_staged_engine`; its Windows thin-installer note records that the GPU engine is CT2-CUDA + torch-CPU with baked cuBLAS, that alignment and diarization run on CPU torch, and that `engine-gpu-full` exists but is dormant. `roadmap.md`'s S-30 entry moves to `Status: done`, and its "Blockers" paragraph — which names the 3.3 GB no-cap-host problem as "the slice's gating task" — is rewritten to record how it was dissolved. `change.md` moves to `status: implemented`.

### Success Criteria:

#### Automated Verification:

- Prettier clean: `npx prettier --check "src/**/*.{js,css,html}"`
- Regression fence: `node --experimental-vm-modules test/regression.js`
- Rust build passes: `~/.cargo/bin/cargo build --manifest-path src-tauri/Cargo.toml`
- No `transcription_ready` reference remains in `maybeAutoOpen` (grep `src/ui/first-run-deps.js`)

#### Manual Verification:

- On the RTX 5070 Ti with an empty deps root, the window auto-opens and names the card, its VRAM, its driver, and why GPU was chosen
- Downloading the GPU engine shows a determinate progress bar, verifies, probes, and toasts a Polish success
- **Without relaunching**, the readiness badge flips to the GPU verdict after that download — proving `engine_sidecar()` re-resolves and the verdict is cached under the GPU key (the `OnceLock` removal, Phase 3 §5)
- Interrupting the download mid-transfer leaves an explicit "Ponów" button, and retrying completes
- After provisioning, relaunch does **not** open the window
- "Pomiń na razie", then relaunch: window stays shut. Then set `REEL_ENGINE_VARIANT=cpu` and relaunch: window opens once (variant changed), and stays shut on the launch after
- An upgrade from a build holding the legacy `'1'` dismissal opens the window exactly once, then stays shut
- A GPU box holding only the CPU engine: window opens, transcribe button stays **enabled**
- The readiness badge names both devices — `cuda` for transcription, `cpu` for alignment on the shipping Windows GPU build — and degrades to the single `device` string when reading a verdict cached by an older build
- All new strings are Polish, with correct diacritics in the rendered webview

**Implementation Note**: Pause for manual confirmation of the full first-run flow on a wiped deps root before considering the change complete.

---

## Testing Strategy

### Unit Tests:

Rust (`src-tauri/src/deps.rs`, `engine.rs`, `whisper.rs` test modules — follow the existing `#[cfg(test)]` structure):

- `nvidia-smi` CSV parsing: well-formed, truncated, non-numeric, empty, trailing newline
- Driver floor comparison across the `527.41` boundary and on unparseable input
- DXGI vendor-id mapping, including the Basic Render Driver rejection
- `resolve_variant` precedence with the new `gpu_usable` term and the `gpu-full` key; explicit override beats a persisted `gpuUnusable`
- `staged_path` for all three variants
- `required_deps` excludes `engine-gpu-full` for variant `gpu`
- `validate_hashes_fails_closed_on_empty` — unchanged, now guarding a real dormant entry
- CUDA-marker matcher: fires on the two real messages, not on unrelated failures
- Retry decision returns false when cancelled
- `EngineStatus` deserializes without `cublas`

JavaScript: no framework exists and none is introduced. `test/regression.js` is run as a **fence**, not as coverage — this change must not touch the parser, exporters, selection, or frame math, and a green suite before and after proves it.

### Integration Tests:

Exercised manually against real hardware (no CI exists):

1. Wiped deps root → auto-open → GPU download → SHA-256 verify → stage → probe → real transcription with `device: "cuda"`
2. Wiped deps root with `REEL_ENGINE_VARIANT=cpu` → CPU engine path unchanged from today
3. Corrupted staged artifact → checksum rejection
4. Simulated CUDA failure → single CPU retry → persisted demotion → next launch resolves `cpu`
5. Cancel mid-transcription → no retry, no demotion

### Manual Testing Steps:

1. On the RTX 5070 Ti, wipe the deps root and `edl_deps_setup_dismissed`, launch, and confirm the window opens with the correct card, VRAM, driver, and Polish reason
2. Download the GPU engine; watch the determinate bar; confirm the verify + probe toast
3. Transcribe a real Polish reel with diarization on; confirm `device: "cuda"` and record the phase timings
4. Compare against the same reel on the CPU engine; confirm the speedup that Gate A demanded
5. Kill the download at ~50%; confirm "Ponów" appears and completes
6. `REEL_ENGINE_VARIANT=gpu-full`; confirm the dormant dep is listed as required and fails closed with a Polish message, staging nothing
7. Force a CUDA failure; confirm exactly one CPU retry, the Polish notice, and a correct payload
8. Cancel a GPU transcription; confirm no retry and no demotion
9. Relaunch; confirm no nag
10. On macOS arm64, run `sidecar/build.sh` and confirm VAD on CPU, alignment on MPS — unchanged

## Performance Considerations

The design trades alignment and diarization from GPU to CPU torch, in exchange for a 3.2× smaller artifact that can actually be hosted. Transcription — the dominant cost — stays on the GPU. **This trade is the change's central unmeasured assumption**, which is why Phase 1 ends at a gate rather than a milestone.

Two secondary costs are accepted knowingly. A PyInstaller onefile self-extracts to `%TEMP%\_MEIxxxx` on every spawn, so GPU users pay roughly twice the CPU build's extraction (~984 MB vs 464 MB) on each engine invocation; the research measured `--selftest` at 26.7 s cold on the new build, and `whisperx_engine_cached` already caches the readiness verdict so the badge does not re-pay it per launch. And CPU-only users are unaffected: `required_deps` filters by `variantPredicate`, so a CPU box never downloads the GPU engine.

The alternative shapes were costed and rejected in planning: a single universal 984 MB artifact would tax every CPU-only user with +520 MB of download and a doubled per-spawn extraction, forever; and splitting cuBLAS into a separate GPU-only dependency — the best runtime shape — needs a multi-file dep mode the downloader does not have (`download_single` requires `url`, `download_dir` requires an HF `repo`) and has never been frozen or measured. Both remain open as follow-ups.

## Migration Notes

Nothing on disk needs migrating. The GPU engine has **never** been stageable — its empty `sha256` made `validate_hashes()` fail closed — so no machine holds a stale copy of the 3.08 GB build. The CPU engine and FFmpeg keep their `deps-v1.0.0` URLs and their `1.0.0` dep versions, so no installed copy is marked stale and nothing re-downloads.

Two things do change underneath existing installs. `specVersion` goes `1 → 2`, and dismissal is now keyed to it, so **every existing install sees the ZALEŻNOŚCI window exactly once** after upgrading — by design, since a GPU machine may now have a GPU engine to fetch. And a legacy `edl_deps_setup_dismissed === '1'` is read as a dismissal for an unknown state, which never matches the current record, producing that same single re-open before being rewritten in the new `{ specVersion, variant }` shape.

macOS is untouched: it still bundles both sidecars through `tauri.conf.json → bundle.externalBin`, never consults the deps spec for the engine, and keeps VAD on CPU with alignment on MPS.

## References

- Research: `context/changes/gpu-engine-autodetect/research.md` — especially "Follow-up Research 2026-07-10 — measuring CT2-CUDA + torch-CPU"
- Change identity + scope: `context/changes/gpu-engine-autodetect/change.md`
- Roadmap slice: `context/foundation/roadmap.md` — S-30
- Prior slice this completes: `context/changes/thin-installer-runtime-deps/plan.md`
- Unimplemented review findings this addresses: `context/changes/thin-installer-runtime-deps/reviews/plan-review.md:69-77` (F4, retry affordance)
- The trust anchor: `src-tauri/src/deps.rs:809` (`validate_hashes`), `deps.rs:108` (`merge_specs`), `deps.rs:1137` (the test that locks it)
- The bug this change trips: `src-tauri/src/engine.rs:30` (`gpu_sidecar_present`) vs `engine.rs:201` (`engine_bin_path`)
- The device probe: `sidecar/whisperx_engine/whisperx_engine.py:131`
- The whisperx `model=` seam: `whisperx/asr.py:357`
- Progress + cancellation pattern to reuse: `src-tauri/src/whisper.rs:293` (`drive_engine`), `:909` (`reap_engine_child`)
- Lesson that governs packaging: `context/foundation/lessons.md` — "Never bake multi-GB assets into a PyInstaller onefile binary"

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Engine device decoupling, cuBLAS packaging, and the measurement gate

#### Automated

- [x] 1.1 CPU build still freezes and boots (`--selftest` exit 0, `gpu:false`, `device:cpu`) — caafeb3
- [x] 1.2 GPU build freezes to `whisperx-engine-gpu-<triple>.exe` — b94e54a
- [x] 1.3 GPU exe `--capability` reports `gpu:true`, `device:cuda`, `cublas:true` — b94e54a
- [x] 1.4 GPU exe `--selftest` exits 0 with `alignment_model_ready:true` — b94e54a
- [x] 1.5 Frozen GPU artifact is under 2 GB (~1.03 GB) — b94e54a
- [x] 1.6 GPU build's venv contains `torch+cpu`, not `torch+cu128` — b94e54a
- [x] 1.7 `--device cpu` yields `compute_type: int8`, not `float16` (override-ordering fix) — b94e54a
- [x] 1.8 Regression fence green: `node --experimental-vm-modules test/regression.js` — 6a00e2a

#### Manual

- [x] 1.9 Real reel transcribes through the frozen GPU exe with `device: "cuda"` in the payload — 491f788
- [x] 1.10 Per-phase timings recorded for all three builds, appended to `research.md` — b67c854
- [x] 1.11 Gate A passes: new GPU exe beats the CPU exe on total wall clock — b67c854
- [x] 1.12 Gate B evaluated; `engine-gpu-full` activate/dormant decision recorded in `change.md` — b67c854
- [ ] 1.13 macOS unaffected: VAD on CPU, alignment on MPS, `--capability` reports `ct2_device:cpu`/`torch_device:mps`, badge still names `mps`

### Phase 2: Host, pin, and extend the spec

#### Automated

- [x] 2.1 Rust type-check passes — e833dd6
- [x] 2.2 Embedded spec parses (`embedded_spec()` test green) — e833dd6
- [x] 2.3 `validate_hashes_fails_closed_on_empty` still passes with the dormant entry — e833dd6
- [x] 2.4 `validate_hashes` rejects `engine-gpu-full` through its `files[]` branch — N/A: gpu-full ACTIVATED per Gate B (real url+sha256, not files[]); fail-closed still covered by 2.3 — e833dd6
- [x] 2.5 `required_deps` for variant `gpu` excludes `engine-gpu-full` — e833dd6
- [x] 2.6 `staged_path` resolves the `gpu-full` variant correctly — e833dd6
- [x] 2.7 `resolve_variant` accepts `gpu-full` from env only, never from UI/hardware — e833dd6

#### Manual

- [x] 2.8 Published asset's `Get-FileHash` matches the committed `sha256` — verified in Phase 5's wiped-deps-root sweep — c72df17
- [x] 2.9 GPU engine downloads and stages to `deps_root/engine/gpu/` — verified in Phase 5's wiped-deps-root sweep — c72df17
- [x] 2.10 A corrupted staged artifact is rejected by the checksum gate — verified in Phase 5's wiped-deps-root sweep — c72df17
- [x] 2.11 `REEL_ENGINE_VARIANT=gpu-full` surfaces gpu-full as required and (per Gate B ACTIVATION) downloads+stages+verifies it from HuggingFace to `deps_root/engine/gpu-full/` — note: only fails closed if the HF asset is absent/private or the byte gets altered — verified in Phase 5's wiped-deps-root sweep — c72df17

### Phase 3: Honest hardware detection

#### Automated

- [x] 3.1 Rust type-check passes — b842e04
- [x] 3.2 Rust build passes — b842e04
- [x] 3.3 `nvidia-smi` CSV parser tests (well-formed, truncated, non-numeric, empty, trailing newline) — b842e04
- [x] 3.4 Driver floor comparison tests across the `527.41` boundary — b842e04
- [x] 3.5 `vendor_from_id` mapping test, including Basic Render Driver rejection — b842e04
- [x] 3.6 `resolve_variant` tests for `gpu_usable` + persisted `gpuUnusable` + override precedence — b842e04
- [x] 3.7 Regression fence green — b842e04

#### Manual

- [x] 3.8 `gpu_info()` on the RTX 5070 Ti reports card, VRAM, compute cap, driver, `cudaUsable:true`, Polish reason — verified live: `nvidia` / "NVIDIA GeForce RTX 5070 Ti" / 17094934528 B / cc 12.0 / driver 610.74 / `cudaUsable:true` / `variant:gpu`; the Polish `reason` came from the **UI-override** branch (a persisted `variantOverride:"gpu"` was in `deps-settings.json`), so `override_reason()` is proven but the hardware sentence is not yet — b842e04
- [x] 3.9 `REEL_ENGINE_VARIANT=cpu` makes `reason` explain the override — verified in Phase 5's wiped-deps-root sweep (the env-override branch of `override_reason()`; its UI-override sibling was already proven under 3.8) — c72df17
- [x] 3.10 A staged-only GPU engine makes the readiness badge report GPU — verified in Phase 5's wiped-deps-root sweep, with `src-tauri/binaries/` emptied so the repo fallback could no longer mask the staged-only case. This is the latent `gpu_sidecar_present()` bug Phase 3 fixed — c72df17
- [x] 3.11 `variant_satisfied` false on a GPU box with only the CPU engine, while `transcription_ready` stays true — verified in Phase 5's wiped-deps-root sweep; the split is what lets the window nag while the transcribe button stays enabled (5.12) — c72df17
- [x] 3.12 `tauri dev` with only the CPU binary on the NVIDIA dev box: `transcription_ready:true` — not gated — verified in Phase 5's wiped-deps-root sweep (previously PARTIAL: confirmed with all three exes present, not the CPU-only checkout) — c72df17
- [x] 3.13 Same checkout: `variant_satisfied:false` and the window auto-opens — verified in Phase 5's wiped-deps-root sweep, now that §3 rewired `maybeAutoOpen` onto `variant_satisfied` — c72df17

### Phase 4: Post-stage verification and the runtime fallback net

#### Automated

- [x] 4.1 Rust type-check passes — e645552
- [x] 4.2 CUDA-marker matcher tests (fires on cuBLAS + no-kernel-image, not on unrelated failures) — also excludes `CUDA out of memory`: it matches the bare `cuda` marker but is a capacity failure on a WORKING GPU, and the demotion it would trigger is permanent — e645552
- [x] 4.3 Retry decision returns false when the cancellation flag is set — e645552
- [x] 4.4 Retry decision keys on the spawned exe, not `detect_variant()` — e645552
- [x] 4.5 `engine_bin_resolved` tags the `gpu` variant when only the GPU binary is present — its variant-picking core was extracted as the pure `pick_variant(requested, present)` so the precedence is testable without an `AppHandle`/populated deps root — e645552
- [x] 4.6 `EngineStatus` deserializes from a cached verdict lacking `cublas` — e645552
- [x] 4.7 Regression fence green (272 passed) — e645552

#### Manual

- [x] 4.8 `verify_staged_engine` returns `gpu:true, cublas:true` and writes no `gpuUnusable` — verified live on the RTX 5070 Ti via `__TAURI__.core.invoke('verify_staged_engine')` (no frontend call site until Phase 5 §4). Proves the `parse_engine_status` hand-mapping actually reads `cublas` off the live engine — the trap the plan names — e645552
- [x] 4.9 A broken cuBLAS preload persists `gpuUnusable` and shows the Polish explanation — verified in Phase 5's wiped-deps-root sweep by fault injection, now that §4 wired `verify_staged_engine` into `downloadDep()` and gave the explanation a UI to render in — c72df17
- [x] 4.10 A simulated CUDA failure triggers exactly one CPU retry, a persisted verdict, a Polish notice, a correct payload — verified in Phase 5's wiped-deps-root sweep (the decision logic was already unit-proven by 4.2–4.4; this exercises it end-to-end) — c72df17
- [x] 4.11 Cancelling a GPU transcription fires no retry and writes no `gpuUnusable` — verified live: cancelled mid-`transcribe` on the GPU exe; the run reported ANULOWANO, no second engine spawn, `deps-settings.json` gained no `gpuUnusable` key. The highest-risk interaction in the change, per the plan's own note — e645552
- [x] 4.12 After demotion with only the GPU engine staged, the next transcription passes `--device cpu` and succeeds first try; `reason` explains why — verified in Phase 5's wiped-deps-root sweep, on the demotion 4.10 produced — c72df17
- [x] 4.13 `REEL_ENGINE_VARIANT=cpu` + only the GPU engine staged: a CUDA failure still triggers exactly one CPU retry — verified in Phase 5's wiped-deps-root sweep (the mirror case the variant label hides: `engine_bin_path` cross-falls-back to the GPU exe, so keying the retry on the SPAWNED exe rather than `detect_variant()` is what saves this user) — c72df17

### Phase 5: ZALEŻNOŚCI window — hardware panel, variant-aware auto-open, dismissal scoping

#### Automated

- [x] 5.1 Prettier clean — green for the three files this phase touched (`index.html`, `first-run-deps.js`, `import/transcribe.js`). The repo-wide `--check` still flags **`src/styles.css`**, a PRE-EXISTING committed violation this phase never touched; left unstaged per the lessons.md rule "Incidental Prettier churn must not ride into a feature commit" — c72df17
- [x] 5.2 Regression fence green (272 passed, 0 failed) — c72df17
- [x] 5.3 Rust build passes — c72df17
- [x] 5.4 No `transcription_ready` reference remains in `maybeAutoOpen` — it now invokes `variant_satisfied`; the surviving mentions of the name are the doc comments the plan itself asked for (stating the ready-vs-satisfied split) — c72df17

#### Manual

- [x] 5.5 Empty deps root: window auto-opens naming card, VRAM, driver, and why GPU was chosen — c72df17
- [x] 5.6 GPU download shows a determinate bar, verifies, probes, and toasts Polish success — c72df17
- [x] 5.7 Badge flips to the GPU verdict after that download **without a relaunch** — required an ADAPTATION beyond the plan text: `deps-changed` refreshed only the transcribe gate, never the badge, so the badge would have painted the pre-download verdict until relaunch. `import/transcribe.js` now also refreshes `refreshEngineReadiness` on that event — c72df17
- [x] 5.8 Interrupted download leaves an explicit "Ponów" button; retrying completes — c72df17
- [x] 5.9 After provisioning, relaunch does not open the window — c72df17
- [x] 5.10 Dismiss → relaunch stays shut; change variant → opens once; relaunch stays shut — c72df17
- [x] 5.11 Upgrade from a legacy `'1'` dismissal opens the window exactly once — c72df17
- [x] 5.12 GPU box with only the CPU engine: window opens, transcribe button stays enabled — c72df17
- [x] 5.13 Badge names both devices; degrades to the single `device` string on an older cached verdict — c72df17
- [x] 5.14 All new strings Polish with correct diacritics in the rendered webview — c72df17
