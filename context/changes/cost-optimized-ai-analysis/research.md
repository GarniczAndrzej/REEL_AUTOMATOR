---
date: 2026-06-23T09:36:01+0200
researcher: GarniczAndrzej
git_commit: 6994f542ce68cc4f6ab4fc2139e55fccd2870566
branch: master
repository: REEL_AUTOMATOR
topic: "Cost-optimized AI analysis — two-step (cluster → curate) pipeline, model tiering, token footprint, cache reuse"
tags: [research, codebase, ai-analysis, openrouter, prompt, cache, cost]
status: complete
last_updated: 2026-06-23
last_updated_by: GarniczAndrzej
---

# Research: Cost-optimized AI analysis (cluster → curate two-step pipeline)

**Date**: 2026-06-23T09:36:01+0200
**Researcher**: GarniczAndrzej
**Git Commit**: 6994f542ce68cc4f6ab4fc2139e55fccd2870566
**Branch**: master
**Repository**: REEL_AUTOMATOR

## Research Question

`idea.md` proposes replacing the current single LLM analysis call (paste ~700 segments, get
~10 scored reels back) with a **two-step cost-optimized pipeline**: Stage 1 uses a cheap,
long-context model to cluster all segments into ~10 thematic buckets of candidate IDs;
Stage 2 uses a stronger model to curate each bucket into a final scored reel. The four
levers in scope (per user): **two-step pipeline**, **model tiering**, **token/cost
accounting**, and **cache reuse**. This document maps what the codebase does today and the
exact integration points each lever touches, as evidence for `/10x-plan`.

## Summary

The entire AI analysis is **one async function**, `runAIAnalysis()` in
`src/ui/step2-prompt-panel.js`, structured as a strictly linear single-call pipeline:
`buildPrompt` → cached `callOpenRouter` → strip fences → `validateReels` →
`state.reelsData = parsed` → `sortReels` → `emit()`. Everything assumes **exactly one
model, one cache key, one prompt, one progress bar (3 hard-coded steps), one response**.

Key findings for the redesign:

- **Cost lives on the INPUT side, not output.** ~700 segments serialized with
  `JSON.stringify(..., null, 2)` ≈ **50–55k input tokens** per call. The `max_tokens: 16384`
  output cap is **not** a real bottleneck for ~10 reels (~1.5–2.5k output tokens) — the
  roadmap's "avoid output truncation" framing is secondary; input reduction (drop
  pretty-print + timecodes for Stage 1, only re-send clustered subsets in Stage 2) is the
  big win.
- **The schema is well-isolated.** `validateReels` is the **only** validation gate and runs
  at exactly two ingest points. It hard-requires only `reel_name` + valid `clip_ids`;
  everything else (`virality_score`, `scores`, `reason`, `markers`) is validated *only when
  present*. A two-step pipeline can converge on the same final `Reel[]` shape and **no
  exporter or `.reelproj` consumer needs to change** (the roadmap's "byte-compatible Stage-2"
  guarantee holds).
- **Model selection is a single flat scalar** (`state.orSelectedModel`, persisted to
  `localStorage['edl_or_model']`, NOT in `.reelproj`). Model tiering = add a second scalar
  beside it + a second mount of the existing `openrouter-picker.js`. S-17's drop of
  multi-*provider* support does **not** constrain multi-*model* tiering (both stages call the
  same `callOpenRouter`, one OpenRouter key).
- **The disk cache is already generic enough** for per-stage/per-bucket reuse — it is a flat
  `<appCacheDir>/llm-cache/<sha256>.json` store keyed by `sha256(JSON.stringify({provider,
  model, prompt}))`. No Rust change is strictly required; you just feed `withLlmCache`
  differently-scoped keys. The cache has **no versioning/namespace** (unlike `whisper-cache/v2/`)
  — worth adding if Stage-1 and Stage-2 want independent invalidation.
- **`callOpenRouter` discards `usage` and `finish_reason`** — there is no token accounting or
  truncation detection anywhere. Capturing these is a prerequisite for the roadmap's cost
  readout and for measuring the before/after saving.

This slice is already specified in the roadmap as **S-25** (see Historical Context). This
research confirms the roadmap's assumptions against live code and pins the exact file:line
integration points.

## Detailed Findings

### A. The single-call orchestration (`src/ui/step2-prompt-panel.js`)

