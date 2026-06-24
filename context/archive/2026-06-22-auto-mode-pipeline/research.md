---
date: 2026-06-24T08:57:50+0200
researcher: GarniczAndrzej
git_commit: 6e054249432e45f7965bca760e2d8275e2258cd7
branch: master
repository: REEL_AUTOMATOR
topic: "S-07 one-click auto mode — orchestrating import→transcribe→align→diarize→segment→AI-select with staged progress + per-stage cancel, driving the S-25 cluster→curate pipeline"
tags: [research, codebase, auto-mode, s-07, orchestration, staged-progress, abort, s-25-pipeline]
status: complete
last_updated: 2026-06-24
last_updated_by: GarniczAndrzej
---

# Research: S-07 One-click auto mode + staged progress

**Date**: 2026-06-24T08:57:50+0200
**Researcher**: GarniczAndrzej
**Git Commit**: 6e054249432e45f7965bca760e2d8275e2258cd7
**Branch**: master
**Repository**: REEL_AUTOMATOR

## Research Question

Implementation-ready map of how to build the `auto-mode-pipeline` change (roadmap **S-07: One-click auto mode + staged progress**): one click that drives import → transcription → alignment → diarization → segmentation → AI selection, auto-advancing the UI, with a single continuous staged-progress indicator (per-stage %), a per-stage cancel button, and **no blocking modal**. Scope includes the **AI-driving detail**: auto-mode must invoke the now-shipped **S-25 cluster→curate two-stage pipeline**, not the legacy single-shot call.

## Summary

S-07 is **orchestration over stages that already exist as callable units** — there is essentially no new pipeline logic to invent, only sequencing, a unified progress surface, and one top-level cancel. Every stage already has an entry point and already mutates `state`; the UI is already render-on-change (`surface.js` reveals sections from `state`, not from manual step toggles), so **"auto-advance" is free** — the orchestrator just mutates state + calls `emit()` and sections reveal themselves.

Three concrete realities shape the plan:

1. **The AI pipeline is done (S-25).** `idea.md` in the repo root describes the cluster→curate multi-model strategy — that is roadmap **S-25 (`cost-optimized-ai-analysis`)**, shipped and archived 2026-06-24. S-07 must *drive* it, via `runAIAnalysis()` in `src/ui/step2-prompt-panel.js`, which already auto-selects single-shot vs pipeline by segment count. **Do not re-implement the AI strategy.**

2. **Two cancel mechanisms already exist and differ by layer.** AI calls use a JS `AbortController` threaded into `fetch` (`callOpenRouter(..., signal)`); WhisperX transcription uses a Rust-side atomic flag + process reaper (`cancel_transcription` command). A unified "Stop" must fan out to **both** depending on which stage is live.

3. **Progress is currently two disconnected surfaces.** Transcription has its own Tauri-event progress bar (`#whisperProgressBox`); AI analysis has the `setPS()` 3-step indicator + log + usage + bucket list (`#progressBox`). S-07's "single continuous staged-progress indicator" means unifying these into one stage list spanning Import→Transcribe→Align→Segment→Analyze.

The sharpest new code is: (a) a top-level orchestrator/controller module that sequences the stage calls and owns one cancel token that routes to the right per-stage primitive; (b) a unified staged-progress component; (c) making the two analysis entry functions (`runAIAnalysis`) awaitable/exported so the orchestrator can sequence on them rather than simulating a button click.

## Detailed Findings

### A. Stage entry points (what to call, in order)

Each stage already has a callable unit that mutates `state`. Auto-mode sequences these.

