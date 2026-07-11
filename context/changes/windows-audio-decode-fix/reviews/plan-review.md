<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Windows Audio Decode Fix

- **Plan**: `context/changes/windows-audio-decode-fix/plan.md`
- **Mode**: Deep
- **Date**: 2026-07-11
- **Verdict**: REVISE → **SOUND** (all 4 findings fixed in plan)
- **Findings**: 1 critical, 2 warnings, 1 observation

## Verdicts

| Dimension | Verdict | After fixes |
|-----------|---------|-------------|
| End-State Alignment | FAIL | PASS |
| Lean Execution | WARNING | PASS |
| Architectural Fitness | PASS | PASS |
| Blind Spots | WARNING | PASS |
| Plan Completeness | PASS | PASS |

## Grounding

9/9 paths ✓, 14/14 symbols ✓, brief↔plan ✓, Progress↔Phase contract ✓ (3 phases, 21 rows, all
Success-Criteria bullets mapped). The `load_audio` snippet the plan tells the implementer "not to
re-derive" was checked byte-for-byte against `whisperx/audio.py` 3.8.6 — it matches (only `str(sr)`
vs the literal `16000`, equivalent at `SAMPLE_RATE=16000`). The `stale` → "Aktualizuj" affordance
Phase 3 depends on exists (`first-run-deps.js:392`). No `docs/reference/contract-surfaces.md` in
this repo — surface check skipped.

Minor prose imprecision, not filed as a finding: Current State says "**Both** resolution paths are
triple-suffixed," but `ffmpeg_bin_path` has *three* branches — the middle (beside-exe, macOS
bundle) is bare-named. The design handles it correctly via the bare-name branch; only the prose
undercounts.

## Findings

### F1 — The decode self-test cannot report `false` — it exits 11 instead

- **Severity**: ❌ CRITICAL
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: End-State Alignment
- **Location**: Phase 2 §2 (and Implementation Approach)
- **Detail**: The plan gave `_selftest_decode_runs` two mutually exclusive properties: it "pushes it
  through **the same `_load_audio`**" AND it "returns a bool — swallowing any exception rather than
  exiting, exactly as `_selftest_align_runs` (`:266`) does." It cannot do both. `_load_audio`
  (`whisperx_engine.py:374-382`) ends both failure branches in `sys.exit(EXIT_AUDIO_DECODE_FAIL)`,
  which raises `SystemExit` — a `BaseException`, not an `Exception`. `_selftest_align_runs` catches
  `except Exception` (verified at `:296`), which will not catch it. So on a machine that genuinely
  cannot decode, `--selftest` never emits `audio_decode_ready: false`: the process exits 11, and
  `whisperx_engine_check` (`engine.rs:473`) maps any non-zero exit to
  `Err("Silnik WhisperX zakończył self-test z błędem (kod 11)")`. Success criteria 2.6 and 2.7, plus
  the Testing Strategy's "a check that cannot fail is not a check", were unreachable as written.
- **Fix**: Split the decode from the exit. `_decode_audio(whisperx, path)` does the work and lets
  exceptions propagate; `_load_audio` becomes the thin try/except → `sys.exit(...)` wrapper the
  three commands keep calling; `_selftest_decode_runs()` calls `_decode_audio` inside
  `try/except Exception → return False`.
  - Strength: One decode path, two failure contracts; the self-test can finally fail.
  - Tradeoff: None material — it is a refactor of one function into two.
  - Confidence: HIGH — `sys.exit` / `SystemExit` semantics verified against the file.
  - Blind spot: None significant.
- **Decision**: FIXED (Fix in plan — Implementation Approach, Phase 2 §1 + §2, and a new
  *Critical Implementation Details* entry)

### F2 — Hardlinked shim goes stale (and leaks 143 MB) on the first FFmpeg re-stage

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots
- **Location**: Phase 1 §1 (`ffmpeg_shim_dir`) + Critical Implementation Details ("Shim idempotency")
- **Detail**: The plan made the shim unconditionally idempotent — "if the shim file already exists,
  return immediately without touching it." But FFmpeg is a versioned, updatable dep
  (`ffmpeg-windows-x86_64`, version `1.0.0`, `deps-spec.json:45-56`), and `download_dependency`
  stages via `.part` → SHA-verify → `swap_in_place` (`deps.rs:1121-1140`), which is
  `rename(final → .bak); rename(part → final)`. A rename installs a **new inode**. The pre-existing
  hardlink at `<ffmpeg_dir>/bin/ffmpeg.exe` still points at the old one and, never being refreshed,
  would point there forever — so after any FFmpeg version bump the engine child silently decodes
  with the *old* FFmpeg while every Rust-side call uses the new one. The orphaned inode also stays
  alive (the `.bak` is dropped; our link is its last reference), leaking ~143 MB that never comes
  back — quietly falsifying manual criterion 1.8. A dev checkout re-running `sidecar/fetch-ffmpeg.sh`
  hits the same trap.