`runAIAnalysis()` (`step2-prompt-panel.js:68-187`) is the whole pipeline. Entry is
`analyzeBtn` → `onAnalyzeClick()` (`:46-52`), which doubles as run/cancel: if a run is
in-flight it calls `analysisController.abort()`, else it starts a run.

The four modules are wired in one `try` block:

- **Build** (`:104-110`): `buildPrompt(state.userPrompt, state.systemPrompt, state.sentences,
  null, state.videoFilename || '')`. Note `sources` is **always `null`** — `state.sources`
  does not exist, so the multi-source branch in `prompt.js` is dead at runtime.
- **Cache + call** (`:118-132`): `orModel = state.orSelectedModel`;
  `cacheKey = JSON.stringify({ provider: 'openrouter', model: orModel || '', prompt })`;
  `withLlmCache(cacheKey, () => callOpenRouter(apiKey, prompt, orModel, controller.signal))`.
- **Parse + validate** (`:146-147`): `responseText.replace(/```json|```/g, '').trim()` then
  `validateReels(JSON.parse(cleaned), state.sentences)`.
- **Commit** (`:151-159`): `pushUndo(snap())` → `state.reelsData = parsed` →
  `sortReels('score_desc')` (which itself stamps `ai_order`, sorts in place, calls
  `renderReels()` + `emit()`) → a second explicit `emit()`.

**Second ingest path:** `applyPastedJSON()` (`:207-233`) repeats strip → `validateReels` →
assign → `sortReels` → `emit()` for manually pasted JSON. **Any pipeline change must update
both call sites.**

**Error / retry (FR-018):** on a non-abort throw (`:168-181`), if the LLM returned text but
parse/validate failed, `revealPasteFix(rawResponse, 'Błąd walidacji: ' + e.message)`
(`:191-205`) stuffs the raw text into `#pasteJsonInput`, shows the Polish error, and opens
the paste-and-fix `<details>`. There is **no automatic retry loop** — recovery is manual.

**Abort:** one module-level `analysisController` (`:41`), `new AbortController()` at `:91`,
signal threaded into `fetch` via `callOpenRouter`. The catch at `:161-167` treats **any**
`AbortError` as a clean full cancel (leaves `state.reelsData` untouched). For a multi-call
loop, partial-completion semantics (some buckets done before abort) is an open decision.

**Progress UI:** a single `#progressBox` with **exactly three hard-coded steps**
`ps1/ps2/ps3` via `setPS(n, state)` (`:277-280`): build / call / parse. A `#logBox` append
log (`log()`/`logClear()`, `:284-291`) can absorb per-bucket lines without structural change.

**`state.*` touched:** reads `state.sentences`, `state.orSelectedModel`, `state.userPrompt`,
`state.systemPrompt`, `state.videoFilename`; writes `state.reelsData`, `state.reelSort`, and
`reel.ai_order` (via `sortReels`). API key comes from `#apiKeyInput` value or
`getApiKey('openrouter')` (`:69-71`), not state. `state.mergeThreshold` is export-stage only,
untouched here.

**Insertion point for Stage 2:** between `:147` (first response validated) and `:152`
(assignment). The first call becomes the *clustering* call; loop its buckets issuing per-bucket
`withLlmCache(...) → callOpenRouter(...)` curation calls; concatenate into the array assigned
at `:152`. The validate/assign/sort/emit tail (`:146-159`) stays as the single convergence
point.

### B. Prompt serialization & token footprint (`src/ai/prompt.js`, `src/ai/providers.js`)

**Serialization chain:** `formatSentence` (`prompt.js:1-7`) projects each `Sentence` to 5
fields — `id`, `text`, `start_tc`, `end_tc`, `duration_frames` (renamed from
`s.duration_frame`). `buildSegmentsSection` serializes via **`JSON.stringify(..., null, 2)`**
(`:63`, `:68`) — the 2-space pretty-print is the dominant non-text overhead.
`buildStaticBlock` (`:81-92`) wraps with a Polish header + the `RESPONSE_FORMAT` example
(`:12-30`). `buildPrompt` (`:106-116`) = `userPrompt` + static block + `systemPrompt`
(default `DEFAULT_SCORING_GUIDANCE` ≈ 700 chars, `:36-41`).

