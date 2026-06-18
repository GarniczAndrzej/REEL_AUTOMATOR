---
project: Reels Automator
version: 1
status: draft
created: 2026-06-10
updated: 2026-06-18
prd_version: 1
main_goal: quality
top_blocker: decisions
---

# Roadmap: Reels Automator

> Derived from `context/foundation/prd.md` (v1) + auto-researched codebase baseline.
> Edit-in-place; archive when superseded.
> Slices below are listed in dependency order. The "At a glance" table is the index.

## Vision recap

Reels Automator is pivoting from "transcribe + select + render" to a **local-first transcription + AI-selection tool whose only deliverable is a clean editing timeline** handed into the editor's own NLE. The FFmpeg MP4 render path and every in-app video-editor concern (9:16 crop, logo, subtitle burn-in, codec matrix, render queue, face-tracking) is legacy to be cut. Because the app no longer renders, its **product wedge** — the one trait that, if removed, makes it indistinguishable from a generic transcription tool — is *accurate, self-contained moment-selection with cuts pinned to real word boundaries*, processed fully on-device (only transcript text ever leaves the machine).

## North star

**S-01: Scored selection → clean EDL export** — this is the validation milestone because it proves the wedge end-to-end on real material: a recording becomes AI-scored reels that export as a timeline importing cleanly into the NLE, with no MP4 ever rendered.

> "North star" here = the smallest end-to-end slice whose successful delivery would prove the core product hypothesis — placed as early as Prerequisites allow because everything else only matters if this works. S-01 deliberately runs on the *existing* transcription path so the selection→export loop can be proven before the heavier WhisperX engine (S-05) lands.

## At a glance

| ID    | Change ID                   | Outcome (user can …)                                          | Prerequisites      | PRD refs                                      | Status   |
| ----- | --------------------------- | ------------------------------------------------------------ | ------------------ | --------------------------------------------- | -------- |
| F-01  | remove-render-path          | (foundation) FFmpeg render path deleted; regression fence green | —               | FR-038                                        | done     |
| F-02  | resolve-plugin-spike        | (foundation) decision recorded on Resolve plugin viability   | —                  | FR-030 (gates), US-02                         | done     |
| R1    | split-step2-analyze         | (refactor) split `step2-analyze.js` into per-surface modules so S-02/S-03/S-04 own separate files | F-01 | — (enabler; streams.md R1)                | done     |
| R2    | api-key-accessor            | (refactor) replace direct `localStorage.edl_apikey_*` reads with a `getApiKey()/setApiKey()` helper | —          | — (enabler; streams.md R2)                    | done     |
| S-01  | scored-selection-edl        | get AI reels scored on Hook/Flow/Value/Trend and export a clean EDL | F-01        | FR-010, FR-011, FR-012, FR-014, FR-017, FR-018, FR-026, FR-033 | done     |
| S-02  | scoring-first-reel-list     | triage reels in a score-sorted list with reasons             | S-01               | FR-020                                        | done     |
| S-03  | prompt-presets              | edit the system prompt and manage reusable prompt presets    | S-01               | FR-015, FR-016                                | done     |
| S-04  | segment-tuning-ops          | reorder, merge, delete segments (reorder/merge/delete ops need rework) | S-01      | FR-022                                        | proposed |
| S-05  | builtin-whisperx-transcription | transcribe locally with word-level alignment + manage models | F-01            | FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007 | done     |
| S-07  | auto-mode-pipeline          | run the whole pipeline in one click with staged progress     | S-01, S-05         | FR-008, FR-009                                | proposed |
| S-08  | timeline-export-set         | export Premiere XML, FCPXML and Resolve Lua (with markers)   | S-01               | FR-027, FR-028, FR-029                        | proposed |
| S-09  | resolve-plugin-handoff      | push reels into Resolve from inside Resolve in one click     | S-01, S-08, F-02   | FR-030, FR-031, US-02                         | go-with-rework |
| S-11  | keychain-credentials        | store API keys in the OS keychain, never plaintext           | —                  | FR-035                                        | done     |
| S-16  | ui-ux-redesign              | move through a simpler, decluttered flow with fewer visible steps | —              | — (UX overhaul; supports US-01 review speed)  | done     |
| S-17  | feature-pruning-cleanup     | run a recurring pass to identify, decide on, and remove backlog/feature bloat | —    | — (process/maintenance; keep-it-lean)         | done     |
| S-18  | whisperx-engine-check-speedup | start transcribing without a long wait — the WhisperX engine/availability check is fast (or cached/async) | S-05 | — (perf; supports FR-001 import-to-transcribe) | done |

## Streams

