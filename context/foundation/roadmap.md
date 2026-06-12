---
project: Reels Automator
version: 1
status: draft
created: 2026-06-10
updated: 2026-06-11
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
| R1    | split-step2-analyze         | (refactor) split `step2-analyze.js` into per-surface modules so S-02/S-03/S-04/S-14/S-15 own separate files | F-01 | — (enabler; streams.md R1)                | proposed |
| R2    | api-key-accessor            | (refactor) replace direct `localStorage.edl_apikey_*` reads with a `getApiKey()/setApiKey()` helper | —          | — (enabler; streams.md R2)                    | proposed |
| S-01  | scored-selection-edl        | get AI reels scored on Hook/Flow/Value/Trend and export a clean EDL | F-01        | FR-010, FR-011, FR-012, FR-014, FR-017, FR-018, FR-026, FR-033 | proposed |
| S-02  | scoring-first-reel-list     | triage reels in a score-sorted list with reasons             | S-01               | FR-020                                        | proposed |
| S-03  | prompt-presets              | edit the system prompt and manage reusable prompt presets    | S-01               | FR-015, FR-016                                | proposed |
| S-04  | segment-tuning-ops          | reorder, merge, delete segments and strip filler words       | S-01               | FR-022, FR-023                                | proposed |
| S-05  | builtin-whisperx-transcription | transcribe locally with word-level alignment + manage models | F-01            | FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007 | proposed |
| S-06  | word-level-boundary-trim    | nudge cut boundaries at word precision with snap-to-pause    | S-04, S-05         | FR-021                                        | proposed |
| S-07  | auto-mode-pipeline          | run the whole pipeline in one click with staged progress     | S-01, S-05         | FR-008, FR-009                                | proposed |
| S-08  | timeline-export-set         | export Premiere XML, FCPXML and Resolve Lua (with markers)   | S-01               | FR-027, FR-028, FR-029                        | proposed |
| S-09  | resolve-plugin-handoff      | push reels into Resolve from inside Resolve in one click     | S-01, S-08, F-02   | FR-030, FR-031, US-02                         | go-with-rework |
| S-10  | en-pl-i18n                  | switch the whole UI between English and Polish               | S-02, S-04         | FR-034                                        | proposed |
| S-11  | keychain-credentials        | store API keys in the OS keychain, never plaintext           | —                  | FR-035                                        | ready    |
| S-12  | empty-error-states          | see explicit empty/error states instead of silent failures   | S-01, S-05         | FR-036                                        | proposed |
| S-13  | keyboard-navigation         | drive review and tuning entirely from the keyboard           | S-02, S-04         | FR-037                                        | proposed |
| S-14  | selection-quality-flags     | get source-grouping and dangling-reference flags             | S-01               | FR-013, FR-025                                | proposed |
| S-15  | reel-preview-playback       | preview a reel's playback synced to its segment list         | S-04               | FR-024                                        | proposed |

## Streams

Navigation aid — groups items that share a Prerequisites chain. Canonical ordering still lives in the dependency graph below; this table is the proposed reading order across parallel tracks.

| Stream | Theme                       | Chain                                                        | Note                                                                 |
| ------ | --------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------- |
| A      | Selection & export deck     | `F-01` → `S-01` → `S-02` / `S-03` / `S-04` → `S-08` → `S-14` / `S-15` | The north-star spine; quality goal fronts the scored-selection loop. |
| B      | Local transcription         | `S-05` → `S-06` / `S-07` / `S-12`                           | Branches from `F-01`; word-level alignment unlocks the cut-accuracy criterion. |
| C      | Resolve integration         | `F-02` → `S-09`                                             | Spike-first (top blocker = decisions); `S-09` joins Stream A at `S-08`. |
| D      | i18n, security & keyboard   | `S-11` / `S-10` / `S-13`                                    | `S-11` is standalone-ready; `S-10` and `S-13` join Stream A at `S-04`. |

## Baseline

What's already in place in the codebase as of 2026-06-10 (auto-researched + user-confirmed).
Foundations below assume these are present and do NOT re-scaffold them.

