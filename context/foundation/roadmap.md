---
project: Reels Automator
version: 1
status: draft
created: 2026-06-10
updated: 2026-06-24
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
| S-04  | segment-tuning-ops          | reorder, merge, delete segments (reorder/merge/delete ops need rework) | S-01      | FR-022                                        | done     |
| S-05  | builtin-whisperx-transcription | transcribe locally with word-level alignment + manage models | F-01            | FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007 | done     |
| S-07  | auto-mode-pipeline          | run the whole pipeline in one click with staged progress     | S-01, S-05         | FR-008, FR-009                                | done     |
| S-08  | timeline-export-set         | export Premiere XML, FCPXML and Resolve Lua (with markers)   | S-01               | FR-027, FR-028, FR-029                        | done |
| S-09  | resolve-plugin-handoff      | auto-collect timeline audio, transcribe in-panel, insert subtitles onto Subtitles track, and create reel timelines — all from inside Resolve | S-01, S-05, S-08, F-02 | FR-030, FR-031, US-02 | go-with-rework |
| S-11  | keychain-credentials        | store API keys in the OS keychain, never plaintext           | —                  | FR-035                                        | done     |
| S-16  | ui-ux-redesign              | move through a simpler, decluttered flow with fewer visible steps | —              | — (UX overhaul; supports US-01 review speed)  | done     |
| S-17  | feature-pruning-cleanup     | run a recurring pass to identify, decide on, and remove backlog/feature bloat | —    | — (process/maintenance; keep-it-lean)         | done     |
| S-18  | whisperx-engine-check-speedup | start transcribing without a long wait — the WhisperX engine/availability check is fast (or cached/async) | S-05 | — (perf; supports FR-001 import-to-transcribe) | done |
| S-19  | word-level-srt-export       | export a word-by-word SRT (one word per cue), onset-pinned with a ≥4-frame minimum, ready to drop into TikTok/Reels captions | S-05 | FR-005 (extends)                          | done     |
| S-20  | word-srt-fix                | word-by-word SRT export actually works — diagnose and fix the broken S-19 implementation (manual steps were skipped) | S-19 | FR-005 (extends)                          | done     |
| S-21  | app-crash-fix               | app no longer randomly closes mid-session — root cause of the spontaneous window/process exit during `tauri dev` is identified and fixed | — | — (stability; blocks all interactive testing)                 | done     |
| S-22  | segment-chunk-slider        | adjust a slider that splits the transcript into finer segments — from full sentences down to word-level chunks — so cuts pin to real word boundaries | S-05 | FR-006 (extends); cut-accuracy wedge          | proposed |
| S-23  | stop-ai-analysis            | cancel an in-flight AI analysis with a Stop button when OpenRouter is slow/laggy (varies by model) | S-01 | — (UX/robustness on the selection action) | done     |
| S-24  | windows-port                | run the whole app on Windows — WhisperX/FFmpeg sidecars rebuilt for Windows (CUDA + CPU configs), keys in Windows Credential Manager, MSI/NSIS installer | S-05, S-11 | — (cross-platform; PRD §Non-Goals "Windows later") | proposed |
| S-25  | cost-optimized-ai-analysis  | cut AI-analysis cost via a two-stage (cluster → curate) pipeline with two selectable OpenRouter models + prompt caching | S-01, S-03, S-16 | — (NFR prompt-caching; promotes parked "two-stage long-form chunking") | done |
| S-26  | refactor-ai-prompts         | get noticeably better reels — each AI-analysis phase ships a re-engineered rubric prompt, plus a built-in prompt preset per BRAVE Education cohort | S-01, S-03, S-25 | FR-015, FR-016 (extends) | proposed |

## Streams

Navigation aid — groups items that share a Prerequisites chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme                       | Chain                                                        | Note                                                                 |
| ------ | --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| A      | Selection & export deck     | `F-01` → `S-01` → `S-02` / `S-03` / `S-04` → `S-08` → `S-25` → `S-26` | The north-star spine; quality goal fronts the scored-selection loop. `S-25` re-architects the S-01 analysis call into a cheaper two-stage pipeline (and folds in S-03's per-stage prompts + S-16's settings pickers); `S-26` re-engineers the prompt *content* for each of those phases + ships BRAVE-cohort presets. |
| B      | Local transcription         | `S-05` → `S-07` / `S-19` / `S-22`                          | Branches from `F-01`; word-level alignment unlocks the cut-accuracy criterion, (S-19) reels-ready word-by-word captions, and (S-22) slider-controlled word-level segment chunking. |
| C      | Resolve integration         | `F-02` → `S-09`                                             | Spike-first (top blocker = decisions); `S-09` joins Stream A at `S-08`. |
| D      | Security                    | `S-11`                                                      | `S-11` is standalone-ready. |
| E      | UX overhaul                 | `S-16` (prereq-free)                                        | Step-shell rewrite; prereq-free so it can land early — later surfaces (`S-02`/`S-04`/`S-08`) build into the new shell. Informs `S-07`'s one-click flow. |
| F      | Cross-platform (Windows)    | `S-05` / `S-11` → `S-24`                                    | Branches off the two platform-coupled slices (native sidecars + OS credential store); `S-24` is a separate-machine effort (build + verify on Windows). Continued on a Windows system. |

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
- **Resolution (2026-06-18):** Re-planned and shipped. Diagnosis: delete/merge already worked; only drag-reorder was broken because Tauri's webview swallowed HTML5 drag events. Fix was a single config flip (`dragDropEnabled: false` in `tauri.conf.json`) — `moveClip()` was already correct. Follow-up fix: keyboard Arrow ↑/↓ reorder now re-applies the focus glow after the re-render.
- **Risk:** `mergeAdjacentClips` remains the export-span source; changing merge behavior must keep integer-frame math intact and not regress the exporters (regression fence).
- **Status:** done

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
- **Status:** done

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
- **Status:** done

