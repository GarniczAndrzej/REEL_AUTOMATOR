# Scoring-First Reel List (S-02) — Plan Brief

> Full plan: `context/changes/scoring-first-reel-list/plan.md`

## What & Why

Make the proposed-reels list a score-driven triage surface: sort reels by their
`virality_score`, show each reel's one-line `reason`, and grey the weak ones. The score is only
useful if it's the lens for the list — this is the editor's primary triage step right after the
north-star scored selection (S-01).

## Starting Point

S-01 + S-16 already render the `virality_score` badge and the Hook/Flow/Value/Trend axis badges
in `src/ui/step2-reel-list.js`. The `reason` field exists end-to-end (schema, validation, prompt)
but is never displayed, the list renders in raw LLM order with no sort control, and there is no
weak-reel de-emphasis.

## Desired End State

Reels open highest-score-first with their reason beneath the name and sub-50 reels greyed (but
fully usable). A dropdown switches score ↓ / score ↑ / AI (original) order, the chosen order is
the export order, and both the order and the sort mode survive save/reopen.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Default order + control | Auto score-desc + dropdown (score ↓ / ↑ / AI) | Delivers scoring-first immediately with an escape to original order | Plan |
| Sort scope | Physically reorder `reelsData` (export follows sort) | WYSIWYG — the score-sorted order carries into the NLE | Plan |
| "Weak" definition | Fixed threshold: `virality_score < 50` | Predictable, zero config | Plan |
| "Selectable" meaning | Purely visual greying; everything still works/exports | Matches roadmap wording; no export-filtering state | Plan |
| Unscored reels | Sort to bottom, NOT greyed | Don't mislabel a reel we simply couldn't score | Plan |
| Load behavior | Persist sort mode; render saved order as-is (no auto re-sort) | Respects the user's last saved arrangement | Plan |

## Scope

**In scope:** sort dropdown + in-place undoable sort, `ai_order` stamping, `reason` line, weak
(<50) greying, `.reelproj` v7 persistence of the sort mode.

**Out of scope:** accept/reject or include/exclude-from-export toggle, configurable/relative
threshold, keyboard shortcuts (S-13), any exporter/parser/frame-math change.

## Architecture / Approach

A single `state.reelSort` mode drives a `sortReels(mode)` that reorders `state.reelsData` in
place (with an undo snapshot), re-renders, and emits. A stable `ai_order` stamped on each reel at
ingest lets the "AI order" mode restore the original LLM sequence even after physical sorts.
Sorting fires only on explicit dropdown change or at ingest — never inside `renderReels`, so clip
edits don't re-sort. Because the sort is physical, `data-reel-idx` stays correct, so drag/merge/
delete need no index remapping.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Sort foundation | `reelSort` state, `ai_order` stamping, `sortReels`, dropdown, ingest defaults | Undo stacking interaction with ingest's existing snapshot |
| 2. Reel-card presentation | `reason` line + weak (<50) greying + CSS | Greying must not disable interaction |
| 3. Persistence | `.reelproj` v7 `reelSort`, legacy `ai_order` backfill | Legacy files: dropdown label vs saved order mismatch |

**Prerequisites:** S-01 (done). No new deps.
**Estimated effort:** ~1 session across 3 small phases.

## Open Risks & Assumptions

- Undo after a fresh AI run may take one or two steps to reach the pre-analysis state; the plan
  flags verifying and documenting which (low stakes, undo already exists).
- Greying is purely cosmetic — if the user later wants to actually drop weak reels from export,
  that's a separate slice (S-04/S-13).

## Success Criteria (Summary)

- Reels open score-desc with reasons shown and sub-50 reels greyed but usable.
- Sort dropdown works across all three modes and is undoable; clip edits never re-sort.
- Order + sort mode survive save/reopen; pre-v7 projects load and AI-order sort works.
