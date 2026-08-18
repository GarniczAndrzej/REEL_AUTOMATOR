// Node port of engine.rs (S-09 Phase 4) — WhisperX engine readiness. Three
// commands mirror the Rust ones:
//   - whisperx_engine_cached: read-only launch-path badge (NEVER spawns — a cold
//     onefile probe is 37–67 s; memory `whisperx-cold-spawn-cost`);
//   - whisperx_engine_check: the heavy `--selftest` (loads the align model, runs a
//     real align) — the only authoritative verdict, refreshes the cache;
//   - whisperx_engine_capability: cheap `--capability` (device detect + dir check)
//     on a cache miss.
// The readiness cache is content-addressed by app version + align-dir metadata so
// a new bundled engine or swapped model invalidates stale verdicts. Fresh Electron
// namespace.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { app } = require('electron');

const paths = require('./paths');

const CAPABILITY_TIMEOUT_MS = 60 * 1000;
const SELFTEST_TIMEOUT_MS = 300 * 1000;

/**
 * Run the engine sidecar with `args`, collecting (stdout, stderr, code), bounded
 * by `timeoutMs`. On timeout the child is killed explicitly and an Err is thrown
 * so callers surface the amber "nie można sprawdzić" state instead of hanging.
 * Both callers use only the bundled align model (or none) → force HF offline.
 */
function runEngine(args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const env = {
      ...process.env,
      HF_HUB_OFFLINE: '1',
      TRANSFORMERS_OFFLINE: '1',
    };
    let child;
    try {
      child = spawn(paths.enginePath(), args, { env });
    } catch (e) {
      reject(new Error(`Silnik WhisperX niedostępny: ${e.message}`));
      return;
    }
    let out = '';
    let err = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* gone */
      }
      reject(new Error('Sprawdzanie silnika przekroczyło limit czasu'));
    }, timeoutMs);

    child.stdout.on('data', (b) => (out += b.toString('utf8')));
    child.stderr.on('data', (b) => (err += b.toString('utf8')));
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(
        new Error(`Nie udało się uruchomić silnika WhisperX: ${e.message}`),
      );
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ out, err, code });
    });
  });
}

/** Parse the engine's readiness JSON (shared by --selftest and --capability). */
function parseEngineStatus(out) {
  let v;
  try {
    v = JSON.parse(out.trim());
  } catch (e) {
    throw new Error(`Niepoprawna odpowiedź silnika: ${e.message}`);
  }
  return {
    ok: !!v.ok,
    version: v.version || '',
    gpu: !!v.gpu,
    device: v.device || '',
    alignment_model_ready: !!v.alignment_model_ready,
    // Stamped by the calling command before caching.
    authoritative: false,
  };
}

// ── Readiness verdict cache ───────────────────────────────────────────────────

/** Pre-spawn cache key: SHA-256 of app version + align-dir metadata (so a swapped
 * engine/model invalidates stale verdicts). Falls back to a sentinel when absent. */
function readinessCacheKey() {
  const h = crypto.createHash('sha256');
  h.update(Buffer.from(app.getVersion(), 'utf8'));
  h.update(Buffer.from([0]));
  const dir = paths.alignModelDir();
  let meta = null;
  if (dir) {
    try {
      meta = fs.statSync(dir);
    } catch {
      meta = null;
    }
  }
  if (meta) {
    const sizeBuf = Buffer.alloc(8);
    sizeBuf.writeBigUInt64LE(BigInt(Math.trunc(meta.size)));
    h.update(sizeBuf);
    const mtimeBuf = Buffer.alloc(8);
    mtimeBuf.writeBigUInt64LE(BigInt(Math.trunc(meta.mtimeMs / 1000)));
    h.update(mtimeBuf);
  } else {
    h.update(Buffer.from('no-align-dir', 'utf8'));
  }
  return h.digest('hex');
}