**INPUT estimate** (timecodes are `HH:MM:SS:FF`, 11 chars — `src/parser/srt.js:47,57`):
- Per-segment structural scaffold (braces, 5 keys, 2-space indent, two 11-char timecodes,
  id, duration) ≈ **45–55 tokens** of overhead independent of text; Polish `text` ≈ 20–30
  tokens. **~70–80 tokens/segment.**
- 700 segments ≈ **~52,000 tokens**; fixed overhead (user prompt + format example + guidance)
  ≈ 600–900 tokens. **Total ≈ 50–55k input tokens/call.** This is the cost driver.
- The two timecodes + `duration_frames` are redundant for *thematic clustering* (only needed
  for final marker/export placement). Dropping them + dropping pretty-print for Stage 1 gets
  to a minified `{"id":1,"text":"..."}` ≈ **30–40 tokens/segment** → **~50% input reduction
  on Stage 1**; Stage 2 only re-sends the small clustered subset.

**OUTPUT estimate:** `max_tokens: 16384`, `temperature: 0.1` (`providers.js:22-23`). Per-reel
output (name, 4 scores, virality, 3 markers, one-sentence `reason`, clip_ids) ≈ **150–250
tokens**; ~10 reels ≈ **1.5–2.5k tokens** — well under the cap. **16384 is not a real
bottleneck** for the stated 10-reel output; it would take ~80+ reels or huge clip lists to
approach it. The roadmap's "avoid output-token truncation" is a real-but-secondary concern;
the dominant lever is input.

**No token accounting / truncation detection exists.** `callOpenRouter` returns only
`data.choices?.[0]?.message?.content` (`providers.js:42`) and **ignores `data.usage` and
`data.choices[0].finish_reason`**. A `finish_reason: "length"` truncation is silently treated
as a malformed-JSON error and routed to the paste-fix path. Capturing `usage` +
`finish_reason` is a prerequisite for the roadmap's cost readout and for explicit truncation
handling.

### C. Schema contract — what the final output must still produce (`src/ai/validate.js`)

`validateReels` (`validate.js:19-109`) is the **only** validation gate, invoked at exactly two
points (`step2-prompt-panel.js:147` AI response, `:217` paste-fix). It **hard-requires**:
- `reel_name`: non-empty string (`:34`)
- `clip_ids`: non-empty array of integers, each existing in `state.sentences` ids (`:37-53`)

Everything else is validated **only when present** (backward-compat): `virality_score`
(`:56-63`), `scores{hook,flow,value,trend}` (`:64-80`), `reason` (`:81-83`),
`markers{hook,body,punchline}` — each marker must be an integer ∈ that reel's `clip_ids`
(`:84-105`).

**Every consumer of each field** (this is what a two-step pipeline's final output must still
satisfy):

| Field | Consumers |
|---|---|
| `reel_name` | `edl.js:35`, `xml.js:50`, `lua.js:137`, `fcpxml.js:147`, `step2-reel-list.js:184` |
| `clip_ids` | `edl.js:30`, `xml.js:45,63`, `lua.js:119,133`, `fcpxml.js:119`, `selection/timeline.js:4,33`, `step2-reel-list.js:116,137-155`, `step2-segment-ops.js` (many), `export-popover.js:88`, `parser/segments.js` (mergeAdjacentClips) |
| `virality_score` | `step2-reel-list.js:124-135` (badge + `weak` class), `:47-59` (sort) |
| `scores` | `step2-reel-list.js:128` → `renderAxisBadges` |
| `reason` | `step2-reel-list.js:132-133` (tooltip/line) |
| `markers` | `edl.js:61-63`, `xml.js:135-137`, `lua.js:163-165`, `fcpxml.js:129-131` (all gated `if (reel.markers)`) |

Typedef source of truth: `Reel` at `src/state.js:40-48`. Because every optional field is
gated, a two-step pipeline could even **degrade gracefully** (emit names+clips first, enrich
scores/markers second) without breaking validation or export — but the roadmap commits to
keeping Stage-2 output **byte-identical to S-01**, so the simplest safe path is: Stage 2 emits
the full existing schema, and only the new Stage-1 cluster output needs a new validator.

