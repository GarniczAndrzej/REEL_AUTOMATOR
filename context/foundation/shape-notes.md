---
project: "Reels Automator"
context_type: brownfield
created: 2026-06-10
updated: 2026-06-10
checkpoint:
  current_phase: 8
  phases_completed: [1, 2, 3, 4, 5, 6, 7]
  gray_areas_resolved:
    - topic: "change frame"
      decision: "strategic pivot — drop MP4 render, become local-first transcription + AI-selection tool that outputs only timelines"
    - topic: "primary persona"
      decision: "the author + similar professional video editors; focused pro tool, not mass-market SaaS"
    - topic: "core insight"
      decision: "local/private processing + a clean timeline handed INTO the editor's own NLE, vs cloud tools that emit finished render"
    - topic: "security scope"
      decision: "keychain credential storage IN scope; PIN/password app-lock DEFERRED"
    - topic: "delivery scope & timeline"
      decision: "full target state is the ambition (sustained after-hours, no deadline, delivery_weeks TBD); first deliverable keeps Resolve plugin + diarization IN; defers URL ingest, CapCut, A/B compare, Batch API, long-form chunking, private-AI"
  frs_drafted: 36
  quality_check_status: accepted
---

# Shape Notes — Reels Automator (brownfield)

> Seed: `AppContext.md` (stan docelowy / target-state spec). This file captures the
> discovery decisions that turn that target state into a PRD-ready scope.

<!-- Sections are filled phase by phase. Order anticipates the 11 brownfield PRD sections. -->

## Current System

- **System purpose:** Reels Automator turns long recordings into a selection of the best moments ("reels") and hands them to a pro NLE as an edit timeline.
- **Architecture:** Tauri 2 desktop app — Vite + vanilla-JS frontend (single mutable `state` + pub/sub), Rust backend exposing Tauri commands. Bundled FFmpeg sidecar.
- **Tech stack:** Tauri 2, Rust, vanilla JS / Vite, FFmpeg sidecar (`tauri-plugin-shell`), `whisper-cli` (invoked from system PATH — NOT bundled), LLM providers (Claude / Gemini / OpenRouter, called from the browser).
- **Current functionality:**
  - SRT/video import + Whisper transcription trigger.
  - LLM analysis that selects reels as ordered `clip_ids` over numbered sentence segments.
  - Exporters: `.edl` (CMX3600), FCP7 `.xml` (xmeml), DaVinci Resolve `.lua`.
  - **MP4 render** via FFmpeg filter graph (crop/scale 9:16, logo, subtitle burn-in, loudnorm, intro/outro, hw-encode) + concurrent render queue + face-tracking crop.
  - `.reelproj` JSON project save/load (schema v2).
- **Users today:** the author + professional editors; macOS-first.
- **All user-facing strings are Polish, hardcoded.**

## Vision & Problem Statement

**Frame: strategic pivot.** Reposition the app from "transcribe + select + *render*" to a **local-first transcription + AI-selection tool whose only deliverable is a clean editing timeline.** The FFmpeg MP4 render path (and its in-app video-editor concerns: 9:16 crop, logo, subtitle burn-in, codec matrix, render queue, face-tracking) is **legacy to be cut**, not a product feature.

The pain: manually fishing short "viral" fragments out of long recordings (podcast, interview, lecture, webinar) is the most tedious pre-edit step — transcribe, listen through everything, then hand-rebuild the cuts and their order on a timeline in the editor's own NLE. Reels Automator automates exactly that mozolny front end (transcription + moment-selection) and returns a ready-to-import timeline; all downstream work (framing, captions, logo, render) stays in the NLE the editor already uses.

**Insight (why build this when Opus Clip / Vizard exist):** existing tools are closed cloud boxes that spit out a *finished render*. Professional editors want the opposite — fully **local/private** processing (the video never leaves the machine; only transcript text goes to the LLM API), and a **clean timeline handed INTO their pro NLE**, not a finished video. Since the app no longer renders, its *only quality product* is accurate moment-selection and clean cut boundaries.

