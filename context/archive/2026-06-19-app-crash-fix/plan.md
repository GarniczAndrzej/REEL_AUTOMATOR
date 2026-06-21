# App Crash Fix (S-21) Implementation Plan

## Overview

S-21 targets a **random, silent, mid-session app exit during `npm run tauri dev`** for which no live reproduction or crash log was available. Research (`research.md`) concluded there is no single smoking-gun bug: the Rust backend is disciplined and the historical WKWebView crash (synchronous JS dialogs) is fully remediated. The strongest fit for "random, no error" is **OOM → silent SIGKILL**, with three concrete in-app amplifiers in the WhisperX transcription path.

Because the crash is rare and unreproducible on demand, this plan does **both**: (1) adds no-suppression instrumentation so the *next* occurrence is captured with a root cause, and (2) preemptively fixes the two highest-confidence OOM amplifiers and the release-only `panic = "abort"` landmine. The instrumentation is a permanent safety net; the fixes are independently-valuable hardening that close the most plausible silent-exit mechanisms now rather than waiting an unknown number of sessions for a repro.

## Current State Analysis

- **No global error handlers anywhere in `src/`** (verified): no `window.onerror`, no `addEventListener('error')`, no `addEventListener('unhandledrejection')`. Any async failure is invisible — which is also why a JS-side crash, if it is one, leaves no trace. `src/main.js:12` registers a `DOMContentLoaded` handler that already `await`s `hydrateKeys()`; this is the natural early registration point.
- **No Rust panic hook.** `lib.rs:11-41 run()` builds and runs the Tauri app; `lib.rs:40` `.expect(...)` covers startup only. A panic inside a command future unwinds silently in a dev (`panic = "unwind"`) build, leaving no logged cause.
- **Unbounded sidecar output buffers** in `drive_engine` (`whisper.rs:273-274`): `stdout_buf` and `stderr_buf` are plain `String`s that grow for the entire run. Every `Stderr` chunk is appended unconditionally (`whisper.rs:290-292`). A chatty engine run (torch/ctranslate2/tqdm spew) can grow `stderr_buf` to hundreds of MB with no cap — the single most plausible in-app mechanism for a silent mid-session disappearance during a long transcription. `stdout_buf` holds the **JSON result payload** (parsed at `whisper.rs:517` and `:717` via `serde_json::from_str(stdout_buf.trim())`) and therefore must NOT be capped.
- **Cancel/completion orphan race.** `drive_engine` sets the global child handle to `None` at `whisper.rs:324` after its loop; `cancel_transcription` does `TRANSCRIBE_CHILD.lock().unwrap().take()` at `whisper.rs:740` then SIGTERM→(300ms)→SIGKILL. If the driver reaches `:324` *before* cancel runs `.take()`, cancel gets `None` and **never kills** the child. Because `drop(CommandChild)` does **not** kill the OS process (documented `engine.rs:92-96`) and SIGKILL of the PyInstaller bootloader orphans the torch worker, repeated cancels in one session can accumulate multi-GB orphaned torch workers → cumulative memory pressure → OOM SIGKILL. This cumulative drift matches the "random-feeling" symptom.
- **Release-only `panic = "abort"`** at `Cargo.toml:48` under `[profile.release]`. `[profile.dev]` (`Cargo.toml:50-52`) does not override it, so dev uses default `panic = "unwind"`. The reported crash is in `tauri dev`, so abort describes a **production landmine**, not the dev mechanism — but it is worth removing for release stability.
- **`FileReader` with no `onerror`** at `src/ui/import/segments.js:61-84`: a failed SRT read silently leaves `state.srtContent` unset (silent data-loss gap, not a crash).
- **Existing Rust test pattern**: `whisper.rs:543-544` already has a `#[cfg(test)] mod tests` (and `models.rs:288`), so a bounded-tail unit test fits the established structure. The node regression suite (`test/regression.js`) only covers JS parser/exporters and cannot reach Rust buffer logic.

## Desired End State

After this plan:

