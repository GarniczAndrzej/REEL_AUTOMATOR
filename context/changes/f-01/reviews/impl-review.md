<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: F-01 — Render-path removal + regression fence

- **Plan**: context/changes/f-01/plan.md
- **Scope**: All 4 phases (full plan)
- **Date**: 2026-06-11
- **Verdict**: APPROVED
- **Findings**: 0 critical, 1 warning, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

Verified live: `cargo check` green (after clearing a stale moved-directory build cache — not an f-01 defect); regression 142 passed / 0 failed incl. new Test 8 (v2 back-compat); all grep guards clean; `src/render/` gone, `src/selection/` holds the 3 survivors; save payload is `version: 3`; `buildPrompt` (S-01's schema) untouched.

## Findings

### F1 — CLAUDE.md still documents the fully-removed render path

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Pattern Consistency (agent-facing doc contract)
- **Location**: CLAUDE.md:67-126 (pre-fix)
- **Detail**: f-01 deleted the render path but CLAUDE.md still described it as live — render-support section, 5 render command rows, RenderRegistry, the entire "Render pipeline (rendering.rs)" section, and "schema version: 2" (now v3) with `renderConfig`. Misleads future agents reading the canonical contract.
- **Fix**: Pruned the render-support/render-pipeline/cancellation/face-detection sections, removed the 5 render command rows, bumped schema 2→3, dropped `renderConfig` from the `.reelproj` description, relabelled `src/render/` → `src/selection/`, removed the `RenderConfig` typedef reference, and reworded the Project intro + `mergeAdjacentClips` invariant (now "export span source").
- **Decision**: FIXED

### F2 — expandSpansWithFillerRemoval is now a dead export

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/selection/fillers.js:59 (pre-fix)
- **Detail**: Its only consumer was the deleted Render tab; the wholesale `git mv` of fillers.js carried it across with zero remaining consumers. `isFiller` (the live export) is still used by step2.
- **Fix**: Deleted the function and its comment. Confirmed no remaining references; regression suite stays green (142/0).
- **Decision**: FIXED

### F3 — Test 8 reimplements the load path rather than importing it

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; narrowly scoped
- **Dimension**: Success Criteria
- **Location**: test/regression.js:488-500
- **Detail**: The back-compat guard uses a local `normalizeV2Project()` that hand-mirrors step1-import.js:352-365. Faithful today, but a parallel copy can drift. step1-import.js is DOM/Tauri-coupled (not importable in the pure-JS runner), and the plan explicitly permitted this.
- **Fix**: When step1-import's load is next refactored, extract a pure importable normalizer the test can call directly.
- **Decision**: SKIPPED (accepted as known limitation)
