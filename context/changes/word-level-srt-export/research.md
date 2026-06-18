---
date: 2026-06-18T18:55:25+0200
researcher: GarniczAndrzej
git_commit: e5e7c01b47e60e9e493d346773e122639538d0a2
branch: master
repository: REEL_AUTOMATOR
topic: "Word-by-word SRT export (one cue per WhisperX word) behind a toggle"
tags: [research, codebase, srt-export, whisperx, word-timestamps, exporters]
status: complete
last_updated: 2026-06-18
last_updated_by: GarniczAndrzej
---

# Research: Word-by-word SRT export (one cue per WhisperX word)

**Date**: 2026-06-18T18:55:25+0200
**Researcher**: GarniczAndrzej
**Git Commit**: e5e7c01b47e60e9e493d346773e122639538d0a2
**Branch**: master
**Repository**: REEL_AUTOMATOR

## Research Question

Build a "word-level SRT export" feature: produce an `.srt` where **each WhisperX word becomes its own cue** with its own precise timestamp (karaoke / reels-style captions), exposed behind a **button or checkbox toggle**. Detailed analysis of where the data lives, how the existing export path works, and how to wire the toggle.

## Summary

**The feature is well-supported by what already exists; no backend changes are needed.** Per-word timestamps are already produced by the WhisperX path and stored, frame-converted, on each sentence as `state.sentences[].words[]`, and they round-trip through the `.reelproj` file (v7). The existing transcript SRT/VTT exporters live in `src/exporters/transcript.js` as pure functions, the export UI lives in `src/ui/export-popover.js`, and saving goes through `saveTextToPath` (native location prompt). A per-word exporter is a **new pure function** reading `s.words[].start_frame/end_frame`, plus a Polish-labelled toggle and a one-line branch in `exportSRT`.

**Critically, this slice is already specified in the roadmap as S-19** (`context/foundation/roadmap.md:315-328`) with hard timing rules that the plan MUST honor:

1. **Onset-pinned** — each cue's start = the word's real audio onset (`word.start_frame`), integer-frame, **never moved**.
2. **4-frame minimum hold** — every word held ≥ 4 frames, computed at the **project fps** (`Math.round`), per the integer-frame invariant.
3. **Right-side-only padding** — words shorter than the floor are lengthened by pushing the **end** later; the onset is untouched.
4. **Collision clamp (default)** — if right-pad would cross the next word's onset, clamp to that onset (no overlap; cue may stay below the floor). Onsets are sacred.
5. **Must NOT route through `mergeAdjacentClips`** — that is the reel-span source, kept separate from caption generation.
6. **Additive** — new export option alongside the existing sentence-level SRT/VTT, **not** a replacement.
7. **Integer-frame only**, **Polish strings**, and **add a regression case** covering onset-pin + floor + right-pad + clamp.

Three "unknowns" in the roadmap already have sensible documented defaults (clamp-to-next-onset, 4-frames-at-project-fps, additive new option) — confirm them with the user during planning rather than re-deriving.

## Detailed Findings

### Word-timestamp data flow (verdict: data is already in frontend state)

Per-word timing flows: WhisperX sidecar → `transcribe_video`/`align_transcript` (Rust) → frontend receipt → `segmentFromWords` (frame conversion) → `state.sentences[].words[]` → `.reelproj`.

- **Backend** (`src-tauri/src/whisper.rs`): the transcription payload is untyped `serde_json::Value` (no named struct). Both `transcribe_video` (`whisper.rs:524-529`) and `align_transcript` (`whisper.rs:727-732`) return `{ srt_content, words, segments, language }`. `segments[].words[]` is the rich source (`{text, start, end, score?, speaker?}`, seconds); the flattened `words[]` (`flatten_words`, `whisper.rs:106-127`) drops `score`. Cache `whisper-cache/v2/<hash>.json` stores the full payload verbatim.
- **Frontend receipt** (`src/ui/import/transcribe.js`): transcribe path uses the rich `segments` → `state.sentences = segmentFromWords(result.segments, state.fps, MIN_CHARS)` (`transcribe.js:650-652`). Align path uses flat `words` → `mergeWordsIntoSentences(...)` (`transcribe.js:522`). Word data is kept, never discarded.
- **Frame conversion** (`src/parser/word-segments.js:72-81`): `segmentFromWords` builds `words: [{ text, start_frame: Math.round(w.start*fps), end_frame: Math.round(w.end*fps), speaker? }]`.
- **State shape** (`src/state.js:1-25`): `Word = {text, start_frame, end_frame, speaker?}`; `Sentence.words?: Word[]` ("engine/align path only").
- **Persistence** (`src/ui/import/project-io.js:94,138`; `src-tauri/src/project.rs:5-15`): `state.sentences` (incl. `words[]`) is saved/loaded verbatim; `.reelproj` is now **version 7** (`project-io.js:78`). `save_project`/`load_project` are generic JSON round-trips — no stripping.

