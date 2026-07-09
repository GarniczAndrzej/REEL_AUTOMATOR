# Thin Installer + First-Run Hardware-Matched Dependency Download — Implementation Plan

## Overview

Today the Windows install bundles every heavy native dependency directly into the Tauri package via `externalBin` + `bundle.resources`: a 3.3 GB CUDA WhisperX engine, a 464 MB CPU engine, a 143 MB FFmpeg, plus the `align_models/` directory — a ~4 GB installer. This plan replaces that with a **thin installer** (the Tauri shell + frontend + Rust binary only, tens of MB) that, on **first run**, detects the machine's hardware, downloads the **matching variant** of each heavy dependency (CUDA engine on a supported NVIDIA GPU, CPU build otherwise; the right FFmpeg; align models; transcription models), **checksum/version-verifies** each artifact, **stages** it where the existing sidecar contract expects, and **spawns** it by absolute path from a writable location.

The download/verify/atomic-stage engine, the GPU/CPU detection, and the progress UI already exist in the codebase (`models.rs`, `engine.rs`, `transcribe.js`). This slice **generalizes** them from "transcription models" to "all heavy deps" and adds a declarative spec, a first-run provisioning screen, and a spawn-path rework so binaries no longer need to live beside the read-only install exe.

## Current State Analysis

- **Bundling** (`src-tauri/tauri.conf.json`): `externalBin: ["binaries/ffmpeg", "binaries/whisperx-engine", "binaries/whisperx-engine-gpu"]`, `resources: ["binaries/align_models"]`. All four are bundled into the installer. The actual on-disk Windows artifacts confirm the size problem (3.3 GB GPU exe).
- **Spawn path**: every sidecar is launched through `tauri-plugin-shell` via `app.shell().sidecar(name)`, which resolves a binary **beside the main executable** (the install dir — read-only on Windows without elevation). Five call sites:
  - `engine.rs::run_engine` (selftest/capability probes)
  - `whisper.rs` ~line 560 (`transcribe_video`)
  - `whisper.rs` ~line 796 (`align_transcript`)
  - `ffmpeg.rs::run_ffmpeg_output` (audio extraction)
  - `waveform.rs` (PCM decode — its **own** `app.shell().sidecar("ffmpeg")` at `waveform.rs:113`, **not** a `run_ffmpeg_output` caller; ffmpeg writes raw f32le PCM to a temp file and the code only waits for `CommandEvent::Terminated`, never pumping stdout — a distinct spawn pattern)
- **GPU/CPU detection already exists** (`engine.rs`): `nvidia_gpu_present()` shells `nvidia-smi -L` (spawn-free, ~instant); `gpu_sidecar_present()` stats the GPU binary; `engine_sidecar()` memoizes the variant choice with a `REEL_ENGINE_VARIANT=cpu|gpu` env override and **fails safe to CPU**. `host_triple()` returns the Tauri arch suffix. This is the core of the "hardware → variant" mechanism the roadmap flagged as the one blocker — it is largely already solved.
- **Download/verify/stage already exists** (`models.rs::download_model`): streams every file of a model from HuggingFace into `whisper-models/<id>.part/`, emits throttled `model-download-progress` (%/speed/ETA), SHA-256-verifies the LFS weights (`verify_sha256` — deletes on mismatch), then performs an atomic `.part` → final, `.bak` → restore-on-failure swap. `is_safe_filename` guards path traversal. This is the artifact-download engine to generalize.
- **Staging contract** (`engine.rs`): `align_model_dir()` resolves the wav2vec2 model from (1) the bundled resource dir, then (2) repo `src-tauri/binaries/align_models`. `engine_sidecar()` returns a **base name** that the shell plugin suffixes. Both must learn a third, higher-priority location: the downloaded/staged deps root.
- **Frontend model manager** (`src/ui/import/transcribe.js`, 1011 lines): renders a model dropdown + ⬇ Pobierz button, listens to `model-download-progress`, paints the engine-readiness badge from `whisperx_engine_cached` (a pure cache read that **never spawns** — S-18 launch-path rule). `src/transcription/model-registry.js` is the curated per-file spec (id/repo/files/sha256/sizeBytes/sentinel) — the pattern `deps.json` mirrors.
- **Capabilities** (`src-tauri/capabilities/default.json`): `shell:default` + `shell:allow-execute`. The shell scope is geared to bundled sidecars; spawning arbitrary downloaded paths through the plugin would need a broad dynamic scope glob — which the chosen spawn approach avoids by using `std::process::Command` directly.
- **Cancellation** (`whisper.rs`): `TRANSCRIBE_CHILD: Mutex<Option<CommandChild>>`, `TRANSCRIBE_CANCELLED: AtomicBool`, `drive_engine(app, rx, child)` consumes a `tauri::async_runtime::Receiver<CommandEvent>` + `CommandChild`, and `cancel_transcription` flips the flag + kills the child. The spawn-path rework must preserve all of this with raw `std::process::Child`.
- **Regression suite** (`test/regression.js`): fences parser + exporters only. Platform-agnostic; stays green by construction. It is the guard that this slice leaked nothing into logic.

## Desired End State

