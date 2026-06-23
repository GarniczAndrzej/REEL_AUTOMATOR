# Cost-optimized AI analysis (cluster → curate) Implementation Plan

## Overview

Re-architect the AI analysis path — today one expensive single-shot OpenRouter call over
~700 segments (`runAIAnalysis()` in `step2-prompt-panel.js:68-187`) — into an
**evidence-sequenced** change. The frame brief refuted the "output truncation" cause
(user observed *complete* output with *poor curation*) and reframed the real problem as
**curation quality on long, mixed-topic input, with no instrument to confirm why or prove a
fix helped**. So we build in this order:

1. Add the measurement instrument (token usage + `finish_reason` + cost readout).
2. Test the cheapest quality lever — point the *existing single call* at a strong
   long-context model — and **gate** the rest on whether that alone fixes quality.
3. Only if the strong single-shot still degrades, build the cluster → curate pipeline.
4. Layer the input-cost levers (Stage-1 minification + `cache_control` prefix) as a
   parallel track.

This is roadmap slice **S-25**, replanned per the frame from "one committed 4-lever slice"
to "instrument → measure → gate".

## Current State Analysis

- **One linear single-call pipeline.** `runAIAnalysis()` does `buildPrompt` → cached
  `callOpenRouter` → strip fences → `validateReels` → `state.reelsData = parsed` →
  `sortReels('score_desc')` → `emit()`. A second ingest path, `applyPastedJSON()`
  (`step2-prompt-panel.js:207-233`), repeats strip → validate → assign → sort → emit for
  manually pasted JSON. **Any pipeline change must keep both paths funnelling through the
  same convergence tail.**
- **Cost is on the INPUT side.** ~700 segments serialized with
  `JSON.stringify(..., null, 2)` ≈ **50–55k input tokens/call** (`prompt.js:63,68`); each
  segment carries 5 fields incl. two 11-char `HH:MM:SS:FF` timecodes + `duration_frames`
  that are redundant for *thematic clustering*. Output is ~1.5–2.5k tokens for 10 reels —
  `max_tokens: 16384` (`providers.js:22`) is **not** a real bottleneck.
- **No instrument.** `callOpenRouter` returns only
  `data.choices?.[0]?.message?.content` (`providers.js:42`) and **discards `data.usage` and
  `finish_reason`**. There is no token accounting, no truncation detection, and no
  AI-quality eval anywhere (only `test/regression.js` for parser/exporter).
- **Schema is well-isolated.** `validateReels` (`validate.js:19-109`) is the **only**
  validation gate. It hard-requires `reel_name` + valid `clip_ids`; everything else
  (`virality_score`, `scores`, `reason`, `markers`) is validated *only when present*. The
  `Reel` typedef lives at `state.js:40-48`. Just-landed S-08 exporter work (all four
  exporters emit `reel.markers`) depends on this shape staying byte-identical.
- **Model selection is a single flat scalar** — `state.orSelectedModel` (`state.js:92`),
  persisted to `localStorage['edl_or_model']`, **not** in `.reelproj`. `openrouter-picker.js`
  is **not** a parameterized component — it is a **singleton**: only `init` and
  `updateOrBadge` are exported, and its ~16 `getElementById` calls are hard-wired to fixed
  DOM ids (`orModelSearch`, `orDropdown`, `orSelectedBadge`, `orSearchWrap`, `orLoadBtn`,
  `apiStatus`, `apiKeyInput`), the fixed `localStorage` key `edl_or_model`, and
  `state.orSelectedModel` (incl. the selected-item highlight `m.id === state.orSelectedModel`
  at `:97`). Mounting a second picker requires parameterizing all of this — a real refactor,
  not an additive mount.
- **The disk cache is generic but unversioned.** `withLlmCache(cacheKey, callFn)`
  (`cache.js:13-41`) hashes the key with SHA-256 and stores the raw response string at
  `<appCacheDir>/llm-cache/<hash>.json` via Tauri (`project.rs:33-53`). Flat directory, no
  namespace/version, `clear_llm_cache` nukes the whole dir.
- **Abort is all-or-nothing.** One module-level `analysisController`; the catch at
  `step2-prompt-panel.js:161-167` treats any `AbortError` as a full clean cancel.
