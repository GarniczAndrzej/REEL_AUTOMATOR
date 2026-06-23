---
change_id: cost-optimized-ai-analysis
title: Cost optimized ai analysis
status: implementing
created: 2026-06-23
updated: 2026-06-23
archived_at: null
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
