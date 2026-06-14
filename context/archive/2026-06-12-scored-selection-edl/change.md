---
change_id: scored-selection-edl
title: Scored AI selection → clean EDL export
status: archived
created: 2026-06-12
updated: 2026-06-14
archived_at: 2026-06-14T16:11:08Z
---

## Notes

Roadmap slice **S-01** (★ north star). Get AI reels scored on Hook/Flow/Value/Trend and export a clean EDL. Prereq: F-01 (done). PRD refs: FR-010, FR-011, FR-012, FR-014, FR-017, FR-018, FR-026, FR-033.

Per `context/foundation/streams.md`, **R1** (split `src/ui/step2-analyze.js` into `step2-reel-list.js` / `step2-prompt-panel.js` / `step2-segment-ops.js`) lands as the opening move of this slice so Wave 2 (S-02/S-03/S-04/S-14/S-15) can run in parallel worktrees. R2 (`getApiKey/setApiKey`) already landed on master — read keys via `src/ai/api-key.js`, not `localStorage`.

Worktree: `reel-wt-selection` on branch `stream/scored-selection-edl`. Run `node --experimental-vm-modules test/regression.js` before and after, especially around the R1 split (pure structural move — behavior must not change).
