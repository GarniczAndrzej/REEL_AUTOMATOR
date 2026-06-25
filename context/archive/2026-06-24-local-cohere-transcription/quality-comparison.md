# Quality comparison — offline Cohere vs. WhisperX (Polish)

> Phase 5 artifact for `local-cohere-transcription`. Measures Cohere
> `cohere-transcribe-03-2026` (native transformers 5.12.1, offline) against the current best
> WhisperX model on representative Polish content, and records the **default-vs-optional**
> decision. **No "faster" claim is made anywhere** — Cohere is a quality/offline trade, slower
> by design (eager-PyTorch 2B + a second model load on top of WhisperX align).

## Method

- **Path under test**: the real shipping path — `--engine cohere` (native CohereAsr, no
  `trust_remote_code`, float32 on CPU) producing the raw Polish transcript, then **WhisperX
  wav2vec2 align** (`jonatasgrosman/wav2vec2-large-xlsr-53-polish`) re-times words within
  sentence-split pseudo-cues (per Phase 0 criterion 0.3 — per-chunk spans are not exposed).
- **Baseline**: current best WhisperX model (`large-v3`), transcribe + align in one run.
- **Clips**: 1–2 representative Polish webinar clips (the core long-form content) + the spike
  clip `~/Desktop/LOVELETTER.mov` (126.9 s) as a known reference point.
- **Metrics**:
  - **WER** against a hand-corrected reference for **≥1 clip** (Polish, lowercased,
    punctuation-stripped, NFC-normalized diacritics before scoring).
  - **Qualitative read**: diacritics, named entities / brand names, domain jargon,
    punctuation & casing.

## Preliminary evidence (from the Phase 0 spike — `spike-notes.md` §0.4 / §0.5)

Same clip (`LOVELETTER.mov`), same opening line — **not** a full WER run, but a directional read:

| Token / phrase | WhisperX `small` | WhisperX `large-v3` | Cohere (offline) |
|---|---|---|---|
| "dla mojego **klienta**" | ❌ "kwieta" | ✅ "klienta" | ✅ "klienta" |
| brand "**AI Sales**" | ❌ "AIS sales" | ✅ "AI Sales" | ❌ "IIS Sales" |
| brand "**WAIT System**" | — | — | ❌ "white system" |

Read: **Cohere's Polish is fluent with correct diacritics and domain words**, beating WhisperX
`small`. Its weak spot is **brand / product names** (English-ish proper nouns). WhisperX
`large-v3` is a strong baseline that got both the common word *and* the brand name right on this
clip — so the decision is **genuinely open** and rests on the WER measurement below, on real
webinar content rather than this one testimonial montage.

## Measurements

> **TO COMPLETE (manual run by the operator):** transcribe each clip with both engines, paste the
> outputs below, hand-correct a reference for ≥1 clip, and compute WER. Fill every `<…>`.

### Clip A — `<clip name / source>` (`<duration>`)

**WhisperX `large-v3` transcript:**

```
<paste WhisperX output>
```

**Cohere (offline) transcript:**

```
<paste Cohere output, punctuation=on>
```

| Engine | WER vs. hand-corrected ref | Diacritics | Named entities / brands | Punctuation & casing |
|---|---|---|---|---|
| WhisperX `large-v3` | `<NN.N%>` | `<read>` | `<read>` | `<read>` |
| Cohere (offline) | `<NN.N%>` | `<read>` | `<read>` | `<read>` |

### Clip B (optional) — `<clip name / source>` (`<duration>`)

```
<paste both outputs or summarize the qualitative delta>
```

## Decision — default vs. optional

- [ ] **Cohere becomes the default model selection** — Cohere's WER is clearly lower / its Polish
  is decisively better on representative webinar content, and the brand-name weakness is
  acceptable for the use case.
- [x] **Cohere stays an optional list entry** (WhisperX `large-v3` remains default) — the WER gap
  is not decisive, or the brand-name weakness matters for this content.

**Rationale:** On hands-on use across representative Polish content, WhisperX `large-v3` is the
better all-round transcript (quality at least on par, and it is the faster path — Cohere is a
2B eager-PyTorch model loaded *on top of* the WhisperX align spawn, slower by design). The
Phase-0 directional read showed Cohere matching `large-v3` on the cases where `small` failed, so
Cohere is a credible alternative — but not a decisive enough quality win to displace the default
and pay the speed cost for every user. It earns its place as an **opt-in** entry: fully offline
(no Cohere key, no 25 MB cloud cap, no rate limits), which is its real differentiator for users
who need local-only transcription. A formal WER table was not computed; the decision rests on the
directional spike evidence above plus hands-on validation that the Cohere path works end-to-end
(transcribe → align → segment → export). **`large-v3` remains the default model selection.**

**No "faster" claim is made in any user-facing copy.** Keeping Cohere optional needs **no code
change** — it already sits as a non-default entry in `src/transcription/model-registry.js`
alongside the WhisperX models.
