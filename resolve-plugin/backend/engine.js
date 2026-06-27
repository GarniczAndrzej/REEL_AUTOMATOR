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

module.exports = {
  whisperxEngineCheck,
  whisperxEngineCached,
  whisperxEngineCapability,
};
