<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Word-by-word SRT export

- **Plan**: context/changes/word-level-srt-export/plan.md
- **Scope**: All 3 phases
- **Date**: 2026-06-18
- **Verdict**: APPROVED (with minor hardening notes)
- **Findings**: 0 critical, 1 warning, 2 observations (note: F1 promoted to WARNING)

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

Automated: regression 203 passed / 0 failed; `cargo check` clean.
Manual: criteria 3.3–3.10 attested `[x]` under commit 2d1e092 (GUI flows).

## Findings

### F1 — generateWordSRT clamp can emit a reversed cue

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/exporters/transcript.js:88-89
- **Detail**: The clamp `if (next && end > next.start_frame) end = next.start_frame` trusts the documented "words in global chronological order" invariant. Diarized/overlapping speech can yield a next-word onset < current start, making `end < start` (negative-duration cue). The 4-frame floor runs before the clamp, so it offers no protection.
- **Fix**: `end = Math.max(start, next.start_frame)` — preserves zero-overlap intent, can never invert the cue.
- **Decision**: FIXED

### F2 — alignToWords @returns sits in a // comment, not a JSDoc block

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/ui/import/transcribe.js:493-500
- **Detail**: alignToWords is a new exported, cross-module boundary function. Repo type-discipline requires JSDoc at boundaries, but `@returns` lived inside a `//` line-comment block (no tooling pickup). Sibling exported fns use proper `/** */` blocks.
- **Fix**: Convert the leading `//` block to a `/** ... @returns {Promise<boolean>} */` JSDoc block.
- **Decision**: FIXED

### F3 — hasFrameWords gate vs generateWordSRT field requirement mismatch

- **Severity**: ◽ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/ui/export-popover.js:225-231
- **Detail**: hasFrameWords() admitted a sentence if any word had a finite `start_frame` only, but generateWordSRT requires BOTH `start_frame` and `end_frame` finite. A word with finite start_frame + NaN end_frame passed the gate yet was dropped by the generator → a near-empty `.srt` could be written.
- **Fix**: Add `&& Number.isFinite(w.end_frame)` to the hasFrameWords predicate.
- **Decision**: FIXED

### F4 — New advanced-settings helpers lack boundary JSDoc

- **Severity**: ◽ OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/ui/import/transcribe.js (defaultWhisperAdvanced, load/saveWhisperAdvancedToLS, fill/applyWhisperAdvancedForm)
- **Detail**: New advanced-settings helpers were untyped, diverging from the repo's "JSDoc at boundaries" discipline.
- **Fix**: Added brief `@returns` JSDoc to the persistence/form helpers.
- **Decision**: FIXED

## Not flagged (by design)

- The WhisperX-card `⬇ Eksport .srt` button staying sentence-only is explicitly planned ("What We're NOT Doing"), not drift.
- `alignToWords` returning `false` instead of throwing is within contract ("success boolean (or throw)").
- Checkbox in a new "Eksport napisów" subsection rather than literally beside `advForceCpu` is cosmetic — same modal; Plan Adherence stays PASS.