**Two caveats for the plan:**
- **Unit inconsistency between ingest paths.** Transcribe path stores words in **frames** (`start_frame/end_frame`); the align path (`mergeWordsIntoSentences`, `src/ui/import/segments.js:147-161`) stores **raw seconds** (`start/end`) without converting. A per-word exporter reading `start_frame` would break on align-path data. Plan must either normalize at the source or handle both shapes. (The roadmap assumes frame-based `words[]`.)
- **Not all sentences have `words[]`.** Only the WhisperX engine/align path populates them; **`parseSRT`/`parseVTT` (imported `.srt`/`.vtt`) discard word granularity** (see below). Manually-pasted/imported transcripts have no `words[]`, so the toggle must gracefully no-op / disable / warn when word data is absent.

### Existing SRT/VTT exporters (the hook point)

`src/exporters/transcript.js` — pure functions (no DOM/state/IO), exactly where the new exporter belongs:

- `generateTranscriptSRT(sentences, fps, opts)` (`transcript.js:35-53`) — sentence-level SRT. Already has an `opts.includeWords` flag, but it only appends a **non-standard `NOTE WORDS: text@start-end` comment line** — it does **not** emit one cue per word. This is *not* the feature; the new mode needs real per-word cue emission.
- `generateTranscriptVTT(sentences, fps)` (`transcript.js:61-72`).
- `frameToStamp(frames, fps, sep)` (`transcript.js:13-21`, module-private) — frames → `HH:MM:SS,mmm` (`sep=','` SRT) / `HH:MM:SS.mmm` (`sep='.'` VTT) via `Math.round(frames/fps*1000)`. **No offset — starts at `00:00:00,000`** (correct for SRT; the CMX-3600 `3600*fps` offset belongs only to the EDL exporter, not subtitles). **Reuse this helper as-is** for word cues.

### Export UI + save flow

- `src/ui/export-popover.js`: the `<details class="export-more">` expander wires `exSrtBtn → exportSRT`, `exVttBtn → exportVTT`, `exMdBtn`, `exPromptBtn` (`export-popover.js:57-60`). `exportSRT` (`export-popover.js:186-196`) guards on `state.sentences.length`, calls `generateTranscriptSRT(state.sentences, state.fps)`, saves via `saveTextToPath({ defaultName: transcriptBase()+'.srt', content })`, toasts in Polish.
- HTML for the expander: `src/index.html:1003-1022` (new checkbox/toggle goes inside this block, near `exSrtBtn` ~line 1009).
- Save flow: `src/util/save-file.js:17-35` — `saveTextToPath({defaultName, content, filters})` uses `@tauri-apps/plugin-dialog` `save()` (native location picker — honors the "every save prompts for a location" rule) then writes via the `save_text_file` Rust command (`src-tauri/src/project.rs:20`, registered `lib.rs:19`). Returns `true`/`false`. No change needed.
- **Scope**: SRT/VTT export feeds on `state.sentences` (the **whole transcript**), independent of reel/clip selection (reels feed only EDL/XML/Lua). The per-word SRT likewise covers the full transcript — and per the roadmap must **not** go through `mergeAdjacentClips`.

### Toggle / persistence pattern

Canonical "add a boolean option" pattern in this codebase:

1. **State** — add a field to the `state` object (`src/state.js:50+`), e.g. alongside `mergeThreshold`/`diarize`.
2. **Mutate + notify** — on a checkbox `change`, set `state.x = e.target.checked` then call `emit()` (pub-sub: `subscribe`/`emit` at `state.js:115-122`). Reference: diarization toggle (`transcribe.js:49-66`).
3. **Persist (cross-session)** — `src/settings.js` (`edl_app_settings` localStorage key): `loadSettings()` at boot, `saveSettings({x})` on change. Reference: `mergeThreshold` wiring in `settings-modal.js:31-39`.

**Placement decision (a roadmap "unknown" with a default):** the roadmap default is an **additive new option in the export popover** (session-time choice next to the existing SRT button). The toggle/settings agent leaned toward the settings modal for a sticky cross-session default. Both are viable — recommend resolving with the user in `/10x-plan`. The user's stated intent ("a button or checkbox to turn on this mode") fits **a checkbox in the export-popover expander** most directly; persisting it via `saveSettings` is a cheap add if "sticky" is wanted.

### Frame math / parsing

- `parseSRT(text, fps, minChars)` (`src/parser/srt.js:122-172`): merges cues into punctuation-terminated sentences via `Math.round(seconds*fps)`; **word granularity is lost** (keeps only first-cue start + last-cue end). Builds `{id, text, start_frame, end_frame, duration_frame, start_tc, end_tc}` (`srt.js:156-164`). Hence word data must come from `words[]`, not from re-parsing SRT.
- `framesToTC` (`srt.js:11-57`) → `HH:MM:SS:FF` (NDF/drop-frame), used for `start_tc`/EDL — **not** for subtitle stamps; use `frameToStamp` instead.

### Regression test pattern

