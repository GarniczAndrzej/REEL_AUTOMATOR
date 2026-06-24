# Auto Mode Pipeline (S-07) Implementation Plan

## Overview

Build a **configurable, one-click "auto mode"** that orchestrates the existing
pipeline stages — Transcription (with alignment + optional diarization, using the
Step-1 WhisperX settings) → Segmentation → AI analysis (S-25 cluster→curate) →
Export — without manual hand-offs. The run is launched from a button **above
Step 1 in the left sidebar**, surfaces a **single non-blocking floating progress
panel** with **per-stage cancel**, lets the user **pick which stages run** and
**which outputs to produce**, and supports a **headless batch mode** that
processes N videos sequentially and writes their outputs to one chosen folder.

This is orchestration over slices that already exist as callable units. There is
essentially no new pipeline logic to invent — the new code is a controller, a
unified progress surface, a cancel-routing layer, a stage/output config, and a
batch queue. The AI stage stays a black box driven via an awaitable wrapper.

## Current State Analysis

- Every stage already has a callable entry that mutates `state`
  (research §A): `transcribeWithWhisper()` (`src/ui/import/transcribe.js:675`),
  `alignToWords()` (`:540`), `segmentFromWords()` (`src/parser/word-segments.js:22`),
  `runAIAnalysis()` (`src/ui/step2-prompt-panel.js:110`).
- The UI is render-on-change: `surface.js` reveals sections from `state`
  (`sentences.length`, `reelsData.length`), so **auto-advance is free** — the
  orchestrator only mutates `state` + `emit()`s (research §C).
- Two cancel mechanisms exist at different layers: a JS `AbortController` threaded
  into `fetch` for AI (`providers.js:32`), and a Rust atomic flag + process reaper
  (`cancel_transcription`, `whisper.rs:845`) for WhisperX (research §F).
- Two disconnected progress surfaces exist: the Tauri-event transcription bar
  (`#whisperProgressBox`) and the AI `setPS()`/bucket list in `#progressBox`
  (research §F).
- `transcribe_video` is directly invokable per-file with
  `{videoPath, modelId, language, diarize, hfToken, ...whisperAdvancedArgs()}` →
  `{srt_content, words, segments}` (`transcribe.js:697`). It emits one **global**
  `transcribe-progress` event and honors one **global** `cancel_transcription`
  flag (single-reaper) — so concurrent transcriptions are not possible; batch must
  be sequential.
- Exporters (`generateEDL/XML/Lua/FCPXML`) and `generateTranscriptVTT` are pure
  functions of explicit opts; SRT export lives in `export-srt.js`; the `.md`
  builder is currently **inline** in `export-popover.js:234`. `saveTextToPath`
  opens a native save dialog per call; `save_text_file` (Rust) writes to any path.
- Boot order in `src/main.js`: `hydrateKeys()` (keys cached) → step inits →
  `initSurface()` last; a new `initAutoMode()` registers before `initSurface()`
  (research §D).

### Key Discoveries:

- `runAIAnalysis()` is `async` but module-private and reads the key from
  `#apiKeyInput || getApiKey('openrouter')` (`step2-prompt-panel.js:111`). It must
  become an awaitable, DOM-free, exported wrapper for the orchestrator to sequence
  on it (research §B, Open Question 1).
- The S-25 pipeline already owns per-bucket retry + partial-commit-on-abort
  (`step2-prompt-panel.js:404`, `:524`). The orchestrator treats the AI stage as a
  single awaitable unit and **must not** duplicate that robustness (research §G).
- Synchronous `window.confirm/alert/prompt` crash the Tauri WKWebView — the pre-run
  gate must use the async `@tauri-apps/plugin-dialog` `ask()` (lessons.md).
- The S-25 `cache_control` lever is inert here; the disk cache (`withLlmCache`)
  makes a re-run of an unchanged transcript effectively free — good for auto-mode
  re-runs (research Historical Context, F1 caveat).

## Desired End State

A user with an API key set can:

1. Click **"Tryb automatyczny"** above Step 1.
2. In a non-blocking floating panel, tick which stages to run (Transcription /
   Segmentacja / Analiza AI / Eksport) and which outputs to produce; dependencies
   are auto-enforced.
