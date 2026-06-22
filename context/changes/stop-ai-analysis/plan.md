# Stop AI Analysis Implementation Plan

## Overview

Add the ability to stop an in-progress AI analysis. Today a started OpenRouter
call (30–90s typical) cannot be interrupted — the analyze button is merely
disabled until the `fetch` resolves or fails. This change threads an
`AbortController` into the provider call so the user can cancel a run started
with the wrong model/prompt and immediately start again. Cancellation is treated
as a first-class, non-error outcome (Polish "Anulowano" feedback), mirroring the
existing transcription-cancel UX.

## Current State Analysis

- **Single entry point.** `runAIAnalysis()` (`src/ui/step2-prompt-panel.js:39`)
  is the only AI-analysis trigger. It disables `analyzeBtn`, shows `progressBox`,
  builds the prompt, then `await`s
  `withLlmCache(cacheKey, () => callOpenRouter(apiKey, prompt, orModel))`, parses
  + validates the response, applies `state.reelsData`, and re-enables the button
  in `finally`.
- **No abort mechanism.** `callOpenRouter()` (`src/ai/providers.js:3`) issues a
  bare `fetch(...)` with no `signal`. There is no way to interrupt it.
- **No cancel control.** During a run, `analyzeBtn` is only `disabled`
  (`step2-prompt-panel.js:60`); there is no stop affordance anywhere.
- **Cache wrapper is signal-agnostic.** `withLlmCache(cacheKey, callFn)`
  (`src/ai/cache.js:13`) does a fast Tauri `load_llm_cache` invoke, then calls
  `callFn()`, then `save_llm_cache`. Because the network call lives entirely
  inside `callFn`, a signal can be threaded through the existing closure without
  changing `withLlmCache`'s signature. If `callFn` throws (abort), `save_llm_cache`
  is never reached — so an aborted call is naturally never cached.
