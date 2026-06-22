# Word-by-word SRT export — fix — Plan Brief

> Full plan: `context/changes/word-srt-fix/plan.md`
> Research: `context/changes/word-srt-fix/research.md`

## What & Why

The word-by-word SRT export shipped by S-19 doesn't work for users — they tick the export
checkbox and get a normal sentence-level SRT instead. The exporter itself is correct (locked by
Test 15); the breakage is in the GUI glue. S-20 fixes that glue and closes the verification gap
that let S-19 ship broken (its manual criteria 3.3–3.10 were attested but never run).

## Starting Point

`generateWordSRT` (`src/exporters/transcript.js:68-98`) correctly emits onset-pinned, floor-padded,
collision-clamped per-word cues. But the `#advWordLevelSrt` checkbox only persists when the user
clicks "Zapisz" (no `change` listener), several export-abort paths fail silently, the inline
37–67s auto-align has no pre-spawn confirmation, and two latent traps (flat-words branch, the
unguarded reversed-cue clamp) were never verified.

## Desired End State

Ticking the word-SRT checkbox sticks no matter how the modal closes and survives a restart. With
the flag on and aligned words present, ⬇ Transkrypcja .srt writes a per-word file via the native
prompt; off, it writes a sentence file. Every path that produces no file explains itself in Polish.
The inline auto-align is informed by a clear confirmation. The latent traps are guarded and the
reversed-cue clamp is locked by a regression test.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Checkbox persistence (#1) | `change` listener on toggle | Toggle must stick regardless of how the modal closes — the most-likely symptom | Plan |
| Auto-align UX (#3) | Keep inline, add confirmation | Preserves S-19's one-click intent while making the 37–67s wait expected | Plan |
| Flat-words branch (#4) + F1 test | Do both | Closes the latent trap and locks the `Math.max` clamp that has no regression | Plan |
| Abort feedback (#2) | Toast on every abort path | Eliminates the silent "nothing happened" experience | Plan |
| Manual QA approach | Automate what's feasible | Push to regression suite where possible; keep only GUI-bound steps manual | Plan |
| Stray working-tree edits | Leave untouched, noted | api-key.js / step2-preset-bar.js are unrelated Prettier reformat | Research |

## Scope

**In scope:** checkbox `change` listener + localStorage write; Polish toasts on every export-abort
path; pre-spawn confirmation for inline auto-align; guard for the flat-words/no-`segments` branch;
F1 reversed-cue regression test; correcting the stale `change.md` note.

**Out of scope:** the exporter timing math; apply-on-Zapisz semantics for the other advanced
fields; any second export button; deferring the auto-align off the export click; the unrelated
Prettier edits.

## Architecture / Approach

Three phases, smallest blast radius first. Phase 1 is the one-listener headline fix (independently
shippable). Phase 2 makes remaining failure modes self-explanatory and gates the cold spawn.
Phase 3 guards the latent trap and adds the regression lock. No data-model or `.reelproj` change.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Checkbox persistence | `change` listener so toggle sticks on any close + restart | Must write only the checkbox, not the whole form (breaks Zapisz/Anuluj for other fields) |
| 2. Feedback + align hardening | Polish toast on every abort path; confirmation before inline cold-spawn align | `alignToWords` is shared with the manual button — confirmation must read sensibly for both |
| 3. Guard + regression locks | Flat-words branch guard; F1 reversed-cue test | Flat-words reachability uncertain — guard+toast acceptable if populating is out of scope |

**Prerequisites:** working `npm run tauri dev`; a WhisperX project and an imported-SRT + video
project for the manual flows.
**Estimated effort:** ~1–2 sessions across 3 phases.

## Open Risks & Assumptions

- Root cause #1 is the strongest hypothesis but only fully confirmed by running the app; the
  `change`-listener fix is correct regardless of the exact close path the user took.
- The flat-words/no-`segments` branch may be genuinely dead on the current engine — a defensive
  guard + Polish toast is acceptable if populating `state.sentences` there is out of scope.
- The inline auto-align cost (37–67s cold spawn) is made explicit, not reduced.

## Success Criteria (Summary)

- User ticks the checkbox, closes the modal any way, restarts → flag persists and word-SRT export
  works.
- No export click ever leaves the user without either a file or a clear Polish explanation.
- `node --experimental-vm-modules test/regression.js` is green including the new F1 case.