`test/regression.js` (bespoke runner, no framework; `assert`/`assertEq` at lines 31-60). Relevant existing cases: Test 9 `segmentFromWords` word-frame math (`regression.js:718-812`, uses `test/whisperx-fixture.json`), Test 10 v4 `words[]` `.reelproj` round-trip (`815-858`), Test 11 transcript `.srt`/`.vtt` export asserting `00:00:00,xxx` (no offset) (`862-901`), Test 12 diarization labels. **Add a new Test 13** for the word-by-word exporter following Test 9/11 structure, asserting: cue start == word `start_frame` (onset-pin, never moved), 4-frame floor at project fps, right-side-only padding, and collision clamp to next onset.

## Code References

- `src-tauri/src/whisper.rs:106-127` — `flatten_words` (drops `score`)
- `src-tauri/src/whisper.rs:524-529` / `727-732` — payload returned by `transcribe_video` / `align_transcript`
- `src/ui/import/transcribe.js:650-652` — transcribe path → `segmentFromWords`
- `src/ui/import/transcribe.js:522` — align path → `mergeWordsIntoSentences`
- `src/parser/word-segments.js:72-81` — word → frame conversion, attaches `words[]`
- `src/ui/import/segments.js:147-161` — `mergeWordsIntoSentences` (stores raw seconds — unit inconsistency)
- `src/state.js:1-25` — `Word` / `Sentence` typedefs
- `src/state.js:115-122` — `subscribe` / `emit` pub-sub
- `src/ui/import/project-io.js:78,94,138` — `.reelproj` v7 save/load of `sentences` (incl. `words[]`)
- `src/exporters/transcript.js:13-21` — `frameToStamp` (reuse for cues)
- `src/exporters/transcript.js:35-53` — `generateTranscriptSRT` (+ misleading `includeWords` NOTE flag)
- `src/ui/export-popover.js:57-60,186-196` — export expander wiring + `exportSRT`
- `src/index.html:1003-1022` — export-more expander HTML (toggle home)
- `src/util/save-file.js:17-35` — `saveTextToPath` native save prompt
- `src/settings.js` + `src/ui/settings-modal.js:31-39` — settings persistence pattern
- `src/parser/srt.js:11-57,122-172` — `framesToTC`, `parseSRT` (word granularity lost)
- `test/regression.js:718-901` — Tests 9–11 (word segmentation, v4 round-trip, transcript export)

## Architecture Insights

- **Exporters are pure** `(sentences[, fps][, opts]) → string` with no DOM/state/IO — keep the new word exporter pure and unit-testable; pass `fps` and any options as args.
- **Integer-frame invariant**: all subtitle timing derives from `*_frame` via `Math.round(s*fps)`; never round to seconds mid-pipeline. The 4-frame floor must be computed in frames at project fps.
- **No CMX-3600 offset for subtitles** — `frameToStamp` correctly starts at `00:00:00,000`; only EDL applies `3600*fps`.
- **Two ingest paths, one Sentence shape, but inconsistent word units** (frames vs seconds) — the single biggest correctness trap for this feature.
- **Separation of concerns**: caption generation must stay off the `mergeAdjacentClips` reel-span path.

## Historical Context (from prior changes)

- **S-05 `builtin-whisperx-transcription`** (`context/archive/2026-06-12-builtin-whisperx-transcription/`): introduced WhisperX, word-level forced alignment, and the existing `.srt`/`.vtt` transcript export (FR-005); bumped `.reelproj` to v4 to persist `words[]`. This produces the source data S-19 consumes.
- **diarization-data-only decision** (user memory + roadmap): speaker labels persist to `.reelproj` but are **intentionally not shown** in SRT/VTT/UI. The word-by-word SRT should likewise **not** emit speaker labels.
- **S-16 `ui-ux-redesign`**: pruned the `minChars` UI knob (segments now align to word precision); bumped schema (now at v7).
- **S-19 `word-level-srt-export`** — this slice; fully specified at `context/foundation/roadmap.md:315-328`, marked `proposed`, "ready for `/10x-plan`: yes" (`roadmap.md:350`).

## Related Research

None prior for this change (first artifact). Source spec: `context/foundation/roadmap.md:315-328` (S-19).

## Open Questions

These are the roadmap's S-19 "unknowns" — owner is **user**, none blocking; confirm defaults in `/10x-plan`:

1. **Right-pad collision policy** — clamp to next onset (default, no overlap, cue may stay sub-floor) vs. allow brief overlaps?
2. **fps basis for the floor** — 4 frames at project fps (default, honors integer-frame invariant) vs. fixed ~160 ms regardless of fps?
3. **New export vs. replace** — additive new Polish-labelled option (default) vs. replace existing SRT export? (User intent points to additive checkbox in the export popover.)
4. **Word-unit normalization** — confirm the plan normalizes align-path words (seconds) to frames, or gates the feature to engine-path data, so `start_frame` reads are always valid.
5. **Toggle home + stickiness** — export-popover checkbox (session) vs. settings-modal persisted default (`saveSettings`).
6. **Missing `words[]` UX** — disable the toggle, warn via toast, or silently fall back to sentence-level SRT when no word data exists (imported-SRT projects)?