- **Frontend:** present — vanilla JS + Vite, `src/ui/stepN-*.js` pipeline over a single `state.js` pub/sub.
- **Backend / API:** present — Rust Tauri 2 commands registered in `src-tauri/src/lib.rs`.
- **Data / persistence:** present — `.reelproj` JSON (schema v2) via `src-tauri/src/project.rs`, serde defaults for back-compat.
- **Transcription:** partial — `src-tauri/src/whisper.rs` shells out to `whisper-cli` on PATH (not bundled, no built-in word-level alignment, no diarization). Rebuilt by S-05.
- **AI selection:** partial — `src/ai/providers.js` + `prompt.js` exist, but the schema is the OLD title/hook/description shape: no `virality_score`, no `hook/body/punchline` markers, no `cache_control` prompt-caching. Rebuilt by S-01.
- **Credentials:** plaintext — API keys live in `localStorage` (`edl_apikey_*`); no OS keychain. Migrated by S-11.
- **i18n:** absent — all user-facing strings are hardcoded Polish; no translation-key layer. Added by S-10.
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

- **Outcome:** (refactor) the 1408-line `src/ui/step2-analyze.js` is carved into `step2-reel-list.js` (→ S-02), `step2-prompt-panel.js` (→ S-03), and `step2-segment-ops.js` (→ S-04), leaving `step2-analyze.js` as a thin orchestrator — so S-02/S-03/S-04/S-14/S-15 each own a distinct file instead of serializing on the shared hot file.
- **Change ID:** split-step2-analyze
- **PRD refs:** — (internal enabler; no FR)
- **Unlocks:** Wave 2 width — S-02/S-03/S-04 (and S-14/S-15) become true worktree partners rather than a serial queue on one file.
- **Prerequisites:** F-01
- **Parallel with:** none — lands as the opening move of S-01 (per `streams.md`); not co-parallel with other step2 work.
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Pure structural move — behavior must not change. Run `node --experimental-vm-modules test/regression.js` before and after. Mechanically the project's bottleneck-buster: without it, 11 slices funnel through one file.
- **Status:** proposed

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
- **Status:** proposed

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
- **Status:** proposed

### S-02: Scoring-first reel list UI

- **Outcome:** Editor sees reels as a list with a `virality_score` badge each, sortable by score, a one-line `reason` under each reel, and weaker reels visually greyed but still selectable.
- **Change ID:** scoring-first-reel-list
- **PRD refs:** FR-020; US-01 ("reels sort by score")
- **Prerequisites:** S-01
- **Parallel with:** S-03, S-04, S-08, S-14, S-11
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Pure UI over the S-01 schema; low risk. Sequenced right after the north star because the scored list is the editor's primary triage surface — the score is only useful if it's the lens for the list.
- **Status:** proposed

### S-03: Editable system prompt + presets

- **Outcome:** Editor edits the (no-longer-hardcoded) system prompt, supplies a user prompt, and manages prompt presets (save-as, duplicate, delete, edit; import/export as `.json` via path picker); built-in starter presets ship and user presets persist.
- **Change ID:** prompt-presets
- **PRD refs:** FR-015, FR-016
- **Prerequisites:** S-01
- **Parallel with:** S-02, S-04, S-08, S-14, S-05, S-11
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Preset persistence + import/export is straightforward; the only sharp edge is keeping the editable prompt in sync with the fixed JSON schema S-01 established — a free-form prompt must still elicit the validated shape.
- **Status:** proposed

### S-04: Segment tuning — reorder / merge / delete / filler removal

- **Outcome:** Editor reorders segments, merges adjacent segments (merge-threshold slider with a sensible default), deletes segments, and optionally strips filler words ("yyy", "eee", …) at word level; the filler behavior is toggleable.
- **Change ID:** segment-tuning-ops
- **PRD refs:** FR-022, FR-023
- **Prerequisites:** S-01
- **Parallel with:** S-02, S-03, S-08, S-14, S-05, S-11
- **Blockers:** —
- **Unknowns:** —
- **Risk:** `mergeAdjacentClips` remains the export-span source; changing merge behavior must keep integer-frame math intact and not regress the exporters (regression fence). Filler removal at word level is best-effort until S-05 supplies word timestamps — sentence-level fallback ships here.
- **Status:** proposed

