<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Built-in WhisperX Transcription

- **Plan**: context/changes/builtin-whisperx-transcription/plan.md
- **Scope**: Phases 1–6 of 7 (Phase 7 is plan-only, not yet implemented)
- **Date**: 2026-06-13
- **Verdict**: NEEDS ATTENTION → all findings triaged & fixed
- **Findings**: 0 critical · 5 warnings · 3 observations (8 total, all FIXED)

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | PASS |
| Safety & Quality | WARNING (5 findings, now fixed) |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | PASS |

Automated criteria re-run live during the review: regression **169/169**, Prettier
clean on touched JS, `cargo check` clean. Manual gates remain pending human
verification (by design — status stays `implementing`). Phase-7 leakage check: CLEAN.

## Findings

### F1 — download_model: per-file name not sanitized (path traversal)

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM
- **Dimension**: Safety & Quality
- **Location**: src-tauri/src/models.rs:159-161, 176
- **Detail**: `model_id` was sanitized but per-file `spec.name` was not — joined into both the `.part` filesystem path and the HuggingFace URL. A registry/JS-supplied `../../foo` could escape the dir.
- **Fix**: Added `is_safe_filename()` (single `Component::Normal` assertion); `download_model` rejects unsafe names with a Polish error before any join/fetch.
- **Decision**: FIXED

### F2 — HF token passed as a process argument

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW
- **Dimension**: Safety & Quality
- **Location**: src-tauri/src/whisper.rs:270-271
- **Detail**: Token pushed onto engine argv (`--hf-token <token>`), visible via `ps`.
- **Fix**: Token now passed via the `HF_TOKEN` env var on spawn; the Python engine reads `os.environ` (explicit `--hf-token` still wins). **Requires a sidecar rebuild** to take effect (engine CLI contract change — see follow-up note).
- **Decision**: FIXED

### F3 — Non-atomic model swap can lose the existing model

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM
- **Dimension**: Safety & Quality (data safety)
- **Location**: src-tauri/src/models.rs:230-235
- **Detail**: `remove_dir_all(final_dir)` then `rename(.part → final)` — a failed rename left the user with no model.
- **Fix**: Back up the existing dir to `.bak` first, move `.part` in, delete `.bak` on success / restore it on failure. Failed swap is now non-destructive.
- **Decision**: FIXED

### F4 — align_transcript leaks temp WAV + transcript on spawn error

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW
- **Dimension**: Safety & Quality (reliability)
- **Location**: src-tauri/src/whisper.rs (align_transcript ~509-516; transcribe_video ~283/296)
- **Detail**: Temp files cleaned on happy/ffmpeg-fail paths but not on the `.sidecar()`/`.spawn()` early-error returns.
- **Fix**: Added cleanup on the sidecar/spawn error paths in both `align_transcript` and `transcribe_video`.
- **Decision**: FIXED

### F5 — Concurrent transcribe orphans the first child

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM
- **Dimension**: Safety & Quality (reliability)
- **Location**: src-tauri/src/whisper.rs (TRANSCRIBE_CHILD)
- **Detail**: A second run overwrites the single global child handle, orphaning the first (cancel can't reach it).
- **Fix**: Added `ensure_engine_free()` guard at the top of `transcribe_video` and `align_transcript` — rejects a new run while one is in flight with a Polish error.
- **Decision**: FIXED

### F6 — align_transcript coerces language "auto" → "pl"

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Plan Adherence (minor drift)
- **Location**: src-tauri/src/whisper.rs (~493)
- **Detail**: Engine needs an explicit align language; "auto" silently became "pl".
- **Fix**: Added a Polish-first comment documenting the fallback at the coercion site (behavior unchanged — intentional for this app).
- **Decision**: FIXED

### F7 — Word-level SRT export is implemented but never invoked

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Plan Adherence (dormant capability)
- **Location**: src/exporters/transcript.js (`includeWords` flag); callers in src/ui/step1-import.js
- **Detail**: Plan Phase 5 said ".srt (incl word-level)"; the capability is behind `{includeWords:true}` (a `NOTE WORDS:` line) and the UI calls it without the flag. Words still persist in `.reelproj`.
- **Fix**: Added a plan addendum under Phase 5 documenting that word-level SRT export is intentionally opt-in/dormant and clean-caption is the default.
- **Decision**: FIXED

### F8 — Diarization failure may log the HF token to stderr

- **Severity**: 🔭 OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Safety & Quality (security)
- **Location**: sidecar/whisperx_engine/whisperx_engine.py (~280, `_diarize` except)
- **Detail**: `_log(str(e))` could echo a token embedded in a pyannote/HF auth error.
- **Fix**: The diarize except handler now scrubs the token substring (`→ ***`) before logging.
- **Decision**: FIXED

## Benign extras (no action)

`EngineStatus.device` field, `language` in the transcribe payload, and a
`delete_model` command — all additive, within the model-manager surface, no
contract break.

## Follow-up

- **Sidecar rebuild required for F2 + F8.** Both touch the Python engine
  (`whisperx_engine.py`): F2 reads `HF_TOKEN` from env, F8 scrubs the token from
  the diarize error log. The frozen binary in `src-tauri/binaries/` is now stale —
  run `sidecar/build.sh` (CPU + GPU + Windows) and re-run `--selftest` before the
  diarization manual gates (6.3–6.6). This is the same contract-bump/rebuild caveat
  the plan already flags for Phase 7.
