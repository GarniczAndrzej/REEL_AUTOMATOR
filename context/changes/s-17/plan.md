# S-17 Feature Pruning & Cleanup Pass — Implementation Plan

## Overview

A recurring de-bloat pass over the shipped code and the planned backlog. This iteration removes grep-verified dead code (F-01 render-removal tail), de-duplicates the whisper engine loop, **drops the Gemini and Claude AI providers to standardize on OpenRouter** (owner decision), deletes the filler-word feature (per the S-04 rescope decision), corrects materially-wrong CLAUDE.md sections, and parks/rescopes backlog slices. The goal is a leaner codebase whose agent-spec docs match reality — nothing that changes the export pipeline or frame-math.

## Current State Analysis

- **F-01 left a dead command tail.** The render path was deleted but six persistence/preset Tauri commands survive with zero `invoke()` reach (`src-tauri/src/lib.rs:21-26`, impls `src-tauri/src/project.rs:48-115` + `sanitize_name`). Verified: `load_project` (`project.rs:12`) deserializes into a generic `serde_json::Value` and the render commands act on separate files (`render-queue.json`, `presets/*.json`) — so removal has **zero** `.reelproj` back-compat impact.
- **Duplicated logic in two live paths.** The provider dispatch (`callGemini`/`callClaude`/`callOpenRouter`) is duplicated across single-run (`src/ui/step2-prompt-panel.js:137-148`) and batch (`:340-351`) — note the two blocks are *not* uniform: single-run reads globals (`state.currentProvider`/`apiKey`/`orModel`), batch reads a `cfg` object, and both Claude branches ignore `prompt` and rebuild via `buildClaudeContent(...)`. The owner-chosen fix is to drop Gemini+Claude (OpenRouter-only), which removes the branch rather than de-duplicating it. In Rust, `transcribe_video` and `align_transcript` share ~45 near-identical spawn/poll/cancel lines (`whisper.rs:440-484` ≈ `:698-741`) — extract `drive_engine`.
- **Filler feature is shallow.** The only shipped filler code is `src/selection/fillers.js` plus a strike-through render in `renderClipText` (`src/ui/step2-reel-list.js:447-470`, imported via `isFiller` at `:7`). The S-04 FR-023 removal logic (`computeExportSpans`/`expandFillerSpans`) was **never implemented** — only the plan exists (`context/changes/s-04/plan.md`).
- **Dead frontend symbols.** `state.whisperModelPath` (`src/state.js:76`) has 0 reads/0 writes; ~11 functions carry `export` with no cross-module consumer; root `ReelAutomatorAI.html` is byte-identical to `legacy/ReelAutomatorAI.html` (`diff -q` → IDENTICAL) and unreferenced.
- **CLAUDE.md drift.** The Whisper section describes a non-existent PATH `whisper-cli` + `brew` dep + old `whisper-cache/<hash>.{srt,json}` layout (actual: bundled WhisperX sidecar, no brew, `whisper-cache/v2/<hash>.json`); references a deleted `expandSpansWithFillerRemoval`; states `CLAUDE_MODEL = 'claude-opus-4-7'` (code: `claude-opus-4-8`, `src/ai/models.js:2`).
- **Backlog.** Precedent is document-and-park (S-10, S-15 dropped 2026-06-15). Owner decided: drop S-06 + S-14, simplify-scope S-13, rescope S-04.

### Key Discoveries:

- `load_project` is schema-agnostic — render-command removal cannot break old project files (`src-tauri/src/project.rs:12`).
- `delete_model` is registered (`lib.rs:33`, `models.rs:279`) but no UI invokes it — owner chose to complete it, not drop it.
- Only `step2-reel-list.js:7,464` imports anything from `fillers.js` — deleting the whole file has a single, contained call site.

## Desired End State

