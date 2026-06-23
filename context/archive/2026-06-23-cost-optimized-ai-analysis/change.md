---
change_id: cost-optimized-ai-analysis
title: Cost optimized ai analysis
status: archived
created: 2026-06-23
updated: 2026-06-24
archived_at: 2026-06-23T22:15:39Z
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

### Phase 2 gate verdict (2026-06-23): GATE OPEN → build cluster→curate pipeline (Phases 3–5)

Ran the existing single-shot path on the real 509-segment transcript across two strong
long-context models. Both underdeliver on curation quality:

| Model | Reels | Input tok | Output tok | Est. cost | Quality |
|---|---|---|---|---|---|
| `anthropic/claude-opus-latest` (baseline) | 10 | 67,454 | 1,832 | $0.3831 | "not the best, not terrible" — mediocre, user wants higher |
| `google/gemini-2.5-pro` | 6 | 56,217 | 5,342 | $0.1237 | far worse — thin reels (~2 segments / ~20s each) |

- Opus billed at standard tier ($5/M in, $25/M out); 67K input is below the 200K threshold,
  so the 1M long-context premium never applies to this transcript size.
- Gemini emitted *more* output tokens yet produced fewer, thinner reels → poor curation, not
  truncation.

**Decision:** two independent strong single-shot models both plateau on long mixed-topic
input → the model-swap lever does not fix curation. **Gate OPEN.** Proceed to Phase 3 (model
tiering) → Phase 4 (cluster→curate pipeline) → Phase 5 (cost levers). **Phase 2a
(cost-levers-only, gate-closed branch) is skipped.**

### Impl-review F1 (2026-06-24): Phase-5 cache_control lever is inert

The `cache_control: ephemeral` cost lever (Phase 5 #2, `providers.js:27-29`) delivers no
measurable benefit in this architecture and manual check 5.3 (non-zero `cached_tokens` on
second+ bucket) is **not substantiated**:

- Any prompt-identical re-call is served from the disk cache (`withLlmCache`) *before*
  `callOpenRouter` reaches the network, so the provider cache never fires on the one case it
  would help.
- The marker wraps the *entire* user message as a single block; variable content (per-bucket
  segments, trailing guidance) is not isolated as a suffix after the cache breakpoint, so no
  reusable stable prefix exists — and across Stage-2 buckets only the small `userPrompt`
  string is common anyway.

The lever is **no-op-safe** (5.4 holds — non-supporting/ignoring providers still succeed) and
the primary input-cost win (Stage-1 minification, Phase 5 #1) is real and working. Accepted
as-is this slice; making cache_control meaningful would require splitting prompts into a
stable-prefix (cached) block + variable-suffix block, deferred as low-payoff.
