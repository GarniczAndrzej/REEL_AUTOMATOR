---
date: 2026-07-10T00:00:00+02:00
researcher: GarniczAndrzej
git_commit: 30359e027d1fabadbfff4174d8f62ff41114f068
branch: feat/windows-port
repository: REEL_AUTOMATOR
topic: "Autodetect the user's GPU and provision a matching WhisperX engine on their machine, without self-hosting the artifact"
tags: [research, codebase, deps, whisperx, cuda, rocm, thin-installer, s-30]
status: complete
last_updated: 2026-07-10
last_updated_by: GarniczAndrzej
last_updated_note: "Added follow-up: built and measured the CT2-CUDA + torch-CPU engine on real hardware — 983.7 MB frozen exe (vs 3.08 GB today), cuBLAS is the only CUDA dependency, GPU inference confirmed under a CPU torch build"
---

# Research: GPU engine autodetect + local provisioning

**Date**: 2026-07-10
**Researcher**: GarniczAndrzej
**Git Commit**: `30359e0`
**Branch**: `feat/windows-port`
**Repository**: REEL_AUTOMATOR

## Research Question

S-29 shipped a thin Windows installer that downloads heavy deps on first run. The GPU engine entry dead-ends: a 3.3 GB CUDA artifact with a placeholder `RELEASE_HOST` URL and an empty `sha256`, which the downloader deliberately fail-closes on.

The product owner's framing:

> Full end-to-end GPU path. Because everyone has different GPU, someone has Radeons and it's good to auto-detect the hardware and base of it download all dependencies needed to run GPU engine and build that engine. **I don't want to host it.** Somehow you helped me to download GPU engine and build it, so app should do the same based on the user's hardware.

So: detect *any* GPU → pull the right dependencies from upstream sources → produce a working GPU engine locally. No self-hosted 3.3 GB binary.

## Summary

Four findings, in descending order of how much they should change the plan.

**1. The 3.3 GB artifact is an accident of packaging, not a requirement.** The GPU engine is huge because the PyInstaller onefile embeds `torch==2.8.0+cu128`, whose Windows wheel is ~3.5 GB (it bundles cuDNN/cuBLAS/cuFFT/cuSOLVER inside the wheel — unlike Linux, where those are separate pip packages). But **torch is not what transcribes.** CTranslate2 does, and the CT2 CUDA wheel ships its own CUDA libraries independent of torch. Torch is only needed for the wav2vec2 forced-alignment step and pyannote diarization. Running **CT2 on CUDA + torch on CPU** gives GPU-accelerated transcription while replacing the 3.5 GB CUDA torch wheel with the ~200 MB CPU one. That alone would shrink the GPU engine under GitHub's 2 GB cap and unblock the existing download path *without any of the work this change proposes*. This is worth knowing before committing to local builds.

**2. If the app provisions Python locally, PyInstaller becomes pointless.** The Rust side does not care that the engine is a frozen onefile — `engine_bin_path()` (`src-tauri/src/engine.rs:201`) just resolves *an absolute path to an executable* honoring a documented CLI contract. PyInstaller exists solely to produce a Python-free artifact for machines without Python. The moment you install a Python environment on the user's box (which "build it on their machine" necessarily means), you can run the engine straight from that venv behind a tiny launcher. That deletes the slowest, most fragile step — the multi-GB onefile freeze — and the whole class of onefile-only bugs the current spec works around (speechbrain's `os.listdir` of its own package dir, `_MEIPASS`, `copy_metadata` for `importlib.metadata`). **"Build the engine" should really be read as "provision an environment."**

**3. Radeon support is newly possible and genuinely rough; Intel is a dead end.** As of 2026, CTranslate2 has upstream ROCm/HIP support (PR #1989 merged, closing the 3-year-old issue #1072) with official AMD wheels on GitHub Releases, and AMD ships native Windows ROCm PyTorch (torch 2.9.1+rocm7.2.1) from repo.radeon.com. But the Windows AMD path is currently broken in ways that are not ours to fix: the AMD wheels are built against ROCm 7.2 while the Windows HIP SDK only reaches 7.1.1, and a DLL was renamed (`libhipblas.dll` → `hipblas.dll`), so CT2 crashes on load (open issue #2016); RX 9070 XT (gfx1201) faults during transcription (#2021); supported hardware is narrow (RX 7000/9000 + specific drivers) and requires staging a heavyweight vendor SDK. **Intel GPUs cannot work at all** with this stack — CTranslate2 has no SYCL/oneAPI backend, so even though PyTorch XPU supports Intel on Windows, the transcription engine can't use it. If genuine "any GPU" coverage is the goal, the only robust answer is a different ASR engine (whisper.cpp + Vulkan, one binary across NVIDIA/AMD/Intel/iGPU), which trades away wav2vec2 forced alignment for DTW-derived word timings.

**4. Local building collides head-on with the security architecture S-29 just built.** `validate_hashes()` (`src-tauri/src/deps.rs:809`) runs before any network I/O and rejects any dependency whose `sha256` is empty. That gate is the trust anchor — the embedded spec ships inside the code-signed installer and is the reason a downloaded multi-hundred-MB `.exe` can be trusted. A locally built artifact's hash **cannot be known in advance** (PyInstaller output isn't bit-reproducible), so it can never be pinned. There is a unit test locking this in: `validate_hashes_fails_closed_on_empty` (`deps.rs:1137`). Beyond that gate, five more structural assumptions break — byte-based progress, byte-based free-space checks, single-file sentinels, same-volume atomic rename, and no cancellation. Details in *The seam* below.