A user downloads a **tens-of-MB** Windows installer. On first launch the app shows a **first-run setup screen** that: reports detected hardware and the auto-picked variant (with a manual CPU/GPU override), offers a deps-location directory (defaulting to the writable app-data dir, with a "change location" option), and downloads each required dependency with live per-artifact %/speed/ETA, checksum/version-verifying and staging each. The setup screen is **dismissable** — import, SRT-paste, and export work immediately with no deps; only **transcription** is gated on "deps ready." A re-run, an app update with a bumped dependency version, or a moved-to-another-machine install re-resolves against the spec and re-downloads only what is missing or stale. macOS continues to bundle (Windows-first); the spec is authored cross-platform so macOS can adopt later without a schema change.

**Verification of end state**: a fresh Windows install produces a tens-of-MB installer; first launch on a CUDA machine downloads + stages the GPU engine and transcribes; first launch on a CPU-only machine downloads + stages the CPU engine and transcribes; offline first launch leaves import/SRT/export usable and shows a Polish "pobierz zależności" CTA on transcription; `node --experimental-vm-modules test/regression.js` stays green throughout.

### Key Discoveries:

- `models.rs::download_model` (`src-tauri/src/models.rs:167`) is a near-complete generic artifact downloader — streaming + `verify_sha256` (`:142`) + atomic `.part`/`.bak` swap (`:299`). Generalize, don't rewrite.
- `engine.rs::nvidia_gpu_present()` (`src-tauri/src/engine.rs:65`) + `engine_sidecar()` (`:84`) already implement fail-safe GPU/CPU detection with an env override — the roadmap's "big unknown" is mostly pre-solved here.
- `engine.rs::align_model_dir()` (`:144`) and `engine_sidecar()` are the two resolution chokepoints that must learn the staged-deps location.
- Five spawn sites use `app.shell().sidecar()`; the rework centralizes them on a single raw-`Command` helper that resolves an absolute staged path.
- `whisperx_engine_cached` (`engine.rs:339`) is the launch-path readiness read that **must never spawn** — the deps-readiness check must follow the same pure-read rule (honor `[[whisperx-cold-spawn-cost]]`).
- `tauri.conf.json` `externalBin` is **not per-platform** in a single file — stripping it for Windows while keeping macOS bundled requires a platform config override (`tauri.windows.conf.json` merged by Tauri) or a build-time switch.

## What We're NOT Doing