| # | Stage | Entry function | File:line | Reads | Writes / effect |
|---|-------|----------------|-----------|-------|-----------------|
| 1 | Import: video meta | `populateVideoMeta(path)` | `src/util/video-meta.js:33` | path | `state.fps` (snapped to [24,25,30,50,60]), `state.videoResolution`; invokes Tauri `probe_video_metadata` |
| 1 | Import: SRT parse | `doParseBtn()` / core `parseSRT(text, fps, minChars)` | `src/ui/import/segments.js` (≈121); `src/parser/srt.js:123` | `state.srtContent`, fps | `state.sentences[]` |
| 2 | Transcription (+diarization) | `transcribeWithWhisper()` | `src/ui/import/transcribe.js:675` | `state._whisperVideoPath`, `state.modelId`, `state.whisperLanguage`, `state.diarize`, `state.whisperAdvanced.*`, HF token | Tauri `transcribe_video`; sets `state.srtContent`, `state.sentences` (via `segmentFromWords`) |
| 3 | Alignment | `alignToWords(opts?)` / `alignImportedTranscript()` | `src/ui/import/transcribe.js:540` | `state.videoPath`, `state.srtContent`, `state.whisperLanguage` | merges word timings into `state.sentences` (skip if transcription already produced `words[]`) |
| 4 | Diarization | **not a stage** — boolean param to stage 2 | toggle wired `src/ui/import/transcribe.js:48-64` | — | passed as `diarize` arg to `transcribe_video`; needs HF token via `getApiKey('huggingface')` |
| 5 | Segmentation | `segmentFromWords(engineSegments, fps, minChars)` / `parseSRT` | `src/parser/word-segments.js:22` | engine output / SRT | `state.sentences[]` — produced *inside* stage 1/2, not a separate call |
| 6 | AI selection | `runAIAnalysis()` | `src/ui/step2-prompt-panel.js:110` | `state.aiPipelineMode`, `state.aiModels.cluster/.curate`, `state.orSelectedModel`, prompts, `state.sentences` | `state.reelsData[]` via `commitReels` |

**Key seam observation:** stages 4 and 5 are not independent calls — diarization is a flag on stage 2, and segmentation happens inside stages 1/2. So the orchestrator's real sequence is **Import → (Transcribe | parse SRT) → [Align if SRT-imported] → Analyze**. The roadmap's 6-stage list is the *displayed* progress granularity, not 6 separate calls.

### B. The AI-selection seam (S-25 cluster→curate) — what auto-mode must drive

`src/ui/step2-prompt-panel.js` is the analysis orchestrator. The entry is the button handler:

- `onAnalyzeClick()` (`:78`) — toggles run/stop: if `analysisController` is set it `.abort()`s; else calls `runAIAnalysis()`.
- `runAIAnalysis()` (`:110`) — **the function auto-mode should drive.** It is currently `async`, **module-private**, and reads the API key from `document.getElementById('apiKeyInput').value || getApiKey('openrouter')` (`:111`). It reads everything else from `state`. It owns the AbortController (`:148`), the progress reset (`:152-170`), and dispatches to `runPipeline` or `runSingleShot` (`:173-177`).
- `shouldUsePipeline()` (`:89`) — mode decision: `state.aiPipelineMode` of `'single'`→false, `'pipeline'`→true, `'auto'`→`state.sentences.length >= PIPELINE_AUTO_THRESHOLD`. **Threshold = 150 segments**, the const `PIPELINE_AUTO_THRESHOLD` at `:46`.
- `runPipeline(apiKey, controller)` (`:269`) — Stage 1 cluster (`buildClusterPrompt` → `callOpenRouter(..., true)` → `validateThemes`), builds stable-sorted buckets (`:373`), then per-bucket Stage 2 loop (`:388`) calling `runBucket` (`:455`).
- `runSingleShot(apiKey, controller)` (`:187`) — legacy one call → `validateReels` → `commitReels`.
- `commitReels(reels, pushHistory=true)` (`:556`) — **the only place `state.reelsData` is written**; sorts, reveals `#reelsCard`/`#step2Next`, `emit()`s. Stage-2 schema is byte-identical to S-01, so exporters/`.reelproj` are untouched.

`callOpenRouter(apiKey, prompt, orModel, signal, cacheControl=false)` (`src/ai/providers.js:19`) returns `{ content, usage, finishReason }`; `signal` flows into `fetch` (`:32`); `usage` is `data.usage` verbatim incl. `prompt_tokens_details.cached_tokens`.

