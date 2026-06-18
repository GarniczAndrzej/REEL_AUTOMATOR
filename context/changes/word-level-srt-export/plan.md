# Word-by-word SRT export — reels-ready captions Implementation Plan

## Overview

Add a **word-by-word `.srt` export** (one cue per WhisperX word) suitable for dropping straight into TikTok / Instagram Reels as karaoke-style captions. The feature is governed by a **sticky checkbox in the WhisperX advanced-settings modal** ("Eksport słowo-po-słowie"). When the mode is ON, the existing **⬇ Transkrypcja .srt** popover button (`exSrtBtn` → `exportSRT`) emits per-word cues instead of sentence-level cues. **No new buttons** — the only UI is the checkbox plus that one existing button (the WhisperX-card `exportSrtBtn` "⬇ Eksport .srt" stays sentence-only by design). When word-level data is missing (imported `.srt`/`.vtt` projects) and a video is loaded, the export **auto-aligns** the transcript to audio first via the existing `align_transcript` flow; when no video is loaded, a Polish toast prompts the user to load one via the existing WhisperX video chooser.

Per-word timestamps already exist in `state.sentences[].words[]` and round-trip through `.reelproj` v7 — **no backend changes are needed**. The one correctness prerequisite is fixing a unit inconsistency: the align ingest path stores word timings in raw **seconds**, while the transcribe path stores **frames**; the exporter reads frames, so the align path is normalized first.

## Current State Analysis

- **Word data is already in frontend state.** `state.sentences[].words[]` carries `{text, start_frame, end_frame, speaker?}` (`src/state.js:1-25`), produced by `segmentFromWords` (`src/parser/word-segments.js:72-81`) on the transcribe path and persisted verbatim in `.reelproj` v7 (`src/ui/import/project-io.js:78`).
- **The exporter hook point is pure.** `src/exporters/transcript.js` holds `generateTranscriptSRT` / `generateTranscriptVTT` and a reusable module-private `frameToStamp(frames, fps, sep)` (`transcript.js:13-21`) that emits `HH:MM:SS,mmm` with **no CMX-3600 offset** (correct for subtitles). The existing `opts.includeWords` flag on `generateTranscriptSRT` only appends a non-standard `NOTE WORDS:` comment — it is **not** the per-word-cue feature.
- **The unit-inconsistency trap is confirmed in code.** `mergeWordsIntoSentences` (`src/ui/import/segments.js:147-161`, the **align** path) stores the raw WhisperX word objects (`{text, start, end}` in **seconds**) directly onto `s.words`, whereas `segmentFromWords` (the **transcribe** path) stores `{text, start_frame, end_frame}` in **frames**. A word exporter reading `start_frame` would read `undefined` on align-path data.
- **An alignment flow already exists.** `alignImportedTranscript()` (`src/ui/import/transcribe.js:488-539`) invokes the `align_transcript` Rust command, gated on a loaded video (`state._whisperVideoPath || state.videoPath`), and merges the result via `mergeWordsIntoSentences`. This is the exact mechanism the auto-align path reuses. Cold sidecar spawn costs ~37–67s (heavy — see [[whisperx-cold-spawn-cost]]).
- **The WhisperX advanced modal** (`src/index.html:538-597`, wired in `src/ui/import/transcribe.js:398-460`) houses the device/computeType knobs. Device/computeType persist **per-machine** in localStorage `edl_whisper_advanced`; this is the natural home + persistence channel for the new export-mode checkbox.
- **The export popover** (`src/ui/export-popover.js:186-196`) — `exportSRT` guards on `state.sentences.length`, calls `generateTranscriptSRT(state.sentences, state.fps)`, saves via `saveTextToPath` (native location prompt — honors the "every save prompts" rule, see [[save-prompts-location]]). The transcript export buttons live in the `<details class="export-more">` expander (`src/index.html:1003-1022`).
- **Video loading already has a home** — the WhisperX import flow's video chooser sets `state._whisperVideoPath` and auto-populates fps/resolution. The no-video auto-align path reuses that existing chooser (no export-side picker is added), so no new dependency on `populateVideoMeta`/`browseVideoMeta` is introduced.
- **Regression suite** (`test/regression.js`, bespoke runner) currently runs through **Test 14**. Test 9 covers `segmentFromWords` word-frame math (uses `test/whisperx-fixture.json`); Test 11 covers transcript `.srt`/`.vtt` export asserting `00:00:00,xxx` (no offset). The new word-SRT case is **Test 15**.

