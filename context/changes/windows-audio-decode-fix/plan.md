# Windows Audio Decode Fix — Implementation Plan

## Overview

The app's FFmpeg-resolution contract ends at the Rust process boundary. Every FFmpeg
invocation the *Rust* process makes is absolute and correct (`ffmpeg.rs::ffmpeg_bin_path`,
S-29 Phase 3). But the WhisperX engine child re-resolves `ffmpeg` **by bare name** from an
inherited `PATH` the app never provisions — so audio decode depends on an ambient system
ffmpeg on *every* platform. Windows is simply the first one with no ambient ffmpeg to mask it,
which is why a fully-provisioned Windows machine (green ZALEŻNOŚCI, engine self-test passing,
model downloaded) dies with `Błąd: Nie udało się zdekodować audio. Sprawdź plik źródłowy.`

We fix this at the contract level, in one chokepoint, with two complementary halves:

- a **Rust half** that provisions the child's FFmpeg (`REEL_FFMPEG_BIN` + a `PATH` shim) — this
  un-breaks engines **already staged on users' disks**, which is the only mechanism that can,
  because staging is presence-only and a staged engine is never auto-replaced;
- an **engine half** that decodes through an explicit absolute path instead of a bare-name
  lookup, and whose `--selftest` finally *decodes something*, so a green badge can no longer
  certify a machine that cannot transcribe.

## Current State Analysis

**The mechanism (frame: Confidence HIGH, evidence direct and on-disk).**

whisperx 3.8.6's `load_audio` (`sidecar/.venv/Lib/site-packages/whisperx/audio.py:41-63`) is a
plain `subprocess.run(["ffmpeg", "-nostdin", …], check=True)` with the comment *"Requires the
ffmpeg CLI to be installed."* There is **no injection point** — no env var, no path argument.
`where.exe ffmpeg` on the affected machine returns nothing. No engine spawn site sets `PATH` or
`current_dir` for the child (`engine.rs:147-162`, `proc.rs:41-56` — only `HF_TOKEN`,
`HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`, `PYTHONUTF8`, `PYTHONIOENCODING`). The lookup fails
deterministically, `_load_audio`'s `except` swallows it, and the engine exits 11 —
which `whisper.rs:302` maps verbatim to the observed Polish toast.

**`_load_audio` is the ONLY decode site — verified, not assumed.** whisperx calls `load_audio`
internally in four places (`asr.py:211`, `alignment.py:135`, `diarize.py:132`,
`transcribe.py:148`), but every one is guarded by `isinstance(audio, str)` / `not
torch.is_tensor(audio)`. The engine always passes an **ndarray**, so none of them fire. Fixing
`whisperx_engine.py:374` therefore closes all three entry points at once — `cmd_transcribe`
(`:487`), `cmd_transcribe_cohere` (`:626`), and `cmd_align_only` (`:733`).

**Both resolution paths are triple-suffixed, so `PATH` alone cannot work.** Staged:
`deps/ffmpeg/ffmpeg-<triple>.exe` (`deps.rs:591`). Dev fallback: `src-tauri/binaries/ffmpeg-
x86_64-pc-windows-msvc.exe`. Windows `CreateProcess` (which Python's `subprocess` uses with a
list argv and `shell=False`) appends only `.exe` to a bare name — never a triple. It will look
for `ffmpeg.exe` and find nothing. A bare-named binary must be **materialized**.

**The affected machine is a dev checkout, not a staged install** — there is no
`%APPDATA%/com.reelautomator.app/deps` root at all; resolution falls through to
`src-tauri/binaries/`, where FFmpeg sits *in the same directory as the engine exe* under a
triple-suffixed name. Both paths must be covered.

**A rebuilt engine will never reach an existing install on its own.** `dep_present`
(`deps.rs:601`) is pure file-existence: `staged.is_file()`. `deps_status` computes a `stale`
flag (`deps.rs:692`, `present && installed_version != spec_version`) and surfaces it, but
nothing blocks or replaces a stale binary — the old exe keeps running forever. The Windows
engines are large (CPU 464 MB, GPU 1.03 GB, gpu-full 3.3 GB) and pinned by embedded SHA-256
(`src/deps/deps-spec.json`). **This is why the Rust half is load-bearing, not a nicety.**

**The readiness check is structurally blind to this failure class.** `_selftest_align_runs`
(`whisperx_engine.py:266`) aligns against `np.zeros(8000)` — synthetic silence. It never
decodes a file and never invokes ffmpeg. `cmd_capability` does a dir-existence check.
`transcription_ready` / `variant_satisfied` (`engine.rs:297`) are pure file stats. A green badge
on a machine that cannot decode one frame of audio is not a bug in the badge — it is a gap in
what the badge is capable of asking.

