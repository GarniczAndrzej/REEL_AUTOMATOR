---
date: 2026-06-19T13:02:37+0200
researcher: GarniczAndrzej
git_commit: 280114498add8bcb2bb70c2103ec4ee2821b3613
branch: master
repository: REEL_AUTOMATOR
topic: "Diagnose the root cause of the random mid-session app crash during `tauri dev` (S-21)"
tags: [research, codebase, stability, tauri, whisperx, panic, oom, wkwebview]
status: complete
last_updated: 2026-06-19
last_updated_by: GarniczAndrzej
---

# Research: Random mid-session app crash during `tauri dev` (S-21 / app-crash-fix)

**Date**: 2026-06-19T13:02:37+0200
**Researcher**: GarniczAndrzej
**Git Commit**: 280114498add8bcb2bb70c2103ec4ee2821b3613
**Branch**: master
**Repository**: REEL_AUTOMATOR

## Research Question

Roadmap slice **S-21 (`app-crash-fix`)**: "The app no longer randomly closes mid-session during `npm run tauri dev`. Root cause is identified (Rust panic, unhandled JS exception, Tauri IPC crash, sidecar OOM, or OS-level signal) and fixed — with a reproducibility note and a regression guard where possible."

No live repro/log was available, so this is a **cold codebase hunt for crash-prone patterns**, ranked into hypotheses, plus a diagnosis-first plan to capture the actual crash signal.

## Summary

**There is no single smoking-gun bug.** The Rust backend is unusually disciplined (almost everything returns `Result<_, String>`, no unguarded `.unwrap()` on normal paths), and the highest-historical-risk frontend pattern — synchronous `window.prompt/confirm/alert`, which the team already learned hard-crashes the macOS WKWebView — has been **fully remediated** (zero occurrences in `src/`, verified). So the crash is most likely **resource/lifecycle-driven, not a code-logic panic.**

Ranked hypotheses for a *random, silent, mid-session* exit during `tauri dev`:

1. **OOM → SIGKILL (silent, no log).** The strongest fit for "random, no error." Three concrete in-app amplifiers exist in the WhisperX transcription path: (a) **unbounded `stdout_buf`/`stderr_buf` Strings** in `drive_engine` (`whisper.rs`) that grow for the whole run; (b) **leaked/orphaned PyInstaller torch workers** from a cancel/completion race that keep multi-GB models resident; (c) the WhisperX engine itself (torch + model + long audio) outgrowing RAM. A SIGKILL from the OS leaves no Rust panic and no JS error — exactly a "the window just vanished" signature.
2. **A panic that escapes to abort the process.** In **dev** this is *weaker than it first looks* — see the important correction below. A main-thread / FFI-boundary panic (e.g. around the `libc::kill` call, or inside a Tauri/tokio/plugin internal) could still take the process down even when unwinding.
3. **Frontend unhandled promise rejections.** Real robustness gaps exist (many fire-and-forget `async` click handlers, no global `unhandledrejection` handler), but these cause *silent failures / inconsistent UI state*, **not** a WKWebView crash. Worth hardening; unlikely to be THE cause. (One agent overstated this — corrected below.)

**Recommended first move is diagnosis, not a fix:** capture the actual termination **signal** (SIGKILL vs SIGABRT vs SIGSEGV) and any dev-console output, because the signal family discriminates between these hypotheses decisively.

## Important corrections to the agent sweep (verified by hand)

- **`panic = "abort"` is RELEASE-only and does NOT apply to `tauri dev`.** `panic = "abort"` is set at `src-tauri/Cargo.toml:48` under `[profile.release]`. `[profile.dev]` (`Cargo.toml:50-52`) sets only `incremental = true` and does **not** override `panic`, so dev builds use the default `panic = "unwind"`. The reported crash is in `tauri dev`, so the "any panic aborts the whole process" theory describes a **production landmine**, not the dev-mode mechanism. (Sub-agent reported this as `Cargo.toml:90` with abort applying broadly — both the line number and the dev applicability were wrong.) It is still worth fixing for release stability, but it does not explain a dev crash.
- **Unhandled promise rejections do NOT crash WKWebView.** They log to the console and leave state inconsistent. The genuine WebKit-level hard-crash pattern is the *synchronous dialog* one (`window.prompt/confirm/alert`), and that is already gone from `src/`. So the frontend "CRITICAL" rejection findings are real code-quality issues but should be **downgraded** as crash suspects.

