---
change_id: align-model-first-run-download
title: Align model first run download
status: impl_reviewed
created: 2026-06-28
updated: 2026-07-03
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

### Phase 1 refinement: torch-free proactive fetch (slow-start fix, 2026-07-03)

User report: pressing "Pobierz model wyrównania" (and the lazy first-run
fetch) "takes a long time to start downloading" — the progress bar sat dead
for a long time before anything moved. Measured cause: `--fetch-align-model`
against an *already-populated* cache took **~99 s** with zero bytes to
transfer. The delay was entirely pre-download overhead, NOT the network:
`cmd_fetch_align_model` did `import whisperx` (drags torch/transformers) and
then `_ensure_align_model` ran `load_align_model(model_cache_only=True)`,
which loads the full ~1.2 GB weight into torch RAM just to confirm presence —
and, after a real download, loaded it a *second* time to "validate". None of
that is needed to download a file. The cold onefile spawn (~40–60 s,
[[whisperx-cold-spawn-cost]]) is unavoidable; the whisperx import + 1.2 GB
torch load stacked on top of it was not.

Fix (engine only, whisperx_engine.py):
- `cmd_fetch_align_model` emits `PROGRESS phase=download percent=0`
  **immediately**, before any heavy import, so the UI shows "Pobieranie… 0%"
  the moment the spawn is ready instead of a frozen bar.
- For the shipping (HF-backed) languages it downloads with **only**
  `huggingface_hub.snapshot_download` — no `import whisperx`. Repo id resolves
  from a small local `_ALIGN_HF_REPOS` mirror of whisperx's
  `DEFAULT_ALIGN_MODELS_HF` (Polish scope); an already-cached model is skipped
  via a torch-free presence probe (`_align_model_cached`, matching engine.rs
  `align_model_present`); the post-download torch validation load is skipped
  (the on-disk snapshot + the next real `align()` is the validation).
  Non-HF/torchaudio languages still fall back to the whisperx path.
- Shared download machinery (`ProgressTqdm`, `allow_patterns`,
  `_download_align_snapshot`) hoisted to module level so `_ensure_align_model`
  (lazy path, whisperx already warm) and the proactive fetch use one impl.

Verified from source: populated-cache no-op dropped **99 s → 0.036 s**
(instant, no whisperx import); an empty-dir fetch emits `download 0`
immediately and streams to 80 % (976 MB, correct HF blob layout) with no
errors. Frozen-binary rebuild + `--selftest ok:true` re-confirmed after.
