# Scoring-First Reel List (S-02) Implementation Plan

## Overview

Turn the proposed-reels list into a score-driven triage surface. The reels gain:
a **score-descending default sort** with a dropdown (score ↓ / score ↑ / AI order), a
**one-line `reason`** rendered under each reel, and **weak reels (virality_score < 50)
visually greyed** but fully usable. The sort physically reorders `state.reelsData`, so the
on-screen order is the export order (WYSIWYG into the NLE). All work sits over the existing
S-01 `Reel` schema — no parser, exporter, or frame-math changes.

## Current State Analysis

- `src/ui/step2-reel-list.js` (`renderReels`) already renders the `virality_score` badge
  (`:62-65`) and the Hook/Flow/Value/Trend axis badges via `renderAxisBadges` (`:29-44`,
  shipped by S-16 #14). It maps `state.reelsData` in raw array order; `data-reel-idx` = array
  index, consumed by `step2-segment-ops.js` for drag/merge/delete.
- The `reason` field exists end-to-end but is **never displayed**: typedef `state.js:45`,
  validated in `src/ai/validate.js:81-82`, produced by `src/ai/prompt.js` (`:19,27,40`).
- `state.reelsData` is the **export-span source** consumed by the EDL/XML/Lua exporters in
  array order. Reordering the array reorders the export — this is the desired WYSIWYG behavior.
- Reels are ingested at **three sites**, all assigning `state.reelsData` directly:
  `runAIAnalysis` (`step2-prompt-panel.js:116`), `applyPastedJSON` (`:173`), and
  `applyProjectData` (`src/ui/import/project-io.js:135`).
- `.reelproj` is **v6** (`project-io.js:76`); `writeProject` serializes `state.reelsData`
  as-is, so any additive field stamped onto a reel object (e.g. `ai_order`) round-trips for
  free. `applyProjectData` is tolerant: unknown keys ignored, nullish-guards for additive
  scalars.
- Undo/redo (`step2-segment-ops.js`): `snap()` deep-copies `reelsData` via
  `{...r, clip_ids:[...]}` — a spread that **preserves** additive reel fields
  (`virality_score`, `scores`, `reason`, and the new `ai_order`). `pushUndo(before)` is the
  pattern every mutation already follows.
- `renderReels()` is called after **every** clip mutation. Therefore sorting must NOT live
  inside `renderReels` — it is an explicit user/ingest action only, or edits would yank reels
  around mid-triage.

### Key Discoveries:

- `data-reel-idx` is the live `reelsData` index; because we physically sort (not display-sort),
  the index stays correct after sorting — **no index-remapping needed** (`step2-reel-list.js:53`,
  `step2-segment-ops.js:79-95`).
- `snap()`'s spread copy already carries arbitrary reel fields, so `ai_order` survives undo/redo
  with zero changes to `snap` (`step2-segment-ops.js:16-23`).
- Exporters read `reelsData` order but their per-reel logic is unchanged, so the regression
  suite stays green without edits (it asserts exporter output for a fixed `reelsData`).

## Desired End State

Opening reels (fresh AI run or paste) shows them ordered highest-score-first, each with its
score badge, axis badges, and a one-line Polish `reason` beneath the name; reels under 50 are
greyed but still expand/edit/export. A sort dropdown switches between score ↓, score ↑, and AI
(original) order. Saving and reopening a project preserves both the reel order and the chosen
sort mode. Verify: run an AI analysis → reels appear score-desc with reasons and greyed weak
reels; change the dropdown → order updates and is undoable; save + reopen → same order and
dropdown state; `node --experimental-vm-modules test/regression.js` stays green.

## What We're NOT Doing

- No accept/reject or include/exclude-from-export toggle (greying is **purely visual**; that
  capability is S-04/S-13 territory).
- No configurable or relative weak-threshold — the cutoff is a fixed constant (< 50).
- No exporter, parser, or frame-math changes.
- No keyboard shortcuts for sort (S-13 owns keyboard nav).
- No change to the axis-badge or score-badge rendering already shipped by S-01/S-16.

## Implementation Approach

A single `reelSort` mode (`'score_desc' | 'score_asc' | 'ai'`) lives in `state`. Reels get a
stable `ai_order` integer stamped at ingest so the `'ai'` mode can always restore the original
LLM order even after physical sorts. `sortReels(mode)` reorders `state.reelsData` in place,
pushes an undo snapshot, re-renders, and emits. Ingest sites stamp `ai_order`, set the default
mode (`score_desc` for fresh AI/paste; saved mode on load), and apply the sort. `renderReels`
gains the `reason` line and the `weak` class; sorting is never triggered from inside
`renderReels`. Persistence bumps `.reelproj` to v7 with an additive `reelSort` key.

## Critical Implementation Details

- **Sort comparator & unscored reels** — `score_desc`/`score_asc` sort reels with a numeric
  `virality_score`; reels with no score sort to the **bottom** in both directions, ordered
  among themselves by `ai_order`. `'ai'` sorts purely by `ai_order` ascending. Use a stable
  comparison (tie-break on `ai_order`) so equal scores keep a deterministic order.
- **`ai_order` stamping is idempotent** — stamp only when absent: fresh AI/paste output gets
  `ai_order = index` in LLM order; on project load, legacy reels missing the field get it
  assigned by their saved index (so `'ai'` order = saved order for old files). Never
  overwrite an existing `ai_order`.
- **Sorting is an explicit action, not a render step** — call `sortReels` from the dropdown
  handler and from the ingest sites, never from `renderReels`; otherwise a clip
  delete/merge/drag would re-sort the list mid-edit.
- **Legacy load with no saved mode** — render `reelsData` as-is (no auto re-sort) and set the
  dropdown cosmetically to `score_desc`; accept that for a pre-v7 file the dropdown label may
  not match the saved physical order until the user picks a mode. This honors the
  "render-as-is on load" decision without lying about data.

## Phase 1: Sort foundation

### Overview

Add the sort mode to state, stamp `ai_order` at ingest, implement the in-place undoable
`sortReels`, add the dropdown control, and default fresh AI/paste output to score-desc.

### Changes Required:

#### 1. Sort-mode state field

**File**: `src/state.js`

**Intent**: Hold the active sort mode so it drives rendering order and persists.

**Contract**: Add `reelSort: 'score_desc'` to the step-2 section of `state`. Extend the `Reel`
typedef with `@property {number} [ai_order]` (additive, optional, backward-compat).

#### 2. Sort logic + `ai_order` stamping

**File**: `src/ui/step2-reel-list.js`

**Intent**: Provide a reusable in-place sort and an idempotent stamp used by all ingest sites
and the dropdown, keeping undo/render/emit consistent with existing mutations.

**Contract**: Export `stampAiOrder()` (assigns `ai_order = index` to any reel lacking it) and
`sortReels(mode)` (sets `state.reelSort`, `pushUndo(snap())`, reorders `state.reelsData` in
place per the comparator above, `renderReels()`, `emit()`). Import `snap`/`pushUndo` from
`step2-segment-ops.js`. The comparator sends unscored reels to the bottom and tie-breaks on
`ai_order`.

#### 3. Sort dropdown control

**File**: `src/index.html`

**Intent**: Give the user the score ↓ / score ↑ / AI-order switch in the reels card header.

**Contract**: Add a `<select id="reelSortSelect">` beside `#reelsCount` in the `#reelsCard`
card-title (`:378-381`) with Polish options — e.g. „Ocena malejąco" (`score_desc`), „Ocena
rosnąco" (`score_asc`), „Kolejność AI" (`ai`).

#### 4. Wire the dropdown + ingest defaults

**Files**: `src/ui/step2-reel-list.js` (init), `src/ui/step2-prompt-panel.js`

**Intent**: Make the dropdown call `sortReels`, reflect `state.reelSort`, and default fresh
output to score-desc.

**Contract**: In `initReelList`, attach a `change` listener on `#reelSortSelect` → `sortReels(value)`,
and set the select's value from `state.reelSort` on render. In `runAIAnalysis` and
`applyPastedJSON`, after assigning `state.reelsData`: call `stampAiOrder()`, set
`state.reelSort = 'score_desc'`, and call `sortReels('score_desc')` instead of the bare
`renderReels()` (sort re-renders). Keep the existing `pushUndo(snap())` ordering correct — the
ingest already snapshots before assignment; ensure `sortReels` does not double-stack an
unwanted undo for the ingest itself (sort's own snapshot of the freshly-set data is acceptable;
verify undo returns to pre-analysis state in one or two steps and document which).

### Success Criteria:

#### Automated Verification:

- Lint/format clean: `npx prettier --check "src/**/*.js"`
- Regression suite green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- After an AI run, reels appear highest-score-first.
- Dropdown switches between score ↓, score ↑, and AI order; AI order restores the original LLM
  sequence.
- A sort can be undone with the existing undo control.
- Clip delete/merge/drag does NOT re-sort the list.

**Implementation Note**: After completing this phase and all automated verification passes,
pause for manual confirmation before proceeding.

---

## Phase 2: Reel-card presentation

### Overview

Render the one-line `reason` under each reel name and grey reels scoring < 50.

### Changes Required:

#### 1. Reason line + weak class

**File**: `src/ui/step2-reel-list.js`

**Intent**: Surface the AI's justification and de-emphasize weak reels, per the triage intent.

**Contract**: In the `renderReels` card template (`:113-121`), add a `.reel-reason` element
(escaped via `esc`, single line) below the header when `r.reason` is a non-empty string. Add a
`weak` modifier class to `.reel-card` when `typeof r.virality_score === 'number' &&
r.virality_score < 50`. Unscored reels get no `weak` class.

#### 2. Styling

**File**: `src/styles.css`

**Intent**: Style the reason line and the greyed weak state without breaking the existing
header/badge layout (`:774-844`).

**Contract**: Add `.reel-reason` (muted text, `--fs-xs`/`--text3`, single-line ellipsis) and
`.reel-card.weak` (reduced opacity / desaturated, still fully interactive on hover). Ensure the
reason sits between the header and `.reel-clips`, and that `weak` does not disable pointer
events.

### Success Criteria:

#### Automated Verification:

- Lint/format clean: `npx prettier --check "src/**/*.{js,css}"`
- Regression suite green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- Each reel shows its Polish `reason` on one line (ellipsis when long); reels without a reason
  show no empty row.
- Reels scoring < 50 render greyed; unscored reels render at full opacity.
- Greyed reels still expand, edit, drag, and export normally.

**Implementation Note**: After completing this phase and all automated verification passes,
pause for manual confirmation before proceeding.

---

## Phase 3: Persistence

### Overview

Persist the sort mode and ensure `ai_order` survives save/load, bumping the project schema.

### Changes Required:

#### 1. Write `reelSort` + bump version

**File**: `src/ui/import/project-io.js`

**Intent**: Save the chosen sort mode so a reopened project restores the same triage view; the
already-stamped `ai_order` on each reel persists automatically via `reelsData`.

**Contract**: In `writeProject` (`:69-93`), set `version: 7` and add `reelSort: state.reelSort`
to the payload. Update the version comment to note v7 adds `reelSort` (S-02).

#### 2. Restore `reelSort` + stamp legacy reels

**File**: `src/ui/import/project-io.js`

**Intent**: Reopen at the saved order and mode; backfill `ai_order` for pre-v7 reels so AI-order
sorting works on legacy files.

**Contract**: In `applyProjectData`: reset `state.reelSort` to its default (`'score_desc'`)
alongside the other per-project resets, then `if (data.reelSort) state.reelSort = data.reelSort`.
After `state.reelsData` is assigned (`:135`), call `stampAiOrder()` (imported from
`step2-reel-list.js`) to backfill missing `ai_order`. Do **not** auto re-sort on load — render
the saved order as-is; sync `#reelSortSelect` to `state.reelSort` (cosmetic for legacy files
without a saved mode, per Critical Implementation Details).

### Success Criteria:

#### Automated Verification:

- Lint/format clean: `npx prettier --check "src/**/*.js"`
- Regression suite green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- Save a project after sorting → reopen → reels appear in the saved order with the dropdown set
  to the saved mode.
- Open a pre-v7 `.reelproj` → loads without error; AI-order sort works (reels have backfilled
  `ai_order`).
- Switching to AI order after a load restores the original LLM sequence for v7 files.

**Implementation Note**: After completing this phase and all automated verification passes,
pause for final manual confirmation.

---

## Testing Strategy

### Unit Tests:

- None added — the regression suite covers only pure parser/exporters (CLAUDE.md), and this
  slice changes neither. Run it before and after to prove no exporter regression.

### Manual Testing Steps:

1. Run an AI analysis on a transcript with a mix of high/low scores → confirm score-desc order,
   reason lines, and greyed < 50 reels.
2. Cycle the sort dropdown through all three modes; confirm order changes and AI order matches
   the raw LLM output.
3. Undo a sort; confirm the previous order returns.
4. Delete/merge/drag a clip; confirm the list does NOT re-sort.
5. Save, reopen; confirm order + dropdown mode restored.
6. Open a legacy (pre-v7) project; confirm no error and AI-order sort works.

## Performance Considerations

Sorting is an in-place array sort over a handful of reels — negligible. No new per-render work
beyond one comparator pass on explicit sort actions.

## Migration Notes

`.reelproj` bumps v6 → v7 (additive `reelSort` only). Older files load tolerantly: missing
`reelSort` defaults to `score_desc`, missing `ai_order` is backfilled on load. New files remain
readable by the tolerant loader (it ignores unknown keys), so no destructive migration.

## References

- Roadmap slice: `context/foundation/roadmap.md` → S-02 (`:152-162`)
- Reel schema (S-01): `src/state.js:37-47`; validation `src/ai/validate.js:56-82`
- Current rendering: `src/ui/step2-reel-list.js`
- Ingest sites: `src/ui/step2-prompt-panel.js:116,173`; `src/ui/import/project-io.js:135`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Sort foundation

#### Automated

- [x] 1.1 Lint/format clean (`npx prettier --check "src/**/*.js"`) — fd8738c
- [x] 1.2 Regression suite green (`node --experimental-vm-modules test/regression.js`) — fd8738c

#### Manual

- [x] 1.3 After an AI run, reels appear highest-score-first — fd8738c
- [x] 1.4 Dropdown switches score ↓ / score ↑ / AI order; AI order restores LLM sequence — fd8738c
- [x] 1.5 A sort can be undone with the existing undo control — fd8738c
- [x] 1.6 Clip delete/merge/drag does NOT re-sort the list — fd8738c

### Phase 2: Reel-card presentation

#### Automated

- [x] 2.1 Lint/format clean (`npx prettier --check "src/**/*.{js,css}"`)
- [x] 2.2 Regression suite green (`node --experimental-vm-modules test/regression.js`)

#### Manual

- [x] 2.3 Each reel shows its Polish reason on one line (ellipsis when long); no empty row when absent
- [x] 2.4 Reels scoring < 50 render greyed; unscored reels at full opacity
- [x] 2.5 Greyed reels still expand, edit, drag, and export normally

### Phase 3: Persistence

#### Automated

- [ ] 3.1 Lint/format clean (`npx prettier --check "src/**/*.js"`)
- [ ] 3.2 Regression suite green (`node --experimental-vm-modules test/regression.js`)

#### Manual

- [ ] 3.3 Save after sorting → reopen → saved order + dropdown mode restored
- [ ] 3.4 Open a pre-v7 `.reelproj` → loads without error; AI-order sort works
- [ ] 3.5 Switching to AI order after a v7 load restores the original LLM sequence
