# Frame Brief: Windows audio decode dead-end

> Framing step before /10x-plan. This document captures what is *actually*
> at issue, separated from what was initially assumed.

## Reported Observation

On a fully-provisioned Windows PC (ZALEŻNOŚCI green, engine self-test passing
— "Silnik gotowy (transkrypcja: cuda · dopasowanie: cpu)", model downloaded),
pressing **Transkrybuj wideo** fails with the red Polish toast:

> `Błąd: Nie udało się zdekodować audio. Sprawdź plik źródłowy.`

The failure reproduces identically on **both** the GPU and the CPU engine
variant. The user has seen **only the toast** — no log, no exit code, no engine
stderr was captured.

## Initial Framing (preserved)

- **User's stated cause or approach** (roadmap S-31, written pre-planning): the
  engine exits 11 (`EXIT_AUDIO_DECODE_FAIL`) because `whisperx.load_audio`
  shells out to a **bare `ffmpeg` resolved from `PATH`**, and on Windows the
  thin installer stages FFmpeg as a triple-suffixed `deps/ffmpeg/ffmpeg-<triple>.exe`
  that is never on `PATH`. The roadmap asserts as *established* that WAV
  extraction (step 1) succeeds.
- **User's proposed direction**: make the engine's ffmpeg resolvable —
  (a) inject `PATH` for the child, (b) pre-decode in Rust and hand the engine an
  array, or (c) patch the sidecar to honor an explicit `--ffmpeg-bin`.