## Desired End State

With the WhisperX "Eksport słowo-po-słowie" checkbox enabled, the user clicks the existing **⬇ Transkrypcja .srt** button and receives a `.srt` where **each spoken word is its own cue**: cue start pinned to the word's real audio onset (integer-frame, never moved), every word held ≥ 4 frames (at project fps), shorter words padded only on the right, and any right-pad that would cross the next word's onset clamped to that onset (overlap-free). With the checkbox off, the button still produces the normal sentence-level `.srt`. Imported-transcript projects without word data trigger forced alignment automatically (or prompt for a video first), then export. The regression suite proves the timing rules.

### Key Discoveries:

- Word data already in state + persisted; backend untouched (`src/state.js:1-25`, `project-io.js:78`).
- Reuse `frameToStamp` as-is for word cues — correct, offset-free (`transcript.js:13-21`).
- The align path stores **seconds**, the transcribe path **frames** — the single biggest correctness trap (`segments.js:147-161` vs `word-segments.js:72-81`).
- Auto-align mechanism already exists and routes through the path we normalize (`transcribe.js:488-539`).
- Caption generation must **not** route through `mergeAdjacentClips` (that is the reel-span source) — the word exporter reads `s.words[]` directly.
- Speaker labels must **not** be emitted (diarization is data-only, see [[diarization-data-only]]).

## What We're NOT Doing

- **No backend / Rust changes.** Word data already flows to the frontend and persists.
- **Not** changing the sentence-level `.srt`/`.vtt` exporters or the `includeWords` `NOTE WORDS:` flag — the word mode is **additive**.
- **Not** routing word cues through `mergeAdjacentClips` or the reel/clip selection — the export covers the whole transcript.
- **Not** emitting speaker labels in the word `.srt`.
- **Not** adding a fixed-millisecond floor — the floor is 4 frames at project fps (integer-frame invariant).
- **Not** allowing overlapping cues — collisions clamp to the next onset.
- **Not** bumping the `.reelproj` schema — the export-mode flag is a per-machine localStorage preference, not project data.
- **Not** adding any new buttons or a separate video picker — the entire UI is the checkbox (WhisperX advanced modal) + the existing **⬇ Transkrypcja .srt** popover button. The second SRT button in the WhisperX card (`exportSrtBtn` → `exportTranscriptSRT`) is intentionally **left untouched** (sentence-level only). No-video case is handled by a toast that points the user at the existing WhisperX video chooser.

## Implementation Approach

Three phases, each independently testable. Phase 1 removes the unit-inconsistency trap at its source so every `words[]` reader (including the new exporter and the auto-align result) sees frames. Phase 2 adds the pure exporter and its regression case — fully unit-testable with no UI. Phase 3 wires the UI: the persisted mode checkbox in the WhisperX modal, the branch in `exportSRT`, and the auto-align fallback. No new buttons.

## Critical Implementation Details

- **Unit normalization must preserve the `Word` typedef shape.** After Phase 1, `mergeWordsIntoSentences` must emit `{text, start_frame, end_frame, speaker?}` (frames via `Math.round(w.start * fps)` / `Math.round(w.end * fps)`), matching `segmentFromWords` exactly so the two ingest paths converge on one shape. Older `.reelproj` files saved through the align path still hold seconds — the exporter (Phase 2) guards by reading only numeric `start_frame`/`end_frame` and skipping words that lack them, so stale files degrade gracefully rather than emitting `NaN` timestamps.
- **Onset-pin ordering inside `generateWordSRT`.** Compute each word's padded end **before** clamping, then clamp against the **next word's raw onset** (`words[i+1].start_frame`), not the next word's padded end. Onsets are never modified. A word with no successor (last word of the last sentence, or last word before a gap) pads freely to the floor.
- **Auto-align is heavy and async.** The `align_transcript` cold spawn costs ~37–67s. The export handler must show the existing `whisperProgressBox` progress UI during alignment and only proceed to `saveTextToPath` once `words[]` are populated. Do not block the UI thread; reuse the `transcribe-progress` event listener pattern from `alignImportedTranscript`.

## Phase 1: Normalize align-path word units to frames

### Overview

Make the align ingest path store word timings as integer frames, matching the transcribe path, so `state.sentences[].words[]` has one consistent shape everywhere.

