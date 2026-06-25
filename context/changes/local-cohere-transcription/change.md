---
change_id: local-cohere-transcription
title: Local Cohere transcription
status: implementing
created: 2026-06-24
updated: 2026-06-25
archived_at: null
---

## Notes

<!-- Free-form notes for this change: links, ad-hoc context, decisions that don't belong in research/frame/plan. -->

- **2026-06-25 — `/10x-plan` RE-PLAN complete (native transformers 5.x architecture).** After
  the Phase 0 gate trip, re-planned with the user. Confirmed transformers 5.x is released/mature
  (PyPI 5.12.1) and whisperx 3.8.6 allows `transformers>=4.48.0` (no upper cap). User chose all 3
  recommended options: (1) **bump the shared `whisperx-engine` to transformers 5.12.x + native
  CohereAsr** (no `trust_remote_code`), Phase-0 gated, isolated-sidecar as named fallback;
  (2) **per-chunk align windows from native `audio_chunk_index`** (sentence-split fallback);
  (3) **hard gate** — existing WhisperX transcribe+align+**diarize** must survive 5.x or fall back
  to isolation. plan.md + plan-brief.md (PL) rewritten: Phase 0 = 5.x coexistence + native-Cohere
  feasibility gate; Phases 1–5 = the single-engine native build. Obsolete in the old plan and
  removed: trust_remote_code path, frozen-RC packaging probe, hand-rolled chunk-and-stitch / RMS
  boundary, the 4 remote `*_cohere_asr.py` modules from the download manifest. Ready for
  `/10x-implement local-cohere-transcription phase 0`.

- **2026-06-25 — `/10x-implement` started; Phase 0 RAN with real prereqs → BIGGER gate
  tripped → STOP + re-plan (user decision).** Token (`Vndrew`) + accepted license + 4.13 GB
  weights + Polish clip (`~/Desktop/LOVELETTER.mov`, 126.9 s) all in place this session, so
  criteria 0.1/0.4 finally ran. Result (full detail in `spike-notes.md` ADDENDUM): the model
  **loads** offline on transformers 4.57.6 via `trust_remote_code` (6.5 s), but **transcription
  fails** — the repo's `trust_remote_code` `CohereAsrProcessor` is a **degraded fallback**
  (ignores `language=`, no punctuation control, no auto-chunk, no `audio_chunk_index`), so no
  decoder prompt is built and `generate()` crashes on 4.57.6 (unhandled gap between the remote
  code's "4.52–4.55" and ">=5.3" branches). The README's full behavior is the **NATIVE
  `transformers>=5.4.0`** integration, not the remote code. **whisperx 3.8.6 requires only
  `transformers>=4.48.0` (no upper cap)**, so a bump to ≥5.4.0 is the candidate clean path — but
  it's a transformers **major-version** change to the working WhisperX engine (pyannote/align
  stack need re-validation). The plan's Phase 2 (trust_remote_code @ 4.57.6 + hand-rolled
  chunk-and-stitch + frozen RC packaging probe) no longer fits. **User chose: stop and formally
  re-plan now.** Plan revision must decide the architecture around the transformers version fork
  (native ≥5.4.0 bump vs. process/venv isolation) and resolve whisperx coexistence on ≥5.4.0.
  Hard facts already captured for the re-plan: real download manifest + `model.safetensors` =
  4131862976 bytes; `max_audio_clip_s: 35`; new deps `librosa`/`sentencepiece`/`protobuf`/
  `accelerate` (installed into `sidecar/.venv` this session — additive, dev-venv only).

- **2026-06-25 — Phase 0 gate TRIPPED → stopped, Phase 2 re-planned.** The spike
  (`spike-notes.md`) found `cohere-transcribe-03-2026` requires `trust_remote_code=True`
  (ships only as HF remote code, not native to transformers 4.57.6) and is **gated**
  (`gated: auto`, single 4.13 GB `model.safetensors`). Per the plan's gate, stopped
  before Phase 1. whisperx `pl` align coexistence verified OK in the same env. Phase 2
  rewritten: added a frozen-`trust_remote_code` packaging probe (§0) ahead of the
  rebuild, and threaded the gated-download + remote-`.py`-manifest requirement into
  Phase 1 §1. Quality read (0.1/0.4) still pending — needs HF token + accepted license
  + a Polish clip. Status moved back to `planned`; the Phase 2 revision may warrant a
  fresh `/10x-plan-review` before implementing.
- **2026-06-25 — `/10x-plan-review` run (verdict REVISE). 4 findings, all fixed in
  plan.md:** F1 (CRITICAL) gated download had no auth → added Phase 1 §3 (Bearer HF
  token on `download_model` + frontend threading + Polish 401/403 error) and corrected
  the stale "no key" scope text. F2 (WARNING) the model's first real run was inside the
  frozen probe → added a plain-venv load+transcribe prerequisite (Phase 2 §0, item 2.0a)
  that also records the real max-input length. F3 (WARNING) fixed-length chunk cuts split
  words → Phase 2 §1 now requires silence/VAD or overlap+de-dup boundary handling. F4
  (OBSERVATION) signature blast radius → caller sites (transcribe.js:207/350) named in
  Phase 1 §2. Status → `plan_reviewed`.
- **2026-06-25 — second `/10x-plan-review` (post-Phase-2 re-plan; verdict REVISE, 0
  critical / 3 warnings / 2 observations → SOUND after fixes). All 5 fixed:** F1 (WARNING,
  Lean Execution) hoisted the §2.0a plain-venv load+transcribe and the §0 frozen
  `trust_remote_code` probe **ahead of Phase 1** via a manual `huggingface-cli download`
  (feasibility probe — explicitly NOT the rejected quality GO/NO-GO; a frozen-probe failure
  can change Phase 1 §1's manifest). F2 (WARNING, Blind Spots) Phase 4 §1 now threads
  `kind`/`sentinel` + `auto`→`pl` through the **shared** `transcribeDocument` so auto-mode
  (`orchestrator.js:233`, `batch.js:210`) inherits Cohere routing and the readiness gate
  (`whisper.rs:400`) gets the sentinel — closing a path that would have re-broken the prior
  review's F1; added Progress 4.6. F3 (WARNING, Completeness) corrected the advanced-panel
  pointer (`index.html:547` + `transcribe.js:448-541`, not `settings-modal.js`) + flagged the
  missing `--temperature` engine arg. F4 (OBS) boundary cut specified as an RMS-energy
  minimum (engine has no reusable VAD over raw audio). F5 (OBS) regenerated `plan-brief.md`
  in Polish (lessons rule) + fixed the stale "full-audio segment" → per-chunk phrasing.