## Desired End State

On a fully-provisioned Windows machine, **Transkrybuj wideo** completes: the engine decodes the
extracted WAV through an FFmpeg the app resolved and handed it, never through an ambient `PATH`
lookup. The same is true of **Dopasuj transkrypcję** (align-only). This holds on both the GPU
and CPU engine variants, on both the staged-deps and dev-checkout resolution paths, and for
engines already on disk *before* this change shipped.

`--selftest` decodes a real (synthetic) audio file through the exact code path a transcription
takes, and reports `audio_decode_ready`. A machine that cannot decode can no longer earn the
green "Silnik gotowy" badge.

**Verify:** on the affected Windows box, transcribe a real video end-to-end (GPU variant, then
`REEL_ENGINE_VARIANT=cpu`); run align-only on the same video; run a full engine verification and
observe `audio_decode_ready: true` in the badge.

### Key Discoveries:

- `sidecar/.venv/.../whisperx/audio.py:44` — `cmd = ["ffmpeg", …]`, bare name, no injection point.
- `whisperx_engine.py:374-382` — `_load_audio`, the single chokepoint; **two** exit-11 branches
  (missing file at `:375`, decode raise at `:380`).
- `asr.py:211` / `alignment.py:135` / `diarize.py:132` — all `isinstance(audio, str)`-guarded;
  the engine passes ndarray, so `_load_audio` really is the only decode site.
- `deps.rs:601` (`dep_present`) — presence is file-existence only; a staged engine is never
  auto-replaced. `deps.rs:692` — a `stale` flag already exists and is already surfaced.
- `engine.rs:147-162` — `with_hf_offline` / `with_utf8_io` are the established pattern for
  "apply this env at every engine spawn site." The new helper joins them.
- `engine.rs:381` (`parse_engine_status`) — **the documented trap**: `EngineStatus` is never
  serde-deserialized from the sidecar JSON (the `Deserialize` derive serves the disk cache
  alone). A new sidecar field is invisible to Rust until it is hand-mapped *here*.
- `engine.rs:329` (`cublas: Option<bool>`) — the established "absent ⇒ unknown, never failed"
  discipline. `audio_decode_ready` must follow it exactly, or an old engine's field-less verdict
  would read as a failure.
- `whisper.rs:732` (`spawn_engine`) — "one spawn recipe, used twice (the original run and the
  CPU retry) so the two can never drift in their env." The new env belongs inside it.

## What We're NOT Doing

- **Not verifying or releasing macOS in this slice.** The fix code is platform-neutral (no
  `#[cfg]` gates), so macOS's latent bundle bug closes as a side effect — but we do not build,
  test, or ship a macOS bundle here, and we do not claim macOS is fixed. See *Open Risks*.
- **Not rebuilding `gpu-full`** (3.3 GB, HuggingFace-hosted, env-only escape hatch, never
  auto-selected). The Rust half un-breaks it; it stays on its current engine build.
- **Not forcing convergence.** We do *not* make staging version-aware. Nobody is forced through
  a 0.5–1 GB re-download for a bug the Rust half already fixed for them.
- **Not changing the CLI contract with a new flag.** `--ffmpeg-bin` would make argparse exit 2
  (`"Nieprawidłowe wywołanie silnika WhisperX"`) on every already-staged engine. Env var only.
- **Not touching `waveform.rs` / `metadata.rs`.** They already resolve FFmpeg absolutely through
  `ffmpeg_bin_path` + `crate::proc`. Confirmed correct; manual-verify only, no code change.
- **Not chasing D1** (is the extracted WAV itself healthy). Unfalsified but not load-bearing —
  the ffmpeg lookup fails first and deterministically. Confirm opportunistically once decode works.

## Implementation Approach

One chokepoint, provisioned from both sides.

The Rust side gains **`engine::with_ffmpeg(app, &mut cmd)`**, a sibling of the existing
`with_hf_offline` / `with_utf8_io`, applied at **every** engine spawn site. It does two things:
sets `REEL_FFMPEG_BIN` to the absolute FFmpeg path (inert on today's engines — an unknown env
var is simply ignored, which is exactly why this is an env var and not a CLI flag), and
**prepends** a directory containing a bare-named `ffmpeg[.exe]` to the child's `PATH` (prepend,
not append, so our binary wins over any stray system ffmpeg).

That directory comes from **`ffmpeg::ffmpeg_shim_dir(app)`**. When the resolved FFmpeg is
*already* bare-named — the macOS bundle, where Tauri's `externalBin` strips the triple — its
parent dir is returned directly, with **no writes** (a signed `.app` bundle must not be mutated).
Otherwise the triple-suffixed binary is **hardlinked** to `<ffmpeg_dir>/bin/ffmpeg[.exe]`. The
shim sits next to its target by construction, so the hardlink is always same-volume and always
free; a copy is the fallback if the link fails (read-only dir, exotic filesystem).

