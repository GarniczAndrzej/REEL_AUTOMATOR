---
date: 2026-06-15T14:46:43+0200
researcher: GarniczAndrzej
git_commit: 2fd469139081d8ff14cef6990ca63ad411d6b784
branch: master
repository: REEL_AUTOMATOR
topic: "UI/UX redesign — simpler, decluttered flow (S-16)"
tags: [research, codebase, ui, ux, frontend, goStep, declutter, styles-css]
status: complete
last_updated: 2026-06-15
last_updated_by: GarniczAndrzej
---

# Research: UI/UX redesign — simpler, decluttered flow (S-16)

**Date**: 2026-06-15T14:46:43+0200
**Researcher**: GarniczAndrzej
**Git Commit**: 2fd469139081d8ff14cef6990ca63ad411d6b784
**Branch**: master
**Repository**: REEL_AUTOMATOR

## Research Question

What is the current state of the frontend UI/UX, and what must a redesign for a "simpler, decluttered flow" (S-16) account for? Comprehensive sweep across all three angles — **control inventory** (declutter), **visual layer** (restyle), and **flow/navigation** (restructure) — over the whole 3-step pipeline, grounded in file:line evidence and prior decisions.

## Summary

The app is a **3-panel `goStep(n)` wizard** (import → analyze → export) rendered from one `src/index.html` (1115 lines) + one monolithic `src/styles.css` (1364 lines), driven by imperative DOM mutation with a near-unused pub-sub. The redesign target is already **specified in the roadmap** (`roadmap.md:277-311`, uncommitted): collapse the three screens into one continuous working surface, pull app config into a **settings window**, make export a **quick-export popover**, auto-populate project settings from the imported video, declutter the reel list, and prune dead controls. S-16 is explicitly a **pure presentation/orchestration rewrite** — no exporter or frame-math changes, all strings stay Polish.

Three concrete structural facts shape the work:

1. **The flow has no real spine.** `goStep(n)` (`main.js:8-14`) blindly toggles `.active` on panels/nav with **zero gating** — you can jump to step 3 with no data and get an `alert()`. Forward navigation is **asymmetric**: step 2→3 has a button, step 1→2 has none (the user must click the sidebar). This is the core "three separate screens" problem the redesign collapses.

2. **Density is front-loaded in step 1 (~33 controls).** Step 2 ≈30 (half behind two optional power features), step 3 ≈18 (repetitive but clean). The biggest declutter wins are in step 1's always-visible advanced knobs and the optional sub-features (A/B compare, dual JSON editors).

3. **Genuine cross-step duplication exists.** The video filename is entered in both step 1 (`videoFilename`) and step 3 (`videoFilename2`) as *separate state keys*; the merge threshold is a global field in step 3 **and** a per-reel slider on every step-2 reel header. Both are exactly what "auto-populate / move to settings" eliminates.

The visual layer is already **clean and token-based** (a coherent `:root` palette, dark-mode-only, Syne + DM Mono). The restyle opportunity is consistency/spacing regularization and **removing ~80 lines of dead render-queue CSS** (F-01 orphans), not a ground-up reskin. The structure (canvas hooks, `data-*` attributes, modal/tab IDs) is load-bearing and must be preserved.

## Detailed Findings

### Area 1 — App shell, navigation & flow

**DOM skeleton** (`src/index.html`): fixed `<header>` (logo + project buttons + API bar) over a two-column `<main>` (260px sidebar + content), with two modals and a floating preview appended after `<script>`.

- Header chrome, always visible: logo (`index.html:11-14`), project actions `Otwórz projekt… / Zapisz / Zapisz jako…` (`index.html:15-21`), `.api-bar` with password API-key input + OpenRouter model picker + save + `#apiStatus` (`index.html:22-49`). **This bar is the densest clutter in the shell.**
- Sidebar: three `.step-item` nav cards `#nav1/#nav2/#nav3` (`index.html:54-74`) + a "Status projektu" panel `#statusSrt/#statusSegs/#statusReels/#statusEdl` (`index.html:76-104`). **`#statusEdl` is never updated by JS — a dead status row.**
- Three content panels `#panel1/2/3`, only one `.active` at a time.

