---
change_id: api-key-accessor
title: getApiKey()/setApiKey() accessor abstraction
status: done
created: 2026-06-11
updated: 2026-06-12
archived_at: null
---

## Notes

Roadmap R2 (prep refactor, from `context/foundation/streams.md`). Replace the 4 direct `localStorage.edl_apikey_*` read sites (OpenRouter picker, step-2 selection, step-1 import, providers) with a single `getApiKey()/setApiKey()` helper, so S-11 can swap the backing store to the OS keychain without touching those call sites and stops conflicting with S-01. Find-all-call-sites refactor, no behavior change. Prerequisite-free; per streams.md slot into Wave 0, ideally before S-01, and land inside/ahead of S-11. Enabler (supports FR-035 via S-11).

## Outcome (2026-06-12)

Landed standalone on `master` ahead of the Wave 1 worktrees so all three streams inherit the helper. New module `src/ai/api-key.js` (`getApiKey`/`setApiKey`); the `edl_apikey_` literal now lives only there. Converted call sites: `src/main.js` (save/load), `src/ui/step2-analyze.js` (runAIAnalysis + A/B compare), `src/ai/openrouter-picker.js` (loadOrModels). `providers.js` already took `apiKey` as a param — no read site there. Regression 142/0 before and after; no behavior change.