Navigation aid — groups items that share a Prerequisites chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme                       | Chain                                                        | Note                                                                 |
| ------ | --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| A      | Selection & export deck     | `F-01` → `S-01` → `S-02` / `S-03` / `S-04` → `S-08`          | The north-star spine; quality goal fronts the scored-selection loop. |
| B      | Local transcription         | `S-05` → `S-07`                                            | Branches from `F-01`; word-level alignment unlocks the cut-accuracy criterion. |
| C      | Resolve integration         | `F-02` → `S-09`                                             | Spike-first (top blocker = decisions); `S-09` joins Stream A at `S-08`. |
| D      | Security                    | `S-11`                                                      | `S-11` is standalone-ready. |
| E      | UX overhaul                 | `S-16` (prereq-free)                                        | Step-shell rewrite; prereq-free so it can land early — later surfaces (`S-02`/`S-04`/`S-08`) build into the new shell. Informs `S-07`'s one-click flow. |

## Baseline

What's already in place in the codebase as of 2026-06-10 (auto-researched + user-confirmed).
Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** present — vanilla JS + Vite, `src/ui/stepN-*.js` pipeline over a single `state.js` pub/sub.
- **Backend / API:** present — Rust Tauri 2 commands registered in `src-tauri/src/lib.rs`.
- **Data / persistence:** present — `.reelproj` JSON (schema v2) via `src-tauri/src/project.rs`, serde defaults for back-compat.
- **Transcription:** partial — `src-tauri/src/whisper.rs` shells out to `whisper-cli` on PATH (not bundled, no built-in word-level alignment, no diarization). Rebuilt by S-05.
- **AI selection:** partial — `src/ai/providers.js` + `prompt.js` exist, but the schema is the OLD title/hook/description shape: no `virality_score`, no `hook/body/punchline` markers, no `cache_control` prompt-caching. Rebuilt by S-01.
- **Credentials:** keychain (macOS), migrated from `localStorage` — API keys live in the macOS Keychain behind `src/ai/api-key.js`; legacy plaintext auto-migrated by S-11.
- **i18n:** absent — all user-facing strings are hardcoded Polish; no translation-key layer. Intentionally kept Polish-only (the i18n slice was dropped — see Parked).
- **Render path:** present — full FFmpeg filter-graph render + queue + face-tracking. Deleted by F-01 (FR-038).
- **Deploy / infra:** present — Tauri desktop bundle, macOS-only, architecture-suffixed FFmpeg sidecar; no CI.
- **Observability:** n/a — local single-user desktop tool.

## Foundations

### F-01: Render-path removal + regression fence

- **Outcome:** (foundation) the FFmpeg filter-graph render, render UI/tab, render queue, hardware-encoder detection, subtitle burn-in, logo overlay and face-tracking keyframes are deleted; the bundled FFmpeg sidecar is kept (still used for audio extraction + thumbnails); the regression suite passes before and after, proving the selection → segment → export pipeline survives.
- **Change ID:** remove-render-path
- **PRD refs:** FR-038; guardrails (preserved pipeline, integer-frame math, `.reelproj` load)
- **Unlocks:** S-01 (shrinks the schema-change consumer surface — no `renderConfig` paths to thread `virality_score` through); the regression fence that every "must not regress" guardrail relies on.
- **Prerequisites:** —
- **Parallel with:** F-02
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Large deletion — the danger is silently breaking the export pipeline or `.reelproj` load. Run `node --experimental-vm-modules test/regression.js` before and after; the suite is the only automated guard. Sequenced first so quality-critical work lands on a slimmed, fenced codebase.
- **Status:** done

### F-02: Resolve plugin runtime spike

- **Outcome:** (foundation) a recorded decision answering whether the DaVinci Resolve Workflow Integration runtime (DaVinciResolveScript API, panel hosting, packaging) is viable and whether the existing Tauri frontend can be reused inside it — including a scoped integration contract if the answer is yes.
- **Change ID:** resolve-plugin-spike
- **PRD refs:** FR-030 (gates), US-02, PRD Open Question #2
- **Unlocks:** reduces the blocking unknown on S-09; turns "is the headline feature even buildable?" into a committed/parked decision.
- **Prerequisites:** —
- **Parallel with:** F-01, and the entire Stream A/B build (research, not build).
- **Blockers:** —
- **Unknowns:** Can the Tauri frontend host inside a Resolve Workflow Integration panel, or does the plugin need a separate runtime? — Owner: user. Block: no (this foundation IS the resolution; it does not itself wait on anything).
- **Risk:** This is the project's single largest technical unknown. Doing it as an early, parallel spike (top blocker = decisions) avoids committing S-09 to a delivery slice before viability is known. If the answer is "not viable," S-09 reverts to the file-export fallback (S-08) and is parked.
- **Status:** done

## Prep refactors

Footprint-reduction refactors carried over from `streams.md`. They are not user-visible slices — each one converts a merge-conflict hot file into owned files so later slices can run in parallel worktrees. Per `streams.md` they land **inside the slice that goes first**, not as standalone changes; they appear here only so the roadmap tracks them.

### R1: Split `step2-analyze.js` into per-surface modules