**`goStep(n)`** (`main.js:8-14`) is the entire step switch: loop `[1,2,3]`, toggle `.active` on `panel{i}`/`nav{i}`; on `n===3` call `step3.updateSummary()`. **No gating/validation** — all three panels live in the DOM permanently; any nav item is clickable anytime.

- Nav wiring (`main.js:18-21`): sidebar clicks → `goStep`; plus a custom-event bridge `document.addEventListener('reel:goStep', …)`.
- The **only** programmatic forward jump is step 2's `Eksportuj →` (`#goStep3Btn`) dispatching `reel:goStep:3` (`step2-analyze.js:23-25`). Step 1 has **no** forward button — `Analizuj SRT →` parses *in place* (`#segmentsCard`) and never calls `goStep`.
- Jumping to step 3 empty → `alert('Brak danych reelsów! Wróć do kroku 2.')` (`step3-export.js:128`) — error-after-the-fact instead of disabled nav.

**Pub-sub** (`state.js:99-106`): `subscribe(fn)` / `emit()`. Despite ~30+ `emit()` calls, there are only **two subscribers** — the sidebar status updater (`main.js:66-70`) and the preview-video src (`step2-reel-list.js:206`). Virtually all UI updates are imperative DOM mutation, not subscription-driven.

**Feedback surfaces**: no toast system. `showStatus` (`main.js:111-119`) writes transient text to `#apiStatus` (API-key-only). Everything else is **20+ blocking native `alert()`/`confirm()`** calls (e.g. `step3-export.js:128,149,177,182`; `step2-prompt-panel.js:77,81,85`). Two heavyweight modals (`#whisperAdvancedModal`, `#compareModal`) and a floating `#previewPanel` live at shell root, shown/hidden by inline `style.display`.

**Navigation indicator**: the left sidebar vertical stepper is the only orientation cue — current step = `.active` class only. No completed/visited state, no progress connector, no breadcrumb. The only tabs in the app are the **export-format tabs inside step 3**.

### Area 2 — Per-step control inventory & declutter candidates

Density ranking: **Step 1 (~33) ≫ Step 2 (~30) > Step 3 (~18)**.

**Step 1 — Import (`src/ui/step1-import.js`, ~1122 LOC — the monolith S-17 deferred splitting to S-16):**
- Clusters: header project I/O (3), SRT/VTT import (3), WhisperX transcription (10 incl. modal opener), advanced WhisperX modal (8 fields), project settings (4), segments preview exports (5), multi-source + parse (2 + per-source repeaters).
- Declutter candidates:
  - `gapFrames` (`step1:108`, html:311) + `minChars` (`step1:112`, html:321) — 90%-never-touched knobs in the always-visible settings card. Roadmap **#7 prunes `minChars`**; `gapFrames`/merge-gap moves to settings window (**#6**).
  - Segment-export quartet `.md`/`.json`/`.srt`/`.vtt` (`step1:26-41`) — debug/inspection noise; collapse or drop (VTT lowest value).
  - Diarization cluster (toggle + HF token + min/max speakers) — speaker labels are *intentionally not shown in the UI* (see Historical Context), strong candidate to bury behind advanced.
  - `videoFilename` (`step1:104`) — **duplicate** of step 3's `videoFilename2` (different state keys).
  - "Dodaj kolejne źródło wideo" (`step1:129`) — roadmap **#12 prunes** the add-another-video feature.

