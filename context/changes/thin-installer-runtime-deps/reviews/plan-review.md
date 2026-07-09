<!-- PLAN-REVIEW-REPORT -->
# Plan Review: Thin Installer + First-Run Hardware-Matched Dependency Download

- **Plan**: context/changes/thin-installer-runtime-deps/plan.md
- **Mode**: Deep
- **Date**: 2026-07-09
- **Verdict**: REVISE
- **Findings**: 0 critical, 3 warnings, 1 observation

## Verdicts

| Dimension | Verdict |
|-----------|---------|
| End-State Alignment | WARNING |
| Lean Execution | PASS |
| Architectural Fitness | PASS |
| Blind Spots | WARNING |
| Plan Completeness | WARNING |

## Grounding

10/10 paths ✓, all symbols ✓ (5 `.shell().sidecar()` spawn sites — engine.rs:197, ffmpeg.rs:10, waveform.rs:113, whisper.rs:562 & :811; env helpers `with_utf8_io`/`with_hf_offline` engine.rs:116,129; cancel handshake `TRANSCRIBE_CHILD`/`TRANSCRIBE_CANCELLED`; download core `download_model`/`verify_sha256`/`.part`/`.bak` all confirmed), brief↔plan ✓, Progress↔Phase consistent ✓ (Phases 0–5 all mapped, every success-criterion numbered N.M), contract-surfaces.md absent (check skipped). Note: `metadata.rs:23` also calls `run_ffmpeg_output` — covered transitively by the Phase 3 rework, no extra change needed.

## Findings

### F1 — "Deps ready" ≠ "can transcribe": models excluded from the gate

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: End-State Alignment
- **Location**: Overview (line 5) vs Phase 1 §1 (F4) vs Phase 4 §2
- **Detail**: The Overview promises first run "downloads ... transcription models," but F4 (Phase 1 §1) removes models from the deps set — they stay in `model-registry.js`, downloaded via the existing dropdown, and `deps_status` covers ONLY engine/ffmpeg/align-models. Phase 4 §2 then gates transcription on `deps_status` alone. Two problems: (1) the existing transcribe gate is already `hasVideo && hasModel` (`src/ui/import/transcribe.js:164-165`); Phase 4 §2's contract ("ready ⇒ normal flow") doesn't say the new deps gate COMPOSES with that model check — read literally, an implementer could un-gate transcription on deps-ready while a moved-machine install has an empty `whisper-models/`, producing a transcribe that fails with the engine's own "Model ... nie został pobrany" (`whisper.rs:183`). (2) The first-run screen provisions engine/ffmpeg/align but NOT a model, so it isn't the one-and-done onboarding the Overview implies.
- **Fix A ⭐ Recommended**: Keep models separate, but reconcile the promise + gate — state Phase 4 §2's gate is `deps_ready && hasModel` (compose with transcribe.js:165, don't replace it), split the CTA copy ("pobierz zależności" vs "pobierz model"), and fix the Overview to stop claiming first-run downloads models.
  - Strength: Preserves F4's clean source-of-truth split; smallest change; existing gate + error path already in code.
  - Tradeoff: First run still isn't fully one-click; user makes two trips.
  - Confidence: HIGH — the existing gate and error path are already in code.
  - Blind spot: None significant.
- **Fix B**: Fold a default model into the first-run flow.
  - Strength: Truly one-and-done onboarding matching the Overview's promise.
  - Tradeoff: Reintroduces models into the first-run/gate surface F4 worked to keep out; needs a "default model" policy.
  - Confidence: MED — model choice is user-facing; a forced default may be wrong.
  - Blind spot: Which model is the sane default per hardware isn't specified.
- **Decision**: PENDING

### F2 — env helpers can't be applied to a raw std::process::Command

- **Severity**: ⚠️ WARNING
- **Impact**: 🔎 MEDIUM — real tradeoff; pause to reason through it
- **Dimension**: Plan Completeness
- **Location**: Phase 3 §2 + Critical Implementation Details (line 65)
- **Detail**: The plan says the raw-Command rework will "preserve ... the PYTHONUTF8/PYTHONIOENCODING env (with_utf8_io)" and apply `with_utf8_io`/`with_hf_offline` "to the raw Command." But both helpers are typed on the tauri-plugin-shell Command: `with_hf_offline(cmd: Command) -> Command` and `with_utf8_io(cmd: Command) -> Command` (engine.rs:116,129), where `Command` is `tauri_plugin_shell::process::Command`, not `std::process::Command`. They cannot be reused as-is; passing a std/tokio Command won't type-check. The UTF-8 env is the fix for the Polish-diacritics bug (S-24) — silently dropping it regresses it.
- **Fix**: Extract the env key/value pairs into plain constants (or a helper taking `&mut std::process::Command`) and apply them at the new spawn helper; port `with_utf8_io`/`with_hf_offline` to the raw Command type. Name this explicitly in Phase 3 §2 so it isn't discovered mid-build. Keep manual check 3.8 (diacritics survive) as the guard.
  - Strength: Removes a compile-time surprise from the load-bearing phase.
  - Tradeoff: Two small helpers exist in two Command flavors during the fallback window (both shell-Command callers and the new raw-Command path coexist until Phase 5).
  - Confidence: HIGH — helper signatures verified in engine.rs.
  - Blind spot: None significant.
- **Decision**: PENDING

### F3 — Downloaded unsigned engine.exe: SmartScreen / AV quarantine risk

- **Severity**: ⚠️ WARNING
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: What We're NOT Doing (line 48) + Phase 5
- **Detail**: Today the engine exe ships inside a code-signed installer and inherits its trust. A thin installer instead downloads a multi-hundred-MB / multi-GB unsigned .exe to app-data and spawns it by absolute path. On Windows that attracts SmartScreen / Defender / third-party AV — mark-of-the-web, on-access scan, or quarantine of a freshly written large unsigned executable can delete or block the binary between staging and spawn. The plan correctly scopes custom signing OUT, but never names this as a risk or a validation step, so Phase 5 could pass on a relaxed dev machine and fail in the field.
- **Fix**: Add a Phase 5 manual-verification row — "a freshly downloaded engine.exe spawns without AV/SmartScreen quarantine on a stock Windows Defender machine" — and a one-line risk note that unsigned downloaded binaries lose the installer's signing trust. Consider signing downloaded artifacts later (out of scope now, but flag).
- **Decision**: PENDING

### F4 — 3.3 GB GPU artifact + no range-resume = restart-from-zero

- **Severity**: 🔍 OBSERVATION
- **Impact**: 🏃 LOW — quick decision; fix is obvious and narrowly scoped
- **Dimension**: Blind Spots
- **Location**: What We're NOT Doing (line 45) + Phase 2
- **Detail**: Range-resume is deferred (reasonable), but the GPU engine is 3.3 GB. An interruption at 90% on a residential connection throws away ~3 GB and restarts from zero. Acceptable for a model, painful at this size. The `.part` restart is correct; the UX cost just scales with the artifact.
- **Fix**: Note the restart cost in Migration/Risks and keep an explicit "retry" affordance in the Phase 4 UI (not an auto-silent restart) so the user understands a large re-download is starting.
- **Decision**: PENDING