The engine side then makes the ambient `PATH` irrelevant for anyone running a rebuilt engine:
`_load_audio` reads `REEL_FFMPEG_BIN` and runs the decode subprocess against that absolute path,
falling back to `whisperx.load_audio` when the env var is unset (so a bare `python
whisperx_engine.py --audio x.mp4` dev invocation still behaves as it does today).

Finally `--selftest` earns its badge: it writes ~0.5 s of synthetic audio to a temp WAV and pushes
it through **the same decode helper** a transcription uses, reporting `audio_decode_ready`. That is
the only check in the system that can actually fail when decode is broken — but only if the decode
is split from the **exit**. Today `_load_audio` ends both failure branches in
`sys.exit(EXIT_AUDIO_DECODE_FAIL)`, and `SystemExit` is a `BaseException` that no `except Exception`
will catch: a self-test calling `_load_audio` on a broken machine would kill the process with exit
11 instead of reporting `false`, and `whisperx_engine_check` (`engine.rs:473`) maps any non-zero
exit to a generic engine error. So the decode moves into a **raising** `_decode_audio`, and
`_load_audio` becomes the thin exit wrapper around it — one decode path, two failure contracts.

## Critical Implementation Details

**Absent ⇒ unknown, never failed.** An engine staged before this change emits no
`audio_decode_ready` field. Rust must model it as `Option<bool>` and the badge must treat `None`
/ `undefined` as "unknown" — only an explicit `false` may block the green tier. This is the exact
discipline `cublas` already follows (`engine.rs:329`), and getting it backwards would paint every
existing install red overnight.

**The `parse_engine_status` trap.** `EngineStatus`'s `Deserialize` derive serves the *disk cache*
only; the sidecar's JSON is hand-mapped field by field (`engine.rs:381`). A new field added to
the struct but not read out there stays `None` on every live probe, forever, silently.

**`SystemExit` is not an `Exception`.** `_load_audio` exits via `sys.exit()`; a self-test that
calls it and catches `except Exception` will not catch the resulting `SystemExit` and will kill the
probe with exit 11 — on precisely the machine it exists to diagnose. The decode therefore lives in
a raising `_decode_audio`, and `_load_audio` is the exit wrapper. A self-test that cannot report
`false` is the same class of blind check this phase exists to abolish.

**Shim idempotency — cheap, but identity-aware.** `with_ffmpeg` runs on every spawn, including the
CPU-retry spawn inside a single transcription, so materializing the shim must be a no-op in the
steady state — otherwise a 143 MB copy fallback could fire twice inside one run. But "no-op if the
file exists" is *too* cheap: `swap_in_place` re-stages FFmpeg by rename (new inode), so an
existence-only check would pin the shim to a stale binary forever. Compare identity, not presence.

## Phase 1: Rust provisions the child's FFmpeg

### Overview

Ships the fix. Independently deployable — this phase alone un-breaks the affected machine and
every already-staged engine in the field, with no sidecar rebuild and no re-download.

### Changes Required:

#### 1. FFmpeg shim resolution

**File**: `src-tauri/src/ffmpeg.rs`

**Intent**: Produce a directory that contains a **bare-named** `ffmpeg[.exe]`, suitable for
prepending to a child's `PATH`. This is what makes whisperx's `subprocess.run(["ffmpeg", …])`
resolvable, since neither the staged nor the dev FFmpeg is bare-named and Windows
`CreateProcess` only ever appends `.exe`.

**Contract**: `pub fn ffmpeg_shim_dir(app: &AppHandle) -> Result<PathBuf, String>`. Resolves the
real binary via the existing `ffmpeg_bin_path(app)`, then:
- if its file name is already exactly `ffmpeg` / `ffmpeg.exe` → return its parent, performing no
  filesystem writes (macOS bundle case — the `.app` is code-signed and must not be mutated);
- else → ensure `<ffmpeg_dir>/bin/` exists and holds `ffmpeg[.exe]`, created by
  `std::fs::hard_link` with a `std::fs::copy` fallback; return that `bin/` dir.
Errors propagate as the existing Polish-message `Err(String)`.

**Idempotency must be identity-aware, not existence-aware.** The obvious "if the shim file exists,
return immediately" goes stale the first time FFmpeg is re-staged: `ffmpeg-windows-x86_64` is a
*versioned, updatable* dep (`deps-spec.json`), and `download_dependency` stages through
`swap_in_place` (`deps.rs:1121-1140`) — `rename(final → .bak); rename(part → final)` — which
installs a **new inode**. A hardlink made before that rename still points at the old one. Never
refreshing it means the engine child would decode with the *old* FFmpeg forever while every
Rust-side call uses the new one — silently, with no error anywhere — and the orphaned inode (our
link being its last reference, since `.bak` is dropped) would leak ~143 MB that never comes back.
A dev checkout re-running `sidecar/fetch-ffmpeg.sh` hits the same trap.

