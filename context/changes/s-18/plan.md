# WhisperX Engine Readiness Probe — Cheap, Cached, Non-Blocking Implementation Plan

## Overview

The "✓ Silnik gotowy" readiness badge runs the heaviest possible probe on **every**
launch — the sidecar `--selftest` imports frozen `whisperx` (dragging torch/transformers),
loads the real wav2vec2 align model, and runs a real `whisperx.align()` on a synthetic
clip (~65 s reproduced warm+offline; ~15 min on the user's machine via an environmental
network/extraction tail) — to paint a **cosmetic, non-gating** badge with **no
cross-launch caching**.

This plan makes the badge cheap, cached, and non-blocking on all three tiers:
1. **Sidecar** — add a lightweight `--capability` subcommand that reports the same JSON
   from a device check + an align-dir existence check, dropping the two confirmed-expensive
   steps (`load_align_model` + `align()`).
2. **Rust** — a new `whisperx_engine_capability` command that caches the verdict
   (content-addressed in `app_cache_dir`, keyed on app version + align-model metadata) and
   bounds the spawn with a timeout; the existing `whisperx_engine_check` (full `--selftest`)
   becomes the manual re-verify path.
3. **Frontend** — point the badge at the cached capability command and add a manual "pełna
   weryfikacja" action driving the full self-test.

## Current State Analysis

- **The probe is heavyweight by construction.** `cmd_selftest`
  (`sidecar/whisperx_engine/whisperx_engine.py:213-235`) calls `_detect_device()` (cheap,
  imports torch), then `import whisperx` (expensive), then `_selftest_align_runs`
  (`:174-210`) which does a cheap dir check **then** `whisperx.load_align_model` (expensive
  deserialize) **then** a real `whisperx.align()` on `np.zeros(8000)` (expensive inference).
- **It is unbounded and uncached on the Rust side.** `whisperx_engine_check`
  (`src-tauri/src/engine.rs:104-129`) spawns `--selftest [--align-model-dir …]`;
  `run_engine` (`:69-100`) awaits `rx.recv()` with **no timeout** (`:88`). No memoization,
  no disk persistence of the verdict.
- **It does NOT gate transcription.** `syncTranscribeBtn`
  (`src/ui/import/transcribe.js:73-77`) enables Transcribe on `hasVideo && hasModel` only;
  readiness is never read. The frontend already fires the probe **un-awaited**
  (`transcribe.js:92`), so it's off the JS critical path — but the badge sits in its default
  state for ~65 s+ until the heavy probe lands, and the probe can leak an HF network call.
- **A lightweight verdict is already expressible from existing helpers.**
  `_detect_device()` (`:118-130`) gives `{device, gpu}`; `_alignment_model_dir(language)`
  (`:114-115`) + `os.path.isdir/os.listdir` gives `alignment_model_ready` — neither needs
  the align model loaded or a real align run.
- **`--version` is a heavy alias for `--selftest`** (`:489`, dispatch `:508-509`) — there is
  no cheap capability subcommand today.
- **Cross-launch caching has a triplicated precedent.** `project.rs:26-46` (LLM cache),
  `whisper.rs:399`, `waveform.rs:51-77` all use `app.path().app_cache_dir().join("<name>")`
  + `create_dir_all` + SHA-256 key + `serde_json`, content-addressed (no TTL), validate-on-read.
  `EngineStatus` (`engine.rs:58-65`) already derives `Serialize`.

### Key Discoveries:

- The two confirmed-expensive steps are exactly the two that can be dropped:
  `whisperx.load_align_model` (`whisperx_engine.py:191-193`) and `whisperx.align`
  (`:195-202`). Reported alignment readiness becomes a dir check (`:185-186`, already present).
- `_detect_device()` imports **torch only** (`:120-121`), not `whisperx` — so the capability
  path can report device/gpu without dragging transformers/pyannote.