### Changes Required:

#### 1. Align-path word merge

**File**: `src/ui/import/segments.js`

**Intent**: Convert the raw WhisperX word objects (seconds) to the frame-based `Word` shape before attaching them to sentences, so downstream readers (the new exporter, `.reelproj` round-trip) always see `start_frame`/`end_frame`.

**Contract**: `mergeWordsIntoSentences(sentences, words, fps)` — the filtered words assigned to `s.words` must be mapped to `{text, start_frame: Math.round(w.start * fps), end_frame: Math.round(w.end * fps), speaker?}` (carry `speaker` only when present), mirroring `segmentFromWords` (`src/parser/word-segments.js:72-81`). The overlap-filter math (which currently reads `w.start`/`w.end` in seconds) must run **before** the conversion or use the raw values for the midpoint test — keep the existing ±0.15s window semantics.

#### 2. Regression coverage for the unified shape

**File**: `test/regression.js`

**Intent**: Lock the align-path output to the frame shape so the seconds-vs-frames regression can't return.

**Contract**: Extend the existing word round-trip coverage (near Test 10) or add an assertion in Test 9's neighborhood: feed `mergeWordsIntoSentences` a sentence + seconds-based words at a known fps and assert the resulting `s.words[0]` has integer `start_frame`/`end_frame` equal to `Math.round(start*fps)` / `Math.round(end*fps)` and **no** `start`/`end` keys.

### Success Criteria:

#### Automated Verification:

- [ ] Regression suite passes: `node --experimental-vm-modules test/regression.js`
- [ ] New align-shape assertion passes (frame keys present, seconds keys absent)

#### Manual Verification:

- [ ] Import a `.srt`/`.vtt`, run "Dopasuj do audio" (align), save `.reelproj`, reload — words survive as frames and segments render correctly

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Word-by-word SRT exporter (pure function + regression)

### Overview

Add a pure `generateWordSRT` exporter implementing the S-19 timing rules, plus a dedicated regression case.

### Changes Required:

#### 1. Word-by-word exporter

**File**: `src/exporters/transcript.js`

**Intent**: Emit one SRT cue per word across the whole transcript, applying onset-pin + 4-frame floor + right-side-only padding + clamp-to-next-onset. Pure function, no DOM/state/IO, reusing `frameToStamp`.

**Contract**: `export function generateWordSRT(sentences, fps) → string`. Flatten `sentences[].words[]` in order (skip sentences with no `words[]`, and skip any word lacking numeric `start_frame`/`end_frame`). For each word: `start = w.start_frame` (never moved); `floor = Math.round(4)` → the minimum hold is **4 frames at project fps** (the floor is literally 4 frames; "≈160ms" is the 25fps interpretation — do not recompute from ms); `end = max(w.end_frame, start + 4)`; if a next word exists and `end > next.start_frame`, set `end = next.start_frame` (clamp; cue may end up < 4 frames — onsets are sacred, no overlap). Number cues sequentially from 1; emit `frameToStamp(start, fps, ',') --> frameToStamp(end, fps, ',')` then `w.text`. **No** speaker labels. The "next word" is the next word in the flattened global order (across sentence boundaries), so clamping respects real audio adjacency.

#### 2. Regression Test 15

**File**: `test/regression.js`

**Intent**: Prove onset-pin, 4-frame floor, right-side-only padding, and collision clamp.

**Contract**: New `Test 15: word-by-word SRT export`. Construct sentences with hand-built `words[]` (frames) exercising: (a) a word longer than the floor → unchanged end; (b) a word shorter than the floor with room → end pushed to `start + 4`, start unchanged; (c) a short word whose floor would cross the next onset → end clamped to next `start_frame` (cue < 4 frames, no overlap); (d) the final word → free pad to floor. Assert exact `HH:MM:SS,mmm` start strings equal the onset stamps (proving starts never move) and the computed ends. Reuse the Test 11 stamp-format expectations.

### Success Criteria:

#### Automated Verification:

- [ ] Regression suite passes: `node --experimental-vm-modules test/regression.js`
- [ ] Test 15 passes (onset-pin, floor, right-pad, clamp all asserted)

#### Manual Verification:

- [ ] `generateWordSRT` output opens cleanly in a subtitle viewer / Reels import — no overlaps, words on-screen long enough to read

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 3: Mode checkbox + export wiring + auto-align fallback

### Overview

