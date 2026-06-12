# Scored AI selection → clean EDL export (S-01) Implementation Plan

## Overview

S-01 is the ★ north-star slice: prove the wedge end-to-end. An editor runs AI
selection on a transcript and gets reels that each carry a `virality_score`
(0–100) with four axis sub-scores (Hook / Flow / Value / Trend), a one-sentence
`reason`, and `hook`/`body`/`punchline` markers — can hand-edit the reels JSON
behind a validate-before-use gate, and exports a CMX3600 `.edl` whose markers
import into the NLE as real timeline locators. No MP4 is rendered.

The slice opens with prep refactor **R1** (split the 1279-line
`src/ui/step2-analyze.js` into per-surface modules) so Wave 2 slices
(S-02/S-03/S-04/S-14/S-15) stop colliding on this file, then layers the scoring
schema, validation, minimal score UI, and EDL markers on top.

## Current State Analysis

- **LLM schema is minimal.** `src/ai/prompt.js:50-59` asks only for
  `{ reel_name, clip_ids }`. No score, no markers, no scoring guidance.
- **`step2-analyze.js` is a 1279-line monolith** with tightly-coupled module
  state: `undoStack`/`redoStack` (`:22-23`), drag/trim/focus state
  (`:71-91`), preview/timeline state (`:63-67`). `init()` (`:330-752`) wires
  every event listener for all surfaces. The only **external** surface (via
  `import * as step2` in `src/main.js:3`) is `init()`, `undo()`, `redo()`
  (`main.js:29,94,98`). `renderReels` and all mutations are internal-only.
- **Validation is thin.** `runAIAnalysis` (`:998`) and `applyManualJSON`
  (`:1029`) do a bare `JSON.parse`; `applyPastedJSON` (`:1054-1056`) checks
  only array / non-empty / `clip_ids` presence. The compare path
  (`:1151`) parses with no checks. Nothing verifies `clip_ids` actually exist
  in `state.sentences` before they reach `mergeAdjacentClips` / the exporters.
- **Providers run temperature 0.3** across Gemini/Claude/OpenRouter
  (`providers.js:10,33-no-temp,59`) and Claude sends **no `cache_control`**
  (`:30-36`). `CLAUDE_MODEL = 'claude-opus-4-7'` (`models.js:2`).
- **EDL export** (`exporters/edl.js`) is span-based and pure; the regression
  suite asserts it is **byte-identical to legacy** for marker-free reels
  (`test/regression.js:303`). Any new EDL output must be **conditional on
  marker presence** to keep that fence green.
- **`.reelproj`** stores the `state` snapshot as generic JSON (`project.rs`);
  `reelsData` is untyped, so additive optional fields need **no schema bump**
  and load tolerantly (FR-033).
- R2 (`getApiKey/setApiKey`) already landed — `step2-analyze.js:4` reads keys
  via `src/ai/api-key.js`. Do not reintroduce `localStorage.edl_apikey_*`.

## Desired End State

Running AI selection on a transcript yields reels each showing a
`virality_score` badge + one-line `reason` in the reel card. Invalid LLM output
never reaches the exporter — the editor sees a clear Polish error with the raw
text preserved for paste-and-fix. Exporting EDL produces `* LOC` locator lines
for each reel's hook/body/punchline that import into Resolve/Premiere as
timeline markers, and the punchline is always inside the selection. Older
projects without scores load fine and show `brak oceny`. The regression suite
is green (legacy EDL still byte-identical; new marker cases added).

### Key Discoveries:

- External surface to preserve across R1: only `init`, `undo`, `redo`
  (`src/main.js:29,94,98`). `step2-analyze.js` stays the orchestrator and
  re-exports these.
- Dependency graph after split is acyclic: `analyze → {reel-list,
  prompt-panel, segment-ops}`; `segment-ops → reel-list` (for `renderReels`);
  `prompt-panel → reel-list` (for `renderReels`, `esc`) + validator. No module
  imports `analyze`.
- EDL byte-identical fence (`test/regression.js:303`) requires marker emission
  to be **strictly conditional** on `reel.markers` existing.
- Marker→record-frame mapping must account for `mergeAdjacentClips`: a marker
  clip_id lives inside a merged span; its record TC = span's record-in +
  (sentence.start_frame − span.start_frame).
