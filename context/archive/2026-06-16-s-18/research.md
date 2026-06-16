---
date: 2026-06-16T14:45:40+0200
researcher: GarniczAndrzej
git_commit: bf132dad7f3e123e7f6fecc40d146b0f07b0ff63
branch: master
repository: REEL_AUTOMATOR
topic: "WhisperX engine readiness probe — 15-min idle hang on every launch"
tags: [research, codebase, whisperx, engine-readiness, sidecar, caching, tauri]
status: complete
last_updated: 2026-06-16
last_updated_by: GarniczAndrzej
---

# Research: WhisperX engine readiness probe — 15-min idle hang on every launch

**Date**: 2026-06-16T14:45:40+0200
**Researcher**: GarniczAndrzej
**Git Commit**: bf132dad7f3e123e7f6fecc40d146b0f07b0ff63
**Branch**: master
**Repository**: REEL_AUTOMATOR

## Research Question

For change **s-18**, gather concrete codebase evidence to feed `/10x-plan`. The
frame brief (`context/changes/s-18/frame.md`) reframed the problem as: *the engine
readiness probe does far too much work (frozen-`whisperx` import + align-model load +
real forced-align, ~65 s reproduced warm+offline) and re-runs it from scratch on every
launch, with no cross-launch caching, to paint a cosmetic, non-gating badge*. This
research nails down the exact code path across the three tiers (Rust command → JS badge →
Python sidecar) and the existing caching/persistence primitives a fix can reuse.

## Summary

The frame's reframe is fully confirmed by the live code on all three tiers:

1. **The probe is heavyweight by construction.** `whisperx_engine_check`
   (`engine.rs:105`) spawns the sidecar with `--selftest`, which (`whisperx_engine.py:213-235`)
   imports `whisperx` (drags torch/transformers), **loads the real wav2vec2 align model**,
   and **runs a real `whisperx.align()` on a synthetic 0.5 s clip** — every launch. The
   cheap parts (device detection, "does the align dir exist") are wrapped around the two
   genuinely expensive parts (model deserialize + align inference).

2. **It is unbounded and uncached on the Rust side.** No timeout on the spawn
   (`engine.rs` `run_engine` `recv().await`, no guard), no memoization, no disk persistence.

3. **It does NOT gate transcription.** `syncTranscribeBtn` (`transcribe.js:73-77`) enables
   the Transcribe button on `hasVideo && hasModel` only — readiness is never consulted.
   The frontend already fires the probe **without awaiting** (`transcribe.js:92`,
   fire-and-forget) — so it's off the JS critical path already, but it still does ~65 s+ of
   work per launch and the badge just sits in its default state until it lands.

4. **A lightweight verdict is cheap to produce.** `{device, gpu, alignment_model_ready}` can
   be reported from `_detect_device()` (cheap, no model) + a directory existence check
   (`os.path.isdir + os.listdir`, cheap) — **without** loading the align model or running a
   real align. The two expensive steps are exactly the two that can be dropped.

5. **Cross-launch caching has a clean precedent.** Three Rust caches
   (`project.rs` LLM cache, `whisper.rs`, `waveform.rs`) all use the same recipe:
   `app.path().app_cache_dir().join("<name>")` + `create_dir_all` + SHA-256 content key +
   `serde_json` read/write, **content-addressed (no TTL)**. `EngineStatus` already derives
   `Serialize`; a verdict file keyed on the sidecar `version` string (already in the JSON) +
   align-model mtime/size fits this pattern exactly.

**Two independent levers, both fully in our control** (either neutralizes the reproducible
~65 s; together they also neutralize the environmental 15-min tail):
- **(A) Lighten the probe** — drop the real forced-align (and ideally the align-model load),
  reporting `alignment_model_ready` from a dir check instead.
- **(B) Cache the verdict across launches** — content-addressed JSON in `app_cache_dir`,
  keyed on engine version + align-model metadata.

## Detailed Findings

### Tier 1 — Rust command (`src-tauri/src/engine.rs`, `whisper.rs`, `lib.rs`)

- **What the check spawns** — `whisperx_engine_check` spawns the sidecar with `--selftest`,
  appending `--align-model-dir <path>` when the bundled align dir exists
  (`engine.rs:105-129`, args at `:106-109`).
- **Env flags** — `with_hf_offline` sets **only** `HF_HUB_OFFLINE=1` + `TRANSFORMERS_OFFLINE=1`
  (`engine.rs:26-29`); applied to the selftest command (`:76`). No `HF_HOME`/`HF_HUB_CACHE`/
  endpoint knobs are touched — so if those two flags don't fully cover a transformers/HF-hub
  internal call, a network HEAD can still leak (the suspected source of the user's 15-min tail;
  not reproduced locally — frame.md:48,63-80).