### S-09: DaVinci Resolve embedded plugin — full integration

- **Outcome:** Editor launches Reels Automator from `Workspace → Workflow Integrations` and gets a single panel covering the full pipeline end-to-end, without leaving Resolve:

  **A. Auto-collect audio from the current timeline (on panel open)**
  The plugin reads the active Resolve timeline via the API (`currentTimeline:GetName()`, `GetStartFrame()`, `GetEndFrame()`), extracts its audio automatically (no manual file picker), and makes it immediately available for transcription — no separate video file import step when inside Resolve.

  **B. Transcription mode (built-in, in-panel)**
  Editor triggers WhisperX transcription directly on the collected timeline audio from within the panel; progress is shown inline. The result (SRT + word timestamps) feeds the existing reel-selection flow — the same S-05 engine, driven via the Electron bridge rather than Tauri IPC.

  **C. Subtitles track insertion**
  After transcription (or after importing an existing SRT), editor can push the full word-level or sentence-level transcript directly onto a **Subtitles track** in the current Resolve timeline — one click, no copy-paste. Uses the Resolve API `timeline:CreateSubtitlesFromAudio()` (Resolve 18.5+) or, as a fallback, inserts subtitle clips frame-by-frame via `mediaPool:ImportMedia()` + timeline subtitle track API.

  **D. Reels → timeline creation**
  After AI scoring and reel selection in the embedded panel, one click creates a new dated folder in the current Resolve project with each reel as its own timeline and source media in the Media Pool — identical to the original S-09 handoff but now reachable without leaving the panel.

  When the Resolve API is unavailable (Resolve Free / non-Studio build), the panel falls back to file export (S-08) automatically.

- **Change ID:** resolve-plugin-handoff
- **PRD refs:** FR-030, FR-031, US-02
- **Prerequisites:** S-01, S-05, S-08, F-02
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - Is the Workflow Integration runtime viable and can the Tauri frontend be reused inside it? — **Resolved by F-02 (verdict `Go-with-rework`, 2026-06-11).** Runtime is viable (Electron Workflow Integration; panel hosting confirmed live in Studio); frontend reuses via Strategy 2 (keep HTML/CSS/JS, rebuild the Tauri `invoke` bridge as an Electron `contextBridge`/`ipcRenderer` bridge + reimplement the 6 post-F-01 commands in Node). Integration contract: `context/changes/f-02/decision.md`.
  - **`CreateSubtitlesFromAudio` availability** — the Resolve 18.5+ subtitles API needs verification; is it accessible via the Workflow Integration runtime (Studio-only scripting scope)? If not, the frame-by-frame fallback via subtitle track creation must be scoped. — Owner: team. Block: no (both paths lead to subtitle insertion; verify during implementation).
  - **Timeline audio extraction in-plugin** — does the Resolve API expose a render-to-file call (e.g. `project:RenderSingleClip()`) that can extract a wav/mp4 from the current timeline without the user manually exporting first? Or must the plugin invoke an FFmpeg sidecar against the source media referenced in the Media Pool? — Owner: team. Block: no (either path works; the render-to-file route is cleaner; investigate at implementation time).
  - **S-05 engine bridge** — the WhisperX sidecar currently lives inside a Tauri `externalBin`; in the Electron bridge rebuild it needs to be spawned as a child process from Node (`child_process.spawn`) with the same audio-extraction + word-alignment pipeline. — Owner: team. Block: no (scoped rework, analogous to the other command reimplementations).
- **Risk:** The headline differentiator and the largest single technical risk. F-02 returned `Go-with-rework`: no hard blocker, but the Tauri→Electron bridge rebuild + packaging/signing are scoped rework. The subtitle insertion path (mode C) depends on Resolve Studio 18.5+ API availability; the frame-by-frame fallback adds surface area. The file-export set (S-08) remains the always-available fallback.
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

### S-21: Random app crash — diagnose and fix

- **Outcome:** The app no longer randomly closes mid-session during `npm run tauri dev`. Root cause is identified (Rust panic, unhandled JS exception, Tauri IPC crash, sidecar OOM, or OS-level signal) and fixed — with a reproducibility note and a regression guard where possible.
- **Change ID:** app-crash-fix
- **PRD refs:** — (stability; blocks all interactive testing of every other slice)
- **Prerequisites:** —
- **Parallel with:** — (blocks interactive QA of every other slice; fix first)
- **Blockers:** —
- **Unknowns:**
  - What triggers the crash and how reproducible is it? Is it a Rust panic (logged in the Tauri dev console), a JS unhandled rejection, a sidecar OOM, or an OS signal? — Owner: team. Block: yes (investigation is the first step).
  - Does it only happen in dev mode (`tauri dev`) or also in a production build? — Owner: team. Block: no (fix targets dev mode first; if prod-only, scope changes).
- **Risk:** Low surface if the cause is a known Rust panic (Tauri logs it). Higher if intermittent OS-level or sidecar-related. Must not introduce log-suppression or silent crash-swallowing as a "fix" — the real cause must be eliminated.
- **Status:** done

### S-20: Word-by-word SRT export — fix broken implementation

- **Outcome:** The word-by-word SRT export (S-19) actually works in the app: the "Eksport słowo-po-słowie" checkbox in the WhisperX advanced modal triggers per-word cues when clicked, the auto-align fallback runs when word data is missing, and the saved `.srt` opens cleanly in a caption viewer.
- **Change ID:** word-srt-fix
- **PRD refs:** FR-005 (extends — same target as S-19; this closes the implementation gap)
- **Prerequisites:** S-19
- **Parallel with:** —
- **Blockers:** —
- **Unknowns:**
  - What exactly is broken? S-19 was archived with all manual steps ticked but the ticks were not earned — the feature was never tested in the running app. There are already two uncommitted bug-fix hunks in the tree (`transcript.js` end-clamp safeguard, `export-popover.js` `hasFrameWords` tightened to require both `start_frame` AND `end_frame`). Root cause is unknown until the app is run.