There is a precedent that makes the owner's instinct ("don't host it") architecturally coherent: commit `30359e0` **already** stopped hosting the wav2vec2 align model and now pulls it from the official HuggingFace repo at first transcription. This change is the same move applied to the engine — trust upstream (PyPI, `download.pytorch.org`, HF) rather than mirror it.

## Detailed Findings

### Current GPU detection: `nvidia-smi` presence, nothing more

`nvidia_gpu_present()` (`src-tauri/src/deps.rs:219`) memoizes a single probe: `nvidia-smi -L`, true iff the command succeeds with non-empty stdout. Every failure mode collapses to `false` (`deps.rs:227`) — fail-safe to CPU. It cannot see an AMD or Intel card at all, and it cannot distinguish "NVIDIA card present" from "usable CUDA driver present."

`resolve_variant(env, ui, gpu_present)` (`deps.rs:271`) is pure and unit-tested: `REEL_ENGINE_VARIANT` env → persisted UI override (`deps-settings.json → variantOverride`) → `gpu_present` → `"cpu"`. `detect_variant()` (`deps.rs:291`) wires it up and is deliberately *not* memoized, so a mid-session override change re-resolves the required dep set.

For broader detection, the reliable Windows mechanism is **DXGI adapter enumeration** (`IDXGIFactory::EnumAdapters1` → `DXGI_ADAPTER_DESC` with `VendorId`: NVIDIA `0x10DE`, AMD `0x1002`, Intel `0x8086`, plus `DedicatedVideoMemory`). In Rust this is reachable via the `windows` crate's `Win32::Graphics::Dxgi`, or higher-level through `wgpu`'s `Instance::enumerate_adapters()` → `AdapterInfo { vendor, device, name, device_type, backend }`. Note that WMI `Win32_VideoController.AdapterRAM` is a signed 32-bit field capped near 4 GB and must not be trusted for VRAM. Crucially, **none of these prove a working CUDA runtime** — they only prove a card exists. `nvidia-smi`/NVML must remain the CUDA-usability gate; DXGI answers the separate question "what GPUs are in this box, and is one of them AMD?"

The roadmap already anticipated depth here (`context/foundation/roadmap.md:555`): profiling via `nvidia-smi --query-gpu=name,memory.total,compute_cap,driver_version --format=csv` vs NVML, mapping to a variant key against a driver floor.

### What the engine actually needs from hardware — one build already serves both

`sidecar/whisperx_engine/whisperx_engine.py:131` — `_detect_device()`:

```
import torch  (on failure → "cpu", False, "int8")
if torch.cuda.is_available():        return "cuda", True, "float16"
if torch.backends.mps.is_available(): return "mps",  True, "int8"
return "cpu", False, "int8"
```

Device selection is a pure runtime check, overridable by `--device` / `--compute-type` (`whisperx_engine.py:146`). CTranslate2 has no MPS backend, so on Apple the transcription leg is forced to CPU (`whisperx_engine.py:401`).

The consequence, stated explicitly in `src-tauri/src/engine.rs:60`: *"The GPU build is a safe superset — if CUDA is unusable it auto-falls back to `device='cpu'`."* **A single CUDA build already runs correctly on a CPU-only machine.** The two-artifact CPU/GPU split exists purely so CPU-only users don't download 3.3 GB. It is a size optimization, not a functional requirement — which is exactly why finding #1 above matters so much.

### The build chain, and what it would cost an end user

`sidecar/build.sh` is bash (`#!/usr/bin/env bash`, `:1`). The CPU/GPU delta is four lines: output base name (`:59-60`), venv directory (`.venv` vs `.venv-gpu`, `:67-68` — CPU and GPU torch are the same package with different `+cpu`/`+cu128` local versions and cannot coexist), and the torch index URL (`:103-105`). `CUDA` env var overrides the wheel tag (`${CUDA:-cu128}`, `:103`); cu128 was chosen because *"cu128 carries Blackwell sm_120 kernels (RTX 50xx); cu121 has none and fails at runtime with 'no kernel image available'"* (`build.sh:101-102`).

What a stock Windows machine is missing to run this: **bash, Python 3.10/3.11, pip, venv, PyInstaller, `pefile`/`pywin32-ctypes`** (Windows-only freeze deps, installed explicitly at `build.sh:113-118` because `--no-deps` skips them), and potentially an MSVC toolchain if any pinned package lacks a `win_amd64` wheel. The lock was validated on macOS arm64 (`requirements.lock.txt:2`); Windows wheel availability for this exact pin set is not proven by anything in the repo.

Cost of a GPU build on the user's machine (agent estimates, reasoned from wheel composition — the repo stores no artifacts):

| | |
|---|---|
| Bytes downloaded | ~4.0–4.2 GB (~3.5 GB torch cu128 + ~0.7 GB rest) |
| Installed venv | ~8–9 GB |
| Peak disk during build | ~18–22 GB (venv + pip cache + PyInstaller scratch + dist) |
| Wall clock | ~25–60 min, disk-bound; the onefile freeze alone is 10–30 min |

The locked stack also drags in surprising weight: `PySide6` + addons + `shiboken6` (~150–250 MB, `requirements.lock.txt:106-108,126`), `opencv-python` (~40 MB, `:76`), `numba`+`llvmlite` (~40 MB). Whether those are prunable for a runtime-only environment is an open question.

### The engine's CLI contract — the only thing Rust actually requires

