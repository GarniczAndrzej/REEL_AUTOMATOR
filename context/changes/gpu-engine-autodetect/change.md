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

**Where we are: ALL FIVE PHASES DONE.** The only Progress row still open is **1.13**
(macOS: VAD on CPU, alignment on MPS, `--capability` reporting `ct2_device:cpu` /
`torch_device:mps`) — it needs a Mac and is not reachable from the Windows dev box.
Everything else is green.

**Phase 5 outcome (ZALEŻNOŚCI window — frontend + docs; the backend was already in place):**
- `src/index.html`: new `#depsHardwareInfo` panel above the "Wariant sprzętowy" heading.
- `src/ui/first-run-deps.js`: `gpu_info` joined the `refreshDepsView()` fan-out and
  `renderHardware()` paints it (the Polish `reason` is authored in Rust — the UI never
  re-derives it); `maybeAutoOpen()` now consults **`variant_satisfied`**, not
  `transcription_ready`; the dismissal is a `{specVersion, variant}` record (a legacy
  `'1'` parses to the NUMBER 1, not a throw — handled explicitly as an "unknown state"
  that never matches, so the window re-opens exactly once after upgrade);
  `downloadDep()` invokes `verify_staged_engine` for `kind === 'engine'` and toasts the
  verdict; a failed download leaves an explicit **"Ponów"** button (plan-review F4);
  the per-dep progress line gained a determinate bar.
- `src/ui/import/transcribe.js`: the badge renders the DEVICE PAIR via a new
  `deviceLabel()` (`transkrypcja: cuda · dopasowanie: cpu`), degrading to the single
  legacy `device` string on a pre-S-30 cached verdict.
- Docs: `CLAUDE.md` (command table + a Windows GPU-engine note), `roadmap.md` (S-30 →
  done; the "no-cap host" Blockers paragraph rewritten to record how it was dissolved).

**Phase 5 DEVIATIONS (both ratified in-session, both needed to make the plan's own
success criteria reachable):**
1. **`deps-changed` now also refreshes the engine badge** (`transcribe.js`). The event
   refreshed only the transcribe gate, never `refreshEngineReadiness` — so criterion 5.7
   ("badge flips to the GPU verdict **without a relaunch**") could not have passed: the
   badge would have kept painting the pre-download verdict until the next launch. The
   plan assumed the `OnceLock` removal (Phase 3 §5) was sufficient; it was necessary but
   not sufficient — nothing was re-READING the verdict.
2. **The post-verify toast scopes the cuBLAS check to the `gpu` variant**, mirroring
   Rust's `should_demote_engine`. `gpu-full` reports `cublas: false` while running fine
   on CUDA (its CUDA comes from the cu128 torch wheel, not our bundled DLLs), so an
   unscoped check would have told a `gpu-full` user their working engine was broken.

**Known pre-existing defect, deliberately NOT fixed here:** `src/styles.css` fails
`npx prettier --check`. It is a committed violation this change never touched; per
lessons.md ("Incidental Prettier churn must not ride into a feature commit") it was
left unstaged. Worth its own cleanup commit.