- **Return shape** — `EngineStatus { ok, version, gpu, device, alignment_model_ready }`
  (`engine.rs:58-65`), parsed from the sidecar's stdout JSON (`:120-128`). On non-zero exit,
  returns an error with the stderr tail.
- **No timeout / no cache / no persistence** — `run_engine` (`engine.rs:69-100`) awaits
  `recv()` unbounded (`:88`), no timeout guard (contrast: `drive_engine` in `whisper.rs:283`
  has a 250 ms poll timeout, but that path is *not* used by the readiness check). No
  memoization, no disk write of the verdict.
- **Align-model path resolution** — `align_model_dir` (`engine.rs:42-55`): prod resolves
  `align_models` via `BaseDirectory::Resource` (`:43`), dev falls back to
  `${CARGO_MANIFEST_DIR}/binaries/align_models` (`:48-50`); registered in
  `tauri.conf.json:39` `resources`. Passed to the sidecar as `--align-model-dir`.
- **Spawn mechanism** — `tauri_plugin_shell` `app.shell().sidecar(ENGINE_SIDECAR)`
  (`engine.rs:11,77-78`); `ENGINE_SIDECAR = "whisperx-engine"` (`:15`). The **same** sidecar
  invoke path is used by readiness, `transcribe_video`, and `align_transcript`
  (`whisper.rs:483,692`) — no separate binary or extraction logic in Rust. Binary registered
  as `externalBin` in `tauri.conf.json:38`.

### Tier 2 — Frontend badge (`src/ui/import/transcribe.js`, `main.js`, `step1-import.js`)

- **`refreshEngineReadiness()`** (`transcribe.js:95-113`) — `invoke('whisperx_engine_check')`,
  then writes `#engineReadyIndicator`: success → `✓ Silnik gotowy (<device>[, GPU][, model
  dopasowania wbudowany])` green (`:102-103`); `ok:false` → amber "nie jest jeszcze zbudowany"
  (`:105-107`); throw → amber "Nie można sprawdzić silnika" (`:110-111`).
- **Single call site, fire-and-forget** — invoked once in `initModelManager()`
  (`transcribe.js:92`), **not awaited**. The in-code comment (`:86-89`) already documents the
  cost: *"spawns a cold sidecar self-test (heavy: imports torch, loads the bundled align model,
  runs a real forced-align) and can take tens of seconds — do NOT gate the model UI on it."*
  Init chain: `main.js:19` → `step1.init()` (`step1-import.js:12` `initTranscribe()`) →
  `initModelManager()`.
- **Does NOT gate transcription** — `syncTranscribeBtn` (`transcribe.js:73-77`):
  `disabled = !(hasVideo && hasModel)`, where `hasModel` = `state.modelId` downloaded.
  Readiness is never read. (Call sites that re-sync the button: `:128,221,282,533,622` — none
  involve readiness.)
- **No verdict caching anywhere** — the result is never persisted. Existing `edl_`-prefixed
  localStorage keys in this area: `edl_whisper_advanced` (per-machine device/computeType,
  `transcribe.js:296,313,324`), `edl_app_settings` (`settings.js:9`), `edl_apikey_<provider>`
  (`api-key.js:7`), `edl_or_model` / `edl_or_models_cache` (`openrouter-picker.js`). None hold
  a readiness verdict.
- **No spinner / no retry / no explicit JS timeout** — the badge sits in its default
  `--text3` state until the probe lands; no loading indicator, no retry path, no
  re-invocation after init.

### Tier 3 — Python sidecar (`sidecar/whisperx_engine/whisperx_engine.py`, `.spec`)

- **`--selftest` step-by-step** (`cmd_selftest`, `whisperx_engine.py:213-235`):
  1. `_detect_device()` (`:214`) — `import torch`, checks cuda/mps. **Cheap.**
  2. `import whisperx` (`:217`) — drags frozen torch/transformers. **Expensive (import).**
  3. `_selftest_align_runs(whisperx)` (`:221`, body `:185-202`):
     - dir existence check `os.path.isdir(model_dir) and os.listdir(model_dir)` (`:185-186`) — **cheap**;
     - `whisperx.load_align_model(...)` (`:191-193`) — **deserializes the wav2vec2 model. Expensive.**
     - `whisperx.align(...)` on synthetic `np.zeros(8000)` 0.5 s clip (`:194-202`) — **real
       forced-align inference. Expensive.**
  4. Emit JSON (`:226-234`).
- **JSON output** (`:226-234`): `{ ok, version, gpu, device, alignment_model_ready }` — matches
  the Rust `EngineStatus` struct.
- **`--version` is an exact alias for `--selftest`** — `p.add_argument("--version", ...,
  help="alias for --selftest")` (`:489`); dispatch `if args.selftest or args.version: return
  cmd_selftest()` (`:508-509`). So `--version` *also* runs the full heavy align exercise (it
  did not finish within a 60 s guard — frame.md:73). There is **no** cheap version/capability
  subcommand today.