Extracted from `src-tauri/src/engine.rs` and `src-tauri/src/whisper.rs`. Any executable satisfying this can replace the frozen onefile:

- **Resolution**: one absolute path from `engine_bin_path()` (`engine.rs:201`), tried staged-deps-root → beside-main-exe → repo `binaries/` (`resolve_engine_variant`, `engine.rs:159`), spawned via `crate::proc::build_command` (`whisper.rs:607`, `:857`; `engine.rs:257`).
- **Readiness**: `--selftest` and `--capability`, each optionally `--align-model-dir DIR` (`engine.rs:352`, `:398`); reply is JSON `{ ok, version, gpu, device, alignment_model_ready }` (`engine.rs:274`).
- **Transcribe**: `--audio <wav> --model <dir> --language <code>` (`whisper.rs:558`), plus optional `--diarize`, `--device`, `--compute-type`, `--beam-size`, `--initial-prompt`, `--vad-onset`, `--vad-offset`, `--min-speakers`, `--max-speakers` (`whisper.rs:135-179`).
- **Align-only**: `--align-only --audio <wav> --transcript <srt> --language <code>` (`whisper.rs:827`).
- **Env, not argv**: `HF_TOKEN` (`whisper.rs:614`), `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE` (`engine.rs:96`), `PYTHONUTF8`/`PYTHONIOENCODING=utf-8` (`engine.rs:109`).
- **stdout**: exactly one JSON document `{ language, segments:[{ start, end, text, words:[…] }] }` (`whisper.rs:640`).
- **stderr**: progress lines `PROGRESS phase=<transcribe|align|diarize> percent=<0-100>` (`whisper.rs:352`, emitted by `whisperx_engine.py:115`); everything else is free-form log tail.
- **Exit codes**: `0` ok, `10` model-not-found, `11` audio-decode-fail, `12` align-fail, `13` diarize-fail, `14` transcribe-fail, `2` usage — mapped to Polish in `engine_error_message` (`whisper.rs:182`).

### The seam: what breaks when a dep is built instead of downloaded

The dependency data model (`Dependency`, `deps.rs:56`) has fields for `url`/`repo`/`files`/`sha256`/`size_bytes`/`sentinel`/`stage_to` — and **no concept of a build recipe**. Six structural assumptions break:

1. **Pinned SHA-256 is mandatory and pre-known.** `validate_hashes()` (`deps.rs:809`) runs before any network I/O (called at `:964`) and rejects empty hashes; `download_single`/`download_dir` verify against the pinned digest (`:880`, `:935`). A build's output hash is unknowable in advance. Locked in by `validate_hashes_fails_closed_on_empty` (`deps.rs:1137`). **This is the central conflict** — resolving it means either exempting build-produced deps from the anchor (and finding a different trust story: signed upstream indexes, pinned wheel hashes) or abandoning local builds.
2. **Progress is byte-shaped.** `emit_progress()` (`deps.rs:727`) emits `dep-download-progress` with `{ id, percent, bytesPerSec, etaSec, downloaded, total }`, where `total = dep.size_bytes` (`:877`). A build has no byte total. The right model already exists elsewhere: `transcribe-progress` with `{ label, percent }` (`whisper.rs:352`).
3. **Free-space check sizes only the final artifact.** `required_total_bytes()` (`deps.rs:549`) sums `dep.size_bytes`. A build needs venv + wheels + pip cache + PyInstaller scratch — roughly 6× the artifact. The "enough room?" gate would be badly wrong.
4. **Atomic swap assumes a same-volume sibling rename.** `atomic_swap()` (`deps.rs:704`) renames `<file>.part` → final via `std::fs::rename` (`:709`). Build output lives in a separate tree, possibly a different volume, where rename fails with `EXDEV`. Needs copy-then-swap.
5. **`url` (or `repo`) is required.** `download_single` errors without `dep.url` (`deps.rs:864`); `download_dir` without `dep.repo` (`:901`). A build dep has neither.
6. **No cancellation exists on the deps side.** `download_dependency` (`deps.rs:954`) has no cancel token. A multi-minute build needs one far more than a download does. The pattern to copy is `whisper.rs`: `TRANSCRIBE_CHILD`/`TRANSCRIBE_CANCELLED` statics (`:14-15`), the `drive_engine` select-loop (`:293`), `reap_engine_child` SIGTERM→300ms→SIGKILL (`:909`), `cancel_transcription` (`:933`).

Two adjacent gaps found while tracing this:

- **`chmod +x` is never set on a staged artifact** anywhere in `deps.rs`. Harmless on Windows; a latent bug the moment macOS/Linux download rather than bundle.
- **Latent variant-resolver inconsistency.** `engine_sidecar()` (`engine.rs:65`), which drives the readiness cache key and the UI badge, gates the GPU choice on `gpu_sidecar_present()` (`engine.rs:30`) — which checks only repo `binaries/` and beside-exe, **not the staged deps root**. But `engine_bin_path()` (`engine.rs:201`), the actual spawn resolver, *does* check the staged root. A GPU engine staged only into `deps_root/engine/gpu/` would be **spawned as GPU while the badge reports CPU**. Any change that stages a GPU engine must fix `gpu_sidecar_present` too.

### Frontend: a download modal, not a build modal

