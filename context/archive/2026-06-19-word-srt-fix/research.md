---
date: 2026-06-22T00:21:28+0200
researcher: GarniczAndrzej
git_commit: 36a13d4d4aa357a50cd0af49ae65f61b6680c4a0
branch: master
repository: REEL_AUTOMATOR
topic: "word-srt-fix (S-20) — diagnose why the word-by-word SRT export is broken"
tags: [research, codebase, word-srt-export, transcript, export-popover, whisperx, defect-localization]
status: complete
last_updated: 2026-06-22
last_updated_by: GarniczAndrzej
---

# Research: word-srt-fix (S-20) — why the word-by-word SRT export doesn't work

**Date**: 2026-06-22T00:21:28+0200
**Researcher**: GarniczAndrzej
**Git Commit**: 36a13d4d4aa357a50cd0af49ae65f61b6680c4a0
**Branch**: master
**Repository**: REEL_AUTOMATOR

## Research Question

S-20 (`word-srt-fix`) is a "diagnose and repair the broken S-19 word-by-word SRT export"
slice. S-19 (`word-level-srt-export`) was archived as **done** without earning its manual
verification steps, and `change.md` reports two uncommitted bug-fix hunks. **Where exactly
does the word-by-word path fail?** (Scope: full root-cause dive; focus: defect localization.)

## Summary

The breakage is **not** in the timing math. The pure exporter `generateWordSRT`
(`src/exporters/transcript.js:68-98`) is correct — onset-pin, 4-frame floor, right-side-only
padding, and collision clamp are all implemented and locked by regression **Test 15**. The two
safeguards `change.md` describes as "uncommitted" (the `transcript.js` end-clamp and the
`export-popover.js` `hasFrameWords` tightening) were in fact **committed in `2801144`**
(2026-06-19 09:54) and are live in HEAD. The `change.md` "uncommitted fixes" note is **stale**;
the current working-tree edits (`src/ai/api-key.js`, `src/ui/step2-preset-bar.js`) are unrelated
Prettier reformatting.

The real defects are in the **data + persistence wiring** around the (correct) exporter, plus an
**entirely unguarded GUI integration** — exactly the surface the skipped manual steps (criteria
3.3–3.10) would have caught. Ranked root causes below; **#1 (checkbox only persists on "Zapisz")**
is the most likely explanation for the reported "I click the checkbox and nothing happens."

## Ranked Root Causes (defect localization)

### #1 — Checkbox state is only persisted on the "Zapisz" button, not on toggle  ★ most likely
The "Eksport napisów słowo-po-słowie (.srt)" checkbox (`#advWordLevelSrt`,
`src/index.html:610-616`) is read into `state.whisperAdvanced.wordLevelSrtExport` **only** by
`applyWhisperAdvancedForm` (`src/ui/import/transcribe.js:482`), which runs **solely** from the
`advSaveBtn` ("Zapisz") click handler (`transcribe.js:431-436`). There is **no `change`
listener on the checkbox itself**. A user who ticks the box and closes the modal via the **X or
the backdrop** never persists the flag, so `exportSRT` (`export-popover.js:194`) reads `false`
and silently emits a normal sentence-level SRT. Default is `false` (`src/state.js:114`).
→ Symptom matches "clicked it, nothing changed."

### #2 — `hasFrameWords()` false → export silently aborts (sometimes with no/var toast)
`hasFrameWords` (`src/ui/export-popover.js:225-233`) requires at least one word with **both**
`start_frame` and `end_frame` finite (correct, matches the exporter filter). When mode is ON but
no frame-words exist, the fallback at `export-popover.js:202-215` either toasts "Najpierw wybierz
plik wideo…" (no video path) or, after a failed/cancelled align, returns at line 214 **writing
nothing**. From the user's view the checkbox "did nothing."