- **Sidecar does not self-set offline flags** — relies entirely on the Rust-provided
  `HF_HUB_OFFLINE`/`TRANSFORMERS_OFFLINE` env (`whisperx_engine.py:500-506`; only reads
  `ENGINE_DEBUG`, `ENGINE_ALIGN_DIR`, `HF_TOKEN`). Potential network leak points if those two
  flags miss an internal call: `load_align_model` (`:191-193` selftest, `:257` real path),
  `DiarizationPipeline` (`:318-320`).
- **Lightweight capability check is feasible** — minimal `{device, gpu, alignment_model_ready}`
  needs only `_detect_device()` + the `os.path.isdir/os.listdir` dir check; both already exist
  in the file. Dropping `load_align_model` + `align()` removes the two expensive steps. (An
  intermediate option: load the align model but skip `.align()` — medium cost.)
- **Packaging** (`whisperx_engine.spec`): **onefile** (`EXE(...)` at `:100`, no `COLLECT`),
  `console=True` (`:112`). Align model is **NOT** baked in — shipped beside the binary
  (`align_models/`, comments `:6-12,22-26`; consistent with lesson "never bake multi-GB into a
  onefile"). Bundled into the 290 MB archive: whisperx/faster_whisper/pyannote/transformers
  data files + explicit dist-info metadata (`:29-67`). Onefile means the archive
  un-compresses/extracts on spawn — a per-launch cost that is environment-sensitive (cold vs
  warm temp dir), the second suspected contributor to the user's tail.

### Reusable caching / persistence primitives (for a fix)

- **Uniform Rust cache recipe** — `app.path().app_cache_dir().join("<name>")` + `create_dir_all`:
  `project.rs:28` (`llm-cache`), `whisper.rs:399` (`whisper-cache`), `waveform.rs:51-52`
  (`waveform-cache`). (Downloaded *models* use `app_data_dir` instead — `models.rs:39` — because
  they're persistent inputs, not derived; a readiness verdict is derived → `app_cache_dir` is the
  right precedent.)
- **Simplest JSON read/write precedent** — LLM cache `project.rs:26-46`: `fs::read_to_string`/
  `fs::write` of `dir.join(format!("{}.json", hash))`, plus `clear_*` = `remove_dir_all`. The
  whisper cache wraps the serde version (`whisper.rs:214-250`).
- **Hashing already available** — `sha2::Sha256`, used with a `metadata.len() + mtime +
  first-1MB` recipe in `whisper.rs:35-53` (`compute_video_hash`) and `waveform.rs:60-77`
  (`source_hash`, 16 hex chars); pure string→hash composer at `whisper.rs:201-208`.
- **`withLlmCache` (frontend)** — `cache.js`: SHA-256 hex of the cacheKey (`:1-9`),
  Tauri-only via `load_llm_cache`/`save_llm_cache`/`clear_llm_cache` (`:26,35,46`), **falls
  through silently outside Tauri / on any error** (`:17-23,28-38`). The "best-effort, never
  fatal" behavior is the model to mirror: a verdict-cache miss/error just re-probes.
- **Invalidation signal** — `EngineStatus.version` already exists (`engine.rs:62`, from the
  sidecar JSON `:124`); it's the natural primary validator (bump engine → version changes →
  verdict invalidates). For robustness, `align_model_dir` is resolvable (`engine.rs:42-55`) and
  can be `fs::metadata`'d for size/mtime like `source_hash`. **Caveat:** the sidecar *binary*
  path is never resolved in code (only invoked by name via `sidecar(ENGINE_SIDECAR)`), so keying
  on the binary's own mtime would need new path-resolution work — the `version` string avoids that.
- **No TTL anywhere** — all three caches are content-addressed; staleness is handled by key
  composition + an on-read sanity check (waveform validates `peaks.len() == num_samples`,
  `waveform.rs:26`; whisper namespaces with `CACHE_VERSION = "v2"`, `:29`, + legacy fallback
  `:226-239`). A verdict cache should follow suit: version-namespace + validate fields on read.

## Code References

