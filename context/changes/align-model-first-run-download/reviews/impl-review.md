<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Align Model First-Run Download

- **Plan**: context/changes/align-model-first-run-download/plan.md
- **Scope**: Full plan (Phases 1–4 of 4)
- **Date**: 2026-07-03
- **Verdict**: NEEDS ATTENTION → all findings triaged & FIXED (2026-07-03)
- **Findings**: 0 critical, 2 warnings, 4 observations (F1–F6 all FIXED; re-verified: cargo check clean, py_compile OK, prettier clean, regression 272/0)

## Automated criteria (all green)

- `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml` — clean
- `node --experimental-vm-modules test/regression.js` — 272 passed, 0 failed
- `python3 -m py_compile sidecar/whisperx_engine/whisperx_engine.py` — OK
- `tauri.conf.json` — valid JSON
- Prettier — the 3 changed src files are clean. `src/styles.css` fails `--check`
  but is NOT in this change's diff (pre-existing, out of scope — correctly not
  swept into a feature commit per the project lesson).

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

Notes: All planned changes across the four phases verified MATCH. Both Phase-1
deviations (weight-format `*.bin` OR `*.safetensors` allow-list; torch-free
proactive fetch) are documented in change.md and correctly implemented. The
highest-risk concern — a presence-check glob mismatch where the model downloads
as `pytorch_model.bin` but a safetensors-only check reports "Brak" forever — was
investigated and is SAFE: both `align_model_present` (engine.rs:118, matches
`bin` || `safetensors`, >1KB) and `_align_model_cached` (whisperx_engine.py:331)
detect the `.bin`, and HF writes the snapshot symlink only after the blob
verifies (interrupted download → Brak, no false positive).

## Findings

### F1 — Double-click starts two concurrent align downloads

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (Reliability/Concurrency)
- **Location**: src/ui/import/transcribe.js:538 · src-tauri/src/whisper.rs:899
- **Detail**: downloadAlignModel sets `_alignDownloading = true` then
  `await renderAlignModelCard()` (async import) BEFORE the button is disabled,
  and there is no early `if (_alignDownloading) return;`. download_align_model
  (Rust) is outside ensure_engine_free and also has no in-flight guard. A fast
  double-click reaches invoke('download_align_model') twice → two cold sidecars
  writing the same cache dir; the first `finally` re-enables the button while the
  second still runs. Corruption prevented only by HF's per-blob filelock.
- **Fix**: Add an early `if (_alignDownloading) return;` at the top of
  downloadAlignModel (before the first await); optionally back it with a Rust
  AtomicBool in-flight guard.
  - Strength: One-line JS guard closes the common double-click path; mirrors the
    single-flighted transcribe path.
  - Tradeoff: JS-only guard doesn't stop a second invoke from devtools/another
    window — Rust guard is defense in depth.
  - Confidence: HIGH — race visible in code ordering.
  - Blind spot: HF filelock already prevents on-disk corruption, so this is a
    UX/wasted-work fix, not data loss.
- **Decision**: FIXED via Fix B (JS early-return guard + Rust AtomicBool in-flight guard)

### F2 — download_align_model can hang forever on a silent stall

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (Reliability)
- **Location**: src-tauri/src/whisper.rs:926
- **Detail**: The command pumps the sidecar with an unbounded
  `while let Some(ev) = rx.recv().await` — no idle/overall timeout and no cancel
  path (button disabled during the run). A hung-but-alive connection mid-1.2 GB
  pull wedges the command indefinitely; only quitting the app recovers. A hard
  connection drop exits 15, so this only bites on a silent stall.
- **Fix**: Wrap the recv loop in a generous idle timeout (no progress for N
  minutes → abort + Polish error) or wire a cancel hook.
  - Strength: Bounds the worst case; report-only probes already use bounded
    run_engine as precedent.
  - Tradeoff: Timeout value is a judgment call — too tight aborts a slow-but-live
    download.
  - Confidence: MED — real but narrow (silent stall only).
  - Blind spot: No measured slow-link download durations to size the timeout.
- **Decision**: FIXED (15-min idle timeout on the recv loop; kills child + Polish timeout message on stall)

### F3 — whisperx_engine.spec comments still describe the bundled model

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency (documentation)
- **Location**: sidecar/whisperx_engine.spec:5-9, 22-25
- **Detail**: `datas = []` is correct (model-free freeze), but the surrounding
  comments still say the align model "are bundled as data" and build.sh "stages
  it BESIDE the sidecar binary" — both false after Phase 4. Phase 4 §3's
  doc-cleanup list named whisperx_engine.py and engine.rs but not the .spec.
  No runtime impact.
- **Fix**: Update the .spec header comments to describe the first-run download
  cache, matching whisperx_engine.py:71-96 and engine.rs:75-103.
- **Decision**: FIXED (rewrote .spec header + datas comment to describe first-run download cache)

### F4 — Exit-15 message assumes network cause

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Reliability)
- **Location**: src-tauri/src/whisper.rs:196
- **Detail**: A disk-full or permission failure while writing the 1.2 GB model
  also maps to "Pierwsze uruchomienie wymaga połączenia z internetem…",
  misdirecting the user.
- **Fix**: Distinguish write/space failures from network failures where feasible.
- **Decision**: FIXED (softened exit-15 message to name network OR disk-space/write-permission)

### F5 — First MB/s reading artificially low

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency (UX)
- **Location**: src/ui/import/transcribe.js:547
- **Detail**: lastTime is set before `await invoke(...)`, so the 37–67 s cold
  spawn counts as download time and deflates the first MB/s sample. Self-corrects
  on the next event.
- **Fix**: Reset lastTime on the first progress event.
- **Decision**: FIXED (seed rate baseline on first progress event)

### F6 — ProgressTqdm leaks a /dev/null fd

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Resource)
- **Location**: sidecar/whisperx_engine/whisperx_engine.py:365
- **Detail**: `kwargs["file"] = open(os.devnull, "w")` is never closed. Process
  is short-lived (exits after fetch), so impact is negligible.
- **Fix**: Close the handle (or use a class-level shared null sink).
- **Decision**: FIXED (class-level shared null sink instead of per-instance open)