So: treat the shim as valid only when it still **resolves to the same file** as the target;
otherwise `remove_file` + re-link. Cheapest correct check on Windows is the file identity pair
`(volume_serial_number, file_index)` from `std::os::windows::fs::MetadataExt`; a portable
`(len, modified)` compare is an acceptable fallback (and is the only option on the copy path).
Either way the steady-state cost stays one `metadata()` call per spawn — no re-link, no re-copy.

The bare-name check is the one piece worth pinning down, because the whole macOS no-write
property rests on it:

```rust
let bare = format!("ffmpeg{}", if cfg!(windows) { ".exe" } else { "" });
if bin.file_name().and_then(|n| n.to_str()) == Some(bare.as_str()) { /* parent, no writes */ }
```

#### 2. The spawn-env helper

**File**: `src-tauri/src/engine.rs`

**Intent**: One place that provisions an engine child's FFmpeg, joining `with_hf_offline` and
`with_utf8_io` as the third member of the "apply at every engine spawn site" family.

**Contract**: `pub fn with_ffmpeg(app: &AppHandle, cmd: &mut tokio::process::Command)`. Sets
`REEL_FFMPEG_BIN` to the absolute path from `ffmpeg_bin_path(app)`, and sets `PATH` to
`<ffmpeg_shim_dir>` **prepended** to the inherited `std::env::var_os("PATH")` (joined with
`std::env::join_paths`, so the platform separator is never hand-rolled). Best-effort **by design**:
if the shim cannot be materialized, still set `REEL_FFMPEG_BIN` and leave `PATH` untouched rather
than clobbering it. That degradation is benign — a Phase-2 engine decodes from `REEL_FFMPEG_BIN`
and never consults `PATH` — so it must not be promoted into a hard error (see §3).

Applied at **all** engine spawn sites: `engine::run_engine` (covers `whisperx_engine_check`,
`whisperx_engine_capability`, `verify_staged_engine`) and both `whisper.rs` sites below.

#### 3. Transcribe + align spawn sites, and the decode toast

**File**: `src-tauri/src/whisper.rs`

**Intent**: Provision FFmpeg on the two decode-carrying spawns, and make the exit-11 toast name the
thing that actually broke.

**Contract**:
- `transcribe_video`'s `spawn_engine` closure (`:732`) — add `crate::engine::with_ffmpeg(&app,
  &mut cmd)` beside the existing `with_utf8_io`. Because it lives inside the shared closure, the
  original run and the CPU retry cannot drift.
- `align_transcript`'s command build (`:1186`) — same call, alongside its `with_utf8_io`.
- **The exit-11 message** (`:302`) — extend the Polish decode error to name FFmpeg as the likely
  cause and point at ZALEŻNOŚCI. This is the toast the user actually sees, and it is the only
  user-facing lever that helps here.

**No pre-flight, deliberately.** An earlier draft guarded both spawns with an `ffmpeg_shim_dir`
call that hard-errored on `Err`. It earns nothing and costs something:
- Its stated case is unreachable. Both commands already extract the WAV through the *Rust* FFmpeg
  before ever spawning the engine (`run_ffmpeg_output` → `ffmpeg_bin_path?`, `whisper.rs:650` and
  `:1138`). If FFmpeg is unresolvable, extraction has already failed with
  "FFmpeg niedostępny dla…" — the pre-flight would be dead code behind it.
- The one case it *could* catch — shim materialization failing on a read-only dir — is one
  `with_ffmpeg` deliberately treats as non-fatal, and rightly so: a Phase-2 engine decodes from
  `REEL_FFMPEG_BIN` and never touches the shim. Hard-failing there would block the population that
  needs the shim least.
- And it cannot prevent exit 11 anyway: that comes from the engine's own decode, which no
  Rust-side stat can predict.

#### 4. Unit tests

**File**: `src-tauri/src/ffmpeg.rs` (`#[cfg(test)] mod tests`)

**Intent**: Lock the two decisions that are easy to get silently wrong.