- Anthropic prompt-caching caches a **prefix**, so the static segments block
  must come first in the Claude content array to get cache hits across
  user-prompt edits.

## What We're NOT Doing

- **No XML/Lua marker emission** — `xml.js`/`lua.js` are S-08's owned files;
  markers there land in S-08. EDL only here.
- **No scoring-first list UI** (sort-by-score, grey weak reels, axis-breakdown
  panel) — that is S-02 (FR-020). S-01 ships only a minimal read-only badge +
  reason.
- **No prompt presets / editable system prompt** (S-03, FR-015/016), no segment
  reorder/filler tuning beyond what exists (S-04), no preview-playback rework
  (S-15), no keychain (S-11). R1 only *carves* their files; it does not build
  their features.
- **No `.reelproj` schema-version bump** — score/markers are additive optional
  fields.
- **No behavior change in Phase 1** — R1 is a pure structural move.

## Implementation Approach

Four phases, each its own commit, regression-gated. Phase 1 (R1) is a
behavior-free refactor landed and verified in isolation so its only real
fence — manual step-2 smoke — is not entangled with feature work. Phases 2–4
then build scoring on the split: schema/providers first (the contract), then
validation + UI (consume it safely), then EDL markers (export it). The
CLAUDE.md "change the schema → update every consumer + grep the field name"
rule governs Phase 2→3.

## Critical Implementation Details

- **Shared module state ownership (Phase 1).** Each carved module owns its own
  mutable state and exposes an `initX(listEl)` that attaches its listeners;
  `analyze.init()` calls them in order. `undoStack`/`redoStack` + `snap`/
  `pushUndo`/`undo`/`redo` + drag/trim/focus → `step2-segment-ops.js`.
  `playheadState`/`activeReelIdx`/`previewVideoEl` + timeline/preview →
  `step2-reel-list.js`. `compareResultA/B` → `step2-prompt-panel.js`. The
  **multi-surface keydown handler** (`:643-724`) spans preview (space/jkl),
  focus+mutation (i/o/x/arrows) — keep it in `segment-ops` and expose a
  `getPreviewVideo()` accessor from `reel-list` for the play/pause keys rather
  than sharing the `previewVideoEl` variable across modules.
- **Marker→record-frame (Phase 4).** Build the clip_id→record-frame map while
  walking spans with the running `cursor`, not from raw sentence frames — the
  record timeline has the 1-hour CMX-3600 offset and per-reel gaps baked in.
- **Claude cache prefix ordering (Phase 2).** The cached content block (static
  instructions + segments JSON) must precede the variable user-prompt block in
  the Claude `messages` content array, or the cache breakpoint covers the
  variable text and never hits.

---

## Phase 1: R1 — structural split of step2-analyze.js (no behavior change)

### Overview

Carve the monolith into three per-surface modules plus a thin orchestrator,
preserving the exact `init`/`undo`/`redo` external surface and all current
behavior. This is the streams.md "opening move" that makes Wave 2 wide.

### Changes Required:

#### 1. Reel-list rendering module

**File**: `src/ui/step2-reel-list.js` (new)

**Intent**: House all reel-card rendering and the timeline/preview surface so
S-02 owns one file. Pure move of existing functions.

**Contract**: Exports `renderReels`, `renderClipText`, `esc`,
`scheduleWaveformLoad`, `drawAllTimelines`, `updateGapColors`, and an
`initReelList(listEl)` that attaches the timeline scrub / play-pause listeners
and calls `initPreviewVideo`. Owns `playheadState`, `activeReelIdx`,
`previewVideoEl`, `cachedAssetUrl`, `isDraggingTimeline` and the preview
functions (`showPreviewPanel`…`initPreviewVideo`, `seekToFrame`,
`frameToDisplayTime`). Exposes `getPreviewVideo()` for the keyboard handler.
Imports only from `state.js`, `parser/srt.js`, `selection/*`.

#### 2. Prompt-panel / AI-run module

**File**: `src/ui/step2-prompt-panel.js` (new)

**Intent**: House AI invocation, the JSON editor/paste paths, the A/B compare
feature, prompt download, and the progress log so S-03 owns one file.

