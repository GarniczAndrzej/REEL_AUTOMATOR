---
date: 2026-06-15T09:47:53+0200
researcher: GarniczAndrzej
git_commit: 3dcf25acd3023dcc0c7568c6c3b653162bdae7bc
branch: master
repository: REEL_AUTOMATOR
topic: "S-17 feature pruning & cleanup — complexity/simplify targets across shipped code + planned backlog"
tags: [research, codebase, pruning, cleanup, dead-code, complexity, backlog, s-17]
status: complete
last_updated: 2026-06-15
last_updated_by: GarniczAndrzej
---

# Research: S-17 Feature Pruning & Cleanup — complexity/simplify targets

**Date**: 2026-06-15T09:47:53+0200
**Researcher**: GarniczAndrzej
**Git Commit**: 3dcf25acd3023dcc0c7568c6c3b653162bdae7bc
**Branch**: master
**Repository**: REEL_AUTOMATOR

## Research Question

For roadmap slice S-17 (`feature-pruning-cleanup`) — a recurring de-bloating pass — find concrete pruning candidates across **both** the shipped codebase **and** the planned backlog, focused on **complexity / simplify targets** (features that work but carry heavy maintenance cost, plus orphaned/dead leftovers worth removing). Output feeds `/10x-plan s-17`.

## Summary

The richest, lowest-risk pruning surface is **F-01 render-removal leftovers** that survived the render-path deletion: **6 orphaned Tauri commands + a helper** in the Rust backend (zero frontend `invoke()`), plus several small dead frontend symbols. All high-impact claims below were **directly verified by grep** (not just reported by sub-agents).

Three classes of candidate, ordered by confidence:

1. **High-confidence dead code (remove)** — 6 render-queue/preset Tauri commands + `sanitize_name`, dead state field `whisperModelPath`, unused `POLISH_FILLERS` export, byte-identical duplicate root `ReelAutomatorAI.html`.
2. **Documentation drift (fix)** — `CLAUDE.md` is materially wrong in two places: the entire Whisper section (describes a non-existent `whisper-cli` PATH binary / `brew` dep / old cache layout) and a stale reference to `expandSpansWithFillerRemoval` (function no longer exists). Model name also drifted (`claude-opus-4-7` in docs vs `claude-opus-4-8` in code).
3. **Genuine simplify targets (judgment)** — `step1-import.js` (1122 LOC, never split), OpenRouter model picker (154 LOC catalogue UI vs a plain ID input), duplicated provider-branch + engine spawn/poll/cancel loops, and ~13 over-exported internal helpers.

On the **backlog** side, the established precedent is *document-and-park* (S-10 i18n, S-15 preview dropped 2026-06-15); candidate slices to drop/simplify for a solo personal app: **S-06**, **S-14** (drop), **S-03**, **S-13** (simplify scope). S-04 is mid-plan — treat separately.

## Detailed Findings

### A. Backend / integration complexity (`src-tauri/src/`, `src/ai/`)

#### A1. Orphaned render-* Tauri commands — VERIFIED dead (highest-value removal)
F-01 deleted the render path but left the persistence/preset commands behind. `lib.rs` still registers them; nothing in `src/` invokes them (grep confirmed 0 `invoke()` calls):

- `src-tauri/src/lib.rs:21-26` registers `save_render_queue`, `load_render_queue`, `list_render_presets`, `load_render_preset`, `save_render_preset`, `delete_render_preset`.
- Implementations in `src-tauri/src/project.rs:48-115` (~60 LOC) + `sanitize_name` helper (`project.rs:106`) used only by these.
- **Verdict: remove all 6 + `sanitize_name` + their `lib.rs` registrations.** F-01 leftovers, zero reach into the current app.

#### A2. `delete_model` — near-orphan
- `src-tauri/src/lib.rs:33` registers `models::delete_model` (`models.rs:279`); no frontend invoke wires a delete button.
- **Verdict: wire a delete control into the model manager, or drop it.**

#### A3. Whisper path — no dead path, but docs are wrong
- `src-tauri/src/whisper.rs` (799 LOC, largest backend module) drives a **bundled WhisperX sidecar** (`engine.rs`), NOT a PATH `whisper-cli`. Grep for `whisper-cli` across `src/` + `src-tauri/src/` returns **nothing** — confirmed.
- Cache layout is `whisper-cache/v2/<hash>.json` with a legacy `.srt` read-fallback (`whisper.rs:226-239`, intentional back-compat — keep).
- **Simplify target:** `transcribe_video` and `align_transcript` share ~45 near-identical spawn/poll/cancel lines (`whisper.rs:440-484` ≈ `:698-741`) — extract a shared `drive_engine(...)` helper.

#### A4. Multi-provider AI layer — keep all three, de-dupe the branch
- `src/ai/providers.js` (87 LOC): `callGemini` / `callClaude` / `callOpenRouter`, all reachable via the provider `<select>` (`src/main.js:58`, default in `src/state.js:58`).
- Branch is duplicated across the single-run (`src/ui/step2-prompt-panel.js:137-148`) and batch (`:340-351`) paths.
- **Verdict: keep providers; collapse the two branches into one `callProvider(cfg)` dispatcher.**