- `src-tauri/src/engine.rs:26-29` — `with_hf_offline` (only HF_HUB_OFFLINE + TRANSFORMERS_OFFLINE)
- `src-tauri/src/engine.rs:42-55` — `align_model_dir` resolution (Resource / dev fallback)
- `src-tauri/src/engine.rs:58-65` — `EngineStatus` struct (derives Serialize)
- `src-tauri/src/engine.rs:69-100` — `run_engine` spawn loop (unbounded `recv().await`, no timeout)
- `src-tauri/src/engine.rs:105-129` — `whisperx_engine_check` (spawns `--selftest [--align-model-dir]`)
- `src/ui/import/transcribe.js:73-77` — `syncTranscribeBtn` (gates on video+model, NOT readiness)
- `src/ui/import/transcribe.js:85-93` — `initModelManager` (fires `refreshEngineReadiness()` un-awaited)
- `src/ui/import/transcribe.js:95-113` — `refreshEngineReadiness` (invoke + badge render)
- `sidecar/whisperx_engine/whisperx_engine.py:185-202` — `_selftest_align_runs` (loads model + real align)
- `sidecar/whisperx_engine/whisperx_engine.py:213-235` — `cmd_selftest` (full heavy probe + JSON)
- `sidecar/whisperx_engine/whisperx_engine.py:489,508-509` — `--version` is an alias for `--selftest`
- `sidecar/whisperx_engine.spec:100-112` — onefile, console=True
- `src-tauri/src/project.rs:26-46` — LLM disk cache (closest JSON-verdict precedent)
- `src-tauri/src/whisper.rs:35-53,201-250,399` — hashing + serde cache + app_cache_dir
- `src-tauri/src/waveform.rs:26,51-77` — app_cache_dir + source_hash + on-read length validation
- `src/ai/cache.js:1-46` — `withLlmCache` (SHA-256 key, Tauri-only, best-effort fall-through)

## Architecture Insights

- **The readiness check violates the "health badge is cheap/cached/non-blocking" convention
  on the Rust+sidecar tiers** even though the frontend already treats it as non-blocking
  (un-awaited). The heavy work is structural, inside `--selftest`, not in how JS calls it.
- **Two clean, orthogonal fix levers exist**, each fully in-repo: lighten the sidecar probe
  (drop `align()` / `load_align_model`) and/or cache the verdict in Rust. The cache pattern is
  already triplicated in the codebase, so adding a fourth `engine-readiness` cache is idiomatic,
  low-risk, and needs no new dependency (`sha2`, `serde_json`, `app_cache_dir` all present).
- **The `version` string is the cheapest correct invalidation key** and already crosses the
  Rust↔sidecar boundary, avoiding the unsolved "resolve the sidecar binary's on-disk path"
  problem.
- **The environmental 15-min tail (network-despite-offline and/or cold onefile extraction) is
  not reproducible here and not directly fixable in code beyond hardening offline coverage** —
  but both levers above make it irrelevant to the user, because (a) a cached verdict means the
  probe rarely runs, and (b) a lightened probe that never touches HF/align-load can't leak a
  network call. Transcription was never gated on the badge, so the user never waits on it.

## Historical Context (from prior changes)

- `context/changes/s-18/frame.md` — the reframe this research backs: probe is ~65 s of
  heavyweight work re-run every launch for a non-gating badge (D5 verdict STRONG/verified);
  15-min tail is environmental (D4 MEDIUM). Reproduction at `frame.md:63-80`.
- `context/foundation/lessons.md` — "Never bake multi-GB assets into a PyInstaller onefile":
  the align model is correctly shipped *beside* the binary (confirmed in `.spec:6-12,22-26`), so
  any fix must keep passing `--align-model-dir` and must not re-bake the model.
- Prior commit `287e5c8` "faster engine readiness" — recurring pain on this exact surface,
  indicating earlier attempts didn't address the structural every-launch re-run.
- `context/archive/2026-06-12-builtin-whisperx-transcription/` — origin of the bundled-sidecar
  architecture this probe sits on.

## Related Research

- None prior under `context/changes/**/research.md`; this is the first research artifact for s-18.
  Upstream: `context/changes/s-18/frame.md`.

## Open Questions

1. **Which call leaks the network HEAD on the user's machine** (if any) — `load_align_model`
   vs a transformers internal vs pyannote. Pin only on the *user's* machine: run the selftest
   *without* offline flags and watch `lsof -nP -i` (frame.md:124-127). Not a planning blocker —
   lever (A)/(B) neutralize it regardless.
2. **Cold-extraction magnitude of the 290 MB onefile** — un-measured here; compare cold vs warm
   wall time on the user's machine. If extraction is minutes, a verdict cache still helps (probe
   runs rarely) but doesn't shrink the *first-ever* spawn.
3. **Cache-key strength** — is `version` alone sufficient, or should the align-model dir
   mtime/size be folded in? Cheapest correct = `version`; robust = `version + align metadata`.
   A plan decision, not a code unknown.
4. **Where to lighten the probe** — drop `align()` only (keep `load_align_model` to truly prove
   the model loads) vs drop both (report `alignment_model_ready` from a dir check). Trade-off:
   fidelity of the badge vs cost. Recommend dir-check for the cached/fast path, with the full
   exercise available behind an explicit/manual re-verify if ever needed.