3. **Single-video**: the run drives the loaded document through the chosen stages,
   auto-advancing the surface; outputs are produced; a per-stage cancel button can
   stop any live stage.
4. **Batch**: load N videos, pick one output folder once, and the panel processes
   each video sequentially, writing the selected outputs per video to that folder —
   without touching the single-document surface.

Verified when: a video + key produces reels end-to-end in one click; a
transcription-only selection produces just the chosen text outputs; a 3-video
batch writes 3 sets of files to the chosen folder; per-stage cancel stops the live
stage and leaves consistent state; the regression suite still passes.

## What We're NOT Doing

- **Not** re-implementing the AI strategy (S-25 cluster→curate), its retry, or its
  partial-commit logic — only driving it.
- **Not** changing the LLM schema, exporters' output format, or the `.reelproj`
  schema — Stage-2 output stays S-01-compatible.
- **Not** adding a separate Tauri OS window — the progress panel is an in-app
  non-blocking overlay.
- **Not** parallelizing transcription (single global reaper/progress channel
  forbids it).
- **Not** building new transcription/alignment/segmentation engine logic — reusing
  `transcribe_video`, `segmentFromWords`, the WhisperX advanced settings.
- **Not** auto-starting on video drop — the run is always explicitly launched.
- **Not** persisting batch results into `.reelproj` (batch is headless-to-disk).

## Implementation Approach

A new `src/ui/auto-mode/` module tree owns the feature, layered so each phase is
independently testable:

- **Phase 1** lands a single-video orchestrator driving the full fixed pipeline,
  reusing the existing inline progress surfaces — this delivers the roadmap's core
  one-click outcome and proves the sequencing/cancel/guard logic.
- **Phase 2** replaces the two disconnected progress surfaces with one
  non-blocking floating panel hosting per-stage rows + per-stage cancel.
- **Phase 3** makes the stage set and outputs configurable.
- **Phase 4** adds the headless batch queue and the pure reusable
  exporter/transcript helpers it needs.

The orchestrator's contract is always "call the stage's entry, await it, mutate
`state` + `emit()`, advance." It holds a single `AutoRunController` that tracks the
live stage and routes a per-stage cancel to the correct primitive.

## Critical Implementation Details

- **Cancel routing & semantics** — per-stage cancel must route to the live stage's
  primitive: an upstream stage (Transcription) cancel aborts the whole run because
  downstream stages have no input (toast "Anulowano"); an AI-stage cancel reuses
  S-25's partial-commit (already-completed buckets are kept). The controller holds
  a reference to whichever primitive is active (`cancel_transcription` invoke vs
  `AbortController.abort()`); never assume both are live. **Phase 1 cancel
  ownership** (no panel yet): `runAnalysis` must install its `AbortController` as
  the module-level `analysisController` (`step2-prompt-panel.js:148`) so the
  existing run⇄stop button cancels the auto-driven AI stage, and the legacy
  `#cancelTranscribeBtn` drives the transcription stage — the unified per-stage
  cancel buttons only arrive with the Phase 2 panel.
- **Re-entrancy** — `runAIAnalysis` already self-guards via `analysisController`.
  Auto-mode needs its own top-level run guard so a second launch during an in-flight
  run is rejected (toast), not started in parallel.
- **Read-only-during-run** — while a run is live, earlier-stage inputs must be
  gated (disabled) so `state.sentences` can't be mutated mid-analyze (the race
  research warns about); editing requires Stop first.
- **Batch is sequential by necessity** — `transcribe_video` has one global progress
  event and one global cancel flag; the batch loop must `await` each video fully
  before starting the next, and the per-video `transcribe-progress` listener must be
  attached/detached per iteration.
- **Diarization degradation** — auto-mode honors `state.diarize`; if on but no HF
  token is present, skip diarization with a toast rather than failing the run.

---

## Phase 1: AI seam + single-video orchestrator

### Overview

Make the AI stage awaitable and DOM-free, then build the orchestrator that runs
the full fixed pipeline (Transcription → Segmentation → AI analysis) for the loaded
document, with auto-advance, a top-level run guard, the read-only-during-run guard,
and the pre-run `ask()` gate. Progress reuses the existing inline surfaces for now.

### Changes Required:

#### 1. Awaitable AI-stage wrapper

**File**: `src/ui/step2-prompt-panel.js`, `src/ui/step2-analyze.js`