### #3 — Auto-align fallback depends on `state.srtContent` + a heavy cold sidecar spawn
`alignToWords` (`transcribe.js:524-578`) requires both a video path **and** `state.srtContent`
(lines 525-536); missing `srtContent` → toast "Brak transkrypcji do dopasowania" → export
aborts. Even when wired, `align_transcript` is the WhisperX sidecar, a **37–67s cold spawn**
(see [[whisperx-cold-spawn-cost]]); a failure/cancel (`transcribe.js:566-574`) aborts the export
with no file. On the normal transcribe path `srtContent` is set (`transcribe.js:691`), so this
mainly bites imported-SRT flows.

### #4 — Flat-words engine branch never populates `words[]`
If `transcribe_video` returns `words` but **no** `segments`, the words land in
`state._pendingWhisperWords` (`transcribe.js:709`) and are only merged on a manual Parse click
(`segments.js:135-142`) — but in that branch `state.sentences` is never set either, so the
word-SRT export has nothing to emit. Edge/dead path today, but a latent trap.

## Detailed Findings

### The 6-link path (checkbox → words[] → align → SRT → save)

1. **Checkbox** — rendered `src/index.html:610-616` (id `advWordLevelSrt`, inside
   `#whisperAdvancedModal`, under an "Eksport napisów" subsection). Read by
   `applyWhisperAdvancedForm` (`transcribe.js:482`), written back by `fillWhisperAdvancedForm`
   (`transcribe.js:459`). Persistence: localStorage bag `edl_whisper_advanced` via
   `saveWhisperAdvancedToLS`/`loadWhisperAdvancedFromLS` (`transcribe.js:383-411`), hydrated at
   boot through `initWhisperAdvanced` → `step1.init()` (`src/main.js:48`). **Save-on-Zapisz-only
   gap → root cause #1.**
2. **`words[]` data** — `Word` typedef `{text, start_frame, end_frame, speaker?}`
   (`src/state.js:1-9`), stored on each `Sentence.words` (`state.js:24`). Primary populate path:
   `segmentFromWords(result.segments, fps, MIN_CHARS)` (`transcribe.js:695`,
   `src/parser/word-segments.js:22-86`, frames attached at 72-81). Align path:
   `mergeWordsIntoSentences` (`segments.js:162-188`) converts seconds → frames (178-186).
   **Flat-words no-segments branch → root cause #4.**
3. **`hasFrameWords` guard** — `export-popover.js:225-233`, used at `:204` (gate) and `:214`
   (re-check after align). Requires both frame keys finite. Correct; this is the F3 fix.
4. **Auto-align fallback** — `export-popover.js:202-215` → `alignToWords`
   (`transcribe.js:524-578`) → `align_transcript` → `mergeWordsIntoSentences`. **Root cause #3.**
5. **Word-by-word SRT generation** — `generateWordSRT` (`src/exporters/transcript.js:68-98`):
   ```js
   const FLOOR_FRAMES = 4;
   const start = w.start_frame;                                   // onset-pin (never moved)
   let end = Math.max(w.end_frame, start + FLOOR_FRAMES);         // 4-frame floor, right-pad only
   const next = words[i + 1];
   if (next && end > next.start_frame) end = Math.max(start, next.start_frame); // collision clamp
   ```
   Integer-frame invariant respected (`frameToStamp` at line 14 is the only s-conversion; rounds
   to whole ms — cosmetic shared-boundary timestamps possible, not an overlap). **No defect.**
6. **Save routing** — `export-popover.js:216-220` → `saveTextToPath` (`src/util/save-file.js:17-35`)
   opens the Tauri native `save` dialog (honors the "every save prompts" rule, see
   [[save-prompts-location]]). **No defect.**

### Git-history forensics (the "uncommitted fixes" question)