Surface the feature: a sticky "Eksport słowo-po-słowie" checkbox in the WhisperX advanced modal, the branch in `exportSRT`, and the auto-align fallback when word data is missing. No new buttons — when no video is loaded, a Polish toast points the user at the existing WhisperX video chooser.

### Changes Required:

#### 1. Mode-checkbox state field

**File**: `src/state.js`

**Intent**: Hold the word-export mode flag.

**Contract**: Add `wordLevelSrtExport: false` to `state.whisperAdvanced` and to `defaultWhisperAdvanced()` (`transcribe.js:360-371`) — it lives inside the advanced-settings bag, not as a separate top-level field, so it shares one persistence channel with `device`/`computeType` and is covered by the modal's existing Save/Reset. Not part of `.reelproj` (per-machine preference).

#### 2. Checkbox UI in the WhisperX advanced modal

**File**: `src/index.html`

**Intent**: A Polish-labelled checkbox inside `#whisperAdvancedModal` (`src/index.html:538-597`) that toggles word-export mode, with a short helper line matching the modal's existing `setting-item` style.

**Contract**: New `<input type="checkbox" id="advWordLevelSrt">` with label "Eksport napisów słowo-po-słowie (.srt)" and a one-line hint (e.g. "Każde słowo jako osobny napis — dla Reelsów/TikToka."). Place it near `advForceCpu` (line ~578) following the existing `setting-item` markup.

#### 3. Checkbox wiring + persistence

**File**: `src/ui/import/transcribe.js`

**Intent**: Persist the checkbox through the **same channel as every other advanced knob** — apply on the modal's "Zapisz" button, save into the `edl_whisper_advanced` localStorage bag — so it is sticky per-machine and behaves identically to `device`/`computeType` (no write-through-on-change; the diarize toggle is NOT the model here — `state.diarize` does not persist).

