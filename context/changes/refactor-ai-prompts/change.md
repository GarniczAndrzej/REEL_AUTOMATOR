---
change_id: refactor-ai-prompts
title: Refactor ai prompts
status: implementing
created: 2026-06-24
updated: 2026-06-24
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

Roadmap slice **S-26** (`refactor-ai-prompts`). Engineered prompt text already authored in `context/foundation/prompt-design.md` (3 per-phase guidance rewrites + 9 BRAVE-cohort presets, with research rationale + citations). This change wires that design in: replace the `DEFAULT_*_GUIDANCE` blocks in `src/ai/prompt.js` and `BUILTIN_PRESETS` in `src/ai/prompt-presets.js`. No schema change. Open decisions: preset re-seed-merge for existing users, cohort-list scope, single-shot guidance EN-flip — see the slice Unknowns.

**Phase 2 deviation (user-directed, 2026-06-24):** the cohort preset `userPrompt`
bodies ship in **English**, not the Polish the design doc/plan specified. The
design doc deliberately kept presets Polish (frequently-edited creative surface);
during implementation the user directed an English flip to match the per-phase
guidance and the [[llm-prompt-instructions-english]] lesson (English instructions
tokenize ~30% leaner; the preset rides on every call). Each preset uses a tight
labeled structure (AUDIENCE → LOOK FOR → HOOK → LENGTH → CTA) — validated against
fresh exa research on 2026 prompt best practice (prompt-as-contract: lead with
objective, set audience explicitly, profile-based selection criteria) — and ends
with an explicit "write reel_name and reason in Polish" anchor so model OUTPUT
stays Polish even if the per-phase guidance is cleared. Picker **names** stay
Polish (UI labels). Result: 11 presets (9 BRAVE cohorts + The5 + Copilot).