`src/ui/first-run-deps.js` (403 lines) + `#firstRunDepsModal` (`src/index.html:619-754`). `refreshDepsView()` (`:145`) fans out to `load_deps_spec`, `deps_status`, `get_deps_root`, `deps_root_space`, `get_variant`, `get_variant_override`. `renderDepsList()` (`:216`) renders one row per *required* dep, with `depLabel()` (`:261`) mapping engine-gpu → **"Silnik WhisperX (GPU / CUDA)"**. The variant dropdown (`src/index.html:659-663`) offers **"Automatyczny" / "GPU (NVIDIA CUDA)" / "CPU"** and writes through `set_variant_override` (`first-run-deps.js:334`).

What exists and is reusable: a determinate progress bar with a phase label (`#whisperProgressBox`, `src/index.html:272`, driven by `setWhisperProgress(label, percent)` at `transcribe.js:1047` off the `transcribe-progress` listener at `:771`); a cancel button + `cancel_transcription` invoke (`transcribe.js:491`); toasts; a single-flight guard (`_downloadingId`, `first-run-deps.js:28`).

What does **not** exist: any phase model on the deps side (`dep-download-progress` is one flat percent per artifact, `first-run-deps.js:80-100`); any cancel affordance in the deps modal (`downloadDep()` awaits to completion, `:296`); the explicit retry button that plan-review F4 asked for; a visual progress bar in the dep rows (it's a plain text `<div>`, `:244`).

Transcription gating: `transcription_ready` (`deps.rs:650`) → `_depsReady` (`transcribe.js:197`) composes with `hasVideo && hasModel` in `syncTranscribeBtn()` (`:174`). Missing deps surface `#depsMissingCta` (`src/index.html:204`) with the button **"Pobierz zależności"**.

JS-side byte assumptions mirror the Rust ones: `fmtBytes(dep.sizeBytes || …)` renders one number per dep (`:243`); `renderLocation` shows a single scalar `{ freeBytes, requiredBytes }` (`:197`); `done` is binary → **"Pobrano i zweryfikowano"** (`:88`).

### AMD / Intel feasibility, with sources

| Backend | CTranslate2 (transcription) | PyTorch on Windows (align + diarize) | Verdict |
|---|---|---|---|
| NVIDIA CUDA | Official, primary | `download.pytorch.org/whl/cu128` | Works today |
| AMD ROCm/HIP | Upstream since PR #1989; wheels on GitHub Releases, not PyPI | Official Windows wheels at repo.radeon.com (torch 2.9.1+rocm7.2.1), RX 7000/9000 + some Ryzen AI APUs | Possible, currently buggy |
| Intel oneAPI/SYCL | **None** | `torch.xpu` native since 2.5 | **Dead end** — engine can't use the GPU |
| Vulkan / DirectML | **None** | `torch-directml` exists, lags | Not via CT2 |

Open AMD-on-Windows bugs as of early 2026: CT2 issue [#2016](https://github.com/OpenNMT/CTranslate2/issues/2016) (wheels built against ROCm 7.2, Windows HIP SDK caps at 7.1.1, `libhipblas.dll` → `hipblas.dll` rename ⇒ crash on load, no maintainer fix) and [#2021](https://github.com/OpenNMT/CTranslate2/issues/2021) (RX 9070 XT / gfx1201 memory access fault). Note that widely-circulated advice saying "CTranslate2 doesn't support ROCm natively" (e.g. a Nov 2025 comparison gist) **predates PR #1989 and is now stale**.

The cross-vendor escape hatch is **whisper.cpp + Vulkan** (`-DGGML_VULKAN=1`): one Windows binary covering NVIDIA, AMD, Intel Arc/iGPU, ARM Mali, no vendor SDK, ~12× CPU on iGPUs. It has built-in word-level timestamps — but **DTW/token-derived, not wav2vec2 forced alignment**, and it has no facility to force-align an *external* transcript (which `align_transcript` needs, `whisper.rs:827`). Adopting it is an ASR-engine replacement, not a provisioning change.

### Provisioning a Python runtime, if that's the road taken

`uv` (Astral) is the natural fit: `uv python install` fetches a standalone CPython with no system Python; `uv venv` creates the environment; `[tool.uv.sources]` routes torch to `download.pytorch.org/whl/{cpu,cu126,cu128,cu130,rocm6.4,xpu}`, and `--torch-backend=auto` autodetects the accelerator and picks the index — which is almost literally the feature this change is asking for. Caveats: uv's `rocm6.4` index is Linux-only (AMD Windows torch lives at repo.radeon.com, a custom index), and `uv` itself becomes a ~30 MB binary the installer must ship or fetch. Alternatives: python-embeddable (no pip, painful for binary deps), conda/micromamba (heavier, but can provision CUDA runtime libs as packages), pixi.

## Code References

- `src-tauri/src/deps.rs:219` — `nvidia_gpu_present()`, the entire current hardware detection
- `src-tauri/src/deps.rs:271` — `resolve_variant()`, pure precedence chain (env → UI → hardware → cpu)
- `src-tauri/src/deps.rs:327` — `staged_path()`, the on-disk layout contract per `stage_to` slot
- `src-tauri/src/deps.rs:809` — `validate_hashes()`, the fail-closed trust anchor that blocks local builds
- `src-tauri/src/deps.rs:704` — `atomic_swap()`, same-volume `.part` rename
- `src-tauri/src/deps.rs:727` — `emit_progress()`, byte-shaped `dep-download-progress`
- `src-tauri/src/deps.rs:954` — `download_dependency()`, the command a build flow must extend or parallel
- `src-tauri/src/deps.rs:1137` — `validate_hashes_fails_closed_on_empty`, the test that locks the anchor
- `src-tauri/src/engine.rs:30` / `:65` — `gpu_sidecar_present()` / `engine_sidecar()`, the badge path that ignores the staged root
- `src-tauri/src/engine.rs:201` — `engine_bin_path()`, the real spawn resolver (staged → beside-exe → repo binaries)
- `src-tauri/src/whisper.rs:293` — `drive_engine()`, the streaming-progress + cancellation pattern worth copying
- `src-tauri/src/whisper.rs:352` — `PROGRESS phase=… percent=…` parsing → `transcribe-progress`
- `src-tauri/src/proc.rs:41` / `:66` — `build_command()` / `spawn_and_collect()`, the raw-`Command` helpers
- `sidecar/build.sh:59-68` / `:96-118` — the entire CPU-vs-GPU build delta
- `sidecar/whisperx_engine/whisperx_engine.py:131` — `_detect_device()`, runtime CUDA→MPS→CPU fallback
- `sidecar/whisperx_engine.spec:90-113` — `hiddenimports`; `:60-88` — `copy_metadata` list
- `src/deps/deps-spec.json:6-17` — the stubbed GPU entry (placeholder URL, empty `sha256`)
- `src/ui/first-run-deps.js:80-100` — the `dep-download-progress` listener
- `src/ui/first-run-deps.js:216-269` — dep-row rendering + Polish labels
- `src/ui/import/transcribe.js:174-206` — the transcription readiness gate
- `src/ui/import/transcribe.js:771` / `:1047` — the phase-progress precedent

## Architecture Insights

**The trust anchor is the load-bearing design.** S-29's whole security story is: the embedded `deps-spec.json` ships inside the code-signed installer; a remote spec may re-point a `url` but can never change a known id's `sha256` or `version` (`merge_specs`, `deps.rs:108`); nothing stages without matching the embedded digest. Any "build it locally" design must answer *what replaces the digest* — probably pinned wheel hashes against PyPI/pytorch indexes over TLS, which is a strictly weaker and much larger trust surface (~145 packages instead of 1 binary).

**"Don't host it" already has a precedent in this repo.** Commit `30359e0` dropped `align-models` from the managed spec because its nested ~1.26 GB HF cache tree couldn't live on GitHub Releases, and made the engine pull `jonatasgrosman/wav2vec2-large-xlsr-53-polish` from official HuggingFace at first transcription (`whisper.rs:592-617`; engine side `whisperx_engine.py:290`). The dependency graph already contains an unpinned, trusted-upstream, downloaded-at-runtime component. Extending that reasoning to the engine is consistent, not novel — the question is only how much surface it adds.

**Engine variant is a size optimization masquerading as a capability split.** `_detect_device()` + the "safe superset" comment mean one CUDA build serves everyone. Every complication in this area — dual venvs, dual artifacts, variant predicates, variant overrides, `resolve_variant` precedence — exists to avoid shipping 3.3 GB to CPU-only users. Shrink the GPU artifact and much of that apparatus becomes optional.

**Progress/cancel already has a good pattern; it's just on the wrong side of the app.** `drive_engine` (`whisper.rs:293`) does streaming stderr parsing, phase-labelled progress events, and a 250 ms-polled cancellation flag with SIGTERM→SIGKILL escalation. The deps subsystem has none of it. A build flow needs exactly that, and should lift it rather than invent a second mechanism.

## Historical Context (from prior changes)

- `context/changes/thin-installer-runtime-deps/plan.md:421-516` — Progress. **Phases 1–5 automated checks all `[x]`; Phase 0 (release host + pinned checksums) entirely `[ ]`; every manual/real-hardware row pending.** The code is complete; the GPU half was never exercised.
- `context/changes/thin-installer-runtime-deps/plan.md:67` — *"Variant must fail safe to CPU… The GPU build is a safe superset (auto-falls back to `device=cpu` internally) but must not be downloaded unless GPU is selected."*
- `context/changes/thin-installer-runtime-deps/plan.md:45` — *"**Not** implementing HTTP-range resume — an interrupted artifact **restarts**… Range resume is explicitly deferred."*
- `context/changes/thin-installer-runtime-deps/reviews/plan-review.md:69-77` — **F4**: 3.3 GB + no resume = restart-from-zero. *"An interruption at 90% on a residential connection throws away ~3 GB… keep an explicit 'retry' affordance in the Phase 4 UI (not an auto-silent restart)."* Still unimplemented.
- `context/changes/thin-installer-runtime-deps/reviews/plan-review.md:59-67` — **F3**: an unsigned downloaded `engine.exe` attracts SmartScreen/Defender quarantine between staging and spawn. A *locally built* exe is, if anything, more suspicious to AV — this finding gets worse under the proposed design, not better. Also flagged independently at `context/foundation/windows-port-guide.md:228-230`.
- `context/foundation/roadmap.md:543-562` — S-30 `gpu-engine-autodetect` (working tree, uncommitted). Names the 3.3 GB no-host problem as *"the slice's gating task, not a side quest"* (`:554`), and on non-NVIDIA hardware prescribes: *"detect and say so in Polish; still install CPU. Honest beats silent"* (`:558`).
- `context/foundation/roadmap.md:547` — two auto-open bugs to fix in this slice: `transcription_ready` is variant-agnostic (true as soon as *any* engine resolves, so a GPU machine with a CPU engine is judged ready and never fetches GPU), and `edl_deps_setup_dismissed` never expires. Both live in `first-run-deps.js:108-121` and `transcribe.js:197-206`.
- `context/foundation/windows-port-guide.md:167-169` — S-24's headline unknown, unresolved: *"CPU is portable but slow; CUDA is fast but needs the matching torch wheel + cuDNN/cuBLAS DLLs bundled and a driver floor. Decide before committing to a sidecar size."*
- `context/foundation/lessons.md:12-17` — *"Never bake multi-GB assets into a PyInstaller onefile binary."* Written about the align model; the 3.3 GB CUDA-torch onefile is the same lesson, unlearned.
- `context/foundation/prd.md:97-104` — **no FR governs transcription hardware or the installer.** FR-002 requires local WhisperX transcription with word-level forced alignment "with no separate install." Both S-29 and S-30 are recorded as *"no single FR"*. Note FR-002's "word-level forced alignment" is what a whisper.cpp/Vulkan swap would put at risk.

## Related Research

None — this is the first research artifact for S-30. The closest prior art is `context/changes/thin-installer-runtime-deps/plan.md` (its Phase 1 §"GPU/CPU detection already exists" section) and `context/foundation/windows-port-guide.md` §4b.

## Open Questions

1. **Is local building actually wanted, once its cost is visible?** Splitting torch (CPU) from CTranslate2 (CUDA) plausibly shrinks the GPU engine below GitHub's 2 GB cap, unblocking the *existing* download path with no new architecture and no weakened trust anchor. **This needs to be measured before anything else is planned** — build a CT2-CUDA + torch-CPU engine and record the onefile size. If it lands under 2 GB, most of this change evaporates. If the owner's "I don't want to host it" is about hosting *at all* rather than the 2 GB cap, that's a different constraint and should be stated explicitly.
2. **What replaces the SHA-256 trust anchor for build-produced artifacts?** Pinned wheel hashes (`--require-hashes`) across ~145 packages? Trust `uv` + TLS + official indexes? Do nothing and exempt build deps? This is the single biggest design decision and it has a security review attached.
3. **Does the product actually need Radeon, or does it need "don't lie to AMD users"?** The roadmap already prescribes the honest-CPU-fallback answer (`roadmap.md:558`). Given CT2 issues #2016/#2021, shipping a ROCm path in 2026 means owning upstream breakage on hardware nobody on the team has. What is the real user demand — and is there one AMD machine available to test on?
4. **Is FR-002's word-level forced alignment negotiable?** It is the only thing ruling out whisper.cpp+Vulkan, which is the sole design that genuinely covers "everyone has a different GPU." (`align_transcript` — forced-aligning an *external* transcript — has no whisper.cpp equivalent at all.)
5. **Can the locked stack be pruned for a runtime-only venv?** PySide6 + addons (~150–250 MB), opencv, numba/llvmlite are all suspicious for an ASR sidecar. If they're only build-time or transitively unused, a provisioned venv is much smaller than the frozen exe.
6. **Where does the ~18–22 GB peak-disk figure land against real user machines?** The current free-space check (`required_total_bytes`, `deps.rs:549`) would need to model build scratch, and a mid-build `ENOSPC` on a laptop is a bad failure mode with no cleanup path today.
7. **AV/SmartScreen behavior on a locally built, unsigned exe** — plan-review F3 is unresolved for *downloaded* binaries; a freshly-frozen PyInstaller exe is a known Defender heuristic trigger (`windows-port-guide.md:228`). Nobody has tested either.
8. **Does `uv --torch-backend=auto` actually resolve correctly on Windows for cu128 and for AMD?** Its ROCm index is Linux-only. Verify before designing around it.

---

## Follow-up Research 2026-07-10 — measuring CT2-CUDA + torch-CPU

Open Question #1 asked whether a CT2-CUDA + torch-CPU engine fits under GitHub's 2 GB
per-asset cap. It was measured on real hardware rather than estimated. **It does, and the
result is stronger than expected: CTranslate2's stock PyPI wheel is already CUDA-capable,
and the only missing piece is cuBLAS.**

Hardware: RTX 5070 Ti, NVIDIA driver only — **no CUDA toolkit installed** (`CUDA_PATH`
empty, no `C:\Program Files\NVIDIA GPU Computing Toolkit`, only `C:\Windows\system32\nvcuda.dll`).
This matters: it makes the machine a fair proxy for an end-user box.

### Where the 3.3 GB actually goes

Both build venvs exist on disk and were decomposed directly:

| | `.venv` (CPU) | `.venv-gpu` (CUDA) |
|---|---|---|
| torch dist-info | `torch-2.8.0+cpu` | `torch-2.8.0+cu128` |
| site-packages total | 4.79 GB | 8.77 GB |
| `torch/` | 3,037 MB | 7,083 MB |
| `ctranslate2/` | **59.8 MB** | **59.8 MB** |
| `nvidia_*` pip packages | 0 | 0 |
| CUDA `.dll` in `torch/lib` | none | **3,999 MB** |
| frozen exe | 464,628,987 B (0.43 GB) | 3,302,778,914 B (3.08 GB) |

Two facts fall out. First, **on Windows the CUDA runtime ships inside the torch wheel**
(`cublasLt64_12.dll` 643 MB, `torch_cuda.dll` 981 MB, `cudnn_engines_precompiled64_9.dll`
490 MB, `cusparse64_12.dll` 362 MB, …) — there are no separate `nvidia-*` pip packages, so
the whole 4.0 GB rides along with `torch==2.8.0+cu128`. Second, **`ctranslate2/` is byte-identical
in both venvs (59.8 MB)** — it does not bundle CUDA libraries, it links to them.

(Aside: `torch/lib/dnnl.lib` is 2,218 MB in *both* venvs but is a link-time static `.lib`.
PyInstaller doesn't bundle `.lib` files, which is why the CPU exe is 464 MB despite a 2.9 GB
`torch/lib`. Don't read raw `torch/lib` totals as shipped bytes.)

### CT2 is CUDA-capable under a CPU torch build

Run in `.venv` (`torch 2.8.0+cpu`, `torch.cuda.is_available() == False`):

```
ct2 4.8.0
cuda_device_count = 1
supported_compute_types('cuda') = {'float16', 'bfloat16', 'int8', 'float32', 'int8_float16', ...}
```

`ctranslate2.dll` has **zero static CUDA imports** (PE import table: only KERNEL32, MSVCP140,
`libiomp5md.dll`, the CRT stubs). It resolves CUDA lazily via `LoadLibrary` at first use.
Device *enumeration* needs only the driver; *inference* needs cuBLAS.

### Bisecting the minimal CUDA DLL set

Real Whisper `encode` + decode (`faster_whisper.WhisperModel("tiny", device="cuda",
compute_type="float16")` over 3 s of audio), run from the **CPU** venv with candidate DLLs
sourced from `.venv-gpu/torch/lib` and placed on `PATH`:

| DLL set | Raw size | Result |
|---|---|---|
| (none) | 0 | `RuntimeError: Library cublas64_12.dll is not found or cannot be loaded` |
| `cublas64_12.dll` | 108.4 MB | fails (cuBLAS needs cuBLASLt) |
| `cublas64_12.dll` + `cublasLt64_12.dll` | **751.9 MB** | **CUDA_INFERENCE_WORKS** |

**No cuDNN. No `cudart64_12.dll`.** CT2 4.8.0 statically links the rest. The failure without
cuBLAS is at `WhisperModel.encode` — the model *loads* onto CUDA and only the first matmul
fails, so a naive smoke test that merely constructs the model would report a false pass.

Note `os.add_dll_directory()` does **not** help here: it only affects `LoadLibraryEx` with
`LOAD_LIBRARY_SEARCH_USER_DIRS`, and CT2 uses a plain load. The DLLs must be on `PATH`, or
preloaded by absolute path via `ctypes.WinDLL` before CT2 touches CUDA.

### Measured artifact size

The engine was actually frozen: the repo's `whisperx_engine.spec` with `binaries` extended by
the two cuBLAS DLLs and a `ctypes.WinDLL` preload runtime hook, built from the **CPU** venv
(`torch 2.8.0+cpu`), `distpath`/`workpath` in scratchpad so nothing under `sidecar/` was touched.

| Build | Bytes | Size |
|---|---:|---:|
| CPU (`torch+cpu`) — shipping today | 464,628,987 | 0.43 GB |
| **NEW: CT2-CUDA + torch-CPU** | **1,031,463,399** | **0.96 GB** |
| GPU (`torch+cu128`) — shipping today | 3,302,778,914 | 3.08 GB |

**983.7 MB — under the 2 GB GitHub Releases cap with 1,064 MB of headroom, and 3.2× smaller
than the current GPU artifact.** (The pre-build projection from the measured 0.71× compression
ratio was ~1.0 GB; the observed figure matches it.)

The frozen exe boots cleanly — `--selftest` exits 0 in 26.7 s and the cuBLAS preload hook causes
no regression:

```
{"ok": true, "version": "1.0.0", "gpu": false, "device": "cpu", "alignment_model_ready": false}
```

Note `"gpu": false`. **The CUDA capability is inside that binary but unreachable**, precisely
because `_detect_device()` asks `torch.cuda.is_available()`. That is the confirmation, from the
frozen artifact itself, that the two code changes below are load-bearing rather than cosmetic.
GPU inference has been proven **in-venv** (see the bisection table) but **not yet through the
frozen exe**, because reaching it requires those changes — `--device cuda` alone would route
whisperx's VAD to `torch.device("cuda")` under CPU torch and fail. Proving it end-to-end through
the exe is the first verification step the plan should carry.

### Two code changes this design requires

1. **`_detect_device()` (`sidecar/whisperx_engine/whisperx_engine.py:131`) gates on
   `torch.cuda.is_available()`**, which is permanently `False` under CPU torch. The
   transcription device must instead be probed via `ctranslate2.get_cuda_device_count() > 0`,
   independently of torch's device.

2. **The transcription device and the torch device must be decoupled.** `whisperx.load_model`
   forwards its `device` argument to the torch-based VAD —
   `VoiceActivitySegmentation(segmentation=vad_model, device=torch.device(device))`
   (`.venv/Lib/site-packages/whisperx/vads/pyannote.py:46`) — so `device="cuda"` under CPU
   torch would break VAD. whisperx already provides the seam: `model = model or WhisperModel(...)`
   (`whisperx/asr.py:357`). Passing a pre-built `WhisperModel(whisper_arch, device="cuda",
   compute_type="float16")` as `model=` while leaving `device="cpu"` puts CT2 on the GPU and
   VAD on CPU torch. The call site to change is `whisperx_engine.py:399-403`.

Also required for the frozen artifact: a PyInstaller runtime hook that `ctypes.WinDLL`-preloads
`cublasLt64_12.dll` then `cublas64_12.dll` from `sys._MEIPASS`. Under the current cu128 build
this is invisible because `import torch` pulls cuBLAS into the process first and CT2's
`LoadLibrary`-by-name then hits the already-loaded module; with CPU torch nothing preloads it.

### What this costs

Alignment (wav2vec2) and diarization (pyannote) would run on **CPU torch**. Transcription — the
dominant cost — stays on the GPU. This is a real regression against the current cu128 build and
is **unmeasured**; it should be timed on a representative reel before the design is committed.
If GPU alignment turns out to be necessary, the 3.5 GB CUDA torch wheel comes back and the
whole size argument collapses — so this timing is the load-bearing follow-up.

### Consequences for the change

- **Open Question #1 is answered: hosting is viable.** A ~1 GB artifact fits GitHub Releases,
  can be SHA-256 pinned into the embedded spec, and flows through the S-29 downloader
  **unchanged**. The trust anchor (`validate_hashes`, `deps.rs:809`) survives intact.
- **Local building / Python provisioning is not needed for the size problem.** It remains an
  option only if "I don't want to host it" is a hosting objection rather than a 2 GB-cap
  objection. Per the user (2026-07-10): it was the cap.
- **The CPU/GPU artifact split may collapse into one.** If the CPU engine is 464 MB and the
  GPU engine is ~1 GB and differs only by two DLLs, a single ~1 GB artifact that selects the
  device at runtime (CT2 falls back to CPU when `get_cuda_device_count() == 0`) could replace
  both — deleting `variantPredicate`, the dual venv, and much of `resolve_variant`. Worth
  costing: it trades ~550 MB of download onto CPU-only users for a large simplification.
- **Detection still needs work, but less of it.** With cuBLAS shipped in the artifact, the
  "does this machine have a usable CUDA runtime" question reduces to
  `ctranslate2.get_cuda_device_count() > 0` — a probe of the real thing, not a proxy. That is
  strictly more honest than `nvidia-smi -L` (`deps.rs:219`), which reports a *card*, not a
  working runtime. AMD/Intel remain out of reach (see the feasibility table above); the roadmap's
  "detect and say so in Polish; still install CPU" (`roadmap.md:558`) stands.

### Reproduction

- `sidecar/.venv/Scripts/python.exe -c "import ctranslate2 as c; print(c.get_cuda_device_count())"` → `1`
- Probe scripts and the generated `cudalite.spec` live in this session's scratchpad; the spec is
  the repo's `whisperx_engine.spec` with `binaries=_CUBLAS` and a `runtime_hooks=[rthook_cublas.py]`
  preload hook. Nothing under `sidecar/` was mutated — the freeze wrote to scratchpad
  `distpath`/`workpath`.

## Follow-up: measured phase timings (2026-07-11, Phase 1 §7 gate)

Measured through the **frozen exes** (not in-venv) on the RTX 5070 Ti, one real Polish
reel, large-v3, via `scratchpad/measure_engines.py` (timestamps the engine's
`PROGRESS phase=` stderr lines). Diarization was requested but **failed on all three
builds** with an identical pre-existing bundling error —
`diarization failed: Lazy import of LazyModule(... speechbrain.integrations.k2_fsa ...)` —
so the diarize column is unmeasured. Because it fails identically on the cu128 build,
it is **not** caused by the device-decoupling changes; it is a separate defect in the
frozen diarization path (loading `pyannote/speaker-diarization-community-1`). The
transcribe and align phases completed on all three and their 0→100 durations are clean
and directly comparable.

| build | transcribe (s) | align (s) | transcribe+align (s) | load (s) |
|---|---:|---:|---:|---:|
| cpu (torch+cpu) | 436.9 | 112.2 | 549.1 | 12.5 |
| cu128 (torch+cu128, GPU align) | 18.3 | 14.3 | 32.6 | 36.3 |
| **gpu (CT2-CUDA + torch-CPU)** | 28.8 | **107.7** | **136.5** | 15.3 |

**Gate A — PASS.** New GPU beats CPU on the completed work: 136.5 s vs 549.1 s (~4.0×
faster). Transcription alone is 28.8 s vs 436.9 s (~15× faster). The lightweight GPU
build is unambiguously worth shipping over CPU — the change's core goal (a hostable,
working GPU path) is met.

**Gate B — FAIL.** New GPU vs cu128: 136.5 / 32.6 = **4.19×**, far above the 1.30×
threshold (2.2× even if load is included). The cause is exactly the plan's load-bearing
assumption: **CPU-torch alignment dominates** — 107.7 s on CPU vs 14.3 s on CUDA
(~7.5× slower). Transcription is comparable (both on CUDA CT2; 28.8 vs 18.3 is within
model-load/thermal noise). Diarization, also moved to CPU torch, would only widen the
gap, so the verdict holds regardless of the unmeasured diarize column.

**Interpretation.** The lightweight build (984 MB, GitHub-hostable) is a large win over
the *status quo* (GPU was unusable because the 3.08 GB cu128 build could not be hosted),
but it is ~4× slower end-to-end than the full cu128 build purely because of CPU
alignment. Per the plan, a Gate-B failure means `engine-gpu-full` should be activated
(hosted on HuggingFace, env-only) rather than left dormant — a Phase-2 scope decision
recorded in `change.md`.

Reproduction: `scratchpad/measure_engines.py --audio <reel> --model large-v3
--cu128-exe <gpu-full exe> --append-research` (HF_TOKEN set). Note the diarization
bundling failure must be fixed separately before a diarize-inclusive number exists.