**Intent**: Let the orchestrator drive the S-25 pipeline without reaching into
step-2's DOM (`#apiKeyInput`) or simulating a button click.

**Contract**: Split the AI stage into a **pure core** and a **state-committing
wrapper** so batch (Phase 4) can analyze a document without mutating the live
surface:

- `export async function analyzeSentences({ sentences, apiKey, signal }) → reels[]`
  — the DOM/`state`-free core. It factors the cluster→curate dispatch
  (`runPipeline`/`runSingleShot`) and the key/abort source out of `runAIAnalysis()`,
  takes its input segments as an argument (not `state.sentences`), and **returns**
  the validated reels (including the partial set on `AbortError`, mirroring the
  current partial-commit-on-abort at `step2-prompt-panel.js:404`) instead of calling
  `commitReels`. It never reads `#apiKeyInput`, never writes `state`, never `emit()`s.
- `export async function runAnalysis({ apiKey, signal })` — the single-video wrapper.
  Calls `analyzeSentences({ sentences: state.sentences, apiKey, signal })`, then
  `commitReels(reels)` (the existing state write + `#reelsCard` reveal + `emit()`).
  Resolves when committed; on `AbortError` commits the returned partials and leaves
  the rest untouched. When `apiKey` is omitted, falls back to
  `getApiKey('openrouter')` (no DOM read).

The existing `onAnalyzeClick()`/`runAIAnalysis()` behavior is preserved by
delegating to `runAnalysis`. Re-export both `analyzeSentences` and `runAnalysis`
through `step2-analyze.js`. The cluster/curate/retry strategy (S-25) is unchanged —
this only relocates the `commitReels` chokepoint out of the core.

#### 2. Auto-mode state shape

**File**: `src/state.js`

**Intent**: Hold auto-mode run/config state in the single mutable object so the
panel and surface gating can read it.

**Contract**: Add an `autoMode` block (config + transient run state):
`autoMode.running:boolean`, `autoMode.activeStage:string|null`. Add a
`@typedef AutoMode` near the existing `Sentence`/`Reel` typedefs. (Stage-selection
and output fields are added in Phase 3; batch fields in Phase 4.)

#### 3. Awaitable transcription wrapper

**File**: `src/ui/import/transcribe.js`

**Intent**: Give the orchestrator (and Phase 4 batch) a clean awaitable
transcription unit, symmetric with the Phase 1 §1 AI seam — instead of reaching
into the DOM-coupled, error-swallowing, module-private `transcribeWithWhisper()`.

**Contract**: Extract a DOM-/`state`-free `export async function
transcribeDocument({ videoPath, modelId, language, diarize, hfToken, ...advanced },
{ signal, onProgress }) → { srtContent, sentences }`. It factors out the
`transcribe_video` invoke + `segmentFromWords` + name-derivation + words-fallback
currently inline in `transcribeWithWhisper()` (`:675`), takes its inputs as
arguments (not `state`), surfaces progress via the `onProgress` callback (not
`#whisperProgressBox`), and **rejects** on real failure / `ANULOWANO` cancel rather
than swallowing into `setWhisperProgress`. The existing manual `transcribeWithWhisper()`
button handler is preserved by delegating to it (it keeps its own DOM/progress
wiring). Export `whisperAdvancedArgs` and `MIN_CHARS` (or fold them into
`transcribeDocument`) so batch can call the same path.

#### 4. Orchestrator module

**File**: `src/ui/auto-mode/orchestrator.js` (new)

**Intent**: Sequence the stages for the loaded document, awaiting each, mutating
`state` + `emit()`ing so the surface auto-advances.

**Contract**: Export `runAutoPipeline(opts)` and an `AutoRunController`. The
controller exposes `cancelStage(stageId)` routing to `cancel_transcription` (for
the transcription stage) or `AbortController.abort()` (for the AI stage), and
tracks `activeStage`. Sequence (single-video, full pipeline this phase):
Transcription (call `transcribeDocument(...)` from §3, then write its
`{srtContent, sentences}` into `state` + `emit()`) →
[no separate align: word timings come from the engine; align only on SRT-import
branch] → `runAnalysis({ apiKey, signal })`. Top-level run guard rejects a second
concurrent launch. Honors `state.diarize` with token-absent degradation.