- **Risk:** Low surface (same files as S-19: `transcript.js`, `export-popover.js`, `transcribe.js`). The regression suite already covers the timing logic (Test 15); manual verification is the missing gate. If the uncommitted fixes are sufficient, this slice is a commit + a manual run. If deeper issues surface (e.g. align path doesn't populate `words[]`, or the checkbox state doesn't persist), the plan expands.
- **Status:** done

### S-19: Word-by-word SRT export — reels-ready captions

- **Outcome:** Editor exports a **word-by-word** `.srt` (one word per cue) built from the word-level forced-alignment timestamps S-05 already produces, suitable for dropping straight into TikTok / Instagram Reels as caption text. Each cue's **start is pinned to the word's real audio onset** (integer-frame, never moved); every word is held on screen for at least a **minimum duration of 4 frames** (≈160 ms at 25 fps, computed at the project fps), and any word shorter than the floor is **lengthened only on its right side** (the end pushed later, the onset left untouched) so captions stay legible without drifting off the audio. The export goes through the **save-location prompt** (native dialog), like every other save.
- **Change ID:** word-level-srt-export
- **PRD refs:** FR-005 (extends — `.srt incl. word-level`; this is the per-word/caption variant with onset-pin + min-length + right-pad rules); supports the "~0% mid-word" cut-accuracy intent (PRD §53/§76) at word-caption granularity
- **Prerequisites:** S-05 (word-level forced alignment supplies the per-word onset/offset timestamps; without it there is no word-level source data)
- **Parallel with:** S-07, S-08 (independent export surface; no shared frame-math beyond the integer-frame invariant)
- **Blockers:** —
- **Unknowns:**
  - **Right-pad collision policy** — when a word's 4-frame floor would push its end past the *next* word's onset, does the extension clamp to the next onset (no overlap, cue may stay below the floor) or are brief overlaps allowed? — Owner: user. Block: no (default: clamp to next onset — onsets are sacred, overlap-free SRT is the safer reels import; revisit if too many sub-floor cues result).
  - **fps basis for the floor** — "4 frames at 25 fps" is ~160 ms; honor the integer-frame invariant by computing 4 frames at the *project* fps, or fix the floor at a constant ~160 ms regardless of fps? — Owner: user. Block: no (default: 4 frames at project fps, per the frame-math invariant).
  - **New export vs. replace** — does this become a new entry in the export popover (alongside the existing sentence-level SRT/VTT) or replace the current SRT export? — Owner: user. Block: no (default: additive new option labelled in Polish; keep the existing transcript SRT/VTT).
- **Risk:** Low–moderate. Pure read of existing alignment data → string output, but it is **not** routed through `mergeAdjacentClips` (that is the *reel-span* source, not a per-word caption source) — keep the two paths separate so caption generation never perturbs the exporter span pipeline. All cue timing must stay integer-frame (`Math.round(s * fps)`, no mid-pipeline seconds rounding). Add a regression case in `test/regression.js` covering the onset-pin, the 4-frame floor, and right-side-only padding (incl. the collision clamp). All new user-facing strings stay Polish.
- **Status:** done

### S-22: Segment chunk-size slider — word-level segmentation granularity

