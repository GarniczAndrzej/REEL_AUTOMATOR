# Thin Installer + First-Run Hardware-Matched Dependency Download — Plan Brief

> Full plan: `context/changes/thin-installer-runtime-deps/plan.md`

## What & Why

The Windows install bundles every heavy native dependency directly into the package (a 3.3 GB CUDA engine, a 464 MB CPU engine, a 143 MB FFmpeg, plus align models) — a ~4 GB installer. This slice replaces it with a **thin installer** (tens of MB) that, on first run, **detects the machine's hardware** and **downloads only the matching variant** of each heavy dependency, verifies it against a checksum, and stages it where the sidecar contract expects.

## Starting Point

The download/verify/atomic-stage engine (`models.rs`), the GPU/CPU detection (`engine.rs` `nvidia-smi` + fail-safe variant selection), and the model-manager download UI (`transcribe.js`) already exist. This slice generalizes them from "transcription models" to "all heavy deps," adds a declarative spec, a first-run screen, and reworks the spawn path so binaries run from a writable directory instead of beside the read-only install exe.

## Desired End State

A tens-of-MB installer. First launch shows a setup screen that reports detected hardware, lets the user override CPU/GPU and the download location, and downloads each dependency with live progress. The screen is dismissable — import / SRT-paste / export work immediately with no deps; only transcription is gated on readiness. Re-runs, app updates with a bumped version, and machine moves re-resolve and re-download only what's missing or stale.

## Key Decisions Made

| Decision | Choice | Why (1 sentence) | Source |
| --- | --- | --- | --- |
| Spawn path for downloaded bins | `std::process::Command` by absolute path | Sidesteps the read-only install-dir + dynamic shell-scope problem; `nvidia-smi` already uses this pattern | Plan |
| Dependency spec source | Fetch `deps.json` from release host + embedded fallback | Deps can be re-pointed without an app update, yet first run resolves offline | Plan |
| Staging location | Default `app_data_dir`, with a "change location" picker | Works out-of-the-box, but lets users with small system drives relocate the multi-GB set | Plan |
| First-run UX | Setup screen, but gates **only transcription** | Strong guided onboarding while honoring S-18 + local-first (import/export stay usable) | Plan |
| Variant override | Auto-pick (fail-safe CPU) + explicit dropdown | Roadmap-mandated fail-safe + manual override; reuses existing detection | Plan |
| Platform scope | Windows-first, spec designed cross-platform | The CUDA/CPU split only bites on Windows; macOS keeps bundling for now | Plan |
| Interruption / staleness | Per-artifact restart + checksum/version re-fetch | Reuses the proven `.part`/`.bak` swap; no stale sidecar ever served | Plan |

## Scope

**In scope:** declarative `deps.json` spec + resolver; hardware→variant mapping; generalized downloader + staging; spawn-path rework (5 sites → raw `Command`); first-run setup screen (Polish); Windows bundle strip + validation.

**Out of scope:** HTTP-range resume; macOS thin-installer treatment; changes to parser/exporters/selection/frame-math; engine CLI/JSON-schema/`sentences[]` changes; custom artifact-signing beyond HTTPS + SHA-256 pinning; fetching any user content.

## Architecture / Approach

A declarative `deps.json` (per-platform/arch/variant entries with url/checksum/version/stage-slot) drives a Rust resolver + generalized downloader (extracted from `models.rs`). Hardware detection (`engine.rs`) maps the host to a variant key, fail-safe to CPU. Downloaded artifacts stage under a user-chosen deps root; path resolvers (engine/ffmpeg/align-models) read staged → bundle → repo. All five sidecar spawn sites move from `tauri-plugin-shell` `.sidecar()` to a shared raw-`Command` helper that preserves UTF-8/HF-offline env, timeouts, and the cancel handshake. A dismissable first-run screen drives the download commands and gates only transcription.

## Phases at a Glance

| Phase | What it delivers | Key risk |
| --- | --- | --- |
| 1. Spec + resolver | `deps.json` schema, remote+fallback loader, hardware→variant + status (spawn-free) | Spec/host trust; getting the variant mapping right |
| 2. Downloader + staging | Generic download/verify/atomic-stage to a user-chosen deps root | Atomic-swap correctness across single-file vs dir artifacts |
| 3. Spawn-path rework | 5 sites → raw `Command`, staged absolute paths, cancel preserved | Cross-cutting; must keep transcription/cancel/timeout byte-identical |
| 4. First-run UI (Polish) | Setup screen, variant override, location picker, gate only transcription | S-18 launch-path rule; clean Polish UX |
| 5. Bundle strip + validation | Windows config overlay, tens-of-MB installer, GPU+CPU first-run validation | Irreversible; only validatable on real Windows hardware |

**Prerequisites:** S-05 (model manager + staging contract) and S-24 (per-hardware sidecar variants) — both shipped. A release host with stable, versioned, checksum-pinned artifact URLs. Real Windows GPU + CPU machines for Phase 5 validation.

**Estimated effort:** ~5 sessions across 5 phases; Phase 3 (spawn rework) and Phase 5 (hardware validation) are the heaviest.

## Open Risks & Assumptions

- The spawn-path rework must reproduce `tauri-plugin-shell`'s event stream + cancel/timeout semantics over a raw child — the highest-risk change; mitigated by keeping the repo-binaries fallback so it's testable before the bundle strip.
- Requires a release host serving versioned, checksum-pinned artifacts; that infrastructure is assumed available (roadmap blocker).
- A wrong GPU pick (CUDA build on a machine without the driver) must fail safe to CPU — relies on detection + the GPU build's internal `device=cpu` fallback.
- Final validation is only possible on real Windows GPU + CPU hardware.

## Success Criteria (Summary)

- The Windows installer is tens of MB; first run downloads + stages the hardware-matched deps and transcribes successfully on both CUDA and CPU machines.
- Import / SRT-paste / export work with no deps; transcription shows a Polish "pobierz zależności" CTA when deps are missing (offline-safe).
- Every fetched binary/model is checksum-verified before staging; bumped versions trigger targeted re-download; `node --experimental-vm-modules test/regression.js` stays green throughout.
