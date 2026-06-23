# Cost-optimized AI analysis (cluster → curate) — Plan Brief

> Full plan: `context/changes/cost-optimized-ai-analysis/plan.md`
> Frame brief: `context/changes/cost-optimized-ai-analysis/frame.md`
> Research: `context/changes/cost-optimized-ai-analysis/research.md`

## What & Why

> The actual problem: the single LLM call produces poor *curation quality* on long,
> mixed-topic input — and the project has no instrument to confirm why or to prove a fix
> helped. The truncation justification is false; cost is a real but separate concern.

So we re-architect the AI analysis path **evidence-sequenced**: instrument first, test the
cheap quality lever (a strong long-context model on the existing call), and only then build
the expensive cluster → curate pipeline — gated on evidence, not on the refuted truncation
story.

## Starting Point

Today `runAIAnalysis()` (`step2-prompt-panel.js:68-187`) makes one single-shot OpenRouter
call over ~700 segments (~52k input tokens), discards `usage`/`finish_reason`
(`providers.js:42`), and funnels through one validate→assign→sort→emit tail. Model choice is
a single scalar; the disk cache is a flat unversioned store. No token accounting and no
AI-quality eval exist.

## Desired End State

Every call surfaces tokens + cost + finish reason in a Polish readout. The editor can A/B a
strong model against the current one and record a verdict. **If** that verdict warrants it, a
two-stage pipeline (cheap cluster model → premium curate model, one OpenRouter key) runs with
per-bucket progress/retry, partial-failure recovery, abort across stages, an auto-collapse
threshold, and per-stage cache reuse — with Stage-2 output byte-identical to S-01 so no
exporter changes. Input cost drops via a minified Stage-1 prompt + `cache_control` prefix.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Problem framing | Curation quality, not truncation/cost | User saw complete-but-bad output; truncation refuted twice | Frame |
| Sequencing | Evidence-sequenced, pipeline gated | Don't build an unmeasured expensive pipeline before testing the cheap model lever | Frame / Plan |
| Phase-1 instrument | usage + finish_reason + cost readout | Unblocks the threshold decision and makes cost visible | Plan |
| Cache namespacing | In-key `{stage, v}` tag | Per-bucket reuse with zero Rust change | Plan |
| Bucket failure | Keep successes, retry failed bucket | Matches roadmap recoverability; one bad bucket ≠ wasted run | Plan |
| Model tiering | Two pickers, one OpenRouter key | Reuses the picker component; no keychain change | Plan |
| Bucket sizing | Fixed defaults (~10×~25) | Fewer settings to design/test; tune later | Plan |
| Cost levers | Stage-1 minification + `cache_control` | The documented big input-cost wins | Plan |
| Auto-collapse | Tunable constant + manual override | Works now, refine from real usage data | Plan |

## Scope

**In scope:** token/cost instrumentation; strong-model A/B gate; two-model tiering UI; split
cluster/curate prompts; gated cluster→curate pipeline with retry/abort/threshold; Stage-1
validator; input-cost minification + `cache_control`.

**Out of scope:** Stage-3 polish pass; user-tunable bucket sizing; second Keychain key / split
billing; any Stage-2/S-01 schema, exporter, `.reelproj`, parser, or Rust-cache change.

## Architecture / Approach

Grow `callOpenRouter` incrementally (usage return → message-blocks with `cache_control`).
Keep `withLlmCache`'s shape; change only the keys fed to it (`{stage, v}`). Preserve the
single convergence tail (`step2-prompt-panel.js:151-159`) as the only writer of
`state.reelsData` — all cluster + per-bucket curate fan-out happens before it. New
`validateThemes` guards the Stage-1 shape and drops hallucinated ids; `validateReels` stays
untouched for Stage-2.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Instrumentation & cost readout | usage/finish_reason capture + Polish cost panel | `callOpenRouter` signature change touches call sites |
| 2. Strong-model A/B (gate) | Recorded verdict: build pipeline or collapse slice | Subjective quality judgement |
| 3. Model tiering plumbing *(gated)* | Two pickers + split prompts, single-shot intact | Picker generalization regressions |
| 4. Cluster → curate pipeline *(gated)* | Two-stage run + retry/abort/threshold/validator | Orchestration surface; keep Stage-2 byte-identical |
| 5. Cost levers (parallel) | Minified Stage-1 + `cache_control` prefix | `cache_control` only lands on some providers |

**Prerequisites:** S-01, S-03, S-16 (all shipped). Phase 2's verdict gates Phases 3–5.
**Estimated effort:** ~4–6 sessions; Phases 1–2 small, Phase 4 is the bulk.

## Open Risks & Assumptions

- **Frame Confidence: LOW on which quality dimension dominates** (recall-decay vs prompt
  overload) — this is unmeasured, which is exactly why Phase 2 gates the pipeline.
- A strong single-shot model may fix quality, in which case Phases 3–5 collapse to "tiering +
  cost levers" — the plan accommodates this.
- `cache_control` discount only lands on supporting providers; minification + architecture
  win still apply elsewhere.
- Bumping in-key cache `v` orphans old entries until a manual full clear (accepted).

## Success Criteria (Summary)

- Cost/usage visible after every run; truncation reported explicitly.
- A recorded gate verdict drives whether the pipeline gets built.
- With the pipeline on, a failed bucket retries without re-paying Stage 1 or other buckets,
  and exports stay byte-identical (regression suite green throughout).