#### A5. OpenRouter model picker — simplify candidate
- `src/ai/openrouter-picker.js` (154 LOC, largest AI-layer file): searchable catalogue over `GET /api/v1/models`, `edl_or_models_cache`, 300-item render cap, hand-rolled escaping/lifecycle. One consumer (`src/main.js:5`).
- `callOpenRouter` (`providers.js:54`) already forwards any `org/model` string.
- **Verdict (optional, ~120 LOC saved): replace catalogue dropdown with a plain model-ID text input.** Drops the `/models` fetch + localStorage cache. Trade-off = lose model discovery.

#### A6. Keep as-is (good ROI / core)
- **LLM disk cache** (`src/ai/cache.js`, 48 LOC + `project.rs:26-46`) — best complexity-to-benefit ratio; no change.
- **Waveform** (`src-tauri/src/waveform.rs` + `src/selection/waveform.js`) — live in the clip-trim UI (`step2-reel-list.js:417-434`, `step2-segment-ops.js:127-310`); keep.
- **Exporters** (`src/exporters/edl.js|xml.js|lua.js`) — core north-star; XML fragility is intrinsic to FCP7, guarded by regression tests. Do not prune.

### B. Frontend surface complexity (`src/`)

#### B1. Dead / removable symbols — VERIFIED
- `state.whisperModelPath` (`src/state.js:76`) — **0 reads, 0 writes**; only two comments noting it's retired (`state.js:76`, `step1-import.js:403`). Remove.
- `POLISH_FILLERS` (`src/selection/fillers.js:50`) — exported, **0 importers**, not used internally. Remove the export.
- `ALWAYS_FILLERS` / `CONTEXT_FILLERS` (`fillers.js:2,29`) — used only by `isFiller` in-file; drop the `export` keyword.

#### B2. `step1-import.js` — the complexity outlier
- **1122 LOC, ~76 functions**, ≥6 responsibilities (import/parse, project IO, model manager, transcription, whisper-advanced modal, multi-source F18, transcript export). Public surface is only `init()` (`step1-import.js:11`).
- Step 2 was already split into a 34-LOC orchestrator (`step2-analyze.js`) + 3 surface modules (`step2-prompt-panel.js` 479, `step2-reel-list.js` 470, `step2-segment-ops.js` 430). Step 1 never got the same treatment.
- **Verdict: largest single simplify opportunity** — split into orchestrator + surface modules (e.g. `step1-model-manager.js`, `step1-sources.js`). Low caller risk (only `init()` is public).

#### B3. Over-exported internal helpers (API tidy, no behavior change)
Functions carrying `export` with zero cross-module consumers — un-export:
- `step2-reel-list.js`: `updateGapColors` (:112), `drawAllTimelines` (:135), `scheduleWaveformLoad` (:407), `renderClipText` (:448)
- `step2-prompt-panel.js`: `setPS` (:465), `logClear` (:469)
- `step2-segment-ops.js`: `setFocusedClip` (:68), `moveClip` (:86), `removeClip` (:104), `mergeWithNext` (:112), `applyTrim` (:133)

#### B4. Clean — no action
- No fully-dead modules: every `src/*.js` has ≥1 importer.
- `src/main.js` (134 LOC) `goStep` orchestrator — tight, all-live.
- `src/selection/timeline.js` + `waveform.js` exports all consumed.

#### B5. Legacy prototypes
- `ReelAutomatorAI.html` (root) and `legacy/ReelAutomatorAI.html` are **byte-identical** (`diff -q` → IDENTICAL), neither referenced in `src/`/build config.
- **Verdict: delete the root copy, keep `legacy/`.** Documented as intentional reference, so judgment call.

### C. Documentation drift (CLAUDE.md) — fix alongside any code prune
- `CLAUDE.md` Whisper section: claims `transcribe_video` invokes PATH `whisper-cli` + `brew install whisper-cpp` + `whisper-cache/<hash>.{srt,json}` — **all false** (bundled WhisperX sidecar, no brew, `whisper-cache/v2/<hash>.json`).
- `CLAUDE.md` references `expandSpansWithFillerRemoval` "retained for S-04 (currently no consumer)" — **function does not exist** (grep empty). The note + rationale are stale.
- Model name drift: docs say `CLAUDE_MODEL = 'claude-opus-4-7'`; code is `claude-opus-4-8` (`src/ai/models.js:2`).

### D. Planned-backlog bloat review (`context/foundation/roadmap.md`)

Precedent for backlog pruning is **document-and-park, not code change**: commit `3dcf25a` (2026-06-15) dropped **S-10 (EN/PL i18n)** — app stays Polish-only — and **S-15 (reel preview playback)** — redundant once reels land in Resolve. Both were `proposed` (no code impact).