- The cache key cannot use the engine-reported `version` for the **lookup** (it's only known
  after spawning). The pre-spawn proxy is the **app package version** (`app.package_info()`),
  which bumps exactly when a new bundled sidecar ships, plus the **align-model dir size+mtime**
  (resolvable cheaply via `align_model_dir`, `engine.rs:42-55`). The engine-reported `version`
  is carried inside the stored verdict as an on-read sanity field.
- The sidecar binary is **frozen** (PyInstaller onefile, `whisperx_engine.spec:100`); editing
  the `.py` has **no effect** on the bundled sidecar until `sidecar/build.sh` rebuilds it. Both
  sidecars + `align_models/` are git-ignored and absent from a fresh checkout (see CLAUDE.md
  and the `whisperx-sidecar-build` memory).

## Desired End State

On launch the badge paints from the last-known cached verdict in milliseconds (no spawn) when
nothing relevant changed; on a cache miss it spawns the **cheap** `--capability` probe (device
detect + dir check, no model load, no align, no HF network), bounded by a timeout, and writes
the verdict to the cache. Transcription is never gated on the badge (unchanged). A "Pełna
weryfikacja silnika" control runs the full `--selftest` on demand, updating the badge and the
cache. The reproducible ~65 s collapses to a cheap probe (or a cache hit), and the environmental
15-min tail is neutralized because the capability path never loads the align model or touches HF.

**Verification**: `whisperx-engine --capability --align-model-dir <dir>` returns the readiness
JSON in well under a second (warm); a second app launch paints the badge with no sidecar spawn
(cache hit); the manual re-verify still exercises a real align.

## What We're NOT Doing

- **Not** shrinking the 290 MB onefile binary or changing packaging (`whisperx_engine.spec`) —
  the frame established the binary size is the wrong lever.
- **Not** re-baking the align model into the binary — it stays beside the sidecar
  (`--align-model-dir`), per the standing lesson.
- **Not** changing the transcription / `--align-only` / diarization paths — only the readiness
  probe surface.
- **Not** gating the Transcribe button on readiness (it never was; `syncTranscribeBtn` stays).
- **Not** changing `--version`'s current behavior beyond what Phase 1 specifies (it remains the
  heavy `--selftest` alias; out of scope to re-home).
- **Not** chasing the environmental network-leak call on the user's machine (frame Open Q1) — the
  lighter+cached path makes it irrelevant; the optional `lsof` pin stays a user-machine diagnostic.
- **Not** adding a TTL — caching is content-addressed + validate-on-read like the other three caches.

## Implementation Approach

Both fix levers from research are applied and are orthogonal: **(A)** lighten the sidecar probe
so even a cache miss is cheap and network-safe, and **(B)** cache the verdict so the badge paints
instantly and the spawn is skipped when nothing changed. The full heavy self-test is retained
behind an explicit manual action so badge fidelity is never lost — it just stops running on every
launch. The cache mirrors the existing `project.rs`/`waveform.rs` recipe exactly (no new deps:
`sha2`, `serde_json`, `app_cache_dir` all present), and is best-effort: any cache error falls
through to a live probe.

## Critical Implementation Details

- **Sidecar rebuild is required to test Phase 1.** The bundled `whisperx-engine-<arch>` is a
  frozen onefile; editing `whisperx_engine.py` changes nothing until `sidecar/build.sh` re-freezes
  it. Phase 1's automated verification runs the rebuilt binary, not the source.
- **Cache key must be pre-spawn computable.** Use `app.package_info().version` + align-model dir
  `fs::metadata` (size + mtime) — both available without running the sidecar — so a cache hit can
  genuinely skip the spawn. The engine-reported `version` string is stored in the verdict for
  on-read validation only, never used as the lookup key.
