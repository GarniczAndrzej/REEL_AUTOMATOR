---
change_id: align-model-first-run-download
title: Align model first run download
status: implementing
created: 2026-06-28
updated: 2026-07-02
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

### Phase 1 deviation: weight-format allow-list (2026-07-02)

The plan's "safetensors-only download" detail assumed the Polish align-model
repo (`jonatasgrosman/wav2vec2-large-xlsr-53-polish`) ships a redundant
`pytorch_model.bin` + `.safetensors` pair on `main`, and that excluding
`.bin` from `allow_patterns` would halve the download. A real empty-dir
`--fetch-align-model` run proved this false: the repo's `main` branch only
has `pytorch_model.bin` — no `.safetensors` at all (confirmed via the HF API
file listing). A `.safetensors` copy exists only on an unofficial, unmerged
community PR revision (`refs/pr/1`), too fragile to pin to (could close/
renumber outside this project's control). The historical ~2.4 GB local
footprint came from some earlier process fetching *both* the PR's
`.safetensors` and main's `.bin` — not from the official repo shipping a
genuine redundant pair.

Fix: `allow_patterns` in `_ensure_align_model` (whisperx_engine.py) now
accepts `*.bin` **or** `*.safetensors` — downloads whichever single weight
format the repo's `main` actually ships (Polish → `pytorch_model.bin`,
~1.2 GB, matching `ALIGN_MODEL.sizeBytes`). Still guarantees exactly one
weight format is ever fetched; just stops assuming which one. Verified via a
real empty-dir download to a scratch dir (safetensors-only allow_patterns
first failed with exit 15 — zero weight files matched — then the `.bin`-
inclusive fix downloaded and loaded successfully).
