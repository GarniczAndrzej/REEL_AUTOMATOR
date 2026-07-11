<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: GPU Engine Autodetect (S-30)

- **Plan**: `context/changes/gpu-engine-autodetect/plan.md`
- **Scope**: Phases 1–5 (all)
- **Date**: 2026-07-11
- **Verdict**: REJECTED → all 8 findings FIXED in triage (2026-07-11)
- **Findings**: 2 critical, 3 warnings, 3 observations

## Summary

Plan adherence is exemplary: all 36 contracts across five phases verified MATCH against the
actual code — zero DRIFT, zero MISSING, no unplanned files. Every deviation was ratified
in-session and recorded in `change.md`. All automated criteria re-verified green
(272 JS regression, 43 Rust unit tests, cargo build, Prettier).

The blocker is a single failure mode, the mirror image of the change's own best idea:
`gpuUnusable` is a deliberately one-way verdict that turns out to be **too easy to trigger
(F2) and impossible to undo (F1)**. Both fixes are small and local — ~15 lines across two
functions.

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | FAIL |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Findings

### F1 — The `gpuUnusable` escape hatch documented in the code does not exist

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (and a latent plan flaw)
- **Location**: src-tauri/src/whisper.rs:141-147
- **Detail**: `set_gpu_unusable`'s doc (`deps.rs:447-450`) promises "an env or UI
  variantOverride beats the verdict in resolve_variant, so they are never stuck." That holds
  for the *variant string* — but `push_gpu_demotion` never consults the override, so
  `REEL_ENGINE_VARIANT=gpu` resolves to `gpu`, spawns the GPU exe, and still gets
  `--device cpu` appended. CT2 is pinned to CPU permanently. There is no `clear_gpu_unusable`
  writer anywhere, and the only device UI ("Wymuś CPU") emits `'cpu'` or `''` — never a value
  that re-arms CUDA. Sole recovery is hand-editing `deps-settings.json`. Traces back to a
  plan self-contradiction: plan line 348 promises the override wins; line 350 specifies the
  spawn-site rule that breaks that promise. The implementation is faithful to 350.
- **Fix A ⭐ Recommended**: Make `push_gpu_demotion` honor an explicit GPU override
  - Strength: Restores the guarantee the code already claims, in ~3 lines, no new UI surface;
    mirrors `resolve_variant`'s precedence so the two agree instead of quietly disagreeing.
  - Tradeoff: A user who forces `gpu` on a genuinely broken box re-runs the failure — but
    that is what an explicit override means.
  - Confidence: HIGH — precedence logic already exists next door in `resolve_variant`.
  - Blind spot: None significant.
- **Fix B**: Add a `clear_gpu_unusable` command + a "Spróbuj ponownie GPU" button
  - Strength: Discoverable in-app recovery, not just a power-user env var.
  - Tradeoff: New command + UI + Polish strings; bigger surface than the bug.
  - Confidence: MEDIUM — needs a spot in the ZALEŻNOŚCI panel and a re-probe flow.
  - Blind spot: Haven't checked how the panel would re-run `verify_staged_engine`.
- **Decision**: FIXED via Fix A — `resolve_gpu_forced` + `gpu_forced()` (deps.rs); `push_gpu_demotion` now honors an explicit GPU override (whisper.rs). Test: `gpu_forced_is_the_other_half_of_the_escape_hatch`.

### F2 — `is_cuda_failure` over-matches: a routine OOM permanently kills a healthy GPU

- **Severity**: ❌ CRITICAL
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src-tauri/src/whisper.rs:217-223
- **Detail**: The guard excludes only the literal `out of memory`, then matches the bare
  `cuda` substring. CTranslate2's cuBLAS workspace OOM surfaces as
  `cuBLAS failed with status CUBLAS_STATUS_ALLOC_FAILED` — contains `cublas`, contains no
  "out of memory" → matches → `set_gpu_unusable()` (whisper.rs:740). A user picks large-v3
  with too big a batch_size and permanently converts an RTX 5070 Ti into a CPU box. Likewise
  `CUDA error: unknown error (999)` (post-sleep driver hiccup) and
  `CUDA driver version is insufficient` (update pending reboot) both match the bare `cuda`
  marker → permanent demotion for a reboot-fixable state. The doc comment at :213-216 states
  the right intent; the code under-delivers on it. With F1 there is then no way back.