**Contract**: Exports `runAIAnalysis`, `editReelsJSON`, `applyManualJSON`,
`applyPastedJSON`, `clearPastedJSON`, the compare functions
(`openCompareModal`…`applyCompareResult`), `downloadPromptTXT`, `setPS`,
`logClear`, `log`, and `initPromptPanel()` wiring the analyze/compare/json
buttons. Imports `renderReels`, `esc` from `step2-reel-list.js`;
`buildPrompt`, providers, `withLlmCache`/`clearLlmCache`, `getApiKey`,
`snap`/`pushUndo` from `step2-segment-ops.js`.

#### 3. Segment-ops / undo module

**File**: `src/ui/step2-segment-ops.js` (new)

**Intent**: House clip mutations, undo/redo, focus, drag-reorder, trim, and the
NLE keyboard shortcuts so S-04 owns one file.

**Contract**: Exports `snap`, `pushUndo`, `undo`, `redo`, `moveClip`,
`removeClip`, `mergeWithNext`, `applyTrim`, `setFocusedClip`, and
`initSegmentOps(listEl)` attaching drag/trim/focus/keydown listeners. Owns
`undoStack`/`redoStack`, `dragSrc`, `focusedClip`, `trimState`,
`trimWarnShown`. Imports `renderReels`, `getPreviewVideo`,
`drawWaveform`/`cachedPeaks`/`invalidateWaveform`, `framesToTC`,
`frameFromX`/`reelSourceSpan`.

#### 4. Thin orchestrator

**File**: `src/ui/step2-analyze.js` (rewritten thin)

**Intent**: Become the orchestrator that wires the three modules and preserves
the public surface `main.js` depends on.

**Contract**: `init()` calls `initReelList(list)`, `initPromptPanel()`,
`initSegmentOps(list)` and the prompt textarea / goStep3 wiring. Re-exports
`undo`, `redo` (from `step2-segment-ops.js`) so `import * as step2` in
`main.js` still resolves `step2.init/undo/redo`. No other module imports it.

### Success Criteria:

#### Automated Verification:

- Regression suite passes unchanged: `node --experimental-vm-modules test/regression.js`
- Rust unaffected / still type-checks: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- No leftover references: `grep -rn "step2-analyze" src/` resolves only to `main.js` and the orchestrator
- Prettier clean: `npx prettier --check "src/ui/step2-*.js"`

#### Manual Verification:

- Step 2 loads; running AI selection renders reels identically to before
- Drag-reorder, delete, merge-with-next, trim handles, per-reel threshold slider all work
- Undo/redo (Cmd-Z / Cmd-Shift-Z) work from step 2 and globally
- NLE keys (space, i/o/x, arrows, j/k/l) and timeline scrub/preview play unchanged
- A/B compare modal + JSON editor/paste paths behave as before

**Implementation Note**: This phase has essentially no automated UI coverage —
the regression suite only guards parser/exporters. Pause for human confirmation
that the manual smoke passed before proceeding. Commit R1 on its own.

---

## Phase 2: LLM schema + prompt + providers

### Overview

Define the scored schema, teach the prompt to produce it, bump the Claude
model, lower temperature for repeatability, and add Claude prompt-caching.

### Changes Required:

#### 1. Reel typedef

**File**: `src/state.js`

**Intent**: Define the canonical scored `Reel` shape once for JSDoc reference,
namespacing axis scores vs markers to avoid the `hook` collision.

**Contract**: Add `@typedef Reel` with `reel_name: string`, `clip_ids:
number[]`, optional `virality_score: number` (0–100), optional `scores:
{hook:number, flow:number, value:number, trend:number}`, optional `reason:
string`, optional `markers: {hook?:number, body?:number, punchline?:number}`
where each marker value is a member of `clip_ids`. Note all scored fields are
optional (backward-compat).

#### 2. Prompt schema + scoring guidance

**File**: `src/ai/prompt.js`

**Intent**: Rewrite the response-format block to demand the scored shape, add
Hook/Flow/Value/Trend scoring guidance and the punchline-inclusion rule, and
factor the static segments+format assembly so a Claude-content builder can
reuse it.

