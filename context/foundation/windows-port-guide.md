---
project: Reels Automator
doc: windows-port-guide
status: draft
created: 2026-06-22
relates_to: roadmap S-24 (windows-port)
---

# Continuing the project on Windows

Practical hand-off for moving development of Reels Automator to a Windows machine.
This is the **how-to** companion to roadmap slice **S-24 `windows-port`** (the *what/why*
lives in `roadmap.md`). Read that slice for the decisions; read this for the steps.

> **Golden rule: clone, don't copy.** The three biggest, platform-specific artifacts
> (both sidecars + the alignment models) are **git-ignored** and **macOS-only binaries** —
> copying them to Windows is useless (they won't run) and slow (~350 MB). You move the
> *source*, then **rebuild the native layer on Windows**.

---

## 0. What actually transfers vs. what gets rebuilt

| Thing | In git? | Action on Windows |
| --- | --- | --- |
| All source (`src/`, `src-tauri/src/`, `sidecar/*.sh`, `*.spec`, config) | ✅ yes | comes with `git clone` |
| `node_modules/` | ❌ ignored | `npm install` |
| `src-tauri/target/` (Rust build) | ❌ ignored | rebuilt by `cargo`/`tauri` |
| `src-tauri/binaries/ffmpeg-aarch64-apple-darwin` (~52 MB) | ❌ ignored | **do not copy** — fetch a Windows static ffmpeg |
| `src-tauri/binaries/whisperx-engine-aarch64-apple-darwin` (~290 MB) | ❌ ignored | **do not copy** — rebuild with `sidecar/build.sh` |
| `src-tauri/binaries/align_models/` | ❌ ignored | **do not copy** — re-staged by `build.sh` |
| `sidecar/.venv/`, `sidecar/build/`, `sidecar/dist/` | ❌ ignored | recreated by `build.sh` |
| `.reelproj` test projects, API keys | n/a | keys live in macOS Keychain — **re-enter on Windows** (they don't migrate) |

The git-ignore rules that make this true (`.gitignore`):
`src-tauri/binaries/whisperx-engine-*`, `src-tauri/binaries/align_models/`,
`src-tauri/binaries/ffmpeg-*`, `node_modules/`, `src-tauri/target/`.

---

## 1. Get the repo onto Windows

**Preferred — push to a remote, clone on Windows.** This is the clean path because git
already excludes everything you shouldn't carry.

On the Mac (if not already pushed somewhere):
```bash
# from the repo root
git status                      # commit or stash anything in flight first
git remote -v                   # confirm a remote exists; if not, create a private repo
git push origin master          # (this project's working branch is `master`)
```

On Windows (PowerShell or Git-Bash):
```powershell
git clone <your-remote-url> REEL_AUTOMATOR
cd REEL_AUTOMATOR
```

**If you must copy the folder directly** (USB / network share, no remote): copy the repo
but **exclude** the ignored heavyweight dirs, or you'll drag ~700 MB of useless macOS
binaries and build caches. Delete these after copying if they came along:
`node_modules/`, `src-tauri/target/`, `sidecar/.venv/`, `sidecar/build/`, `sidecar/dist/`,
and everything under `src-tauri/binaries/`. The `.git/` folder *should* come so history
is preserved.

---

## 2. Install Windows prerequisites

Tauri 2 + Vite + a PyInstaller sidecar need a real toolchain. Install, in order:

1. **Visual Studio Build Tools** — "Desktop development with C++" workload (MSVC linker +
   Windows SDK + WebView2). Tauri's `x86_64-pc-windows-msvc` target requires MSVC.
   WebView2 Runtime ships with current Windows 10/11 but install the Evergreen runtime if
   missing.
2. **Rust** via `rustup` (`https://rustup.rs`) → gives `cargo` on `PATH` (no more
   `~/.cargo/bin/cargo` prefix — the macOS-specific path in `CLAUDE.md` doesn't apply).
3. **Node.js LTS** (v20+) → `npm`.
4. **Python 3.10 or 3.11** (the sidecar pins this range) — check "Add to PATH" in the
   installer. 3.12+ may break torch/whisperx wheels.
5. **Git for Windows** — also gives you **Git-Bash**, which you need because the sidecar
   build scripts are bash (see §4).
6. **(GPU path only)** NVIDIA driver + CUDA 12.1-compatible runtime, if you choose the
   CUDA WhisperX build. See §4 / S-24's "big unknown".

---

## 3. Frontend + Rust check (fast feedback before the heavy sidecar build)

From the repo root:
```powershell
npm install
```

You can't fully `cargo check` yet — Tauri hard-fails if a registered `externalBin` is
missing for the host triple, and on a fresh Windows clone the `binaries/` are absent. So
the order is: **§4 (build sidecars) → then build/run**. But the pure-logic regression
suite has no native deps and should pass identically on Windows right now — run it to prove
the JS pipeline is byte-identical across platforms:
```powershell
node --experimental-vm-modules test/regression.js
```
This is the single most important cross-platform check: parser, exporters and frame-math
are platform-agnostic and must **not** change for Windows. If this stays green, the port is
purely a native-layer/packaging job.

---

## 4. Rebuild the native sidecars for Windows (the real work)

Tauri registers two `externalBin` entries (`tauri.conf.json`):
`binaries/ffmpeg` and `binaries/whisperx-engine`, plus `binaries/align_models` as a bundled
resource. Tauri resolves the **arch-suffixed** variant per target, so for a Windows build
you need:

- `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe`
- `src-tauri/binaries/whisperx-engine-x86_64-pc-windows-msvc.exe`
- `src-tauri/binaries/align_models/` (re-staged beside the engine)

### 4a. FFmpeg — supply a Windows static build manually

`sidecar/fetch-ffmpeg.sh` only knows macOS sources and will **abort on Windows by design**
with a message telling you to drop a static binary in place. So:

1. Download a **static** Windows ffmpeg (e.g. the gyan.dev or BtbN "release-full" /
   "static" build — a single self-contained `ffmpeg.exe`, no shared DLLs).
2. Rename and place it exactly as:
   `src-tauri/binaries/ffmpeg-x86_64-pc-windows-msvc.exe`
3. Verify it runs and is self-contained: `ffmpeg-x86_64-pc-windows-msvc.exe -version`.
   (Static = no missing-DLL popups on a clean machine — the same constraint the mac build
   enforces.)

> **S-24 follow-up:** porting `fetch-ffmpeg.sh` to also auto-fetch the Windows build (a
> PowerShell sibling, or a `MINGW*` branch) is a nice-to-have, not a blocker. Manual drop is
> fine to start.

### 4b. WhisperX engine — rebuild with `build.sh` under Git-Bash

`sidecar/build.sh` is **already Windows-aware**: it detects the `MINGW*/MSYS*` host as the
`x86_64-pc-windows-msvc` triple, appends `.exe`, activates the venv via `Scripts/activate`,
and branches torch CPU-vs-CUDA. Run it **from Git-Bash** (not PowerShell — it's bash):

```bash
# CPU build (portable, slower) — start here to get a working app
sidecar/build.sh

# GPU/CUDA build (NVIDIA, much faster) — only if you've set up CUDA 12.1
GPU=1 sidecar/build.sh

# bundle extra alignment languages (default is Polish only)
ALIGN_LANGS="pl en" sidecar/build.sh
```

What it does: creates `sidecar/.venv`, installs torch (`--index-url .../whl/cpu` for CPU or
`.../whl/cu121` for GPU) + `whisperx_engine/requirements.txt`, pre-downloads the wav2vec2
alignment model into `align_models/<lang>`, freezes `whisperx_engine.py` with PyInstaller,
then copies the `.exe` + `align_models/` into `src-tauri/binaries/`.

Self-test the result (proves the frozen engine + alignment model load before you wire it to
the app — note every cold spawn costs ~37–67 s for onefile extraction + torch import, so be
patient):
```bash
"src-tauri/binaries/whisperx-engine-x86_64-pc-windows-msvc.exe" --selftest
```

**The CUDA-vs-CPU decision is S-24's headline unknown** — CPU is portable but slow; CUDA is
fast but needs the matching torch wheel + cuDNN/cuBLAS DLLs bundled and a driver floor.
Decide before committing to a sidecar size. Start CPU, add GPU once the app runs end-to-end.

---

## 5. One required Cargo change — the Windows credential store

API keys use the `keyring` crate (S-11). `src-tauri/Cargo.toml` currently enables **only**
the macOS backend:
```toml
keyring = { version = "3.6.3", features = ["apple-native"] }
```
`keyring` 3.x ships **no** credential store by default — it silently falls back to an
in-memory mock, so on Windows your keys would vanish every launch unless you enable the
Windows backend. Add `windows-native` (keep `apple-native` for the mac build):
```toml
keyring = { version = "3.6.3", features = ["apple-native", "windows-native"] }
```
This points the same `keychain.rs` get/set/delete commands at **Windows Credential
Manager**. The one-time `localStorage`→Keychain migration is macOS-history only; on Windows
you simply re-enter the OpenRouter (and optional HuggingFace) key in Settings once.

---

## 6. Run it

```powershell
npm run tauri dev      # dev window (Vite + Tauri)
npm run tauri build    # production installer (MSI/NSIS — see below)
```
`tauri.conf.json` has `"targets": "all"`, so a Windows build emits the platform's installer
formats (MSI via WiX, NSIS `.exe`). Code signing on Windows is **Authenticode** (a separate
cert), not Apple notarization — leave unsigned for personal use; SmartScreen will warn on
first run.

---

## 7. Verification checklist (Windows parity with macOS)

- [ ] `node --experimental-vm-modules test/regression.js` green (pipeline byte-identical).
- [ ] `ffmpeg-x86_64-pc-windows-msvc.exe -version` runs, no missing-DLL popup.
- [ ] `whisperx-engine-...-msvc.exe --selftest` passes (engine + alignment model load).
- [ ] `npm run tauri dev` opens the window; UI strings still Polish.
- [ ] Import a video → transcribe locally → word-level alignment populates.
- [ ] AI selection scores reels (after entering the OpenRouter key in Settings).
- [ ] Export EDL / XML / Lua / word-SRT — open the EDL in Premiere/Resolve to confirm.
- [ ] Close and relaunch → API key persists (Windows Credential Manager working ⇒
      `windows-native` feature is active).
- [ ] Save/load a `.reelproj` round-trips.

---

## 8. Known Windows gotchas to watch (S-24 unknowns, applied)

- **Path separators / cache dir** — audit `whisper.rs`, `ffmpeg.rs`, `waveform.rs` and the
  `appCacheDir` logic for any POSIX-only path assumptions. The whisper cache lives under
  `<appCacheDir>/whisper-cache/v2/...` — confirm it resolves on Windows.
- **Long paths** — Windows' 260-char `MAX_PATH` can bite PyInstaller temp extraction and
  deep `node_modules`/`target` trees. Enable Win32 long-path support if builds fail with
  path-length errors.
- **Antivirus / SmartScreen** — a freshly-frozen unsigned PyInstaller `.exe` may be quarantined
  or scanned slowly on first spawn (compounding the cold-start cost). Whitelist the
  `binaries/` dir during development.
- **`.gitignore` discipline** — never commit the rebuilt `.exe` sidecars or `align_models/`
  from Windows either; they're large and host-specific. The existing ignore rules already
  cover the `whisperx-engine-*` / `ffmpeg-*` / `align_models/` globs across triples.
- **Keep one codebase** — resist forking platform-specific JS. The frontend, parser and
  exporters must stay identical; all real divergence lives in the sidecar build + Cargo
  features + the installer config.
