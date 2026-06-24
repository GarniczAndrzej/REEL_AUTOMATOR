<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Auto Mode Pipeline (S-07)

- **Plan**: context/changes/auto-mode-pipeline/plan.md
- **Scope**: All 4 phases (full plan)
- **Date**: 2026-06-24
- **Verdict**: NEEDS ATTENTION (all findings triaged — see Decisions)
- **Findings**: 0 critical, 3 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Automated: regression 258/258 PASS · `runAnalysis`/`analyzeSentences` re-export
confirmed · prettier clean on touched files (the lone repo-wide prettier warning is
on `src/ai/openrouter-picker.js`, which is not in this change's scope).

## Findings

### F1 — Batch export loop aborts the whole queue on one bad video

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality (Reliability)
- **Location**: src/ui/auto-mode/batch.js:293-321
- **Detail**: Transcription failures `continue` to the next video, but the export section (buildBatchItems + saveTextToFolder loop) was unguarded. A thrown exporter or failed save on one video escaped to the outer try/finally, abandoning every remaining video in the queue.
- **Fix**: Wrapped the per-video export build+save in try/catch that sets `video.status='error'`, toasts, `emit()`s, and `continue`s — mirroring the transcription-failure handler.
- **Decision**: FIXED (batch.js:290-339)

### F2 — Unplanned Rust `open_path` command + open-folder button

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src-tauri/src/project.rs:31-41, lib.rs:41
- **Detail**: A new Tauri command shelling out to macOS `open` (reveal output folder) + a panel button were added but not described in the plan. Safe as written (argv-vector form, path from native picker — no injection). Issue is sign-off, not risk.
- **Fix A ⭐ Recommended**: Document in the plan as an addendum.
- **Fix B**: Revert the command + button.
- **Decision**: FIXED via Fix A (plan.md "Addenda (post-implementation)" section)

### F3 — Stale `disabled` + tooltip on the auto-mode button

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/index.html:33-34 (vs index.js:32-41)
- **Detail**: Button gating was deliberately relaxed (always opens panel; validated at launch), but index.html still shipped a static `disabled` + a tooltip implying the old input+key gating.
- **Fix**: Removed the static `disabled` and replaced the tooltip with one matching the launch-time validation model.
- **Decision**: FIXED (index.html:29-37)

### F4 — #whisperProgressBox not suppressed on the auto align path

- **Severity**: 🟢 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/ui/auto-mode/orchestrator.js:135 → transcribe.js:604
- **Detail**: On an imported-SRT + video auto run, `alignToWords()` unconditionally showed the legacy `#whisperProgressBox` alongside the unified panel. Cosmetic only.
- **Fix**: Guarded the box show on `!state.autoMode.running` so the unified panel owns progress during an auto run.
- **Decision**: FIXED (transcribe.js:604-611)

### F5 — videoBase/stripExt filename-stem helper duplicated ×3

- **Severity**: 🟢 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: orchestrator.js:455, batch.js:436, export-popover.js:266
- **Detail**: The same filename-stem logic was copy-pasted across three modules.
- **Fix**: Extracted a pure `stripExt(name)` into `src/util/filename.js`; `videoBase()` in orchestrator.js + export-popover.js now wraps it, and batch.js imports it.
- **Decision**: FIXED (new src/util/filename.js + 3 call sites)