1. The **next** random crash is no longer silent — a Rust panic prints a tagged crash log via `std::panic::set_hook`, and any uncaught JS error or promise rejection is logged to the console and surfaced as a Polish `toast()` instead of being swallowed.
2. `drive_engine` can no longer grow `stderr_buf` without bound — stderr is reduced to a bounded tail (~64KB) while still parsing every `PROGRESS` line and preserving the trailing diagnostic context shown on a non-zero exit. A unit test proves the tail stays bounded under arbitrarily large input.
3. A cancelled transcription always reaps its engine child: `drive_engine` owns the child's full lifecycle and kills it on cancel before nulling the handle, eliminating the window where the handle is `None` and nobody kills the orphan.
4. A packaged (release) build no longer aborts the whole process on a panic — `panic = "unwind"` lets a panic be contained the same way dev contains it.
5. A failed SRT `FileReader` read surfaces a Polish error toast instead of silently leaving `state.srtContent` unset.

**Verification**: `cargo check` + `cargo test` pass; `node --experimental-vm-modules test/regression.js` still passes (no parser/exporter regression); a forced panic in a temporary test command prints the hook output; a transcription runs to completion and a cancelled-then-restarted transcription works with no accumulating orphaned `whisperx-engine`/torch processes (Activity Monitor).

### Key Discoveries:

- `whisper.rs:289-292` — every stderr chunk appended unconditionally; `stdout_buf` (`:289`, `:517`, `:717`) is the JSON payload and must stay uncapped.
- `whisper.rs:324` vs `:740` — the orphan race window (driver nulls handle before cancel takes it).
- `engine.rs:92-96` — `drop(CommandChild)` does NOT kill the OS process; an explicit kill is mandatory.
- `whisper.rs:543` — existing `#[cfg(test)] mod tests` to extend.
- `src/main.js:12` — `DOMContentLoaded` handler, the early registration point for JS global listeners.
- `Cargo.toml:48` — release `panic = "abort"`; dev unwinds (`:50-52`).
- Lesson (`lessons.md:19-24`): never use synchronous `window.prompt/confirm/alert`; use `toast()` for notifications. All user-facing strings stay Polish.

## What We're NOT Doing

- **Not** wrapping every fire-and-forget async click handler in try/catch (`export-popover.js`, `step2-preset-bar.js`, `transcribe.js`, `openrouter-picker.js`). The new global `unhandledrejection` listener surfaces these anyway; a full robustness refactor is out of scope.
- **Not** touching the dead waveform path (`waveform.rs:92-159`, `src/selection/waveform.js`) — latent OOM, no live caller; not a current suspect.
- **Not** adding timeouts to `ffmpeg.rs` / `waveform.rs` decode — a wedged ffmpeg is a hang, not a crash.
- **Not** streaming stdout to a temp file or ring-buffering stdout — stdout is the bounded JSON result payload and is left as-is.
- **Not** building a JS-level automated test for the new global handlers (manual verification only); the only new automated test is the Rust bounded-tail unit test.
- **Not** changing the cancel UX, the 250ms poll cadence, or the SIGTERM→300ms→SIGKILL escalation timings.

## Implementation Approach

Four phases in research's recommended order: instrument first (so any crash during the remaining work is itself captured), then fix the two OOM amplifiers, then the release landmine. Phases 2 and 3 both touch `drive_engine` but are kept separate for clean, independently-verifiable diffs (memory cap vs lifecycle reaping). Each phase is small and reversible.

## Critical Implementation Details

- **Instrumentation must surface, never suppress.** The Rust panic hook chains to (does not replace) any default behavior in a way that still prints; the JS listeners log AND toast but must not `preventDefault()` in a way that hides the error from the console. This directly honors the S-21 guardrail against "log-suppression / silent crash-swallowing."
- **`stdout_buf` is load-bearing** — it is `serde_json::from_str`-parsed at `whisper.rs:517` and `:717`. Capping or evicting its head corrupts the result. Only `stderr_buf` is bounded.
- **Ordering in `drive_engine` cancel path**: the child must be killed *before* the handle is set to `None`, and `cancel_transcription` must not also try to kill a handle the driver already took — otherwise a double-kill or a kill-by-recycled-handle is possible. The driver owning the lifecycle resolves this; `cancel_transcription` only sets the flag and kills if it still holds the handle (fallback for the not-yet-in-driver window).

## Phase 1: Diagnostic Instrumentation

### Overview

Make the next crash legible. Add a Rust panic hook and JS global error/rejection listeners that log and surface (Polish `toast()`) without suppressing, plus the one silent-data-loss `FileReader.onerror` fix.

### Changes Required:

#### 1. Rust panic hook

**File**: `src-tauri/src/lib.rs`

