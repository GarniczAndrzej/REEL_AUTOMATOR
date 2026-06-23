# Frame Brief: Cost-optimized AI analysis (cluster → curate)

> Framing step before /10x-plan. This document captures what is *actually*
> at issue, separated from what was initially assumed.

## Reported Observation

Running the current single LLM call on a real ~700-segment transcript produces a
**complete, valid JSON response whose reel selection is poor** — segments are
forgotten, ordering is off, and choices feel generic. (User-confirmed: the output
was *not* truncated; it parsed fine — the content was wrong.)

`idea.md` predicted a different failure: that the model would "cut off halfway
through its response… around Reel 4 or 5." That truncation was *not* what was
observed.

## Initial Framing (preserved)

- **User's stated cause or approach**: A single call is inadequate because of
  (a) output-token truncation and (b) long-context memory degradation; the fix is a
  two-step **cluster → curate** pipeline with model tiering.
- **User's proposed direction**: Build roadmap slice **S-25** — Stage 1
  cheap/long-context clustering → Stage 2 premium curation, plus model tiering,
  token/cost accounting, and per-stage/per-bucket cache reuse (4 levers, one slice).
- **Pre-dispatch narrowing**: Symptom = "quality was bad, output complete" (rules out
  truncation); leading concern = **cost and quality equally**; scope = **open to
  reframing** (willing to drop/reorder/sequence the levers).

## Dimension Map

Where "complete-but-bad reels" can originate:

1. **Output-token truncation** — idea.md's headline cause. ← initial framing (part a)
2. **Input cost (~52k tokens/call)** — real, but a cost problem, orthogonal to the symptom.
3. **Long-context recall / attention decay** — "forgets half / mixes order." ← initial framing (part b); the genuine quality hypothesis.
4. **Overloaded single prompt** — one call does cluster + curate + 4-axis score + virality + reason + 3 markers for ~700 segments at once.
5. **No measurement instrument** — `usage`/`finish_reason` discarded; no AI-quality eval exists.

## Hypothesis Investigation

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| 1. Output truncation (idea.md headline) | `max_tokens: 16384` vs ~1.5–2.5k actual output for 10 reels (`providers.js:22`, research §B); **user observed complete output**. Refuted twice. | NONE |
| 2. Input cost is the problem | ~52k input tokens/call, `JSON.stringify(...,null,2)` + redundant timecodes (`prompt.js:63,68`; research §B). Real cost fact — but a *different problem* than the observed quality symptom; a naïve two-step pipeline can *increase* input tokens. | STRONG (for cost) / ORTHOGONAL (to symptom) |
| 3. Long-context recall decay | Matches the symptom ("forgets half, mixes order"). But **no eval, no instrument** — unverifiable today. idea.md itself claims a 1M-context model (Gemini) does *not* degrade, making model choice a confound clustering doesn't isolate. | PLAUSIBLE / UNMEASURED |
| 4. Overloaded single prompt | Confirmed: one call asks for selection + naming + 4 scores + virality + reason + 3 markers across ~700 segments (`prompt.js:106-116`, `RESPONSE_FORMAT` `:12-30`, `DEFAULT_SCORING_GUIDANCE` `:36-41`). Maps to "lazy / generic choices." | STRONG (structural) |
| 5. No measurement instrument | `callOpenRouter` returns only `content`, discards `data.usage` + `finish_reason` (`providers.js:42`, research §B). No AI-quality eval anywhere (only `test/regression.js` for parser/exporter). | STRONG |

## Narrowing Signals

- **"Output was complete, but reels were wrong"** — single most decisive signal.
  Kills dimension #1 outright and reframes the problem from *truncation/cost* to
  *curation quality*.
- **"Cost and quality matter equally"** — keeps the input-cost lever (#2) in scope,
  but as a *parallel, independent* track, not the answer to the quality symptom.
- **"Open to reframing"** — permits a sequencing reframe rather than building all
  four levers as one committed slice.

## Cross-System Convention

This class of problem ("LLM output quality is bad on a large/complex input") is
normally attacked by **measuring before re-architecting**: capture token usage +
finish reason, then test the cheapest lever (a stronger/longer-context model, or a
focused prompt) before committing to a multi-call pipeline. The repo has **no
AI-quality eval harness and no token accounting** — so today there is no way to
confirm the cause of the bad reels or prove that any fix improved them. The
two-step pipeline is a reasonable remedy for dimension #3, but it is currently an
*unmeasured bet*, and idea.md's own Gemini argument suggests model choice alone
may recover most of the quality.

## Reframed (or Confirmed) Problem Statement

> **The actual problem to plan around is: the single call produces poor *curation
> quality* on long, mixed-topic input — and the project has no instrument to
> confirm why or to prove a fix helped. The truncation justification is false; cost
> is a real but separate concern.**

What changes if addressed: instead of committing to the full 4-lever S-25 build up
front, the work is **sequenced by evidence**. First add the measurement instrument
(capture `usage`/`finish_reason` + a lightweight quality spot-check). Then test the
cheapest quality lever — point the *existing single call* at a strong long-context
model (the "tiering" lever, per idea.md's Gemini claim). Only build the
cluster → curate pipeline if a strong single-shot call still degrades. The
cost levers (input minification, `cache_control` prefix) run as an **independent
parallel track**, since they don't depend on the quality outcome.

The initial framing is *not wrong about wanting a two-step pipeline* — it may well
be needed. It is wrong about (a) the truncation cause and (b) bundling an
unmeasured, expensive pipeline as a single committed slice before the cheap lever
is tested.

## Confidence

- **HIGH** on the *reframe* (truncation refuted; problem is curation quality;
  instrument-and-sequence before full build). Backed by the user's direct
  observation + file:line evidence.
- **LOW** on *which quality dimension dominates* (#3 recall decay vs #4 prompt
  overload) — and that is precisely the point: it is unmeasured.

**Verification step before /10x-plan commits to building the pipeline:** add the
token/cost + finish_reason readout and run the existing single call against (a) the
current model and (b) a strong long-context model on the real ~700-segment
transcript. If the strong-model single call still produces forgotten/mis-ordered
reels, the cluster → curate pipeline is justified; if it doesn't, the pipeline may
be unnecessary and the slice collapses to "model tiering + cost levers."

## What Changes for /10x-plan

Plan the slice as **evidence-sequenced**, not all-at-once: (1) instrumentation
(usage/finish_reason capture) + quality spot-check first; (2) model-tiering test on
the existing single call; (3) cluster → curate pipeline gated on that test's
result; (4) input-cost levers as a parallel track. Do **not** plan the two-step
pipeline as a settled requirement justified by output truncation.

## References

- Source files: `src/ui/step2-prompt-panel.js:68-187`, `src/ai/prompt.js:106-116`,
  `src/ai/prompt.js:12-41`, `src/ai/providers.js:22,42`, `src/ai/validate.js:19-109`,
  `src/ai/cache.js:13-48`, `src/state.js:90-92`
- Related research: `context/changes/cost-optimized-ai-analysis/research.md`
- Roadmap spec: `context/foundation/roadmap.md:428-463` (S-25)
- Idea source: `idea.md`
- Investigation: no sub-agent tasks spawned — decisive evidence was the user's
  direct observation plus existing research §B/§C and a confirming read of
  `prompt.js` / `providers.js` (skill guardrail #6: no hypothesis padding).