- **Pre-dispatch narrowing**: evidence is the **toast only** ("I inferred the
  chain from reading the code, not from a captured failing run"); only
  *Transkrybuj wideo* has been exercised (waveform and align untested on this
  machine); and the leading concern is **the whole ffmpeg-resolution contract** —
  every place anything shells out to ffmpeg, Rust and Python, Windows and macOS.

## Dimension Map

The observation could originate at any of these dimensions:

1. **Engine cannot see the WAV at all** — `_load_audio` exits 11 from a *second*
   branch: `if not os.path.isfile(audio_path)` (`whisperx_engine.py:375-377`).
   A temp-path, permission, or 0-byte-WAV problem lands here with FFmpeg still
   exiting 0. The roadmap's chain collapses this branch into non-existence.
2. **`whisperx.load_audio` shells out to a bare `ffmpeg` not on `PATH`** ←
   initial framing.
3. **`load_audio` raises for a non-ffmpeg reason** — the pinned whisperx might
   decode via torchaudio/pyav, or a frozen-PyInstaller DLL/import failure might
   fire inside the decode path. Same exit code, entirely different fix.
4. **Exit 11 is not actually what happened** — a fallback/default arm, a crash
   without an exit code, or a frontend hardcode could produce that same string
   without the engine ever returning 11.
5. **macOS "works by accident via Homebrew" is itself unverified** — a
   Finder-launched `.app` inherits a minimal `PATH` with no `/opt/homebrew/bin`,
   so if D2 were true, *bundled macOS should fail identically*. If it doesn't,
   D2 is wrong.

## Hypothesis Investigation

| Hypothesis | Evidence | Verdict |
| --- | --- | --- |
| **D2: bare `ffmpeg` from `PATH`** (initial framing) | whisperx **3.8.6** (`sidecar/.venv/Lib/site-packages/whisperx-3.8.6.dist-info`) — `audio.py:41-63`: `cmd = ["ffmpeg", "-nostdin", …]; subprocess.run(cmd, capture_output=True, check=True)`, comment: *"Requires the ffmpeg CLI to be installed."* No env var / arg injection point exists. `where.exe ffmpeg` on this machine → **not found**. No spawn site sets `PATH` or `current_dir` for the child (only `HF_TOKEN`, `HF_HUB_OFFLINE`, `TRANSFORMERS_OFFLINE`, `PYTHONUTF8`, `PYTHONIOENCODING` — `engine.rs:148-161`, `whisper.rs:741`). Staged name is triple-suffixed (`deps.rs:591`), and the dev fallback is too (`src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe`). | **STRONG** |
| **D3: non-ffmpeg decode failure** | Killed outright — the pinned 3.8.6 `load_audio` is a plain `subprocess.run(["ffmpeg", …])`. No torchaudio/pyav/soundfile path exists in it. | **NONE** |
| **D4: exit 11 is not what happened** | `engine_error_message` (`whisper.rs:299-312`) maps `Some(11)` to exactly the observed string; its default arm emits a *different* message (`"Silnik WhisperX zakończył się błędem. Szczegóły: …"`). A spawn failure or missing-DLL death cannot reach the observed text. Exit 11 is confirmed **by construction**, despite no log being read. | **NONE** |
| **D1: engine cannot see the WAV** | Cannot be excluded from the exit code alone (both branches exit 11), and no leftover `reel_audio_*.wav` survives in `%TEMP%` to inspect (Rust unlinks on failure). **But it is moot**: even a perfect WAV cannot be decoded, because the `ffmpeg` lookup fails first and deterministically. | **MOOT** (unfalsified, but not load-bearing) |
| **D5: macOS is safe** | **CONTRADICTED — this is the reframe.** POSIX `execvp` searches `PATH` only — never the caller's exe directory. macOS `externalBin` (`tauri.conf.json:39`) places a plain `ffmpeg` beside the engine in `Contents/MacOS/`, but the child will never look there. A Finder/Dock-launched `.app` gets a minimal `PATH` (`/usr/bin:/bin:/usr/sbin:/sbin`) with no Homebrew. macOS therefore only "works" under terminal-launched `npm run tauri dev`, which inherits the developer's shell `PATH`. | **STRONG (breaks the "Windows-only" premise)** |

## Narrowing Signals

- **The evidence was never captured.** The user has only ever seen the toast —
  the roadmap's confident 5-step chain is code-reading, not observation. It
  happens to be right on the mechanism, but D4's independent check (not the
  user's log) is what actually established exit 11.
- **`_load_audio` exits 11 from two branches, not one** (`whisperx_engine.py:375`
  and `:382`). The roadmap's "step 1 succeeds — a failure would have raised a
  different message" is an unproven inference. It survives only because the
  ffmpeg lookup fails regardless of whether the WAV is fine.
- **This machine is running the dev checkout, not a staged install.** There is no
  `%APPDATA%/com.reelautomator.app/deps` root at all; resolution falls through to
  `src-tauri/binaries/`. FFmpeg is sitting **in the same directory as the engine
  exe** — under a triple-suffixed name. Both resolution paths (staged + dev) are
  triple-suffixed, so neither yields a bare `ffmpeg`.
- **The self-test is structurally blind to this.** `_selftest_align_runs`
  (`whisperx_engine.py:286`) aligns against `np.zeros(8000)` — synthetic
  silence. It never decodes a file, never invokes ffmpeg. `transcription_ready` /
  `variant_satisfied` (`engine.rs:303`, `deps.rs:1073`) only check *file
  presence*. A green badge on a machine that cannot decode one frame of audio is
  not a bug in the badge — it is a gap in what the badge is capable of asking.
- **`_load_audio` is called from three entry points** (`whisperx_engine.py:487`,
  `:626`, `:733`) — transcribe *and* align. Any fix that covers only `transcribe`
  leaves `align_transcript` broken.

## Cross-System Convention

The codebase **already established the right convention** and this one call site
never got it. S-29 Phase 3 moved every sidecar spawn off `tauri-plugin-shell`
onto absolute-path resolution through `crate::proc`: `ffmpeg_bin_path()`
(`ffmpeg.rs:11`, staged → bundle → repo `binaries/`) backs `whisper.rs:650`,
`waveform.rs:130`, and `metadata.rs:23`. Every FFmpeg invocation the *Rust*
process makes is absolute and correct.

The contract simply **stops at the process boundary**. The WhisperX child
re-resolves FFmpeg from scratch, by bare name, out of an environment the app
never provisions. The leading hypothesis matches the convention exactly: this is
the one place that violates a rule the project already follows everywhere else.

## Reframed (or Confirmed) Problem Statement

> **The actual problem to plan around is**: the app's FFmpeg-resolution contract
> ends at the Rust boundary — the WhisperX sidecar child re-resolves `ffmpeg` by
> bare name from an inherited `PATH` the app never provisions, so audio decode
> depends on an ambient system ffmpeg on **every** platform. Windows is simply the
> first one with no ambient ffmpeg to mask it.

The mechanism in the initial framing was **correct**, and the fix directions
listed are the right ones. What was wrong is the **scope**: this is not a Windows
bug. It is a latent, platform-independent defect that macOS has been hiding
behind a terminal-launched `tauri dev` inheriting Homebrew's `PATH`. A bundled,
Finder-launched macOS `.app` almost certainly fails the same way today — and
nobody has noticed, because macOS has only ever been exercised in dev.

If addressed as scoped ("Windows audio decode fix"), the change ships a
`PATH`-shaped patch on the Windows spawn sites, macOS keeps working in dev, and
the macOS bundle stays broken with nobody the wiser. If addressed as reframed,
the same fix is applied once, at the contract level, and closes both platforms.

Two corollaries the plan must carry:

1. **Both decode entry points** (`transcribe` *and* `align_transcript`) and
   **both resolution paths** (staged deps root *and* the dev `src-tauri/binaries/`
   fallback) must be covered — the dev fallback is what this machine is actually
   running.
2. **The readiness check cannot currently detect this class of failure at all.**
   It checks file presence and aligns against synthetic silence. Until something
   in the self-test decodes a real file through the same path a transcription
   would, a green ZALEŻNOŚCI badge will keep certifying machines that cannot
   transcribe.

## Confidence

**HIGH** — the decisive evidence is direct and on-disk, not inferred:
whisperx 3.8.6's `load_audio` is verifiably a bare `subprocess.run(["ffmpeg", …])`
with no injection point; `where.exe ffmpeg` returns nothing on the affected
machine; no spawn site sets `PATH` or `current_dir`; and the only route to the
observed Polish string is exit 11. The failure is **deterministic, not
probabilistic** — with no `ffmpeg` discoverable by the child, decode cannot
succeed regardless of the WAV's state.

One residual unknown, deliberately left open because it is not load-bearing:
whether the extracted WAV is itself healthy (D1). It should be confirmed
opportunistically once decode works, not treated as a blocker.

## What Changes for /10x-plan

Plan the fix at the **contract** level, not the Windows level: make the engine
child's ffmpeg resolution explicit and provisioned by the app on every platform,
covering both decode entry points and both resolution paths — then make the
readiness check capable of failing when it isn't. The roadmap's fix candidates
(a/b/c) remain the right menu; the choice between them is /10x-plan's call.

The roadmap's S-31 entry should have its "Diagnosis" claim that *"[WAV
extraction] succeeds"* softened — it was never verified, and exit 11 has a second
branch that would look identical.