## Detailed Findings

### Area 1 — Frontend (WKWebView) — `src/`

- **No synchronous dialogs remain (verified).** `grep -rnE "window\.(prompt|confirm|alert)\("` over `src/` returns only a *comment* at `src/ui/import/transcribe.js:252` ("window.confirm() does not reliably show a panel"). The S-03 remediation (in-app overlay modal + async `@tauri-apps/plugin-dialog` `ask()` + `toast()`) is complete. **This historical #1 crash cause is closed.**
- **No global error handlers (verified).** No `window.onerror`, no `addEventListener('error'…)`, no `addEventListener('unhandledrejection'…)` anywhere in `src/`. Consequence: any async failure is invisible — which is also why a JS-side crash, if it is one, leaves no trace. Adding these handlers is the cheapest *diagnostic* win (log + `toast()` the error instead of swallowing it).
- **Fire-and-forget async click handlers (robustness gap, not a crash).** Many handlers call an `async` function without `await`/`try-catch`/`.catch()`:
  - `src/ui/export-popover.js:41,44,47,50,53,56` (`saveFormat`/`copyFormat`), `:59-62` (`exportSRT/VTT/MD`, `copyPrompt`)
  - `src/ui/step2-preset-bar.js:156-157` (`importPresets`/`exportPresets`)
  - `src/ui/import/transcribe.js:236-244` (`downloadModel`/`deleteModel`)
  - `src/ai/openrouter-picker.js:5,123` (`loadOrModels`)
- **Missing `FileReader` error handling** at `src/ui/import/segments.js:61-84` — `onload` set, no `onerror`/`onabort`; a failed SRT read silently leaves `state.srtContent` unset (downstream inconsistency, not a crash).
- Canvas/waveform draw, the `emit()`/`subscribe()` pub-sub, and navigation were all checked — no unbounded loops, no recursion storm, no `window.close()`/reload. Clean.

### Area 2 — Rust panic surfaces — `src-tauri/src/`

The backend is clean: almost everything is `Result<_, String>` with `.unwrap_or(...)`/`.ok()?`. The only non-test `.unwrap()` on a normal path:

- **Three `TRANSCRIBE_CHILD.lock().unwrap()` sites** on the global `static Mutex<Option<CommandChild>>`: `whisper.rs:20` (`ensure_engine_free`), `:271` and `:324` (`drive_engine`), `:740` (`cancel_transcription`). These panic only on **lock poisoning** (a prior panic while the guard was held). The critical sections are trivial assignments, so first-order poisoning is unlikely — but in a dev (unwind) build, a poison would then panic on every subsequent transcribe/cancel, compounding a crash.
- `lib.rs:40` `.expect("error while running tauri application")` — startup only, not mid-session.
- `drive_engine` (`whisper.rs:266-326`) was read line-by-line: exit handling, output parsing (`from_utf8_lossy`, `parse().unwrap_or(0.0)`, `drain(..=nl)` with `nl` from `find('\n')`), and channel recv are all bounds- and panic-safe. The body itself does not panic on sidecar I/O.
- Slice indexing (`waveform.rs:82-83,139,151-153`, `models.rs:130-131`) and integer arithmetic (`waveform.rs:99-100`, `models.rs:216`, `whisper.rs:204`) are all guarded. One theoretical edge: `models.rs:130-131` byte-slices an externally-supplied `expected` SHA string (`&expected[..12]`) — would panic only if a curated hash contained a multibyte char at a byte boundary (in practice hex; LOW).
- **No** `tokio::spawn` / `thread::spawn` / `tauri::async_runtime::spawn`; all async work runs inside `#[tauri::command] async fn` bodies. No `tauri::State`/`OnceCell`/`RefCell` (no borrow-panic risk); shared state is lock-free atomics plus the one `Mutex`.

### Area 3 — Sidecar lifecycle & memory (strongest OOM candidates)

