# Word-by-word SRT export — fix Implementation Plan

## Overview

S-20 (`word-srt-fix`) repairs the broken word-by-word SRT export shipped by S-19. The pure
exporter `generateWordSRT` (`src/exporters/transcript.js:68-98`) is **correct** and locked by
regression Test 15 — the breakage lives entirely in the **GUI glue** around it: the export
checkbox only persists on "Zapisz", several export-abort paths fail silently, and two latent
traps (#4 flat-words branch, the unguarded F1 reversed-cue clamp) were never verified because
S-19's manual criteria 3.3–3.10 were attested but never run.

This plan makes the toggle persist on change, ensures every export path gives the user clear
Polish feedback, hardens the inline auto-align, and closes the latent traps with a defensive
guard plus a regression lock — pushing verification into the automated suite wherever the GUI
doesn't force manual QA.

## Current State Analysis

Verified directly against HEAD (`36a13d4`):

- **Exporter is correct.** `generateWordSRT` implements onset-pin, 4-frame floor, right-side-only
  padding, and the collision clamp `if (next && end > next.start_frame) end = Math.max(start,
  next.start_frame);` (`transcript.js:89`). Test 15 (`test/regression.js:1155-1263`, FPS=25)
  asserts an exact 4-cue SRT and the skip of seconds-only words.
- **Checkbox persists only on "Zapisz".** `#advWordLevelSrt` (`src/index.html:610-616`) is read
  into state by `applyWhisperAdvancedForm` (`transcribe.js:466-483`), which runs **only** from the
  `advSaveBtn` handler (`transcribe.js:431-436`). There is **no `change` listener** on the
  checkbox. Close via X (`closeBtn`, `transcribe.js:427`) or backdrop (`transcribe.js:428-430`)
  after ticking → flag never written → `exportSRT` reads `false` (default `state.js:114`) and
  silently emits a sentence-level SRT. **This is root cause #1.**
- **Persistence plumbing exists and is correct otherwise.** `saveWhisperAdvancedToLS` /
  `loadWhisperAdvancedFromLS` (`transcribe.js:383-412`) round-trip `wordLevelSrtExport` through the
  `edl_whisper_advanced` localStorage bag; `fillWhisperAdvancedForm` (`transcribe.js:459`) restores
  the checkbox on open. Only the *write-on-toggle* link is missing.
- **Export wiring** (`export-popover.js:188-233`): mode OFF → sentence SRT; mode ON → `hasFrameWords()`
  gate, else auto-align fallback (needs a video path, else toast) then re-check, else **return
  writing nothing** (line 214). The post-align "still no frame-words" return is silent. **Root
  cause #2.**
- **Auto-align** `alignToWords` (`transcribe.js:524-578`) requires a video path **and**
  `state.srtContent`; it drives the WhisperX `align_transcript` sidecar — a 37–67s cold spawn
  (see [[whisperx-cold-spawn-cost]]) — with a progress box but **no pre-spawn confirmation**.
  Cancel/fail surfaces a toast and returns false. **Root cause #3.**
- **Flat-words / no-`segments` branch** (`segments.js:135-142`, `transcribe.js:~709`) stashes
  engine words into `state._pendingWhisperWords` but never sets `state.sentences`, so the word-SRT
  export has nothing to emit. Likely dead with the current WhisperX engine but unguarded.
  **Root cause #4.**
- **Stale `change.md` note.** It claims two "uncommitted" bug-fix hunks; both landed in commit
  `2801144`. The current working-tree edits (`src/ai/api-key.js`, `src/ui/step2-preset-bar.js`)
  are **unrelated** Prettier reformatting and are out of scope for this change.

### Key Discoveries:

- The missing link is a single `change` listener — `applyWhisperAdvancedForm` already does the
  read correctly (`transcribe.js:482`), it just only runs from "Zapisz" (`transcribe.js:431-436`).
- `hasFrameWords()` (`export-popover.js:225-233`) and the exporter filter agree (both `start_frame`
  **and** `end_frame` finite) — the F3 fix from `2801144`. No change needed there.
- Test 15's inputs are strictly increasing, so the `Math.max(start, …)` clamp (F1 fix) has **no
  regression lock** — a diarized/overlapping-onset input is the gap.
- All user-facing strings are Polish (CLAUDE.md invariant); every new toast/label must be Polish.

## Desired End State

- Ticking "Eksport napisów słowo-po-słowie (.srt)" and closing the modal **by any means**
  (Zapisz / X / backdrop) persists the flag and survives an app restart.
- With the flag ON and frame-aligned words present, the ⬇ **Transkrypcja .srt** button writes a
  per-word `.srt` via the native save prompt; with the flag OFF it writes a sentence-level `.srt`.
- Every export path that does **not** produce a file shows a specific Polish toast explaining why
  — no silent "I clicked it and nothing happened."
- The inline auto-align still works for imported-SRT + video flows, now behind a clear Polish
  confirmation/progress so the 37–67s wait is never a surprise.
- The flat-words/no-`segments` branch can no longer silently yield an empty export — it is guarded.
- The regression suite locks the F1 reversed-cue/diarized-overlap clamp, so the `Math.max` guard
  can't regress.

Verify: `node --experimental-vm-modules test/regression.js` is green (incl. the new F1 case), and
the GUI flows below pass a hands-on pass in `npm run tauri dev`.

## What We're NOT Doing

- **Not** touching the exporter timing math (`generateWordSRT`) — it is correct and locked.
- **Not** changing the apply-on-Zapisz semantics for the *other* advanced fields — only the
  word-SRT checkbox gets live persistence (per the chosen "change listener on toggle" approach).
- **Not** adding a second export button — S-19's additive "reuse the existing ⬇ Transkrypcja .srt
  button" contract is preserved.
- **Not** moving the auto-align off the export click — it stays inline (hardened), not deferred.
- **Not** committing/reverting the unrelated `api-key.js` / `step2-preset-bar.js` Prettier edits —
  left untouched in the working tree; noted here only so they aren't mistaken for this change.

## Implementation Approach

Three phases, smallest-blast-radius first. Phase 1 is the headline one-listener fix that kills the
most-likely symptom and is independently shippable. Phase 2 makes the remaining failure modes
self-explanatory. Phase 3 closes the latent traps and adds the regression lock — the "automate
what's feasible" deliverable, keeping only the genuinely GUI-bound steps manual.

## Critical Implementation Details

- **State sequencing (Phase 1):** the `change` handler must write `state.whisperAdvanced
  .wordLevelSrtExport` **before** calling `saveWhisperAdvancedToLS()` (it serializes from state,
  `transcribe.js:400-411`), then `emit()`. Do not reuse the full `applyWhisperAdvancedForm` here —
  that would also pull in the other unsaved modal fields and break the Zapisz/Anuluj semantics the
  other inputs rely on. Write only the checkbox.
- **Timing & lifecycle (Phase 2):** the inline confirmation must fire **before**
  `document.getElementById('whisperProgressBox').style.display = 'block'` in `alignToWords`
  (`transcribe.js:537`), or after a decline the progress box is left visible. Decline must return
  `false` cleanly so `exportSRT` writes nothing and the caller already handles `!ok`.
- **Dialog mechanism (Phase 2) — NEVER `window.confirm`:** the confirmation MUST use the async
  `ask()` from `@tauri-apps/plugin-dialog` with a Polish message. Synchronous JS dialogs
  (`window.confirm`/`prompt`/`alert`) **hard-crash** Tauri's macOS WKWebView — this is an accepted
  lesson (`context/foundation/lessons.md` → "Synchronous JS dialogs crash Tauri's macOS WKWebView";
  forced the S-03 swap to `ask()`). Use the same `ask()` pattern already used for the preset-delete
  flow.

## Phase 1: Checkbox persistence

### Overview

Make the word-SRT toggle persist the instant it changes, regardless of how the modal is dismissed,
and correct the stale `change.md` note.

### Changes Required:

#### 1. Live-persist the checkbox on toggle

**File**: `src/ui/import/transcribe.js` (in `initWhisperAdvanced`, near `transcribe.js:431-443`)

**Intent**: Add a `change` listener on `#advWordLevelSrt` so a tick/untick immediately writes the
flag to state + localStorage + `emit()`, decoupling persistence from the "Zapisz" button. This is
the core fix for the "clicked the checkbox, nothing happened" symptom.

**Contract**: New listener writes only `state.whisperAdvanced.wordLevelSrtExport =
el.checked`, then `saveWhisperAdvancedToLS()`, then `emit()`. Must NOT call
`applyWhisperAdvancedForm` (which would capture the other unsaved fields). Existing `advSaveBtn`
handler stays as-is (still applies the full form for the other settings).

#### 2. Correct the stale change.md note

**File**: `context/changes/word-srt-fix/change.md`

**Intent**: The "Notes" section claims two uncommitted bug-fix hunks that actually landed in commit
`2801144`; the live working-tree edits are unrelated Prettier reformatting. Update the note to
reflect the research finding so the record isn't misleading.

**Contract**: Prose-only edit to the `## Notes` section; no frontmatter `status` change here
(the skill stamps `status: planned` / `updated` separately).

### Success Criteria:

#### Automated Verification:

- Regression suite still green: `node --experimental-vm-modules test/regression.js`
- Rust unaffected — no backend change in this phase.

#### Manual Verification:

- Tick the checkbox, close the modal via **X**, reopen → still ticked.
- Tick it, close via **backdrop click**, reopen → still ticked.
- Tick it, restart the app (`npm run tauri dev`) → still ticked (criterion 3.3).
- Untick + Zapisz → stays unticked across restart (no regression of the existing path).

**Implementation Note**: After automated checks pass, pause for manual confirmation of the
persistence flows before proceeding to Phase 2.

---

## Phase 2: Export feedback + align hardening

### Overview

Make every export-abort path explain itself in Polish, and put the inline 37–67s auto-align behind
a clear confirmation so it's never a silent surprise.

### Changes Required:

#### 1. Toast on every silent abort path in `exportSRT`

**File**: `src/ui/export-popover.js` (`exportSRT`, lines 188-221)

**Intent**: Audit each early return so the user always learns why no file was written. The
currently-silent path is the post-align "still no frame-words" return (`:214`); ensure it emits a
specific Polish toast. Confirm the no-video branch (`:206-211`) and the empty-sentences branch
(`:189-191`) already toast (they do) and leave their messages intact.

**Contract**: Line-214 return gains a Polish toast (e.g. informing that alignment produced no
word-level timing, so word-by-word export isn't possible). No change to the happy path or to
`hasFrameWords()`.

#### 2. Cover the no-`srtContent` abort surfaced through export

**File**: `src/ui/import/transcribe.js` (`alignToWords`, lines 533-536)

**Intent**: `alignToWords` already toasts on missing video and missing `srtContent`; verify both
toasts are reached when invoked from the export fallback (not only from the manual button) so the
export-driven path never returns false without a visible reason.

**Contract**: No new behavior if the toasts already fire on every return; add a toast only where a
return path is currently silent. Keep `ANULOWANO`/error handling (`:566-574`) intact.

#### 3. Confirm before the inline cold-spawn align

**File**: `src/ui/import/transcribe.js` (`alignToWords`, before line 537)

**Intent**: Before spawning the WhisperX align sidecar (37–67s cold), surface a clear Polish
confirmation/notice so the wait is expected. Keep the align inline (chosen approach), just make it
informed. Decline aborts cleanly without showing the progress box.

**Contract**: A confirmation gate — implemented with the **async `ask()` from
`@tauri-apps/plugin-dialog`** (NEVER `window.confirm`, which hard-crashes the WKWebView; see
`context/foundation/lessons.md`) — fires before `whisperProgressBox` is shown
(`transcribe.js:537`); decline → `return false` (caller already handles `!ok` at
`export-popover.js:214`). Polish string. Because `alignToWords` is shared with the manual "Dopasuj
do audio" button, ensure the confirmation reads sensibly for both entry points (or gate it to the
export-driven call path).

#### 4. Don't leave the progress box stuck on cancel/abort

**File**: `src/ui/import/transcribe.js` (`alignToWords` catch / ANULOWANO branch, `:566-577`)

**Intent**: On user-cancel (ANULOWANO) the catch branch sets the box to "Anulowano." (0%) but
**never hides `whisperProgressBox`** — unlike the success path it stays on screen indefinitely, and
no toast fires while `exportSRT:214` returns silently. Close this so no abort leaves stale UI: hide
the progress box after the cancel/error message (and on the §3 confirmation decline, the box is
never shown in the first place — keep it that way).

**Contract**: The ANULOWANO branch hides `whisperProgressBox` (e.g. a short `setTimeout` hide
mirroring the success path at `:561-563`, or an immediate hide) after surfacing "Anulowano.". Keep
the error branch's existing toast (`:572`). No change to the success path. Polish strings.

### Success Criteria:

#### Automated Verification:

- Regression suite still green: `node --experimental-vm-modules test/regression.js`
- Prettier clean on touched files: `npx prettier --check "src/ui/export-popover.js" "src/ui/import/transcribe.js"`

#### Manual Verification:

- Mode ON + imported `.srt` + **no** video → Polish toast, no file (criterion 3.7).
- Mode ON + imported `.srt` + video → confirmation appears, then align runs, then native save
  prompt; cancelling the confirmation writes nothing and hides the progress box (criterion 3.6).
- Cancel the align mid-spawn → Polish "Anulowano", no file, no silent state.
- Mode ON + WhisperX project (already has frame-words) → per-word `.srt` saved with no align prompt
  (criterion 3.4).
- Mode OFF → normal sentence `.srt` (criterion 3.5).

**Implementation Note**: After automated checks pass, pause for manual confirmation of the export
feedback + align flows before proceeding to Phase 3.

---

## Phase 3: Latent-trap guard + regression locks

### Overview

Guard the flat-words/no-`segments` branch so it can't yield a silent empty export, and lock the F1
reversed-cue/diarized-overlap clamp in the regression suite — the "automate what's feasible"
deliverable.

### Changes Required:

#### 1. Guard the flat-words / no-`segments` branch

**File**: `src/ui/import/segments.js` (the `_pendingWhisperWords` merge path, ~lines 135-142) and/or
`src/ui/import/transcribe.js` (the no-`segments` engine branch, ~line 709)

**Intent**: When the engine returns `words` but no `segments`, today the words are stashed but
`state.sentences` is never set, so a later word-SRT export silently emits nothing. Add a defensive
guard/notice so this path either populates sentences or surfaces a clear Polish message — never a
silent empty result.

**Contract**: On the no-`segments` branch, either map the pending words into a minimal
`state.sentences` representation the exporter can consume, or emit a Polish toast indicating that
word-level export needs parsed sentences first. Decide by reachability during implementation
(research flags it as likely dead — a guard + toast is acceptable if populating is out of scope).
No change to the normal `segmentFromWords` path (`transcribe.js:695`).

#### 2. Regression test for the F1 reversed-cue / diarized-overlap clamp

**File**: `test/regression.js` (new case after Test 15, ~line 1264)

**Intent**: Test 15's onsets are strictly increasing, so the `Math.max(start, next.start_frame)`
clamp (F1 fix) is never exercised under a successor whose onset is **≤** the current word's start
(the diarized/overlapping case). Add a case where the next word's onset precedes the current end so
the clamp must produce `end = max(start, next.start)` and never a reversed cue (`end < start`).

**Contract**: New `generateWordSRT` assertion: given two consecutive words where
`next.start_frame ≤ current.start_frame` (or within the floor window), the emitted cue has
`start ≤ end` (no reversed/negative-duration cue) and no overlap into the next onset. Follow the
existing Test 15 structure (`assertEq` on exact stamps + targeted `assert`s); do not introduce a
new test framework.

### Success Criteria:

#### Automated Verification:

- Full regression suite green including the new F1 case: `node --experimental-vm-modules test/regression.js`
- New test fails if the `Math.max(start, …)` guard is reverted to `end = next.start_frame`
  (verify by temporarily reverting locally).
- Prettier clean: `npx prettier --check "test/regression.js" "src/ui/import/segments.js"`

#### Manual Verification:

- WhisperX-card ⬇ **Eksport .srt** still produces sentence-level output (criterion 3.9) — guard
  didn't alter the normal path.
- All new strings are Polish (criterion 3.10).
- After loading a video on an imported-SRT project → auto-align then save works end-to-end
  (criterion 3.8).

**Implementation Note**: After automated checks pass, pause for final manual confirmation of the
remaining GUI-bound criteria before marking the change done.

---

## Testing Strategy

### Unit / Regression Tests:

- Keep Test 15 unchanged (locks onset-pin / floor / clamp / stale-skip).
- Add the F1 reversed-cue/diarized-overlap case (Phase 3) — the previously-unguarded path.

### Manual Testing Steps (GUI-bound, run in `npm run tauri dev`):

1. Checkbox persists across X / backdrop / restart (Phase 1).
2. Mode ON + frame-words → per-word `.srt` via native prompt (Phase 2).
3. Mode OFF → sentence `.srt` (Phase 2).
4. Mode ON + imported `.srt` + video → confirm → align → save; cancel paths show Polish toasts (Phase 2).
5. Mode ON + imported `.srt` + no video → Polish toast, no file (Phase 2).
6. WhisperX-card ⬇ Eksport .srt still sentence-level (Phase 3).
7. All new strings Polish (Phase 3).

These map 1:1 to S-19's skipped criteria 3.3–3.10 — this time **observed**, not attested.

## Performance Considerations

The inline auto-align is a 37–67s cold WhisperX spawn ([[whisperx-cold-spawn-cost]]); Phase 2's
confirmation makes that cost explicit rather than reducing it. No new spawns are added to any
launch/critical path.

## Migration Notes

No data-model or `.reelproj` schema change. `wordLevelSrtExport` already exists in
`state.whisperAdvanced` (default `false`, `state.js:114`) and in the `edl_whisper_advanced`
localStorage bag; existing users' settings load unchanged.

## References

- Research: `context/changes/word-srt-fix/research.md`
- Exporter (correct): `src/exporters/transcript.js:68-98`
- Checkbox + persistence: `src/index.html:610-616`, `src/ui/import/transcribe.js:383-483`
- Export wiring: `src/ui/export-popover.js:188-233`
- Auto-align: `src/ui/import/transcribe.js:524-578`
- Test 15: `test/regression.js:1155-1263`
- S-19 archive: `context/archive/2026-06-18-word-level-srt-export/`
- Commit `2801144` (the F1/F3 fixes that change.md still calls "uncommitted")

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles.

### Phase 1: Checkbox persistence

#### Automated

- [x] 1.1 Regression suite still green — ee34f17
- [x] 1.2 Rust unaffected (no backend change) — ee34f17

#### Manual

- [x] 1.3 Tick → close via X → reopen still ticked — ee34f17
- [x] 1.4 Tick → close via backdrop → reopen still ticked — ee34f17
- [x] 1.5 Tick → restart app → still ticked (criterion 3.3) — ee34f17
- [x] 1.6 Untick + Zapisz → stays unticked across restart — ee34f17

### Phase 2: Export feedback + align hardening

#### Automated

- [x] 2.1 Regression suite still green — f8e8987
- [x] 2.2 Prettier clean on export-popover.js + transcribe.js — f8e8987

#### Manual

- [x] 2.3 Mode ON + imported .srt + no video → Polish toast, no file (3.7) — f8e8987
- [x] 2.4 Mode ON + imported .srt + video → confirm → align → save; cancel hides progress, writes nothing (3.6) — f8e8987
- [x] 2.5 Cancel align mid-spawn → Polish "Anulowano", no file — f8e8987
- [x] 2.6 Mode ON + WhisperX project (frame-words) → per-word .srt, no align prompt (3.4) — f8e8987
- [x] 2.7 Mode OFF → normal sentence .srt (3.5) — f8e8987

### Phase 3: Latent-trap guard + regression locks

#### Automated

- [x] 3.1 Full regression suite green incl. new F1 case — 2bf6b11
- [x] 3.2 New test fails if Math.max clamp is reverted (verify locally) — 2bf6b11
- [x] 3.3 Prettier clean on regression.js + segments.js — 2bf6b11

#### Manual

- [x] 3.4 WhisperX-card ⬇ Eksport .srt still sentence-level (3.9) — 2bf6b11
- [x] 3.5 All new strings Polish (3.10) — 2bf6b11
- [x] 3.6 Load video on imported-SRT project → auto-align then save end-to-end (3.8) — 2bf6b11