- **Fix**: Match the two enumerated markers as literals rather than the bare `cuda`
  substring; explicitly exclude the `CUBLAS_STATUS_ALLOC_FAILED` / `CUBLAS_STATUS_NOT_INITIALIZED`
  family and error 999. Add a test case — the suite has no `CUBLAS_STATUS_ALLOC_FAILED`
  example, which is why the gap is invisible to it.
- **Decision**: FIXED — split the predicate: `is_cuda_failure` (broad, retry) vs `is_permanent_cuda_failure` (narrow, demote). OOM / CUBLAS_STATUS_ALLOC_FAILED / unknown-error-999 / stale-driver now retry on CPU but never brand the machine. Tests: `a_capacity_or_transient_failure_retries_but_never_brands_the_machine`, `only_a_structural_cuda_failure_brands_the_machine`.

### F3 — A CUDA init failure at model construction exits 10, bypassing the net entirely

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: sidecar/whisperx_engine/whisperx_engine.py:519-525
- **Detail**: The `except Exception` around `WhisperModel(...)` maps *every* model-load
  failure to `EXIT_MODEL_NOT_FOUND` (10) — and the canonical cuBLAS message
  (`Library cublas64_12.dll is not found or cannot be loaded`) literally contains "not found",
  so it takes the first branch. `should_retry_on_cpu` requires exit 14 → no CPU retry, and
  `engine_error_message(10)` tells the user to "download a model in the model manager".
  Scope: this block is pre-existing (untouched by this change), and the research established
  the measured cuBLAS failure surfaces at first `encode` (→ exit 14), so the net's primary
  path works. The residual is a CUDA-context init failure at construction time — narrower
  than it looks, but it lands on the least helpful error message in the set.
- **Fix**: In the sidecar, test for CUDA/cuBLAS markers *before* the "not found" heuristic and
  exit `EXIT_TRANSCRIBE_FAIL`; or in Rust, treat exit 10 + a CUDA marker as retryable.
- **Decision**: FIXED — sidecar checks CUDA/cuBLAS markers BEFORE the "not found" heuristic and exits 14. NOTE: source-only until the engine is rebuilt, re-hosted and re-pinned.

### F4 — An NVIDIA card with a pre-R495 driver is reported as "no graphics card"

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src-tauri/src/deps.rs:924-930
- **Detail**: `nvidia-smi` rejects the `compute_cap` query field on drivers below R495 →
  non-zero exit → `nvidia_query()` returns `None`. Control falls to the DXGI branch, whose
  picker selects `amd | intel`, then `unknown` — an adapter tagged `nvidia` is never picked.
  Result: `vendor: "none"`, reason "Nie wykryto dedykowanej karty graficznej". That is
  precisely the user the 527.41 driver floor exists to serve, told the opposite of the truth.
  Variant selection is still correct (CPU either way) — reporting only, but "honest hardware
  detection" was Phase 3's entire title.
- **Fix**: Add an `nvidia` arm to the picker chain with its own Polish reason — "wykryto kartę
  NVIDIA, ale nie udało się odczytać sterownika — zaktualizuj sterownik NVIDIA".
- **Decision**: FIXED — `gpu_info()`'s DXGI picker gained an `nvidia` arm with a Polish "update your driver" reason.

### F5 — `download_dependency` stages by `detect_variant()`, not by the dep's own predicate

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Architecture
- **Location**: src-tauri/src/deps.rs:1317-1321
- **Detail**: `let variant = detect_variant();` is pre-existing (confirmed via `git log -L`:
  unchanged in this range), but this change is what makes it reachable, because it introduces
  a variant that flips *mid-session*. Scenario: `verify_staged_engine` demotes → `gpuUnusable`
  written → `detect_variant()` flips to `cpu`. A stale "Ponów" row for `engine-gpu` (rendered
  before the flip) now stages the GPU exe at `engine/cpu/whisperx-engine-<triple>.exe`.
  `engine_bin_resolved` then tags that binary `"cpu"`, `is_gpu_variant` is false, and the CUDA
  retry gate never fires for what is actually a CUDA binary — reintroducing the exact "the
  label lies" bug the variant tag was invented to kill, through the staging path.
