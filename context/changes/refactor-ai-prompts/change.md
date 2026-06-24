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