**Contract**: (a) the bare-name detector returns "no shim needed" for `ffmpeg.exe` / `ffmpeg` and
"shim needed" for `ffmpeg-x86_64-pc-windows-msvc.exe`; (b) a PATH built from a shim dir plus an
existing PATH puts the shim dir **first**; (c) **the stale-shim case** — materialize a shim against
a target, then replace the target by rename (exactly what `swap_in_place` does), and assert the next
call re-links so the shim resolves to the *new* file, not the old one. Test (c) is the regression
guard for the whole class; write it against a `tempdir`, mirroring `deps.rs`'s own
`swap_in_place` test (`deps.rs:1805`). Factor the pure decisions out of the `AppHandle`-taking
functions so they are testable without a Tauri app, mirroring how `pick_variant`
(`engine.rs:71`) injects its `present` closure for exactly this reason.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Rust unit tests pass: `~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml`
- Regression suite still green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- On the affected Windows machine (dev checkout, GPU engine): **Transkrybuj wideo** on a real
  video completes and produces a transcript — the original bug is dead.
- The same video transcribes with `REEL_ENGINE_VARIANT=cpu` (the failure was variant-independent;
  the fix must be too).
- Align-only (**Dopasuj transkrypcję**) completes on the same video — the second decode entry
  point, never previously exercised on this machine.