- **Timeout must kill the child explicitly.** The bounded wait wraps `run_engine`'s recv loop in
  `tokio::time::timeout`; on elapse, call `child.kill()` **explicitly** (do NOT rely on drop —
  tauri-plugin-shell's `CommandChild` is not documented to terminate the process on drop, mirroring
  `std::process::Child`; a silent no-op leaves an orphaned sidecar running, i.e. the same hang
  detached and invisible) and return an error so the badge shows the amber "nie można sprawdzić"
  state rather than hanging. Verify the `kill()` signature against the pinned tauri-plugin-shell
  version during implementation.

---

## Phase 1: Sidecar — cheap `--capability` subcommand

### Overview

Add a lightweight capability probe to the Python sidecar that produces the same readiness JSON
without the two expensive steps, and expose it as a new `--capability` flag. Leave `--selftest`
(and its `--version` alias) as the full exercise for manual re-verify.

### Changes Required:

#### 1. New `cmd_capability()` and dispatch

**File**: `sidecar/whisperx_engine/whisperx_engine.py`

**Intent**: Report `{ok, version, gpu, device, alignment_model_ready}` from a device detection
plus an align-dir existence check — no `import whisperx`, no `load_align_model`, no `align()`, so
the probe cannot block on a model deserialize or an HF network call.

**Contract**: New `cmd_capability()` returning the same JSON shape as `cmd_selftest`
(`:226-234`) via `_write_result(json.dumps(...))` → `EXIT_OK`. `device, gpu, _ = _detect_device()`
(`:118-130`); `alignment_model_ready` from `os.path.isdir(d) and os.listdir(d)` over
`_alignment_model_dir("pl")` (`:114-115`, mirroring `:185-186`); `version = str(ENGINE_VERSION)`
(`:61` — `whisperx` is intentionally not imported here, so its `__version__` is unavailable);
`ok = True` when device detection completed. Add `p.add_argument("--capability", action="store_true",
help="print lightweight readiness JSON (no model load) and exit")` beside `--selftest` (`:488`),
and dispatch it **before** the `--selftest`/`--version` branch in `main` (`:508-509`):
`if args.capability: return cmd_capability()`.

### Success Criteria:

#### Automated Verification:

- Sidecar rebuilds cleanly: `sidecar/build.sh` completes and produces `whisperx-engine-<arch>`
- Capability probe returns valid JSON fast: `src-tauri/binaries/whisperx-engine-aarch64-apple-darwin --capability --align-model-dir src-tauri/binaries/align_models` prints `{"ok": true, …, "alignment_model_ready": true}` and exits 0 in well under a second
- `--selftest` still runs the full exercise (unchanged): same command with `--selftest` still loads the model and runs a real align

#### Manual Verification:

- Capability JSON `device`/`gpu` matches the machine (e.g. `mps`, `gpu:true` on Apple Silicon)
- With `align_models/` absent/empty, `alignment_model_ready` is `false` (dir-check correctness)
- No network sockets opened during `--capability` (`lsof -nP -i` during the run shows none)

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 2: Rust — capability command, verdict cache, bounded timeout

### Overview

Add a cached, timeout-bounded `whisperx_engine_capability` command that the badge will call, and
keep `whisperx_engine_check` as the heavy manual re-verify (now also writing the cache). Introduce
an `engine-readiness` disk cache mirroring the existing cache recipe.

### Changes Required:

#### 1. Bounded spawn

**File**: `src-tauri/src/engine.rs`

**Intent**: Guarantee the readiness probe can never hang the way the user observed — bound the
spawn wait and kill the child on elapse.

**Contract**: Wrap `run_engine`'s recv loop (`:88-98`) in `tokio::time::timeout` (e.g. 30 s).
On elapse, call `child.kill()` **explicitly** (not drop — see Critical Implementation Details:
the `CommandChild` is not documented to terminate the OS process on drop, so an orphaned sidecar
would survive), then return `Err("Sprawdzanie silnika przekroczyło limit czasu")`. Rebind the
child from `_child` (`:82`) to a live `mut child` handle threaded out of the recv loop so it is
killable on the timeout branch; verify the `kill()` signature against the pinned
tauri-plugin-shell version. Either add a `timeout` parameter to `run_engine` or add a
`run_engine_timeout` wrapper — both callers (`whisperx_engine_check`, new
`whisperx_engine_capability`) use the bounded form.

