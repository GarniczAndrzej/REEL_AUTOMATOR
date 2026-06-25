<!-- IMPL-REVIEW-REPORT -->
# Implementation Review: Local (offline) Cohere Transcription

- **Plan**: context/changes/local-cohere-transcription/plan.md
- **Scope**: Phases 1–4 implemented (Phase 0 spike-only; Phases 3–5 manual checks pending)
- **Date**: 2026-06-25
- **Verdict**: NEEDS ATTENTION
- **Findings**: 0 critical, 3 warnings, 2 observations

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| Plan Adherence | PASS |
| Scope Discipline | WARNING |
| Safety & Quality | WARNING |
| Architecture | PASS |
| Pattern Consistency | PASS |
| Success Criteria | WARNING |

Automated re-run: regression 258/258 PASS · `cargo check` PASS · prettier (changed files) PASS · prettier repo-wide PASS (after F5 fix).

## Findings

### F1 — Phase 5 quality premise still unmeasured

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Success Criteria
- **Location**: context/changes/local-cohere-transcription/quality-comparison.md
- **Detail**: The change's sole justification (Polish quality) is unmeasured — Measurements section is all placeholders, no WER, no default decision. Code path shipped; deciding measurement not done. Correctly tracked (5.3/5.4 unchecked, status: implementing).
- **Fix**: Run the side-by-side on ≥1 real Polish clip, fill WER + qualitative cells, tick one decision box before archiving.
- **Decision**: SKIPPED — pending manual work, correctly tracked.

### F2 — Cohere panel exposes more than the plan's "hide the rest"

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Scope Discipline
- **Location**: src/index.html:~607–706, whisperx_engine.py:531–537
- **Detail**: Plan Phase 4 specified Cohere panel = device + punctuation only; impl also shows beam size + word-SRT. Justified in-code (beam wired to Cohere num_beams; word-SRT works on aligned words) but contradicts an explicit plan line with no addendum.
- **Fix**: Add a one-line addendum to plan.md Phase 4 recording the intentional deviation.
- **Decision**: FIXED — addendum appended to plan.md Phase 4.

### F3 — Cohere model-load errors all report "model not found"

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Safety & Quality (Reliability)
- **Location**: sidecar/whisperx_engine/whisperx_engine.py:506–512
- **Detail**: Generic load-failure fallthrough mapped to EXIT_MODEL_NOT_FOUND, so an OOM / corrupt-but-sha256-valid / dtype failure on a downloaded model told the user "Pobierz model" — a re-download that won't help.
- **Fix**: Keep the 'not found' substring → EXIT_MODEL_NOT_FOUND; send the generic fallthrough to EXIT_TRANSCRIBE_FAIL.
- **Decision**: FIXED — fallthrough now exits EXIT_TRANSCRIBE_FAIL. Requires a sidecar rebuild (`sidecar/build.sh`) to take effect.

### F4 — Relies on a private transformers processor method

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Pattern Consistency / Reliability
- **Location**: sidecar/whisperx_engine/whisperx_engine.py:542
- **Detail**: `proc._reassemble_chunk_texts(...)` is a private API. Mitigated by the transformers==5.12.1 pin + a public `chunk_index is None` fallback; failure degrades to EXIT_TRANSCRIBE_FAIL (no silent corruption).
- **Fix**: Add a comment tying the call to the version pin — re-verify on any bump.
- **Decision**: FIXED — pin-dependency comment added at the call site.

### F5 — Repo-wide prettier criterion is red on an unrelated file

- **Severity**: OBSERVATION
- **Impact**: 🏃 LOW
- **Dimension**: Success Criteria
- **Location**: src/ai/openrouter-picker.js
- **Detail**: Phase 4 criterion 4.1 (`prettier --check "src/**"`) failed on src/ai/openrouter-picker.js, owned by a different change (cost-optimized-ai-analysis, 99abd05). All files this change touched are clean.
- **Fix**: `npx prettier --write src/ai/openrouter-picker.js`.
- **Decision**: FIXED — file formatted; repo-wide prettier now green.
