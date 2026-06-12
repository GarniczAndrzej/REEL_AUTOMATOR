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

- Phase 1: 1.1 (cargo check). 1.2/1.3 + manual 1.4–1.7 require running
  `sidecar/build.sh` (Python/PyInstaller, ~1 GB models, GPU/Windows boxes).
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