- **Fix**: `let variant = dep.variant_predicate.as_deref().unwrap_or_else(|| detect_variant());`
  (FFmpeg has no predicate and correctly keeps the fallback.)
- **Decision**: FIXED — `download_dependency` stages by `dep.variant_predicate` (`any` follows the host).

### F6 — `gpu-full` is stranded on disk after download

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Architecture
- **Location**: src-tauri/src/engine.rs:95-101
- **Detail**: `variant_fallbacks` never falls back *to* `gpu-full`. Unset
  `REEL_ENGINE_VARIANT` after downloading the 3.08 GB gpu-full engine and the app reports
  "Silnik WhisperX niedostępny" with a 3 GB artifact sitting inert on disk. Consistent with
  the env-only design, but the stranding deserves a Polish hint.
- **Fix**: Add a Polish hint when a `gpu-full` binary is staged but the variant is not `gpu-full`.
- **Decision**: FIXED — `variant_fallbacks` appends `gpu-full` last for `gpu`/`cpu`. Test: `a_stranded_gpu_full_engine_is_still_spawned_rather_than_ignored`.

### F7 — Post-demotion nag for a redundant CPU engine

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/ui/first-run-deps.js (maybeAutoOpen) + src-tauri/src/deps.rs (required_deps)
- **Detail**: After a demotion the required set flips to the CPU engine (not staged) →
  `variant_satisfied` false → the ZALEŻNOŚCI window re-opens and nags for a ~700 MB CPU engine
  that `push_gpu_demotion` has already made redundant: the staged GPU exe runs fine with
  `--device cpu`.
- **Fix**: Treat a staged GPU engine + a persisted `gpuUnusable` as satisfying the CPU variant.
- **Decision**: FIXED — `variant_satisfied` treats a demoted box holding a GPU build as satisfied.

### F8 — `merge_specs` appends remote-only ids verbatim

- **Severity**: 💡 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (supply chain)
- **Location**: src-tauri/src/deps.rs:120-125
- **Detail**: `merge_specs` appends remote-only ids with hash *and* URL from the remote host.
  A compromised deps host could add a new `stageTo: "engine-bin"` id that passes
  `validate_hashes` (non-empty, self-consistent digest) and gets staged and spawned.
  Pre-existing and outside this diff, but it is the one seam in the "embedded spec is the
  trust root" story that this change leans on heavily.
- **Fix**: Reject remote-only ids whose `stageTo` is an executable slot, or require every
  spawnable id to exist in the embedded spec.
- **Decision**: FIXED — `merge_specs` drops remote-only ids that stage into a spawnable slot (`is_spawnable_slot`). Test: `merge_refuses_a_remote_only_executable`. The pre-existing `merge_keeps_embedded_hash_repoints_url` asserted the vulnerable behavior on `ffmpeg-bin` and was moved to a data slot.

## Verified sound (no action)

- `validate_hashes` fails closed on empty *and* absent digests, before any network I/O, for
  both dep shapes.
- The `unsafe` DXGI block is correct — RAII releases the COM factory and adapters, `i += 1`
  precedes the `continue` so no infinite loop, UTF-16 truncated at NUL.
- No command injection: `REEL_ENGINE_VARIANT` escapes `resolve_variant` only as one of three
  `&'static str` literals.
- `build.sh`'s cuBLAS wheel is pinned **and** SHA-256-verified before extraction.
- `rthook_cublas.py` genuinely cannot raise.
- The retry is capped at one *by construction* (a single `if`; the appended `--device` makes
  `argv_pins_device` true thereafter).
- Cancellation is checked first **and** independently defeated by `exit_code: None`.
- S-18 holds — nothing spawns the engine on the launch path.
- The driver-floor test really is a `(u32, u32)` tuple compare, so `527.9` correctly reads as
  older than `527.41`.

*Doc nit (not a finding): `CLAUDE.md` says the GPU engine is ~984 MB; the pinned spec says
1,031,465,189 B ≈ 1.03 GB.*
