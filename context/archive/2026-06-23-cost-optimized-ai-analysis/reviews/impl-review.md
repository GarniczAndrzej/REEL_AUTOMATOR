<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Cost-optimized AI analysis (cluster → curate)

- **Plan**: context/changes/cost-optimized-ai-analysis/plan.md
- **Scope**: Phases 1–5 (full plan; Phase 2a skipped — gate OPEN)
- **Date**: 2026-06-24
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 2 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | WARNING |
| Scope Discipline | PASS |
| Safety & Quality | PASS |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

Automated gates all green: regression 254/254, `cargo check` clean, grep gates
(callOpenRouter object-shape, orSelectedModel vs aiModels, exporter fields untouched) pass.

## Findings

### F1 — cache_control lever delivers no measurable benefit in this architecture

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Adherence (+ Success Criteria)
- **Location**: src/ai/providers.js:27-29; src/ai/prompt.js:182,208,231
- **Detail**: Phase 5 #2's intent was cache_control on the stable transcript prefix. As built, the marker wraps the entire user message as one block, and the prompt is `userPrompt → segments → guidance` with no isolated stable prefix. (1) Any prompt-identical re-call is served from the disk cache (`withLlmCache`) before `callOpenRouter` reaches the network, so the provider cache can't fire. (2) Across Stage-2 buckets, segments differ, so no shared cached prefix exists. Net: ≈0 cached_tokens; manual check 5.3 is unsubstantiated. Lever is no-op-safe (5.4 holds).
- **Fix A ⭐**: Accept as-is; annotate 5.3 + note the limitation in change.md.
  - Strength: The big input-cost win (Stage-1 minification) works; cache_control's ceiling here is low even if fixed.
  - Tradeoff: Leaves a planned lever inert.
  - Confidence: HIGH — provable from cache.js:30-36 + single call site.
  - Blind spot: Provider auto-caching of the system message (marginal).
- **Fix B**: Split prompts into stable-prefix (cached) + variable-suffix blocks.
  - Strength: Makes the marker meaningful for guidance-only edits.
  - Tradeoff: Restructures three prompt builders; still near-zero cross-bucket gain.
  - Confidence: MED — correct in principle, small payoff.
  - Blind spot: Provider min-cacheable-token thresholds.
- **Decision**: FIXED via Fix A (annotated plan Progress 5.3 → `[~]`; recorded limitation in change.md Notes)

### F2 — "Fixed defaults (~10 themes × ~25 ids)" are prompt-suggested, not code-enforced

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Adherence
- **Location**: src/ui/step2-prompt-panel.js:373-380; src/ai/prompt.js:72
- **Detail**: Bucket count/size come entirely from the cluster model's output (themes.map, no cap/pad); "~10×25" lives only in DEFAULT_CLUSTER_GUIDANCE prose. The coverage instrument (X/N + <50% warn) makes over/under-coverage visible.
- **Fix**: None required. If determinism matters later, cap themes/candidate_ids in code after validateThemes.
- **Decision**: SKIPPED (accepted as-is — prompt-guided + coverage instrument is sufficient)

### F3 — Per-bucket retry cannot be aborted

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Reliability)
- **Location**: src/ui/step2-prompt-panel.js:528
- **Detail**: retryBucket calls runBucket without a 4th arg, so the retried call gets signal=undefined and can't be cancelled. Low blast radius; no AbortController is live post-run anyway.
- **Fix**: None required this slice. If wanted, create a fresh controller in retryBucket routed through analysisController.
- **Decision**: SKIPPED (accepted as-is — informational, low blast radius)