The render-command tail, dead symbols, filler feature, and root HTML duplicate are gone; the whisper engine loop has one source of truth (`drive_engine`); the AI layer is OpenRouter-only (Gemini/Claude code and the provider `<select>` removed, OpenRouter model picker kept); the model manager has a working delete control; CLAUDE.md accurately describes the WhisperX sidecar, the OpenRouter-only AI layer, and removed symbols; `roadmap.md` reflects the parked/rescoped slices; the `s-04` change folder is deleted (owner will re-plan). The regression suite (`node --experimental-vm-modules test/regression.js`) and `cargo check` are both green, and the step-1/step-2 UI behaves unchanged except for the (intentionally removed) filler strike-through, the removed provider selector, and the (new) model delete control.

## What We're NOT Doing

- **Not splitting `step1-import.js`** — deferred to S-16 (ui-ux-redesign), which rewrites the whole `goStep` shell; splitting now would be thrown away.
- **Not touching the OpenRouter picker** (`src/ai/openrouter-picker.js`) — owner keeps the catalogue UI as-is.
- **Not reworking the reorder/merge/delete segment ops** (`step2-segment-ops.js`, FR-022) — owner will re-plan that under a fresh S-04.
- **Not simplifying S-03** (prompt-presets) — stays full scope.
- **Not changing** any exporter, parser, frame-math, or `.reelproj` schema behavior.

## Implementation Approach

Follow the F-01 removal recipe: grep all consumers first, run the regression fence before and after, keep user-facing strings Polish, and fix CLAUDE.md in the same change. Three independent phases ordered backend → frontend → docs/backlog so each lands behind a green check. Phases 1 and 2 are code (fenced by `cargo check` + regression + manual UI); Phase 3 is documentation/housekeeping only.

## Critical Implementation Details

- **`drive_engine` extraction must preserve cancellation semantics.** The two whisper loops handle a user-cancel path; the shared helper must keep the same cancel-token check and process-kill behavior, or in-flight transcription/alignment can leak a child process. Verify by cancelling a real transcription after extraction.
- **`renderClipText` has a no-`words` fallback** (`step2-reel-list.js:450-453`) that must survive: after removing the `isFiller` branch, both the word-list and the plain-text paths must still truncate at `MAX` and HTML-escape.

## Phase 1: Backend Rust de-bloat

### Overview

Remove the orphaned render-command tail and de-duplicate the whisper engine-driving loop.

### Changes Required:

#### 1. Remove orphaned render-* commands

**File**: `src-tauri/src/project.rs`, `src-tauri/src/lib.rs`

**Intent**: Delete the six F-01-leftover commands that nothing invokes, plus their only helper, and unregister them — pure dead-code removal.

**Contract**: Remove `save_render_queue`, `load_render_queue`, `list_render_presets`, `save_render_preset`, `delete_render_preset`, `load_render_preset` (`project.rs:48-104`) and `sanitize_name` (`project.rs:106-115`); remove the matching entries from the `invoke_handler!`/`generate_handler!` list in `lib.rs:21-26`. Leave `save_project`/`load_project`/`save_text_file`/the LLM-cache commands untouched.

#### 2. Extract shared `drive_engine(...)` helper

**File**: `src-tauri/src/whisper.rs`

**Intent**: Collapse the ~45 near-identical spawn/poll/cancel lines shared by `transcribe_video` and `align_transcript` into one helper, so cancellation logic lives once.

**Contract**: A private `fn drive_engine(...)` (signature carrying the engine args + cancel token the two call sites both need) that both `transcribe_video` (`:440-484`) and `align_transcript` (`:698-741`) call. Must preserve the existing cancel-token check and child-process kill on cancel. No change to the Tauri command signatures or their return shapes.

### Success Criteria:

#### Automated Verification:

- Rust type-checks: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- No lingering references: `grep -rn "render_queue\|render_preset\|sanitize_name" src-tauri/src` returns nothing
- Regression suite green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- A real transcription runs end-to-end and can be cancelled mid-run without leaving a stray child process
- A real word-alignment pass runs end-to-end after the `drive_engine` extraction

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Frontend de-bloat + filler removal

