<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: DaVinci Resolve Embedded Plugin (S-09 resolve-plugin-handoff)

- **Plan**: context/changes/resolve-plugin-handoff/plan.md
- **Scope**: All 5 feature phases (Phase 6 packaging descoped)
- **Date**: 2026-06-27
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical · 3 warnings · 1 observation

## Automated criteria

- Regression suite: 272 passed / 0 failed ✅
- `node --check` on main.js + preload.js + all backend/*.js (15 files) ✅
- Prettier clean on `src/platform/**` + `resolve-plugin/**` ✅

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Plan drift: ZERO. Every planned item MATCHES. All EXTRA changes are legitimate — adapter-routing of `invoke()`/dialog sites across the frontend (behavior-neutral under Tauri) and a real prod-bundle circular-dep TDZ fix (`src/ui/import/constants.js`). Phase 6 correctly struck-through (descoped), not rubber-stamped.

## Findings

### F1 — Electron renderer has no CSP and no navigation guard

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Safety & Quality
- **Location**: resolve-plugin/main.js:160-181, resolve-plugin/preload.js:11
- **Detail**: preload.js exposes a generic `window.bridge.invoke(command, args)` reaching every `ipcMain.handle` channel, incl. save/load_text_file, save/load_project (renderer-supplied `path` → fs) and transcribe_video / extract_waveform (renderer-supplied path → child_process spawn). The built renderer ships no Content-Security-Policy, and createWindow sets neither `setWindowOpenHandler` nor a `will-navigate` deny. sandbox/contextIsolation/nodeIntegration are correct, but those don't stop page script from calling window.bridge — so XSS in panel content (LLM/transcript text via innerHTML) escalates to arbitrary file write + process spawn. Low-likelihood for the current personal-use install; matters before any wider distribution.
- **Fix**: Add a strict CSP `<meta>` to the built renderer (default-src 'self') and harden createWindow with `setWindowOpenHandler(() => ({action:'deny'}))` + a `will-navigate` handler blocking off-`file://` URLs. Optional: replace the pass-through invoke with per-command bridge methods.
- **Decision**: FIXED — applied Electron-only (not a shared `<meta>`, which would break the Tauri build's IPC/asset protocol): CSP via `session.onHeadersReceived` (`script-src 'self'`, `connect-src 'self' https://openrouter.ai`) + `setWindowOpenHandler` deny / `will-navigate` off-`file://` block, both routing http(s) to the system browser. resolve-plugin/main.js.

### F2 — Mode A render output / temp files are never cleaned up

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Reliability)
- **Location**: resolve-plugin/backend/resolve.js:259-305 (importSubtitles), resolve.js:~533 (collectTimelineAudio)
- **Detail**: (1) collectTimelineAudio mkdtemp's a dir and renders a WAV into it that is never removed — the `finally` only deletes the Resolve render JOB, so every Mode A click leaks an audio file to temp. (2) importSubtitles writes a temp `.srt`, imports it as a MediaPoolItem, then unlinks it in `finally` immediately — if Resolve's subtitle clip still references that file on disk, the unlink could invalidate it. Phase-3 manual criteria passed, so Resolve likely copies on import, but worth confirming.
- **Fix**: Remove the rendered WAV/temp dir in collectTimelineAudio's `finally`; confirm the subtitle survives the importSubtitles unlink (keep the temp file until import is verified, or leave it for the OS tmp reaper if Resolve needs it).
- **Decision**: FIXED — WAV leak addressed via `sweepStaleAudioDirs()` (purges prior `reels-audio-*` temp dirs at the start of each collect; bounds accumulation to one file and never deletes the returned path, which is consumed by a later transcribe click — a `finally` delete would race that consumer). resolve.js. importSubtitles unlink left as-is: Phase-3 manual criteria passed, confirming Resolve copies on import.

### F3 — Unrelated Prettier churn folded into a feature commit

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/ai/openrouter-picker.js (in commit 5091709)
- **Detail**: openrouter-picker.js carries 2 hunks of pure Prettier reformatting with no functional change, swept into the Phase-1 feature commit — the exact pattern the recorded lesson "Incidental Prettier churn must not ride into a feature commit" warns against. Already committed and harmless, so a process note rather than a code fix.
- **Fix**: No action on committed history. Going forward, stage incidental formatting separately per the lessons.md rule.
- **Decision**: SKIPPED — committed + harmless; the governing lesson already exists, no re-record needed.

### F4 — Empty modelId resolves to the models root (rm/swap hazard)

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Data safety)
- **Location**: resolve-plugin/backend/models.js:26,124,253
- **Detail**: `modelDir('')` → `path.join(modelsRoot(), '')` resolves to the models root itself, so `deleteModel({modelId:''})` would `fsp.rm` the entire models dir and downloadModel's rename would target the root. Faithfully copied from models.rs:51 — a shared latent hazard, not introduced here. No caller passes empty today, but a guard is cheap.
- **Fix**: Add a non-empty modelId guard at the top of deleteModel/downloadModel (and ideally mirror it in models.rs).
- **Decision**: FIXED — `requireModelId()` guard added to deleteModel + downloadModel (models.js); mirrored at the `model_dir()` chokepoint in models.rs (covers both destructive Rust callers). Polish error message. `cargo check` + `node --check` pass.
