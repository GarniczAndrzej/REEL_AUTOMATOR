<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: UI/UX Redesign — Simpler, Decluttered Flow (S-16)

- **Plan**: context/changes/s-16/plan.md
- **Scope**: Full plan (Phases 1–4 of 4)
- **Date**: 2026-06-16
- **Verdict**: NEEDS ATTENTION (all findings triaged & fixed)
- **Findings**: 0 critical, 2 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Automated criteria all green: `cargo check` ✓ · regression 179/0 ✓ · prettier ✓ ·
dead-identifier greps empty ✓.

## Findings

### F1 — Per-reel mergeThreshold fallback not removed "end-to-end"

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; no-touch-exporters guardrail vs plan claim
- **Dimension**: Plan Adherence
- **Location**: src/exporters/edl.js:32, xml.js:42, lua.js:60, lua.js:108
- **Detail**: Plan 3b §2 said the per-reel override is "removed end-to-end." UI/state/v5-writer were cleaned (step2-reel-list.js:50 reads state.mergeThreshold only), but the 4 exporters still read `reel.mergeThreshold ?? mergeThreshold`. Inert today (no layer writes the field), and exporters are the plan's no-touch zone — an internal tension.
- **Fix A ⭐**: Amend plan wording; leave exporters untouched (honors no-touch guardrail, zero regression risk).
- **Fix B**: Strip the 4 dead reads + add regression case.
- **Decision**: FIXED via Fix A — plan.md Phase 3b §2 and Migration Notes reworded to "removed at UI/state/writer layers; exporter reads are inert dead code, left to respect the no-touch-exporters guardrail."

### F2 — Merge-gap input persists unguarded numeric value

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/ui/settings-modal.js:33
- **Detail**: `input` handler did `state.mergeThreshold = +e.target.value; saveSettings(...)` with no finite/empty guard; the value is the export span source. `type=number` prevents true NaN, but clearing mid-edit gives `+'' === 0`, persisting "no merge" across restart.
- **Fix**: Guard with `Number.isFinite(n) && n >= 0` before persisting.
- **Decision**: FIXED — guard added; bad/empty values are now ignored.

### F3 — Import submodules still used alert() for informational notices

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Pattern Consistency
- **Location**: src/ui/import/transcribe.js (10 sites), project-io.js (3 sites)
- **Detail**: Phase 1 §4 introduced toast.js to replace informational alert()s; import submodules still used native alert() for non-destructive notices, contrary to the slice's stated intent.
- **Fix**: Migrate non-destructive alert()s to toast(..., 'error'|'info').
- **Decision**: FIXED — all 13 alert()s migrated to toast (errors→'error', validation→'info'); toast imported in both files; `grep alert( src/ui/import/` now empty.

### F4 — applyProjectData additive; stale cross-project carry-over

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🔎 MEDIUM
- **Dimension**: Data safety
- **Location**: src/ui/import/project-io.js:97-116
- **Detail**: Load applied `if (data.x != null) state.x = ...` only — omitted keys were never reset, so loading a partial/older file over an active session could carry over the previous project's reelsData/sentences/videoPath.
- **Fix**: Reset per-project content fields to defaults before applying.
- **Decision**: FIXED — applyProjectData now resets srtName/srtContent/videoFilename/videoPath/videoResolution/projectName/sentences/reelsData before applying; app-level config (mergeThreshold/whisperLanguage/modelId/diarize) intentionally not reset.

### F5 — Two modules bound listeners to the same fps/filename/gap inputs

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Pattern Consistency
- **Location**: settings-modal.js & import/segments.js (shared ids fpsSelect/videoFilename/gapFrames)
- **Detail**: The inputs physically live in `#settingsModal`, but segments.js (import submodule) wired their listeners — an ownership inversion violating "one component owns its DOM."
- **Fix**: Consolidate the bindings into the owning module (settings-modal.js).
- **Decision**: FIXED — fps (with re-parse note), videoFilename, gapFrames bindings moved into settings-modal.js; duplicates removed from segments.js. `.value=` sync writes left in place (state→DOM mirror, not listeners).

## Post-fix verification

- Regression: 179 passed, 0 failed
- Prettier: clean
- Dead-identifier greps: empty
- No Rust changes (cargo unaffected)
