---
change_id: builtin-whisperx-transcription
title: Built-in WhisperX transcription + word-level alignment + model manager
status: implementing
created: 2026-06-12
updated: 2026-06-12
archived_at: null
---

## Notes

All six phases implemented and committed (p1–p6). Every automated success
criterion verifiable in a headless macOS dev session is green and checked:

- Phase 1: 1.1 (cargo check) + 1.2 (`sidecar/build.sh` emits the arch-suffixed
  binary). **Packaging re-architected** (deviation from plan): the plan baked the
  2.4 GB wav2vec2 alignment model INTO the frozen onefile, which yields a 2.6 GB
  Mach-O that macOS 26 dyld refuses to load (`syscall to map cache into shared
  region failed`, aborts before `main`). Isolated via a hello-world onefile (runs)
  vs a model-free engine build (283 MB, runs). Fix (user-approved option A): ship
  `align_models/` **beside** the sidecar — `whisperx_engine.spec` no longer bakes
  it, `build.sh` copies it to `src-tauri/binaries/align_models/`, `tauri.conf.json`
  ships it via `bundle.resources`, the engine resolves it (`--align-model-dir` /
  env / next-to-exe), and `whisper.rs`/`engine.rs` pass the resolved path.
  Verified headless: 283 MB binary `--selftest` → `{"ok":true,...,
  "alignment_model_ready":true}`, `cargo check` + regression 169/169 green.
  Remaining: 1.3 (Tauri `whisperx_engine_check` in-app), 1.4 (sample-WAV run),
  1.5 (rebuild `GPU=1` variant — old `-gpu` was baked/stale — then time Metal vs
  CPU), 1.6 (Windows box), 1.7 (real offline align run).
- Phase 2: 2.1/2.2/2.3 (cargo check/build + cache unit tests).
- Phase 3: 3.1/3.2/3.3 (regression + cargo check + v3/v4 round-trip).
- Phase 4: 4.1/4.2 (build + SHA-256 mismatch unit test). 4.3 global
  `prettier --check` left unchecked: pre-existing `styles.css` drift is out of
  scope; touched JS/HTML are prettier-clean.
- Phase 5: 5.1/5.2 (transcript-exporter regression + cargo check).
- Phase 6: 6.1/6.2 (speaker present/absent regression + cargo check).

Remaining unchecked = manual/hardware/external gates only (real engine run,
GPU/Metal vs CPU, Windows clean box, model download with live progress, NLE EDL
import, diarization with a valid HF token). Status stays `implementing` until a
human runs the manual verification; do not flip to `implemented` on these alone.

Dev bootstrap note: `src-tauri/binaries/whisperx-engine-aarch64-apple-darwin` is
a git-ignored placeholder stub (answers `--selftest` with `ok:false`) so the
Tauri build compiles before the real sidecar is frozen. `sidecar/build.sh`
overwrites it with the real binary.
