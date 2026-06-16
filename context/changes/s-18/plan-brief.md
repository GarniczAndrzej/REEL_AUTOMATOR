# WhisperX Engine Readiness Probe — Plan Brief

> Full plan: `context/changes/s-18/plan.md`
> Frame brief: `context/changes/s-18/frame.md`
> Research: `context/changes/s-18/research.md`

## What & Why

The engine readiness probe does far too much work — a full frozen-`whisperx` import,
align-model load, and a real forced-align (~65 s reproduced, warm + offline) — and re-runs
it from scratch on **every** launch, with no cross-launch caching, to paint a **cosmetic,
non-gating** badge; on the user's machine an environmental factor (network-despite-offline
and/or cold onefile extraction) stretches that to ~15 min. We make the badge cheap, cached,
and non-blocking so the user never waits on it.

## Starting Point

`whisperx_engine_check` (`engine.rs:104`) spawns the sidecar `--selftest`, which loads the
real wav2vec2 align model and runs a real `whisperx.align()` every launch, unbounded and
uncached. The frontend already fires it un-awaited (`transcribe.js:92`) and the Transcribe
button never reads readiness — so it's cosmetic, just slow and potentially network-leaking.

## Desired End State

The badge paints from a cached verdict in milliseconds when nothing relevant changed; on a
cache miss it runs a **cheap** capability probe (device detect + align-dir check, no model
load, no align, no HF network), bounded by a timeout. The full self-test still exists behind
a manual "Pełna weryfikacja silnika" action. Transcription remains ungated by the badge.

## Key Decisions Made

| Decision                  | Choice                                              | Why (1 sentence)                                                                 | Source |
| ------------------------- | --------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| How much to lighten probe | Dir-check only (drop `load_align_model` + `align()`)| Removes both confirmed-expensive steps and any HF network leak                   | Plan   |
| Sidecar interface         | New `--capability` subcommand; keep `--selftest`    | Clean separation; full verification stays available on demand                    | Plan   |
| Caching + invalidation    | Content-addressed cache, key = app version + align meta | Pre-spawn computable (so it can skip the spawn); mirrors existing cache recipe | Plan   |
| Badge UX                  | Cached badge + bounded timeout + manual re-verify   | Instant badge, can never hang, full check still reachable                        | Plan   |
| Levers applied            | Both (lighten **and** cache)                        | Either neutralizes the 65 s; together they neutralize the environmental tail     | Frame/Research |

## Scope

**In scope:**
- New `--capability` subcommand in the Python sidecar (cheap device + dir check)
- New cached, timeout-bounded `whisperx_engine_capability` Rust command + `engine-readiness` cache
- Frontend: badge uses cached command; manual "Pełna weryfikacja silnika" runs the full self-test

**Out of scope:**
- Shrinking the 290 MB onefile / changing packaging
- Re-baking the align model into the binary
- Transcription / `--align-only` / diarization paths
- Gating Transcribe on readiness (never was)
- Hunting the environmental network-leak call on the user's machine (made irrelevant)

## Architecture / Approach

Two orthogonal levers, both fully in-repo: **(A)** lighten the sidecar probe so even a cache
miss is cheap and network-safe, and **(B)** cache the verdict (content-addressed JSON in
`app_cache_dir`, keyed on app version + align-model size/mtime) so the badge paints instantly
and the spawn is skipped when nothing changed. The full `--selftest` is retained behind a
manual button. Flow per tier: Python `cmd_capability` → Rust `whisperx_engine_capability`
(cache read → instant, or bounded `--capability` spawn → write cache) → JS badge.

## Phases at a Glance

| Phase                                          | What it delivers                                         | Key risk                                                        |
| ---------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| 1. Sidecar `--capability`                      | Cheap readiness JSON (no model load/align)              | Requires `sidecar/build.sh` rebuild to test (frozen binary)    |
| 2. Rust command + cache + timeout              | Cached, bounded `whisperx_engine_capability`            | Cache key must be pre-spawn computable (app version + align meta) |
| 3. Frontend cached badge + manual re-verify    | Instant badge + "Pełna weryfikacja silnika" control     | Keep full-fidelity verify reachable; Polish strings            |

**Prerequisites:** Both sidecars + `align_models/` present (run `sidecar/build.sh` +
`sidecar/fetch-ffmpeg.sh` on a fresh checkout); macOS / Apple Silicon dev environment.
**Estimated effort:** ~1–2 sessions across 3 phases (small, well-mapped surface).

## Open Risks & Assumptions

- **Engine-version invalidation relies on the app version bumping** when a new sidecar ships;
  a dev rebuild that doesn't bump app version won't auto-invalidate (mitigated by the manual
  re-verify, which rewrites the cache, and by deleting the cache file).
- **The environmental 15-min tail is not reproducible here** (frame Confidence: MEDIUM); the
  fix neutralizes it by design rather than pinning the exact leaking call. Optional user-machine
  `lsof` pin remains available but is not a blocker.
- **Onefile cold-extraction** still costs on the first-ever spawn after install; the cache makes
  the probe run rarely but does not shrink that one-time cost.

## Success Criteria (Summary)

- On launch the badge resolves quickly (cold) and effectively instantly (warm), never hanging.
- The capability probe opens no network sockets and runs no real align.
- The full self-test is still available on demand via "Pełna weryfikacja silnika", and the
  Transcribe button's enablement is unchanged.