**Recommended seam change for S-07:** export an awaitable `runAIAnalysis()` (or a thin `runAnalysis({apiKey})` wrapper) from `step2-prompt-panel.js` and re-export through `step2-analyze.js`, so the orchestrator can `await` it and observe completion via `state.reelsData.length`, instead of simulating `analyzeBtn.click()` (which is fire-and-forget and reads the API key from a DOM input). This keeps S-07 from reaching into step-2's DOM.

### C. State model & auto-advance (why revealing is free)

`src/state.js` is one mutable object + a `Set` of listeners; `emit()` (`:144`) notifies all `subscribe(fn)` (`:140`). Relevant gating fields: `srtContent`, `sentences[]`, `reelsData[]`, plus the S-25 AI knobs `aiPipelineMode` (`:112`), `aiModels.cluster/.curate` (`:107`), `clusterPrompt`/`curatePrompt` (`:78-79`), and transcription knobs `modelId`/`whisperLanguage`/`diarize`/`whisperAdvanced` (`:115-136`).

`src/ui/surface.js` is render-on-change: `SECTIONS` (`:16`) gates `sectionReview` on `s.sentences.length > 0` (`:18`); `render()` (`:57`) toggles `.section-locked` and computes the sidebar "current" step as `reelsData.length ? 3 : sentences.length ? 2 : 1` (`:67`). It batches through one rAF (`scheduleRender`, `:49`). **Implication:** the orchestrator never manually shows/hides sections — mutating `state` + `emit()` after each stage reveals the next section automatically. `scrollToSection(id)` (`:43`) is available if auto-mode wants to scroll-follow.

### D. App boot / where to register the orchestrator

`src/main.js` (`DOMContentLoaded`, `:13`): order is `loadSettings` → `seedPresetsIfEmpty`/`loadPresets` → **`await hydrateKeys()` (`:42`)** → `step1.init` → `step2.init` → `step3.init` → `initOrPicker` → `initSettingsModal` → **`initSurface()` last (`:85`)**. Global error/rejection handlers (`:18-25`) and global undo/redo keybindings (`:98`) live here. A new `initAutoMode()` should be registered alongside the other `init`s (before `initSurface`), and the one-click button wired there. `hydrateKeys()` already runs before any init, so the OpenRouter + HF keys are in the in-memory cache when auto-mode runs.

### E. Settings — the AI knobs auto-mode reads are already persisted

`src/ui/settings-modal.js` already mounts **two model pickers** for S-25: `initOrPicker(CLUSTER_CONFIG)` + `initOrPicker(CURATE_CONFIG)` (`:39-40`), each reusing `src/ai/openrouter-picker.js`, writing `state.aiModels.cluster/.curate` + per-machine localStorage keys. It also boot-seeds `state.clusterPrompt`/`curatePrompt` (`:64-65`) and `state.aiPipelineMode` (`:67`, default `'auto'`), and binds an `#aiPipelineMode` selector (`:85-89`). **Auto-mode reads these straight from `state`** — no new settings needed for the AI stage. (S-07 may still add its own settings: e.g. default diarization on/off, default model, "confirm before run".)

### F. Progress + cancel primitives (the two surfaces to unify)

**Transcription progress (Tauri event):**
- Rust emits `transcribe-progress` `{phase, label, percent}` from `src-tauri/src/whisper.rs:340-343`; `map_progress()` (`:58-75`) maps phases (`transcribe` 5–70%, `align` 70–95%, `diarize` 95–100%) to Polish labels + overall %.
- JS listens via `listen('transcribe-progress', …)` at `src/ui/import/transcribe.js:689` (and `:575` for align) → `setWhisperProgress(label, percent)` (`:767`) → updates `#whisperProgressLabel` / `#whisperProgressFill` (`src/index.html:188-219`).

**AI-analysis progress (DOM, in `#progressBox` `src/index.html:419-437`):**
- `setPS(n, state)` (`step2-prompt-panel.js:803`) sets `running|done|err` on `#ps1/2/3` (Przygotowanie → Wysyłanie → Parsowanie).
- `log(msg, type)` (`:810`) → `#logBox`; `renderUsageSummary()` (`:789`) → `#usageBox`; `renderBucketList`/`updateBucketRow` (`:572`/`:593`) → `#bucketList` with per-bucket icons `{pending:'…',running:'⏳',done:'✓',error:'✗'}` (`:584`) and a "Ponów" retry button on error.