- **Outcome:** (refactor) the 1408-line `src/ui/step2-analyze.js` is carved into `step2-reel-list.js` (→ S-02), `step2-prompt-panel.js` (→ S-03), and `step2-segment-ops.js` (→ S-04), leaving `step2-analyze.js` as a thin orchestrator — so S-02/S-03/S-04 each own a distinct file instead of serializing on the shared hot file.
- **Change ID:** split-step2-analyze
- **PRD refs:** — (internal enabler; no FR)
- **Unlocks:** Wave 2 width — S-02/S-03/S-04 become true worktree partners rather than a serial queue on one file.
- **Prerequisites:** F-01
- **Parallel with:** none — lands as the opening move of S-01 (per `streams.md`); not co-parallel with other step2 work.
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Pure structural move — behavior must not change. Run `node --experimental-vm-modules test/regression.js` before and after. Mechanically the project's bottleneck-buster: without it, 11 slices funnel through one file.
- **Status:** done — shipped inside S-01 (`scored-selection-edl`), not as a standalone change. `step2-analyze.js` is now a thin orchestrator wiring `step2-reel-list.js`, `step2-prompt-panel.js`, `step2-segment-ops.js`; regression suite green (179/0).

### R2: `getApiKey()/setApiKey()` accessor abstraction

- **Outcome:** (refactor) the 4 direct `localStorage.edl_apikey_*` read sites (OpenRouter picker, step-2 selection, step-1 import, providers) are replaced by a single `getApiKey()/setApiKey()` helper — so S-11 can swap the backing store to the OS keychain without touching those call sites, and stops conflicting with S-01.
- **Change ID:** api-key-accessor
- **PRD refs:** — (internal enabler; supports FR-035 via S-11)
- **Unlocks:** S-11 (clean keychain swap behind the helper); de-conflicts the key-read sites from S-01.
- **Prerequisites:** —
- **Parallel with:** prerequisite-free — slot into Wave 0 (per `streams.md`), ideally before S-01.
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Low — a find-all-call-sites refactor with no behavior change. The win is purely shrinking the merge surface so S-01 and S-11 don't collide on key reads.
- **Status:** done — shipped behind `src/ai/api-key.js`; all 5 key read/write sites route through `getApiKey()/setApiKey()`.

## Slices

### S-01: Scored AI selection → clean EDL export  (★ north star)

- **Outcome:** Editor runs AI selection on a transcript and gets reels each carrying a `virality_score` (Hook/Flow/Value/Trend) + one-line `reason` + `hook/body/punchline` markers, can hand-edit the reels JSON, and exports a CMX3600 `.edl` that imports cleanly into the NLE with markers intact.
- **Change ID:** scored-selection-edl
- **PRD refs:** FR-010, FR-011, FR-012, FR-014, FR-017, FR-018, FR-026, FR-033; NFRs (repeatability, prompt-caching, validate-before-use)
- **Prerequisites:** F-01
- **Parallel with:** S-05, S-11
- **Blockers:** —
- **Unknowns:**
  - Does adding `virality_score` + markers to the Reel schema break EDL/`.reelproj` import compatibility? — Owner: team. Block: no (covered by the regression fence + serde defaults).
- **Risk:** The LLM-schema change in `src/ai/prompt.js` touches every consumer (providers, step-2 editor, exporters) — the CLAUDE.md "update every consumer + grep the field name" rule applies. Validate the response before use (FR-018) so no unvalidated object reaches the export pipeline. This slice IS the wedge; correctness here is the product.
- **Status:** done

### S-02: Scoring-first reel list UI

- **Outcome:** Editor sees reels as a list with a `virality_score` badge each, sortable by score, a one-line `reason` under each reel, and weaker reels visually greyed but still selectable.
- **Change ID:** scoring-first-reel-list
- **PRD refs:** FR-020; US-01 ("reels sort by score")
- **Prerequisites:** S-01
- **Parallel with:** S-03, S-04, S-08, S-11
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Pure UI over the S-01 schema; low risk. Sequenced right after the north star because the scored list is the editor's primary triage surface — the score is only useful if it's the lens for the list.
- **Status:** done

### S-03: Editable system prompt + presets

- **Outcome:** Editor edits the (no-longer-hardcoded) system prompt, supplies a user prompt, and manages prompt presets (save-as, duplicate, delete, edit; import/export as `.json` via path picker); built-in starter presets ship and user presets persist.
- **Change ID:** prompt-presets
- **PRD refs:** FR-015, FR-016
- **Prerequisites:** S-01
- **Parallel with:** S-02, S-04, S-08, S-05, S-11
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Preset persistence + import/export is straightforward; the only sharp edge is keeping the editable prompt in sync with the fixed JSON schema S-01 established — a free-form prompt must still elicit the validated shape.
- **Status:** done

### S-04: Segment tuning — reorder / merge / delete

- **Outcome:** Editor reorders segments, merges adjacent segments (merge-threshold slider with a sensible default), and deletes segments.
- **Change ID:** segment-tuning-ops
- **PRD refs:** FR-022
- **Prerequisites:** S-01
- **Parallel with:** S-02, S-03, S-08, S-05, S-11
- **Blockers:** —
- **Unknowns:** —
- **Rescope (2026-06-15):** FR-023 filler removal **dropped** — the filler feature (`src/selection/fillers.js` + strike-through preview) was removed in S-17, and FR-023's word-level removal logic was never implemented. The FR-022 reorder/merge/delete ops (`step2-segment-ops.js`) need **rework** and the owner will re-plan this slice fresh; the existing `context/changes/s-04/` plan was superseded and deleted.
- **Risk:** `mergeAdjacentClips` remains the export-span source; changing merge behavior must keep integer-frame math intact and not regress the exporters (regression fence).
- **Status:** proposed