### S-05: Built-in WhisperX transcription + word-level alignment + model manager

- **Outcome:** Editor imports a local video by drag-and-drop, runs fully-local built-in transcription producing text + word-level forced alignment with no separate install, browses a model list (downloaded vs missing) and downloads a missing model (path picker, %/speed/ETA), can instead import an existing `.srt`/`.vtt`, can export the transcript, and gets the transcript auto-split into gap-free numbered segments feeding selection directly; diarization runs in the same pass as an opt-in toggle.
- **Change ID:** builtin-whisperx-transcription
- **PRD refs:** FR-001, FR-002, FR-003, FR-004, FR-005, FR-006, FR-007
- **Prerequisites:** F-01
- **Parallel with:** S-01, S-02, S-03, S-04, S-08, S-14, S-11
- **Blockers:** Hugging Face token + pyannote model access for opt-in diarization (external — opt-in only; core transcription + alignment path is never blocked by it).
- **Unknowns:**
  - How to bundle WhisperX (+ alignment) as a built-in engine replacing the PATH `whisper-cli`, and how to migrate/preserve the existing SRT+word-JSON cache contract? — Owner: team. Block: no (a hard build task, not a viability unknown — but de-risk early).
- **Risk:** Heaviest slice on the quality path — word-level alignment is what guarantees the ~0%-mid-word primary criterion. Engine swap changes the transcription command, packaging, and cache key/format; preserve or migrate the cache so existing projects don't re-transcribe.
- **Status:** proposed

### S-06: Word-level boundary trim + snap-to-pause

- **Outcome:** Editor adjusts segment boundaries by adding/subtracting time front/back at word-level precision, with a "snap to nearest pause/breath" handle.
- **Change ID:** word-level-boundary-trim
- **PRD refs:** FR-021
- **Prerequisites:** S-04, S-05
- **Parallel with:** S-07, S-12, S-15
- **Blockers:** —
- **Unknowns:**
  - What signal defines a "pause/breath" to snap to — silence gaps in the word timing, or an audio-energy probe? — Owner: team. Block: no.
- **Risk:** Depends on S-05's word timestamps; the snap heuristic is the only real design call. Keep all arithmetic integer-frame.
- **Status:** proposed

### S-07: One-click auto mode + staged progress

- **Outcome:** Editor triggers a one-click automatic run (after an API key is set, with confirmation) that drives import → transcription → alignment → diarization → segmentation → AI selection and auto-advances, with the ability to return to earlier steps; a single continuous staged progress indicator shows per-stage %, a per-stage cancel button, and no blocking modal.
- **Change ID:** auto-mode-pipeline
- **PRD refs:** FR-008, FR-009
- **Prerequisites:** S-01, S-05
- **Parallel with:** S-06, S-08, S-12
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Orchestration over slices that must already exist; the sharp edges are cancelability mid-stage and not blocking the window. Sequenced after both the selection (S-01) and transcription (S-05) engines are real.
- **Status:** proposed

### S-08: Full timeline-export set — Premiere XML / FCPXML / Resolve Lua

- **Outcome:** Editor exports FCP7 xmeml `.xml` (Premiere), `.fcpxml` (Final Cut Pro X, generated separately from xmeml), and a DaVinci Resolve `.lua` console script — all carrying the new markers and importing cleanly.
- **Change ID:** timeline-export-set
- **PRD refs:** FR-027, FR-028, FR-029
- **Prerequisites:** S-01
- **Parallel with:** S-02, S-03, S-04, S-14
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
- **Parallel with:** S-10, S-13
- **Blockers:** —
- **Unknowns:**
  - Is the Workflow Integration runtime viable and can the Tauri frontend be reused inside it? — **Resolved by F-02 (verdict `Go-with-rework`, 2026-06-11).** Runtime is viable (Electron Workflow Integration; panel hosting confirmed live in Studio); frontend reuses via Strategy 2 (keep HTML/CSS/JS, rebuild the Tauri `invoke` bridge as an Electron `contextBridge`/`ipcRenderer` bridge + reimplement the 6 post-F-01 commands in Node). Integration contract: `context/changes/f-02/decision.md`.
