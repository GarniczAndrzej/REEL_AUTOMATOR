// Shared path + cache-root resolution for the Node backend ports (S-09 Phase 4).
//
// Tauri auto-resolves the arch-suffixed `externalBin` sidecars and exposes
// `app_cache_dir()`/`app_data_dir()`; Node has no analog, so every sidecar path,
// align-model dir, and cache root is computed manually here. Two layouts:
//   - packaged (electron-builder `extraResources`): binaries + `align_models/`
//     land directly under `process.resourcesPath`.
//   - dev: the repo's `src-tauri/binaries/` (where `sidecar/build.sh` +
//     `sidecar/fetch-ffmpeg.sh` stage them, beside the align models).
// All cache roots live under a FRESH Electron namespace (`app.getPath`), cold by
// decision — no migration from the Tauri app's caches.

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

/**
 * The Rust target-triple suffix Tauri appends to `externalBin` names, derived
 * from the running Electron process. macOS-only this slice (Windows is a mapped
 * follow-up); an unsupported host throws so a missing binary fails loudly rather
 * than silently no-opping transcription.
 * @returns {string}
 */
function archSuffix() {
  const { platform, arch } = process;
  if (platform === 'darwin') {
    return arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  }
  throw new Error(
    `Nieobsługiwana platforma dla sidecara: ${platform}/${arch} (ten dodatek działa obecnie tylko na macOS).`,
  );
}

/**
 * Root holding the bundled sidecars + `align_models/`. Probed in order so the
 * same code works whether the plugin runs packaged, dev-installed in the WI
 * plugins dir, or straight from the repo:
 *   1. packaged: the app's `Resources/` dir (electron-builder `extraResources`);
 *   2. dev-install: a `binaries/` dir (real or a symlink to the repo's) sitting
 *      beside the plugin root — the install copies `resolve-plugin/` OUT of the
 *      repo, so the repo-relative path below no longer resolves there;
 *   3. repo layout: `src-tauri/binaries` (running straight from a checkout).
 * The first existing candidate wins; otherwise the last is returned so error
 * messages name a sensible path.
 * @returns {string}
 */
function binariesDir() {
  const candidates = [];
  if (app.isPackaged) candidates.push(process.resourcesPath);
  candidates.push(path.join(__dirname, '..', 'binaries'));
  candidates.push(path.join(__dirname, '..', '..', 'src-tauri', 'binaries'));
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isDirectory()) return c;
    } catch {
      /* not this one */
    }
  }
  return candidates[candidates.length - 1];
}

/** Absolute path to the arch-suffixed WhisperX engine sidecar. @returns {string} */
function enginePath() {
  return path.join(binariesDir(), `whisperx-engine-${archSuffix()}`);
}

/** Absolute path to the arch-suffixed FFmpeg sidecar. @returns {string} */
function ffmpegPath() {
  return path.join(binariesDir(), `ffmpeg-${archSuffix()}`);
}

/**
 * The wav2vec2 alignment-model dir that ships BESIDE the engine (never baked into
 * the onefile — a multi-GB Mach-O won't load on macOS; see lessons.md). Returns
 * `null` when absent (engine then falls back to next-to-exe), mirroring the Rust
 * `align_model_dir`.
 * @returns {string | null}
 */
function alignModelDir() {
  const dir = path.join(binariesDir(), 'align_models');
  try {
    if (fs.statSync(dir).isDirectory()) return dir;
  } catch {
    /* absent */
  }
  return null;
}

/**
 * Ensure a directory holding a plain `ffmpeg`-named symlink to the bundled
 * sidecar, and return it for prepending to a child's `PATH`. WhisperX's
 * `load_audio` shells out to a BARE `ffmpeg` command, so the engine subprocess
 * needs one on its PATH. Resolve launches the panel's Electron with a minimal GUI
 * PATH (`/usr/bin:/bin:…`) that has no ffmpeg — unlike `tauri dev`, which inherits
 * the terminal's PATH — so without this the engine decodes nothing (exit 11). The
 * symlink lives in a writable userData dir (the binaries dir may be a read-only
 * resource or a repo symlink) and is refreshed if it points elsewhere.
 * @returns {string | null} the dir to prepend to PATH, or null on failure
 */
function ffmpegPathDir() {
  try {
    const binDir = path.join(userDataRoot(), 'ffmpeg-bin');
    fs.mkdirSync(binDir, { recursive: true });
    const link = path.join(binDir, 'ffmpeg');
    const target = ffmpegPath();
    let ok = false;
    try {
      ok = fs.readlinkSync(link) === target;
    } catch {
      ok = false;
    }
    if (!ok) {
      try {
        fs.unlinkSync(link);
      } catch {
        /* absent */
      }
      fs.symlinkSync(target, link);
    }
    return binDir;
  } catch {
    return null;
  }
}

/** Base for all fresh-namespace caches (matches the other Node ports). */
function userDataRoot() {
  return app.getPath('userData');
}

/** `<userData>/whisper-cache` — transcription v2 cache root. @returns {string} */
function whisperCacheDir() {
  return path.join(userDataRoot(), 'whisper-cache');
}

/** `<userData>/engine-readiness` — readiness-verdict cache root. @returns {string} */
function engineReadinessDir() {
  return path.join(userDataRoot(), 'engine-readiness');
}

/** `<userData>/waveform-cache` — clip-trim waveform cache root. @returns {string} */
function waveformCacheDir() {
  return path.join(userDataRoot(), 'waveform-cache');
}

/** `<userData>/whisper-models` — downloaded transcription models root. @returns {string} */
function modelsRoot() {
  return path.join(userDataRoot(), 'whisper-models');
}

module.exports = {
  archSuffix,
  binariesDir,
  enginePath,
  ffmpegPath,
  ffmpegPathDir,
  alignModelDir,
  whisperCacheDir,
  engineReadinessDir,
  waveformCacheDir,
  modelsRoot,
};
