<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Refactor AI Prompts (S-26)

- **Plan**: context/changes/refactor-ai-prompts/plan.md
- **Scope**: Full plan — Phases 1–3 of 3
- **Date**: 2026-06-24
- **Verdict**: APPROVED
- **Findings**: 0 critical, 0 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

## Automated criteria

- `node --experimental-vm-modules test/regression.js` → 258 passed, 0 failed.
- `npx prettier --check src/ai/prompt.js src/ai/prompt-presets.js src/main.js` → all clean.
- Guidance constants verified byte-for-byte against `context/foundation/prompt-design.md` Phases 1–3.
- `RESPONSE_FORMAT` / `CLUSTER_RESPONSE_FORMAT` / `validateReels` / `validateThemes` untouched (no schema/exporter/`.reelproj` impact, as planned).
- `BUILTIN_PRESETS` = 11 entries, ids unique and `builtin-`-prefixed; The5 + Copilot ids/names match the Phase 2 contract.
- Migration flag-guarded + try/catch (mirrors `seedPresetsIfEmpty`); boot order `seed → migrate → load` per Phase 3 contract.

## Findings

### F1 — Preset bodies shipped in English vs. plan's "verbatim Polish"

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/ai/prompt-presets.js:26-148
- **Detail**: Phase 2 contract specified verbatim Polish userPrompt bodies; shipped bodies are English (AUDIENCE → LOOK FOR → HOOK → LENGTH → CTA) with a Polish-output anchor. Deliberate, user-directed deviation documented in change.md Notes, plan Progress note (plan.md:458-462), and design doc banner (prompt-design.md:48-54). ids/names/output language all conform.
- **Decision**: ACKNOWLEDGED — no action (deviation already documented in source of truth).

### F2 — test/regression.js edited though plan called the suite "unaffected"

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: test/regression.js:1457,1466
- **Detail**: Plan claimed the regression suite does not exercise prompts, but two assertions hard-coded the old Polish scoring marker `ZASADY OCENY`. Phase 1's EN-flip staled them; they were correctly updated to the English marker `find every Reel worth cutting`. Necessary, correct edit; suite green (258/258).
- **Decision**: ACCEPTED-AS-RULE: "Changing DEFAULT_*_GUIDANCE text breaks regression marker assertions" (code fix already present in commit a022cd9; rule appended to lessons.md).

### F3 — Migration repopulates a deliberately-emptied library

- **Severity**: 🔵 OBSERVATION
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: src/ai/prompt-presets.js:260-287
- **Detail**: `seedPresetsIfEmpty()` leaves an existing-but-empty library `[]` untouched, but `migrateBuiltinPresets()` will populate it with all 11 builtins on its one run, then set the flag. A user who deliberately deleted ALL presets pre-update gets 11 injected once. Does not violate the documented post-flag idempotency guarantee; narrow edge case.
- **Fix (optional)**: Early-return from `migrateBuiltinPresets` when library is `[]` and no retired starters present (still stamp the flag).
- **Decision**: SKIPPED — leave as-is (accepted behavior; emptied library gets the new cohort starters once).