#### 5. SRT-vs-video branch

**File**: `src/ui/auto-mode/orchestrator.js`

**Intent**: Support both real entry points (video → transcribe; imported SRT →
parse + optional align).

**Contract**: Branch on input: when `state._whisperVideoPath` is present, run the
transcription path; when only `state.srtContent`/`state.sentences` exist (SRT
import), skip transcription, run `alignToWords()` if a video is available for
alignment, else proceed straight to analysis.

#### 6. Entry button + boot wiring + run guards

**File**: `src/ui/auto-mode/index.js` (new), `src/main.js`, `src/index.html`,
`src/ui/surface.js`

**Intent**: Add the sidebar entry point, register the module at boot, and gate
earlier-stage inputs while a run is live.

**Contract**: Add a Polish-labeled button **"Tryb automatyczny"** above Step 1 in
the left sidebar (`src/index.html`); `initAutoMode()` wires it and is registered in
`main.js` before `initSurface()`. The button is enabled only when an input
(video/SRT) + an OpenRouter key are present. Launch runs the pre-run gate: if
`state.reelsData.length` is non-empty, show async `ask()` ("Nadpisać istniejące
reelsy?"); otherwise start immediately. `surface.js` disables earlier-stage inputs
when `state.autoMode.running` (read-only-during-run); editing requires Stop.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- Prettier clean on touched files: `npx prettier --check "src/**/*.{js,css,html}"`
- `runAnalysis` and `analyzeSentences` are exported from `step2-analyze.js` (grep confirms re-export)

#### Manual Verification:

- One click on a loaded video with a key set drives transcribe → segment → analyze
  and reveals the reels section automatically.
- Imported-SRT branch runs analysis (with align when a video is present) without
  attempting transcription.
- A second launch during an in-flight run is rejected with a Polish toast.
- Launching when reels already exist shows the async overwrite `ask()`; cancelling
  it aborts the launch.
- Earlier-stage inputs are disabled while the run is live.

**Implementation Note**: After this phase and all automated verification passes,
pause for manual confirmation before proceeding.

---

## Phase 2: Unified non-blocking floating progress panel + per-stage cancel

### Overview

Replace the two disconnected progress surfaces with one in-app non-blocking
floating panel showing a stage list (per-stage label, %, state) and a per-stage
cancel control, fed by the existing signals.

### Changes Required:

#### 1. Floating progress panel component

**File**: `src/ui/auto-mode/progress-panel.js` (new), `src/index.html`, `src/index.css` (or the project's stylesheet)

**Intent**: Render one non-blocking overlay panel that the app stays interactive
behind, hosting the stage rows and per-stage cancel buttons.

**Contract**: Export `mountProgressPanel()` / `updateStage(stageId, {label, percent, status})` / `showPanel()`/`hidePanel()`. Panel is an in-app overlay (not a
modal, not a Tauri window): it never traps focus or blocks pointer events on the
rest of the app, and is dismissible. Each stage row carries a cancel button wired
to `controller.cancelStage(stageId)`. Stage rows: Transkrypcja → Segmentacja →
Analiza AI → Eksport (Eksport row appears in Phase 3+). Reuse stage-status icon
vocabulary from the existing bucket list (`{pending,running,done,error}`).

#### 2. Route stage signals into the panel

**File**: `src/ui/auto-mode/orchestrator.js`, `src/ui/import/transcribe.js`, `src/ui/step2-prompt-panel.js`

**Intent**: Feed the panel from the existing per-stage progress without rewriting
the stage internals.

**Contract**: During an auto run, the orchestrator subscribes the transcription
stage to the `transcribe-progress` Tauri event and maps it to
`updateStage('transcribe', …)`; the AI stage's `setPS`/bucket ticks drive
`updateStage('analyze', …)` (expose a lightweight progress callback or read the
existing DOM-less signals). The legacy inline surfaces (`#whisperProgressBox`,
`#progressBox`) are suppressed while an auto run owns the panel; manual (non-auto)
runs keep their existing surfaces unchanged.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- Prettier clean on touched files: `npx prettier --check "src/**/*.{js,css,html}"`

#### Manual Verification:

- A single auto run shows one continuous panel with per-stage % advancing across
  Transkrypcja → Segmentacja → Analiza AI.
- The app remains interactive behind the panel (no focus trap / no blocked
  scrolling); the panel is dismissible.
- Per-stage cancel on the transcription row aborts the run ("Anulowano"); per-stage
  cancel on the AI row keeps already-completed buckets (S-25 partial commit).
- Manual (non-auto) transcription and analysis still show their original surfaces.

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 3: Configurable stage selection + output picker

### Overview

Let the user choose which stages run and which outputs to produce, with
dependencies auto-enforced.

### Changes Required:

#### 1. Stage + output config state

**File**: `src/state.js`

**Intent**: Persist the user's stage/output selection.

**Contract**: Extend `autoMode` with `stages` (`transcription`, `segmentation`,
`analysis`, `export` booleans) and `outputs` (`srt`, `vtt`, `md`, `wordJson`,
`edl`, `xml`, `lua` booleans). Transcription always carries alignment + optional
diarization + word settings from the Step-1 WhisperX box (`state.whisperAdvanced`,
`state.diarize`, `state.modelId`, `state.whisperLanguage`) — it is one toggle, not
separate align/diarize toggles.

#### 2. Config UI in the panel

**File**: `src/ui/auto-mode/config.js` (new), `src/ui/auto-mode/progress-panel.js`

**Intent**: Render the stage checkboxes + output multi-select with dependency
enforcement.

**Contract**: Checkboxes: Transkrypcja, Segmentacja, Analiza AI, Eksport. Output
multi-select: SRT, VTT, `.md`, słowo-JSON (text outputs, available once a
transcript exists) and EDL, XML, Lua (timeline outputs, **disabled unless** Analiza
AI is selected / reels exist). Dependency rules: Segmentacja requires a transcript
upstream (transcription selected or a transcript already loaded); Analiza AI
requires segments; timeline outputs require Analiza AI. Invalid combos are greyed
out, not silently dropped.

#### 3. Orchestrator honors the config

**File**: `src/ui/auto-mode/orchestrator.js`

**Intent**: Run only the selected stages and produce only the selected outputs.

**Contract**: The sequence skips unselected stages (e.g. Transcription-only =
transcribe + write selected text outputs, no analysis). After the run, the Export
stage writes each selected output via the pure generators. Export-write policy
(avoids a dialog-per-file): a **single** selected output uses `saveTextToPath`
(one native save dialog); **≥2** selected outputs prompt once with `pickFolder()`
then write each file via `saveTextToFolder({folder, name, content})`. This pulls
the `pickFolder`/`saveTextToFolder` helper (see Phase 4 §2) **forward to this
phase** — Phase 4 batch reuses the same helper rather than introducing it.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite passes: `node --experimental-vm-modules test/regression.js`
- Prettier clean on touched files: `npx prettier --check "src/**/*.{js,css,html}"`

#### Manual Verification:

- Selecting only Transkrypcja + SRT output produces just an SRT, no analysis runs.
- Timeline outputs (EDL/XML/Lua) are disabled until Analiza AI is selected.
- Selecting Analiza AI without a transcript auto-enables/greys the required upstream
  stage per the dependency rules.
- A full selection (all stages + outputs) behaves like Phase 1's full run plus
  export.

**Implementation Note**: Pause for manual confirmation before proceeding.

---

## Phase 4: Batch mode (headless → chosen folder)

### Overview

Process N videos sequentially in a headless mode that writes each video's selected
outputs to one folder picked once, without touching the single-document surface.

### Changes Required:

#### 1. Reusable pure generation helpers

**File**: `src/exporters/transcript.js` (or a new `src/exporters/segments-md.js`), `src/ui/export-popover.js`, `src/ui/export-srt.js`

**Intent**: Make every output producible from explicit per-video data (not global
`state`) so batch can generate without mutating the live document.

**Contract**: Extract the inline `.md` builder (`export-popover.js:234`) into a
pure `generateSegmentsMd(sentences, fps, srtName)`. Confirm SRT (`export-srt.js`),
VTT (`generateTranscriptVTT`), and word-JSON producers accept explicit args. The
EDL/XML/Lua generators already take explicit opts — call them directly with
per-video opts. No change to output formats (regression-guarded).

#### 2. Folder-write helper (introduced in Phase 3 §3 — reused here)

**File**: `src/util/save-file.js`

**Intent**: Write many files to one user-chosen folder without a dialog per file.

**Contract**: `pickFolder()` (wraps `@tauri-apps/plugin-dialog` `open({directory:true})`) and `saveTextToFolder({ folder, name, content })` (joins path + invokes the
existing `save_text_file` Rust command) are introduced in Phase 3 §3 for
single-video multi-output export; Phase 4 batch **reuses** them unchanged. Honors
the save-location rule: the user picks the folder once via a native dialog; nothing
auto-dumps to ~/Downloads.

#### 3. Batch queue + state

**File**: `src/state.js`, `src/ui/auto-mode/batch.js` (new), `src/ui/auto-mode/orchestrator.js`

**Intent**: Hold a queue of videos and process them one at a time headlessly.

**Contract**: Add `autoMode.batchQueue` (`[{ path, name, status }]`) and
`autoMode.batchFolder`. `runBatch()` iterates the queue: for each video, invoke
`transcribe_video` directly (with `whisperAdvancedArgs()` + `state.diarize`/token
degradation), run `segmentFromWords` into a **local** `sentences` array (not
`state.sentences`) — calling `transcribeDocument(...)` from Phase 1 §3 with the
exported `whisperAdvancedArgs()` — optionally call
`analyzeSentences({ sentences, apiKey, signal })`
— the pure core from Phase 1, which **returns** reels without touching `state` or
`commitReels` (resolves F1) — then write the selected outputs to `batchFolder` via
`saveTextToFolder`, generating each from the local `sentences`/returned `reels`.
Each iteration attaches/detaches its own `transcribe-progress` listener (single
global event). The live document surface is **not** mutated (no `commitReels`, no
`emit()` of document fields). Per-video status feeds the panel's batch queue rows.

#### 4. Batch UI (multi-load + queue rows)

**File**: `src/ui/auto-mode/config.js`, `src/ui/auto-mode/progress-panel.js`, `src/index.html`

**Intent**: Let the user add multiple videos and watch the queue progress.

**Contract**: A multi-file picker / drop target adds videos to `batchQueue`; the
panel shows one row per video with its current stage + status, plus the overall
batch progress. The "pick output folder" prompt fires once at batch start
(`pickFolder()`). Per-stage cancel during batch aborts the current video; define
whether the queue continues to the next video or stops (default: stop the whole
batch on cancel, consistent with Phase 1 upstream-cancel semantics).

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite passes (output formats unchanged): `node --experimental-vm-modules test/regression.js`
- New regression case for `generateSegmentsMd` added and passing
- Prettier clean on touched files: `npx prettier --check "src/**/*.{js,css,html}"`

#### Manual Verification:

- Loading 3 videos and selecting Transkrypcja + SRT writes 3 SRT files (named per
  source video) into the chosen folder, sequentially.
- A full-pipeline batch writes the selected timeline + text outputs per video.
- The single-document surface is untouched after a batch run (no "last video"
  leaking into the live state).
- Per-stage cancel during batch stops the current video per the defined semantics;
  already-written files remain.
- Diarization-on-without-token degrades gracefully per video (toast, no hard fail).

**Implementation Note**: Pause for manual confirmation; this phase touches the
shared save/export helpers — run the regression suite before and after.

---

## Testing Strategy

### Unit Tests (regression suite — `test/regression.js`):

- Existing parser + EDL/XML/Lua cases must stay green (output formats unchanged).
- Add a case for the extracted `generateSegmentsMd(sentences, fps, srtName)` to
  pin its output (Phase 4).

### Integration / Manual Testing:

- Single-video full run (video → reels) in one click.
- Imported-SRT branch (parse + align, no transcription).
- Stage-subset run (Transcription-only → SRT/VTT/.md/word-JSON).
- 3-video batch to a chosen folder.
- Per-stage cancel on transcription (aborts run) vs AI (partial commit).
- Re-run with existing reels (overwrite `ask()` gate).
- Diarization-on-without-HF-token degradation.

### Manual Testing Steps:

1. Set an OpenRouter key; load a video; click "Tryb automatyczny"; confirm reels
   appear and the surface auto-advances.
2. Tick only Transkrypcja + SRT; confirm only an SRT is produced.
3. Load 3 videos, pick a folder, run; confirm 3 output sets land in the folder.
4. Cancel the transcription stage mid-run; confirm "Anulowano" and consistent
   state. Cancel the AI stage; confirm completed buckets are kept.
5. Re-launch with reels present; confirm the overwrite `ask()` appears.

## Performance Considerations

- Each WhisperX spawn is cold (37–67s; memory `whisperx-cold-spawn-cost`); batch is
  sequential and will be long-running by design — keep the panel non-blocking and
  the per-stage % live so the user has feedback.
- The LLM disk cache (`withLlmCache`) makes re-running an unchanged transcript
  effectively free; do not claim provider prompt-cache savings (F1 caveat).

## Migration Notes

- No `.reelproj` schema change; batch never writes project files. No data
  migration. Single-video auto mode mutates the same `state` fields manual flow
  already uses.

## References

- Research: `context/changes/auto-mode-pipeline/research.md`
- Roadmap S-07: `context/foundation/roadmap.md:209`
- AI-stage seam: `src/ui/step2-prompt-panel.js:110` (`runAIAnalysis`), `:556` (`commitReels`)
- Transcription: `src/ui/import/transcribe.js:675` (`transcribeWithWhisper`), `:697` (`transcribe_video` invoke)
- Cancel: `src/ui/import/transcribe.js:336` (`cancelTranscribe`), `src-tauri/src/whisper.rs:845` (`cancel_transcription`)
- Surface gating: `src/ui/surface.js:16-67`; boot: `src/main.js:13-88`
- Exporters / save: `src/ui/export-popover.js`, `src/util/save-file.js`, `src/exporters/*`
- Lessons: no sync `confirm/alert`; commit only in-scope files (`context/foundation/lessons.md`)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: AI seam + single-video orchestrator

#### Automated

- [x] 1.1 Rust type-check passes — 9201dfe
- [x] 1.2 Regression suite passes — 9201dfe
- [x] 1.3 Prettier clean on touched files — 9201dfe
- [x] 1.4 `runAnalysis` + `analyzeSentences` exported from `step2-analyze.js` — 9201dfe

#### Manual

- [ ] 1.5 One click drives transcribe → segment → analyze and reveals reels
- [ ] 1.6 Imported-SRT branch runs analysis (with align) without transcription
- [ ] 1.7 Second launch during a run is rejected with a toast
- [ ] 1.8 Overwrite `ask()` appears when reels already exist; cancel aborts launch
- [ ] 1.9 Earlier-stage inputs disabled while the run is live

### Phase 2: Unified non-blocking floating progress panel + per-stage cancel

#### Automated

- [ ] 2.1 Rust type-check passes
- [ ] 2.2 Regression suite passes
- [ ] 2.3 Prettier clean on touched files

#### Manual

- [ ] 2.4 One continuous panel shows per-stage % across stages
- [ ] 2.5 App stays interactive behind the panel; panel dismissible
- [ ] 2.6 Transcription-row cancel aborts run; AI-row cancel keeps completed buckets
- [ ] 2.7 Manual (non-auto) runs still show their original surfaces

### Phase 3: Configurable stage selection + output picker

#### Automated

- [ ] 3.1 Rust type-check passes
- [ ] 3.2 Regression suite passes
- [ ] 3.3 Prettier clean on touched files

#### Manual

- [ ] 3.4 Transkrypcja + SRT only produces just an SRT, no analysis
- [ ] 3.5 Timeline outputs disabled until Analiza AI selected
- [ ] 3.6 Dependency enforcement greys out invalid combos
- [ ] 3.7 Full selection behaves like full run plus export

### Phase 4: Batch mode (headless → chosen folder)

#### Automated

- [ ] 4.1 Rust type-check passes
- [ ] 4.2 Regression suite passes (output formats unchanged)
- [ ] 4.3 New `generateSegmentsMd` regression case added and passing
- [ ] 4.4 Prettier clean on touched files

#### Manual

- [ ] 4.5 3 videos + SRT writes 3 SRT files to the chosen folder sequentially
- [ ] 4.6 Full-pipeline batch writes selected timeline + text outputs per video
- [ ] 4.7 Single-document surface untouched after a batch run
- [ ] 4.8 Per-stage cancel during batch stops per defined semantics; written files remain
- [ ] 4.9 Diarization-on-without-token degrades gracefully per video