#### 2. `engine-readiness` verdict cache

**File**: `src-tauri/src/engine.rs`

**Intent**: Persist the verdict so the badge paints instantly and the spawn is skipped when
nothing relevant changed, following the `project.rs`/`waveform.rs` content-addressed pattern.

**Contract**: Add `Deserialize` to the `EngineStatus` derive (`:58`). Two private helpers in
`engine.rs`: `readiness_cache_key(app) -> String` = `sha256_hex(app.package_info().version` +
align-model dir `fs::metadata` size+mtime via `align_model_dir`, `:42-55`; fall back to a stable
sentinel when the dir is absent) — reuse the `sha2::Sha256` recipe from `whisper.rs:201-208`;
and read/write over `app.path().app_cache_dir()?.join("engine-readiness").join(format!("{key}.json"))`
with `create_dir_all`, mirroring `project.rs:26-46`. Both best-effort: any error → treat as a miss
and return `None` / skip the write (never fatal). The stored JSON is the `EngineStatus` (its
`version` field is the on-read sanity value).

#### 3. `whisperx_engine_capability` command

**File**: `src-tauri/src/engine.rs`, `src-tauri/src/lib.rs`

**Intent**: The badge's new entry point — return a cached verdict instantly on hit, else run the
cheap `--capability` probe (bounded) and cache the result.

**Contract**: `#[tauri::command] async fn whisperx_engine_capability(app) -> Result<EngineStatus,
String>`: compute `readiness_cache_key`; on cache hit return the deserialized `EngineStatus`
(no spawn); on miss spawn `--capability [--align-model-dir <dir>]` via the bounded `run_engine`,
parse the JSON exactly as `whisperx_engine_check` does (`:120-128`), write the cache, return.
Register in the `invoke_handler` generate list in `lib.rs` next to `whisperx_engine_check`.

#### 4. `whisperx_engine_check` writes the cache

**File**: `src-tauri/src/engine.rs`

**Intent**: The manual full re-verify should refresh the cached verdict so subsequent launches
reflect the heavyweight result.

**Contract**: After a successful parse in `whisperx_engine_check` (`:122-128`), write the resulting
`EngineStatus` to the readiness cache under the current key (best-effort) before returning.

### Success Criteria:

#### Automated Verification:

- Rust type-checks: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Rust builds: `~/.cargo/bin/cargo build --manifest-path src-tauri/Cargo.toml`
- Regression suite still passes (no exporter/parser regressions): `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- First launch (cold cache): badge resolves via the cheap `--capability` probe quickly; a
  `engine-readiness/<hash>.json` file appears under the app cache dir
- Second launch: badge paints from cache with **no** sidecar spawn (verify via no new process /
  instant resolution)
- Deleting the cache file or changing the align-model dir forces a fresh probe on next launch
- A simulated hang (e.g. point at a stalling sidecar) trips the timeout and surfaces the amber
  error state rather than hanging

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful before
proceeding to the next phase.

---

## Phase 3: Frontend — instant cached badge + manual re-verify

### Overview

Point the badge at the cached capability command, show a transient "checking" state on a cold
cache, and add a manual "Pełna weryfikacja silnika" control that drives the full self-test.

### Changes Required:

#### 1. Badge uses the cached capability command

**File**: `src/ui/import/transcribe.js`

**Intent**: The fast path — the badge calls the cached, lightened command so it resolves in ms on
a cache hit and stays off the critical path on a miss.

**Contract**: In `refreshEngineReadiness` (`:95-113`) switch `invoke('whisperx_engine_check')`
(`:100`) to `invoke('whisperx_engine_capability')`. Set a transient checking state (e.g.
`el.textContent = 'Sprawdzanie silnika…'`, `--text3`) before the await so a cold-cache miss shows
progress. Update the stale comment in `initModelManager` (`:86-89`) to describe the cheap cached
probe.

**Two-tier rendering (F1 — do NOT paint the authoritative green on the capability path).** The
capability probe is a device-detect + dir-check; it does **not** `import whisperx`, so it cannot
verify the frozen import chain — exactly the false-positive `whisperx_engine.py:177-183` documents
(a binary self-reporting `alignment_model_ready: true` yet failing every real align with exit 12).
Therefore the capability verdict renders a **distinct, non-authoritative tier**: on `ok:true`,
`el.textContent = '✓ Silnik wykryty ({device}{, GPU}) — pełna weryfikacja zalecana'` in a neutral/
amber tone (e.g. `--text2`/`--amber`), **not** the green `var(--green)` "✓ Silnik gotowy". The green
authoritative state is earned only by the full `--selftest` path (Phase 3 §2). Keep the existing
`ok:false`/catch rendering (`:104-112`) unchanged. The shared render helper (Phase 3 §2) takes an
`authoritative` flag so the same code paints the green tier for self-test and the amber "wykryty"
tier for capability.

#### 2. Manual "Pełna weryfikacja silnika" control

**File**: `src/ui/import/transcribe.js`, `src/index.html`

**Intent**: Preserve full-fidelity verification on demand without running it every launch.

**Contract**: Add a button beside `#engineReadyIndicator` in `index.html` (Polish label "Pełna
weryfikacja silnika"); wire a click handler in `initTranscribe` (near `:67`) that disables the
button + sets a "Pełna weryfikacja…" checking state, calls `invoke('whisperx_engine_check')`
(the heavy self-test, which also refreshes the Rust cache), then renders the verdict via the same
badge-rendering logic as `refreshEngineReadiness` (extract the render into a small shared helper,
`renderEngineBadge(el, status, { authoritative })`, to avoid duplication) and re-enables the
button. This path passes `authoritative: true`, so a passing self-test paints the green
`var(--green)` "✓ Silnik gotowy (…)" state — the only path that earns it (capability passes
`authoritative: false`, see Phase 3 §1). All user-facing strings Polish.

### Success Criteria:

#### Automated Verification:

- Prettier clean: `npx prettier --check "src/**/*.{js,css,html}"` (or `--write` then re-check)
- Regression suite passes: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- On launch the badge shows "Sprawdzanie silnika…" briefly (cold cache) then the
  non-authoritative "✓ Silnik wykryty … — pełna weryfikacja zalecana" tier (amber/neutral, **not**
  green); on subsequent launches it appears effectively instantly
- Clicking "Pełna weryfikacja silnika" shows a checking state, runs the real align (tens of
  seconds), then paints the authoritative green "✓ Silnik gotowy" state; the button re-enables
  afterward (only this path earns green)
- The Transcribe button still enables on video+model regardless of badge state (no new gating)
- All readiness strings render in Polish

**Implementation Note**: After completing this phase and all automated verification passes, pause
here for manual confirmation from the human that the manual testing was successful.

---

## Testing Strategy

### Unit / Regression Tests:

- The bespoke regression suite (`test/regression.js`) covers parser + exporters only; it must
  continue to pass unchanged (guard against accidental cross-module breakage). No new regression
  cases are warranted — this change touches the engine-readiness surface, not parser/exporter
  frame math.

### Integration Tests:

- End-to-end via the running app (`npm run tauri dev`): cold-cache launch → cheap probe → cache
  file written → warm-cache launch → no spawn → manual full re-verify → cache refreshed.

### Manual Testing Steps:

1. Rebuild the sidecar (`sidecar/build.sh`), then run `whisperx-engine --capability
   --align-model-dir …` and confirm fast valid JSON + no sockets (`lsof -nP -i`).