function readReadinessCache(key) {
  try {
    const text = fs.readFileSync(
      path.join(paths.engineReadinessDir(), `${key}.json`),
      'utf-8',
    );
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function writeReadinessCache(key, status) {
  try {
    const dir = paths.engineReadinessDir();
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(path.join(dir, `${key}.json`), JSON.stringify(status));
  } catch {
    /* best-effort */
  }
}

function alignArgs(base) {
  const args = [...base];
  const dir = paths.alignModelDir();
  if (dir) args.push('--align-model-dir', dir);
  return args;
}

/** Heavy `--selftest`: authoritative readiness; refreshes the cache. */
async function whisperxEngineCheck() {
  const { out, err, code } = await runEngine(
    alignArgs(['--selftest']),
    SELFTEST_TIMEOUT_MS,
  );
  if (code !== 0) {
    throw new Error(
      `Silnik WhisperX zakończył self-test z błędem (kod ${code}): ${err.trim()}`,
    );
  }
  const status = parseEngineStatus(out);
  status.authoritative = true;
  await writeReadinessCache(readinessCacheKey(), status);
  return status;
}

/** Launch-path badge read: cached verdict or null. NEVER spawns. */
async function whisperxEngineCached() {
  return readReadinessCache(readinessCacheKey());
}

/** On-demand cheap probe: cached verdict on a hit, else `--capability`. */
async function whisperxEngineCapability() {
  const key = readinessCacheKey();
  const cached = readReadinessCache(key);
  if (cached) return cached;
  const { out, err, code } = await runEngine(
    alignArgs(['--capability']),
    CAPABILITY_TIMEOUT_MS,
  );
  if (code !== 0) {
    throw new Error(
      `Sprawdzanie silnika WhisperX nie powiodło się (kod ${code}): ${err.trim()}`,
    );
  }
  const status = parseEngineStatus(out);
  status.authoritative = false;
  await writeReadinessCache(key, status);
  return status;
}

// ── Alignment-model presence (port of engine.rs align_model_present/_status) ──

/**
 * Shallow-recursive glob for a non-trivial `*.safetensors` OR `*.bin` weight
 * under the align-model dir. Both extensions are checked because the engine
 * downloads whichever single format a language's repo actually ships — the
 * Polish repo has no `.safetensors` at all, only `pytorch_model.bin`.
 * `statSync` (not `lstatSync`) so the HF snapshot layout's symlinks into
 * `blobs/` are FOLLOWED to the real file's size.
 * @param {string} p @param {number} depth @returns {boolean}
 */
function hasWeight(p, depth) {
  if (depth > 6) return false;
  let entries;
  try {
    entries = fs.readdirSync(p, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const e of entries) {
    const full = path.join(p, e.name);
    if (e.isDirectory()) {
      if (hasWeight(full, depth + 1)) return true;
    } else if (/\.(safetensors|bin)$/.test(e.name)) {
      try {
        if (fs.statSync(full).size > 1024) return true;
      } catch {
        /* dangling symlink — not a usable weight */
      }
    }
  }
  return false;
}

/**
 * Recursive total size of REAL (non-symlink) files under `dir`. The HF cache
 * layout nests `blobs/` (real files) inside `models--org--repo/snapshots/<sha>/`
 * (symlinks into `blobs/`), so symlinks are skipped rather than dereferenced —
 * each blob is counted exactly once instead of being doubled via its snapshot
 * link. `lstatSync` is what makes that distinction.
 * @param {string} dir @returns {number}
 */
function dirSizeRecursive(dir) {
  let total = 0;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    let meta;
    try {
      meta = fs.lstatSync(full);
    } catch {
      continue;
    }
    if (meta.isDirectory()) total += dirSizeRecursive(full);
    else if (meta.isFile()) total += meta.size;
  }
  return total;
}

/**
 * Cheap status read for the model-manager's align-model card: whether the model
 * is present and its on-disk footprint. NEVER spawns the sidecar.
 *
 * Without this handler the renderer's `invoke('align_model_status')` rejected
 * with "No handler registered"; the caller swallows that in a bare catch and
 * falls back to `{}`, so a fully-downloaded 2.4 GB model still rendered as
 * "Brak" with an active download button (S-09 parity gap).
 * @returns {Promise<{downloaded: boolean, size_bytes: number}>}
 */
async function alignModelStatus() {
  const dir = paths.alignModelDir();
  if (!dir) return { downloaded: false, size_bytes: 0 };
  return {
    downloaded: hasWeight(dir, 0),
    size_bytes: dirSizeRecursive(dir),
  };
}

module.exports = {
  whisperxEngineCheck,
  whisperxEngineCached,
  whisperxEngineCapability,
  alignModelStatus,
};