## User & Persona

**Primary persona:** a professional video editor (the author + editors with the same workflow). They live in DaVinci Resolve / Premiere Pro / Final Cut Pro / CapCut, work locally, value privacy and keyboard speed, and want the drudgery of transcription + first-pass selection removed — but insist on finishing the edit themselves in their own NLE. Not a mass-market SaaS audience; a focused pro tool.

## Access Control

Single user, single device, no accounts, no roles — local desktop app. No multi-user or collaboration (see Non-Goals).

**Change in scope:** migrate API-key storage from `localStorage` plaintext into the **OS secure credential store** (macOS Keychain / Windows Credential Manager). Keys are no longer persisted in plaintext.

**Deferred (out of scope for this change):** optional PIN / password app-lock screen at startup. Recorded as later security hardening, not part of this delivery.

## Timeline acknowledgment

Acknowledged on 2026-06-10: user committed to the **full target state** as the ambition (sustained, multi-month after-hours effort) with the first deliverable deferring four heavy items (see below). User accepted the sustained-effort cost; estimated `delivery_weeks` is **TBD** (to be refined at roadmap/plan stage). No hard deadline.

**First-deliverable scope vs deferred:**

- **In scope (first deliverable):** remove FFmpeg render path + in-app video-editor concerns; built-in local WhisperX (transcription + word-level forced alignment; **diarization as an opt-in toggle**); auto-segmentation feeding AI selection; AI selection with `virality_score` (Hook/Flow/Value/Trend) + `reason` + hook/body/punchline markers; editable system prompt + presets (CRUD, import/export); selection-tuning UI (boundary trim/snap, reorder, merge, delete, filler removal); export EDL/FCP7-XML/FCPXML/Lua; **DaVinci Resolve embedded plugin**; EN/PL i18n; keychain credentials; performance arch (prompt caching, model-per-stage, streaming, result caching).
- **Deferred (later changes):** URL ingest (YouTube/Vimeo); CapCut draft export; A/B provider comparison + merge; Batch API; two-stage long-form chunking; "private AI" prompt-export/paste-back mode; **per-reel metadata generation (title/desc/hashtags/SEO) and per-reel `.md` export** (social/SEO repurposing — moved out during the Socratic round).

## Success Criteria

### Primary
- The core pivot flow works end-to-end on a real recording: local video → local transcription with word-level alignment → auto-segmented → AI-selected reels (each with `virality_score` + `reason`) → light boundary tuning → exported timeline imports **cleanly into the editor's NLE** with no manual structural fixes. (No MP4 render in the app.)
- **AI acceptance ≥ 75%** — share of exported reels exported *without changing* the AI's `clip_ids`.
- **Cut accuracy** — ~0% of segment boundaries fall mid-word (thanks to word-level alignment); each reel contains its `punchline` marker.

### Secondary
- **Resolve plugin one-click hand-off** — from inside Resolve, reels land in a new folder of the current project via the Resolve API, no script-paste / file-import.
- **Speed-to-timeline** — time from import-complete to ready `.edl` (auto mode) is materially shorter than manually listening-through + rebuilding cuts on the same material.
- **Prompt-cache effectiveness** — `usage.cache_read_input_tokens > 0` on the 2nd+ call with the same transcript.

### Guardrails (must not regress)
- Existing exporters (EDL / FCP7 XML / Lua) still import cleanly into Resolve / Premiere / Final Cut after the render path is removed.
- Integer-frame timeline math invariants hold (no mid-pipeline rounding to seconds; CMX 3600 record-TC offset).
- `.reelproj` projects still load — including older schema versions (serde defaults).
- Removing the render path must not break the selection → segment → export pipeline.
- Video never leaves the machine; only transcript text is sent to the LLM API.

## Functional Requirements

