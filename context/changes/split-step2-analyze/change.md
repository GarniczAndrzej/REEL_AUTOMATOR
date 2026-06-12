---
change_id: split-step2-analyze
title: Split step2-analyze.js into per-surface modules
status: new
created: 2026-06-11
updated: 2026-06-11
archived_at: null
---

## Notes

Roadmap R1 (prep refactor, from `context/foundation/streams.md`). Carve the 1408-line `src/ui/step2-analyze.js` into `step2-reel-list.js` (→ S-02), `step2-prompt-panel.js` (→ S-03), and `step2-segment-ops.js` (→ S-04), leaving `step2-analyze.js` as a thin orchestrator. Pure structural move — no behavior change; run `node --experimental-vm-modules test/regression.js` before and after. Per streams.md this lands as the opening move of S-01; tracked separately so the roadmap records it. Prereq: F-01. Enabler, no PRD/FR ref.