**Stage-1 minimal schema:** the roadmap fixes it as `{ themes: [{ title, candidate_ids[] }] }`.
This needs its **own lightweight validator** (do not reuse `validateReels` — it requires
`reel_name` and checks ids against sentences; raw clusters would fail). Critical guard
(roadmap Unknown "ID integrity"): validate Stage-1 `candidate_ids` against the real segment
set and **drop hallucinated ids** before building buckets. Consumers only ever see
`state.reelsData` (validated full `Reel[]`), so the intermediate cluster shape is free to be
minimal as long as Stage 2 converts buckets → `Reel[]` before the assignment at
`step2-prompt-panel.js:152`.

### D. Model selection plumbing (`src/ai/openrouter-picker.js`, `settings-modal.js`, `state.js`)

- **State:** `state.orSelectedModel` (single string id) + `state.orAllModels` (full model
  objects). Defined as flat scalars at `state.js:90-92` — **no structure holds >1 model**. A
  second model field goes right here (e.g. `orClusterModel` beside `orSelectedModel`, or an
  `aiModels: { cluster, curate }` object). No JSDoc typedef to update for the scalar.
- **Picker:** `loadOrModels()` (`openrouter-picker.js:40-71`) GETs
  `openrouter.ai/api/v1/models`, sorts by `id`, stores to `state.orAllModels`, caches verbatim
  to `localStorage['edl_or_models_cache']` (no TTL). Each model carries `id`, `name`,
  `context_length`, `pricing.prompt` — exactly the fields a cheap/long-context heuristic for
  the Stage-1 picker would read. `selectOrModel(id)` (`:134-140`) writes
  `state.orSelectedModel`, persists `localStorage['edl_or_model']`, `emit()`s. The picker is a
  reusable component — mounting a second instance for Stage 2 is the natural path.
- **Settings modal:** `settings-modal.js:24-25` only reveals `#orModelWrap`; the picker wires
  its own listeners at boot. Other AI settings here: API key (`:166-188`, → Keychain via
  `api-key.js`), merge-gap (`:31-40`), system prompt / scoring guidance (`:46-56`). Model is
  **not** routed through `saveSettings()` — only the picker's localStorage key.
- **Read for the call:** guard at `step2-prompt-panel.js:80`, captured at `:118`, passed at
  `:131`. **Not persisted to `.reelproj`** — confirmed by the save payload in
  `import/project-io.js:70-96`, which omits `orSelectedModel`/`orAllModels`. Model choice is a
  machine-global preference, not per-project.

### E. Caching plumbing (`src/ai/cache.js`, `src-tauri/src/project.rs`)

- **Frontend:** `withLlmCache(cacheKey, callFn)` (`cache.js:13-41`) computes
  `sha256hex(cacheKey)` (via `crypto.subtle.digest`, `:1-9`), calls Tauri `load_llm_cache`;
  on miss calls `callFn()` then `save_llm_cache`. Returns `{ result, fromCache, hashShort }`.
  Outside Tauri it falls through with no cache (`:21-22`). `clearLlmCache()` (`:43-48`) calls
  `clear_llm_cache`.
- **Backend** (`src-tauri/src/project.rs:33-53`, registered `lib.rs:41-43`):
  `load_llm_cache`/`save_llm_cache`/`clear_llm_cache` operate on
  `<appCacheDir>/llm-cache/<hash>.json` — **flat directory, raw response string verbatim, no
  versioning/namespace, no TTL/eviction**. `clear_llm_cache` `remove_dir_all`s the whole dir
  (the only purge). Contrast `whisper-cache/v2/` which IS versioned.
- **Current key:** `sha256(JSON.stringify({provider, model, prompt}))` where `prompt` bakes in
  all ~700 segments + user prompt + scoring guidance — **any change to any of those busts the
  whole cache** (no partial reuse today).
- **For two-step:** the wrapper is already generic; feed it differently-scoped keys.
  - Stage-1 key = `{provider, model: clusterModel, prompt: clusterPrompt}` built from the
    *segment set only*, **excluding** the curate prompt/model → reused across Stage-2 reruns.
  - Stage-2 keys = per-bucket `{provider, model: curateModel, prompt: bucketPrompt_i}` → each
    bucket reusable independently; re-running one bucket doesn't re-pay the others.
  - **Stability requirement:** bucket content/order fed to each prompt must be deterministic
    (stable sort of clip ids) or hashes drift between runs.
  - **Versioning option:** mirror `whisper-cache/v2/` by adding a `namespace`/`version` param
    to the Rust commands (`llm-cache/cluster-v1/`, `llm-cache/curate-v1/`) for selective
    invalidation, OR embed `{ stage, v }` in the hashed key (zero Rust change, but can't
    selectively purge from disk).