**Cancel — AI (S-23, shipped):** `analysisController = new AbortController()` (`:148`); `controller.signal` → `callOpenRouter` → `fetch` (`providers.js:32`); abort from `onAnalyzeClick` (`:79`). `AbortError` is distinguished from real errors (`:239`, `:330`, `:392`): user-cancel leaves `state.reelsData` untouched and toasts "Anulowano"; a Stage-2 abort **commits already-completed buckets** (partial success, `:404-420`).

**Cancel — transcription:** `cancelTranscribe()` (`src/ui/import/transcribe.js:336`) invokes Tauri `cancel_transcription` (`whisper.rs:845`), which sets `TRANSCRIBE_CANCELLED: AtomicBool` and reaps the child (single-reaper pattern; the driver poll-loop checks the flag every 250ms, `whisper.rs:306-315`). Errors carrying `ANULOWANO` are treated as cancel, not failure (`transcribe.js:600`).

**Non-blocking notifications:** `toast(message, type)` (`src/ui/toast.js:1`) — stacking, auto-dismiss 3200ms, never blocks. The whole progress design is already modal-free (progress sits inline; the analyze button toggles run⇄stop and is never disabled).

### G. Partial failure / robustness already in place

The S-25 pipeline already implements per-bucket retry (`retryBucket`, `step2-prompt-panel.js:524`), partial commit on abort/failure (`collectPipelineReels` + `commitReels`, `:539`/`:404`), and a Stage-1 paste-fix recovery path (`revealPasteFix`, `:614`, FR-018). S-07 should **not** duplicate this — it should treat the AI stage as a single awaitable unit and surface its internal progress, letting the existing retry UI handle bucket failures.

## Code References

- `src/ui/step2-prompt-panel.js:110` — `runAIAnalysis()`, the AI-stage entry auto-mode must drive (make awaitable/exported)
- `src/ui/step2-prompt-panel.js:46` — `PIPELINE_AUTO_THRESHOLD = 150` (auto single-shot↔pipeline cutoff)
- `src/ui/step2-prompt-panel.js:89` — `shouldUsePipeline()` mode decision
- `src/ui/step2-prompt-panel.js:556` — `commitReels()`, only writer of `state.reelsData`
- `src/ai/providers.js:19` — `callOpenRouter(apiKey, prompt, orModel, signal, cacheControl)`
- `src/ui/import/transcribe.js:675` — `transcribeWithWhisper()` (stage 2)
- `src/ui/import/transcribe.js:540` — `alignToWords()` (stage 3)
- `src/ui/import/transcribe.js:336` — `cancelTranscribe()` → Tauri `cancel_transcription`
- `src/util/video-meta.js:33` — `populateVideoMeta()` (fps/resolution auto-populate)
- `src/parser/srt.js:123` — `parseSRT()`; `src/parser/word-segments.js:22` — `segmentFromWords()`
- `src/state.js:54-137` — state shape; `:140`/`:144` — `subscribe`/`emit`
- `src/ui/surface.js:16-67` — render-on-change section gating (auto-advance is free)
- `src/main.js:13-88` — boot wiring; register `initAutoMode()` before `initSurface()`
- `src/ui/settings-modal.js:39-89` — two model pickers + `aiPipelineMode` selector (S-25)
- `src-tauri/src/whisper.rs:340-343` — `transcribe-progress` event; `:58-75` `map_progress`; `:845` `cancel_transcription`
- `src/ui/toast.js:1` — non-blocking toast

## Architecture Insights