- **Fix A ⭐ Recommended**: Make idempotency identity-aware, not existence-aware — the shim is valid
  only when it still resolves to the same file as the target, else `remove_file` + re-`hard_link`.
  Compare `(volume_serial, file_index)` via `std::os::windows::fs::MetadataExt`, or portably
  `(len, modified)`.
  - Strength: Closes the whole class; steady-state cost stays one `metadata()` call per spawn.
  - Tradeoff: A few more lines; the metadata compare is a heuristic on the copy-fallback path.
  - Confidence: HIGH — the rename that creates the new inode is at `deps.rs:1135`.
  - Blind spot: None significant.
- **Fix B**: Writer-side invalidation — `download_dependency` deletes `<ffmpeg_dir>/bin/` after
  staging an `ffmpeg` dep.
  - Strength: The shim resolver stays a pure two-line no-op.
  - Tradeoff: Couples `deps.rs` to a shim layout it knows nothing about; misses the dev-checkout
    `fetch-ffmpeg.sh` path entirely.
  - Confidence: MEDIUM — correct for the staged path, silently incomplete for dev.
- **Decision**: FIXED via Fix A (Phase 1 §1 rewritten; *Critical Implementation Details* updated;
  new unit-test case (c) — stale-shim re-link after a rename — added to Phase 1 §4, the Testing
  Strategy, and Progress row 1.2)

### F3 — The pre-flight is dead code in its stated case, over-strict in the one left

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Lean Execution
- **Location**: Phase 1 §3 — "Pre-flight"
- **Detail**: The pre-flight called `ffmpeg_shim_dir` before spawning and hard-errored on `Err`, to
  "replace the mystifying exit-11 toast." But both commands already extract the WAV through the
  Rust-side FFmpeg first — `transcribe_video` at `whisper.rs:650` and `align_transcript` at
  `whisper.rs:1138` both call `run_ffmpeg_output`, which calls `ffmpeg_bin_path(app)?`. If FFmpeg is
  unresolvable, extraction has already failed with "FFmpeg niedostępny dla…" long before the spawn;
  that branch is dead code. The only live failure left is *shim materialization* (read-only dir) —
  and `with_ffmpeg` explicitly declares that case non-fatal, correctly, because a Phase-2 engine
  needs only `REEL_FFMPEG_BIN` and never touches the shim. The pre-flight therefore promoted a
  benign condition into a hard block, on precisely the population that needs the shim least. It also
  cannot prevent exit 11, which comes from the engine's decode — no Rust-side stat can predict it.
- **Fix ⭐**: Drop the hard pre-flight. Keep `with_ffmpeg` best-effort, and make the exit-11 arm
  (`whisper.rs:302`) name FFmpeg in its Polish message and point at ZALEŻNOŚCI — that is the toast
  the user actually sees.
  - Strength: Removes a new failure mode and a dead branch; improves the message that actually fires.
  - Tradeoff: No pre-spawn guard at all — accepted, since the guard could not fire meaningfully.
  - Confidence: HIGH — the extraction-before-spawn ordering verified at `whisper.rs:650` / `:1138`.
  - Blind spot: None significant.
- **Decision**: FIXED (Phase 1 §3 rewritten; the rejection is recorded in-plan with its rationale)

### F4 — `cmd_capability`'s `audio_decode_ready` is a check that can't fail and can't matter

- **Severity**: 💡 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Lean Execution
- **Location**: Phase 2 §2
- **Detail**: Capability was specified to report `audio_decode_ready` from a file-existence check on
  `REEL_FFMPEG_BIN`. But Rust sets that var from `ffmpeg_bin_path`, which only ever returns a path it
  has already `is_file()`-verified — so the check is true whenever the var is set. Its one real
  signal ("Rust could not resolve FFmpeg") is already carried by `variant_satisfied`
  (`engine.rs:303`) and the ZALEŻNOŚCI panel. And capability verdicts are stamped
  `authoritative: false` (`engine.rs:529`/`:564`), so they paint amber and can never reach the green
  tier this field exists to guard.
- **Fix**: Emit `audio_decode_ready` from `--selftest` only; `--capability` omits it (⇒ `None` ⇒
  "unknown") — the mirror image of how `cublas` is scoped today.
  - Strength: One less field to keep truthful; capability stays at its cheap, non-authoritative tier.
  - Tradeoff: None material.
  - Confidence: HIGH.
  - Blind spot: None significant.
- **Decision**: FIXED (Phase 2 §2; the rejected alternative is recorded in-plan)

## Note (not a finding)

`context/foundation/lessons.md` carries an accepted rule — *"plan-brief.md zawsze po polsku"* —
that applies to `plan` and `plan-review`. This change's `plan-brief.md` is in English. Not a
substance defect, so it was not filed as a finding, but it is a live deviation from an accepted
lesson and worth correcting before implementation.
