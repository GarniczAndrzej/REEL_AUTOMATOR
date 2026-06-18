<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Editable system prompt + reusable prompt presets (S-03)

- **Plan**: context/changes/s-03/plan.md
- **Scope**: All 4 phases (full plan)
- **Date**: 2026-06-18
- **Verdict**: NEEDS ATTENTION (all findings minor / justified)
- **Findings**: 0 critical, 2 warnings, 3 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | WARNING |
| Success Criteria | PASS |

Success Criteria evidence: `node --experimental-vm-modules test/regression.js` → 187 passed / 0 failed (incl. Test 14 buildPrompt assembly); `cargo check` clean; all manual Progress boxes checked.

## Findings

### F1 — Native prompt/confirm replaced by in-app modal + unplanned save-file.js touch

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Scope Discipline
- **Location**: src/ui/step2-preset-bar.js:262-399; src/util/save-file.js; src/ui/step2-prompt-panel.js
- **Detail**: Plan specified native window.prompt/window.confirm for save-as/rename/delete. Implementation added an in-app overlay modal (promptNative/openModal) + native ask() for delete because synchronous JS dialogs hard-crash Tauri's macOS WKWebView. Companion fix (0637445) swapped alert()→toast() in step2-prompt-panel.js and src/util/save-file.js (latter not in plan, but its new `filters` param is load-bearing for Phase 4 export). Deviation is correct; behavior preserved (delete still confirms; Polish strings; no synchronous dialogs remain).
- **Fix A ⭐ Recommended**: Document the WKWebView deviation as a plan addendum.
  - Strength: Updates source of truth; matches repo's documentation discipline.
  - Tradeoff: Plan text becomes a slightly moving target.
  - Confidence: HIGH — deviation already reflected in commit messages.
  - Blind spot: None significant.
- **Fix B**: Capture as a recurring lesson (synchronous dialogs crash WKWebView).
  - Strength: Prevents the bug class in future slices.
  - Tradeoff: Doesn't reconcile this plan's specific text.
  - Confidence: HIGH — lessons.md precedent exists.
  - Blind spot: None significant.
- **Decision**: ACCEPTED-AS-RULE: Synchronous JS dialogs crash Tauri's macOS WKWebView (lessons.md). Code deviation already correct; no code change needed.

### F2 — Emptied system prompt is silently dropped on .reelproj reload

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/ui/import/project-io.js:129
- **Detail**: `if (data.systemPrompt) state.systemPrompt = data.systemPrompt;` truthy guard drops a deliberately-emptied ('') scoring guidance on reload, replacing it with DEFAULT_SCORING_GUIDANCE. Empty systemPrompt is meaningful (Test 14 asserts it omits ZASADY OCENY). settings-modal.js:44 uses `?? DEFAULT` (nullish) — two restore paths disagree. Note: plan literally said "assign-if-present, like userPrompt" and userPrompt:126 has the same truthy guard, so this follows the plan; the gap is in the plan's chosen guard.
- **Fix**: Change to `if (data.systemPrompt != null) state.systemPrompt = data.systemPrompt;` to match nullish discipline.
- **Decision**: FIXED — nullish guard applied at project-io.js:129.

### F3 — AppSettings @typedef missing systemPrompt

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/settings.js:11-14
- **Detail**: saveSettings({ systemPrompt })/loadSettings().systemPrompt now live (settings-modal.js:44,51) but AppSettings typedef only declares mergeThreshold.
- **Fix**: Add `@property {string} [systemPrompt]` to the AppSettings typedef.
- **Decision**: FIXED — @property added at settings.js:14.

### F4 — savePresets swallows write errors while caller toasts success

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality
- **Location**: src/ai/prompt-presets.js:84-88, 116-120
- **Detail**: savePresets uses `catch {}`; a failed localStorage write is invisible and the caller (step2-preset-bar.js:81) still fires a "…zapisany" success toast. Consistent with settings.js precedent, but the success toast makes the swallow more user-visible.
- **Fix**: Optionally have savePresets return a boolean and gate the toast on it.
- **Decision**: FIXED — savePresets/addPreset/updatePreset/removePreset now return write status; all four mutation toasts in step2-preset-bar.js gated on success (error toast on failure). Regression: 187/0.

### F5 — Boot-time state mutation without emit()

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Pattern Consistency
- **Location**: src/ui/settings-modal.js:44
- **Detail**: `state.systemPrompt = loadSettings().systemPrompt ?? DEFAULT_SCORING_GUIDANCE;` mutates state without a following emit(). Harmless (runs at boot before any subscriber registers) but technically violates the "emit after any mutation" rule.
- **Fix**: Add emit() or a one-line comment marking it a pre-subscriber boot seed.
- **Decision**: FIXED — added comment at settings-modal.js:44 marking it a pre-subscriber boot seed (no emit by design).