- **Risk:** The headline differentiator and the largest single technical risk. F-02 returned `Go-with-rework`: no hard blocker, but the Tauri→Electron bridge rebuild + packaging/signing are scoped rework. The file-export set (S-08) remains the always-available fallback (and the only path for Resolve Free / Linux).
- **Status:** go-with-rework

### S-10: EN/PL internationalization

- **Outcome:** Editor switches the entire UI between English and Polish; all UI text comes from translation keys, not hardcoded strings.
- **Change ID:** en-pl-i18n
- **PRD refs:** FR-034
- **Prerequisites:** S-02, S-04
- **Parallel with:** S-11, S-13, S-09
- **Blockers:** —
- **Unknowns:** —
- **Risk:** A cross-cutting string-extraction refactor touching every UI file. Sequenced after the new selection-list (S-02) and tuning (S-04) surfaces exist, so strings are extracted once rather than re-extracted from UI that's about to be rewritten.
- **Status:** proposed

### S-11: API keys in the OS keychain

- **Outcome:** Editor's API keys are stored in the OS secure credential store (macOS Keychain / Windows Credential Manager) and are never persisted in plaintext.
- **Change ID:** keychain-credentials
- **PRD refs:** FR-035
- **Prerequisites:** —
- **Parallel with:** essentially all slices (no prerequisite)
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Touches every key read/write site (`edl_apikey_*` in the OpenRouter picker, step-2 selection, compare panel). Low conceptual risk; the work is finding all call sites. Independent of the selection pipeline, so it can run any time as a parallel hardening task.
- **Status:** ready

### S-12: Explicit empty/error states

- **Outcome:** Editor sees explicit empty/error states instead of silent failures: no API key (AI gated, transcription still works), whisper/model not installed, invalid LLM JSON, empty project / no reels.
- **Change ID:** empty-error-states
- **PRD refs:** FR-036
- **Prerequisites:** S-01, S-05
- **Parallel with:** S-06, S-07
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Each state belongs to a feature that must already exist (invalid-JSON ↔ S-01, model-not-installed ↔ S-05). A thin consolidation pass; the risk is missing a state, not implementing one.
- **Status:** proposed

### S-13: Keyboard-driven actions

- **Outcome:** Editor drives core actions from the keyboard: previous/next reel, accept/reject, nudge segment boundaries (word-level), and move between steps 1–2–3.
- **Change ID:** keyboard-navigation
- **PRD refs:** FR-037
- **Prerequisites:** S-02, S-04
- **Parallel with:** S-09, S-10
- **Blockers:** —
- **Unknowns:** —
- **Risk:** Depends on the reel-list (S-02) and tuning (S-04) surfaces being keyboard-targetable. Word-level nudges degrade to sentence-level until S-06 lands. The persona explicitly values keyboard speed, so this is product-relevant, not polish.
- **Status:** proposed

### S-14: Selection-quality flags — source grouping + dangling references

- **Outcome:** With multiple source files, segments are grouped and labeled (`[ŹRÓDŁO 1]`, …) and the model is forbidden to mix segments across files in one reel; reels that open on an unexplained pronoun/reference ("dangling references") are flagged and either pull in an introducing segment or have their score lowered.
- **Change ID:** selection-quality-flags
- **PRD refs:** FR-013, FR-025
- **Prerequisites:** S-01
- **Parallel with:** S-02, S-03, S-04, S-08
- **Blockers:** —
- **Unknowns:**
  - Is dangling-reference detection prompt-side (the model self-flags) or a post-pass heuristic over segment text? — Owner: team. Block: no.
- **Risk:** Both are nice-to-have refinements of the selection rule (FR-013, FR-025 are nice-to-have). They sharpen selection quality but the wedge is provable without them — kept late in Stream A.
- **Status:** proposed