**Contract**: The `OCZEKIWANY FORMAT` example now includes `virality_score`,
`scores.{hook,flow,value,trend}`, `reason`, and `markers.{hook,body,punchline}`
(each a clip_id from that reel's `clip_ids`). Add Polish instructions: score
each reel 0–100 on the four axes and give an overall `virality_score`; the
selection must include the punchline segment (never cut before the payoff);
`reason` is one sentence. Extract the segments-block + format-spec construction
into a shared internal helper. Export an additional `buildClaudeContent(...)`
returning a `messages[0].content` array with the static block first
(`cache_control: {type:'ephemeral'}`) and the user prompt second. `buildPrompt`
(string) stays for Gemini/OpenRouter, compare, download, and the disk-cache key.

#### 3. Model bump + temperature + Claude caching

**File**: `src/ai/models.js`, `src/ai/providers.js`

**Intent**: Ship the wedge on the current Opus, make runs repeatable, and cache
the static Claude prefix.

**Contract**: `models.js` → `CLAUDE_MODEL = 'claude-opus-4-8'`. In
`providers.js` set `temperature: 0.1` for Gemini (`generationConfig`),
OpenRouter, and add `temperature: 0.1` to the Claude body. `callClaude` accepts
structured content (the `buildClaudeContent` array) as its message content
instead of a bare string; keep the system param. Non-obvious API shape:

```js
// callClaude message content with a cached static prefix
messages: [{ role: 'user', content: [
  { type: 'text', text: staticBlock, cache_control: { type: 'ephemeral' } },
  { type: 'text', text: userPromptBlock },
] }]
```

#### 4. Wire Claude content at call sites

**File**: `src/ui/step2-prompt-panel.js`

**Intent**: Feed the structured content to Claude in both the main run and the
compare path, keeping the disk-cache key derived from the string prompt.

**Contract**: In `runAIAnalysis` and `runComparison`, the `claude` branch calls
`callClaude(key, buildClaudeContent(...))`; Gemini/OpenRouter keep
`buildPrompt(...)`. The `cacheKey` continues to hash the `buildPrompt` string so
disk-cache hit behavior is unchanged.

### Success Criteria:

#### Automated Verification:

- Regression suite passes (no exporter change yet): `node --experimental-vm-modules test/regression.js`
- `grep -rn "claude-opus-4-7" src/` returns nothing
- `grep -rn "virality_score\|markers\|scores" src/ai/prompt.js` shows the new schema present
- Prettier clean: `npx prettier --check "src/ai/*.js" "src/ui/step2-prompt-panel.js"`

#### Manual Verification:

- A real Claude run returns reels with `virality_score`, `scores`, `reason`, `markers`
- A real Gemini and OpenRouter run also return the scored shape
- Re-running the same transcript yields near-identical selections (low-temp repeatability)
- A second Claude run on the same segments shows a prompt-cache read (token usage / latency drop)

**Implementation Note**: Pause for human confirmation of live provider runs
before Phase 3.

---

## Phase 3: Validation (FR-018) + minimal score UI

### Overview

Gate every ingest path through one validator and surface the score read-only so
the wedge is visibly proven, without building S-02's triage UI.

### Changes Required:

#### 1. Shared validator

**File**: `src/ai/validate.js` (new)

**Intent**: One validate-before-use function for all four reel-ingest paths.

**Contract**: `validateReels(parsed, sentences)` enforces: top-level is a
non-empty array; each reel has a non-empty string `reel_name` and a `clip_ids`
array of integers that **all exist** in `sentences`. Scored fields are
validated **only if present**: `virality_score` a number 0–100; `scores` an
object of numeric axes; `reason` a string; each present `markers.{hook,body,
punchline}` an integer that is a member of that reel's `clip_ids`. On any hard
failure it throws an `Error` with a descriptive Polish message naming the
offending reel/field. Missing scored fields are **not** failures. Pure, no DOM.

#### 2. Route all ingest paths through the validator

**File**: `src/ui/step2-prompt-panel.js`

**Intent**: Replace the bare `JSON.parse` / ad-hoc checks with the shared
validator and deliver the FR-018 retry / paste-and-fix experience.

**Contract**: `runAIAnalysis`, `applyManualJSON`, `applyPastedJSON`, and
`runComparison` parse then call `validateReels(parsed, state.sentences)` before
assigning `state.reelsData`. On throw: show a clear Polish error in the existing
log / paste-status, **preserve the raw response text** in the paste-and-fix
input (`pasteJsonInput`), reveal that panel, and do not mutate `reelsData`. The
existing retry path (re-run button) remains.

#### 3. Minimal read-only score display

**File**: `src/ui/step2-reel-list.js`

**Intent**: Show the score + reason in each reel card header so the editor can
validate scoring; `brak oceny` when absent.

**Contract**: In `renderReels`, the reel header gains a `virality_score` badge
and the one-line `reason` beneath the name; reels with no `virality_score`
render a neutral `brak oceny` badge and no reason line. No sorting, no greying,
no axis breakdown (those are S-02). All strings Polish; values run through
`esc`.

#### 4. Score badge styling

**File**: `src/styles.css`

**Intent**: Minimal badge/reason styling consistent with existing reel-card CSS.

**Contract**: Add `.reel-score-badge` (+ a muted `brak oceny` variant) and
`.reel-reason` rules. Reuse existing CSS variables.

### Success Criteria:

#### Automated Verification:

- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- `grep -rn "validateReels" src/ui/step2-prompt-panel.js` shows all four paths wired
- Prettier clean: `npx prettier --check "src/ai/validate.js" "src/ui/step2-*.js" "src/styles.css"`

#### Manual Verification:

- A valid scored response renders badges + reasons in the reel cards
- Pasting malformed JSON shows a clear Polish error and keeps the raw text editable; `reelsData` is unchanged
- A response with a `clip_ids` id not in the transcript is rejected with a naming error
- A response missing `virality_score` still loads and shows `brak oceny`
- Loading an older `.reelproj` (no scores) loads and shows `brak oceny`

**Implementation Note**: Pause for human confirmation before Phase 4.

---

## Phase 4: EDL markers

### Overview

Emit hook/body/punchline as CMX3600 `* LOC` locator lines on the EDL, mapped to
their record-timeline position, strictly conditional on marker presence so
legacy reels stay byte-identical.

### Changes Required:

#### 1. Conditional marker emission

**File**: `src/exporters/edl.js`

**Intent**: Add importable timeline markers without changing output for
marker-free reels.

**Contract**: While walking each reel's spans with the running `cursor`, build a
`clip_id → record_frame` map (`record_frame = recIn + (sentence.start_frame −
span.start_frame)`). When `reel.markers` exists, for each present
`markers.{hook,body,punchline}` whose clip_id is in the map, emit a
`* LOC: <framesToTC(record_frame, fps)> <COLOR> <NAME>` line (e.g. HOOK→GREEN,
BODY→BLUE, PUNCHLINE→RED) after that reel's event block. When `reel.markers` is
absent, output is unchanged (byte-identical). Remains a pure function; no new
opts in the `generateEDL` signature.

#### 2. Regression cases

**File**: `test/regression.js`

**Intent**: Guard both the byte-identical legacy path and the new marker path.

**Contract**: Keep the existing marker-free byte-identical assertion. Add a case
with a reel carrying `markers` and assert the expected count of `* LOC:` lines,
that each references a record TC inside the reel's record span, and that a
marker-free reel in the same run emits zero `* LOC:` lines.

### Success Criteria:

#### Automated Verification:

- Regression suite passes incl. new marker cases: `node --experimental-vm-modules test/regression.js`
- Legacy byte-identical EDL assertion still green
- Prettier clean: `npx prettier --check "src/exporters/edl.js" "test/regression.js"`

#### Manual Verification:

- Exported `.edl` from a scored run contains `* LOC` lines for hook/body/punchline
- The `.edl` imports into Resolve (and/or Premiere) with the three markers visible at the right timeline positions
- The punchline marker falls within the reel and is never cut off
- A project with marker-free reels exports an `.edl` identical to before

**Implementation Note**: After automated verification, confirm a real NLE import
shows the markers before closing the slice.

---

## Testing Strategy

### Unit / regression Tests:

- Extend `test/regression.js` (the only automated guard) with the marker cases
  above. Do not introduce a new framework.
- `validateReels` is pure and testable, but the suite has no validator harness;
  cover it via the manual malformed-JSON checks in Phase 3.

### Integration Tests:

- End-to-end: transcript → AI run (each provider) → scored reels render →
  export EDL → import into NLE with markers.

### Manual Testing Steps:

1. Run a transcript through Phase-1 build and confirm step 2 behaves identically (R1 fence).
2. Run each provider; confirm scored shape + repeatability + Claude cache hit.
3. Paste malformed and out-of-range JSON; confirm FR-018 error + raw-text preservation.
4. Export EDL; import into Resolve/Premiere; confirm three markers and punchline inclusion.
5. Open an older `.reelproj`; confirm `brak oceny` and identical EDL.

## Performance Considerations

- Claude prompt-caching cuts repeated-run token cost; complements the existing
  SHA-256 disk cache (exact-repeat) by covering near-repeat (same segments,
  edited user prompt).
- `temperature: 0.1` improves run-to-run stability, making the A/B compare and
  the disk cache more effective.

## Migration Notes

- No `.reelproj` schema bump. Score/markers are additive optional fields;
  older projects load tolerantly (FR-033) and show `brak oceny`.
- Legacy EDL output is unchanged for marker-free reels (regression fence).

## References

- Change brief: `context/changes/scored-selection-edl/change.md`
- Plan brief: `context/changes/scored-selection-edl/plan-brief.md`
- Streams (R1/R2, waves): `context/foundation/streams.md`
- Roadmap S-01: `context/foundation/roadmap.md:139`
- PRD FRs: FR-010/011/012/014/017/018/026/033 (`context/foundation/prd.md:111`)
- F-02 Resolve decision (S-09, later): `context/archive/2026-06-10-f-02/decision.md`
- Schema-change rule: `CLAUDE.md` → "update EVERY consumer + grep the field name"

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: R1 — structural split of step2-analyze.js

#### Automated

- [x] 1.1 Regression suite passes unchanged — 79f03dd
- [x] 1.2 Rust still type-checks (`cargo check`) — 79f03dd
- [x] 1.3 No leftover `step2-analyze` references beyond main.js + orchestrator — 79f03dd
- [x] 1.4 Prettier clean on `src/ui/step2-*.js` — 79f03dd

#### Manual

- [x] 1.5 Step 2 loads; AI run renders reels identically — 79f03dd
- [x] 1.6 Drag/delete/merge/trim/threshold all work — 79f03dd
- [x] 1.7 Undo/redo work from step 2 and globally — 79f03dd
- [x] 1.8 NLE keys + timeline scrub/preview unchanged — 79f03dd
- [x] 1.9 Compare modal + JSON editor/paste paths unchanged — 79f03dd

### Phase 2: LLM schema + prompt + providers

#### Automated

- [x] 2.1 Regression suite passes — 38b5f76
- [x] 2.2 No `claude-opus-4-7` references remain — 38b5f76
- [x] 2.3 New schema fields present in `prompt.js` — 38b5f76
- [x] 2.4 Prettier clean on `src/ai/*.js` + prompt-panel — 38b5f76

#### Manual

- [x] 2.5 Claude run returns full scored shape — 38b5f76
- [x] 2.6 Gemini + OpenRouter runs return scored shape — 38b5f76
- [x] 2.7 Re-run yields near-identical selections (repeatability) — 38b5f76
- [x] 2.8 Second Claude run shows prompt-cache read — 38b5f76

### Phase 3: Validation + minimal score UI

#### Automated

- [x] 3.1 Regression suite passes — 1262433
- [x] 3.2 All four ingest paths call `validateReels` — 1262433
- [x] 3.3 Prettier clean on validate.js + step2 + styles — 1262433

#### Manual

- [x] 3.4 Valid scored response renders badges + reasons — 1262433
- [x] 3.5 Malformed JSON → clear error, raw text preserved, reelsData unchanged — 1262433
- [x] 3.6 Out-of-range clip_id rejected with naming error — 1262433
- [x] 3.7 Missing virality_score still loads as `brak oceny` — 1262433
- [x] 3.8 Older `.reelproj` loads as `brak oceny` — 1262433

### Phase 4: EDL markers

#### Automated

- [x] 4.1 Regression suite passes incl. new marker cases — a531863
- [x] 4.2 Legacy byte-identical EDL assertion still green — a531863
- [x] 4.3 Prettier clean on edl.js + regression.js — a531863

#### Manual

- [x] 4.4 Scored `.edl` contains `* LOC` hook/body/punchline lines — a531863
- [x] 4.5 `.edl` imports into NLE with markers at correct positions — a531863
- [x] 4.6 Punchline marker is inside the reel, never cut — a531863
- [x] 4.7 Marker-free project exports identical `.edl` — a531863