## Code References

- `src/ui/step2-prompt-panel.js:46-52` — run/cancel dispatch (`onAnalyzeClick`)
- `src/ui/step2-prompt-panel.js:68-187` — `runAIAnalysis` (entire single-call pipeline)
- `src/ui/step2-prompt-panel.js:104-110` — `buildPrompt` call site (`sources` = null)
- `src/ui/step2-prompt-panel.js:118-132` — cacheKey + `withLlmCache`/`callOpenRouter`
- `src/ui/step2-prompt-panel.js:146-159` — strip/validate/assign/sort/emit (convergence tail)
- `src/ui/step2-prompt-panel.js:160-186` — abort vs error branches, FR-018 paste-fix, finally
- `src/ui/step2-prompt-panel.js:191-205` — `revealPasteFix`; `:207-233` — `applyPastedJSON` (2nd ingest)
- `src/ui/step2-prompt-panel.js:277-291` — `setPS` (3-step progress), `log`/`logClear`
- `src/ai/prompt.js:1-7` — `formatSentence` (5 fields incl. redundant `duration_frames`)
- `src/ai/prompt.js:12-30` — `RESPONSE_FORMAT`; `:36-41` — `DEFAULT_SCORING_GUIDANCE`
- `src/ai/prompt.js:45-76` — `buildSegmentsSection` (`JSON.stringify(..., null, 2)`)
- `src/ai/prompt.js:81-92` — `buildStaticBlock`; `:106-116` — `buildPrompt`
- `src/ai/providers.js:9-43` — `callOpenRouter`; `:22-23` max_tokens 16384 / temp 0.1; `:42` discards usage/finish_reason
- `src/ai/validate.js:19-109` — `validateReels` (hard: reel_name + clip_ids; rest optional)
- `src/ai/cache.js:1-9,13-48` — `sha256hex`, `withLlmCache`, `clearLlmCache`
- `src-tauri/src/project.rs:33-53` — `load/save/clear_llm_cache` (`<appCacheDir>/llm-cache/<hash>.json`, unversioned)
- `src-tauri/src/lib.rs:41-43` — cache command registration
- `src/ai/openrouter-picker.js:24-37,40-71,134-140` — model list fetch/cache + `selectOrModel`
- `src/state.js:40-48` — `Reel` typedef; `:90-92` — `orAllModels`/`orSelectedModel` (single scalar)
- `src/ui/settings-modal.js:24-56,166-188` — picker reveal + merge-gap/system-prompt/API-key
- `src/ui/import/project-io.js:70-96` — `.reelproj` save payload (model NOT persisted per-project)
- `src/parser/srt.js:47,57` — timecode format `HH:MM:SS:FF`
- Exporter field consumers: `src/exporters/{edl,xml,lua,fcpxml}.js`, `src/exporters/markers.js`

## Architecture Insights

- **One convergence point is the safety net.** Both ingest paths funnel through `validateReels`
  → `state.reelsData`. A two-step pipeline should preserve this: do all fan-out (cluster +
  per-bucket curate) *before* the single validate/assign/sort/emit tail, so exporters and the
  reel list never see intermediate state.
- **Schema isolation is the enabling property.** The LLM schema only escapes through
  `validateReels` and the `Reel` typedef. Keeping Stage-2 output identical to S-01 means
  **zero exporter / `.reelproj` churn** — the highest-leverage constraint to hold (and the
  CLAUDE.md rule: grep field names before declaring a schema change done).
