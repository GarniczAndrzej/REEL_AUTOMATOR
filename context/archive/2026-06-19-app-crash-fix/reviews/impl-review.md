<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: App Crash Fix (S-21)

- **Plan**: context/changes/app-crash-fix/plan.md
- **Scope**: Phases 1–4 of 4 (full plan)
- **Date**: 2026-06-22
- **Verdict**: APPROVED
- **Findings**: 0 critical  0 warnings  1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Verification

| Check | Result |
|---|---|
| `cargo test` | PASS — 6/6; bounded-tail tests (`_stays_capped_and_keeps_latest`, `_is_multibyte_safe`) green |
| `cargo check` | PASS (implied; test profile compiled) |
| `node --experimental-vm-modules test/regression.js` | PASS — 203 passed, 0 failed |
| Prettier (changed files) | PASS |

### Reviewer-verified correctness notes

- **Orphan race (P3) closed**: `drive_engine` and `cancel_transcription` both reap via a single atomic `TRANSCRIBE_CHILD.lock().take()` — winner gets `Some` and reaps, loser gets `None` and no-ops. No double-kill, no orphan window. Escalation centralized in `reap_engine_child` (SIGTERM → 300ms → SIGKILL).
- **Stale cancel flag handled**: `TRANSCRIBE_CANCELLED` reset to `false` at the start of `transcribe_video` (whisper.rs:418) and `align_transcript` (whisper.rs:712) — a cancel landing at the completion boundary cannot poison the next run.
- **stdout_buf uncapped**: only `stderr_buf` is bounded; `stderr_buf` feeds only `engine_error_message` (whisper.rs:555/793), while `stdout_buf` is the JSON parsed at whisper.rs:559/796.
- **Scope discipline**: no try/catch refactor, no waveform/ffmpeg changes, no stdout ring-buffering, no cancel-UX/timing changes — "NOT doing" list respected.
- **Lessons honored**: Polish strings throughout, `toast()` reused (no synchronous dialogs), panic hook chains to the default rather than suppressing.

## Findings

### F1 — Repo-wide Prettier check not clean (pre-existing, unrelated)

- **Severity**: 📝 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: src/ai/api-key.js, src/ui/step2-preset-bar.js
- **Detail**: Criterion 1.3 ("Prettier clean") was marked done, but a repo-wide `prettier --check` flagged 2 files. Neither is touched by S-21 — both pre-existing style debt. The files this change modified (src/main.js, src/ui/import/segments.js) are clean; no new formatting drift was introduced.
- **Fix**: `npx prettier --write src/ai/api-key.js src/ui/step2-preset-bar.js`.
- **Decision**: FIXED — formatted both files; repo-wide `prettier --check` now reports "All matched files use Prettier code style!". (Working-tree changes to the 2 files are uncommitted and unrelated to the S-21 commits.)
