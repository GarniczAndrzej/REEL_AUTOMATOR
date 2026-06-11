# F-02: Resolve plugin runtime spike — Implementation Plan

## Overview

A time-boxed (~1 day) research spike that resolves the project's single largest technical unknown: **is the DaVinci Resolve Workflow Integration runtime viable, and can the existing Tauri frontend be reused inside it?** (PRD Open Question #2; FR-030; US-02.)

The spike produces **no production code**. It ends with a recorded **3-way verdict** — `Go` / `Go-with-rework` / `Park` — written to `context/changes/f-02/decision.md`, and, when the verdict is not `Park`, a **scoped integration contract** that S-09 (`resolve-plugin-handoff`) can plan against. Any code written during the spike is a throwaway smoke-test PoC that is deleted in the final phase.

This slice runs in **Wave 0**, in parallel with F-01 (`remove-render-path`). It is footprint-safe with everything because it touches no source files (streams.md: "no code — writes a decision doc").

## Current State Analysis

- **The plugin runtime is unbuilt and unproven.** FR-030 (run as an embedded Resolve Workflow Integration plugin, one-click create-folder + reels-as-timelines via the Resolve API) is marked `new` and flagged in the PRD as "the largest single technical risk in the build." S-09 is `blocked` until this spike returns a verdict (roadmap; streams.md Wave 4 — "blocked until F-02 returns 'viable'; else parks to S-08 fallback").
- **The frontend is web-native but Tauri-coupled.** `src/` is a Vite + vanilla-JS ES-module app (`src/index.html` → `src/main.js`). The HTML/CSS/JS layer is portable to a webview in principle; the coupling that blocks reuse is the set of `invoke()` calls to the Rust backend.
- **The reuse-relevant `invoke()` surface shrinks after F-01.** Today there are ~19 `invoke()` call sites. Most are render-path commands that **F-01 deletes**: `detect_hw_encoder`, `detect_face_keyframes`, `extract_thumbnail`, `list/load/save/delete_render_preset`, `extract_waveform`, `save/load_render_queue`, `run_render`, `cancel_render`. The **post-F-01 surviving surface** that a reused frontend would still need is small:
  - `load_project` / `save_project` (`src/ui/step1-import.js:288,346`)
  - `transcribe_video` (`src/ui/step1-import.js:517`)
  - `load_llm_cache` / `save_llm_cache` / `clear_llm_cache` (`src/ai/cache.js:26,35,46`)
  - AI provider calls (`callGemini`/`callClaude`/`callOpenRouter` in `src/ai/providers.js`) are **already direct browser `fetch`**, not `invoke()` — they would work in any webview with network access.
- **There is a defined fallback.** If "not viable," S-09 reverts to the S-08 file-export set (EDL / FCPXML / XML / Lua) and is parked. The product still ships; the spike's job is a clean go/park decision, not to make the plugin work.
- **Environment is ready.** The spike runs against **DaVinci Resolve Studio (paid)**, which exposes the full DaVinciResolveScript API without the external-scripting gating that affects the Free edition.

## Desired End State

`context/changes/f-02/decision.md` exists and contains:
1. A **3-way verdict** (`Go` / `Go-with-rework` / `Park`) with explicit rationale tied to the spike findings.
2. Findings on **panel hosting** (does a custom HTML/JS Workflow Integration panel load and reach the Resolve API in Studio?), **API surface** (can it create a folder/bin and a timeline programmatically?), and **packaging/signing**.
3. A **frontend-reuse recommendation** chosen from the three evaluated strategies.
4. **If not `Park`:** a scoped **integration contract** for S-09 — the bridge API the panel needs (mapping each post-F-01 `invoke()` to its Resolve-side replacement), the packaging approach, and the recommended reuse strategy.

Verify by: the file exists, states one of the three verdicts unambiguously, and (unless `Park`) lists a bridge contract S-09 can plan from. All PoC scaffolding is deleted from the working tree.

### Key Discoveries:

- Reuse blocker is the `invoke()` bridge, not the markup — and after F-01 that bridge is only ~6 commands + already-portable `fetch` AI calls (see Current State Analysis for call-site references).
- AI provider calls already bypass Tauri (`src/ai/providers.js`) — one fewer thing the bridge must replace.
- Resolve **Studio** is installed, so the PoC can exercise the real (ungated) API surface.
- S-08 file-export is the committed fallback, so a `Park` verdict is a valid, non-blocking outcome.

## What We're NOT Doing

- **Not building S-09.** No real plugin, no production bridge, no porting of the actual frontend. Only a throwaway "hello panel" smoke test.
- **Not modifying any `src/` or `src-tauri/` source file.** F-02 has zero source footprint by design (streams.md).
- **Not waiting on or coordinating with F-01.** They run in parallel; the plan simply *reads* the post-F-01 surface to scope the contract correctly.
- **Not resolving deep packaging/signing/distribution edge cases.** Within a 1-day box these are documented and risk-flagged, not exhaustively proven.
- **Not building the Free-edition path.** Studio is the target environment; any Free-edition API gating is noted as a downstream caveat only.

## Implementation Approach

Desk research first to build a mental model of the Workflow Integration runtime, then a thin empirical smoke test to kill the "will it even load?" risk that docs alone can't settle, then a structured evaluation of the three reuse strategies, then the written verdict. The PoC is deliberately minimal and disposable — its only job is to produce evidence for the verdict, not to advance S-09.

## Phase 1: SDK & runtime desk research

### Overview

Build an accurate model of the DaVinci Resolve Workflow Integration plugin runtime from the Studio SDK and official docs, captured as research notes that feed the verdict.

### Changes Required:

#### 1. Research notes (scratch)

**File**: `context/changes/f-02/research-notes.md` (working notes; may be folded into `decision.md` later)

**Intent**: Inventory the runtime so the verdict rests on facts, not assumptions. Capture: how a Workflow Integration plugin is registered and launched (`Workspace → Workflow Integrations`); the panel-hosting model (what web/UI tech a panel can host, how it renders); the DaVinciResolveScript API surface relevant to US-02 (resolve handle → current project → create folder/bin in Media Pool → create timeline → import source media); packaging/install layout (where plugins live, manifest format); and any Studio-vs-Free gating notes.

**Contract**: A notes doc with sections `Panel hosting`, `API surface (US-02 path)`, `Packaging/install`, `Studio vs Free`, each with source links. The Resolve Studio SDK ships docs/examples inside the install (Developer/Scripting and Workflow Integration sample folders) — prefer those as primary source over forum lore. Use Context7 / official docs for the DaVinciResolveScript API where helpful.

### Success Criteria:

#### Automated Verification:

- Notes file exists: `test -f context/changes/f-02/research-notes.md`

#### Manual Verification:

- Notes answer all four section questions (panel hosting, API surface for the US-02 path, packaging, Studio/Free gating) with at least one concrete source per section.
- The minimal API call sequence to "create a folder and place a timeline in the current project" is written down as a concrete step list.

**Implementation Note**: After completing this phase and automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Smoke-test PoC (throwaway)

### Overview

Empirically confirm the two facts docs cannot reliably settle: (a) a **custom HTML/JS panel actually loads** inside Resolve Studio, and (b) panel JS can **reach the Resolve API** and perform a trivial mutation.

### Changes Required:

#### 1. Throwaway "hello panel" plugin

**File**: Scratch location outside the repo source tree — the Resolve plugin install path discovered in Phase 1 (NOT under `src/` or `src-tauri/`). Track its path in `research-notes.md`.

**Intent**: Stand up the smallest possible Workflow Integration that renders a custom HTML/JS panel and, on a button click, calls the Resolve API to create a uniquely-named bin (and, if reachable within the box, an empty timeline) in the currently open project. This proves panel hosting + API reachability end-to-end in the real runtime.