Solo-app bloat assessment of still-`proposed` slices:

| Slice | Lean verdict | Rationale |
|---|---|---|
| S-06 word-level-boundary-trim | **DROP / defer** | Fine-grained micro-optimization; reorder/merge/delete is enough |
| S-14 selection-quality-flags | **DROP / defer** | Optional scoring polish; north-star provable without it |
| S-03 prompt-presets | **SIMPLIFY** | Ship built-in presets; defer full save/load/import/export (FR-016) |
| S-13 keyboard-navigation | **SIMPLIFY** | Core hotkeys only; defer word-level nudges (depend on S-06) |
| S-09 resolve-plugin-handoff | **REWORK-GATE** | F-02 = `Go-with-rework`; land S-08 file exports first |
| S-16 ui-ux-redesign | **SEQUENCE** | Prereq-free; land early before S-02/S-04/S-08 fill in old shell |
| S-02/S-07/S-08/S-11/S-12, R2 | **KEEP** | Core wedge / orchestration / lightweight enablers |

Note: **S-04** (`segment-tuning-ops`, filler removal FR-023) is an active change with a written plan (`context/changes/s-04/plan.md`); decide its scope separately rather than pruning blind.

## Code References

- `src-tauri/src/lib.rs:21-26,33` — orphaned render-* + `delete_model` registrations
- `src-tauri/src/project.rs:48-115` — orphaned render command impls + `sanitize_name`
- `src-tauri/src/whisper.rs:440-484,698-741` — duplicated spawn/poll/cancel loop
- `src/ai/providers.js:54`, `src/ui/step2-prompt-panel.js:137-148,340-351` — duplicated provider branch
- `src/ai/openrouter-picker.js` — 154-LOC catalogue picker (simplify candidate)
- `src/ai/models.js:2` — `CLAUDE_MODEL = 'claude-opus-4-8'` (docs drift)
- `src/state.js:76` — dead `whisperModelPath`
- `src/selection/fillers.js:2,29,50` — un-export Sets, remove `POLISH_FILLERS`
- `src/ui/step1-import.js` (1122 LOC) — split candidate
- `ReelAutomatorAI.html` vs `legacy/ReelAutomatorAI.html` — identical duplicate
- `context/foundation/roadmap.md:315-326` (S-17 slice), `:358-377` (Parked)

## Architecture Insights

- **F-01 removal left a "dead command tail."** A render *feature* removal pruned the UI/JS but missed backend persistence/preset commands. Pattern lesson: after a feature removal, grep `lib.rs` registrations against `invoke()` to catch surviving commands.
- **Asymmetric refactor debt:** step 2 was modularized (R1), step 1 was not — `step1-import.js` is now the lone 1000+ LOC monolith.
- **Docs-as-contract drift:** CLAUDE.md is the agent spec; two sections describe removed/renamed code. Stale agent docs actively mislead future pruning.

## Historical Context (from prior changes)

The **F-01 removal pattern** is the reusable safety recipe for any shipped-feature prune in S-17:
1. **Grep all consumers first** (`grep -r SYMBOL src/ src-tauri/`); identify load-bearing invariants that must survive (e.g. `mergeThreshold` was top-level, not in `renderConfig`).
2. **Relocate, don't delete, misplaced code** (F-01 moved `fillers.js`/`timeline.js`/`waveform.js` `src/render/` → `src/selection/`).
3. **Regression fence before+after:** `node --experimental-vm-modules test/regression.js` must be green; add a back-compat case when touching parser/exporters/frame-math (F-01 Test 8 for v2 `.reelproj` load).
4. **Update CLAUDE.md in the same change** (F-01 impl-review flagged stale render docs).
5. **Park backlog items with a one-line rationale + date**; archive the change folder via `/10x-archive`.

- `context/archive/2026-06-10-f-01/plan.md` — render-removal scope + regression fence
- `context/archive/2026-06-10-f-01/reviews/impl-review.md` — flagged stale CLAUDE.md + a dead `expandSpansWithFillerRemoval` export (deleted then; the *doc reference* survived — see §C)
- `context/archive/2026-06-10-f-02/decision.md` — S-09 `Go-with-rework` verdict

## Related Research

- `context/changes/s-04/plan.md` — active filler-removal plan (decide S-04 scope before pruning that area)
- No prior `research.md` artifacts under `context/archive/**` for pruning specifically.

## Open Questions

1. **Render-command removal touches `project.rs`** — does any older `.reelproj` rely on a render-queue/preset shape that load would now reject? (Likely no — `project.rs` is schema-agnostic and v3 already dropped render blobs — but confirm before deleting `save/load_render_queue`.)
2. **OpenRouter usage** — does the owner actually use OpenRouter enough to justify the 154-LOC picker, or is plain model-ID input acceptable? (Owner call.)
3. **S-04 scope** — keep FR-023 filler removal as planned, or fold the "simplify" verdict into its plan? (Owner call; S-04 has a live plan.)
4. **`delete_model`** — wire it up or drop it?