- **Cost asymmetry.** Input (~52k tokens) dwarfs output (~2k). The architecture win
  (don't re-send the whole transcript per bucket; cache the prefix) matters more than the
  output-truncation framing. `cache_control: { type: 'ephemeral' }` on the stable transcript
  prefix (roadmap lever) only lands on providers that honour it (Anthropic / Gemini 2.5 /
  Qwen) — a no-op elsewhere.
- **`callOpenRouter` must grow.** Today it is a fixed single-message/single-model call. The
  redesign needs it (or a sibling) to accept per-call model, message blocks (for
  `cache_control`), and to return `usage` + `finish_reason`. This is the single most-touched
  primitive.
- **Existing primitives already fit.** `withLlmCache` (per-call), `openrouter-picker.js`
  (reusable), the `AbortController`, and the `log()` box all generalize to N calls with minimal
  structural change. The 3-step `setPS` indicator is the main UI piece that needs reshaping.

## Historical Context (from prior changes)

- **`context/foundation/roadmap.md:428-463` — slice S-25** is the authoritative spec for this
  change and matches `idea.md`. It defines: Stage 1 cluster (cheap/long-context →
  `{ themes: [{ title, candidate_ids[] }] }`), Stage 2 curate (premium → **S-01 schema
  unchanged**), optional Stage 3 polish (off by default), and an auto-collapse to the legacy
  single-shot call below a segment-count threshold. Cost levers: `cache_control` ephemeral
  prefix, per-stage/per-bucket `withLlmCache`, and a post-run usage/cost readout. UI: two
  OpenRouter pickers in settings (S-16), split cluster/curate prompt presets (S-03), staged
  progress (S-07 pattern), shared Stop/abort (S-23). Open unknowns: one key vs two,
  `cache_control` reach, theme/bucket sizing, the auto threshold, and Stage-1 ID hallucination.
  Prerequisites S-01/S-03/S-16 are all shipped.
- **S-17 (OpenRouter-only migration, `context/archive/2026-06-15-s-17/`)** dropped Gemini &
  Claude *providers* to kill provider-dispatch duplication and deleted `src/ai/models.js`. This
  **does not constrain model *tiering*** — both stages call the same `callOpenRouter` with one
  OpenRouter key; only the `model` id differs. (CLAUDE.md confirms: OpenRouter-only, model
  chosen at runtime via the picker.)
- **S-01 (`context/archive/2026-06-12-scored-selection-edl/`)** introduced the current scored
  schema (`virality_score`, `scores`, `reason`, `markers`) and the `validateReels` gate that
  S-25 must keep byte-compatible on the Stage-2 side.
- **S-08 timeline-export-set (recent, commit `900bfeb` + earlier)** made all four exporters
  (EDL/XML/Lua/FCPXML) emit `reel.markers`. No schema change — markers were already validated
  and present. Reinforces "keep Stage-2 output identical" so this just-landed work isn't
  disturbed; run `node --experimental-vm-modules test/regression.js` if any exporter input
  shifts.
- **Lessons (`context/foundation/lessons.md`):** the "Synchronous JS dialogs crash Tauri's
  WKWebView" and "Keep all user-facing strings Polish" rules apply to any new settings/progress
  UI for the two pickers and cost panel.

## Related Research

- `context/changes/auto-mode-pipeline/research.md` (S-07, in-flight) — one-click
  import→transcribe→align→AI-select orchestration. **Prerequisite/coordinate, not a conflict:**
  S-25 splits the single "AI select" stage into cluster→curate *inside* S-07's final slot, and
  both share the S-23 `AbortController` and a staged-progress UI. S-07 also notes the backend
  single-run constraint (`ensure_engine_free`) — S-25's two AI calls are pure HTTP and don't
  touch the sidecar, but stages must run sequentially (Stage 2 needs Stage 1's buckets).

## Open Questions

These are the roadmap's S-25 Unknowns, confirmed still open against the code:

1. **Two model fields, one key** — confirmed feasible: add a second scalar beside
   `state.orSelectedModel` + a second picker mount; one Keychain OpenRouter account backs both.
   Separate-billing (two keys) would need a second keychain account in `api-key.js`.
2. **Cache namespace/versioning** — decide subfolder (`llm-cache/cluster-v1/`, needs a Rust
   param) vs in-key `{stage, v}` (zero Rust change, no selective disk purge).
3. **Auto single-shot threshold** — needs a real-transcript measurement; no token counting
   exists today, so capturing `usage` from `callOpenRouter` is a prerequisite to decide it.
4. **Partial-failure / abort semantics across buckets** — current catch treats any
   `AbortError` as a full clean cancel; roadmap wants a Stage-2 bucket failure to be
   recoverable (retry that bucket, keep the rest). New decision, no existing pattern.
5. **Stage-1 ID hallucination** — must validate `candidate_ids` against the real segment set
   and drop unknowns before building buckets (new lightweight validator, separate from
   `validateReels`).
