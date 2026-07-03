<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Align Model First-Run Download

- **Plan**: context/changes/align-model-first-run-download/plan.md
- **Mode**: Deep
- **Date**: 2026-06-28
- **Verdict**: REVISE → SOUND after fixes
- **Findings**: 0 critical, 3 warnings, 1 observation (all fixed)

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | PASS |
| Lean Execution | PASS |
| Architectural Fitness | WARNING (F1) |
| Blind Spots | WARNING (F1, F3) |
| Plan Completeness | WARNING (F2, F4) |

## Grounding

9/9 paths ✓, symbols ✓ (`load_align_model` `model_cache_only` @ alignment.py:80,101-102 confirmed; exit codes stop at 14 so 15 is free; `map_progress`/`engine_error_message`/transcribe.js anchors all real), brief↔plan ✓. Progress block mechanically consistent with phases.

## Findings

### F1 — Cold-path offline determinism restored for the ALIGN load only, not whisperx.load_model

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Blind Spots (also Architectural Fitness)
- **Location**: Phase 2 §1 + Phase 1 §1
- **Detail**: Plan removes the blanket `with_hf_offline` (HF_HUB_OFFLINE=1) from the whole transcribe spawn but compensates only the align load with `model_cache_only=True`. `whisperx.load_model` (asr.py:315) also takes `local_files_only` (default False, asr.py:328→362); cmd_transcribe calls it with no such kwarg. The "no cold-path regression" claim assumed align was the sole HF touchpoint — intersects logged lesson [[whisperx-cold-spawn-cost]] (~50s/spawn saved by offline).
- **Fix A ⭐ Recommended**: Also pass `local_files_only=True`/`model_cache_only=True` to `whisperx.load_model` in cmd_transcribe (cached, non-download case).
  - Strength: Fully compensates blanket-env removal; param verified at asr.py:328; transcription model always local (EXIT_MODEL_NOT_FOUND guards absence).
  - Tradeoff: One extra kwarg + note that align download is the only network-allowed load.
  - Confidence: HIGH — param confirmed; model passed as local dir via --model.
  - Blind spot: VAD load is torch-hub/local, not HF — unaffected (confirmed).
- **Fix B**: Keep plan as-is; make Phase 2.6 a hard timed cold-path gate + document rollback.
  - Strength: No code beyond verification.
  - Tradeoff: Leaves a known lesson as an assumption; reactive fix if it regresses.
  - Confidence: MED — depends on args.model never triggering HF resolution.
  - Blind spot: Cold-path timing machine-dependent; soft regression may slip.
- **Decision**: FIXED via Fix A — added "Offline determinism (BOTH loads)" detail + new Phase 1 §1b (pass `local_files_only=True` to `load_model` in cmd_transcribe).

### F2 — Download→PROGRESS emission mechanism underspecified

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 1 §1
- **Detail**: "a tqdm aggregation that emits PROGRESS phase=download" didn't name the hook for intercepting snapshot_download's per-file tqdm bars.
- **Fix**: Specify a `ProgressTqdm` subclass of `huggingface_hub.utils.tqdm` passed via `snapshot_download(..., tqdm_class=ProgressTqdm)`; ignores bars <50 MB (aggregation guard), writes `PROGRESS phase=download percent=N` to stderr for the dominant weight.
- **Decision**: FIXED — Phase 1 §1 contract now names `ProgressTqdm` + the stderr write.

### F3 — Readiness badge stays "pobierz model wyrównania" after a successful proactive download

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: Phase 3 §2–§3
- **Detail**: Card flips to "Pobrany" via cheap `align_model_status`, but badge keys on `alignment_model_ready` from the expensive selftest (37–67s cold spawn, [[whisperx-cold-spawn-cost]]), not re-run on download. Card says done, badge says not done until a full verify.
- **Fix**: Gate the badge hint on `!alignModelDownloaded` (from `align_model_status.downloaded`, no spawn) in addition to `!alignment_model_ready`; re-render badge in `downloadAlignModel` completion handler.
- **Decision**: FIXED — Phase 3 §3 contract updated.

### F4 — align-download-progress carries bytesPerSec but engine emits percent-only

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Plan Completeness
- **Location**: Phase 2 §3 + Phase 3 §2
- **Detail**: Event spec'd `{percent, bytesPerSec, etaSec}` "derive rate/ETA from wall-clock + percent," but PROGRESS carries percent only → Rust has no byte total, MB/s not computable.
- **Fix**: Engine/Rust emit `{ language, percent }` only; frontend derives MB/s + ETA from `percent` × known `ALIGN_MODEL.sizeBytes`.
- **Decision**: FIXED — Phase 2 §3 and Phase 3 §2 contracts updated.

## Notes (confirmed sound, no action)

- snapshot_download↔`from_pretrained(local_files_only=True)` HF cache-layout match — both use `cache_dir`.
- Per-language gating is functionally correct (engine load drives it; Rust `align_model_present` glob is language-agnostic — documented limitation).
- Partial-download false positives mitigated by HF's atomic snapshot symlink layout (`*.safetensors` only appears on completion).