**Phase 4 outcome (post-stage verification + the runtime fallback net):**
- `engine.rs`: `EngineStatus` gained `cublas: Option<bool>`, `ct2_device`,
  `torch_device` (all `#[serde(default)]`, so pre-Phase-4 cached verdicts on disk
  stay readable). `parse_engine_status` **hand-maps all three** — the derive only
  serves the disk cache, so a field not read out there is invisible to Rust. New
  `verify_staged_engine` command (spawns `--capability`, always — a cached verdict
  would defeat probing the binary we just wrote — and persists `gpuUnusable` when
  the exe that ACTUALLY resolved is a GPU build that can't see CUDA). New pure
  helpers: `is_gpu_variant`, `variant_fallbacks`, `pick_variant` (the testable core
  extracted from `engine_bin_resolved`), `should_demote_engine`.
- `whisper.rs`: `is_cuda_failure`, `argv_pins_device`, `should_retry_on_cpu`, and the
  net itself in `transcribe_video` — one CPU retry, capped by construction (the retry
  pins `--device`, which the gate then reads as "not ours to retry").
- `deps.rs`: `set_gpu_unusable()` — a public one-way writer over the private
  `write_settings_field`. Nothing clears it automatically; an env/UI override beats it.
- `lib.rs`: `verify_staged_engine` registered.

**DONE in Phase 5:** `verify_staged_engine` is wired into `downloadDep()` (plan §4), so
4.9's Polish demotion explanation now has a place to render.

**Phase 3 outcome (honest hardware detection):**
- `deps.rs`: `nvidia_query()` (memoized `nvidia-smi --query-gpu` → name/VRAM/compute-cap/
  driver, tolerant parse, any malformation ⇒ `None` ⇒ fail-safe to CPU);
  `driver_meets_floor()` gating on `DRIVER_FLOOR_WINDOWS = (527, 41)` compared as a
  `(major, minor)` TUPLE, not a float (527.9 is 527.09 — older — not newer than 527.41);
  `dxgi_adapters()` (AMD/Intel/unknown, Basic Render Driver `0x1414` skipped, VRAM from
  `DedicatedVideoMemory` never WMI's 32-bit `AdapterRAM`); `gpu_unusable()` reader;
  `gpu_info()` command (Polish `reason`, un-memoized so a Phase 4 demotion surfaces
  without relaunch); `resolve_variant`'s 3rd term changed meaning `gpu_present` →
  `gpu_usable`.
- `engine.rs`: `gpu_sidecar_present()` DELETED; `engine_sidecar()` now takes `&AppHandle`,
  is **un-memoized** (the OnceLock is gone — it must re-resolve after a mid-session
  download), and derives from `engine_bin_resolved()`; new
  `engine_bin_resolved(app) -> (PathBuf, &'static str)` returns the path **and the
  variant tag of the exe that actually resolved** (`engine_bin_path` is now a thin
  wrapper over it); new `variant_satisfied` command.
- `whisper.rs`: `push_gpu_demotion()` appends `--device cpu` at BOTH spawn sites when
  `gpuUnusable` is persisted and the caller passed no explicit `--device`.
- `Cargo.toml`: `windows` 0.61 under `[target.'cfg(windows)'.dependencies]` (same line
  Tauri already pulls in, so no duplicate crate).
- `lib.rs`: `gpu_info` + `variant_satisfied` registered. **`verify_staged_engine` is NOT
  yet registered — Phase 4 §2 must add it.**

**Phase 3 DEVIATIONS (both ratified in-session, both strictly safer):**
1. Plan §5 specified `engine_sidecar()`'s guard as
   `resolve_engine_variant(app, detect_variant(), triple).is_some()`. Implemented as
   `engine_bin_resolved(app)`'s returned variant tag instead — identical in every case
   the plan enumerates, but it ALSO covers the reverse cross-fallback the plan itself
   calls out (`engine.rs` falls back to the GPU exe when a `cpu` selection has no CPU
   binary). The literal guard would file that GPU exe's readiness verdict under the CPU
   cache key; keying on the exe that actually resolves cannot.
2. `nvidia_gpu_present()` DELETED, not kept as the plan's thin wrapper. Its rationale was
   "so no existing caller breaks mid-phase", but `detect_variant()` was its only caller
   and now calls `nvidia_query()` directly — it was dead code with a compiler warning.

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
**Phase 3 / Phase 4:** see the SHAs on the plan's 3.x / 4.x Progress rows.

**Three engine exes remain on disk in src-tauri/binaries/ (git-ignored):**
- `whisperx-engine-x86_64-pc-windows-msvc.exe` — CPU (torch+cpu)
- `whisperx-engine-gpu-x86_64-pc-windows-msvc.exe` — CT2-CUDA (1.03 GB, torch+cpu + cuBLAS) [hosted]
- `whisperx-engine-gpu-full-x86_64-pc-windows-msvc.exe` — cu128 baseline (3.08 GB) [hosted on HF]

**Next action: none — the change is implemented.** Remaining open item is 1.13 (macOS),
which needs hardware nobody on the team has here.

Two facts worth keeping, both confirmed in Phase 5:
- Plan §5 said the badge reads `status.ct2Device`/`status.torchDevice` (camelCase). That
  was WRONG: `EngineStatus` has no `rename_all`, and `transcribe.js` already reads
  `status.alignment_model_ready`. The real keys are **`ct2_device` / `torch_device`** —
  which is what shipped. (`GpuInfo` DOES carry `rename_all = "camelCase"`, so the
  hardware panel correctly reads `vramBytes` / `cudaUsable` / `driverVersion`. The two
  structs genuinely differ; do not "normalize" one to match the other.)
- Phase 5's wiped-deps-root flow was the state every deferred manual row was waiting on
  (2.8–2.11, 3.9–3.13, 4.9, 4.10, 4.12, 4.13). All were swept green in that one run.

**Phase 4 TODO — DONE:** `gpu-full`'s `--capability` reports `cublas:false` (its CUDA
comes from torch, not our bundled DLLs) while still running on CUDA. Phase 4's plan
would have demoted it. `should_demote_engine` now scopes the cuBLAS check to the `gpu`
variant only; `gpu-full` is judged by `gpu == false` alone.

## Phase 4 deviation (2026-07-11): the runtime net is wired at `transcribe_video` only

Plan §3 said to wire the CUDA-failure → CPU-retry net into BOTH `drive_engine`
callers. It cannot work at `align_transcript`, and the user ratified scoping it out:
the retry lever is `--device cpu`, which Phase 1 fixed to override the **CT2** device
only (torch is deliberately untouchable). `--align-only` is pure torch and never
touches CT2. So on the shipping GPU build (torch=CPU) a CUDA failure there is
impossible, and on `gpu-full` (torch=CUDA) the retry would re-run identically and
fail — a guaranteed-useless second multi-minute run. `align_transcript` keeps Phase
3's `push_gpu_demotion` (it still honors a persisted `gpuUnusable`); nothing else was
added. The retry gate is likewise scoped to `EXIT_TRANSCRIBE_FAIL` (14) for the same
reason: align (12) and diarize (13) run on torch, which `--device` does not move.

**Also implemented (from the Phase 4 TODO above):** `should_demote_engine` judges
`gpu` on `gpu && cublas != Some(false)` but `gpu-full` on `gpu` alone — gpu-full's
CUDA comes from the cu128 torch wheel, not our bundled DLLs, so it truthfully reports
`cublas: false` while running fine. Demoting it on that field would break a working
engine. `cublas: None` (a `--selftest` verdict, which omits the field) is "unknown",
never "failed", and never demotes.

**Also excluded:** `CUDA out of memory` does NOT trip the CUDA marker. It contains
`cuda` and would otherwise match, but OOM is a capacity problem on a working GPU and
`gpuUnusable` is a one-way, permanent verdict.

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