- **Progress UI is 3 hard-coded steps** (`setPS(n)`, `:277-280`) plus an append `log()` box
  (`:284-291`) that can absorb per-bucket lines without structural change.

## Desired End State

After this plan:

- Every OpenRouter call returns and surfaces **token usage + finish reason + estimated
  cost** in a compact Polish post-run readout; a `finish_reason: 'length'` truncation is
  reported explicitly rather than silently routed to the paste-fix path.
- The editor can run the existing single call against a **strong long-context model** and
  compare quality/cost against the current model on the real ~700-segment transcript — with
  a recorded verdict (the gate).
- **If the gate opens** (strong single-shot still degrades): the editor can run a
  **two-stage cluster → curate pipeline** driven by two separately-chosen OpenRouter models
  (one Keychain key), with per-bucket progress + retry, partial-failure recovery, abort
  across stages, an auto-collapse-to-single-shot threshold with manual override, and
  per-stage/per-bucket disk-cache reuse. Stage-2 output stays **byte-identical to S-01** so
  no exporter or `.reelproj` consumer changes.
- Input cost is cut via a minified Stage-1 prompt (~50% input reduction) and
  `cache_control: ephemeral` on the stable transcript prefix (a no-op on providers that
  ignore it).

**Verification:** `node --experimental-vm-modules test/regression.js` stays green
throughout (exporter inputs must not shift); the cost panel shows non-zero usage after a
real run; with the pipeline enabled on the real transcript, a single failed bucket retries
without re-paying Stage 1 or the other buckets.

### Key Discoveries:

- Single convergence tail at `step2-prompt-panel.js:146-159` is the safety net — do all
  fan-out (cluster + per-bucket curate) **before** the validate/assign/sort/emit tail so
  exporters and the reel list never see intermediate state (research §A, Architecture
  Insights).
- `validateReels` requires `reel_name` + ids-in-`sentences`, so the Stage-1 cluster shape
  `{themes:[{title, candidate_ids[]}]}` needs its **own lightweight validator** that drops
  hallucinated ids (research §C; roadmap Unknown "ID integrity").
- The cache key already hashes `{provider, model, prompt}` — adding `{stage, v}` to that
  object gives per-stage/per-bucket reuse with **zero Rust change** (research §E).
- S-17 dropped multi-*provider* support but does **not** constrain multi-*model* tiering —
  both stages call the same `callOpenRouter` with one OpenRouter key (research §D, Historical
  Context).
- On a **cache hit** there is no fresh `usage` to report — the readout must mark cached
  results as "z pamięci podręcznej" rather than show zero/fabricated cost.

## What We're NOT Doing

- **Not** building the cluster → curate pipeline as a settled requirement justified by
  output truncation — it is **gated** on the Phase-2 evidence test.
- **Not** the optional Stage-3 global polish pass (roadmap leaves it off by default) — out
  of scope this slice.
- **Not** exposing theme count / candidates-per-bucket as user settings — fixed sensible
  defaults (~10 themes × ~25 candidate IDs) this slice.
- **Not** adding a second Keychain key / split billing — two model pickers share one
  OpenRouter account key.
- **Not** changing the Stage-2 / S-01 scored schema, any exporter, or the `.reelproj`
  format. **Not** changing parser/frame-math.
- **Not** adding Rust cache namespacing — versioning rides in the hashed key
  (`{stage, v}`); `clear_llm_cache` stays whole-dir.

## Implementation Approach

Grow the single most-touched primitive (`callOpenRouter`) incrementally: Phase 1 makes it
return usage/finish_reason; Phase 5 lets it accept message-blocks with `cache_control`.
Keep `withLlmCache`'s shape — change only the *keys* fed to it. Preserve the single
convergence tail as the only place `state.reelsData` is written. Phases 1–2 ship and
de-risk the change; Phases 3–5 are **gated** on the Phase-2 verdict but planned in full so
they're ready to implement when the gate opens.

## Critical Implementation Details

- **Cache value shape change (Phase 1).** `withLlmCache` today caches the raw response
  string. Once callers need `usage`/`finish_reason`, a cache *hit* has no fresh usage. Do
  **not** widen the on-disk cache format; instead have `withLlmCache` keep returning the raw
  content string and let callers treat `fromCache === true` as "usage unavailable — show
  cached badge". This avoids a backend cache-format migration.