- **Auto-advance for free**: the surface is already state-driven (`surface.js`). The orchestrator's contract is "mutate `state`, call `emit()`" — never "show section N". This is the cleanest possible substrate for one-click flow.
- **One cancel token, two routing targets**: S-07 needs a single Stop that, depending on the live stage, calls either the JS `AbortController.abort()` (AI) or the Tauri `cancel_transcription` (Whisper). These are *different mechanisms at different layers* — the orchestrator must hold a reference to whichever is active. This is the main new robustness surface.
- **Progress unification, not invention**: both progress surfaces (`#whisperProgressBox`, `#progressBox` `setPS`) exist and are reusable; S-07's "single continuous staged-progress indicator" is a presentation merge (a stage list Import→Transcribe→Align→Segment→Analyze) feeding off the existing per-stage signals.
- **AI stage is a black box to S-07**: drive `runAIAnalysis()`, observe `state.reelsData.length`, let its internal cluster/curate/bucket/retry UI render inside the unified progress area. Schema stays S-01-compatible, so exporters/`.reelproj` are untouched (CLAUDE.md grep rule still applies if any field is touched).
- **Re-entrancy**: `runAIAnalysis` has a single-run guard via `analysisController` (`:147`). Auto-mode needs its own top-level run guard so a second click during transcription doesn't start a parallel pipeline.

## Historical Context (from prior changes)

- **S-25 `cost-optimized-ai-analysis`** (archived `context/archive/2026-06-23-cost-optimized-ai-analysis/`) — built the cluster→curate pipeline S-07 must drive. Roadmap explicitly lists the coordination: *"S-07 (one-click auto mode must drive both stages, not the legacy single call)."*
  - **F1 caveat (impl-review.md:26)** — the `cache_control` prompt-cache lever is **inert in this architecture**: the exact-match disk cache (`withLlmCache`) serves prompt-identical re-calls before the network, so the provider cache never fires; and across Stage-2 buckets the segments differ so there's no shared cached prefix. Net ≈0 `cached_tokens`. **Relevance to S-07:** do not expect/claim provider-cache savings from re-running auto-mode; the real input-cost win is Stage-1 minification, which works. The disk cache *does* make a re-run of an unchanged transcript effectively free (good for auto-mode re-runs).
- **S-23 `stop-ai-analysis`** (done) — added the `AbortController` thread + run⇄stop button that S-07 reuses for the AI stage; roadmap says "share cancel primitive with S-07."
- **S-16 `ui-ux-redesign`** (done) — replaced the `goStep(n)` wizard with the render-on-change `surface.js`; this is why auto-advance is trivial. Roadmap notes S-16 "informs S-07's one-click flow."
- **S-21 app-crash-fix** (archived) — established the single-reaper cancel pattern in `whisper.rs` that `cancel_transcription` relies on (`drop(CommandChild)` does not kill the OS process).

## Related Research

- `context/archive/2026-06-23-cost-optimized-ai-analysis/research.md` — prior exploration of the AI-analysis call path and the two-stage design.
- `context/archive/2026-06-23-cost-optimized-ai-analysis/plan.md` / `reviews/impl-review.md` — the shipped pipeline contract + F1 caveat.

## Open Questions

1. **AI-stage seam shape** — export `runAIAnalysis()` as awaitable vs. add a params-taking `runAnalysis({apiKey, signal})`? (Recommended: a thin exported wrapper so S-07 doesn't read step-2's `#apiKeyInput`.) Owner: implementer.
2. **Unified Stop semantics** — one global Stop that cancels the whole run, or the roadmap's "per-stage cancel button"? The roadmap says per-stage %; clarify whether cancel is per-stage or global-with-stage-awareness. Owner: user/team.
3. **Pre-run gate** — roadmap says "after an API key is set, with confirmation." What exactly is confirmed (cost? overwrite of existing reels?) and is it a toast or an async `ask()` dialog (note the lessons.md rule: no synchronous `window.confirm` in the Tauri webview)? Owner: user.
4. **SRT-vs-video branch** — auto-mode from a video runs transcribe; from an imported SRT it runs parse (+ optional align). Does one-click support both inputs, or only the video→transcribe path? Owner: user.
5. **Diarization default** — is diarization part of the one-click default (needs HF token present) or opt-in only? Owner: user.
6. **Return-to-earlier-step during a run** — roadmap wants the ability to return to earlier steps; define whether that cancels the in-flight run or is read-only until done. Owner: team.
