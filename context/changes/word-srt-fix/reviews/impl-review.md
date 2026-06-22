<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Word-by-word SRT export — fix

- **Plan**: context/changes/word-srt-fix/plan.md
- **Scope**: Phases 1–3 of 3 (full plan)
- **Date**: 2026-06-22
- **Verdict**: APPROVED
- **Findings**: 0 critical, 2 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | WARNING |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Automated criteria re-run during review: regression suite **206 passed / 0 failed** (incl. new
Test 16 — F1 reversed-cue/diarized-overlap clamp); Prettier clean on all touched files.

## Findings

### F1 — Phase 2 built as a module extraction, not the planned in-place toast patch

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence
- **Location**: src/ui/export-srt.js (new), src/ui/export-popover.js:182, src/ui/import/transcribe.js:632
- **Detail**: Phase 2 §1 scoped an in-place toast audit of `exportSRT` in `export-popover.js`. Implementation (`f8e8987`) instead extracted a new shared `src/ui/export-srt.js` (`exportTranscriptSrt`), removed `exportSRT`/`hasFrameWords` from the popover, and routed both SRT buttons through it. Beneficial drift: the import-section `#exportSrtBtn` previously called `exportTranscriptSRT`, which always emitted sentence-level SRT and ignored the word-by-word toggle entirely — the refactor makes both entry points honor the toggle. Import cycle broken via dynamic `import('./import/transcribe.js')`. No timing-math change.
- **Fix**: Document the extraction + the second-button toggle bug as a plan addendum. No code change.
- **Decision**: FIXED via documentation — addendum added to plan.md (## Addenda, post-implementation).

### F2 — Out-of-scope files committed against an explicit "What We're NOT Doing"

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: ee34f17 — src/ai/api-key.js, src/ui/step2-preset-bar.js
- **Detail**: Plan "What We're NOT Doing" #5 said leave the unrelated Prettier edits untouched in the working tree, but Phase 1 commit `ee34f17` committed both. Diffs are confirmed pure Prettier reformatting (no behavior change); commit message records "staged at user request." Knowingly user-authorized, not a silent violation.
- **Fix**: Reconcile the plan's "NOT doing" #5 with what shipped.
- **Decision**: ACCEPTED-AS-RULE: "Incidental Prettier churn must not ride into a feature commit" (lessons.md) + FIXED — plan.md "NOT doing" #5 reconciled to note the files were committed in ee34f17 at user request.

### F3 — transcriptBase() duplicated across two export modules

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/ui/export-srt.js:31 vs src/ui/export-popover.js:240
- **Detail**: New `export-srt.js` defined a `transcriptBase()` byte-identical to the one still in `export-popover.js`. Two sources of the same filename rule can drift independently. Trivial DRY nit.
- **Fix**: Export `transcriptBase()` from one module and import it in the other.
- **Decision**: FIXED — `transcriptBase()` now exported from export-srt.js (with JSDoc) and imported by export-popover.js; local copy removed. Regression 206/0 green, Prettier clean.

### F4 — Manual criteria all checked; the exact failure mode S-20 exists to correct

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Success Criteria
- **Location**: plan.md ## Progress (Manual blocks)
- **Detail**: Every GUI-bound manual box is `[x]`. The diff proves the mechanisms exist (toasts on every abort path, `ask()` confirm gate, progress-box hide on cancel, Polish strings) but GUI behavior can't be evidenced from a diff. S-19 (the reason this change exists) attested manual criteria without running them.
- **Fix**: Confirm the GUI flows were hands-on tested, not re-attested.
- **Decision**: SKIPPED — user confirms the `npm run tauri dev` flows were observed hands-on.