- **Outcome:** Editor adjusts a slider that controls how the transcript is chunked into the numbered segments AI selection works over — from full punctuation-terminated **sentences** (today's default) down to fine-grained **word-level / N-word chunks** — built directly from the word-level forced-alignment timestamps S-05 already produces. Finer chunks give selection and the exporters more, smaller cut points pinned to real word onsets/offsets, so reel boundaries land on word boundaries (~0% mid-word) instead of approximate sentence ends. The slider has a sensible default, lives in the **settings window** and **persists across sessions** (alongside the merge-gap), re-segments live when moved, and the resulting numbered segments feed AI selection and the EDL/XML/Lua exporters through the existing pipeline unchanged.
- **Change ID:** segment-chunk-slider
- **PRD refs:** FR-006 (extends — segment granularity becomes a user-tunable knob, not a fixed sentence merge); supports the cut-accuracy wedge (~0% mid-word, PRD §53/§76). Adjacent to the parked S-06 word-level boundary trim (this is *upstream chunk size*, not per-boundary nudging).
- **Prerequisites:** S-05 (word-level forced alignment supplies the per-word onset/offset timestamps the chunker splits on; without it there is no sub-sentence word data to chunk).
- **Parallel with:** S-07, S-08, S-19 (independent segmentation knob; no shared frame-math beyond the integer-frame invariant).
- **Blockers:** —
- **Unknowns:**
  - **Chunk unit** — does the slider count words-per-segment, target a duration window, or interpolate sentence→word granularity? — Owner: user. Block: no (default: words-per-chunk, with the sentence as the natural upper bound so a max setting reproduces today's sentence segments).
  - **Re-chunk vs. existing selection** — moving the slider changes segment IDs, but reels reference segments as ordered `clip_ids`; do existing reels remap or invalidate on re-chunk? — Owner: team. Block: no (default: the chunk size is locked in *before* AI selection; changing it after selection warns and re-segments, requiring a re-run rather than silently remapping IDs).
  - **Interaction with the merge-gap (S-04)** — the export-span `mergeAdjacentClips` threshold and this upstream chunk size are two different knobs; confirm they compose (finer chunks upstream + merge collapse downstream) without double-counting or fighting each other. — Owner: team. Block: no.
- **Risk:** Touches the **regression-fenced parser** — `src/parser/srt.js` (`parseSRT` sentence-merge) and `src/parser/segments.js`. Segment IDs become slider-dependent, so the `clip_ids` → segment contract must stay consistent (re-segment before selection, or remap deterministically). Keep timeline math integer-frame only (`Math.round(s * fps)`, no mid-pipeline seconds rounding). Must **not** perturb `mergeAdjacentClips` — that is the *reel-span* source (downstream span collapse), distinct from this *segmentation chunk size* (upstream). Add a regression case per granularity setting (sentence / N-word / per-word) proving gap-free coverage and correct word-boundary onsets. Run `node --experimental-vm-modules test/regression.js` before and after. All new user-facing strings stay Polish.
- **Status:** proposed

### S-23: Stop / cancel in-flight AI analysis

- **Outcome:** Editor can abort a running AI analysis at any time via a **Stop** button that takes over the "Analizuj z OpenRouter" action while a request is in flight. OpenRouter latency swings widely by model — a slow or hung model no longer locks the editor into waiting. Clicking Stop aborts the in-flight `fetch` (`AbortController`), restores the Analyze action and clears the spinner, leaves any existing reels untouched, and surfaces a Polish "anulowano" toast instead of an error. No partial or aborted response is ever parsed, validated, or fed into the selection/export pipeline.
- **Change ID:** stop-ai-analysis
- **PRD refs:** — (UX/robustness on the selection action; serves US-01 review-speed by never blocking the editor on a slow/hung model)
- **Prerequisites:** S-01 (the scored-selection analysis call — `callOpenRouter` in `step2-prompt-panel.js` — that this cancels)
- **Parallel with:** essentially all slices (isolated to the analyze action; no shared state with the pipeline)
- **Blockers:** —
- **Unknowns:**
  - **Cache interaction** — `withLlmCache` wraps the call; an aborted request must **not** write a cache entry (no partial/empty result cached, no poisoned hash). — Owner: team. Block: no (abort short-circuits before the cache write; only a full successful response caches).
  - **Button affordance** — does Stop replace the Analyze button in-place, or sit beside it as a secondary control? — Owner: user. Block: no (default: in-place toggle Analyze ⇄ Stop, mirroring the per-stage cancel pattern S-07 specifies).
- **Risk:** Low surface. `callOpenRouter` currently calls `fetch` with **no** `signal` — thread an `AbortController` through `callOpenRouter` and wire its `abort()` to the Stop button in `src/ui/step2-prompt-panel.js`. A cancelled run must fully reset the in-flight UI state (re-enable Analyze, clear spinner) and distinguish a user abort (`AbortError`) from a real network error so the editor sees "anulowano", not a failure. Share the cancellation primitive with the per-stage cancel button S-07 introduces so auto-mode reuses it. Keep all strings Polish. No parser/exporter/frame-math impact.
- **Status:** done

### S-24: Windows port — sidecars, credential store, installer

- **Outcome:** The full app runs natively on Windows (x86_64). The two platform-coupled native dependencies are rebuilt for Windows and bundled correctly; API keys move to the Windows Credential Manager; the app ships as an MSI/NSIS installer. A Windows editor imports a video, transcribes locally, scores reels, and exports EDL/XML/Lua/SRT exactly as on macOS — with no manual install steps beyond the installer. Continued on a Windows system (separate build + verification machine).
- **Change ID:** windows-port
- **PRD refs:** — (cross-platform delivery; PRD §Non-Goals lists Linux out but flags "macOS-first, **Windows later**" — this is the "later")
- **Prerequisites:** S-05 (the WhisperX + FFmpeg sidecar architecture this re-targets), S-11 (the `keyring`-backed credential abstraction this re-points at Windows Credential Manager)
- **Parallel with:** essentially all macOS feature work (a separate build target; touches packaging/native deps, not the JS feature surfaces)
- **Blockers:** Access to a Windows build+test machine (the user continues this slice on Windows). NVIDIA driver / CUDA toolkit availability if GPU acceleration is in scope.
- **Unknowns:**
  - **WhisperX engine on Windows — GPU vs CPU configuration (the big one)** — the PyInstaller onefile sidecar must be rebuilt on Windows with a Windows torch build. Decide the acceleration target: CUDA (NVIDIA — much faster, but requires the matching `torch`+CUDA wheel, cuDNN/cuBLAS DLLs bundled or detected, and a driver floor) vs. a CPU-only build (portable, slow), vs. shipping both and selecting at runtime. macOS uses MPS/CPU — none of that translates. — Owner: user. Block: yes (defines sidecar size, speed, and minimum-spec story; resolve before building the sidecar).
  - **Build scripts are bash** — `sidecar/build.sh` and `sidecar/fetch-ffmpeg.sh` are macOS/bash. Need a Windows equivalent (PowerShell / `.bat`, or run under Git-Bash/WSL) to produce `whisperx-engine-x86_64-pc-windows-msvc.exe`, fetch a **static** Windows FFmpeg (`ffmpeg-x86_64-pc-windows-msvc.exe`), and stage `align_models/` beside the binary. — Owner: user. Block: no (mechanical port of the existing scripts).
  - **`keyring` Windows backend** — mirror the S-11 `apple-native` lesson: the crate ships no store by default. Enable the `windows-native` feature in `Cargo.toml` or Credential Manager writes silently no-op. Verify the boot-time hydrate + the (macOS-only) localStorage→Keychain migration is a no-op / correctly scoped on Windows. — Owner: user. Block: no (one Cargo feature + a verification pass).
  - **`tauri.conf.json` externalBin + bundle targets** — `externalBin` entries are architecture-suffixed; Tauri resolves the `-x86_64-pc-windows-msvc.exe` variants per target, so both the macOS and Windows suffixed binaries must exist for their respective builds. Add Windows bundle targets (`msi`/`nsis`) and a code-signing path (Windows Authenticode cert — distinct from Apple notarization). — Owner: user. Block: no.
  - **Path / shell assumptions in Rust + docs** — audit `whisper.rs` / `ffmpeg.rs` / `waveform.rs` and the cache-dir logic for POSIX path or `~/.cargo/bin/cargo` assumptions; Windows path separators, `appCacheDir`, and the FFmpeg spawn must all resolve. — Owner: team. Block: no.
- **Risk:** Largest surface outside the feature set — it is a *configuration + packaging* slice, not a logic change, but it spans the whole native bottom layer (two sidecars, the credential store, the bundler, signing) and can only be validated on real Windows hardware. The CUDA-vs-CPU decision dominates: get it wrong and the sidecar is either multi-GB-unshippable or unusably slow. The frontend JS, parser, exporters and frame-math are platform-agnostic and should need **no** changes — keep it that way (run `node --experimental-vm-modules test/regression.js` on Windows to confirm the pipeline is byte-identical). All user-facing strings stay Polish. Reuse the macOS sidecar contract verbatim where possible so the two platforms don't diverge into separate codepaths.
- **Status:** proposed

### S-25: Cost-optimized multi-stage AI analysis — two models, prompt caching

- **Outcome:** Editor cuts the cost (and avoids the output-token truncation) of analysing a long transcript by running AI selection as a **two-stage — optionally three-stage — pipeline driven by two separately-chosen OpenRouter models**, instead of one expensive single-shot call over all segments:

  **Stage 1 — Cluster / filter (cheap, big-context model).** The full numbered-segment list (`[SEG-001]…`) goes to a high-context, low-cost model that returns only **N candidate themes, each as a catchy title + a list of candidate segment IDs** — no segment text echoed back, so the *output* stays tiny even when the *input* is the whole transcript. This is the "swallow 700 segments and sort them into piles" step from `idea.md`.

  **Stage 2 — Curate (premium creative model).** Each theme bucket (~N candidate IDs, a small input) is passed to a second, higher-quality model that picks the best segments, orders them into a high-retention flow, and emits the **existing S-01 scored schema unchanged** (`virality_score` Hook/Flow/Value/Trend + `reason` + `hook/body/punchline` markers) so every downstream consumer — step-2 reel list, EDL/XML/Lua exporters — stays byte-compatible. Buckets run independently, so no single call can hit the output ceiling.

  **Stage 3 — Optional final polish (off by default).** A cheap global pass de-duplicates segments reused across reels and fixes cross-reel ordering; skipped unless enabled.

  For short transcripts (below a segment-count threshold) the pipeline auto-collapses to the **legacy single-shot call** so small jobs don't pay the two-call overhead; the editor can override the auto choice.

  **Cost levers layered in (research-backed):**
  - **Prompt caching** (`cache_control: { type: "ephemeral" }` on the large, stable transcript prefix) so the full segment list is billed at the cached rate (~10% of input on supporting providers) across the Stage-1 re-runs *and* every Stage-2 bucket call, instead of re-sending the whole transcript at full price each time. OpenRouter passes `cache_control` through to Anthropic/Gemini/Qwen-class providers and reports `usage.prompt_tokens_details.cached_tokens`; it is silently ignored by providers that don't support it (no error).
  - **Per-stage disk cache** — the existing `withLlmCache` (exact-match) is keyed **per stage and per bucket**, so re-running only Stage 2 (e.g. after editing the curate prompt) doesn't re-pay Stage 1, and a re-analyse of an untouched bucket is free.
  - **Usage / cost readout** — surface OpenRouter usage accounting (cached vs. fresh input tokens, completion tokens, and est. cost per stage) in the UI after a run, so the saving is visible and the model choice is decidable rather than blind.

- **Change ID:** cost-optimized-ai-analysis
- **PRD refs:** — (no single FR; serves the **NFR prompt-caching** + repeatability requirements behind S-01, and **promotes** the parked "Two-stage long-form chunking" deferred item — see Parked). Validate-before-use (FR-018) extends to the new Stage-1 cluster schema.
- **All UI changes (this slice is mostly a UI + orchestration reshape over S-01's call):**
  - **Settings window (S-16):** **two OpenRouter model pickers** instead of one — a Stage-1 *"Model klastrowania (tani, długi kontekst)"* and a Stage-2 *"Model kuracji (jakość)"*, each a reuse of `src/ai/openrouter-picker.js`, both persisted across sessions alongside the merge-gap. A single OpenRouter key in the keychain backs both (see Unknowns). A toggle for the optional Stage 3 and the auto-single-shot threshold also live here.
  - **Prompt presets (S-03):** the editable system/user prompt splits into a **cluster prompt** and a **curate prompt**, each with its own preset library + Polish starters; the cluster prompt must elicit the `{ themes: [{ title, candidate_ids[] }] }` shape, the curate prompt the existing scored schema.
  - **Analyze action:** *"Analizuj z OpenRouter"* now drives the staged run with a **continuous staged-progress indicator** — Stage 1 → "found K themes" → Stage 2 per-bucket ticks — reusing S-07's staged-progress pattern. The **Stop** button (S-23) cancels the whole pipeline (both stages) via the shared `AbortController`.
  - **Cost/usage panel:** a compact post-run readout (cached tokens, fresh tokens, est. cost, per stage), in Polish.
- **Prerequisites:** S-01 (the scored-selection call + schema this re-architects), S-03 (per-stage editable prompts + presets), S-16 (the settings window the two model pickers live in)
- **Parallel with:** S-08 (export set — untouched; Stage-2 schema is byte-identical), S-22 (chunk slider — orthogonal; finer chunks *raise* segment count, which is exactly the case this slice makes cheap)
- **Coordinate with:** S-07 (one-click auto mode must drive both stages, not the legacy single call), S-23 (Stop must abort mid-stage)
- **Blockers:** —
- **Unknowns:**
  - **One key or two?** — "two OpenRouter inputs" = two **model** pickers backed by one account key, or two **separate** keys (e.g. split billing / two accounts)? — Owner: user. Block: no (default: two model pickers, single keychain key; add a second keychain account only if separate billing is wanted).
  - **`cache_control` reach** — the prompt-cache discount only lands on providers that honour it (Anthropic, Gemini 2.5, Qwen); a cheap clustering model without caching gets the two-stage *architecture* win but not the cache win. Confirm the recommended Stage-1 models support both long context and caching. — Owner: team. Block: no (apply `cache_control` opportunistically; it's a no-op elsewhere).
  - **Theme/bucket sizing** — fixed (`idea.md`: ~10 themes × ~25 candidate IDs) or user-tunable in settings? — Owner: user. Block: no (default: sensible fixed defaults, exposed as advanced settings later).
  - **Auto single-shot threshold** — at what segment count does two-stage start paying off vs. the legacy one call? — Owner: team. Block: no (default: a tunable segment-count threshold with manual override; measure on a real transcript).
  - **ID integrity across stages** — Stage 1 returns candidate IDs the model could hallucinate; Stage 2 must only see real `[SEG-nnn]` IDs. — Owner: team. Block: no (validate Stage-1 IDs against the actual segment set, drop unknowns, before building buckets).
- **Risk:** Re-architects the S-01 analysis call — the highest-value path in the app. `callOpenRouter` must grow from a fixed single-message/single-model call into a per-call (model, message-blocks-with-`cache_control`, usage-returning) call; keep the **Stage-2 output schema identical to S-01** so no exporter/`.reelproj` consumer changes (grep the field names per the CLAUDE.md rule). **Validate both** the new Stage-1 cluster schema and the reused Stage-2 scored schema before use (FR-018) — an unvalidated cluster object must never build buckets. No parser/exporter/frame-math change is intended; if any exporter input shifts, run `node --experimental-vm-modules test/regression.js` and add a case. The two-stage path adds orchestration surface (partial failure mid-bucket, cache-key fan-out, abort across stages) — make a Stage-2 bucket failure recoverable (retry that bucket, keep the rest) rather than failing the whole run. Keep all new user-facing strings Polish.
- **Status:** done

### S-26: Re-engineered per-phase prompts + BRAVE cohort presets

- **Outcome:** Editor gets noticeably better reels because each AI-analysis **phase** now ships a re-engineered, rubric-based prompt instead of the first-draft guidance: **Stage-1 clustering** (`DEFAULT_CLUSTER_GUIDANCE`), **Stage-2 curation** (`DEFAULT_CURATE_GUIDANCE`), and the **single-shot** fallback (`DEFAULT_SCORING_GUIDANCE`) are each rewritten as a structured `ROLE → TASK → RUBRIC → CONSTRAINTS → OUTPUT` block with explicit 0–100 score-band anchors for the Hook/Flow/Value/Trend axes and the "strong short-form clip" definition (hook in first ~3 s, one self-contained point, builds to a payoff). On top of that, the four generic `userPrompt` starters in `BUILTIN_PRESETS` are replaced by **one built-in preset per BRAVE Education cohort** (AI_devs, 10xDevs, AI_Managers, AI Product Heroes, AI_Marketers, AI_Sales, AI HR, AI_Enterprise, and an AI 360 / general preset) so the editor picks the cohort being marketed and the selection is framed for that audience. The machine-owned JSON response format + `validateReels`/`validateThemes` are untouched — the schema does not change, so no exporter/`.reelproj` consumer changes.
- **Change ID:** refactor-ai-prompts
- **PRD refs:** FR-015 (editable system prompt — re-authored defaults), FR-016 (prompt presets — cohort library); serves the `main_goal: quality` north-star intent (better selection = better reels) on the S-01/S-25 analysis path.
- **Design artifact:** `context/foundation/prompt-design.md` — the full engineered prompt text (all three per-phase guidance rewrites + all cohort presets) plus the research-backed rationale and citations. This slice *wires in* what that doc *authored*.
- **Prerequisites:** S-01 (the scored schema the curate/single-shot prompts must elicit), S-03 (the editable-guidance + preset machinery these defaults seed), S-25 (the three-phase cluster/curate/single-shot split this re-engineers per phase)
- **Parallel with:** S-08, S-22, S-24 (no shared surface — pure prompt-text + preset-seed change)
- **Coordinate with:** S-22 (finer chunks change segment granularity but not the rubric), S-25 (the two-stage orchestration these prompts run inside — must not regress the cached-prefix layout)
- **Blockers:** —
- **Unknowns:**
  - **Existing-user preset migration** — `seedPresetsIfEmpty()` only seeds on first run, so users who already hold the 4 old starters in `localStorage.edl_prompt_presets` won't see the new cohort presets. Re-seed-merge the new built-ins (by stable `builtin-brave-*` id) without clobbering user-created/edited presets, or leave existing users on the old set? — Owner: user. Block: no (default: merge-in any missing `builtin-*` ids on boot, never overwrite a preset the user has touched).
  - **Cohort list scope** — ship all nine cohort presets, or only the subset the user actively markets? Some (AI HR, AI_Enterprise, AI 360) were not on every BRAVE page at research time. — Owner: user. Block: no (default: ship all nine; they are cheap to prune in-app).
  - **Per-phase guidance language** — the rewrites keep instruction blocks English with a Polish-output directive ([[llm-prompt-instructions-english]]); the single-shot `DEFAULT_SCORING_GUIDANCE` is currently Polish, so this slice flips it to the English-instructions/Polish-output pattern for consistency. Confirm that flip is wanted (it changes a user-visible default in the settings modal). — Owner: user. Block: no (default: flip, matching the cluster/curate phases).
- **Risk:** Low surface, high leverage. No schema change, no parser/exporter/frame-math touch — `RESPONSE_FORMAT`/`CLUSTER_RESPONSE_FORMAT` and the validators stay byte-identical, so the export pipeline is unaffected (run `node --experimental-vm-modules test/regression.js` to confirm green before/after; prompts aren't exercised by the suite, so the real verification is a manual A/B analysis run on a real BRAVE recording — old vs. new prompts — judged on reel quality). Sharp edges are (1) the verbose rubric sits *after* the cacheable prefix, so keep it tight or it inflates per-bucket Stage-2 tokens (S-25 cost lever), and (2) the preset migration must not wipe user-edited presets. Keep all `userPrompt` presets and user-facing strings Polish.
- **Status:** proposed

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
| S-04       | segment-tuning-ops             | Reorder / merge / delete segments (ops need rework)     | done                  | Archived 2026-06-18 → `context/archive/2026-06-18-segment-tuning-ops/`; drag-reorder fixed via `dragDropEnabled: false` |
| S-05       | builtin-whisperx-transcription | Built-in WhisperX transcription + word-level alignment  | no                    | Needs F-01; heavy; cache migration               |
| S-07       | auto-mode-pipeline             | One-click auto mode + staged progress                   | no                    | Needs S-01, S-05                                 |
| S-08       | timeline-export-set            | Premiere XML / FCPXML / Resolve Lua export set          | no                    | Needs S-01                                       |
| S-09       | resolve-plugin-handoff         | DaVinci Resolve embedded plugin — full integration (auto audio collect, in-panel transcription, subtitle track insertion, reel timelines) | yes | F-02 verdict `Go-with-rework`; plan against decision.md; S-05 engine bridge needed |
| S-11       | keychain-credentials           | Move API keys to OS keychain                            | yes                   | No prerequisite; parallel hardening              |
| S-16       | ui-ux-redesign                 | UI/UX redesign — step-shell rewrite, simpler flow       | yes                   | Prereq-free; land early                          |
| S-17       | feature-pruning-cleanup        | Feature pruning & cleanup pass                          | yes                   | Prereq-free; recurring de-bloat of backlog + code |
| S-18       | whisperx-engine-check-speedup  | Speed up the WhisperX engine availability check         | yes                   | Needs S-05 (shipped); perf fix, profile first    |
| S-19       | word-level-srt-export          | Word-by-word SRT export — reels-ready captions          | done                  | Archived 2026-06-18; implementation broken — tracked by S-20 |
| S-20       | word-srt-fix                   | Fix broken word-by-word SRT export (S-19 manual steps skipped) | yes            | Needs S-19 (archived); `/10x-plan word-srt-fix` |
| S-21       | app-crash-fix                  | Diagnose and fix random spontaneous app exit during `tauri dev` | yes            | Prereq-free; fix before other interactive QA; `/10x-plan app-crash-fix` |
| S-22       | segment-chunk-slider           | Segment chunk-size slider — word-level segmentation granularity | yes            | Needs S-05 (shipped); upstream chunk size, distinct from the merge-gap; `/10x-plan segment-chunk-slider` |
| S-23       | stop-ai-analysis               | Stop button to cancel in-flight AI analysis (OpenRouter lag) | yes            | Needs S-01 (shipped); thread `AbortController` through `callOpenRouter`; share cancel primitive with S-07; `/10x-plan stop-ai-analysis` |
| S-24       | windows-port                   | Windows port — sidecars (CUDA/CPU), Credential Manager, MSI/NSIS installer | yes | Needs S-05 + S-11 (shipped); continued on Windows machine; resolve CUDA-vs-CPU WhisperX config first; `keyring` `windows-native` feature; port the bash build scripts; `/10x-plan windows-port` |
| S-25       | cost-optimized-ai-analysis     | Cost-optimized two-stage AI analysis (cluster → curate), two models, prompt caching | yes | Needs S-01 + S-03 + S-16 (shipped); two OpenRouter model pickers in settings; `cache_control` on transcript prefix + per-stage `withLlmCache`; keep Stage-2 schema = S-01; promotes parked "two-stage long-form chunking"; `/10x-plan cost-optimized-ai-analysis` |
| S-26       | refactor-ai-prompts            | Re-engineered per-phase rubric prompts + BRAVE cohort presets | yes | Needs S-01 + S-03 + S-25 (shipped); engineered text authored in `context/foundation/prompt-design.md`; rewrites the 3 `DEFAULT_*_GUIDANCE` blocks + replaces `BUILTIN_PRESETS` with 9 BRAVE-cohort presets; no schema change; decide preset re-seed-merge for existing users; `/10x-plan refactor-ai-prompts` |

## Open Roadmap Questions

1. **What is the `delivery_weeks` estimate for this change?** — Owner: user. Block: `roadmap-wide` (pacing only; does not block any specific slice). Sustained after-hours effort acknowledged 2026-06-10; no hard deadline.
2. ~~**Is the DaVinci Resolve Workflow Integration plugin runtime viable, and can the Tauri frontend be reused inside it?**~~ — **RESOLVED 2026-06-11 by F-02 (`resolve-plugin-spike`): verdict `Go-with-rework`.** Runtime viable (Electron Workflow Integration); frontend reuses via Strategy 2 with a rebuilt Electron bridge. S-09 unblocked; integration contract in `context/changes/f-02/decision.md`.
3. **WhisperX bundling + cache migration** — how to ship WhisperX (+ alignment, + optional pyannote diarization with HF-token handling) as a built-in engine replacing the PATH `whisper-cli`, preserving or migrating the SRT+word-JSON cache contract? — Owner: team. Block: no (a hard build task inside S-05, surfaced here because it spans transcription + caching + packaging).

## Parked

- **In-app video render / video editor (any future return)** — Why parked: PRD §Non-Goals hard lock — "its absence is the product's identity." (Note: F-01 *removes* the existing render path; this entry blocks it ever coming back.)
- **Cloud / SaaS / collaboration / hosted AI** — Why parked: PRD §Non-Goals hard lock — fully local, single-user.
- **Browser/web version of the app** — Why parked: PRD §Non-Goals (from AppContext.md).
- **Linux support** — Why parked: PRD §Non-Goals; macOS-first. (Windows is no longer "later" — promoted to slice **S-24** `windows-port`; Linux stays parked.)
- **General plugin architecture beyond the Resolve integration** — Why parked: PRD §Non-Goals.
- **Multi-region / high-availability architecture** — Why parked: PRD §Non-Goals; single device.
- **URL ingest (YouTube/Vimeo)** — Why parked: PRD §Non-Goals deferred set (later change).
- **CapCut draft export** — Why parked: PRD §Non-Goals deferred set.
- **A/B provider comparison + merge** — Why parked: PRD §Non-Goals deferred set.
- **Batch API** — Why parked: PRD §Non-Goals deferred set.
- **Two-stage long-form chunking** — ~~Why parked: PRD §Non-Goals deferred set.~~ **Promoted 2026-06-23 to slice S-25 (`cost-optimized-ai-analysis`)** — the cluster → curate two-stage pipeline (with two selectable OpenRouter models + prompt caching) is now the cost-optimization path for AI analysis, no longer deferred.
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
- **S-04: reorder, merge, delete segments (reorder/merge/delete ops need rework)** — Archived 2026-06-18 → `context/archive/2026-06-18-segment-tuning-ops/`. Diagnosis showed delete/merge already worked; only drag-reorder was broken because Tauri's webview intercepted HTML5 drag events — fixed with one config flip (`dragDropEnabled: false`), `moveClip()` untouched. Lesson: Tauri's webview swallows HTML5 drag-and-drop by default; set `dragDropEnabled: false` on the window to hand DnD to the frontend (and it governs the HTML5 file-drop import too — no native `onDragDropEvent` listener to lose).
- **S-25: cut AI-analysis cost via a two-stage (cluster → curate) pipeline with two selectable OpenRouter models + prompt caching** — Archived 2026-06-24 → `context/archive/2026-06-23-cost-optimized-ai-analysis/`. Phase-2 evidence gate ran OPEN (two strong single-shot models both plateaued on long mixed-topic input), so built instrumentation + model tiering + cluster→curate pipeline + Stage-1 minification (Phases 1,3,4,5); Phase 2a skipped. Lesson: a `cache_control` provider-cache lever is inert when an exact-match disk cache sits in front of the call and the marker isn't isolating a stable prefix — the disk cache serves prompt-identical re-runs before the network, so the provider cache never fires (impl-review F1).
- **S-11: store API keys in the OS keychain, never plaintext** — Archived 2026-06-18 → `context/archive/2026-06-18-keychain-credentials/`. `keyring`-crate `keychain.rs` get/set/delete commands + hydrated `src/ai/api-key.js` cache (sync `getApiKey`, async write-through `setApiKey`, boot `hydrateKeys()` with one-time localStorage→Keychain migration); R2 accessor folded in. Lesson: the `keyring` 3.x crate ships NO credential store by default (silent in-memory mock) — enable `apple-native` in Cargo.toml or Keychain writes don't persist.
- **S-19: export a word-by-word SRT (one word per cue), onset-pinned with a ≥4-frame minimum, ready to drop into TikTok/Reels captions** — Archived 2026-06-18 → `context/archive/2026-06-18-word-level-srt-export/`. Lesson: —.
- **S-21: The app no longer randomly closes mid-session during `npm run tauri dev`. Root cause is identified (Rust panic, unhandled JS exception, Tauri IPC crash, sidecar OOM, or OS-level signal) and fixed — with a reproducibility note and a regression guard where possible.** — Archived 2026-06-22 → `context/archive/2026-06-19-app-crash-fix/`. No single smoking gun; hardened the most plausible silent-exit mechanisms — bounded the unbounded WhisperX `stderr_buf` (top OOM amplifier), closed the cancel/completion orphan race so a cancelled run is always reaped (single atomic reaper), switched release `panic = unwind`, and added a Rust `[PANIC]` hook + JS global error/rejection handlers so the next crash is no longer silent. Lesson: `drop(CommandChild)` does NOT kill the OS process — a cancelled sidecar must be explicitly reaped (SIGTERM→SIGKILL) by a single deterministic owner, or orphaned torch workers accumulate into cumulative OOM.
- **S-20: The word-by-word SRT export (S-19) actually works in the app: the "Eksport słowo-po-słowie" checkbox in the WhisperX advanced modal triggers per-word cues when clicked, the auto-align fallback runs when word data is missing, and the saved `.srt` opens cleanly in a caption viewer.** — Archived 2026-06-22 → `context/archive/2026-06-19-word-srt-fix/`. Lesson: —.
- **S-07: Editor triggers a one-click automatic run (after an API key is set, with confirmation) that drives import → transcription → alignment → diarization → segmentation → AI selection and auto-advances, with the ability to return to earlier steps; a single continuous staged progress indicator shows per-stage %, a per-stage cancel button, and no blocking modal.** — Archived 2026-06-24 → `context/archive/2026-06-22-auto-mode-pipeline/`. Lesson: —.
- **S-23: cancel an in-flight AI analysis with a Stop button when OpenRouter is slow/laggy (varies by model)** — Archived 2026-06-22 → `context/archive/2026-06-22-stop-ai-analysis/`. Lesson: —.
- **S-08: Editor exports FCP7 xmeml `.xml` (Premiere), `.fcpxml` (Final Cut Pro X, generated separately from xmeml), and a DaVinci Resolve `.lua` console script — all carrying the new markers and importing cleanly.** — Archived 2026-06-24 → `context/archive/2026-06-22-timeline-export-set/`. Lesson: —.