- **Both ingest paths (Phases 1, 4).** `runAIAnalysis()` and `applyPastedJSON()` both end in
  validate → assign → `sortReels` → `emit`. The cost readout (Phase 1) attaches to the run
  path only; the convergence refactor (Phase 4) must not break the paste path.
- **Cache-key determinism (Phase 4).** Per-bucket curate prompts must be built from a
  **stable sort** of candidate ids or the hashes drift between runs and cache reuse breaks
  (research §E).
- **Abort across stages (Phase 4).** The shared `AbortController` must cancel an in-flight
  stage; completed buckets stay committed (partial-success), distinct from today's
  treat-any-abort-as-full-cancel at `:161-167`.

## Phase 1: Instrumentation & cost readout

### Overview

Make every OpenRouter call observable: capture `usage` + `finish_reason`, surface a compact
Polish post-run cost/usage panel, and detect truncation explicitly. Ships independently —
no gate, immediate value, and a prerequisite for the Phase-2 measurement and the
auto-collapse threshold.

### Changes Required:

#### 1. `callOpenRouter` returns usage + finish_reason

**File**: `src/ai/providers.js`

**Intent**: Stop discarding `data.usage` and `data.choices[0].finish_reason`. Return them
alongside the content so callers can show cost and detect truncation.

**Contract**: Change the return from `Promise<string>` to
`Promise<{ content: string, usage: object|null, finishReason: string|null }>`.
`usage` is `data.usage` verbatim (includes `prompt_tokens`, `completion_tokens`, and
`prompt_tokens_details.cached_tokens` when present). Update the JSDoc. **This is a signature
change — update the single call site** (`step2-prompt-panel.js:131`, the run path;
`downloadPromptTXT`/`copyPromptMD` build the prompt but don't call `callOpenRouter`).

#### 2. `withLlmCache` passes through the richer call result

**File**: `src/ai/cache.js`

**Intent**: Let the wrapper carry whatever `callFn` returns (now an object) without changing
the on-disk format. The cache continues to store **only the content string**.

**Contract**: `callFn` now returns `{content, usage, finishReason}`. On a **miss**, save
`result.content` to disk and return `{ result, fromCache:false, hashShort }`. On a **hit**,
reconstruct `{ content: cached, usage:null, finishReason:'cached' }` so callers get a uniform
shape. `result` is the object, not the bare string — update the run-path destructuring at
`step2-prompt-panel.js:126-132` accordingly.

#### 3. Truncation detection on the run path

**File**: `src/ui/step2-prompt-panel.js`

**Intent**: When `finishReason === 'length'`, log an explicit Polish truncation warning
before the JSON parse (which would otherwise fail opaquely and dump into paste-fix).

**Contract**: After the call resolves (around `:143`), if `finishReason === 'length'`, emit
`log('Odpowiedź ucięta przez limit tokenów (finish_reason=length).', 'err')`. Parsing still
proceeds; the existing FR-018 paste-fix remains the recovery path.

#### 4. Cost/usage readout panel

**File**: `src/ui/step2-prompt-panel.js` (+ markup in `src/index.html`, styles as needed)

**Intent**: After a run, show a compact Polish readout: prompt tokens (and cached tokens
when present), completion tokens, and an estimated cost. On a cache hit, show a "z pamięci
podręcznej" badge instead of fabricated numbers.

**Contract**: A new `#usageBox` (or reuse the `#progressBox` footer) rendered by a small
`renderUsage(usage, model)` helper. Estimated cost = `prompt_tokens × pricing.prompt +
completion_tokens × pricing.completion`, reading `pricing` from the selected model object in
`state.orAllModels` (fields already fetched by `openrouter-picker.js`). All strings Polish.
No persistence — display only.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- No remaining references to the old string return of `callOpenRouter`:
  `grep -rn "callOpenRouter" src/` shows only the new object-shape call sites

#### Manual Verification:

- A real OpenRouter run shows non-zero prompt/completion tokens and an estimated cost in the
  panel
- A cache-hit run shows the "z pamięci podręcznej" badge, not zero-cost numbers
- Forcing a tiny `max_tokens` (temporary) produces an explicit truncation log line

**Implementation Note**: After this phase and all automated verification passes, pause for
human confirmation of the manual testing before proceeding.

---

## Phase 2: Strong-model single-shot A/B (evidence gate)

### Overview

The decisive measurement. Run the **existing single call** on the real ~700-segment
transcript against (a) the current model and (b) a strong long-context model, compare via the
Phase-1 instrument plus a manual quality review, and record the verdict that gates Phases
3–5. Minimal code — the value is the decision.

### Changes Required:

#### 1. Make the strong-model comparison runnable

**File**: `src/ui/step2-prompt-panel.js` / settings (`openrouter-picker.js` reuse)

**Intent**: Let the user switch `state.orSelectedModel` to a strong long-context model and
re-run the existing single call, reading the Phase-1 cost panel for the cost side. No new
pipeline — this uses the current single-shot path as-is.

**Contract**: No new orchestration. If anything, a convenience: ensure the cost panel
includes the model id so two consecutive runs (current vs strong) are comparable in the
log. The disk cache already keys on `model`, so the two runs cache independently.

#### 2. Record the gate verdict

**File**: `context/changes/cost-optimized-ai-analysis/change.md` (Notes) and this plan's
Progress section

**Intent**: Capture the outcome: does a strong single-shot model produce
forgotten/mis-ordered reels? If **yes** → Phases 3–5 are justified. If **no** → the slice
may collapse to "model tiering + cost levers" and the pipeline phases are skipped.

**Contract**: A short written verdict (model tested, observed quality, cost delta vs current)
in `change.md` Notes. This is the explicit decision the frame mandates before building the
pipeline.

### Success Criteria:

#### Automated Verification:

- Regression suite still green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- Two runs (current model, strong long-context model) completed on the real ~700-segment
  transcript with cost panels captured
- Quality of both reel sets reviewed by the human against the "forgets half / mixes order"
  symptom
- A written gate verdict recorded in `change.md` Notes (proceed to Phase 3, or collapse the
  slice)

**Implementation Note**: This phase **ends in a human decision**. The verdict routes to ONE
of two branches — Phase 2a (gate **closed**) or Phases 3–5 (gate **open**). Do not start
either branch until the verdict is recorded and the human confirms which one.

---

## Phase 2a: Single-shot cost levers

### Overview

**Branch: gate CLOSED. Reached only if the Phase-2 verdict CLOSES the gate** — a strong long-context single-shot
model fixes curation quality, so the cluster → curate pipeline (Phases 3–4) is **not built**.
This branch keeps the single-shot path and applies just the cost levers that make sense
without a pipeline. It is the gate-closed end state; **Phases 3–5 are skipped entirely** in
this branch.

### Changes Required:

#### 1. Minified single-shot segment projection

**File**: `src/ai/prompt.js`

**Intent**: Cut single-shot input cost by dropping pretty-print and export-only fields the
LLM doesn't need for selection.

**Contract**: Reuse the Phase-5 minification idea on the **single-shot** `buildPrompt` path —
serialize the `{id, text}` projection without the 2-space indent. Verify the existing scored
schema still comes back unchanged (regression suite + a real run). This is Phase 5 #1's
technique pointed at `buildPrompt` instead of the (non-existent) cluster prompt.

#### 2. `cache_control` on the single-shot transcript prefix

**File**: `src/ai/providers.js`

**Intent**: Bill the stable transcript prefix at the cached rate across single-shot re-runs.

**Contract**: Same as Phase 5 #2 — `callOpenRouter` accepts message-blocks so a
`cache_control: {type:'ephemeral'}` marker sits on the transcript prefix; no-op on providers
that ignore it. `cached_tokens` surfaces via the Phase-1 readout.

### Success Criteria:

#### Automated Verification:

- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- Single-shot prompt token estimate materially lower after minification

#### Manual Verification:

- A real single-shot run on a cache-honouring provider shows non-zero `cached_tokens`
- Scored output (and exports) unchanged after minification

**Implementation Note**: This branch terminates the slice. Do not proceed to Phases 3–5.

---

## Phase 3: Model tiering plumbing

### Overview

**Gated on the Phase-2 verdict.** Introduce the two-model configuration (cluster + curate)
and the split cluster/curate prompts, without yet changing orchestration. After this phase the single-shot call still
works (using the curate model); the pipeline lands in Phase 4.

### Changes Required:

#### 1. Two-model state

**File**: `src/state.js`

**Intent**: Hold a cluster model and a curate model instead of one scalar.

**Contract**: Add `aiModels: { cluster: null, curate: null }` beside `orSelectedModel`
(keep `orSelectedModel` as the single-shot / legacy model and the Phase-2 test model).
Persist both to `localStorage` (mirror `edl_or_model`, e.g. `edl_or_model_cluster` /
`edl_or_model_curate`). **Not** added to `.reelproj` (model is machine-global, per research
§D). Add a JSDoc note; no new typedef required for the scalar pair.

#### 2. Second model picker in settings

**File**: `src/ui/settings-modal.js`, `src/ai/openrouter-picker.js`, `src/index.html`

**Intent**: Mount a second `openrouter-picker` instance — *"Model klastrowania (tani, długi
kontekst)"* (Stage 1) and *"Model kuracji (jakość)"* (Stage 2).