### S-15: Reel preview playback

- **Outcome:** Editor optionally previews playback of a selected reel synced to its segment list.
- **Change ID:** reel-preview-playback
- **PRD refs:** FR-024
- **Prerequisites:** S-04
- **Parallel with:** S-06, S-12
- **Blockers:** —
- **Unknowns:**
  - Does preview play the source video seeked across the reel's spans, or a stitched audio-only scrub? — Owner: team. Block: no.
- **Risk:** Nice-to-have. The sidecar is kept for audio/thumbnail use, so preview need not resurrect any deleted render code — keep it strictly read/seek, never a render.
- **Status:** proposed

## Backlog Handoff

| Roadmap ID | Change ID                      | Suggested issue title                                   | Ready for `/10x-plan` | Notes                                            |
| ---------- | ------------------------------ | ------------------------------------------------------- | --------------------- | ------------------------------------------------ |
| F-01       | remove-render-path             | Remove FFmpeg render path; add regression fence         | yes                   | Run `/10x-plan remove-render-path`               |
| F-02       | resolve-plugin-spike           | Spike: Resolve Workflow Integration runtime viability   | yes                   | Resolves PRD Open Q #2; unblocks S-09            |
| R1         | split-step2-analyze            | Split step2-analyze.js into per-surface modules         | no                    | Enabler; land inside S-01 (streams.md R1)        |
| R2         | api-key-accessor               | getApiKey()/setApiKey() accessor abstraction            | yes                   | Enabler; prereq-free, land inside/ahead of S-11  |
| S-01       | scored-selection-edl           | Scored AI selection → clean EDL export (north star)     | no                    | Needs F-01                                       |
| S-02       | scoring-first-reel-list        | Scoring-first reel list UI                              | no                    | Needs S-01                                       |
| S-03       | prompt-presets                 | Editable system prompt + preset management              | no                    | Needs S-01                                       |
| S-04       | segment-tuning-ops             | Reorder / merge / delete segments + filler removal      | no                    | Needs S-01                                       |
| S-05       | builtin-whisperx-transcription | Built-in WhisperX transcription + word-level alignment  | no                    | Needs F-01; heavy; cache migration               |
| S-06       | word-level-boundary-trim       | Word-level boundary trim + snap-to-pause                | no                    | Needs S-04, S-05                                 |
| S-07       | auto-mode-pipeline             | One-click auto mode + staged progress                   | no                    | Needs S-01, S-05                                 |
| S-08       | timeline-export-set            | Premiere XML / FCPXML / Resolve Lua export set          | no                    | Needs S-01                                       |
| S-09       | resolve-plugin-handoff         | DaVinci Resolve embedded plugin (one-click hand-off)    | yes                   | F-02 verdict `Go-with-rework`; plan against decision.md |
| S-10       | en-pl-i18n                     | EN/PL internationalization                              | no                    | Needs S-02, S-04                                 |
| S-11       | keychain-credentials           | Move API keys to OS keychain                            | yes                   | No prerequisite; parallel hardening              |
| S-12       | empty-error-states             | Explicit empty/error states                             | no                    | Needs S-01, S-05                                 |
| S-13       | keyboard-navigation            | Keyboard-driven review and tuning                       | no                    | Needs S-02, S-04                                 |
| S-14       | selection-quality-flags        | Source grouping + dangling-reference flags              | no                    | Needs S-01                                       |
| S-15       | reel-preview-playback          | Reel preview playback                                   | no                    | Needs S-04                                       |

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

## Done

(Empty on first generation. `/10x-archive` appends here — and flips the matching item's `Status` to `done` — when a change whose `Change ID` matches a roadmap item is archived. Do NOT pre-populate.)

- **F-01: (foundation) FFmpeg render path deleted; regression fence green** — Archived 2026-06-11 → `context/archive/2026-06-10-f-01/`. Lesson: —.
- **F-02: (foundation) decision recorded on Resolve plugin viability** — Archived 2026-06-11 → `context/archive/2026-06-10-f-02/`. Lesson: —.