> Change tags: `new` (doesn't exist today) · `modified` (existing behavior changes) · `preserved` (must keep working unchanged) · `removed` (deleted in this change). FRs for deferred items (URL ingest, CapCut, A/B, batch, chunking, private-AI) are intentionally NOT listed — see Non-Goals.

### Import & transcription
- FR-001: Editor can import a local video file by drag-and-drop. Priority: must-have. Change: preserved
- FR-002: Editor can run fully-local transcription (built-in WhisperX) producing text + word-level forced alignment, with no separate install; speaker diarization runs in the same pass but is an **opt-in toggle**. Priority: must-have. Change: modified
  > Socratic: Counter-argument considered: "diarization is a heavy dependency (pyannote-class model, HF token) and the core pivot works without speaker labels." Resolution: kept, but made an opt-in toggle so the core transcription + alignment path is never blocked by diarization model setup.
- FR-003: Editor can browse a built-in model list showing which models are downloaded, and download a missing model (destination path picker, % / speed / ETA). Priority: must-have. Change: new
- FR-004: Editor can import an existing transcript (`.srt` / `.vtt`) instead of transcribing. Priority: must-have. Change: modified
- FR-005: Editor can export the transcript (`.srt` incl. word-level, `.vtt`). Priority: nice-to-have. Change: new
- FR-006: Transcript auto-splits into numbered sentence segments covering the whole material with no gaps, and feeds AI selection directly without a manual export/import step. Priority: must-have. Change: modified
- FR-007: Editor can edit auto-filled project fields (name, transcript file, etc.). Priority: must-have. Change: preserved

### Auto (one-click) mode
- FR-008: Editor can trigger a one-click automatic run (after an API key is set, with confirmation) that drives import → transcription → alignment → diarization → segmentation → AI selection and auto-advances, with the ability to return to earlier steps. Priority: must-have. Change: new
- FR-009: Auto mode shows a single continuous staged progress indicator (Import → Transcription → Alignment → Diarization → Segments → AI selection) with per-stage %, a per-stage cancel button, and no blocking modal. (Metadata stage omitted — deferred.) Priority: must-have. Change: new

### AI selection
- FR-010: AI selects each reel as an ordered list of existing segment `clip_ids` (selecting/reordering, never paraphrasing the text) plus a `reel_name`. Priority: must-have. Change: preserved
- FR-011: For each reel the model returns a `virality_score` (0–100, scored on Hook / Flow / Value / Trend) and a one-sentence `reason`. Priority: must-have. Change: new
  > Socratic: Counter-argument considered: "a four-axis 0–100 score reads as false precision." Resolution: stands — since the app no longer renders, selection quality IS the product, and the score is the editor's primary triage tool.
- FR-012: For each reel the model returns `hook` / `body` / `punchline` time markers that export as timeline markers; selection must include the punchline (not cut before it). Priority: must-have. Change: new
  > Socratic: Counter-argument considered: "markers add prompt/schema complexity." Resolution: stands — the punchline marker is what prevents cutting a reel before its payoff.
- FR-013: With multiple source files, segments are grouped and labeled (`[ŹRÓDŁO 1]`, …) and the model is forbidden to mix segments from different files in one reel. Priority: nice-to-have. Change: new
- FR-014: Editor can choose the LLM provider/model (Claude / Gemini / OpenRouter) and run selection at low temperature / low effort for repeatability. Priority: must-have. Change: preserved
- FR-015: Editor can edit the system prompt and supply a user prompt; the system prompt is not hardcoded. Priority: must-have. Change: new
- FR-016: Editor can manage prompt presets (list + editor; save-as, duplicate, delete, edit; import/export as `.json` with path picker); built-in starter presets ship; user presets persist. Priority: must-have. Change: new
- FR-017: Editor can manually edit the reels JSON (segment selection). Priority: must-have. Change: preserved
- FR-018: When the LLM returns invalid JSON, the editor gets a clear error with retry / manual-paste-and-fix options (structure validated before use). Priority: must-have. Change: new
- FR-019: ~~Editor can generate per-reel metadata (title, description, hashtags, SEO keywords) in a separate pass.~~ **DEFERRED** to a later change (see Non-Goals).
  > Socratic: Counter-argument considered: "the product hands a TIMELINE to an editor; title/description/hashtags/SEO is social-publishing repurposing — a different job." Resolution: deferred out of the first deliverable along with FR-032 (.md export).

### Selection list (scoring-first UI)
- FR-020: The reel list shows a `virality_score` badge per reel with sort-by-score, a one-line `reason` under each reel, and visually greys weaker reels while keeping them selectable. Priority: must-have. Change: new

### Selection tuning (pre-export)
- FR-021: Editor can adjust segment boundaries by adding/subtracting time front/back at word-level precision, with a "snap to nearest pause/breath" handle. Priority: must-have. Change: modified
- FR-022: Editor can reorder segments, merge adjacent segments (merge-threshold slider with a sensible default), and delete segments. Priority: must-have. Change: modified
- FR-023: Editor can optionally remove filler words ("yyy", "eee", …) at word level to tighten cuts; the behavior is toggleable. Priority: must-have. Change: modified
- FR-024: Editor can optionally preview playback of a selected reel synced to its segment list. Priority: nice-to-have. Change: new
- FR-025: The system flags reels that open on a pronoun/reference without context ("dangling references") and either pulls in an introducing segment or lowers the score. Priority: nice-to-have. Change: new

### Export (the deliverable)
- FR-026: Editor can export a CMX3600 `.edl` (primary/default universal format). Priority: must-have. Change: preserved
- FR-027: Editor can export FCP7 xmeml `.xml` for Premiere Pro. Priority: must-have. Change: preserved
- FR-028: Editor can export `.fcpxml` for Final Cut Pro X (distinct from xmeml, generated separately). Priority: must-have. Change: new
- FR-029: Editor can export a DaVinci Resolve `.lua` script to paste into the Resolve console (file fallback). Priority: must-have. Change: preserved
- FR-030: Editor can run the app as an embedded DaVinci Resolve Workflow Integration plugin (launched from `Workspace → Workflow Integrations`), working in a panel inside Resolve; one click creates a new folder in the current project and places reels as timelines via the Resolve API (importing source to the Media Pool), with no script-paste or file-import. Priority: must-have. Change: new
  > Socratic: Counter-argument considered: "this is a different runtime + Resolve plugin API + separate packaging — plausibly its own project, and file export already reaches Resolve." Resolution: stands — the 'work without leaving Resolve' workflow is the headline differentiator. (Flagged as the largest single technical risk in the build; see Open Questions / Constraints.)
- FR-031: Editor can run the same app standalone (separate window); file export (EDL / Lua / FCPXML / XML) is the universal fallback, used automatically when the plugin has no Resolve API access. Priority: must-have. Change: modified
- FR-032: ~~Editor can export a per-reel `.md` (title, `virality_score` badge, social description, hashtag block, full transcript, speaker-labeled variant).~~ **DEFERRED** to a later change (see Non-Goals).
  > Socratic: Deferred together with FR-019 — the `.md` repurposing document is a social/SEO artifact, not part of timeline delivery.

### Projects, i18n, security, UX states
- FR-033: Editor can create / open / update / delete projects (`.reelproj`); full state is persisted and reloads (including older schema versions). Priority: must-have. Change: preserved
- FR-034: Editor can switch the UI between English and Polish; all UI text comes from translation keys, not hardcoded strings. Priority: must-have. Change: new
- FR-035: API keys are stored in the OS secure credential store, never plaintext. Priority: must-have. Change: modified

### Removal
- FR-038: The FFmpeg MP4 render path and all in-app video-editor concerns (9:16 crop, logo overlay, subtitle burn-in, codec matrix, render queue, face-tracking keyframes) are removed from the app. Priority: must-have. Change: removed

## User Stories

### US-01: Editor turns a long recording into an importable timeline (core pivot path)

- **Given** an editor with a long local recording and a configured LLM API key
- **When** they import the video, run the built-in local transcription, let AI select reels, lightly tune the segment boundaries, and export an `.edl`
- **Then** they get a timeline file that imports cleanly into their NLE with cuts on word boundaries — and the app never rendered an MP4

#### Acceptance Criteria
- Transcription produces word-level timestamps; segment boundaries land on word boundaries (~0% mid-word).
- Each reel shows a `virality_score` + one-line `reason`; reels sort by score.
- The exported `.edl` imports into DaVinci Resolve / Premiere / Final Cut with no manual structural fixes.
- ≥ 75% of exported reels are exported without changing the AI's `clip_ids`.

### US-02: Editor hands reels into Resolve from inside Resolve (plugin path)

- **Given** the editor is working in DaVinci Resolve with a project open
- **When** they launch Reels Automator from `Workspace → Workflow Integrations`, complete selection in the embedded panel, and confirm the reels
- **Then** a new folder appears in the current Resolve project containing each reel as its own timeline, with source media in the Media Pool — in one click, no script paste, no file import

#### Acceptance Criteria
- The plugin detects the active project / media / timeline context.
- Reels become separate timelines under a new dated/named folder via the Resolve API.
- When API access is unavailable, the app falls back to file export automatically.

## Business Logic

**Domain rule (one sentence):** Given a transcript split into numbered segments, the app decides which segments — and in what order — form self-contained, high-value reels, scoring each on Hook / Flow / Value / Trend and keeping every cut on a real word boundary.

This is a **modification** of an existing rule. *Current rule:* the app already returns reels as ordered `clip_ids` over numbered segments. *Change:* the selection now (a) treats **informational/merytoryczna value as the overriding criterion** — a less flashy but substantive fragment beats clickbait; (b) attaches a `virality_score` (Hook/Flow/Value/Trend) and a one-line `reason` per reel; (c) requires each reel to be understandable on its own — open on a hook, close on its punchline — and flags "dangling references" (a reel opening on an unexplained pronoun/reference) to either pull in an intro segment or lower the score; (d) never paraphrases — it only selects and reorders existing text; and (e) pins cut boundaries to word-level timestamps (and natural pauses/breaths) rather than approximate sentence ends.

Inputs the rule consumes (as user-facing inputs): the full numbered segment list with timecodes, an editable instruction/preset describing audience, tone and target platform length (TikTok ~15–30s / Reels ~30–60s / Shorts ~60–90s), and — when multiple files are loaded — source grouping that forbids mixing segments across files in one reel. Output: a ranked set of reels (ordered segment IDs + name + score + reason + hook/body/punchline markers) the editor encounters as a scored, sortable list before tuning and export.

## Non-Functional Requirements

- Source video never leaves the user's machine; the only outbound data is transcript **text** sent to the chosen LLM API.
- The same transcript + prompt + model produces the same selection on re-run (repeatable; supported by low temperature/effort and result caching) — an editor re-running a project does not get a different set of reels.
- Segment cut boundaries fall on word boundaries: ~0% of boundaries land mid-word.
- Any operation longer than ~2 seconds (transcription, model download, AI selection) shows continuous visible progress and is cancelable; no operation blocks the window behind a modal.
- Exported timeline files import into DaVinci Resolve, Premiere Pro and Final Cut Pro X with no manual structural fixes.
- Re-running selection on an unchanged transcript reads from cache rather than re-paying the full LLM input cost.
- The entire UI is available in both English and Polish.
- Malformed model output produces a readable error with a recovery path (retry / manual paste-and-fix), never a silent failure or crash.

## Constraints & Preserved Behavior

**Backward compatibility**
- `.reelproj` projects must continue to load, including older schema versions (serde defaults today; schema currently v2). A schema bump must not break existing files.
- The output structure of the existing exporters (CMX3600 EDL, FCP7 xmeml XML, Resolve Lua) is fragile and import-tested in real NLEs; its import compatibility must be preserved when the schema gains `virality_score` / markers.

**Preserved behavior (must NOT break)**
- Integer-frame timeline math: seconds→frames via `Math.round(s*fps)`, no mid-pipeline rounding to seconds; EDL record TC keeps the CMX-3600 1-hour offset.
- The import → segment → AI-selection → export pipeline must keep working after the render path is removed.
- `mergeAdjacentClips` remains the source of render/export spans (now export-only).
- Local-first guarantee: video stays on-device.

**Removal boundary (decided)**
- "Remove the render path" = delete the FFmpeg **filter-graph render**, the render UI/tab, the render queue, hardware-encoder detection, subtitle burn-in, logo, and face-tracking keyframes. **Keep the bundled FFmpeg sidecar** — it is still used for WhisperX **audio extraction** and thumbnail extraction.

**Integration / migration constraints**
- The LLM response schema is fixed in `src/ai/prompt.js`; adding `virality_score` + markers requires updating every consumer.
- `callClaude` calls `api.anthropic.com` directly from the browser; prompt-caching (`cache_control: ephemeral`) must fit that call structure.
- `transcribe_video` currently shells out to `whisper-cli` from PATH (not bundled); moving to a bundled WhisperX engine changes the transcription command, its packaging, and the SRT+word-JSON cache contract — that cache key/format must be migrated or preserved.
- The DaVinci Resolve Workflow Integration plugin runs inside Resolve under its scripting/plugin API (DaVinciResolveScript), which is a different runtime/packaging model than the standalone Tauri window — the largest technical unknown in this work (see Open Questions).

## Product Framing

- **Product type:** desktop application (unchanged). New surface added: an embedded DaVinci Resolve Workflow Integration plugin alongside the standalone window. Platforms: macOS first, Windows later.
- **Scale:** small — single user, single device, professional editors. No change.
- **Timeline:** after-hours, no hard deadline; `delivery_weeks` TBD (see Timeline acknowledgment).

## Non-Goals

**Hard locks (load-bearing — confirmed this session):**
- **No video render / no in-app video editor.** The app never renders MP4 and contains no editing surface: no 9:16 crop, no logo/gradients, no subtitle burn-in, no codec matrix, no render queue, no face-centering. All of that belongs to the NLE. *(This is the pivot — its absence is the product's identity.)*
- **No cloud / SaaS / collaboration.** Fully local, single-user. No hosted service, no project sharing between users, no team features / shared library / hosted AI.

**Also out of scope (stated in AppContext.md; not re-prioritized this session):**
- No browser-based / web version of the app.
- No Linux support.
- No general plugin architecture beyond the dedicated DaVinci Resolve integration.
- No multi-region / high-availability architecture.

**Deferred (functional non-goals for the FIRST deliverable, intended for later changes):**
- URL ingest (YouTube/Vimeo) · CapCut draft export · A/B provider comparison + merge · Batch API · two-stage long-form chunking · "private AI" prompt-export/paste-back · per-reel metadata generation (title/desc/hashtags/SEO) · per-reel `.md` export.

## Forward: technical-roadmap (not part of PRD schema)

Informational hand-off for downstream stack-assessment / planning, NOT PRD content:
- **DaVinci Resolve plugin runtime spike** — the highest-risk item. Investigate the Workflow Integration Plugin model (DaVinciResolveScript API, panel hosting, packaging) and how/whether the existing Tauri frontend can be reused inside it before committing the plugin to a delivery.
- **WhisperX bundling** — packaging WhisperX + alignment (+ optional pyannote diarization, HF token handling) as a built-in engine replacing the PATH `whisper-cli`; cache-format migration.
- **Windows release** — second platform; FFmpeg sidecar is architecture-suffixed and needs the matching binary + `tauri.conf.json` update.
- **Deferred features above** sequence into later changes once the core pivot is stable.

## Quality cross-check

All six brownfield elements present (Access Control, Business Logic, Project artifacts, Timeline-cost ack, Non-Goals, Preserved behavior). `quality_check_status: accepted`. No gaps. Two known-unknowns to carry into the PRD's Open Questions:

1. **`delivery_weeks` is TBD** — owner: user; to be refined at the roadmap/plan stage.
2. **DaVinci Resolve plugin runtime is unresolved** — owner: user/tech-stack stage; resolve before committing the plugin (FR-030) to a delivery slice. Highest technical risk in the build.