**Contract**: This is the **bulk of Phase 3** — `openrouter-picker.js` is a singleton today
(see Current State Analysis), so generalize it before a second instance is possible:

- Refactor the module to take a per-mount **config object** —
  `{ searchId, dropdownId, badgeId, loadBtnId, searchWrapId, stateKey, lsKey }` — instead of
  the hard-coded ids/keys. `init(config)` wires listeners against `config.*` ids; `selectOrModel`/
  `filterOrModels`/`renderOrDropdown`/`closeOrDropdown`/`updateOrBadge` all read from the passed
  config rather than literals.
- Make the **selected-item highlight per-instance**: `m.id === state[config.stateKey]` instead of
  the literal `state.orSelectedModel` (`:97`).
- Keep `state.orAllModels` and the model-list cache (`edl_or_models_cache`) **shared** across both
  mounts — only the *selection* (state field + localStorage key) differs per picker.
- Add the second mount's markup to `src/index.html` (duplicate the `#orModelWrap` block —
  `orModelSearch`, `orDropdown`, `orSelectedBadge`, `orSearchWrap`, `orLoadBtn` — under new ids,
  e.g. an `_cluster`/`_curate` suffix) and mount both from `settings-modal.js`.

Two labelled picker rows in the settings modal, both revealed alongside the existing
`#orModelWrap`. Polish labels. **Regression risk**: the existing single-shot picker must keep
behaving identically after the generalization (it becomes the `orSelectedModel`-configured mount).

