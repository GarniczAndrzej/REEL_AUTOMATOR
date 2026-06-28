---
project: Reels Automator
doc: windows-port-phase4-plan
status: complete
created: 2026-06-28
relates_to: roadmap S-24 (windows-port); windows-port-guide.md §4
---

# Windows port — §4 "Rebuild the native sidecars" — phased execution plan

This is the **execution/handoff plan** for `windows-port-guide.md` **§4** as scoped on
**this** Windows machine. It expands §4 beyond the guide's "CPU-first" path because of a
user decision and a hardware fact discovered on this box. Read this top-to-bottom to resume
after a context clear — it records every decision, machine fact, command, and the live
progress state.

> **Scope decision (user, 2026-06-28):** build **BOTH** a CPU and a GPU WhisperX engine
> sidecar, and make the **app auto-select** the correct one at startup ("every configuration
> is different, so it should get the proper dependencies"). This is larger than the guide:
> it adds a cu128 GPU build *and* a new runtime-selection feature in the Rust layer.

---

## 0. Machine facts discovered on this box (the reason the plan deviates)

| Fact | Value / location | Consequence |
| --- | --- | --- |
| GPU | **NVIDIA GeForce RTX 5070 Ti** (Blackwell, compute **sm_120**), driver 610.62 / 32.0.16.1062 | The guide's `GPU=1` path installs **cu121** torch wheels, which have **no sm_120 kernels**. A cu121 build freezes fine but **fails at runtime** ("no kernel image available"). A real GPU build needs **cu128+** torch wheels → a `build.sh` patch, not a one-flag change. |
| Python (Windows) | 3.11.9 at `C:\Users\garni\AppData\Local\Programs\Python\Python311\python.exe`; default `py` → 3.14.6 | Sidecar pins 3.10/3.11; **3.14 is too new** for torch/whisperx wheels. Must build the venv with 3.11. |
| Python in **Git-Bash** | `python` / `python3` **both unresolved**; only `py` → 3.14 | `build.sh` calls `python3 -m venv` (guarded by `if [ ! -d "$VENV" ]`). **Workaround:** pre-create `sidecar/.venv` with 3.11 so build.sh skips that line and uses the venv's interpreter for everything after. ✅ done. |
| Git-Bash | `C:\Program Files\Git\bin\bash.exe` (the `Bash` tool here is this MINGW64 shell) | `build.sh` detects `MINGW64_NT` → triple `x86_64-pc-windows-msvc`, `.exe` suffix. |
| Node | `C:\Program Files\nodejs\node.exe` (not on this PowerShell PATH) | `npm install` / regression suite work; call by full path if PATH-less. |
| Cargo/Rust | `C:\Users\garni\.cargo\bin\cargo.exe` (not on this PowerShell PATH) | On Windows, no `~/.cargo/bin/` prefix needed once PATH is set; call by full path here. |
| VS Build Tools | present (`C:\Program Files (x86)\Microsoft Visual Studio`) | MSVC linker available for `cargo`/Tauri. |
| `src-tauri/binaries/` | did **not** exist on this checkout | Created. All sidecars git-ignored & absent on fresh clone (expected). |

---

## 1. Target artifacts (what §4 must produce on Windows)

```
src-tauri/binaries/
  ffmpeg-x86_64-pc-windows-msvc.exe              # 4a — static ffmpeg          ✅ DONE
  whisperx-engine-x86_64-pc-windows-msvc.exe     # 4b CPU build                ⏳ Phase 2
  whisperx-engine-gpu-x86_64-pc-windows-msvc.exe # 4b GPU build (cu128)        ⏳ Phase 3
  align_models/                                  # wav2vec2 (Polish), staged by build.sh
  <cuDNN/cuBLAS DLLs beside the GPU exe>         # GPU runtime deps            ⏳ Phase 3
```

> **Naming note (critical for runtime selection):** `build.sh` today names the GPU build
> `whisperx-engine-<triple>-gpu.exe` — the `-gpu` lands **after** the triple. Tauri's
> `externalBin` / `sidecar(name)` resolver appends the triple to a **base name**, so to
> register the GPU variant as its own sidecar it must be `whisperx-engine-gpu-<triple>.exe`
> (`-gpu` **before** the triple). Phase 3 reconciles this (rename-on-copy or a build.sh
> tweak) so both variants are Tauri-resolvable base names: `whisperx-engine` and
> `whisperx-engine-gpu`.

---

## Phase 1 — FFmpeg + build prerequisites  ✅ COMPLETE

**Goal:** static ffmpeg in place; Python toolchain ready for the freeze.

1. ✅ Create `src-tauri/binaries/`.
2. ✅ **FFmpeg (guide §4a):** downloaded BtbN static `win64-gpl` build
   (`https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip`),
   extracted `bin/ffmpeg.exe` → `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe`.
   Verified: `ffmpeg version N-125328-g8512161c81-20260627`. Self-contained (no shared DLLs).
3. ✅ **venv workaround:** created `sidecar/.venv` with Python 3.11.9 so `build.sh` skips
   `python3 -m venv` and uses the venv interpreter thereafter.

**Acceptance:** ✅ `ffmpeg-...-msvc.exe -version` runs; `sidecar/.venv/Scripts/python.exe`
reports 3.11.9.

---

## Phase 2 — CPU WhisperX sidecar  ✅ COMPLETE

**Goal:** a working, portable CPU engine so the app runs end-to-end on any Windows box
(the guide's milestone).

**Outcome (2026-06-28):** `src-tauri/binaries/whisperx-engine-x86_64-pc-windows-msvc.exe`
(464 MB onefile) + `align_models/pl` built and verified — frozen `--selftest` returns
`{ok:true, device:"cpu", gpu:false, alignment_model_ready:true}` in ~16 s cold.

**What had to change (the resolver landmine the plan predicted):**
- The Windows `else` branch's plain `pip install -r requirements.txt` **failed** with
  `ResolutionImpossible` exactly as flagged: whisperx 3.8.6 caps `huggingface-hub<1.0.0`
  while transformers 5.12.1 needs `>=1.5.0` — not pip-cross-resolvable on **any** platform.
- **Fix:** `build.sh` now uses the macOS dodge on **every** platform — install the
  `requirements.lock.txt` stack with `--no-deps` (tolerates the stale cap). torch is
  platform-specific, so non-macOS installs the torch trio **first** at the lock's exact
  versions from the right wheel index, and the lock's `torch==2.8.0` then resolves as
  already-satisfied (PEP 440: `==2.8.0` permits `2.8.0+cpu`). Key versions: **torch 2.8.0
  / torchvision 0.23.0 / torchaudio 2.8.0** (whisperx pins `torchvision~=0.23.0`, which
  pins torch 2.8.0 — the latest torch 2.12 the naive install grabbed is incompatible).
- **Windows PyInstaller deps:** the `--no-deps` lock skips pyinstaller's own win32 deps;
  `build.sh` now installs `pefile` + `pywin32-ctypes` when `EXE_EXT=.exe` before the freeze.
- **torchcodec 0.7.0** installs (Windows wheel exists) but its native `libtorchcodec_core*.dll`
  **can't load** — it needs *shared* FFmpeg libs and our ffmpeg is a static `.exe`. Harmless:
  only pyannote (opt-in diarization) uses it and degrades to an in-memory fallback; core
  transcribe + align use `whisperx.load_audio` (ffmpeg subprocess). The spec already ships
  torchcodec's **dist-info metadata** (transformers reads its version at import) so the
  wav2vec2/align chain is unaffected. ⚠️ If diarization on Windows is needed later, bundle
  shared FFmpeg DLLs beside the exe — separate task.

> Below is the original Phase-2 step list (kept for reference; superseded by the outcome above).

**Steps**
1. Run the CPU build from **Git-Bash** (the `.venv` already exists, so no `python3` call):
   ```bash
   sidecar/build.sh
   ```
   build.sh (Windows/`else` branch) will: `pip install torch torchaudio --index-url
   https://download.pytorch.org/whl/cpu`, then `requirements.txt`, stage the Polish
   wav2vec2 align model into `align_models/pl`, PyInstaller-freeze `whisperx_engine.py`
   via `whisperx_engine.spec`, copy the `.exe` + `align_models/` into `src-tauri/binaries/`.
   - Long poles: torch CPU wheel (~200 MB) + PyInstaller onefile freeze. Run in background.
   - If freeze/import fails, check whisperx vs huggingface-hub/transformers version skew
     (the macOS path uses `requirements.lock.txt --no-deps` *because* the combo isn't
     pip-cross-resolvable; the Windows `else` branch uses plain `requirements.txt` — watch
     for resolver conflicts here).
2. Self-test (expect ~37–67 s cold per spawn — onefile extraction + torch import):
   ```bash
   "src-tauri/binaries/whisperx-engine-x86_64-pc-windows-msvc.exe" --selftest
   ```
   Expect JSON `{ ok:true, device:"cpu", gpu:false, alignment_model_ready:true, ... }`.

**Acceptance:** CPU `--selftest` returns `ok:true`. (`device:"cpu"` is correct for this build.)

---

## Phase 3 — GPU WhisperX sidecar (cu128 for Blackwell)  ✅ COMPLETE

**Goal:** a CUDA engine that actually runs on the RTX 5070 Ti (sm_120).

**Outcome (2026-06-28):** `src-tauri/binaries/whisperx-engine-gpu-x86_64-pc-windows-msvc.exe`
(**3.3 GB** onefile) built + verified. Frozen `--selftest` returns
`{ok:true, version:"1.0.0", gpu:true, device:"cuda", alignment_model_ready:true}` in **~48 s
cold** — a real align ran on CUDA, confirming **cu128/sm_120 kernels work** (no "no kernel
image available" error). Acceptance met.

**Step 3 (CUDA DLL bundling) — resolved, no separate staging needed.** The selftest ran the
align on CUDA with **zero loose DLLs beside the exe**, so PyInstaller's torch hook collected
torch's CUDA runtime (cuDNN/cuBLAS from `torch/lib`) **into** the onefile (that's the 3.3 GB).
The plan's "headline unknown" was a non-issue here. ⚠️ **Caveat:** the selftest exercises
**torch's** CUDA path (alignment), not **CTranslate2's** transcription CUDA path
(faster-whisper backend). CT2 has its own cuDNN dependency — verify a real GPU *transcribe* in
Phase 5 end-to-end; if CT2 can't find cuDNN at runtime it silently falls back to CPU or errors,
which is the one thing the selftest did **not** prove.

**Progress (2026-06-28):**
- ✅ **Step 1 — cu128 patch DONE.** `build.sh` GPU path installs the torch trio from
  `https://download.pytorch.org/whl/${CUDA:-cu128}` (env-overridable knob, default cu128) at
  the lock's exact versions (torch 2.8.0 / torchvision 0.23.0 / torchaudio 2.8.0). **Verified
  cu128 cp311 win_amd64 wheels exist** for all three (`torch-2.8.0+cu128-cp311-cp311-win_amd64.whl`
  etc.) — the #1 risk is cleared.
- ✅ **Step 2 — naming reconciliation DONE.** `build.sh` now derives `BASE_NAME`
  (`whisperx-engine` | `whisperx-engine-gpu`) and `OUT_NAME="${BASE_NAME}-${TRIPLE}"`, so the
  GPU artifact is `whisperx-engine-gpu-x86_64-pc-windows-msvc.exe` (base name
  `whisperx-engine-gpu`, Tauri-resolvable). Header-comment targets updated to match (macOS GPU
  is now `whisperx-engine-gpu-aarch64-apple-darwin`, also pre-triple).
- ✅ **Separate GPU venv DONE.** `build.sh` uses `sidecar/.venv-gpu` when `GPU=1` (CPU/GPU torch
  can't co-exist in one venv). Pre-created with Python 3.11.9 (git-bash `python3` workaround,
  same as Phase 1's `.venv`).
- 🔄 **Build launched** in background: `GPU=1 bash sidecar/build.sh` (log:
  `scratchpad/gpu-build.log`). Downloading the cu128 torch trio (~3 GB) → lock `--no-deps` →
  win PyInstaller deps → stage `align_models/pl` → PyInstaller freeze → copy to `binaries/`.
- ⏳ **Step 3 (CUDA DLL bundling)** + **Step 4 (GPU `--selftest`)** pending build completion.

**Steps**
1. ✅ **Patch `build.sh` GPU path** cu121 → **cu128** (Blackwell support). DONE — uses
   `https://download.pytorch.org/whl/${CUDA:-cu128}` (env-overridable knob). cu128 cp311
   win_amd64 wheels confirmed present for the torch trio.
2. ✅ **Naming reconciliation** (see §1 note): GPU artifact is
   `whisperx-engine-gpu-x86_64-pc-windows-msvc.exe` (base name `whisperx-engine-gpu`). DONE via
   `BASE_NAME`/`OUT_NAME` derivation in build.sh.
3. **Bundle CUDA runtime DLLs** beside the GPU exe: CTranslate2 (faster-whisper) + torch
   need cuDNN/cuBLAS (`cudnn_*`, `cublas*`, `cublasLt*`, etc.). PyInstaller may not collect
   all; stage them next to the exe (and into `bundle.resources` for production). This is the
   guide's "headline unknown" — size + which DLLs.
4. Build (fresh `.venv` likely needed — CPU and GPU torch can't co-exist in one venv; use a
   separate `sidecar/.venv-gpu` or rebuild). Then self-test on the GPU:
   ```bash
   GPU=1 sidecar/build.sh
   "src-tauri/binaries/whisperx-engine-gpu-x86_64-pc-windows-msvc.exe" --selftest
   ```
   Expect `{ ok:true, device:"cuda", gpu:true, ... }`.

**Acceptance:** GPU `--selftest` returns `ok:true, gpu:true, device:"cuda"` on the 5070 Ti
(no "no kernel image" error → confirms cu128/sm_120 is correct).

**Open questions to resolve in this phase**
- Exact cu128 torch/torchaudio versions with Windows+py3.11 wheels.
- Which CUDA DLLs must ship; total GPU sidecar size (likely multi-GB).
- Whether CTranslate2's CUDA build is pulled by whisperx automatically or needs its own wheel.

---

## Phase 4 — Runtime CPU/GPU auto-select  ✅ COMPLETE

**Goal:** at startup the app picks the GPU sidecar when a usable NVIDIA GPU is present, else
the CPU sidecar — "proper dependencies for every configuration."

**Outcome (2026-06-28):** implemented + unit-verified. `cargo check` clean (42 s); regression
**272/272 green**. On this box both selection signals are positive (`nvidia-smi -L` lists the
RTX 5070 Ti; the gpu binary is present) → `engine_sidecar()` returns `whisperx-engine-gpu`.
Full in-app GPU transcribe is the Phase 5 end-to-end check.

**What was implemented (engine.rs):**
- Split `ENGINE_SIDECAR` → `ENGINE_SIDECAR_CPU` (`whisperx-engine`) + `ENGINE_SIDECAR_GPU`
  (`whisperx-engine-gpu`).
- `engine_sidecar() -> &'static str` — process-memoized (`OnceLock`), **cheap & spawn-free**:
  `REEL_ENGINE_VARIANT=cpu|gpu` override → else GPU iff `gpu_sidecar_present()` (stats the
  arch-suffixed file in dev `binaries/` or beside the prod exe) **and** `nvidia_gpu_present()`
  (`nvidia-smi -L` lists ≥1 GPU) → else CPU. All three `ENGINE_SIDECAR` call sites
  (`engine.rs` run_engine, `whisper.rs` ×2) now use it.
- `readiness_cache_key()` folds in `engine_sidecar()` so CPU/GPU verdicts never collide.
- `tauri.conf.json` externalBin now lists `binaries/whisperx-engine-gpu`.

> **Design deviation from the plan's step 2 (intentional):** the plan recommended an
> *authoritative* `--capability` probe (spawn the gpu engine, trust its `gpu:true`). I used the
> plan's cheaper option (a) — `nvidia-smi` + binary presence — instead, because the launch
> badge `whisperx_engine_cached` **must never spawn** the engine, yet must fold the chosen
> variant into its cache key; an authoritative probe there would break that invariant. The
> engine's own `--selftest`/`--capability` still provides the authoritative `gpu:true`/`device`
> to the badge UI. And the GPU build is a safe superset (torch auto-falls back to `device="cpu"`
> when CUDA is unusable), so a false-positive `nvidia-smi` only costs a slower start, never a
> failure. Net: no disk-cache-for-selection needed, no spawn on the launch path.

**Current wiring (verified in code):**
- `src-tauri/src/engine.rs` → `pub const ENGINE_SIDECAR: &str = "whisperx-engine";` is the
  single base name used by `run_engine()` (selftest/capability) **and** by `whisper.rs`
  (`drive_engine` for transcription/alignment). Tauri appends the triple.
- `tauri.conf.json` → `bundle.externalBin: ["binaries/ffmpeg", "binaries/whisperx-engine"]`,
  `bundle.resources: ["binaries/align_models"]`.
- `EngineStatus` already carries `gpu: bool` + `device: String`, reported by the engine's
  `--capability` / `--selftest` (torch device detect).

**Steps**
1. **Register both sidecars** in `tauri.conf.json`:
   `externalBin: ["binaries/ffmpeg", "binaries/whisperx-engine", "binaries/whisperx-engine-gpu"]`.
   (Both arch-suffixed files must exist for the host triple at build time or Tauri hard-fails.
   Plan: on a CPU-only build machine we may need a fallback — see risk below.)
2. **Selection logic** (new, in `engine.rs`): resolve the engine base name once via a helper,
   e.g. `fn engine_sidecar(app) -> &str` returning `"whisperx-engine-gpu"` when a usable GPU
   is detected and the gpu binary is present, else `"whisperx-engine"`. Replace the bare
   `ENGINE_SIDECAR` references in `run_engine` (engine.rs) **and** `drive_engine` (whisper.rs)
   with this helper. Grep for `ENGINE_SIDECAR` before declaring done.
   - **GPU detection options:** (a) cheap — check `nvidia-smi` / WMI / presence of the gpu
     exe + driver; (b) authoritative — spawn `whisperx-engine-gpu --capability` and trust its
     `gpu:true`. Recommended: prefer the gpu sidecar if its binary exists AND a quick
     `--capability` probe reports `gpu:true`; cache the verdict (reuse the existing
     `engine-readiness` cache pattern; the cache key must fold in which variant was chosen).
   - Keep it overridable (env var or setting) for debugging.
3. **Readiness cache:** the key in `readiness_cache_key()` must distinguish CPU vs GPU
   verdicts (add the chosen variant to the hash) so a swap doesn't serve a stale badge.
4. `cargo check` + run the **regression suite** (must stay byte-identical — pure JS, no native
   deps):
   ```powershell
   node --experimental-vm-modules test/regression.js
   ```

**Acceptance:** on this box the app selects `whisperx-engine-gpu` and transcribes on CUDA;
on a CPU-only machine it falls back to `whisperx-engine`. Regression suite green. `cargo
check` clean.

---

## Phase 5 — Cargo/keyring + end-to-end verification  ⏳ (guide §5–§7)

1. ✅ **Windows credential store (guide §5) — DONE.** `src-tauri/Cargo.toml` keyring features
   are now `["apple-native", "windows-native"]`; `cargo check` compiled it clean. Without it
   keys vanish each launch (keyring 3.x falls back to an in-memory mock). Still verify
   *persistence across relaunch* in the §7 walk below.
2. `npm install` (if not already) → `npm run tauri dev`.
3. ✅ **Guide §7 in-app walk — PASSED (user-verified 2026-06-28).** `npm run tauri dev` builds
   clean (cargo 57.6 s cold, 0.25 s warm) and launches `reel-automator.exe`; fresh transcription
   produces correct Polish diacritics; **API key persists across relaunch** (⇒ `windows-native`
   keyring active); `.reelproj` projects round-trip (save → load). All three step-2 checks green.
4. ✅ **CT2-on-CUDA check (carried from Phase 3) — CONFIRMED WORKING.** A real GPU transcription
   ran end-to-end in the app (user-verified 2026-06-28) — faster-whisper/CTranslate2 uses CUDA
   and finds cuDNN from the onefile. No loose CT2 cuDNN DLLs needed. The Phase-3 "headline
   unknown" is fully closed.

---

## Phase 6 — Polish-diacritics UTF-8 bug (found in §7 testing)  🔄 IN PROGRESS

**Symptom (2026-06-28):** transcription works but Polish diacritics (ą/ć/ę/ł/ń/ó/ś/ź/ż) come
back as � / missing. A follow-up *align* of that text then hard-errors:
`engine internal error: 'charmap' codec can't encode character '�' ...`.

**Root cause (confirmed by byte inspection):** the engine writes its result JSON with
`json.dumps(..., ensure_ascii=False)` (raw non-ASCII). On Windows a frozen Python's **piped
stdout defaults to cp1250** (Polish ANSI codepage), so `ż`→`0xBF`, `ó`→`0xF3` etc. go out as
single bytes that are **invalid UTF-8**; the Rust reader (`String::from_utf8_lossy`) turns them
into `U+FFFD` (�). cp1250 *contains* every Polish letter, so Python never raised — the text was
silently mangled. The later `align_transcript` writes that �-laden state text to a temp file,
the engine reads it (valid UTF-8 now), then tries to write a result containing `U+FFFD` back to
its **still-cp1250** stdout → cp1250 has no `U+FFFD` glyph → the `charmap` encode error.

**Fix (two layers):**
- **`whisperx_engine.py`** — reconfigure `sys.stdout`/`sys.stderr` to `encoding="utf-8",
  errors="replace"` at import, *before* `_RESULT_OUT = sys.stdout` captures the handle. This is
  the **real, permanent** fix. ⚠️ Requires **rebuilding the sidecar(s)** — the frozen exe has
  the old code.
- **`engine.rs` `with_utf8_io()`** — sets `PYTHONUTF8=1` + `PYTHONIOENCODING=utf-8` on all 3
  engine spawn sites (run_engine + whisper.rs ×2). Intended as belt-and-suspenders, but the
  `charmap` error proves **PyInstaller-frozen exes do NOT honor these env vars** (stdio is set
  up by the bootloader first). Kept anyway — harmless, correct for non-frozen/dev, and sets the
  in-engine `open()`/FS default encoding. **Do not rely on it alone — the rebuild is mandatory.**

**Status / remaining:**
- ✅ Both fix layers committed to source; `cargo check` clean.
- ✅ **GPU sidecar REBUILT + VERIFIED** (2026-06-28, 3.3 GB, in `binaries/`). Decisive test:
  ran the rebuilt exe `--align-only` on a 1 s silent WAV with transcript `zażółć gęślą jaźń`
  (needs an `ffmpeg.exe` on PATH for the engine's `load_audio` when run standalone); the result
  JSON `strict`-decodes as UTF-8 and `text == "zażółć gęślą jaźń"` → **True**. Hexdump confirmed
  `c5 bc`=ż etc. (UTF-8), no lone cp1250 bytes.
- ⏳ **In-app confirm:** re-transcribe FRESH in `npm run tauri dev` — diacritics must be correct.
  The old in-app transcript is corrupted (�) and **cannot be recovered** — do NOT re-align it.
  Note: this box auto-selects the **GPU** sidecar, so the in-app test exercises the GPU exe (already
  UTF-8-verified); the CPU exe is proven separately by the standalone align test below.
- ✅ **CPU sidecar REBUILT + VERIFIED** (2026-06-28, 464 MB, 14:22, in `binaries/`). Frozen
  `--selftest` green (`{ok:true, gpu:false, device:"cpu", alignment_model_ready:true}`). Decisive
  UTF-8 test (same as the GPU one): `--align-only` on a 1 s silent WAV with transcript
  `zażółć gęślą jaźń` (ffmpeg.exe on PATH) → result JSON `strict`-decodes as UTF-8, no U+FFFD,
  `text == "zażółć gęślą jaźń"` → **exact match True**. Hexdump confirmed `c5 bc`=ż / `c3 b3`=ó /
  `c5 82`=ł / `c4 87`=ć (UTF-8), zero cp1250 bytes. Build reused the existing `.venv` (deps already
  satisfied), so it was a re-stage-align-model + PyInstaller re-freeze only.

---

## Live progress (update as you go)

- [x] **Phase 1** — ffmpeg in place + verified; Python 3.11 `.venv` created.
- [x] **Phase 2** — CPU sidecar built (464 MB) + frozen `--selftest` green (cpu). `build.sh`
  patched: lock `--no-deps` on all platforms + non-mac torch trio (2.8.0) + win PyInstaller deps.
- [x] **Phase 3** — cu128 build.sh patch + naming reconcile + `.venv-gpu` + GPU sidecar
  (3.3 GB) built; `--selftest` green (`gpu:true, device:"cuda"`). CUDA DLLs baked into the
  onefile (no loose staging). CT2 transcribe-on-CUDA still to confirm in Phase 5.
- [x] **Phase 4** — both externalBin registered + `engine_sidecar()` auto-select (cheap,
  spawn-free) + variant folded into readiness key; `cargo check` clean; regression 272/272.
- [x] **Phase 5** — keyring `windows-native` done; GPU transcribe + CT2-on-CUDA confirmed in-app;
  §7 walk PASSED (user-verified 2026-06-28): fresh transcription diacritics correct, API key persists
  across relaunch, `.reelproj` round-trips.
- [x] **Phase 6** — Polish-diacritics UTF-8 fix: source patched (engine.py reconfigure +
  engine.rs `with_utf8_io`); **both** sidecars rebuilt + UTF-8-verified standalone (GPU 3.3 GB
  14:07, CPU 464 MB 14:22; both strict-decode `zażółć gęślą jaźń` exactly); in-app fresh
  transcription confirmed correct diacritics (user-verified 2026-06-28). **All phases complete —
  ready to commit.**

Task tracker mirrors this (TaskCreate IDs 1–5; #1 ffmpeg and the venv step are done).

---

## Risks / things that will bite (watch these)

- **cu128 wheel availability** — confirm torch/torchaudio cu128 wheels exist for Win+py3.11
  before committing; Blackwell support landed in newer torch only.
- **CUDA DLL bundling** — the GPU sidecar's real complexity; missing cuDNN/cuBLAS = silent
  CPU fallback or a hard crash. Test on a machine **without** the CUDA toolkit installed.
- **Two externalBin both required at build time** — Tauri hard-fails if either arch-suffixed
  binary is missing for the host triple. If a build machine can't produce the GPU build,
  we need a strategy (stub, conditional config, or always build both here). Decide in Phase 4.
- **CPU vs GPU venv collision** — don't install cu128 torch over CPU torch in the same
  `.venv`; use a second venv (`.venv-gpu`) or clean rebuild.
- **Long paths / PyInstaller temp** — enable Win32 long-path support if the freeze fails on
  path length; whitelist `binaries/` in AV/SmartScreen (unsigned frozen exe, slow first spawn).
- **`.gitignore` discipline** — never commit the rebuilt sidecars / `align_models/` / CUDA
  DLLs; the `whisperx-engine-*`, `ffmpeg-*`, `align_models/` globs already cover the engine
  variants across triples — verified `src-tauri/binaries/whisperx-engine-*` also matches the
  new `whisperx-engine-gpu-...` name. (CUDA DLLs staged loosely in `binaries/` are **not** yet
  ignored — add a glob in Phase 3 once their names are known.)
- **Keep one codebase** — all divergence stays in build.sh + Cargo features + tauri.conf.json
  + the new Rust selection helper. Do **not** fork the frontend/parser/exporters.