### Overview

Remove dead frontend symbols and the filler feature, drop the Gemini/Claude providers (OpenRouter-only), wire up `delete_model`, and delete the root HTML duplicate.

### Changes Required:

#### 1. Remove dead `whisperModelPath`

**File**: `src/state.js`, `src/ui/step1-import.js`

**Intent**: Delete the unused state field and the two stale comments noting its retirement.

**Contract**: Remove `whisperModelPath` (`state.js:76`) and the explanatory comments at `state.js:76` and `step1-import.js:403`. No reads/writes exist, so no caller changes.

#### 2. Delete the filler feature

**File**: `src/selection/fillers.js` (delete), `src/ui/step2-reel-list.js`

**Intent**: Per the S-04 rescope, remove the filler-word feature entirely — the standalone module and its only consumer (the strike-through preview).

**Contract**: Delete `src/selection/fillers.js`. In `step2-reel-list.js`, remove the `import { isFiller } from '../selection/fillers.js'` (`:7`) and rewrite `renderClipText` (`:448-470`) to render plain escaped text. **Behavior-preserving choice: keep the per-word loop** (`:454-468`) — it truncates at word boundaries via the running `chars` count — and drop only the `isFiller`/`<s>` branch (`:464-466`), emitting `${safe} ` for every word. Keep the `MAX` truncation and the no-`words` fallback (`:450-453`) unchanged.

#### 3. Drop the Gemini + Claude providers — standardize on OpenRouter

**File**: `src/ai/providers.js`, `src/ai/models.js` (delete), `src/ai/prompt.js`, `src/state.js`, `src/main.js`, `src/index.html`, `src/ui/step2-prompt-panel.js`