**Contract**: Minimal plugin manifest + an `index.html`/JS panel + the script glue the Workflow Integration model requires (per Phase 1 findings). Success = the panel is visible under `Workspace → Workflow Integrations`, and clicking the button produces a visible new bin in the Media Pool of the open project. This is disposable code; do not optimize or generalize it.

### Success Criteria:

#### Automated Verification:

- PoC artifact path is recorded in `research-notes.md`: `grep -q "PoC path" context/changes/f-02/research-notes.md`

#### Manual Verification:

- The custom panel loads and renders inside Resolve Studio (screenshot or note in `research-notes.md`).
- Clicking the panel button creates a visibly new bin in the open project's Media Pool (and a timeline if reached).
- Any blockers, API quirks, or failures encountered are written down verbatim — a *failure here is a valid, high-value finding* and likely points the verdict toward `Park` or `Go-with-rework`.

**Implementation Note**: After this phase, pause for manual confirmation before proceeding.

---

## Phase 3: Frontend-reuse evaluation

### Overview

Decide which reuse strategy is recommended, grounded in the Phase 1–2 findings and the concrete post-F-01 `invoke()` surface.

### Changes Required:

#### 1. Reuse evaluation section (scratch)

**File**: `context/changes/f-02/research-notes.md` (append)

**Intent**: Map the post-F-01 surviving `invoke()` surface (the ~6 commands + the already-`fetch` AI calls, per Current State Analysis) to "what would replace each inside a Resolve panel," then score the three strategies the user asked to evaluate:
1. **Full as-is reuse** — Tauri app runs unchanged inside the panel (expected quick rule-out: no Tauri runtime in a Resolve panel).
2. **UI reuse + new Resolve-side bridge** — keep HTML/CSS/JS, replace each `invoke()` with a Resolve-script/IPC bridge (expected realistic middle path).
3. **Separate Resolve-native panel** — thin new UI calling shared selection logic (fallback if reuse infeasible).

**Contract**: An appended `Reuse evaluation` section containing (a) the post-F-01 `invoke()`→Resolve-bridge mapping table, and (b) a one-paragraph verdict per strategy with a single recommended pick. No code.

### Success Criteria:

#### Automated Verification:

- Notes contain a reuse evaluation section: `grep -qi "reuse evaluation" context/changes/f-02/research-notes.md`

#### Manual Verification:

- All three strategies are addressed; one is explicitly recommended with rationale tied to Phase 1–2 findings.
- The `invoke()`→bridge mapping covers every post-F-01 surviving command and notes that AI calls need no bridge.

**Implementation Note**: After this phase, pause for manual confirmation before proceeding.

---

## Phase 4: Decision doc + cleanup

### Overview

Convert the research into the durable 3-way verdict + (if applicable) the S-09 integration contract, and remove all PoC scaffolding.

### Changes Required:

#### 1. Decision document

**File**: `context/changes/f-02/decision.md`

**Intent**: Record the final, consumable verdict for S-09 and the foundation. State the verdict (`Go` / `Go-with-rework` / `Park`), summarize the evidence from Phases 1–3, give the reuse recommendation, and — unless `Park` — specify the scoped integration contract: the bridge API the panel needs (the mapped command list), the packaging approach, and the recommended reuse strategy. If `Park`, state that S-09 falls back to S-08 and why.

**Contract**: A doc with sections `Verdict`, `Evidence`, `Reuse recommendation`, `Integration contract for S-09` (omitted/short-circuited if `Park`), and `Risks & caveats` (incl. any Studio-vs-Free gating and unproven packaging/signing edges). Polish prose per project convention; technical IDs (FR-030, US-02, S-09, command names) stay as-is.

#### 2. PoC teardown

**File**: the throwaway plugin from Phase 2 (path recorded in `research-notes.md`)

**Intent**: Delete the smoke-test plugin from the Resolve install path so no orphan artifact lingers. The repo source tree was never touched, so there is nothing to revert there.

**Contract**: PoC files removed; `decision.md` notes that teardown was done.

### Success Criteria:

#### Automated Verification:

- Decision doc exists and names a verdict: `test -f context/changes/f-02/decision.md && grep -Eqi "Go-with-rework|^.*Go$|Park|Werdykt" context/changes/f-02/decision.md`
- Repo source tree untouched: `git status --porcelain src src-tauri` returns empty.

#### Manual Verification:

- `decision.md` states exactly one of the three verdicts unambiguously.
- If not `Park`, the integration contract is concrete enough for S-09 to plan against (bridge command list + packaging + reuse strategy).
- PoC artifacts are confirmed deleted from the Resolve plugin path.

**Implementation Note**: Final phase — confirm the verdict reads cleanly and S-09's blocker can be flipped (or formally parked) in the roadmap.

---

## Testing Strategy

This is a research spike; "testing" means evidence quality, not code tests.

### Manual Testing Steps:

1. Re-read `decision.md` cold: can someone who wasn't in the spike act on the verdict?
2. Confirm the PoC actually loaded and mutated the project (Phase 2 evidence), not just "docs say so."
3. Confirm the `invoke()`→bridge mapping matches the *post-F-01* surface, not today's render-heavy surface.
4. Run `node --experimental-vm-modules test/regression.js` once at the end — not because F-02 changed code (it didn't), but as the Wave-0 hygiene fence and to confirm the spike left the tree clean.

## Performance Considerations

None — no runtime code ships. The only "budget" is the ~1-day time-box; if Phase 2 hits a hard wall (panel won't load / API unreachable), stop early and record that as a `Park`-leaning finding rather than burning the box chasing it.

## Migration Notes

None. When this lands, S-09's blocker in `context/foundation/roadmap.md` (Open Question #2; S-09 status `blocked`) can be flipped to reflect the verdict, but that roadmap edit is outside this spike's source-zero scope and is a follow-up bookkeeping step.

## References

- Roadmap slice: `context/foundation/roadmap.md` (F-02, lines 92–103; S-09 dependency)
- Parallelization: `context/foundation/streams.md` (Wave 0; F-02 = "no code, decision doc")
- PRD: `context/foundation/prd.md` — FR-030, FR-031, US-02, Open Question #2
- Reuse-blocker grounding: `invoke()` call sites in `src/ui/step1-import.js`, `src/ai/cache.js`, `src/ai/providers.js` (post-F-01 surviving surface)
- Project rule: `context/foundation/lessons.md` (plan-brief.md in Polish)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: SDK & runtime desk research

#### Automated

- [x] 1.1 Notes file exists: `test -f context/changes/f-02/research-notes.md` — 2cb9bca

#### Manual

- [x] 1.2 Notes answer all four section questions with a concrete source each — 2cb9bca
- [x] 1.3 Minimal "create folder + timeline" API call sequence written down — 2cb9bca

### Phase 2: Smoke-test PoC (throwaway)

#### Automated

- [x] 2.1 PoC artifact path recorded in research-notes.md — 47a2328

#### Manual

- [ ] 2.2 Custom panel loads and renders inside Resolve Studio
- [ ] 2.3 Panel button creates a visibly new bin in the open project's Media Pool
- [ ] 2.4 Blockers/quirks/failures recorded verbatim

### Phase 3: Frontend-reuse evaluation

#### Automated

- [x] 3.1 Notes contain a reuse evaluation section — 0791db0

#### Manual

- [x] 3.2 All three strategies addressed; one explicitly recommended — 0791db0
- [x] 3.3 invoke()→bridge mapping covers every post-F-01 surviving command — 0791db0

### Phase 4: Decision doc + cleanup

#### Automated

- [x] 4.1 Decision doc exists and names a verdict — d8cf9af
- [x] 4.2 Repo source tree untouched (`git status --porcelain src src-tauri` empty) — d8cf9af

#### Manual

- [x] 4.3 decision.md states exactly one verdict unambiguously — d8cf9af
- [x] 4.4 If not Park, integration contract is concrete enough for S-09 — d8cf9af
- [x] 4.5 PoC artifacts confirmed deleted from the Resolve plugin path — d8cf9af