- **Unbounded sidecar output buffers** — `drive_engine` `whisper.rs:273-274` keeps `stdout_buf`/`stderr_buf` as plain `String`s that grow for the entire run; every `Stderr` chunk is appended unconditionally (`whisper.rs:289-291`). A chatty/verbose engine run (torch/ctranslate2/tqdm spew) can grow `stderr_buf` to hundreds of MB with no cap — an in-app allocation that, combined with the engine footprint, can push the process to OOM (silent SIGKILL, no panic log). **This is the single most plausible in-app mechanism for a silent mid-session disappearance during a long transcription.**
- **Cancel/completion orphan race** — `cancel_transcription` `whisper.rs:740` does `TRANSCRIBE_CHILD.lock().unwrap().take()` to SIGTERM→(300ms)→SIGKILL the child; `drive_engine` sets the handle to `None` at `whisper.rs:324` after the loop. If the loop reaches `:324` *before* cancel runs `.take()`, cancel gets `None` and **never kills** the child. Because `drop(CommandChild)` does **not** kill the OS process (documented at `engine.rs:90-96`), and SIGKILL of the PyInstaller bootloader orphans the torch worker, repeated cancels in one session can **accumulate multi-GB orphaned torch workers** → cumulative memory pressure → OOM SIGKILL. This "random-feeling" cumulative drift matches the symptom well.
- **WhisperX engine OOM** — torch + wav2vec2 align model + a long audio file is the likeliest *root* OOM; if it's the engine child that dies, that surfaces as a Polish error toast (`exit_code != Some(0)`), but if the *app* is the one the OS reaps under shared pressure, it's silent.
- **No hot-path sidecar spawning** in the shipped build. `ensure_engine_free` (`whisper.rs:19-24`) serializes transcribe/align; readiness probes are cache-reads that never spawn on launch (S-18). ffmpeg waveform decode would be hot **if** the waveform UI existed — but it does not (next point).
- **Waveform memory/cache are DEAD code.** `extract_waveform` (`waveform.rs:92-159`) reads the full decoded PCM into one `Vec<u8>` then a second `Vec<f32>` with no span cap, and `src/selection/waveform.js` keeps an unbounded `cachedPeaks` Map — **but `loadWaveform`/`drawWaveform`/`cachedPeaks` have no live caller** (the clip-trim/waveform UI was removed in the step2 declutter; see `src/ui/step2-reel-list.js:4`). Latent only; not a current suspect. Worth fixing if that UI ever returns.
- `ffmpeg.rs` (`run_ffmpeg_output`) and the `waveform.rs` decode have **no timeout** — a wedged ffmpeg hangs the await forever (UI stuck), a hang not a crash.

## Code References

- `src-tauri/Cargo.toml:48` — `panic = "abort"` (RELEASE only; dev unwinds — `Cargo.toml:50-52`)
- `src-tauri/src/whisper.rs:273-274,289-291` — unbounded `stdout_buf`/`stderr_buf` (top OOM amplifier)
- `src-tauri/src/whisper.rs:324` vs `:740` — cancel/completion orphan race (leaks torch workers)
- `src-tauri/src/whisper.rs:20,271,324,740` — `TRANSCRIBE_CHILD.lock().unwrap()` (poison-only panic)
- `src-tauri/src/engine.rs:90-96` — `drop(CommandChild)` does NOT kill the OS process
- `src/ui/import/transcribe.js:252` — only remaining mention of `window.confirm` (a comment; dialog already removed)
- `src/ui/export-popover.js:41-62`, `src/ui/step2-preset-bar.js:156-157`, `src/ui/import/transcribe.js:236-244`, `src/ai/openrouter-picker.js:5,123` — fire-and-forget async handlers (robustness)
- `src/ui/import/segments.js:61-84` — `FileReader` with no `onerror`
- `src-tauri/src/waveform.rs:92-159` & `src/selection/waveform.js` — full-PCM-in-RAM + unbounded cache (DEAD code)

## Architecture Insights

- **Dev vs release panic behavior diverge** — a panic that is contained (unwound) in `tauri dev` could *abort* in a release build because of `panic = "abort"`. A crash that only reproduces in a packaged build, or that stops reproducing under dev, points here.
- **Silent SIGKILL ≠ panic.** None of the OOM/orphan mechanisms produce a Rust panic log or a JS error; they manifest as the process simply vanishing. A "random, no error" disappearance is far more consistent with OOM/signal than with a logged panic — which is why **capturing the signal is the decisive first diagnostic step.**
- **The error-reporting blind spot is structural** — no JS global error handler, and (in dev) panics may unwind silently out of a command future. Adding a `std::panic::set_hook` (Rust) + `unhandledrejection`/`error` listeners (JS) converts the next "random close" into an actual logged cause with near-zero risk. This is hardening that doubles as diagnosis — and it does **not** violate the S-21 guardrail against "log-suppression / silent crash-swallowing" (it does the opposite: it surfaces).