**Step 2 — Analyze (`step2-analyze.js` thin orchestrator + `step2-prompt-panel.js`, `step2-reel-list.js`, `step2-segment-ops.js`):**
- Declutter candidates:
  - **A/B "Porównaj dostawców" compare modal** (~9 controls, `prompt-panel:43-67`) — semantically stale since the app is OpenRouter-only. Roadmap **#9 notes it was already removed in S-17** — verify no remnant survives in HTML/JS.
  - **"🗑 Cache AI"** (`clearLlmCacheBtn`, `prompt-panel:21`) — roadmap **#9** says also already removed; confirm.
  - Dual JSON-edit paths: "✏ Edytuj JSON ręcznie" (`editJsonBtn`) + "Wklej JSON od AI" paste box overlap. Roadmap **#11**: move the paste-JSON panel behind an optional function; **primary** action = copy AI prompt as **`.md`** (not `.txt`), file export demoted to secondary.
  - Rename "Analizuj z AI" → **"Analizuj z OpenRouter"** (roadmap **#10**, `analyzeBtn` html:415).
  - Per-reel "Próg" slider on every reel header (`reel-list:392`) duplicates the global merge threshold. Roadmap **#14**: declutter the reel list — drop in-list playback (`tl-play-btn`, `reel-list:271-296`) and the per-reel timeline canvas (`reel-list:238-268`), surface **component scores (Hook/Flow/Value/Trend)** instead of just the overall score *(coordinate: S-02)*.

**Step 3 — Export (`src/ui/step3-export.js` — cleanest step):**
- Source-file settings card (6 controls) + 3 export tabs + 3×3 per-tab generate/download/copy (9).
- Declutter candidates:
  - `videoFilename2` (`step3:21`), `videoFullPath`, `resolutionSelect`, `projectName` — roadmap **#5**: the whole "Plik wideo źródłowy" settings surface stops being editable; video path/name/resolution/format are **auto-detected** on import.
  - `mergeThreshold` (`step3:39`, html:617) — roadmap **#6**: moves to settings window, persists across sessions *(coordinate: S-04)*.
  - The export step itself becomes a **quick-export popover** (roadmap **#8**) offering SRT/VTT/`.md`/AI-prompt copy **and** EDL/XML/Lua *(coordinate: S-08)*.

### Area 3 — CSS / visual layer

**One file**: `src/styles.css` (1364 lines / 24.7 KB), no preprocessor, linked from `index.html`. Minimal inline styles; one JS style injection in `step2-prompt-panel.js` (error color).

- **Token system** (`styles.css:11-28`): coherent `:root` palette — `--bg #0d0d10`, `--surface*` (3 tiers), `--border`/`--border2`, `--accent #7c6dfa` (purple) + `--accent2`, `--green/--amber/--red`, `--text` 3 tiers, fonts `--mono 'DM Mono'` / `--display 'Syne'`. **Dark mode only** (no light tokens, no `prefers-color-scheme`). Colors are strictly variable-based; **spacing, type scale, and radii are hard-coded** (not tokenized).
- **Typography**: Syne (display, headings/titles) + DM Mono (body, 12px default). Uppercase letter-spaced labels at 11px. No font-smoothing rules.
- **Layout**: header (fixed flex) + `main` grid (260px sidebar + 1fr content). **No media queries** — fixed widths, ~1200px minimum, desktop-first. Canvases scale to container width, fixed height (timeline 40px, waveform 400×48, preview 320×180 fixed top-right).
- **Component patterns**: ad-hoc semantic classes (no BEM/utility). `.btn` + `.btn-primary/secondary/success`; `.card`; `.setting-item`; `.badge*`; `.reel-card`; `.clip-row`; `.modal-overlay`/`.modal-box`; `.export-tab`/`.export-panel`. Flat color, no gradients/shadows (alpha for depth).
- **Dead CSS (F-01 orphans)**: `styles.css:955-1027` — `.render-reel-row`, `.render-progress-*`, `.status-pill`/`.status-*`, `.aspect-badge` (~80 lines, ~14 classes) no longer referenced. Safe removal in this slice.

### Area 4 — Historical context & prior decisions

See "Historical Context" and "Don't re-litigate" sections below — S-17 (de-bloat, archived today) explicitly **deferred the `step1-import.js` split to S-16** and the roadmap's uncommitted edits encode the full redesign scope.

## Code References

- `src/main.js:8-14` — `goStep(n)`: the entire (ungated) step switch.
- `src/main.js:18-21` — nav wiring + `reel:goStep` custom-event bridge.
- `src/main.js:66-70`, `src/main.js:111-119` — sole sidebar subscriber + `showStatus` (the only "toast").
- `src/state.js:99-106` — `subscribe`/`emit` pub-sub (two subscribers total).
- `src/index.html:10-50` — header chrome / dense API bar.
- `src/index.html:53-104` — sidebar stepper + status panel (`#statusEdl` dead).
- `src/index.html:792-968`, `970-1113` — `#whisperAdvancedModal`, `#compareModal`.
- `src/ui/step1-import.js:104-115` — project settings card (`videoFilename`, `gapFrames`, `minChars`).
- `src/ui/step1-import.js:26-41` — segment-export quartet (`.md`/`.json`/`.srt`/`.vtt`).
- `src/ui/step2-analyze.js:23-25` — the only step→step button (`Eksportuj →`).
- `src/ui/step2-prompt-panel.js:43-67` — A/B compare feature (stale, OpenRouter-only).
- `src/ui/step2-reel-list.js:238-296`, `:392` — per-reel timeline scrub / play / threshold slider (declutter #14).
- `src/ui/step3-export.js:21-42` — source-file settings card + `mergeThreshold`; `:128` empty-data alert.
- `src/styles.css:11-28` — `:root` design tokens.
- `src/styles.css:955-1027` — dead render-queue CSS (~80 lines).
- `context/foundation/roadmap.md:277-311` — full S-16 redesign scope (uncommitted).

## Architecture Insights

- **Imperative, not reactive.** The pub-sub exists but is vestigial (2 subscribers). A redesign that wants a single continuous surface will need to either keep the imperative render-on-action pattern or formalize the subscription model — but it should not assume `emit()` re-renders anything beyond the sidebar/preview today.
- **The shell is the cheap part to rewrite; the steps are the work.** `goStep` is 7 lines. The real surface area is the three `stepN-*.js` files (esp. the 1122-line `step1-import.js`) and the 1115-line `index.html`. "Collapse into one flow" = re-laying-out `index.html` and re-homing each step's controls, not rewriting logic.
- **State keys, not just DOM, encode the duplication.** `videoFilename` vs `videoFilename2`, global vs per-reel threshold — fixing the UX duplication touches `state.js` shape, so "pure presentation" has a thin state-plumbing tail (filename/threshold consolidation + a persisted settings store for #6).
- **Load-bearing structural hooks** that a restyle must preserve: canvas elements (`.reel-timeline`, `.clip-waveform`) and their `data-reel-idx`/`data-clip-idx`/`data-sentence-id` attributes; modal overlay IDs; `.export-tab`/`.export-panel` pairing; `#previewVideo` fixed positioning. Colors/spacing/typography/borders are free to change.
- **No CI gate on UI.** The regression suite fences only parser/exporters (`test/regression.js`). Per `roadmap.md:311`, UI behavior must be **manually re-verified** — a redesign of this size needs a manual test pass plan.

## Historical Context (from prior changes)

- `context/archive/2026-06-15-s-17/plan.md:28` — **explicitly defers the `step1-import.js` split to S-16**: "splitting now would be thrown away" since S-16 rewrites the whole `goStep` shell. **S-16 owns this refactor.**
- `context/archive/2026-06-15-s-17/plan.md` — removed the provider selector (Gemini/Claude), `callGemini`/`callClaude`, `src/ai/models.js`, the filler strike-through preview + `fillers.js`, and the A/B *provider* options (compare degenerated to model-vs-model). The redesign must carry **no remnant** of these (roadmap #9).
- `context/archive/2026-06-10-f-01/plan.md` — removed the Render tab, metadata/thumbnail feature, render-queue, subtitle burn-in, render settings/presets, 9:16 face-crop UI. The ~80 lines of dead render CSS (`styles.css:955-1027`) are leftovers from this.
- **Memory facts**: speaker labels are **intentionally hidden** from SRT/UI (diarization is data-only); **saves must always prompt for a location** (no silent auto-save). The redesign must not "fix" either as if it were clutter/friction.
- `context/foundation/lessons.md` — `plan-brief.md` must be written **in Polish**; never bake multi-GB assets into the PyInstaller sidecar (not UI-relevant but a standing constraint).

## Roadmap-encoded redesign scope (the actual S-16 contract)

`roadmap.md:277-311` (uncommitted) already groups the owner's intent — this is the spec a plan should satisfy:

- **A. One continuous flow** (#1, #3, #8): collapse the 3-step wizard into one surface; import accepts video **+ optional `.srt`** (auto-transcribe when absent — *coord S-05/S-07*); export becomes a **quick-export popover** (SRT/VTT/`.md`/prompt-copy/EDL/XML/Lua — *coord S-08*).
- **B. Settings knob** (#2, #4, #5, #6): API key + model + settings → dedicated **settings window**; project settings (fps, EDL filename) **auto-populate** on video add; step-3 source-file card stops being editable (auto-detected); merge-gap → settings window, **persisted across sessions** (*coord S-04*).
- **C. Declutter & prune** (#7, #9, #10, #11, #12, #14): prune `minChars` (#7) and add-another-video (#12); ensure no compare/cache remnant (#9, done in S-17); rename "Analizuj z AI" → "Analizuj z OpenRouter" (#10); demote paste-JSON, primary = copy prompt as `.md` (#11); declutter reel list — drop in-list playback + per-reel timeline, surface component scores (#14, *coord S-02*).
- **Out of scope** (#13): WhisperX transcription queue + audio-file input — separate slice off S-05.
- **Guardrails**: pure presentation/orchestration; **no exporter/frame-math changes**; **all strings Polish**; land **before S-13** (keyboard); manual UI re-verification (no CI fence).

## Related Research

- `context/archive/2026-06-15-s-17/research.md` — UI removal details (provider/filler/compare).
- `context/archive/2026-06-10-f-01/research.md` / `plan.md` — render-path removal (source of dead CSS).
- `context/foundation/roadmap.md` — S-16 slice definition + dependency lanes (E: UX overhaul).

## Open Questions

1. **Coordination ownership** (from `roadmap.md:309-310`): does the quick-export popover (#8) duplicate or replace the S-08 export surface? Does merge-gap-in-settings (#6) move threshold-UI ownership out of S-04? Does S-07's one-click mode already deliver most of the "simpler flow"? These don't gate the rewrite but shape where boundaries land.
2. **Settings persistence mechanism**: #6 requires merge-gap to "persist across sessions." There's no existing app-settings store (API key is in `localStorage`; project data is in `.reelproj`). Decide: `localStorage` settings bag vs. a new backend-backed config — this is the one piece of net-new state plumbing in an otherwise presentation-only slice.
3. **`UI changes proposals.md` is missing.** `roadmap.md:282` cites `context/foundation/UI changes proposals.md` (2026-06-15) as the source of items #1–#14, but the file does not exist on disk — the content appears to have been folded into the roadmap. Confirm nothing was lost.
4. **"One continuous surface" vs. three panels — how literal?** The outcome text says collapse `goStep(n)` into "a single primary working surface." Is the target a true single-scroll page, a progressive-disclosure single panel, or a lighter-weight stepper? This is the central design decision the plan must pin down before touching `index.html`.
5. **Manual test plan**: with no UI regression coverage, what is the acceptance checklist (import→reels→export happy path + save/load round-trip + each export format) that proves the rewrite didn't break behavior?