#### 3. Split cluster/curate prompt presets

**File**: `src/ai/prompt.js`, `src/state.js`, settings UI

**Intent**: The editable system/user prompt splits into a **cluster prompt** (must elicit
`{themes:[{title, candidate_ids[]}]}`) and a **curate prompt** (must elicit the existing
scored schema). Provide Polish starter defaults for each.

**Contract**: New `buildClusterPrompt(...)` and `buildCuratePrompt(...)` builders (the
existing `buildPrompt` stays for the single-shot/legacy path). New default constants beside
`DEFAULT_SCORING_GUIDANCE`. The cluster prompt's `RESPONSE_FORMAT` example shows the themes
shape; the curate prompt reuses the existing scored `RESPONSE_FORMAT`. Wire the editable
fields into state + settings persistence following the existing `systemPrompt` pattern.

### Success Criteria:

#### Automated Verification:

- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- `grep -rn "orSelectedModel" src/` confirms the single-shot path still reads it; new picker
  reads `aiModels.*`

#### Manual Verification:

- Both model pickers appear in settings, load models, and persist their selections across an
  app restart
- The single-shot analysis still runs unchanged using the curate (or legacy) model
- Cluster and curate prompt fields are editable and seed sensible Polish defaults

**Implementation Note**: Pause for human confirmation after automated verification.

---

## Phase 4: Cluster → curate pipeline

### Overview

**Gated on the Phase-2 verdict.** The core re-architecture: Stage 1 clusters all segments into themes; Stage 2 curates each
theme bucket into a final scored reel; results fan in through the single existing convergence
tail. Includes the new Stage-1 validator, per-stage/per-bucket cache fan-out, per-bucket
progress + retry, partial-failure recovery, abort across stages, and the auto-collapse
threshold with manual override.

### Changes Required:

#### 1. Stage-1 cluster schema validator

**File**: `src/ai/validate.js` (new export) — keep `validateReels` untouched

**Intent**: Validate the Stage-1 `{themes:[{title, candidate_ids[]}]}` shape and **drop
hallucinated ids** against the real segment set before buckets are built.