### S-05: Built-in WhisperX transcription + word-level alignment + model manager

- **Outcome:** Editor imports a local video by drag-and-drop, runs fully-local built-in transcription producing text + word-level forced alignment with no separate install, browses a model list (downloaded vs missing) and downloads a missing model (path picker, %/speed/ETA), can instead import an existing `.srt`/`.vtt`, can export the transcript, and gets the transcript auto-split into gap-free numbered segments feeding selection directly; diarization runs in the same pass as an opt-in toggle.
- **Change ID:** builtin-whisperx-transcription
- **PRD refs:** FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007
- **Prerequisites:** F-01
- **Parallel with:** S-01, S-02, S-03, S-04, S-08, S-11
- **Blockers:** Hugging Face token + pyannote model access for opt-in diarization (external — opt-in only; core transcription + alignment path is never blocked by it).
- **Unknowns:**
  - How to bundle WhisperX (+ alignment) as a built-in engine replacing the PATH `whisper-cli`, and how to migrate/preserve the existing SRT+word-JSON cache contract? — Owner: team. Block: no (a hard build task, not a viability unknown — but de-risk early).
- **Risk:** Heaviest slice on the quality path — word-level alignment is what guarantees the ~0%-mid-word primary criterion. Engine swap changes the transcription command, packaging, and cache key/format; preserve or migrate the cache so existing projects don't re-transcribe.
- **Status:** done

### S-07: One-click auto mode + staged progress

- **Outcome:** Editor triggers a one-click automatic run (after an API key is set, with confirmation) that drives import → transcription → alignment → diarization → segmentation → AI selection and auto-advances, with the ability to return to earlier steps; a single continuous staged progress indicator shows per-stage %, a per-stage cancel button, and no blocking modal.
- **Change ID:** auto-mode-pipeline
- **PRD refs:** FR-008, FR-009
- **Prerequisites:** S-01, S-05
- **Parallel with:** S-08
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Orchestration over slices that must already exist; the sharp edges are cancelability mid-stage and not blocking the window. Sequenced after both the selection (S-01) and transcription (S-05) engines are real.
- **Status:** proposed

### S-08: Full timeline-export set — Premiere XML / FCPXML / Resolve Lua

- **Outcome:** Editor exports FCP7 xmeml `.xml` (Premiere), `.fcpxml` (Final Cut Pro X, generated separately from xmeml), and a DaVinci Resolve `.lua` console script — all carrying the new markers and importing cleanly.
- **Change ID:** timeline-export-set
- **PRD refs:** FR-027, FR-028, FR-029
- **Prerequisites:** S-01
- **Parallel with:** S-02, S-03, S-04
- **Blockers:** —
- **Unknowns:**
  - Does the `.fcpxml` (new, distinct format) need its own marker/timecode model vs the xmeml exporter? — Owner: team. Block: no.
- **Risk:** XML and Lua are `preserved` exporters whose structure is fragile and import-tested in real NLEs — adding markers must not break import. FCPXML is net-new. Extend the regression suite with a case per format in the same change.
- **Status:** proposed

### S-09: DaVinci Resolve embedded plugin (one-click hand-off)

- **Outcome:** Editor launches Reels Automator from `Workspace → Workflow Integrations`, completes selection in the embedded panel, and one click creates a new dated folder in the current Resolve project with each reel as its own timeline and source media in the Media Pool — no script-paste, no file-import; when the Resolve API is unavailable the app falls back to file export automatically.
- **Change ID:** resolve-plugin-handoff
- **PRD refs:** FR-030, FR-031, US-02
- **Prerequisites:** S-01, S-08, F-02
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - Is the Workflow Integration runtime viable and can the Tauri frontend be reused inside it? — **Resolved by F-02 (verdict `Go-with-rework`, 2026-06-11).** Runtime is viable (Electron Workflow Integration; panel hosting confirmed live in Studio); frontend reuses via Strategy 2 (keep HTML/CSS/JS, rebuild the Tauri `invoke` bridge as an Electron `contextBridge`/`ipcRenderer` bridge + reimplement the 6 post-F-01 commands in Node). Integration contract: `context/changes/f-02/decision.md`.
- **Risk:** The headline differentiator and the largest single technical risk. F-02 returned `Go-with-rework`: no hard blocker, but the Tauri→Electron bridge rebuild + packaging/signing are scoped rework. The file-export set (S-08) remains the always-available fallback (and the only path for Resolve Free / Linux).
- **Status:** go-with-rework

### S-11: API keys in the OS keychain