- **Not** touching parser, exporters, selection, or frame-math (platform-agnostic; regression suite fences them).
- **Not** changing the transcription/align engine's CLI contract, the JSON result schema, or `sentences[]` shape — byte-identical output.
- **Not** implementing HTTP-range resume — an interrupted artifact **restarts** (reuses the proven `.part` cleanup). Range resume is explicitly deferred.
- **Not** shipping the thin-installer treatment on macOS in this slice — macOS keeps bundling; the spec is merely designed to accommodate it later.
- **Not** fetching any user content — only binary + model artifacts are downloaded (local-first promise preserved).
- **Not** building a custom code-signing / artifact-signature scheme beyond HTTPS + per-artifact SHA-256 pinning from the spec (the spec's own integrity is addressed via the embedded-fallback + host trust note).
- **Not** removing the `REEL_ENGINE_VARIANT` env override — it stays as the power-user/debug escape alongside the new UI override.

## Implementation Approach

Generalize the existing model-download machinery into a **dependency-resolver + downloader** driven by a declarative `deps.json` spec, then rework the spawn path so staged binaries run from a writable directory by absolute path. Order phases so each is independently verifiable and the irreversible bundler strip lands **last**:

1. Spec + resolver (read-only, unit-testable) →
2. Generalized downloader + staging (writes to disk, no spawn change yet) →
3. Spawn-path rework (still resolves repo `binaries/` as fallback, so the app keeps working with bundled bins) →
4. First-run UI (drives phases 1–2 commands) →
5. Strip the bundle (only safe once 1–4 prove download+stage+spawn works end-to-end).

Throughout, **reuse** `verify_sha256`, the `.part`/`.bak` atomic swap, the progress-event pattern, `nvidia_gpu_present()`, and `host_triple()`. Keep every new user-facing string Polish.

## Critical Implementation Details

- **Spawn-path rework is the load-bearing risk.** `tauri-plugin-shell`'s `CommandEvent` stream + `CommandChild::kill` back `drive_engine` and `cancel_transcription`. Replacing `.sidecar()` with `std::process::Command` means re-implementing the stdout/stderr line pump + explicit timeout-kill over a raw `std::process::Child` (or `tokio::process::Child`), preserving: the `PYTHONUTF8`/`PYTHONIOENCODING` UTF-8 env (`with_utf8_io`), the `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE` env (`with_hf_offline`, omitted when diarizing), the `TRANSCRIBE_CHILD`/`TRANSCRIBE_CANCELLED` cancel handshake, and the explicit-kill-on-timeout for the sites that *have* a timeout (no orphaned sidecars). The timeout is **per-call-site** (F4): probes stay bounded (60s/300s), but the transcription/align driver stays cancel-only/unbounded exactly as today — do not impose a universal bound. Do this once in a shared helper and route all five call sites through it.
- **Readiness must stay off the launch path (S-18).** The deps-readiness check the first-run screen and the transcription gate consult must be a spawn-free **presence + checksum/version** read (mirror `whisperx_engine_cached`), never a sidecar spawn at launch.
- **Variant must fail safe to CPU.** A CUDA engine on a machine without the matching driver/cuDNN won't load. Detection ambiguity, `nvidia-smi` absence, or any error resolves to the CPU variant; the UI override can force either. The GPU build is a safe superset (auto-falls back to `device=cpu` internally) but must not be *downloaded* unless GPU is selected.
- **Supply-chain integrity — the embedded spec is the checksum trust anchor.** Every downloaded binary/model MUST pass SHA-256 **before** it is staged or ever spawned — a thin installer that fetches executables is a code-execution surface. The SHA-256 used to verify a *known* artifact MUST come from the **embedded** `deps-spec.json` (which ships inside the code-signed installer), never from the remote spec. The remote spec is trusted only to (a) re-point an artifact's `url` and (b) add genuinely *new* dependency ids; for any `id` already present in the embedded copy, the embedded `sha256`/`version` wins. This closes the hole where a compromised host serves a malicious binary together with a matching malicious hash — verifying against a host-supplied hash proves nothing. First-seen (host-only) deps remain a residual trust on the host for their initial hash; flag any such entry. The embedded `deps-spec.json` is also the offline/host-down fallback.
- **Bundler strip is platform-scoped.** Removing `externalBin`/`resources` entries for Windows while macOS keeps bundling requires a `tauri.windows.conf.json` overlay (Tauri merges `tauri.<platform>.conf.json` over `tauri.conf.json`); do not blanket-remove from the base config or the macOS build breaks.

---

## Phase 0: Release-host artifacts + pinned checksums (prerequisite)

### Overview

Stand up the release host that serves the heavy artifacts at stable, versioned URLs, compute each artifact's SHA-256, and pin `url`/`sha256`/`version`/`sizeBytes` into the **embedded** `deps-spec.json`. This is the trust anchor (F1) and the precondition for every download path — without it Phases 2/4/5 cannot be validated. Mostly infra + authoring work, but it is in-scope and gating, not an external assumption.

### Changes Required:

#### 1. Upload artifacts to the versioned release host

**Where**: release host (e.g. GitHub Releases / object storage on the pinned host)

**Intent**: Publish the GPU engine, CPU engine, FFmpeg, and the `align_models/` set at immutable, versioned URLs that won't move under a tag.

**Contract**: Each artifact has a stable URL containing its version; re-publishing a new build means a new version segment (never overwriting an existing URL). Record the exact bytes uploaded so the pinned hash matches what clients fetch.

#### 2. Compute + pin checksums into the embedded spec

**File**: `src/deps/deps-spec.json` (the embedded copy authored in Phase 1 §1)

**Intent**: For every artifact, compute SHA-256 + byte size and write them, with the version and URL, into the embedded spec so verification (F1) has a real anchor.

**Contract**: Every dependency entry in the embedded `deps-spec.json` carries a real `url`, `sha256`, `sizeBytes`, and `version` matching the uploaded bytes. A documented one-liner (e.g. `sha256sum`/`Get-FileHash`) records how each hash was produced for re-pin on version bumps.

### Success Criteria:

#### Automated Verification:

- Each pinned URL is reachable and returns the expected `sizeBytes` (a small fetch-HEAD/size check script)
- Re-computing SHA-256 of each downloaded artifact matches the embedded spec value

#### Manual Verification:

- Downloading each artifact from its pinned URL and hashing it reproduces the embedded `sha256`
- Bumping one artifact to a new version produces a new URL (old URL still serves the old bytes)

**Implementation Note**: This phase gates Phases 2, 4, and 5 — their download/validation steps cannot pass until the host + pinned checksums exist. Complete it (or stub with a local file:// host for dev) before relying on real downloads.

---

## Phase 1: Declarative dependency spec + hardware resolver

### Overview

Define the `deps.json` schema and a Rust resolver that loads it (remote host → embedded fallback), detects hardware, maps it to a variant key, computes the required dependency set for the host, and reports each dependency's status (present / missing / stale) — all spawn-free.

### Changes Required:

#### 1. Dependency spec file + schema

**File**: `src/deps/deps-spec.json` (embedded fallback, bundled), documented schema in `src/deps/deps-spec.js`

**Intent**: Author the canonical declarative spec listing every heavy dependency per platform/arch/variant, with the integrity + staging metadata needed to download and place it. Ship a checksum-pinned copy in-app as the offline/host-down fallback.

**Source-of-truth boundary (F4):** `deps-spec.json` covers ONLY the new heavy hardware-variant deps — `engine`, `ffmpeg`, `align-models`. **Transcription models stay authored in `src/transcription/model-registry.js`** and the model dropdown keeps reading that registry; deps-spec does NOT enumerate models, and there is no `model` kind. (The download *core* is still shared — see Phase 2 §2 — but the two specs are never both a source of truth for the same artifact.)

**Contract**: A versioned JSON document: top-level `{ specVersion, dependencies: [...] }`. Each dependency entry carries: `id`, `kind` (`engine` | `ffmpeg` | `align-models`), `platform` (`windows`|`macos`), `arch`, `variantPredicate` (`gpu`|`cpu`|`any`), `url` (single file) **or** `repo`+`files[]` (multi-file dir, reusing the model-registry `{name,sizeBytes,sha256}` shape), `sizeBytes`, `sha256` (single-file case), `version`, `sentinel` (presence marker), and `stageTo` (a logical staging slot: `engine-bin` | `ffmpeg-bin` | `align-models`). Mirror the existing `model-registry.js` JSDoc typedef style. **Every sha256 in deps-spec is mandatory and non-empty (F2):** unlike the transcription-models registry (where small git-blob files carry `sha256: ''` and `verify_sha256` skips them), deps-spec covers executables and torch-loaded align files — a code-execution surface. Every single-file `sha256` and every `files[].sha256` under an `engine`/`ffmpeg`/`align-models` entry MUST be a non-empty pinned digest; the schema doc states this as a hard constraint.

#### 2. Spec loader (remote → embedded fallback)

**File**: `src-tauri/src/deps.rs` (new module), registered in `lib.rs`

**Intent**: Load the active spec by fetching the versioned `deps.json` from the release host, falling back to the embedded copy on any network/parse error, so first run resolves even offline.

**Contract**: New command `load_deps_spec() -> Result<DepsSpec, String>`. Fetches over HTTPS (reuse the `reqwest` client pattern from `models.rs`); on failure reads the embedded `deps-spec.json` (compiled in via `include_str!` or read from a bundled resource). Returns the parsed spec. **Merge rule (trust anchor):** the embedded spec is authoritative for integrity — for any dependency `id` present in the embedded copy, its `sha256`/`version` override whatever the remote spec carries; the remote spec may only re-point that id's `url` or introduce new ids. A new (host-only) id's hash is trusted-on-first-use and surfaced as such. This means a tampered host can re-point a URL but cannot swap a *known* binary for a malicious one with a self-consistent hash (see Critical Implementation Details → Supply-chain integrity).

#### 3. Hardware detection → variant resolver

**File**: `src-tauri/src/deps.rs`; refactor shared detection out of `src-tauri/src/engine.rs`

**Intent**: Reuse the existing `nvidia_gpu_present()` + `host_triple()` to map the host to a `(platform, arch, variant)` key, fail-safe to CPU, honoring the `REEL_ENGINE_VARIANT` env override and (Phase 4) a persisted UI override.

**Contract**: `pub fn detect_variant() -> &'static str` (`"gpu"`|`"cpu"`) and `pub fn host_platform_arch() -> (&'static str, &'static str)`. Lift `nvidia_gpu_present` and `host_triple` from `engine.rs` into `deps.rs` (or a shared `platform.rs`) and have `engine.rs::engine_sidecar()` call the shared resolver so the two never disagree. Detection precedence: env override → UI override (read from `app_config_dir().join("deps-settings.json")` → `variantOverride`; the file is authored in Phase 2 §1 / written by Phase 4, and `detect_variant()` simply tolerates its absence in Phase 1) → `nvidia-smi` present ⇒ gpu → cpu.

#### 4. Required-set + status reporting

**File**: `src-tauri/src/deps.rs`

**Intent**: Filter the spec to the dependencies the host actually needs (matching platform/arch + resolved variant + `any`), and report each one's on-disk status without spawning anything.

**Contract**: New command `deps_status() -> Result<Vec<DepStatus>, String>` returning per-dependency `{ id, kind, required, present, stale, sizeBytes, stagedPath? }`. `present` = sentinel exists at the staged location (Phase 2 path resolver); `stale` = present but the **recorded installed `version`** (read from the `deps-installed.json` manifest written on stage — Phase 2 §2) differs from the embedded-authoritative spec `version`. Comparison is a cheap manifest read — **never re-hash the multi-GB staged artifact on a status read** (that would break the fast/spawn-free launch rule); the pinned SHA-256 is the download-time gate, the recorded `version` is the staleness gate. Pure filesystem reads — never spawns a sidecar (S-18). Unit-test the variant filtering and the host-match logic.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Unit tests for variant filtering + host-match pass: `~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml deps`
- Embedded `deps-spec.json` parses into `DepsSpec` (covered by a unit test that deserializes the bundled copy)
- Regression suite green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- `deps_status` on a CUDA machine reports the `gpu` engine as required; on a CPU-only machine reports the `cpu` engine as required
- With `REEL_ENGINE_VARIANT=cpu` set, `deps_status` reports the CPU engine even on a GPU machine
- Loader returns the embedded spec when the release host is unreachable (simulate by blocking the host)

**Implementation Note**: After this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 2: Generalized downloader + staging

### Overview

Generalize `models.rs`'s download/verify/atomic-swap so it can fetch single-file artifacts (engine exe, ffmpeg) and multi-file directories (align_models, models) into a persisted, user-overridable deps root, staging each to the slot the resolver expects, with checksum/version gating and restart-on-interruption.

### Changes Required:

#### 1. Persisted deps-root setting + writability check

**File**: `src-tauri/src/deps.rs`

**Intent**: Resolve the staging root from a persisted setting, defaulting to the writable `app_data_dir`, with validation that the chosen directory is writable and has enough free space for the required set.

**Contract**: `deps_root() -> Result<PathBuf, String>` (reads persisted override or defaults to `app_data_dir().join("deps")`); commands `get_deps_root()`, `set_deps_root(path)` (validates writability + free space ≥ required-set size, persists), and `deps_root_space() -> { freeBytes, requiredBytes }`. **Persistence store:** a new backend-readable per-machine settings file at `app_config_dir().join("deps-settings.json")` (NOT `.reelproj`, NOT localStorage — `detect_variant()` in Phase 1 must read it from Rust). It holds at least `{ depsRoot?, variantOverride? }`; `set_deps_root` writes `depsRoot`, and the Phase 4 variant override writes `variantOverride`. Reads tolerate a missing/corrupt file (fall back to defaults).

#### 2. Generalized artifact downloader

**File**: `src-tauri/src/deps.rs` (extract shared core from `src-tauri/src/models.rs`)

**Intent**: Lift the streaming + SHA-256 + atomic `.part`/`.bak` swap core out of `download_model` into a reusable function that downloads either one file or a file-set into a staging slot, emitting per-artifact progress.

**Contract**: New command `download_dependency(dep_id) -> Result<String, String>` resolving the dep from the spec and staging it to its slot under `deps_root()`. Emits `dep-download-progress` (same `{id, percent, bytesPerSec, etaSec, downloaded, total}` shape as `model-download-progress`). Reuse `verify_sha256`, `is_safe_filename`, and the `.part`→final / `.bak`→restore swap verbatim. **Record the installed version (F1):** on a successful atomic swap, write/update a per-machine installed-manifest at `deps_root()/deps-installed.json` recording `{ <dep_id>: { version, sha256 } }` from the embedded-authoritative spec — this is the record `deps_status` (Phase 1 §4) compares against the spec `version` to compute `stale`, so a version bump re-downloads without ever re-hashing the staged artifact. Reads tolerate a missing/corrupt manifest (treat as no recorded version ⇒ absent, so a first stage populates it). **Models are NOT a deps-spec dependency (F4):** `models.rs::download_model` keeps its own registry-driven entry point (reading `model-registry.js`); it may share the extracted streaming/verify/swap *core* with `download_dependency`, but `download_dependency` only handles `engine`/`ffmpeg`/`align-models`. Interrupted download → `.part` cleanup → restart on retry (no range resume). **Fail closed on empty hash (F2):** because `verify_sha256` treats an empty expected digest as "skip," `download_dependency` MUST reject (before staging) any deps-spec file whose `sha256` is empty for these kinds — an unverified executable or torch-loaded align file is never staged or spawned. (This differs from `download_model`, which tolerates empty hashes for the models registry's small git-blob files.)

#### 3. Staging-slot path resolver

**File**: `src-tauri/src/deps.rs`

**Intent**: Map each `stageTo` slot to a concrete path under `deps_root()` so both the downloader (write) and the spawn resolver (read, Phase 3) agree on locations, preserving the `align_models/`-beside-the-binary contract.

**Contract**: `staged_path(slot, variant) -> PathBuf` — e.g. `engine-bin` → `deps_root()/engine/<variant>/whisperx-engine[-gpu]-<triple>.exe`, `ffmpeg-bin` → `deps_root()/ffmpeg/ffmpeg-<triple>.exe`, `align-models` → `deps_root()/engine/<variant>/align_models/`. `deps_status` (Phase 1) consults this resolver. (Models keep their existing `whisper-models/<id>/` layout via `download_model` — unchanged and outside this resolver, per F4.)

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Existing `models.rs` checksum test still passes: `~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml models`
- New downloader unit test (checksum mismatch deletes partial, atomic swap leaves no `.part`) passes
- Regression suite green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- Downloading the CPU engine stages a runnable exe at the resolved `engine-bin` path with `align_models/` beside it
- A deliberately corrupted artifact (wrong sha256) is rejected and removed; no partial is left staged
- Changing the deps root to a second drive re-resolves and downloads there; writability/space validation rejects a read-only or too-small target
- `dep-download-progress` reports plausible %/speed/ETA in the UI console

**Implementation Note**: After this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 3: Spawn-path rework — staged absolute paths via raw Command

### Overview

Replace `app.shell().sidecar(name)` at all five call sites with resolution of a staged absolute path and a raw `std::process::Command` spawn, porting the stdout/stderr pump + timeout/cancel from `tauri-plugin-shell` while preserving UTF-8/HF-offline env and the cancellation handshake. Resolution falls back to repo `binaries/` so the app keeps working with bundled bins until Phase 5.

### Changes Required:

#### 1. Absolute-path resolvers for engine, ffmpeg, align models

**File**: `src-tauri/src/engine.rs`, `src-tauri/src/deps.rs`

**Intent**: Make engine, ffmpeg, and align-model resolution return an absolute path resolved from the staged deps root first, then the bundle resource dir, then the repo `binaries/` dir (dev/back-compat).

**Contract**: `engine.rs::engine_sidecar()` keeps its variant-selection role but a new `engine_bin_path(app) -> Result<PathBuf,String>` returns the absolute staged exe; `align_model_dir()` gains a deps-root branch ahead of its existing two; a `ffmpeg_bin_path(app)` resolves the staged ffmpeg. Three-way precedence: `deps_root` staged → bundle resource → repo `binaries/`.

#### 2. Shared raw-Command spawn/pump/cancel helper

**File**: `src-tauri/src/whisper.rs` (rework `drive_engine`), new shared helper (e.g. `src-tauri/src/proc.rs`)

**Intent**: Spawn a resolved absolute path with `std::process::Command`/`tokio::process::Command`, pump stdout+stderr, enforce a bounded timeout with explicit kill, and preserve the existing cancel handshake — replacing the `CommandEvent`/`CommandChild` machinery.

**Contract**: A helper returning `(stdout, stderr, exit_code)` with the same semantics `run_engine`/`drive_engine` expose today. **Timeout is per-call-site, not universal (F4):** the helper takes an `Option<Duration>` — the probe path (`run_engine`) passes the existing bounds (`CAPABILITY_TIMEOUT` 60s / `SELFTEST_TIMEOUT` 300s), but the transcription/align driver (`drive_engine`) passes `None` and stays **cancel-only/unbounded** exactly as today (a real transcription legitimately runs many minutes; a fixed bound would kill it). Waveform passes its own bound. A universal bounded timeout must NOT be applied to `drive_engine`. `TRANSCRIBE_CHILD` changes from `Mutex<Option<CommandChild>>` to hold the raw child handle; `cancel_transcription` kills it. Env application (`with_utf8_io`, `with_hf_offline`, `HF_TOKEN` when diarizing) is applied to the raw `Command`. Timeout path kills the child explicitly (no orphan). All five sites — `engine.rs::run_engine`, `whisper.rs` transcribe (~:560), `whisper.rs` align (~:796), `ffmpeg.rs::run_ffmpeg_output`, and `waveform.rs` (`:113`, its **own** sidecar spawn — independent of `run_ffmpeg_output`) — route through the shared helper. **Note (F5):** `waveform.rs` does not consume stdout — ffmpeg writes raw PCM to a temp file and the caller only awaits termination. The helper must therefore support a "no-stdout / file-output" spawn (spawn + timeout + wait, stdout ignored), not just the engine's stdout-JSON pattern; if a single signature can't cleanly serve both, keep waveform's spawn as a thin variant over the same spawn/timeout/kill primitive rather than forcing the JSON-tuned shape.

#### 3. Capability cleanup

**File**: `src-tauri/capabilities/default.json`

**Intent**: Since downloaded binaries are spawned via `std::process::Command` (not the shell plugin), drop the now-unneeded broad `shell:allow-execute` if no remaining caller uses the shell plugin for these spawns; keep whatever the dialog/fs/path plugins still require.

**Contract**: Remove `shell:allow-execute` only if grep confirms no surviving `app.shell()` spawn depends on it; otherwise leave it. Document the reason inline.

### Success Criteria:

#### Automated Verification:

- Rust type-check + build pass: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- No surviving `.shell().sidecar(` references for engine/ffmpeg: `grep -rn "shell().sidecar" src-tauri/src` returns nothing for those bins
- Regression suite green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- Transcription still runs end-to-end (engine spawned by absolute path from repo `binaries/` fallback) and produces byte-identical `sentences[]`
- Cancelling an in-flight transcription kills the child (no orphaned process in Task Manager)
- A wedged/slow engine hits the timeout and is killed explicitly (amber "nie można sprawdzić" state, no hang)
- FFmpeg audio extraction + waveform decode still work
- Polish diacritics survive in the result JSON (UTF-8 env preserved)

**Implementation Note**: After this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 4: First-run setup screen + provisioning UI (Polish)

### Overview

Add a first-run setup view that reports detected hardware + the auto-picked variant (with a manual override), offers the deps-location picker (default app-data, "change location"), and downloads each required dependency with live progress — dismissable, gating only transcription, honoring the launch-path readiness rule.

### Changes Required:

#### 1. First-run setup view

**File**: `src/ui/` (new module, e.g. `src/ui/first-run-deps.js`), wired into `src/ui/surface.js`

**Intent**: Present a prominent (default-landing, dismissable) setup surface listing required dependencies with per-artifact %/speed/ETA, a variant override dropdown, and a deps-location control; reuse the model-manager progress patterns from `transcribe.js`.

**Contract**: Subscribes to `dep-download-progress` (the exact event name emitted by Phase 2 §2 — singular, mirroring `model-download-progress`); calls `deps_status`, `load_deps_spec`, `download_dependency`, `get/set_deps_root`, `deps_root_space`. Shows a CPU/GPU override dropdown (default = detected, fail-safe CPU). A "pomiń na razie" affordance dismisses the screen; import/SRT-paste/export remain reachable while deps are absent. All strings Polish (`Zależności`, `Pobierz`, `Zmień lokalizację`, `Pomiń na razie`, etc.).

#### 2. Transcription readiness gate + missing-dep CTA

**File**: `src/ui/import/transcribe.js`

**Intent**: Gate the transcription action on a spawn-free deps-readiness read; when deps are missing, disable transcription and surface a Polish "pobierz zależności" call-to-action linking back to the setup screen — without touching import/SRT/export.

**Contract**: Reuse the `whisperx_engine_cached` pattern: read `deps_status` (pure presence/version read, no spawn) to decide the gate. Missing → CTA + disabled transcribe; ready → normal flow. The readiness badge logic stays launch-path-safe (S-18).

#### 3. Persisted variant override

**File**: `src/ui/first-run-deps.js` + `src-tauri/src/deps.rs`

**Intent**: Persist the user's CPU/GPU override so the resolver (Phase 1 precedence) and downloader honor it across launches.

**Contract**: Override stored per-machine in `deps-settings.json` (`variantOverride`, the same backend file as the deps root — see Phase 2 §1), so `detect_variant()` reads it from Rust ahead of `nvidia-smi`. Changing it re-runs `deps_status` and surfaces the now-required (possibly not-yet-downloaded) variant.

### Success Criteria:

#### Automated Verification:

- Prettier clean: `npx prettier --check "src/**/*.{js,css,html}"`
- Regression suite green: `node --experimental-vm-modules test/regression.js`
- No non-Polish user-facing strings introduced (grep review of new UI strings)

#### Manual Verification:

- First launch shows the setup screen; it is dismissable and import/SRT-paste/export work with no deps
- Variant override flips the required engine; downloading it stages + readies transcription
- Per-artifact progress (%/speed/ETA) renders; a completed required set flips transcription from gated to enabled
- Offline first launch shows the Polish "pobierz zależności" CTA on transcription, app otherwise usable
- "Change location" picks a second drive and downloads there; bad/too-small target is rejected with a Polish error

**Implementation Note**: After this phase and all automated verification passes, pause for manual confirmation before proceeding.

---

## Phase 5: Thin-installer bundler config + Windows validation

### Overview

Strip the heavy `externalBin`/`resources` entries from the Windows bundle (via a platform config overlay), keeping macOS bundled, verify the installer shrinks to tens of MB, and validate the full first-run flow on real GPU + CPU Windows hardware.

### Changes Required:

#### 1. Platform-scoped bundle config

**File**: `src-tauri/tauri.windows.conf.json` (new overlay), `src-tauri/tauri.conf.json`

**Intent**: Remove the heavy `whisperx-engine`, `whisperx-engine-gpu`, `ffmpeg`, and `align_models` entries from the **Windows** bundle while leaving the macOS base config bundling as-is.

**Contract**: Tauri merges `tauri.<platform>.conf.json` over the base. The Windows overlay sets `bundle.externalBin` to the thin set (or empty) and drops `align_models` from `resources`. The base `tauri.conf.json` keeps the macOS-bundled entries. Confirm the dev fallback (repo `binaries/`) still satisfies `cargo`/`tauri dev` on Windows, or document that dev requires the staged deps.

#### 2. Build/docs alignment

**File**: `CLAUDE.md`, `sidecar/README.md`

**Intent**: Document that the Windows distribution is thin + download-on-demand, where deps stage, and how a fresh dev checkout obtains them (build script vs. first-run download).

**Contract**: Prose updates only — reflect the new spawn path, the deps root, and the platform split. No code.

### Success Criteria:

#### Automated Verification:

- Windows `tauri build` produces an installer in the tens-of-MB range (manually inspect artifact size — assert it is < ~80 MB)
- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Regression suite green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- Thin installer installs on a clean Windows machine with **no** bundled engine/ffmpeg present
- First run on a **CUDA** machine downloads + stages the GPU engine and transcribes successfully
- First run on a **CPU-only** machine downloads + stages the CPU engine and transcribes successfully
- Moving the install to another machine re-resolves and downloads only what is missing/stale
- A bumped spec `version`/checksum triggers re-download of just that dependency (no stale sidecar served)
- macOS build still bundles and runs unchanged

**Implementation Note**: This is the final, hardest-to-reverse phase. Complete all automated checks, then pause for manual confirmation on real GPU + CPU Windows hardware before considering the slice done.

---

## Testing Strategy

### Unit Tests:

- `deps.rs`: variant filtering (GPU vs CPU host → correct required set), host platform/arch match, env-override precedence, spec deserialization of the embedded fallback.
- `deps.rs` downloader: checksum mismatch deletes the partial and errors; atomic swap leaves no `.part`; staged-path resolver returns the contract paths.
- Preserve the existing `models.rs` `verify_sha256` test.

### Integration Tests:

- Full first-run resolve → download → stage → spawn on Windows (manual, both GPU and CPU machines — the only place the spawn-path rework and hardware detection can be truly validated).

### Manual Testing Steps:

1. Clean Windows install of the thin installer; confirm no bundled heavy bins.
2. Launch; confirm setup screen, hardware detection, auto-picked variant.
3. Dismiss setup; confirm import/SRT-paste/export work with no deps.
4. Download required deps; confirm progress, checksum acceptance, staging, and that transcription un-gates.
5. Transcribe; confirm byte-identical `sentences[]` and Polish diacritics.
6. Toggle the variant override; confirm re-resolution + re-download.
7. Simulate offline first run; confirm embedded-spec fallback + Polish CTA + usable non-transcription paths.
8. Bump a dependency `version` in the spec; confirm targeted re-download.
9. Run `node --experimental-vm-modules test/regression.js` before and after; confirm green.

## Performance Considerations

- Hardware detection (`nvidia-smi -L`) and all readiness/status reads stay spawn-free and off the launch path (S-18) — first paint must not block on a sidecar spawn or a network call.
- Spec fetch has a short timeout with immediate embedded fallback so first launch never stalls on the host.
- Progress events stay throttled (~5/s, as `download_model` already does) to avoid flooding the UI thread on multi-GB downloads.

## Migration Notes

- Existing installs that already have bundled bins continue to work via the repo/bundle fallback in the path resolvers — no forced re-download for current users until they move to a thin build.
- `whisper-models/<id>/` layout is unchanged; previously downloaded models are reused as-is (the `model` dependency kind resolves to the same dir).
- macOS is unaffected this slice (still bundled).

## References

- Roadmap entry: `context/foundation/roadmap.md` → S-29
- Download/verify/stage to generalize: `src-tauri/src/models.rs:142,167,299`
- Hardware detection + variant selection to reuse: `src-tauri/src/engine.rs:65,84,144`
- Spawn sites to rework: `src-tauri/src/whisper.rs:292,560,796`, `src-tauri/src/ffmpeg.rs:5`, `src-tauri/src/waveform.rs`
- Curated-spec pattern to mirror: `src/transcription/model-registry.js`
- Frontend download UI surface to reuse: `src/ui/import/transcribe.js`
- Prereqs: S-05 (model manager + staging contract), S-24 (per-hardware sidecar variants)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 0: Release-host artifacts + pinned checksums (prerequisite)

#### Automated

- [ ] 0.1 Each pinned URL reachable and returns expected `sizeBytes`
- [ ] 0.2 Re-computed SHA-256 of each artifact matches the embedded spec value

#### Manual

- [ ] 0.3 Downloading each artifact from its pinned URL reproduces the embedded `sha256`
- [ ] 0.4 Bumping one artifact yields a new versioned URL (old URL still serves old bytes)

### Phase 1: Declarative dependency spec + hardware resolver

#### Automated

- [x] 1.1 Rust type-check passes (`cargo check`) — 989847c
- [x] 1.2 Unit tests for variant filtering + host-match pass (`cargo test deps`) — 989847c
- [x] 1.3 Embedded `deps-spec.json` deserializes into `DepsSpec` (unit test) — 989847c
- [x] 1.4 Regression suite green — 989847c

#### Manual

- [ ] 1.5 `deps_status` reports gpu engine on CUDA host, cpu engine on CPU-only host
- [ ] 1.6 `REEL_ENGINE_VARIANT=cpu` forces CPU engine on a GPU machine
- [ ] 1.7 Loader returns embedded spec when the release host is unreachable

### Phase 2: Generalized downloader + staging

#### Automated

- [x] 2.1 Rust type-check passes (`cargo check`)
- [x] 2.2 Existing `models.rs` checksum test still passes
- [x] 2.3 New downloader unit test (mismatch deletes partial, atomic swap leaves no `.part`) passes
- [x] 2.4 Regression suite green

#### Manual

- [ ] 2.5 CPU engine stages a runnable exe with `align_models/` beside it
- [ ] 2.6 Corrupted artifact (wrong sha256) rejected + removed, no partial staged
- [ ] 2.7 Changing deps root to a second drive re-resolves + downloads; writability/space validation rejects bad target
- [ ] 2.8 `dep-download-progress` reports plausible %/speed/ETA

### Phase 3: Spawn-path rework — staged absolute paths via raw Command

#### Automated

- [ ] 3.1 Rust type-check + build pass
- [ ] 3.2 No surviving `.shell().sidecar(` references for engine/ffmpeg
- [ ] 3.3 Regression suite green

#### Manual

- [ ] 3.4 Transcription runs end-to-end (absolute-path spawn) with byte-identical `sentences[]`
- [ ] 3.5 Cancelling transcription kills the child (no orphan process)
- [ ] 3.6 Wedged/slow engine hits timeout + explicit kill (no hang)
- [ ] 3.7 FFmpeg extraction + waveform decode still work
- [ ] 3.8 Polish diacritics survive in result JSON

### Phase 4: First-run setup screen + provisioning UI (Polish)

#### Automated

- [ ] 4.1 Prettier check clean
- [ ] 4.2 Regression suite green
- [ ] 4.3 No non-Polish user-facing strings introduced

#### Manual

- [ ] 4.4 Setup screen shows on first launch, dismissable, import/SRT/export usable with no deps
- [ ] 4.5 Variant override flips required engine; download stages + readies transcription
- [ ] 4.6 Per-artifact progress renders; completed required set un-gates transcription
- [ ] 4.7 Offline first launch shows Polish "pobierz zależności" CTA, app otherwise usable
- [ ] 4.8 "Change location" downloads to a second drive; bad/too-small target rejected with Polish error

### Phase 5: Thin-installer bundler config + Windows validation

#### Automated

- [ ] 5.1 Windows `tauri build` installer is tens-of-MB (< ~80 MB)
- [ ] 5.2 Rust type-check passes
- [ ] 5.3 Regression suite green

#### Manual

- [ ] 5.4 Thin installer installs on clean Windows with no bundled engine/ffmpeg
- [ ] 5.5 First run on CUDA machine downloads + stages GPU engine and transcribes
- [ ] 5.6 First run on CPU-only machine downloads + stages CPU engine and transcribes
- [ ] 5.7 Moved-to-another-machine install re-resolves + downloads only missing/stale
- [ ] 5.8 Bumped spec version/checksum triggers targeted re-download (no stale sidecar)
- [ ] 5.9 macOS build still bundles and runs unchanged