**Contract**: Wire `advWordLevelSrt` ↔ `state.whisperAdvanced.wordLevelSrtExport` through the four existing advanced helpers (`transcribe.js:373-455`): read it in `fillWhisperAdvancedForm` (set checkbox from state on modal open), write it in `applyWhisperAdvancedForm` (state from checkbox on "Zapisz"), persist it in `saveWhisperAdvancedToLS` (add to the JSON bag alongside `device`/`computeType`), and restore it in `loadWhisperAdvancedFromLS` (read `saved.wordLevelSrtExport` if boolean). It is already defaulted by `defaultWhisperAdvanced()` (#1), so `advResetBtn` clears it for free. No standalone change-listener.

#### 4. Export branch + auto-align fallback

**File**: `src/ui/export-popover.js`

**Intent**: When `state.whisperAdvanced.wordLevelSrtExport` is true, `exportSRT` emits the word `.srt`. If no sentence carries `words[]`, run forced alignment first (when a video is loaded), then export; if no video is loaded, toast the user to load one.

**Contract**: Import `generateWordSRT`. In `exportSRT`: if `state.whisperAdvanced.wordLevelSrtExport` is false → existing behavior. If true → check whether any sentence has a populated `words[]`. If yes → `saveTextToPath({ defaultName: transcriptBase()+'.srt', content: generateWordSRT(state.sentences, state.fps) })`, Polish success toast. If no words[] and a video path exists (`state.videoPath || state._whisperVideoPath`) → run the alignment via a shared, **exported** `alignToWords()` helper extracted from `alignImportedTranscript` (`transcribe.js:488-539`), reusing the `whisperProgressBox` progress UI; the helper must **return a success boolean (or throw)** so the caller can branch — the current private function returns void and swallows errors. Only on a successful align (verified by re-checking that some sentence now has numeric `words[].start_frame`) proceed to `saveTextToPath`; on align failure/cancel, abort without writing. If no words[] and no video → toast "Najpierw wybierz plik wideo, aby dopasować napisy do audio." (the user loads a video via the existing WhisperX video chooser) and abort. The auto-align flow must populate `words[]` via the now-frame-normalized `mergeWordsIntoSentences` (Phase 1).

### Success Criteria:

#### Automated Verification:

- [ ] Regression suite passes: `node --experimental-vm-modules test/regression.js`
- [ ] Rust type-check passes (no backend change expected, sanity): `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`

#### Manual Verification:

- [ ] Checkbox in WhisperX advanced modal toggles the mode and persists across app restarts
- [ ] With mode ON + a WhisperX-transcribed project: ⬇ Transkrypcja .srt saves a per-word `.srt` (native save prompt), opens cleanly in a viewer
- [ ] With mode OFF: the same button still saves a normal sentence-level `.srt`
- [ ] With mode ON + imported `.srt` (no words) + video loaded: export auto-aligns (progress shown) then saves the word `.srt`
- [ ] With mode ON + imported `.srt` + no video: Polish toast prompts to load a video via the WhisperX chooser; no file written
- [ ] After loading a video via the WhisperX chooser, the same export then auto-aligns and saves the word `.srt`
- [ ] The WhisperX-card ⬇ Eksport .srt button still produces sentence-level `.srt` (mode does not affect it)
- [ ] All new strings are Polish

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation.

---

## Testing Strategy

### Unit Tests (regression.js):

- Phase 1: align-path `mergeWordsIntoSentences` emits frame keys, no seconds keys.
- Phase 2 (Test 15): onset-pin (start stamps never move), 4-frame floor, right-side-only pad, clamp-to-next-onset (no overlap, cue may stay sub-floor), final-word free pad.

### Manual Testing Steps:

1. Transcribe a short video with WhisperX → enable the checkbox → export `.srt` → verify per-word cues in a viewer.
2. Toggle the checkbox off → export → verify sentence-level `.srt` returns.
3. Import a plain `.srt`, no video → export in word mode → expect the "load video" toast → load a video via the existing WhisperX chooser → export → auto-align runs → word `.srt` saved.
4. Reload the app → confirm checkbox state persisted.

## Performance Considerations

Auto-alignment cold-spawns the WhisperX sidecar (~37–67s, see [[whisperx-cold-spawn-cost]]) — gate it behind the progress UI and only on the missing-words path; never on the happy path where `words[]` already exist. The exporter itself is O(words) string building, negligible.

## Migration Notes

No schema bump. Older `.reelproj` files saved via the align path before Phase 1 may still carry seconds-based `words[]`; the Phase 2 exporter skips words lacking numeric `start_frame`/`end_frame`, so such files degrade to fewer/no word cues rather than emitting `NaN` — re-running alignment regenerates frame-based words.

## References

- Internal research: `context/changes/word-level-srt-export/research.md`
- Roadmap spec (S-19): `context/foundation/roadmap.md:315-328`
- Exporter hook: `src/exporters/transcript.js:13-53`
- Unit-trap source: `src/ui/import/segments.js:147-161` vs `src/parser/word-segments.js:72-81`
- Existing align flow: `src/ui/import/transcribe.js:488-539`
- WhisperX modal: `src/index.html:538-597`; export expander: `src/index.html:1003-1022`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Normalize align-path word units to frames

#### Automated

- [x] 1.1 Regression suite passes: `node --experimental-vm-modules test/regression.js`
- [x] 1.2 New align-shape assertion passes (frame keys present, seconds keys absent)

#### Manual

- [ ] 1.3 Import → align → save → reload: words survive as frames, segments render

### Phase 2: Word-by-word SRT exporter (pure function + regression)

#### Automated

- [ ] 2.1 Regression suite passes: `node --experimental-vm-modules test/regression.js`
- [ ] 2.2 Test 15 passes (onset-pin, floor, right-pad, clamp)

#### Manual

- [ ] 2.3 `generateWordSRT` output opens cleanly in a viewer / Reels import — no overlaps, legible holds

### Phase 3: Mode checkbox + export wiring + auto-align fallback

#### Automated

- [ ] 3.1 Regression suite passes: `node --experimental-vm-modules test/regression.js`
- [ ] 3.2 Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`

#### Manual

- [ ] 3.3 Checkbox toggles mode and persists across restarts
- [ ] 3.4 Mode ON + transcribed project: per-word `.srt` saved via native prompt, opens cleanly
- [ ] 3.5 Mode OFF: sentence-level `.srt` still produced
- [ ] 3.6 Mode ON + imported `.srt` + video loaded: auto-align then word `.srt` saved
- [ ] 3.7 Mode ON + imported `.srt` + no video: Polish toast prompts to load a video; no file written
- [ ] 3.8 After loading a video via the WhisperX chooser, the same export auto-aligns and saves the word `.srt`
- [ ] 3.9 WhisperX-card ⬇ Eksport .srt still produces sentence-level `.srt` (mode does not affect it)
- [ ] 3.10 All new strings are Polish