**Contract**: New `validateThemes(parsed, sentences)`: require `themes` non-empty array; each
theme needs a non-empty `title` and an array `candidate_ids`; filter each `candidate_ids` to
integers present in `state.sentences` ids (drop unknowns, don't throw on a stray id); drop a
theme that ends up with zero valid ids. Polish error messages for structural failures. Do
**not** reuse `validateReels` (it requires `reel_name` and would reject raw clusters).

#### 2. Stage-1 cluster call

**File**: `src/ui/step2-prompt-panel.js`

**Intent**: Replace the single call (when the pipeline is active) with a clustering call:
`buildClusterPrompt` → cached `callOpenRouter` (cluster model) → `validateThemes` → build
buckets of `{title, candidate_ids[]}` using fixed defaults (~10 themes × ~25 ids).

**Contract**: Cache key = `{provider:'openrouter', model:clusterModel, prompt:clusterPrompt,
stage:'cluster', v:1}`. Buckets built from a **stable-sorted** id list.

**Coverage instrument**: The fixed defaults (~10 themes × ~25 ids ≈ 250) can leave most of a
~700-segment transcript unclustered — a silent recall risk against the very quality dimension
this slice targets. After `validateThemes`, log the coverage explicitly:
`log('Sklastrowano X / N segmentów w K tematach.', ...)` where X = count of distinct ids
across all buckets, N = `state.sentences.length`. If `X / N` falls below a named threshold
(initial guess ~0.5), log a Polish **warning** so under-coverage is visible, not silent.
Display only — no behavior change; this feeds the Phase-2-style quality judgement on the
pipeline.

#### 3. Stage-2 per-bucket curate loop

**File**: `src/ui/step2-prompt-panel.js`

**Intent**: For each bucket, send only that bucket's small candidate set to the curate model
and collect the returned `Reel` objects; concatenate into the array assigned at the
convergence tail.

**Contract**: Per-bucket cache key = `{provider, model:curateModel, prompt:bucketPrompt_i,
stage:'curate', v:1}`. Each bucket's result runs through `validateReels` (unchanged) before
being added. Fan-out completes **before** the single `state.reelsData = parsed` →
`sortReels` → `emit` tail (`:151-159`), which stays the only write point. `applyPastedJSON`
is untouched.

#### 4. Per-bucket progress + retry, partial-failure

**File**: `src/ui/step2-prompt-panel.js`, `src/index.html`

**Intent**: Replace the 3-step `setPS` indicator with a staged readout: Stage 1 →
"znaleziono K tematów" → per-bucket ticks. On a bucket failure, keep the successful buckets
and surface a per-bucket **retry** affordance; the run commits whatever validated.

**Contract**: Reuse the `log()` box for per-bucket lines; a per-bucket status list with a
retry button per failed bucket. A failed bucket re-issues only its own
`withLlmCache`/`callOpenRouter`. Successful buckets persist into `state.reelsData` even if
some failed. All strings Polish.

#### 5. Abort across stages

**File**: `src/ui/step2-prompt-panel.js`

**Intent**: The shared `AbortController` cancels the in-flight stage; already-completed
buckets stay committed (partial-success), unlike today's full clean cancel.

**Contract**: Thread `controller.signal` into every stage/bucket call. On abort mid-Stage-2,
commit completed buckets through the convergence tail and log the partial cancel; do not wipe
`state.reelsData`.

#### 6. Auto-collapse threshold + manual override

**File**: `src/ui/step2-prompt-panel.js`, `src/ui/settings-modal.js`, `src/state.js`

**Intent**: Below a segment-count threshold, auto-run the legacy single-shot call so small
jobs don't pay two-call overhead; let the user force single-shot vs pipeline.

**Contract**: A named constant (initial guess ~150 segments — refine from Phase-1 usage
data) + a settings toggle (`state.aiPipelineMode: 'auto' | 'single' | 'pipeline'`, persisted
to localStorage). `runAIAnalysis` branches on mode + `state.sentences.length`.

### Success Criteria:

#### Automated Verification:

- Regression suite passes (exporter inputs unchanged):
  `node --experimental-vm-modules test/regression.js`
- `grep -rn "reel_name\|clip_ids\|virality_score\|markers" src/exporters/` confirms no
  exporter field consumer changed (Stage-2 schema byte-identical)
- Rust type-check passes (no backend change expected):
  `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`

#### Manual Verification:

- Pipeline run on the real ~700-segment transcript produces a valid `Reel[]`; exports
  (EDL/XML/Lua/FCPXML) open correctly in the target NLE
- A deliberately failed bucket (e.g. bad curate prompt) retries successfully **without**
  re-running Stage 1 or the other buckets (cache hit logged)
- Aborting mid-Stage-2 keeps the already-completed reels
- Below-threshold transcript auto-runs single-shot; the manual override forces the other mode
- Stage-1 output with an injected fake id has that id dropped, not passed to Stage 2
- The run logs segment coverage (`X / N` clustered) and warns when the ratio is below threshold

**Implementation Note**: Pause for human confirmation after automated verification.

---

## Phase 5: Cost levers (parallel track)

### Overview

Layer the two input-cost optimizations onto the pipeline: a minified Stage-1 prompt (~50%
input reduction) and `cache_control: ephemeral` on the stable transcript prefix so the
segment list is billed at the cached rate across Stage-1 re-runs and bucket calls.

### Changes Required:

#### 1. Minified Stage-1 segment serialization

**File**: `src/ai/prompt.js`

**Intent**: For the cluster prompt only, drop pretty-print and the export-only fields
(timecodes, `duration_frames`) that thematic clustering doesn't need.

**Contract**: A Stage-1 segment projection of `{id, text}` serialized **without** the
2-space indent (`JSON.stringify` no spacer) → ~30–40 tokens/segment vs ~70–80. The
single-shot and Stage-2 paths keep the full `formatSentence` projection. Verify the cluster
prompt still elicits the themes shape after the trim.

#### 2. `cache_control` message-blocks in `callOpenRouter`

**File**: `src/ai/providers.js`

**Intent**: Allow the caller to pass message content as blocks so a `cache_control:
{type:'ephemeral'}` marker can sit on the large stable transcript prefix; OpenRouter passes
it to providers that honour it (Anthropic/Gemini 2.5/Qwen) and ignores it elsewhere.

**Contract**: Accept an optional structured-messages form (or a `cacheControl` flag that
wraps the transcript prefix as a cached block) in addition to the current string-prompt
form. The cached-token count already surfaces via the Phase-1 usage readout
(`prompt_tokens_details.cached_tokens`). No error path when the provider ignores it.

### Success Criteria:

#### Automated Verification:

- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- Stage-1 prompt token estimate is materially lower than the full projection (manual token
  count or logged char-length delta)

#### Manual Verification:

- A pipeline run on a cache-honouring provider shows non-zero `cached_tokens` in the cost
  panel on the second+ bucket
- On a non-supporting provider, the run still succeeds (cache_control ignored, no error)
- Cluster quality (themes returned) is unchanged after minification

**Implementation Note**: Pause for human confirmation after automated verification.

---

## Testing Strategy

### Unit / regression Tests:

- `test/regression.js` must stay green at every phase — it is the only guard that
  exporter/parser/frame-math behavior is unchanged. The Stage-2 schema is byte-identical to
  S-01, so no new exporter cases are needed unless an exporter input shifts.
- If `validateThemes` warrants coverage, add a focused case following the existing
  `test/regression.js` structure (valid themes, hallucinated-id dropping, empty-theme
  drop) — do not introduce a new test framework.

### Integration Tests:

- End-to-end pipeline run on the real ~700-segment transcript → export → open in NLE.
- Bucket-failure → retry path (cache reuse verified via the "z pamięci podręcznej" log).
- Abort mid-stage → partial commit.

### Manual Testing Steps:

1. Phase 1: run analysis, read cost panel; force truncation to see the explicit log.
2. Phase 2: run current vs strong model; record the gate verdict.
3. Phase 3: confirm both pickers persist; single-shot still works.
4. Phase 4: full pipeline + retry + abort + threshold override + hallucinated-id drop.
5. Phase 5: confirm `cached_tokens` appear on a supporting provider; non-supporting provider
   still succeeds.

## Performance Considerations

- Input dominates cost (~52k tokens single-shot). The architecture win — don't re-send the
  whole transcript per bucket; minify Stage-1; cache the prefix — matters more than output.
- Per-bucket cache reuse means re-running one bucket (or only Stage 2) doesn't re-pay the
  rest, provided bucket prompts are built from a stable id sort.

## Migration Notes

- No `.reelproj` schema change (model + pipeline settings are machine-global localStorage).
- No backend/Rust change; the disk cache format is unchanged (content-string only;
  versioning rides in the hashed key via `{stage, v}`).
- Bumping the in-key `v` orphans old cache entries until a manual `clear_llm_cache` — accept
  that (no selective disk purge this slice).

## References

- Frame brief: `context/changes/cost-optimized-ai-analysis/frame.md`
- Research: `context/changes/cost-optimized-ai-analysis/research.md`
- Roadmap spec: `context/foundation/roadmap.md:428-463` (S-25)
- Single-call pipeline: `src/ui/step2-prompt-panel.js:68-187`
- Schema gate: `src/ai/validate.js:19-109`; `Reel` typedef `src/state.js:40-48`
- Cache: `src/ai/cache.js:13-48`, `src-tauri/src/project.rs:33-53`
- Provider call: `src/ai/providers.js:9-43`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Instrumentation & cost readout

#### Automated

- [x] 1.1 Rust type-check passes: `cargo check` — b755d52
- [x] 1.2 Regression suite passes: `node --experimental-vm-modules test/regression.js` — b755d52
- [x] 1.3 No remaining references to the old string return of `callOpenRouter` — b755d52

#### Manual

- [x] 1.4 Real run shows non-zero tokens + estimated cost in the panel — b755d52
- [x] 1.5 Cache-hit run shows the "z pamięci podręcznej" badge — b755d52
- [x] 1.6 Forced tiny `max_tokens` produces an explicit truncation log line — b755d52

### Phase 2: Strong-model single-shot A/B (evidence gate)

#### Automated

- [x] 2.1 Regression suite still green — 3b0f046

#### Manual

- [x] 2.2 Two runs (current + strong long-context model) completed with cost panels captured — 3b0f046
- [x] 2.3 Both reel sets reviewed against the "forgets half / mixes order" symptom — 3b0f046
- [x] 2.4 Written gate verdict recorded in `change.md` Notes — 3b0f046

### Phase 2a: Single-shot cost levers

> Branch: gate CLOSED. Mutually exclusive with Phases 3–5.

#### Automated

- [ ] 2a.1 Regression suite passes
- [ ] 2a.2 Single-shot prompt token estimate materially lower after minification

#### Manual

- [ ] 2a.3 Real single-shot run on a cache-honouring provider shows non-zero `cached_tokens`
- [ ] 2a.4 Scored output and exports unchanged after minification

### Phase 3: Model tiering plumbing

#### Automated

- [x] 3.1 Regression suite passes
- [x] 3.2 `grep` confirms single-shot reads `orSelectedModel`, new picker reads `aiModels.*`

#### Manual

- [ ] 3.3 Both model pickers appear, load models, persist across restart
- [ ] 3.4 Single-shot analysis still runs unchanged
- [ ] 3.5 Cluster/curate prompt fields editable with Polish defaults

### Phase 4: Cluster → curate pipeline

#### Automated

- [ ] 4.1 Regression suite passes (exporter inputs unchanged)
- [ ] 4.2 `grep` confirms no exporter field consumer changed
- [ ] 4.3 Rust type-check passes

#### Manual

- [ ] 4.4 Pipeline run produces valid `Reel[]`; exports open in the target NLE
- [ ] 4.5 Failed bucket retries without re-running Stage 1 or other buckets
- [ ] 4.6 Abort mid-Stage-2 keeps already-completed reels
- [ ] 4.7 Below-threshold auto-runs single-shot; manual override forces the other mode
- [ ] 4.8 Injected fake Stage-1 id is dropped, not passed to Stage 2
- [ ] 4.9 Run logs segment coverage (`X / N` clustered) and warns below threshold

### Phase 5: Cost levers (parallel track)

#### Automated

- [ ] 5.1 Regression suite passes
- [ ] 5.2 Stage-1 prompt token estimate materially lower than full projection

#### Manual

- [ ] 5.3 Supporting provider shows non-zero `cached_tokens` on second+ bucket
- [ ] 5.4 Non-supporting provider still succeeds (cache_control ignored)
- [ ] 5.5 Cluster quality unchanged after minification