2. Launch the app cold (clear `engine-readiness/` cache): confirm the badge resolves quickly and a
   cache file appears.
3. Relaunch: confirm the badge paints with no sidecar spawn.
4. Click "Pełna weryfikacja silnika": confirm the heavy align runs and the badge/cache update.
5. Confirm Transcribe enablement is unchanged and all strings are Polish.

## Performance Considerations

- The capability probe drops the two confirmed-expensive steps (model load + real align),
  collapsing the reproduced ~65 s to a cheap device-detect + dir-check (dominated by torch import
  / onefile extraction). A cache hit skips the spawn entirely.
- The cache is best-effort and tiny (one small JSON per key); no measurable overhead.
- The bounded timeout caps worst-case latency on a misbehaving sidecar.

## Migration Notes

- No data migration. The new `engine-readiness` cache is created lazily; deleting it is safe (next
  launch re-probes). The cache key folds in the app version, so an app upgrade (new bundled
  sidecar) invalidates stale verdicts automatically.
- The sidecar `.py` change requires `sidecar/build.sh` to re-freeze the bundled binary; this is a
  build step, not a runtime migration.

## References

- Frame brief: `context/changes/s-18/frame.md`
- Research: `context/changes/s-18/research.md`
- Cheap-probe helpers: `sidecar/whisperx_engine/whisperx_engine.py:114-130,185-186,213-235,488,508-509`
- Rust readiness path: `src-tauri/src/engine.rs:42-65,69-100,104-129`
- Cache precedent: `src-tauri/src/project.rs:26-46`, `whisper.rs:201-208,399`, `waveform.rs:51-77`
- Badge: `src/ui/import/transcribe.js:73-77,85-113`
- Sidecar build / git-ignored binaries: CLAUDE.md "Things to know"; memory `whisperx-sidecar-build`

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Sidecar — cheap `--capability` subcommand

#### Automated

- [x] 1.1 Sidecar rebuilds cleanly (`sidecar/build.sh` produces `whisperx-engine-<arch>`)
- [x] 1.2 `--capability` returns valid JSON fast and exits 0 (sub-second, warm)
- [x] 1.3 `--selftest` still runs the full exercise unchanged

#### Manual

- [x] 1.4 Capability `device`/`gpu` matches the machine
- [x] 1.5 `alignment_model_ready` is `false` when `align_models/` is absent/empty
- [x] 1.6 No network sockets during `--capability` (`lsof -nP -i`)

### Phase 2: Rust — capability command, verdict cache, bounded timeout

#### Automated

- [ ] 2.1 `cargo check` passes
- [ ] 2.2 `cargo build` passes
- [ ] 2.3 Regression suite passes (`node --experimental-vm-modules test/regression.js`)

#### Manual

- [ ] 2.4 Cold cache: badge resolves via cheap probe; `engine-readiness/<hash>.json` appears
- [ ] 2.5 Warm cache: badge paints with no sidecar spawn
- [ ] 2.6 Deleting cache / changing align dir forces a fresh probe
- [ ] 2.7 A simulated hang trips the timeout → amber error, no hang

### Phase 3: Frontend — instant cached badge + manual re-verify

#### Automated

- [ ] 3.1 Prettier clean (`npx prettier --check "src/**/*.{js,css,html}"`)
- [ ] 3.2 Regression suite passes

#### Manual

- [ ] 3.3 Cold launch shows "Sprawdzanie silnika…" then the amber "✓ Silnik wykryty … — pełna weryfikacja zalecana" tier (not green); warm launch is effectively instant
- [ ] 3.4 "Pełna weryfikacja silnika" runs the real align, paints the authoritative green "✓ Silnik gotowy" (only path that earns green), re-enables button
- [ ] 3.5 Transcribe enablement unchanged (no new gating)
- [ ] 3.6 All readiness strings Polish
