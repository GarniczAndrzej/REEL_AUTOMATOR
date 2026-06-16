---
change_id: s-18
title: WhisperX engine readiness probe — 15-min idle hang on every launch
status: implemented
created: 2026-06-16
updated: 2026-06-16
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

### Phase 3 deviation — launch badge is cache-read-only (no spawn)

Plan Phase 3 §1 had the launch badge call `whisperx_engine_capability`, spawning the
cheap probe on a cache miss. During manual verification the "cheap" capability probe
measured **37–67 s cold and highly variable** on the dev machine — the work we dropped
(model load + align) was never the bottleneck; the dominant cost is the 290 MB
PyInstaller onefile extraction + torch import, which every sidecar spawn pays. With a
60 s timeout the cold probe trips, never completes, and therefore never writes the cache
that was meant to make launch #2 instant — so it re-fails every launch.

**Decision (user, 2026-06-16):** the launch badge does a **pure cache read**
(`whisperx_engine_cached`, new no-spawn command) and **never spawns the sidecar**. A
miss paints a neutral "Silnik niezweryfikowany — kliknij „Pełna weryfikacja silnika”."
The verdict cache now carries an `authoritative` flag (true only when written by the
full `--selftest`), so a cache hit paints the green tier only when a real self-test
earned it. `whisperx_engine_capability` is kept as the on-demand cheap primitive but is
no longer on the launch path.