**Intent**: Install a `std::panic::set_hook` at the very start of `run()` (before `tauri::Builder`) so any panic in a command future or Tauri/tokio internal prints a tagged, identifiable crash log to stderr instead of unwinding silently.

**Contract**: `std::panic::set_hook(Box<dyn Fn(&PanicHookInfo)>)` called once at the top of `run()`. The hook logs the panic payload + location with a greppable tag (e.g. `[PANIC]`) and still allows the default unw*ind/print behavior to be visible. No change to the `invoke_handler` list or `.run()` call.

#### 2. JS global error + rejection listeners

**File**: `src/main.js`

**Intent**: Register `window.addEventListener('error', …)` and `window.addEventListener('unhandledrejection', …)` early in the `DOMContentLoaded` handler (`main.js:12`) so any uncaught exception or rejected promise is `console.error`-logged and shown as a Polish `toast()` rather than silently swallowed.

**Contract**: Two listeners registered before the rest of boot. Each logs the error/reason and calls the existing `toast()` helper with a Polish message. Must not call `preventDefault()` in a way that hides the console error. Reuse the project's existing `toast()` import path used elsewhere in `src/ui/`.

#### 3. FileReader onerror

**File**: `src/ui/import/segments.js`

**Intent**: Add `onerror`/`onabort` to the SRT `FileReader` (`segments.js:61-84`) so a failed read surfaces a Polish error toast instead of silently leaving `state.srtContent` unset.

**Contract**: `reader.onerror` (and `onabort`) handlers that `toast()` a Polish failure message and leave state unchanged. The existing `onload` path is untouched.

### Success Criteria:

#### Automated Verification:

- Rust type-checks: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite still passes: `node --experimental-vm-modules test/regression.js`
- Prettier clean: `npx prettier --check "src/**/*.{js,css,html}"`

#### Manual Verification:

- A deliberately-thrown JS error and a rejected promise each produce a console log AND a Polish toast.
- Temporarily wiring a `panic!()` into a dev command prints the `[PANIC]`-tagged hook output in the `tauri dev` terminal (then revert the temporary panic).
- Simulating a `FileReader` failure (e.g. an unreadable file) shows the Polish error toast and does not silently proceed.
- No regression: normal SRT/video import, transcription, and export still work.

**Implementation Note**: After completing this phase and all automated verification passes, pause for manual confirmation before proceeding to Phase 2.

---

## Phase 2: Bound the Sidecar stderr Buffer

### Overview

Remove the unbounded `stderr_buf` growth in `drive_engine` — the top OOM amplifier — by retaining only a bounded tail, while still parsing every `PROGRESS` line. Leave `stdout_buf` (the JSON payload) intact. Add a unit test proving the tail stays bounded.

### Changes Required:

#### 1. Bounded-tail helper + extraction

**File**: `src-tauri/src/whisper.rs`

**Intent**: Replace the unconditional `stderr_buf.push_str(&chunk)` (`whisper.rs:292`) with a bounded-tail accumulation: keep at most ~64KB of the most recent stderr bytes so the diagnostic context shown on a non-zero exit survives, but total memory is capped regardless of run length. `PROGRESS`-line parsing via `stderr_line` (`:294-314`) is unchanged — it consumes lines as they arrive and never accumulates. Factor the tail-capping into a small pure helper (`fn append_bounded_tail(buf: &mut String, chunk: &str, max_bytes: usize)` or equivalent) so it is unit-testable in isolation. `stdout_buf` accumulation (`:289`) is left exactly as-is.

**Contract**: A pure helper that appends a chunk and truncates `buf` from the front to a byte ceiling (on a UTF-8 char boundary, since `String::from_utf8_lossy` output is valid UTF-8). `drive_engine` calls it for stderr only. The returned `stderr_buf` semantics at the call sites (`whisper.rs:504`, `:705`) are unchanged except that very long runs now carry only the tail.

#### 2. Unit test for the bounded-tail helper

**File**: `src-tauri/src/whisper.rs` (existing `#[cfg(test)] mod tests`, `:543`)

**Intent**: Add a test feeding the helper far more than the ceiling (e.g. many MB of chunks) and asserting the buffer never exceeds the ceiling and retains the latest content.

**Contract**: A `#[test]` asserting `buf.len() <= max_bytes` after large input and that the final bytes are the most recent ones. Char-boundary safety covered by including multibyte input.