- **Proven cancel template.** `cancelTranscribe()` (`src/ui/import/transcribe.js:336`)
  shows the house pattern: reset the UI immediately, hide the cancel control,
  surface a distinct "Anulowano." message, and treat cancel separately from a
  real failure (`transcribe.js:754` — "User cancel — distinct from a real
  failure, no error dialog."). Mechanism differs: transcription SIGTERMs a
  backend sidecar; analysis is a pure frontend `fetch`, so the tool here is
  `AbortController`.
- **Error path to preserve.** The existing `catch` (`step2-prompt-panel.js:127`)
  drives FR-018 paste-and-fix: on a genuine validation/parse error with a
  non-empty `rawResponse`, it stashes the raw text via `revealPasteFix(...)`. An
  abort must NOT trigger this path (there is no usable partial body, and it isn't
  an error).

## Desired End State

While an analysis is running, the primary button reads "⏹ Zatrzymaj" (red); the
user can click it to abort the in-flight OpenRouter request. On cancel, the
progress UI resets, the log shows "Anulowano." (plus a toast), the button reverts
to "Analizuj z OpenRouter →" and is immediately usable again, and any previously
loaded reels are left untouched. Nothing is cached and the paste-fix box is not
shown. A genuine API/validation error still behaves exactly as today.

Verify by: starting an analysis against a slow/large model, clicking "Zatrzymaj"
mid-flight, and confirming the run stops within ~1s with the "Anulowano." note
and a re-enabled button; then re-running successfully.

### Key Discoveries:

- Signal threads via the existing `callFn` closure — `withLlmCache` / `cache.js`
  need no changes (`src/ai/cache.js:32`).
- `fetch` abort rejects with a `DOMException` whose `name === 'AbortError'`
  (or, in some engines, an `AbortError`-named `Error`). Detect by `e.name`.
- The cancel reuses `analyzeBtn` itself (toggle), so `index.html` needs no new
  element — only label/class swaps in JS.
- House convention: cancel is never silent and never an error dialog — surface a
  Polish toast/log (`save-prompts-location` memory + transcribe precedent).

## What We're NOT Doing

- No backend/Rust changes — this is entirely frontend.
- Not making the disk-cache read, JSON parse/validate, or apply steps separately
  cancellable (sub-millisecond / instant; a late cancel during parse is ignored
  and the run effectively completes).
- Not making the manual "Wklej JSON od AI" paste path cancellable (synchronous).
- No changes to `withLlmCache` / `cache.js` signatures.
- No confirmation dialog before cancelling (single click stops; matches transcribe).
- No new persisted state / no `.reelproj` schema change.

## Implementation Approach

Thread an optional `AbortSignal` from `runAIAnalysis` through the existing
provider closure into `callOpenRouter`'s `fetch`. Hold a module-scoped
`AbortController` so a cancel handler bound to the (toggled) analyze button can
abort the active run. Branch the existing `catch` on `e.name === 'AbortError'` to
run the reset-and-"Anulowano" path instead of the error/paste-fix path. The
`finally` block restores the button to its idle "Analizuj" state and clears the
controller.

## Phase 1: Abortable provider call

### Overview

Let `callOpenRouter` accept and forward an `AbortSignal` so its `fetch` can be
interrupted. Backwards-compatible — the parameter is optional.

### Changes Required:

#### 1. OpenRouter provider

**File**: `src/ai/providers.js`

**Intent**: Accept an optional abort signal and pass it to `fetch`, so callers
can cancel an in-flight request. No behavior change when the signal is omitted.

**Contract**: `callOpenRouter(apiKey, prompt, orModel, signal?)` →
`Promise<string>`. Add `signal` to the `fetch` options object. Update the JSDoc
boundary annotation to include `@param {AbortSignal} [signal]`. Aborting rejects
the returned promise with an `AbortError`-named exception (propagated unchanged).

### Success Criteria:

#### Automated Verification:

- Rust unchanged / still type-checks: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite still green (no parser/exporter impact): `node --experimental-vm-modules test/regression.js`
- Prettier clean: `npx prettier --check "src/ai/providers.js"`

#### Manual Verification:

- A normal analysis (no cancel) still completes and returns reels exactly as before.

**Implementation Note**: After completing this phase and all automated
verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Cancel control + lifecycle

### Overview

Give `runAIAnalysis` an `AbortController`, toggle `analyzeBtn` into a "Zatrzymaj"
stop control during the run, wire the cancel, and treat `AbortError` as a
distinct non-error outcome.

### Changes Required:

#### 1. Analysis run lifecycle + cancel handler

**File**: `src/ui/step2-prompt-panel.js`

**Intent**: Own a module-scoped `AbortController` for the active run. When
analysis starts, set the controller, switch `analyzeBtn` into stop mode (label
"⏹ Zatrzymaj", red styling, click → cancel) instead of disabling it. Pass
`controller.signal` into the provider call through the existing `withLlmCache`
closure. On cancel, abort the controller. In `catch`, branch on
`e.name === 'AbortError'`: reset progress UI (clear/hide `progressBox` steps),
`log('Anulowano.', ...)`, `toast('Anulowano analizę', ...)`, and skip the
paste-fix/error path entirely (leave existing `state.reelsData` untouched). In
`finally`, restore `analyzeBtn` to its idle "Analizuj z OpenRouter →" state and
clear the controller reference.

**Contract**:
- Module-scoped `let analysisController = null;` (or equivalent single-run guard).
- `withLlmCache(cacheKey, () => callOpenRouter(apiKey, prompt, orModel, controller.signal))`.
- Button toggle is a small helper, e.g. `setAnalyzeBtnMode('running' | 'idle')`,
  that swaps `textContent`, toggles a CSS class (e.g. `btn-danger`/`btn-primary`),
  and rebinds the click target (run vs cancel). Re-entrancy guard: ignore a new
  run while `analysisController` is non-null.
- Abort detection: `if (e.name === 'AbortError') { /* cancel path */ }` before
  the existing error handling.
- Cancelled runs must not reach `save_llm_cache` — guaranteed because the throw
  propagates out of `callFn` (no code change in `cache.js`).

**Contract (snippet — the catch branch ordering is load-bearing):**
```js
} catch (e) {
  if (e.name === 'AbortError') {
    // user cancel — distinct from a real failure, no error dialog / paste-fix
    setPS(2, ''); setPS(3, '');
    log('Anulowano.', 'info');
    toast('Anulowano analizę', 'info');
  } else {
    setPS(2, 'err'); setPS(3, 'err');
    log('BŁĄD: ' + e.message, 'err');
    // …existing FR-018 paste-fix path unchanged…
  }
} finally {
  analysisController = null;
  setAnalyzeBtnMode('idle');
}
```

#### 2. Stop-button styling (if no existing danger class)

**File**: `src/index.html` (inline `<style>`) or the relevant CSS block

**Intent**: Ensure the running-state button is visually a stop/danger action
(red). Reuse an existing danger/secondary class if one already covers it;
otherwise add a minimal `.btn-danger` rule consistent with the existing button
palette.

**Contract**: A single class toggled on `#analyzeBtn` during a run. No layout
change (same button slot). Polish label only.

### Success Criteria:

#### Automated Verification:

- Regression suite green: `node --experimental-vm-modules test/regression.js`
- Prettier clean: `npx prettier --check "src/ui/step2-prompt-panel.js"`
- App builds: `npm run tauri build` (or `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml` for the Rust half — unchanged)

#### Manual Verification:

- Start analysis against a slow/large model → button shows "⏹ Zatrzymaj" (red).
- Click "Zatrzymaj" mid-flight → run stops within ~1s; log shows "Anulowano.";
  toast appears; button reverts to "Analizuj z OpenRouter →" and is usable again.
- Previously loaded reels (if any) are unchanged after a cancel.
- A genuine error (e.g. bad API key) still shows the error path / paste-fix box —
  cancel branch did not swallow it.
- A cache-hit run (instant) does not flicker the stop button into a stuck state.
- A normal successful run is unaffected.

**Implementation Note**: After completing this phase and all automated
verification passes, pause for manual confirmation before considering the change
done.

---

## Testing Strategy

### Unit/Regression Tests:

- Existing `test/regression.js` (parser + exporters) must stay green — this
  change touches neither, so it serves as a no-regression guard.
- No new automated test is added: the change is UI/networking lifecycle, outside
  the bespoke runner's scope (parser/exporter only). Verification is manual per
  the criteria above.

### Manual Testing Steps:

1. Run `npm run tauri dev`, import an SRT, pick a slow OpenRouter model.
2. Click "Analizuj" → confirm button becomes "⏹ Zatrzymaj" (red).
3. Click "Zatrzymaj" → confirm stop within ~1s, "Anulowano." log, toast, button
   reverts and is immediately clickable.
4. Re-run and let it complete → confirm reels load normally.
5. Force an error (clear/break API key) → confirm error/paste-fix path intact.
6. Re-run with same prompt+model (cache hit) → confirm instant result, no stuck
   stop button.

## Performance Considerations

Negligible. `AbortController` is native; the only added work is one click handler
swap and a branch in `catch`. Cancelling frees the socket immediately.

## Migration Notes

None — no persisted state, schema, or backend changes.

## References

- Cancel UX template: `src/ui/import/transcribe.js:336` (`cancelTranscribe`) and
  `:754` (cancel-is-not-an-error precedent)
- Provider call: `src/ai/providers.js:3`
- Analysis lifecycle: `src/ui/step2-prompt-panel.js:39`
- Cache wrapper (unchanged): `src/ai/cache.js:13`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Abortable provider call

#### Automated

- [x] 1.1 Rust still type-checks (`cargo check`) — 0bbbd69
- [x] 1.2 Regression suite green — 0bbbd69
- [x] 1.3 Prettier clean on `providers.js` — 0bbbd69

#### Manual

- [x] 1.4 Normal analysis (no cancel) still completes and returns reels — 0bbbd69

### Phase 2: Cancel control + lifecycle

#### Automated

- [x] 2.1 Regression suite green
- [x] 2.2 Prettier clean on `step2-prompt-panel.js`
- [x] 2.3 App builds (Rust unchanged)

#### Manual

- [x] 2.4 Running state shows "⏹ Zatrzymaj" (red)
- [x] 2.5 Cancel stops within ~1s with "Anulowano." log + toast + reverted button
- [x] 2.6 Previously loaded reels unchanged after cancel
- [x] 2.7 Genuine error still shows error/paste-fix path
- [x] 2.8 Cache-hit run does not leave a stuck stop button
- [x] 2.9 Normal successful run unaffected