## References

- `sidecar/.venv/Lib/site-packages/whisperx/audio.py:41-63` — the bare `ffmpeg` subprocess (whisperx 3.8.6)
- `sidecar/whisperx_engine/whisperx_engine.py:374-382` — `_load_audio`, both exit-11 branches
- `sidecar/whisperx_engine/whisperx_engine.py:487`, `:626`, `:733` — the three decode entry points
- `sidecar/whisperx_engine/whisperx_engine.py:266-297` — `_selftest_align_runs`, synthetic silence
- `src-tauri/src/whisper.rs:299-312` — `engine_error_message`, the exit-11 → toast mapping
- `src-tauri/src/whisper.rs:647-660` — WAV extraction into `%TEMP%`
- `src-tauri/src/ffmpeg.rs:11-37` — `ffmpeg_bin_path()`, the convention the child violates
- `src-tauri/src/deps.rs:591` — staged FFmpeg is triple-suffixed
- `src-tauri/src/engine.rs:148-161`, `src-tauri/src/proc.rs:41-56` — the child's env; no `PATH`, no `current_dir`
- `src-tauri/tauri.conf.json:39` — macOS `externalBin` (plain `ffmpeg` beside the engine, unreachable by `execvp`)
- Roadmap slice: `context/foundation/roadmap.md` § S-31
- Investigation tasks: #1 (whisperx `load_audio`), #2 (exit-11 mapping), #3 (Windows staging/PATH), #4 (macOS inverse check)