### Success Criteria:

#### Automated Verification:

- Rust type-checks: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Rust tests pass: `~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml`
- Regression suite still passes: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- A normal transcription completes successfully and the result JSON parses (proves `stdout_buf` untouched).
- A transcription that fails (non-zero exit) still surfaces a meaningful Polish error containing the recent stderr tail.
- Progress bar still updates during transcription (proves `PROGRESS` parsing intact).
- During a long transcription, app memory does not grow unbounded with stderr volume (Activity Monitor).

**Implementation Note**: Pause for manual confirmation before Phase 3.

---

## Phase 3: Close the Cancel/Completion Orphan Race

### Overview

Make `drive_engine` own the engine child's entire lifecycle so a cancelled run is always reaped, eliminating the window where the handle is `None` and nobody kills the orphaned torch worker.

### Changes Required:

#### 1. Reap the child inside drive_engine on cancel

**File**: `src-tauri/src/whisper.rs`

**Intent**: When `drive_engine` breaks out of its loop on the cancel flag (`whisper.rs:279-281`), it must kill its own child (SIGTERM → 300ms → SIGKILL, mirroring the existing `cancel_transcription` escalation) before setting the handle to `None` (`:324`). This closes the race: the driver, which always holds the child, is the single reaper for the cancel path.

**Contract**: In the cancel-break branch, take the child from `TRANSCRIBE_CHILD` (or use the locally-owned handle), perform the Unix SIGTERM→sleep(300ms)→`kill()` escalation (and `kill()` on non-unix), then set the handle to `None`. The normal-completion path (`Terminated`/stream-closed) still just nulls the handle. Reuse/extract the kill escalation already in `cancel_transcription` (`whisper.rs:747-759`) so the logic lives in one place.

#### 2. Reduce cancel_transcription to flag + fallback

**File**: `src-tauri/src/whisper.rs`

**Intent**: `cancel_transcription` (`whisper.rs:738`) sets `TRANSCRIBE_CANCELLED` and, if it still holds the handle (the window before the driver has taken ownership / for the no-driver case), performs the same escalation as a fallback. It no longer races the driver for the kill.

**Contract**: `cancel_transcription` stores the cancel flag, then `take()`s the handle; if `Some`, runs the shared kill escalation; if `None`, the driver is handling (or has handled) the kill — return `Ok(())`. Behavior for an in-flight cancel is unchanged from the user's perspective (still SIGTERM→SIGKILL); only the ownership/ordering is deterministic.

### Success Criteria:

#### Automated Verification:

- Rust type-checks: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Rust tests pass: `~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml`

#### Manual Verification:

- Start a transcription, cancel it: UI returns to the cancelled state promptly and a new transcription can be started immediately.
- After cancelling several transcriptions in one session, Activity Monitor shows no accumulating orphaned `whisperx-engine` / Python / torch processes and no creeping memory.
- A transcription allowed to complete normally still returns its result (completion path unaffected).
- Cancel pressed at the very end of a run (near the completion boundary) does not double-kill or error.

**Implementation Note**: Pause for manual confirmation before Phase 4.

---

## Phase 4: Release Panic Hardening

### Overview

Remove the release-only `panic = "abort"` landmine so a packaged build contains a panic the same way dev does.

### Changes Required:

#### 1. Switch release profile to unwind

**File**: `src-tauri/Cargo.toml`

**Intent**: Change `[profile.release]` `panic = "abort"` (`Cargo.toml:48`) to `panic = "unwind"` so a panic in a packaged build is unwound (and caught by the Phase 1 hook) instead of aborting the whole process.

**Contract**: `panic = "unwind"` under `[profile.release]`. No other profile keys change.

### Success Criteria:

#### Automated Verification:

- Release build compiles: `~/.cargo/bin/cargo build --release --manifest-path src-tauri/Cargo.toml` (or `npm run tauri build` if a full bundle is feasible).
- Rust tests pass: `~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml`

#### Manual Verification:

- A packaged/release build launches and runs a transcription successfully.
- (Optional, if a temporary panic is wired) a panic in a release build is logged by the hook rather than aborting silently.

**Implementation Note**: Final phase — confirm the full pipeline (import → transcribe → analyze → export) still works end-to-end.

---

## Testing Strategy

### Unit Tests:

- Bounded-tail helper (`whisper.rs` test module): buffer never exceeds the byte ceiling under large input; retains most-recent bytes; multibyte-safe (no panic on char boundary).

### Integration Tests:

- None automated for the sidecar lifecycle (requires the bundled `whisperx-engine` + ffmpeg sidecars and a real audio file). Covered by manual verification.

### Manual Testing Steps:

1. Wire a temporary `panic!()` into a dev command, run `tauri dev`, confirm the `[PANIC]` hook output appears, then revert.
2. Throw a JS error and reject a promise in the console; confirm each logs + toasts in Polish.
3. Run a full transcription to completion; confirm result parses and progress updates.
4. Cancel a transcription mid-run; confirm prompt return to cancelled state and immediate restart.
5. Cancel several transcriptions in one session; watch Activity Monitor for orphaned engine/torch processes and memory creep (should be none).
6. Force a `FileReader` failure on SRT import; confirm Polish error toast, no silent proceed.
7. Build a release bundle; confirm it launches and transcribes.

## Performance Considerations

- Bounding `stderr_buf` strictly reduces memory and has negligible CPU cost (front-truncation only when over the ceiling).
- `panic = "unwind"` slightly increases release binary size and adds unwinding tables vs abort — acceptable for a desktop app; not on any hot path.
- No change to the 250ms cancel poll cadence or progress-emit frequency.

## Migration Notes

None — no schema, no `.reelproj` format change, no persisted-data impact. All changes are runtime behavior / build config.

## References

- Related research: `context/changes/app-crash-fix/research.md`
- Cancel/orphan prior art: `context/archive/2026-06-12-builtin-whisperx-transcription/plan.md:527-562`
- Lesson: synchronous JS dialogs crash WKWebView (`context/foundation/lessons.md:19-24`) — use `toast()`, keep strings Polish.
- Key code: `src-tauri/src/whisper.rs:266-326` (driver), `:738-759` (cancel), `src-tauri/src/engine.rs:92-96` (drop ≠ kill), `src-tauri/src/lib.rs:11-41` (run), `src-tauri/Cargo.toml:44-52` (profiles), `src/main.js:12` (boot), `src/ui/import/segments.js:61-84` (FileReader).

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Diagnostic Instrumentation

#### Automated

- [x] 1.1 Rust type-checks (`cargo check`) — 96d7f21
- [x] 1.2 Regression suite passes (`test/regression.js`) — 96d7f21
- [x] 1.3 Prettier clean — 96d7f21

#### Manual

- [x] 1.4 JS error + rejection each log and toast (Polish)
- [x] 1.5 Temporary `panic!()` prints `[PANIC]` hook output, then reverted
- [x] 1.6 FileReader failure shows Polish toast, no silent proceed
- [x] 1.7 No regression in import/transcribe/export

### Phase 2: Bound the Sidecar stderr Buffer

#### Automated

- [x] 2.1 Rust type-checks (`cargo check`) — 5a1bcda
- [x] 2.2 Rust tests pass (`cargo test`) — 5a1bcda
- [x] 2.3 Regression suite passes (`test/regression.js`) — 5a1bcda

#### Manual

- [x] 2.4 Normal transcription completes, result JSON parses (stdout untouched)
- [x] 2.5 Failed transcription surfaces Polish error with recent stderr tail
- [x] 2.6 Progress bar still updates (PROGRESS parsing intact)
- [x] 2.7 App memory does not grow unbounded with stderr volume

### Phase 3: Close the Cancel/Completion Orphan Race

#### Automated

- [x] 3.1 Rust type-checks (`cargo check`) — 6584eb3
- [x] 3.2 Rust tests pass (`cargo test`) — 6584eb3

#### Manual

- [x] 3.3 Cancel returns to cancelled state promptly; restart works immediately
- [x] 3.4 Multiple cancels leave no orphaned engine/torch processes or memory creep
- [x] 3.5 Normal completion still returns result
- [x] 3.6 Cancel at completion boundary does not double-kill or error

### Phase 4: Release Panic Hardening

#### Automated

- [x] 4.1 Release build compiles (`cargo build --release`) — 5055508
- [x] 4.2 Rust tests pass (`cargo test`) — 5055508

#### Manual

- [x] 4.3 Release build launches and transcribes successfully
- [x] 4.4 (Optional) panic in release build is logged by hook, not silent abort
