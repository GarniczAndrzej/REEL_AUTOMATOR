# Stop AI Analysis — Plan Brief

> Full plan: `context/changes/stop-ai-analysis/plan.md`

## What & Why

Add the ability to stop an in-progress AI analysis. A started OpenRouter call
(30–90s typical) currently can't be interrupted — the analyze button is just
disabled until the `fetch` resolves or fails. Users who start a run with the
wrong model or prompt are stuck waiting. This adds a cancel via `AbortController`.

## Starting Point

`runAIAnalysis()` (`src/ui/step2-prompt-panel.js:39`) `await`s
`withLlmCache(…, () => callOpenRouter(…))`, which does a bare `fetch` with no
`signal` (`src/ai/providers.js:3`). The only running-state feedback is a disabled
button — there is no cancel control. A working cancel pattern already exists for
transcription (`transcribe.js:336`), but that's a backend sidecar SIGTERM;
analysis is a pure frontend fetch.

## Desired End State

While analyzing, the primary button reads "⏹ Zatrzymaj" (red). Clicking it aborts
the in-flight request within ~1s, resets the progress UI, logs "Anulowano." with
a toast, reverts the button to "Analizuj z OpenRouter →" (immediately usable),
and leaves any prior reels untouched. Nothing is cached; the paste-fix box is not
shown. Genuine errors behave exactly as today.

## Key Decisions Made

| Decision               | Choice                                   | Why (1 sentence)                                                      | Source |
| ---------------------- | ---------------------------------------- | -------------------------------------------------------------------- | ------ |
| Cancel control shape   | Toggle the analyze button into "Zatrzymaj" | No layout shift, single control, common LLM-app UX.                  | Plan   |
| Post-cancel UI         | Reset progress + "Anulowano" note         | Clean restart state, mirrors transcribe's immediate reset.          | Plan   |
| Cancel scope           | API call only                            | Cache read / parse / apply are instant; nothing else needs aborting. | Plan   |
| Abort handling         | Discard silently (not an error)          | Aborted call has no usable body; keeps FR-018 paste-fix for real errors. | Plan |
| Cache wrapper          | Untouched — signal via existing closure   | Signal threads through `callFn`; aborted call never reaches save.    | Plan   |

## Scope

**In scope:**
- `callOpenRouter` accepts/forwards an optional `AbortSignal`.
- `runAIAnalysis` owns an `AbortController`, toggles the button, wires cancel.
- `AbortError` handled as a distinct non-error outcome (reset + "Anulowano").

**Out of scope:**
- Backend/Rust changes; `withLlmCache`/`cache.js` signature changes.
- Cancelling cache-hit, parse/validate, apply, or the manual paste path.
- Confirmation dialog before cancel; any persisted/schema change.

## Architecture / Approach

Frontend only. A module-scoped `AbortController` in `step2-prompt-panel.js` is
created when a run starts; its `.signal` threads through the existing
`withLlmCache(cacheKey, () => callOpenRouter(…, signal))` closure into `fetch`.
The analyze button toggles between run/cancel modes via a small helper. The
existing `catch` branches on `e.name === 'AbortError'` before the error/paste-fix
path; `finally` restores the idle button and clears the controller.

## Phases at a Glance

| Phase                          | What it delivers                                  | Key risk                                         |
| ------------------------------ | ------------------------------------------------- | ------------------------------------------------ |
| 1. Abortable provider call     | `callOpenRouter(…, signal?)` forwards to `fetch`  | None — additive, backwards-compatible param.     |
| 2. Cancel control + lifecycle  | Button toggle, abort wiring, distinct cancel path | Catch-branch ordering must not swallow real errors. |

**Prerequisites:** Working dev environment (`npm run tauri dev`), an OpenRouter
API key + selected model to exercise a real (slow) call.
**Estimated effort:** ~1 session, 2 small phases, 2 files (+ minor CSS).

## Open Risks & Assumptions

- `fetch` abort surfaces as `e.name === 'AbortError'` across the bundled WebView —
  if an engine names it differently, the cancel branch needs a fallback check.
- A cancel landing during the synchronous parse/apply window is ignored (run
  effectively completes) — accepted, sub-millisecond.

## Success Criteria (Summary)

- User can stop a running analysis within ~1s and immediately start a new one.
- Cancel is visibly distinct from a failure (Polish "Anulowano", no error dialog).
- Genuine errors and normal successful runs are completely unaffected.