- **Both fixes were COMMITTED, not lost.** Commit **`2801144`** ("chore(roadmap): add S-20/S-21
  slices, fix word-SRT end-clamp and hasFrameWords, add JSDoc"), authored **2026-06-19 09:54:59
  +0200**, bundled both hunks. The `change.md` note was written earlier that morning while they
  were still uncommitted — it is now **stale**.
- **End-clamp** in HEAD: `src/exporters/transcript.js:89` →
  `if (next && end > next.start_frame) end = Math.max(start, next.start_frame);` (was
  `end = next.start_frame`; `Math.max(start, …)` enforces `start ≤ end`).
- **`hasFrameWords`** in HEAD: `src/ui/export-popover.js:225-231` requires
  `Number.isFinite(w.start_frame) && Number.isFinite(w.end_frame)` (was `start_frame`-only).
- Reflog is strictly linear after `2801144` (only the `app-crash-fix` series + archive close); no
  `reset`/`revert`/`stash` touched these files; `git stash list` empty.
- **Working-tree changes are unrelated**: `src/ai/api-key.js` and `src/ui/step2-preset-bar.js`
  are pure Prettier reformatting (multi-line `toast(...)`/`addPreset({...})` wrapping), zero
  functional change, no connection to word-srt-fix.

### S-19 contract & which manual steps were skipped

S-19 spec (roadmap `roadmap.md:362-375`, archived plan
`context/archive/2026-06-18-word-level-srt-export/`): onset-pin (start = real onset, never moved);
4-frame floor **at project fps** (literally 4 frames, not recomputed from ms — `plan.md:107`);
right-side-only padding; collision clamp to **next word's raw onset** in flattened global order;
additive mode (reuses the existing **⬇ Transkrypcja .srt** button, no second button); native
save prompt; Polish strings.

Implemented in 3 phases (Phase 1 align-unit normalization → `bfe3a34`; Phase 2 exporter + Test 15
→ `8a7e27f`; Phase 3 checkbox + wiring + auto-align → `2d1e092`).

**Skipped manual steps (attested `[x]`, never observed)** — `plan.md:179-188`, confirmed in
`reviews/impl-review.md:22` ("Manual: criteria 3.3–3.10 attested `[x]` … GUI flows"):
- 3.3 checkbox toggles mode and **persists across app restarts** ← directly exposes root cause #1
- 3.4 mode ON + WhisperX project → per-word `.srt` via native prompt, opens cleanly
- 3.5 mode OFF → normal sentence `.srt`
- 3.6 mode ON + imported `.srt` + video → auto-align then save
- 3.7 mode ON + imported `.srt` + no video → Polish toast, no file
- 3.8 after loading video → auto-align and save
- 3.9 WhisperX-card ⬇ Eksport .srt still sentence-level
- 3.10 all new strings Polish

**impl-review verdict**: APPROVED, 0 critical / 1 warning / 2 observations; F1 (reversed cue from
clamp) → the `Math.max(start, …)` fix; F3 (hasFrameWords mismatch) → the both-frames fix. No
plan-review file exists in the archive. The review **did not re-run the GUI flows** — every
app-level behavior rests on the unearned ticks.

### Test coverage (the automated guard, and its blind spots)

- **Test 15** (`test/regression.js:1155-1263`, FPS=25): asserts an exact 4-cue SRT — onset-pin
  (starts 0/20/50/52 never move), 4-frame floor (case b → `…,960`), word-longer-than-floor
  unchanged (case a), collision clamp (case c → 52, zero-overlap), and stale seconds-only words
  dropped (1247-1263). The pure timing math is genuinely earned.
- **Test 10b** (`regression.js:864-901`): align-path words carry integer `start_frame/end_frame`.
- **NOT covered (manual-only surface):** the `exportSRT` mode branch, the `hasFrameWords` gate,
  checkbox persistence/restart, `alignToWords` auto-align + progress UI, native save prompt
  firing, the no-video toast, "mode OFF still emits sentence SRT", and the **F1 reversed-cue /
  diarized-overlap path** (all Test 15 inputs are strictly increasing, so the `Math.max` guard
  has no regression lock).

## Code References

- `src/index.html:610-616` — `#advWordLevelSrt` checkbox + Polish label/hint
- `src/ui/import/transcribe.js:383-411` — `edl_whisper_advanced` localStorage save/load
- `src/ui/import/transcribe.js:431-436` — `advSaveBtn` handler (the **only** caller of `applyWhisperAdvancedForm`) ← root cause #1
- `src/ui/import/transcribe.js:459-483` — `fillWhisperAdvancedForm` / `applyWhisperAdvancedForm`
- `src/ui/import/transcribe.js:524-578` — `alignToWords` (auto-align fallback)
- `src/ui/export-popover.js:194-233` — `exportSRT` mode branch + `hasFrameWords` gate + fallback
- `src/exporters/transcript.js:68-98` — `generateWordSRT` (correct; line 89 end-clamp)
- `src/parser/word-segments.js:22-86` — `segmentFromWords` (primary words populate)
- `src/ui/import/segments.js:135-188` — `doParseBtn` / `mergeWordsIntoSentences`
- `src/util/save-file.js:17-35` — `saveTextToPath` native dialog
- `src/state.js:1-9,114` — `Word` typedef + `wordLevelSrtExport: false` default
- `test/regression.js:864-901,1155-1263` — Test 10b + Test 15

## Architecture Insights

- The exporter is a **pure function** of `(sentences, fps)` (CLAUDE.md exporter rule) and is the
  best-tested part of the feature. The defects live entirely in the **untyped, untested GUI glue**
  (modal persistence, export wiring, async align) — consistent with this codebase's recurring
  pattern that automated coverage stops at the pub-sub boundary and GUI flows rely on manual QA.
- Persistence is **save-button-gated, not change-gated** — a general modal-UX smell here:
  `applyWhisperAdvancedForm` only runs from "Zapisz", so any close-without-save loses edits.
- Two word-unit conventions (align=seconds, transcribe=frames) were a known trap S-19 Phase 1
  normalized; the `hasFrameWords` both-frames gate is the defensive descendant of that.

## Historical Context (from prior changes)

- `context/archive/2026-06-18-word-level-srt-export/plan.md` — full S-19 contract, 3 phases, the
  manual criteria 3.3–3.10 that were attested but unverified.
- `context/archive/2026-06-18-word-level-srt-export/reviews/impl-review.md` — APPROVED on
  **attested** manual ticks; F1/F3 fixes (later committed in `2801144`).
- Commit `2801144` (2026-06-19) — committed the end-clamp + hasFrameWords fixes that `change.md`
  still calls "uncommitted."
- Memory [[whisperx-cold-spawn-cost]] — align sidecar is a 37–67s cold spawn (relevant to the
  auto-align fallback UX, root cause #3).
- Memory [[save-prompts-location]] — confirms the native save-prompt routing is by design.

## Related Research

- `context/archive/2026-06-18-word-level-srt-export/research.md` — the original S-19 internal research.

## Open Questions

1. **Reproduce the exact failure mode.** Root cause #1 (save-on-Zapisz-only) is the strongest
   hypothesis but unconfirmed without running the app: does the user close the modal via X/backdrop
   after ticking? Confirm whether the checkbox needs a `change`-listener (persist on toggle) or
   whether the modal should auto-apply on close.
2. **Should the fix add a `change` listener / persist-on-close, or just educate that "Zapisz" is
   required?** A toggle that silently doesn't stick is a UX bug regardless.
3. **Auto-align UX (#3):** is the 37–67s cold spawn acceptable inline on export, or should the
   word-SRT export require pre-aligned words and refuse early with a clearer Polish prompt?
4. **Add a regression test for the F1 reversed-cue path** (diarized/overlapping onsets) so the
   `Math.max(start, …)` guard is locked — currently unguarded.
5. **The flat-words no-`segments` branch (#4):** is it reachable with the current WhisperX engine,
   or genuinely dead? Decides whether it needs a fix or just a guard/assert.