**Intent**: Owner decision (supersedes the research "keep all three providers" note): use **OpenRouter only**. Removing Gemini and Claude eliminates the duplicated provider-branch entirely — both call sites collapse to a direct `callOpenRouter(...)`, so no dispatcher abstraction is introduced. The OpenRouter **model picker** (`src/ai/openrouter-picker.js`, `orModelWrap`) is **kept** (the provider `<select>` is what's removed).

**Contract**:

- **`src/ai/providers.js`**: delete `callGemini` (`:3`) and `callClaude` (`:28`) and the `import { GEMINI_MODEL, CLAUDE_MODEL }` (`:1`); keep `callOpenRouter` (`:54`). Update the `callClaude`-content doc comment (`:24`).
- **`src/ai/models.js`**: delete the file — its only exports (`GEMINI_MODEL`, `CLAUDE_MODEL`) are now unused; `providers.js` is its sole importer (grep-confirmed) and is changed above. (This also resolves the CLAUDE_MODEL doc-drift — there is no constant left to drift.)
- **`src/ai/prompt.js`**: delete `buildClaudeContent` (`:116`) and its lead-in comment (`:10`); keep `buildPrompt`. Sole consumers are the two Claude branches being removed.
- **`src/state.js`**: remove the `currentProvider: 'gemini'` field (`:58`). The app is single-provider now; reads of `state.currentProvider` are removed (see prompt-panel + main below), not repointed.
- **`src/main.js`**: remove the `modelSelect` provider-switch listener (`:54-71`) — keep only the OpenRouter behavior (apiKey placeholder = OpenRouter, `orModelWrap` always visible). Replace `setApiKey(state.currentProvider, …)` (`:109`) and `getApiKey(state.currentProvider)` (`:114`) with the literal `'openrouter'`.
- **`src/index.html`**: remove the provider `<select id="modelSelect">` (`:24-28`) — the OpenRouter key bar + `orModelWrap` picker stay, now unconditionally shown. In the A/B compare panel, remove the gemini/claude `<option>`s from `compareProviderA` (`:1021-1022`) and `compareProviderB` (`:1061-1062`); see consequence note below.
- **`src/ui/step2-prompt-panel.js`**: drop `callGemini`/`callClaude` from the import (`:8`) and `buildClaudeContent` from the `prompt.js` import (`:6`). Single-run (`:137-148`) → `return callOpenRouter(apiKey, prompt, orModel);`. Batch/A-B (`:340-351`) → `return callOpenRouter(cfg.key, prompt, cfg.model);`. Remove the now-dead provider-branch logging/guards (`:84`, `:112-124`, `:128`) — the `=== 'openrouter'` conditionals become unconditional; the cache-key `provider` field is hardcoded `'openrouter'`.

**Consequence to note**: the A/B compare feature ("Dostawca A/B") becomes **model-vs-model on OpenRouter** rather than provider-vs-provider. The `compareProviderA/B` `<select>`s degenerate to a single OpenRouter option — acceptable for now (the `compareModelA/B` inputs remain the differentiators); leave the selects in place (single-option) unless trivially removable without disturbing the compare wiring.

**Dead-key note**: `edl_apikey_gemini` / `edl_apikey_claude` in `localStorage` become orphaned — harmless, no code reads them after this; no cleanup required.

#### 4. Wire a delete control for `delete_model`

**File**: `src/ui/step1-import.js` (model-manager section)

**Intent**: Add a per-model delete button so the registered `delete_model` command earns its keep; reclaim disk from unused models.

**Contract**: A delete affordance in the model-manager list that `invoke`s `delete_model` with the model identifier, guarded by a Polish confirm dialog, and refreshes the model list on success. Reuse the existing model-list render path; surface errors the same way other model-manager actions do. All new strings Polish.

#### 5. Un-export internal-only helpers

**File**: `src/ui/step2-reel-list.js`, `src/ui/step2-prompt-panel.js`, `src/ui/step2-segment-ops.js`

**Intent**: Drop the `export` keyword from functions with zero cross-module consumers — API tidy, no behavior change.

**Contract**: Un-export `updateGapColors` (`step2-reel-list.js:112`), `drawAllTimelines` (`:135`), `scheduleWaveformLoad` (`:407`), `renderClipText` (`:448`); `setPS` (`step2-prompt-panel.js:465`), `logClear` (`:469`); `setFocusedClip` (`step2-segment-ops.js:68`), `moveClip` (`:86`), `removeClip` (`:104`), `mergeWithNext` (`:112`), `applyTrim` (`:133`). Verify each has no importer before un-exporting.

#### 6. Delete root HTML duplicate

**File**: `ReelAutomatorAI.html` (delete)

**Intent**: Remove the byte-identical, unreferenced root copy; `legacy/ReelAutomatorAI.html` remains as the reference prototype.

**Contract**: `rm ReelAutomatorAI.html`. Confirm `legacy/ReelAutomatorAI.html` is unchanged and nothing in `src/` or build config references the root path.

### Success Criteria:

#### Automated Verification:

- No dead references: `grep -rn "whisperModelPath\|fillers\|isFiller" src --include="*.js"` returns nothing
- Providers removed: `grep -rn "callGemini\|callClaude\|buildClaudeContent\|GEMINI_MODEL\|CLAUDE_MODEL\|currentProvider" src --include="*.js" --include="*.html"` returns nothing; `test ! -f src/ai/models.js`
- Un-export safety: each un-exported name has no importer (`grep -rn "<name>" src --include="*.js"` shows only its own file)
- Root duplicate gone: `test ! -f ReelAutomatorAI.html`
- Regression suite green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- Step-2 reel list renders clip text correctly with no strike-through and no console errors (word and no-`words` segments)
- AI analysis works on both the single-run and the A/B compare paths via OpenRouter (no provider `<select>`; the OpenRouter model picker selects the model); the A/B compare runs two OpenRouter models
- Model manager: deleting a model removes it from disk and refreshes the list; Polish confirm dialog shows
- No regressions in step-1 import / project save-load

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 3: Docs + backlog housekeeping

### Overview

Correct CLAUDE.md to match reality, update the roadmap for the parked/rescoped slices, and delete the superseded s-04 change folder. Documentation/housekeeping only — no code.

### Changes Required:

#### 1. Fix CLAUDE.md drift

**File**: `CLAUDE.md`

**Intent**: Bring the agent spec back in line with the code after this change and the prior WhisperX/F-01 work.

**Contract**: Rewrite the Whisper section to describe the bundled WhisperX sidecar (`engine.rs`) — not a PATH `whisper-cli`, no `brew install whisper-cpp` — and the `whisper-cache/v2/<hash>.json` layout with the legacy `.srt` read-fallback. Remove the stale `expandSpansWithFillerRemoval` reference and the `src/selection/fillers.js` description (file now deleted). Update the `src/selection/` listing to reflect the remaining files (`timeline.js`, `waveform.js`). **Rewrite the "AI providers" section** to OpenRouter-only: drop `callGemini`/`callClaude`, the `callClaude` → `api.anthropic.com` note, and the `src/ai/models.js` (`GEMINI_MODEL`/`CLAUDE_MODEL`) description (file deleted); describe `callOpenRouter` + the kept OpenRouter model picker; update the `localStorage` API-key note (only `edl_apikey_openrouter` is live). Remove the `CLAUDE_MODEL = 'claude-opus-4-7'` line entirely (no provider-model constants remain).

#### 2. Update roadmap.md — park/rescope slices

**File**: `context/foundation/roadmap.md`

**Intent**: Record the owner's backlog decisions following the document-and-park precedent.

**Contract**:
- **Drop S-06 and S-14**: remove their `### S-06`/`### S-14` slice bodies and "At a glance" rows (`:41`, `:48`) and Backlog Handoff rows (`:341`, `:348`); add a Parked entry for each with a one-line rationale + date 2026-06-15 (S-06: reorder/merge/delete is enough, fine-grained micro-opt; S-14: north-star provable without scoring polish).
- **Simplify S-13**: add a note to the `### S-13` body that scope is core hotkeys only, deferring word-level nudges (which depended on dropped S-06); keep the slice proposed.
- **Rescope S-04**: update the `### S-04` body, "At a glance" row (`:39`), and Backlog Handoff row (`:339`) to drop FR-023 filler removal and flag the FR-022 reorder/merge/delete ops for rework (owner re-plans). Note the filler feature was removed in S-17.

#### 3. Delete the s-04 change folder

**File**: `context/changes/s-04/` (delete)

**Intent**: Remove the superseded plan; owner will re-plan S-04 fresh.

**Contract**: `rm -rf context/changes/s-04/`. The folder is untracked (no git history to preserve). Roadmap S-04 entry survives as the backlog pointer (updated above).

### Success Criteria:

#### Automated Verification:

- No stale doc symbols: `grep -n "whisper-cli\|whisper-cpp\|expandSpansWithFillerRemoval\|claude-opus-4-7\|fillers.js\|callGemini\|callClaude\|GEMINI_MODEL\|CLAUDE_MODEL\|api.anthropic.com" CLAUDE.md` returns nothing
- s-04 folder gone: `test ! -d context/changes/s-04`
- Roadmap has no orphaned S-06/S-14 slice bodies: `grep -n "### S-06\|### S-14" context/foundation/roadmap.md` returns nothing

#### Manual Verification:

- CLAUDE.md Whisper section reads accurately against `src-tauri/src/whisper.rs` + `engine.rs`
- roadmap.md "At a glance", "Backlog Handoff", "Parked" sections are internally consistent (no dangling references to dropped slices)

**Implementation Note**: This phase is docs/housekeeping; after automated verification, a quick read-through confirms consistency.

---

## Testing Strategy

### Unit / Regression Tests:

- Run `node --experimental-vm-modules test/regression.js` before Phase 1 (baseline) and after each code phase. This change touches no parser/exporter/frame-math behavior, so no new regression case is required — the suite's role here is to prove the selection → segment → export pipeline is unaffected by the removals.

### Manual Testing Steps:

1. Transcribe a real video, then cancel mid-run — confirm no stray child process (Phase 1 `drive_engine`).
2. Run word alignment on a transcript — confirm output unchanged (Phase 1).
3. Open step 2 — confirm clip text renders without strike-through, no console errors, on both word-aligned and plain-SRT segments (Phase 2).
4. Run AI analysis single-run and via A/B compare — both through OpenRouter (Phase 2 provider removal); confirm no provider `<select>`, the model picker drives the model, and the A/B compare runs two OpenRouter models.
5. Delete a model from the model manager — confirm disk removal + list refresh + Polish confirm (Phase 2).
6. Save and reload a `.reelproj` — confirm load still works after render-command removal (Phase 1/2 back-compat).

## Performance Considerations

None — this is removal/de-duplication; no new hot paths. `drive_engine` is a refactor with identical runtime behavior.

## Migration Notes

No data migration. `load_project` is schema-agnostic; removing the render-queue/preset commands cannot reject any existing `.reelproj` (they read separate sidecar files). No `.reelproj` schema bump.

## References

- Internal research: `context/changes/s-17/research.md`
- F-01 removal recipe: `context/archive/2026-06-10-f-01/plan.md`, `.../reviews/impl-review.md`
- Superseded S-04 plan (to be deleted): `context/changes/s-04/plan.md`
- Key code: `src-tauri/src/project.rs:48-115`, `src-tauri/src/lib.rs:21-26,33`, `src-tauri/src/whisper.rs:440-484,698-741`, `src/selection/fillers.js`, `src/ui/step2-reel-list.js:7,447-470`, `src/ui/step2-prompt-panel.js:137-148,340-351`, `src/state.js:76`, `src/ai/models.js:2`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Backend Rust de-bloat

#### Automated

- [x] 1.1 Rust type-checks (`cargo check`) — cd30361
- [x] 1.2 No lingering render_queue/render_preset/sanitize_name references — cd30361
- [x] 1.3 Regression suite green — cd30361

#### Manual

- [x] 1.4 Transcription runs + cancels cleanly (no stray child process) — cd30361
- [x] 1.5 Word-alignment pass runs end-to-end after `drive_engine` extraction — cd30361

### Phase 2: Frontend de-bloat + filler removal

#### Automated

- [x] 2.1 No dead whisperModelPath/fillers/isFiller references — be0e8c5
- [x] 2.2 Gemini/Claude providers removed (no callGemini/callClaude/buildClaudeContent/GEMINI_MODEL/CLAUDE_MODEL/currentProvider; models.js deleted) — be0e8c5
- [x] 2.3 Un-exported names have no importer — be0e8c5
- [x] 2.4 Root ReelAutomatorAI.html removed — be0e8c5
- [x] 2.5 Regression suite green — be0e8c5

#### Manual

- [x] 2.6 Step-2 clip text renders without strike-through, no console errors (word + no-words) — be0e8c5
- [x] 2.7 AI analysis works single-run + A/B compare via OpenRouter (no provider selector; model picker drives model) — be0e8c5
- [x] 2.8 Model delete control removes from disk + refreshes list + Polish confirm — be0e8c5
- [x] 2.9 No regressions in step-1 import / project save-load — be0e8c5

### Phase 3: Docs + backlog housekeeping

#### Automated

- [x] 3.1 No stale doc symbols in CLAUDE.md — 41391e5
- [x] 3.2 s-04 folder deleted — 41391e5
- [x] 3.3 No orphaned S-06/S-14 slice bodies in roadmap — 41391e5

#### Manual

- [x] 3.4 CLAUDE.md Whisper section accurate against whisper.rs + engine.rs — 41391e5
- [x] 3.5 roadmap.md At-a-glance / Backlog Handoff / Parked internally consistent — 41391e5