- The waveform UI (clip-trim) still renders — confirms `waveform.rs`'s absolute-path spawn was
  never affected (roadmap S-31 unknown #3).
- A shim is materialized at `src-tauri/binaries/bin/ffmpeg.exe` and is a hardlink (same size,
  no 143 MB of extra disk consumed).
- Opportunistic (frame D1): the extracted `%TEMP%\reel_audio_*.wav` is a healthy, non-zero-byte
  16 kHz mono WAV.

**Implementation Note**: After this phase and its automated verification, pause for manual
confirmation before proceeding — Phase 1 is the shippable fix and everything after it is
hardening.

---

## Phase 2: Engine takes an explicit FFmpeg + a truthful decode self-test

### Overview

Removes the ambient-`PATH` dependence from the engine itself, and closes the frame's corollary 2:
make the readiness check capable of failing when decode is broken. Sidecar source changes — they
reach users only once Phase 3 ships them.

### Changes Required:

#### 1. Explicit-FFmpeg decode

**File**: `sidecar/whisperx_engine/whisperx_engine.py`

**Intent**: Decode through the absolute FFmpeg the app handed us, instead of a bare-name `PATH`
lookup. One function; all three entry points inherit it.

**Contract**: split the decode from the exit — two functions, not one.

- **`_decode_audio(whisperx, audio_path) -> np.ndarray`** (new): when `REEL_FFMPEG_BIN` is set and
  names an existing file, decode via that binary; otherwise fall back to `whisperx.load_audio`
  (unchanged dev-CLI behavior). It **raises** on failure — no `sys.exit`, no swallowing. This is
  the shared decode path, reusable by a self-test that must *report* failure rather than die of it.
- **`_load_audio(whisperx, audio_path)`** keeps its exact signature, its two exit-11 branches, and
  its `sys.exit(EXIT_AUDIO_DECODE_FAIL)` behavior — it becomes a thin wrapper: the missing-file
  check, then `try: return _decode_audio(...) except Exception: _log(...); sys.exit(EXIT_AUDIO_DECODE_FAIL)`.
  All three entry points (`cmd_transcribe`, `cmd_transcribe_cohere`, `cmd_align_only`) keep calling
  it and are unaffected.

Why the split is not optional: `sys.exit` raises `SystemExit`, which derives from `BaseException`,
**not** `Exception`. A `_selftest_decode_runs` that called `_load_audio` and caught `except
Exception` (as `_selftest_align_runs` does) would not catch it — the self-test process would exit
11 on exactly the broken machine it exists to detect, `whisperx_engine_check` (`engine.rs:473`)
would turn that into a generic "self-test z błędem (kod 11)" error, and `audio_decode_ready: false`
would never be emitted at all.

The decode must reproduce whisperx 3.8.6's `load_audio` **exactly** — same argv, same dtype math —
or every downstream timestamp shifts. This is the one snippet the implementer should not re-derive:

```python
cmd = [ffmpeg_bin, "-nostdin", "-threads", "0", "-i", audio_path,
       "-f", "s16le", "-ac", "1", "-acodec", "pcm_s16le", "-ar", "16000", "-"]
out = subprocess.run(cmd, capture_output=True, check=True).stdout
return np.frombuffer(out, np.int16).flatten().astype(np.float32) / 32768.0
```

On Windows, pass `creationflags=subprocess.CREATE_NO_WINDOW` so the decode does not flash a
console — `crate::proc::build_command` already does this for every Rust-side spawn
(`proc.rs:47-52`), and this child is spawned by Python, outside that guarantee.

#### 2. A self-test that actually decodes

**File**: `sidecar/whisperx_engine/whisperx_engine.py`

**Intent**: Give the readiness probe the one capability it structurally lacks — decoding a real
file through the real path. Until this exists, a green badge cannot mean "can transcribe."

**Contract**: a `_selftest_decode_runs()` helper writes ~0.5 s of 16 kHz mono silence to a temp
WAV via the stdlib `wave` module (no ffmpeg needed to *create* it), pushes it through
**`_decode_audio`** — the raising helper from §1, **never `_load_audio`** — and returns a bool,
swallowing any exception rather than exiting, exactly as `_selftest_align_runs` (`:266`) does.
Calling `_load_audio` here would exit the process with code 11 instead of returning `False` (see
§1). Clean up the temp WAV on both paths. `cmd_selftest` (`:305`) adds
`audio_decode_ready` to its JSON. 
`cmd_capability` (`:336`) **does not** — it omits the field entirely, so Rust reads `None`
("unknown"). This mirrors how `cublas` is scoped today (capability-only, absent from `--selftest`
⇒ `None`), and it keeps capability at its documented cheap, non-authoritative tier: no spawn, no
decode. A file-existence check on `REEL_FFMPEG_BIN` was considered and **rejected** — it is
near-tautological (Rust sets that var from `ffmpeg_bin_path`, which only ever returns a path it has
already `is_file()`-verified), its one real signal ("Rust could not resolve FFmpeg") is already
carried by `variant_satisfied` (`engine.rs:303`) and the ZALEŻNOŚCI panel, and a capability verdict
is stamped `authoritative: false` (`engine.rs:529`/`:564`) so it paints amber and could never reach
the green tier this field exists to guard. The real decode in `--selftest` is the whole value here.

#### 3. Rust reads the new field

**File**: `src-tauri/src/engine.rs`

**Intent**: Surface `audio_decode_ready` without breaking any verdict already cached on disk.

**Contract**: `EngineStatus` gains `#[serde(default)] pub audio_decode_ready: Option<bool>`, and
`parse_engine_status` (`:381`) **hand-maps it** (`v["audio_decode_ready"].as_bool()`) — the
derive alone will not do it, per the module's own warning. `Option<bool>` is deliberate and
mirrors `cublas`: an engine staged before this change emits no such field, and `None` must mean
*unknown*, never *failed*.

#### 4. The badge stops lying

**File**: `src/ui/import/transcribe.js`

**Intent**: A machine that cannot decode audio must not be able to earn the green "Silnik gotowy"
tier — that badge is precisely what certified the machine in this bug report.

**Contract**: `renderEngineBadge` (`:279`) paints the authoritative green tier only when
`status.audio_decode_ready !== false`. An explicit `false` paints a distinct red/amber state
naming the decode failure in Polish. `undefined` (an older engine) keeps today's behavior
untouched. Update the JSDoc `@param` status shape at `:272` to carry the new field.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Rust unit tests pass: `~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml` — including
  a new `parse_engine_status` case proving `audio_decode_ready` is hand-mapped, and a cached-verdict
  case proving a field-less legacy JSON still deserializes to `None`
- Engine self-test runs from source and reports the new field:
  `sidecar/.venv/Scripts/python sidecar/whisperx_engine/whisperx_engine.py --selftest`
- Regression suite still green: `node --experimental-vm-modules test/regression.js`

#### Manual Verification:

- From source, with `REEL_FFMPEG_BIN` pointing at the repo FFmpeg: `--selftest` reports
  `audio_decode_ready: true`.
- With `REEL_FFMPEG_BIN` unset **and** no ffmpeg on `PATH`: `--selftest` reports
  `audio_decode_ready: false` — i.e. the check can actually fail, which is the entire point.
- With that `false` verdict, the ZALEŻNOŚCI badge refuses the green tier and names the decode
  problem in Polish.
- An engine verification against the **old** staged binary (no such field) still paints exactly
  as it does today — `undefined` is not treated as failure.

**Implementation Note**: Pause for manual confirmation before Phase 3 — Phase 3 is a release
operation and is expensive to unwind.

---

## Phase 3: Rebuild, re-pin, release (Windows CPU + GPU)

### Overview

Get the Phase 2 engine into users' hands as an **opt-in** update, using the `stale` machinery that
already exists. Nobody is forced through a re-download for a bug Phase 1 already fixed for them.

### Changes Required:

#### 1. Rebuild the two shipping Windows engines

**File**: `sidecar/build.sh` (invocation only — no source change expected)

**Intent**: Freeze the Phase 2 engine into the CPU (464 MB) and GPU (1.03 GB) Windows binaries.
`gpu-full` (3.3 GB, env-only, never auto-selected) is deliberately **not** rebuilt.

**Contract**: The rebuilt binaries keep their existing names and their `--capability` / `--selftest`
JSON contract, now additively carrying `audio_decode_ready`. The GPU build must still report
`cublas: true` (the `rthook_cublas.py` preload is untouched by this change) — a regression there
would trip `should_demote_engine` (`engine.rs:92`) and silently demote every GPU machine.

#### 2. Upload and re-pin

**File**: `src/deps/deps-spec.json`

**Intent**: Point the spec at the new artifacts and mark the old ones stale, so ZALEŻNOŚCI offers
the update instead of forcing it.

**Contract**: For `engine-cpu-windows-x86_64` and `engine-gpu-windows-x86_64`: new release-tag
`url`, recomputed `sha256` (`Get-FileHash -Algorithm SHA256`), corrected `sizeBytes`, and a bumped
`version`. The version bump is what lights `stale` (`deps.rs:692` — `present && installed !=
spec`). An empty `sha256` fail-closes the downloader, so the hash must land in the same edit as
the URL. `engine-gpu-full-windows-x86_64` is left **untouched**.

#### 3. Roadmap correction

**File**: `context/foundation/roadmap.md` (§ S-31)

**Intent**: The frame explicitly asks for this. The Diagnosis asserts WAV extraction *"succeeds"*
as established fact; it was never verified, and exit 11 has a second branch
(`whisperx_engine.py:375`) that would look identical. Soften it to an inference, and record that
the reframe made this a platform-independent defect rather than a Windows bug.

**Contract**: Prose edit to the S-31 entry; mark status `done` once Phase 3 lands.

### Success Criteria:

#### Automated Verification:

- Rust type-check passes: `~/.cargo/bin/cargo check --manifest-path src-tauri/Cargo.toml`
- Rust unit tests pass: `~/.cargo/bin/cargo test --manifest-path src-tauri/Cargo.toml` — the
  embedded-spec parse test (`deps.rs`) must still pass against the edited JSON
- Every pinned `sha256` in `deps-spec.json` matches the uploaded artifact byte-for-byte
  (recompute and compare after upload; a mismatch fail-closes the downloader at install time)

#### Manual Verification:

- With an old engine staged, ZALEŻNOŚCI shows the engine as **stale** and offers an update; the
  app still transcribes *before* taking it (Phase 1's shim carrying the old binary).
- Taking the update re-downloads and stages the new engine; the SHA-256 check passes.
- A full engine verification on the new binary reports `audio_decode_ready: true`, and the GPU
  build still reports `cublas: true` (no accidental demotion).
- Transcription works on the freshly-staged engine, GPU and CPU variants.
- A clean-machine install (empty deps root) downloads the new engine and transcribes end-to-end.

---

## Testing Strategy

### Unit Tests:

- `ffmpeg.rs` — bare-named vs triple-suffixed shim decision; PATH prepend ordering (shim dir first);
  stale-shim re-link after the target is replaced by rename (the `swap_in_place` re-stage path).
- `engine.rs` — `parse_engine_status` hand-maps `audio_decode_ready`; a legacy cached verdict with
  no such field deserializes to `None` (not `Some(false)`).

### Integration Tests:

The decode path cannot be unit-tested from Rust (it lives in a frozen Python child), so its
coverage is the engine's own `--selftest`, which is now an end-to-end decode assertion by
construction. Run it in both states — `REEL_FFMPEG_BIN` set and unset with a clean `PATH` — and
require it to report `true` and `false` respectively. A check that cannot fail is not a check.

### Manual Testing Steps:

1. On the affected Windows box, transcribe a real video (GPU variant). Expect a transcript, not
   the decode toast.
2. Re-run with `REEL_ENGINE_VARIANT=cpu`. Expect the same.
3. Run align-only on the same video — the second decode entry point.
4. Open the clip-trim waveform — confirms `waveform.rs` was never affected.
5. Inspect `src-tauri/binaries/bin/ffmpeg.exe`: exists, hardlink, no disk bloat.
6. Full engine verification → `audio_decode_ready: true`.
7. Break it on purpose: clear `REEL_FFMPEG_BIN`, ensure no ffmpeg on `PATH`, run `--selftest` from
   source → must report `false`.

## Performance Considerations

`with_ffmpeg` runs on every engine spawn, including the CPU-retry inside a single transcription.
On the shimmed path it is a single `is_file()` stat once the hardlink exists — well inside the
spawn-free budget the readiness path already holds itself to (`engine.rs:105-115`). The one
cliff to avoid: a non-idempotent implementation that re-copies 143 MB on the retry spawn. On the
macOS-bundle path there are no writes at all.

The engine's decode subprocess replaces whisperx's — same argv, same work. No change.
`--selftest` grows by one sub-second decode of 0.5 s of silence.

## Migration Notes

**Existing Windows installs keep working without downloading anything.** Phase 1's shim provisions
the *old* staged engine's `PATH`, and its bare-name lookup then resolves. This is the whole reason
the Rust half exists: `dep_present` (`deps.rs:601`) is presence-only, so a rebuilt engine would
otherwise never reach these machines at all.

**Phase 3 is opt-in.** The `version` bump lights the existing `stale` flag; users may take the
update or ignore it. Two engine populations will coexist indefinitely — old engines carried by the
shim, new engines carrying the explicit contract. Both work. The `Option<bool>` modeling of
`audio_decode_ready` is what keeps the old population from reading as broken.

**Cached readiness verdicts survive.** `#[serde(default)]` on the new field keeps every
`engine-readiness/*.json` already on disk deserializable (`engine.rs:644` already tests exactly
this for the Phase-4 fields).

## References

- Frame brief: `context/changes/windows-audio-decode-fix/frame.md`
- Roadmap slice: `context/foundation/roadmap.md` § S-31
- The convention this violates: `src-tauri/src/ffmpeg.rs:11` (`ffmpeg_bin_path`), S-29 Phase 3
- The spawn-env pattern to follow: `src-tauri/src/engine.rs:147-162`
- The hand-map trap: `src-tauri/src/engine.rs:381` (`parse_engine_status`)
- The `Option<bool>` precedent: `src-tauri/src/engine.rs:329` (`cublas`)

## Progress

> Convention: `- [ ]` pending, `- [x]` done. Append ` — <commit sha>` when a step lands. Do not rename step titles. See `references/progress-format.md`.

### Phase 1: Rust provisions the child's FFmpeg

#### Automated

- [x] 1.1 Rust type-check passes: `cargo check` — d6b4748
- [x] 1.2 Rust unit tests pass: `cargo test` (shim decision + PATH prepend ordering + stale-shim re-link) — d6b4748
- [x] 1.3 Regression suite still green: `node --experimental-vm-modules test/regression.js` — d6b4748

#### Manual

- [x] 1.4 Transkrybuj wideo completes on the affected Windows machine (GPU variant) — d6b4748
- [x] 1.5 Same video transcribes with `REEL_ENGINE_VARIANT=cpu` — d6b4748
- [x] 1.6 Align-only (Dopasuj transkrypcję) completes on the same video — d6b4748
- [x] 1.7 Waveform UI still renders (waveform.rs unaffected — S-31 unknown #3) — d6b4748
- [x] 1.8 Shim exists at `binaries/bin/ffmpeg.exe`, is a hardlink, no disk bloat — d6b4748
- [x] 1.9 Opportunistic (frame D1): extracted `%TEMP%` WAV is healthy and non-zero — d6b4748

### Phase 2: Engine takes an explicit FFmpeg + a truthful decode self-test

#### Automated

- [x] 2.1 Rust type-check passes: `cargo check` — 64fdd6b
- [x] 2.2 Rust unit tests pass: `cargo test` (`audio_decode_ready` hand-mapped; legacy verdict → `None`) — 64fdd6b
- [x] 2.3 Engine `--selftest` runs from source and reports `audio_decode_ready` — 64fdd6b
- [x] 2.4 Regression suite still green: `node --experimental-vm-modules test/regression.js` — 64fdd6b

#### Manual

- [x] 2.5 `--selftest` with `REEL_FFMPEG_BIN` set reports `audio_decode_ready: true` — 64fdd6b
- [x] 2.6 `--selftest` with no `REEL_FFMPEG_BIN` and no PATH ffmpeg reports `false` (the check can fail) — 64fdd6b
- [x] 2.7 A `false` verdict blocks the green badge and names the decode problem in Polish — 64fdd6b
- [x] 2.8 An old staged engine (no such field) paints exactly as today — `undefined` ≠ failure — 64fdd6b

### Phase 3: Rebuild, re-pin, release (Windows CPU + GPU)

#### Automated

- [x] 3.1 Rust type-check passes: `cargo check` — 9cf75de
- [x] 3.2 Rust unit tests pass: `cargo test` (embedded-spec parse test against the edited JSON) — 9cf75de
- [x] 3.3 Every pinned `sha256` matches its uploaded artifact byte-for-byte — 9cf75de

#### Manual

- [x] 3.4 Old engine shows as stale, offers an update, and still transcribes before taking it — 9cf75de
- [x] 3.5 Taking the update re-downloads + stages the new engine; SHA-256 check passes — 9cf75de
- [x] 3.6 New binary reports `audio_decode_ready: true`, and the GPU build still reports `cublas: true` — 9cf75de
- [x] 3.7 Transcription works on the freshly-staged engine (GPU and CPU) — 9cf75de
- [x] 3.8 Clean-machine install (empty deps root) downloads and transcribes end-to-end — 9cf75de
- [x] 3.9 Roadmap § S-31 Diagnosis softened; status marked done — 9cf75de