- **Outcome:** Editor's API keys are stored in the OS secure credential store (macOS Keychain / Windows Credential Manager) and are never persisted in plaintext.
- **Change ID:** keychain-credentials
- **PRD refs:** FR-035
- **Prerequisites:** —
- **Parallel with:** essentially all slices (no prerequisite)
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Touches every key read/write site (`edl_apikey_*` in the OpenRouter picker, step-2 selection, compare panel). Low conceptual risk; the work is finding all call sites. Independent of the selection pipeline, so it can run any time as a parallel hardening task.
- **Status:** done — `keyring`-crate `keychain.rs` commands + hydrated `src/ai/api-key.js` cache; one-time `localStorage`→Keychain migration at boot (macOS).

### S-16: UI/UX redesign — simpler, decluttered flow

- **Outcome:** Editor moves through a streamlined interface that **rewrites the current three-step wizard** (`step1-import` → `step2-analyze` → `step3-export`) into a flow with fewer visible steps and far less on-screen clutter — collapsing the staged `goStep(n)` shell into a single primary working surface where import/transcribe, scored-reel review + segment tuning, and export read as one continuous task rather than three separate screens. App-level configuration (API key, model, merge gap) moves out of the inline flow into a dedicated **settings window**; export becomes a **quick-export popover** rather than a full step; project settings auto-populate from the imported video; and the proposed-reels list is decluttered (no in-list playback, no per-reel timeline, component scores surfaced). Visual hierarchy is tightened (clear primary action per state, secondary controls demoted/collapsed), so a first-time editor reaches a clean exported timeline without hunting across tabs.
- **Change ID:** ui-ux-redesign
- **PRD refs:** — (UX overhaul; no single FR — serves the persona's review-speed goal behind US-01 and the "fewer steps" usability intent; coordinate with FR-008/FR-009 one-click flow)
- **Redesign scope (from `context/foundation/UI changes proposals.md`, 2026-06-15):** the user's concrete redesign intents, grouped. Items marked *(coordinate: …)* overlap another slice and must be reconciled when that slice builds into the new shell; items marked *(prune)* are removals; *(done)* / *(parked)* note prior decisions.

  **A. One continuous flow — collapse the 3-step wizard (#1, #3, #8)**
  - One uninterrupted flow to make reels — import → review → export read as one task, not three separate screens. *(#1, core of this slice)*
  - Import accepts a video **plus an optional `.srt`**; when no SRT is provided, WhisperX transcription starts automatically and everything loads without manual steps. *(#3 — coordinate: S-05 transcription, S-07 one-click)*
  - Export stops being a dedicated step and becomes a small **quick-export window/popover** offering SRT, VTT, `.md`, AI-prompt copy, **and** the main timeline exports (EDL / XML / Lua). *(#8 — coordinate: S-08 export set)*

  **B. Settings knob — pull config out of the flow (#2, #4, #5, #6)**
  - API key, model, and overall settings move into a dedicated **settings window**, out of the inline flow. *(#2)*
  - Project settings (fps, EDL file name) **auto-populate when the video is added** — no manual entry. *(#4)*
  - Step 3's "Plik wideo źródłowy" stops being an editable settings surface — video path / name / resolution / format are **auto-detected**; anything that is genuinely a setting moves to the settings window / project settings. *(#5)*
  - "Przerwa między Reelsami" (the merge-gap / threshold) moves into the **settings window** and its value **persists across sessions**. *(#6 — coordinate: S-04 merge-threshold slider)*

  **C. Declutter & remove dead controls (#7, #9, #10, #11, #12, #14)**
  - Remove "Minimalna długość zdania" (min sentence length / `minChars`) — redundant now that segments align to word-level precision. *(#7 — prune)*
  - "Porównaj dostawców" (compare providers) **and** the AI cache control — **already removed in S-17**; the redesign must carry no remnant. *(#9 — done)*
  - Rename the analyze action from "Analizuj z AI" → **"Analizuj z OpenRouter"**. *(#10)*
  - Move the "wklej JSON z AI" panel behind a separate/optional function; the **primary** action is copying the AI prompt (as `.md`, not `.txt`), with file export demoted to a **secondary** button. *(#11 — note: standalone prompt-**export** is Parked; keep the copy-prompt affordance, treat file export as secondary/optional)*
  - Remove the "dodaj kolejny film" (add another video) feature. *(#12 — prune)*
  - Declutter the proposed-reels list: drop in-list playback and the per-reel timeline; surface the **component scores** (Hook/Flow/Value/Trend), not just the overall score. *(#14 — coordinate: S-02 scoring-first list)*

  **Out of scope here — needs its own slice (#13)**
  - WhisperX **transcription queue** (batch-mark several files, queue them) **and** accepting audio files (`.wav`, etc.), not only video — this is new transcription functionality, not a UX reshape. Flag as a separate slice off S-05 rather than folding it into S-16. *(#13)*
- **Prerequisites:** — (none; prereq-free so it can land early. Decision 2026-06-15: this is a genuine step-shell rewrite, not a visual declutter, so it is best done **before** the feature surfaces fill in — S-02/S-04/S-08 then build into the new shell rather than the old `goStep` staging.)
- **Parallel with:** S-08, S-11 (exporter/selection/hardening work the redesign re-skins but does not block on)
- **Blockers:** —
- **Unknowns:**
  - How much of the "simpler flow" is already delivered by S-07's one-click auto mode vs. owned here (manual-flow ergonomics)? — Owner: team. Block: no (coordinate the shared "fewer steps" goal; does not gate the rewrite).
  - Does the quick-export popover (#8) duplicate or replace the S-08 export surface, and does merge-gap-in-settings (#6) move ownership of the threshold UI out of S-04? — Owner: team. Block: no (reconcile when those slices build into the new shell).
- **Risk:** Cross-cutting rewrite of the `goStep(n)` orchestration in `main.js` and every `src/ui/stepN-*.js` surface; the regression suite only fences parser/exporters, so UI behavior must be manually re-verified. Landing it **early** (prereq-free) is the cheaper sequencing: later slices build into the new shell, avoiding a second reshape — but anything already shipped against the old steps (none yet beyond S-01's step-2 split) would need rework if reordered. Several proposals overlap live slices (S-02/S-04/S-08) and one (#13 queue) is net-new functionality, not presentation — scope-gate those out so S-16 stays a pure shell/declutter rewrite. Keep all user-facing strings Polish. No exporter or frame-math changes — pure presentation/orchestration.
- **Status:** done

### S-17: Feature pruning & cleanup pass

- **Outcome:** Editor (solo owner) runs a recurring de-bloating pass over the app: (1) **Identify bloat** — review both the planned backlog (Slices / Backlog Handoff) and already-implemented features against current personal needs, flagging anything that no longer earns its keep; (2) **Brainstorm & decide** — a quick sync to challenge each flagged item's usefulness and decide per item keep / simplify / drop; (3) **Execute** — instantly delete rejected *planned* tasks (slice + Backlog Handoff row, recorded under Parked), and safely refactor/remove the code for rejected *shipped* features to keep the codebase clean.
- **Change ID:** feature-pruning-cleanup
- **PRD refs:** — (process/maintenance slice; no FR — serves the solo-app "keep it lean" goal)
- **Prerequisites:** —
- **Parallel with:** essentially all slices (no prerequisite; it operates *on* the backlog/codebase rather than depending on a feature)
- **Blockers:** —
- **Unknowns:**
  - Which currently-planned slices and shipped features are the first pruning candidates? — Owner: user. Block: no (resolved in the step-2 sync).
- **Risk:** Code removal for shipped features is the sharp edge — grep all consumers, keep user-facing strings Polish, and run `node --experimental-vm-modules test/regression.js` before and after any removal touching `src/parser/`, `src/exporters/`, or the frame-math pipeline. Recurring, not one-shot: re-run whenever the backlog or UI outgrows personal need.
- **Status:** done

### S-18: Speed up the WhisperX engine check

- **Outcome:** Editor no longer waits on a slow "checking engine" step before transcription can start — the WhisperX engine availability/readiness probe (the `whisperx-engine` sidecar version/health check that runs ahead of `transcribe_video`) is made fast: cached after first success, run asynchronously so the UI stays responsive, and surfaced with an explicit "checking…/ready/unavailable" state instead of a silent multi-second stall.
- **Change ID:** whisperx-engine-check-speedup
- **PRD refs:** — (performance/UX fix on the S-05 transcription path; supports FR-001 import→transcribe responsiveness)
- **Prerequisites:** S-05
- **Parallel with:** essentially all slices (isolated to the transcription engine bring-up path)
- **Blockers:** —
- **Unknowns:**
  - What dominates the check latency — sidecar cold-start (PyInstaller onefile unpack), the align-model probe, or a redundant per-call health invocation? — Owner: team. Block: no (profile first, then choose cache vs. async vs. warm-on-launch).
- **Risk:** Low surface — touches the engine bring-up/health path (`src-tauri/src/whisper.rs` + its frontend caller), not the transcription correctness path or the cache contract. Must not mask a genuinely-missing/broken engine: a cached "ready" has to invalidate when the sidecar/model is absent, so keep the unavailable state honest. No parser/exporter/frame-math impact.
- **Status:** done

## Backlog Handoff

| Roadmap ID | Change ID                      | Suggested issue title                                   | Ready for `/10x-plan` | Notes                                            |
| ---------- | ------------------------------ | ------------------------------------------------------- | --------------------- | ------------------------------------------------ |
| F-01       | remove-render-path             | Remove FFmpeg render path; add regression fence         | yes                   | Run `/10x-plan remove-render-path`               |
| F-02       | resolve-plugin-spike           | Spike: Resolve Workflow Integration runtime viability   | yes                   | Resolves PRD Open Q #2; unblocks S-09            |
| R1         | split-step2-analyze            | Split step2-analyze.js into per-surface modules         | done                  | Shipped inside S-01; thin orchestrator + 3 surface modules |
| R2         | api-key-accessor               | getApiKey()/setApiKey() accessor abstraction            | yes                   | Enabler; prereq-free, land inside/ahead of S-11  |
| S-01       | scored-selection-edl           | Scored AI selection → clean EDL export (north star)     | no                    | Needs F-01                                       |
| S-02       | scoring-first-reel-list        | Scoring-first reel list UI                              | no                    | Needs S-01                                       |
| S-03       | prompt-presets                 | Editable system prompt + preset management              | done                  | Archived 2026-06-18 → `context/archive/2026-06-16-s-03/` |
| S-04       | segment-tuning-ops             | Reorder / merge / delete segments (ops need rework)     | no                    | Needs S-01; FR-023 filler dropped (S-17); owner re-plans |
| S-05       | builtin-whisperx-transcription | Built-in WhisperX transcription + word-level alignment  | no                    | Needs F-01; heavy; cache migration               |
| S-07       | auto-mode-pipeline             | One-click auto mode + staged progress                   | no                    | Needs S-01, S-05                                 |
| S-08       | timeline-export-set            | Premiere XML / FCPXML / Resolve Lua export set          | no                    | Needs S-01                                       |
| S-09       | resolve-plugin-handoff         | DaVinci Resolve embedded plugin (one-click hand-off)    | yes                   | F-02 verdict `Go-with-rework`; plan against decision.md |
| S-11       | keychain-credentials           | Move API keys to OS keychain                            | yes                   | No prerequisite; parallel hardening              |
| S-16       | ui-ux-redesign                 | UI/UX redesign — step-shell rewrite, simpler flow       | yes                   | Prereq-free; land early                          |
| S-17       | feature-pruning-cleanup        | Feature pruning & cleanup pass                          | yes                   | Prereq-free; recurring de-bloat of backlog + code |
| S-18       | whisperx-engine-check-speedup  | Speed up the WhisperX engine availability check         | yes                   | Needs S-05 (shipped); perf fix, profile first    |

## Open Roadmap Questions

1. **What is the `delivery_weeks` estimate for this change?** — Owner: user. Block: `roadmap-wide` (pacing only; does not block any specific slice). Sustained after-hours effort acknowledged 2026-06-10; no hard deadline.
2. ~~**Is the DaVinci Resolve Workflow Integration plugin runtime viable, and can the Tauri frontend be reused inside it?**~~ — **RESOLVED 2026-06-11 by F-02 (`resolve-plugin-spike`): verdict `Go-with-rework`.** Runtime viable (Electron Workflow Integration); frontend reuses via Strategy 2 with a rebuilt Electron bridge. S-09 unblocked; integration contract in `context/changes/f-02/decision.md`.
3. **WhisperX bundling + cache migration** — how to ship WhisperX (+ alignment, + optional pyannote diarization with HF-token handling) as a built-in engine replacing the PATH `whisper-cli`, preserving or migrating the SRT+word-JSON cache contract? — Owner: team. Block: no (a hard build task inside S-05, surfaced here because it spans transcription + caching + packaging).

## Parked

- **In-app video render / video editor (any future return)** — Why parked: PRD §Non-Goals hard lock — "its absence is the product's identity." (Note: F-01 *removes* the existing render path; this entry blocks it ever coming back.)
- **Cloud / SaaS / collaboration / hosted AI** — Why parked: PRD §Non-Goals hard lock — fully local, single-user.
- **Browser/web version of the app** — Why parked: PRD §Non-Goals (from AppContext.md).
- **Linux support** — Why parked: PRD §Non-Goals; macOS-first, Windows later.
- **General plugin architecture beyond the Resolve integration** — Why parked: PRD §Non-Goals.
- **Multi-region / high-availability architecture** — Why parked: PRD §Non-Goals; single device.
- **URL ingest (YouTube/Vimeo)** — Why parked: PRD §Non-Goals deferred set (later change).
- **CapCut draft export** — Why parked: PRD §Non-Goals deferred set.
- **A/B provider comparison + merge** — Why parked: PRD §Non-Goals deferred set.
- **Batch API** — Why parked: PRD §Non-Goals deferred set.
- **Two-stage long-form chunking** — Why parked: PRD §Non-Goals deferred set.
- **"Private AI" prompt-export / paste-back mode** — Why parked: PRD §Non-Goals deferred set.
- **Per-reel metadata generation (title/desc/hashtags/SEO)** — Why parked: PRD FR-019 DEFERRED; social/SEO repurposing, not timeline delivery.
- **Per-reel `.md` export** — Why parked: PRD FR-032 DEFERRED; social/SEO artifact, deferred with FR-019.
- **PIN / password app-lock at startup** — Why parked: PRD §Access Control — later security hardening, not this delivery.
- **Reel preview playback (was S-15, FR-024)** — Why parked: dropped 2026-06-15 by user. Preview is redundant once reels land in DaVinci Resolve (S-09), where the editor scrubs natively; no value duplicating it in-app.
- **EN/PL internationalization (was S-10, FR-034)** — Why parked: dropped 2026-06-15 by user. App stays Polish-only; no translation-key layer planned. Re-open only if a non-Polish audience is targeted.
- **Word-level boundary trim + snap-to-pause (was S-06, FR-021)** — Why parked: dropped 2026-06-15 by user (S-17 pruning). The reorder/merge/delete ops in S-04 are enough boundary control for now; word-precision nudging + pause-snap is fine-grained micro-optimization not worth the surface. Re-open if cut-boundary precision becomes a felt limitation.
- **Selection-quality flags — source grouping + dangling references (was S-14, FR-013/FR-025)** — Why parked: dropped 2026-06-15 by user (S-17 pruning). FR-013/FR-025 are nice-to-have selection refinements; the north-star wedge is provable without scoring polish. Re-open if multi-source mixing or dangling-reference reels prove a recurring quality problem.

## Done

(Empty on first generation. `/10x-archive` appends here — and flips the matching item's `Status` to `done` — when a change whose `Change ID` matches a roadmap item is archived. Do NOT pre-populate.)

- **F-01: (foundation) FFmpeg render path deleted; regression fence green** — Archived 2026-06-11 → `context/archive/2026-06-10-f-01/`. Lesson: —.
- **F-02: (foundation) decision recorded on Resolve plugin viability** — Archived 2026-06-11 → `context/archive/2026-06-10-f-02/`. Lesson: —.
- **S-01: get AI reels scored on Hook/Flow/Value/Trend and export a clean EDL** — Archived 2026-06-14 → `context/archive/2026-06-12-scored-selection-edl/`. Bundled the R1 refactor (step2-analyze split) as its opening move; scored LLM schema/prompt/providers + validate-before-use gate + EDL hook/body/punchline markers (regression Test 13). Lesson: a free-form editable prompt must still elicit the fixed validated schema — validate every LLM response before it reaches the export pipeline (FR-018).
- **S-05: transcribe locally with word-level alignment + manage models** — Archived 2026-06-14 → `context/archive/2026-06-12-builtin-whisperx-transcription/`. Built-in WhisperX engine (frozen Python sidecar via PyInstaller) replacing PATH `whisper-cli`; model manager (download/list/delete), word-level forced alignment, opt-in diarization. Lesson: both bundled sidecars (`ffmpeg-*` and `whisperx-engine-*`) plus `binaries/align_models/` are git-ignored and absent from any fresh checkout/worktree — restore via `sidecar/fetch-ffmpeg.sh` + `sidecar/build.sh` or `cargo`/`tauri dev` hard-fails on the missing `externalBin`. Never bake the multi-GB alignment model into the onefile — ship it beside the binary.
- **R1: (refactor) split `step2-analyze.js` into per-surface modules** — Shipped inside S-01 (no separate archive). `step2-analyze.js` reduced to a thin orchestrator over `step2-reel-list.js` / `step2-prompt-panel.js` / `step2-segment-ops.js`; unblocks parallel work on S-02/S-03/S-04. Lesson: —.
- **S-17: run a recurring pass to identify, decide on, and remove backlog/feature bloat** — Archived 2026-06-15 → `context/archive/2026-06-15-s-17/`. Lesson: —.
- **S-16: move through a simpler, decluttered flow with fewer visible steps** — Archived 2026-06-16 → `context/archive/2026-06-15-s-16/`. Lesson: —.
- **S-18: start transcribing without a long wait — the WhisperX engine check is fast (cached/async)** — Archived 2026-06-16 → `context/archive/2026-06-16-s-18/`. Cheap `--capability` sidecar probe + content-addressed verdict cache + bounded timeout; launch badge is cache-read-only (never spawns), green earned only by the manual full self-test. Lesson: every `whisperx-engine` sidecar spawn pays a 37–67s cold cost (onefile extraction + torch import) regardless of the probe's own work — never put a sidecar spawn on the launch/critical path.
- **S-03: edit the system prompt and manage reusable prompt presets** — Archived 2026-06-18 → `context/archive/2026-06-16-s-03/`. Editable (no-longer-hardcoded) system prompt split from the user prompt + reusable preset library (save-as/duplicate/rename/delete, JSON import/export, built-in Polish starters); empty system prompt is meaningful (omits scoring guidance). Lesson: synchronous JS dialogs (`window.prompt/confirm/alert`) hard-crash Tauri's macOS WKWebView — use an in-app modal + async `@tauri-apps/plugin-dialog` `ask()` + `toast()` instead.
- **S-02: Scoring-first reel list UI** — Archived 2026-06-18 → `context/archive/2026-06-18-scoring-first-reel-list/`. Lesson: —.
- **S-11: store API keys in the OS keychain, never plaintext** — Archived 2026-06-18 → `context/archive/2026-06-18-keychain-credentials/`. `keyring`-crate `keychain.rs` get/set/delete commands + hydrated `src/ai/api-key.js` cache (sync `getApiKey`, async write-through `setApiKey`, boot `hydrateKeys()` with one-time localStorage→Keychain migration); R2 accessor folded in. Lesson: the `keyring` 3.x crate ships NO credential store by default (silent in-memory mock) — enable `apple-native` in Cargo.toml or Keychain writes don't persist.