## Historical Context (from prior changes)

- `context/foundation/lessons.md` — **"Synchronous JS dialogs crash Tauri's macOS WKWebView"** (the literal crash class; now remediated in `src/`) and **"Never bake multi-GB assets into a PyInstaller onefile"** (dyld `syscall to map cache into shared region failed`, aborts before `main` — a *startup* crash, not mid-session).
- `context/archive/2026-06-16-s-03/` — origin of the sync-dialog crash; fix used `promptNative`/`openModal` + async `ask()` + `alert()`→`toast()`.
- `context/archive/2026-06-18-segment-tuning-ops/` (S-04) — `dragDropEnabled: false` in `tauri.conf.json` (verified present at `tauri.conf.json:25`); was broken DnD, not a crash.
- `context/archive/2026-06-12-builtin-whisperx-transcription/` (S-05) — the 2.6 GB Mach-O dyld load failure (lesson source); **plus** post-core fixes directly relevant here: static ffmpeg (dynamic Homebrew build broke audio extraction); **cancel-leaves-run-unrestartable** (SIGKILL orphaned the PyInstaller worker, stdout pipe stayed open, driver's `rx.recv().await` never returned → the 250ms cancel-poll + SIGTERM→SIGKILL mitigation we see today); cache key now folds in model/settings.
- `context/archive/2026-06-16-s-18/` (S-18) — every `whisperx-engine` spawn costs 37–67s cold; launch badge is cache-read-only, never spawns. (Memory: `whisperx-cold-spawn-cost`.)
- `context/changes/word-srt-fix/` (S-20) — the S-19 word-SRT fixes are now **committed** (commit 2801144; working tree is clean), separate from this crash investigation.

## Related Research

- `context/archive/2026-06-12-builtin-whisperx-transcription/plan.md:527-562` — the original sidecar cancel/orphan + static-linking fixes (closest prior art to hypotheses #1 lifecycle pieces).
- Memories: `whisperx-cold-spawn-cost`, `whisperx-sidecar-build`, `keyring-needs-apple-native`.

## Open Questions

1. **What is the actual termination signal?** SIGKILL (→ OOM/resource, hypothesis #1), SIGABRT (→ panic/`abort`, hypothesis #2), or SIGSEGV (→ native/FFI/WebKit)? Capture via the dev terminal exit, macOS **Console.app** crash reports (`~/Library/Logs/DiagnosticReports/`), and Activity Monitor memory watch during a transcription. **This single answer collapses the hypothesis tree.**
2. **Is the crash correlated with transcription / cancel?** If it clusters around long or repeatedly-cancelled transcriptions, hypothesis #1 (OOM via unbounded buffers + orphaned workers) is confirmed. If it happens with no transcription running, look at the webview / a dependency panic.
3. **Dev-only or also in a packaged build?** A packaged-only or more-frequent-when-packaged crash implicates `panic = "abort"` (release). Reproduces identically in both → resource/OOM.
4. **Does adding instrumentation (Rust `panic::set_hook` + JS `unhandledrejection`/`error` listeners) catch it?** Lowest-risk next step; turns the next occurrence into a logged root cause without changing behavior.

### Suggested diagnosis-first sequence (for `/10x-plan`)
1. Add the Rust panic hook + JS global error/rejection listeners (pure instrumentation; surfaces, never suppresses).
2. Reproduce while watching memory + Console.app; record the signal.
3. Then fix the confirmed cause — most likely: **cap `stderr_buf`/`stdout_buf` in `drive_engine`** (ring-buffer / drop non-PROGRESS stderr) and **close the cancel/completion orphan race** so a cancelled engine child is always reaped. Consider `panic = "unwind"` (or a tested abort path) for release as a separate hardening item.
4. Add a regression guard where feasible (e.g. a bounded-buffer unit check); note that the existing suite only fences parser/exporters, so most of this is manual verification.
