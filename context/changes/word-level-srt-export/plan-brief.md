# Word-by-word SRT export — Plan Brief

> Full plan: `context/changes/word-level-srt-export/plan.md`
> Research: `context/changes/word-level-srt-export/research.md`

## What & Why

Export a **word-by-word `.srt`** (one cue per WhisperX word) for dropping straight into TikTok / Instagram Reels as karaoke-style captions. Each cue's start is pinned to the word's real audio onset (integer-frame, never moved), every word is held ≥ 4 frames at project fps, and short words are padded only on the right — so captions stay legible without drifting off the audio. Additive to the existing sentence-level SRT/VTT.

## Starting Point

Per-word timestamps already exist on `state.sentences[].words[]` (from S-05 WhisperX forced alignment) and round-trip through `.reelproj` v7 — **no backend work needed**. The sentence-level SRT/VTT exporters are pure functions in `src/exporters/transcript.js`, and an `align_transcript`-based alignment flow already exists for imported transcripts. One latent bug: the align ingest path stores word timings in **seconds** while the transcribe path stores **frames**.

## Desired End State

With the WhisperX "Eksport słowo-po-słowie" checkbox enabled, the existing ⬇ Transkrypcja .srt popover button emits per-word cues (onset-pinned, 4-frame floor, right-pad, clamp-to-next-onset — overlap-free). With it off, the button still produces normal sentence SRT. Imported-transcript projects with no word data auto-align to audio first; if no video is loaded, a Polish toast points the user at the existing WhisperX video chooser. No new buttons or pickers.

## Key Decisions Made

| Decision | Choice | Why | Source |
| --- | --- | --- | --- |
| Toggle home | Sticky checkbox in WhisperX advanced modal | User wants it in the WhisperX section; per-machine localStorage like device/computeType | Plan |
| Export trigger | Existing `.srt` button switches mode | One button, mode-driven; no second export button | Plan |
| Missing word data | Auto-align via existing `align_transcript` flow | Imported SRT/VTT gets word data on demand instead of a dead-end | Plan |
| No video loaded | Polish toast → load via existing WhisperX video chooser | Keep it simple; no new export-side controls | Plan |
| Align-path units | Normalize at source (store frames) | Removes the seconds-vs-frames trap permanently; one `Word` shape everywhere | Plan |
| Timing rules | All S-19 defaults (onset-pin, 4-frame floor @ fps, right-pad, clamp) | Documented spec + integer-frame invariant; overlap-free imports cleanly | Research / Roadmap |

## Scope

**In scope:** unit normalization on the align path; pure `generateWordSRT` exporter + regression Test 15; sticky mode checkbox (in `state.whisperAdvanced`); `exportSRT` branch; auto-align fallback.

**Out of scope:** backend/Rust changes; `.reelproj` schema bump; changing sentence-level exporters; routing through `mergeAdjacentClips`; speaker labels; fixed-ms floor; overlapping cues.

## Architecture / Approach

Frontend-only. `mergeWordsIntoSentences` is fixed to emit frames → both ingest paths converge on one `Word` shape. A new pure `generateWordSRT(sentences, fps)` reads `words[].start_frame/end_frame`, reusing the offset-free `frameToStamp`. UI: a persisted checkbox in `#whisperAdvancedModal` flips `state.whisperAdvanced.wordLevelSrtExport` (applied on "Zapisz", saved in the `edl_whisper_advanced` bag); `exportSRT` branches on it, auto-aligning (heavy ~37–67s sidecar spawn, behind the progress UI) when word data is absent.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Normalize align units | Align path stores frames; regression lock | Stale seconds-based `.reelproj` files (exporter skips non-numeric) |
| 2. Word exporter + Test 15 | Pure `generateWordSRT` + onset/floor/pad/clamp test | Clamp/onset ordering math |
| 3. UI + wiring + auto-align | Mode checkbox, export branch, auto-align fallback | Async auto-align UX; cold sidecar spawn cost |

**Prerequisites:** S-05 (shipped) — word-level alignment supplies the source data.
**Estimated effort:** ~1–2 sessions across 3 phases.

## Open Risks & Assumptions

- Older `.reelproj` files saved through the align path before Phase 1 carry seconds-based words; the exporter skips words lacking numeric frame keys (degrades gracefully; re-align regenerates).
- Auto-align cold-spawn (~37–67s) is acceptable as an explicit, progress-gated action only on the missing-words path.
- The export-mode flag is a per-machine preference, intentionally not persisted in `.reelproj`.

## Success Criteria (Summary)

- Mode ON → per-word `.srt` with onset-pinned, non-overlapping, legibly-held cues; mode OFF → normal sentence SRT unchanged.
- Imported transcripts without words auto-align (or prompt for video) then export.
- Regression Test 15 proves onset-pin + 4-frame floor + right-pad + clamp; full suite green.
