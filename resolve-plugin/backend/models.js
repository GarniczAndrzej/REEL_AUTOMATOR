// Node port of models.rs (S-09 Phase 4) — transcription-model manager. CT2 models
// are multi-file directories streamed from HuggingFace into
// `<userData>/whisper-models/<id>/` with live aggregate progress + SHA-256
// verification of the big LFS weights, an atomic `.part` → final swap (a
// half-download never looks ready), and per-model status via the registry
// sentinel (CT2 `model.bin`, Cohere `model.safetensors`). Command shapes mirror
// the Rust commands 1:1 (renderer forwards camelCase verbatim).

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

const paths = require('./paths');
const events = require('./events');

const MODEL_SENTINEL = 'model.bin';

function sanitize(id) {
  return String(id)
    .split('')
    .map((c) => (/[A-Za-z0-9._-]/.test(c) ? c : '_'))
    .join('');
}

function modelDir(modelId) {
  return path.join(paths.modelsRoot(), sanitize(modelId));
}

function isDownloaded(dir, sentinel) {
  const s = sentinel && sentinel.trim() ? sentinel : MODEL_SENTINEL;
  try {
    return fs.statSync(path.join(dir, s)).isFile();
  } catch {
    return false;
  }
}

// A per-file name must be a single normal path segment — no separators, no `..`,
// no absolute parts — so it can't escape the `.part` dir nor smuggle traversal
// into the HF URL. `download_model` is a command boundary, so validate here.
function isSafeFilename(name) {
  if (typeof name !== 'string' || !name) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  if (name === '.' || name === '..') return false;
  return path.basename(name) === name;
}

/** Total bytes of all files directly inside `dir` (non-recursive — CT2 flat). */
function dirSize(dir) {
  try {
    return fs.readdirSync(dir).reduce((sum, name) => {
      try {
        const st = fs.statSync(path.join(dir, name));
        return st.isFile() ? sum + st.size : sum;
      } catch {
        return sum;
      }
    }, 0);
  } catch {
    return 0;
  }
}

/**
 * Report downloaded/missing status (+ on-disk size) per requested model.
 * @param {{ models: {id:string, sentinel?:string}[] }} args
 * @returns {Promise<{id:string,downloaded:boolean,path:string|null,size_bytes:number}[]>}
 */
async function listModels({ models }) {
  const out = [];
  for (const m of models || []) {
    const dir = modelDir(m.id);
    const downloaded = isDownloaded(dir, m.sentinel);
    out.push({
      id: m.id,
      downloaded,
      path: downloaded ? dir : null,
      size_bytes: downloaded ? dirSize(dir) : 0,
    });
  }
  return out;
}

/** Verify a file's SHA-256; on mismatch delete it and throw a Polish error.
 * Empty `expected` skips verification (small git-blob JSON files). */
async function verifySha256(filePath, expected) {
  if (!expected || !expected.trim()) return;
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const rs = fs.createReadStream(filePath);
    rs.on('data', (c) => hash.update(c));
    rs.on('error', reject);
    rs.on('end', resolve);
  });
  const got = hash.digest('hex');
  if (got.toLowerCase() !== expected.trim().toLowerCase()) {
    await fsp.rm(filePath, { force: true });
    throw new Error(
      `Suma kontrolna pobranego modelu nie zgadza się (oczekiwano ${expected.slice(
        0,
        12,
      )}, otrzymano ${got.slice(0, 12)}). Pobieranie odrzucone.`,
    );
  }
}

/**
 * Stream every file of a CT2/transformers model from its HF `repo` into
 * `whisper-models/<id>/`, emitting aggregate %/speed/ETA, verifying the LFS
 * weights, then atomically swapping the `.part` dir into place. Returns the final
 * local model-dir path.
 * @returns {Promise<string>}
 */
async function downloadModel({ modelId, repo, files, totalBytes, hfToken }) {
  if (!files || !files.length) {
    throw new Error(
      'Brak listy plików modelu w rejestrze (uzupełnij repo/files).',
    );
  }
  const root = paths.modelsRoot();
  await fsp.mkdir(root, { recursive: true });
  const finalDir = modelDir(modelId);
  const partDir = path.join(root, `${sanitize(modelId)}.part`);
  await fsp.rm(partDir, { recursive: true, force: true });
  await fsp.mkdir(partDir, { recursive: true });

  const total =
    totalBytes && totalBytes > 0
      ? totalBytes
      : files.reduce((s, f) => s + (f.sizeBytes || 0), 0);

  const bearer = hfToken && hfToken.trim() ? `Bearer ${hfToken.trim()}` : null;

  const start = Date.now();
  let downloaded = 0;
  let lastEmit = Date.now();

  try {
    for (const spec of files) {
      if (!isSafeFilename(spec.name)) {
        throw new Error(
          `Nieprawidłowa nazwa pliku modelu: ${spec.name}. Pobieranie odrzucone.`,
        );
      }
      const url = `https://huggingface.co/${repo}/resolve/main/${spec.name}`;
      const headers = bearer ? { Authorization: bearer } : {};
      let resp;
      try {
        resp = await fetch(url, { headers });
      } catch (e) {
        throw new Error(`Pobieranie modelu nie powiodło się: ${e.message}`);
      }
      // Gated repo → 401 (no token) / 403 (license not accepted): surface both
      // prerequisites in Polish rather than a bare code.
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(
          `Brak dostępu do bramkowanego repozytorium „${repo}” (HTTP ${resp.status}). ` +
            `Aby pobrać ten model: 1) zaakceptuj licencję modelu jednorazowo na stronie ` +
            `https://huggingface.co/${repo}, oraz 2) podaj prawidłowy token HuggingFace ` +
            `(pole tokenu HF przy opcji diaryzacji).`,
        );
      }
      if (!resp.ok || !resp.body) {
        throw new Error(
          `Serwer zwrócił błąd ${resp.status} przy pobieraniu pliku ${spec.name}.`,
        );
      }

      const dest = path.join(partDir, spec.name);
      const fileHandle = await fsp.open(dest, 'w');
      try {
        const writeStream = fileHandle.createWriteStream();
        for await (const chunk of resp.body) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          if (!writeStream.write(buf)) {
            await new Promise((r) => writeStream.once('drain', r));
          }
          downloaded += buf.length;

          if (Date.now() - lastEmit >= 200) {
            lastEmit = Date.now();
            const secs = Math.max((Date.now() - start) / 1000, 0.001);
            const rate = downloaded / secs;
            const percent = total > 0 ? (downloaded / total) * 100 : 0;
            const eta =
              rate > 0 && total > downloaded ? (total - downloaded) / rate : 0;
            events.emit('model-download-progress', {
              modelId,
              percent,
              bytesPerSec: rate,
              etaSec: eta,
              downloaded,
              total,
            });
          }
        }
        await new Promise((resolve, reject) => {
          writeStream.end((err) => (err ? reject(err) : resolve()));
        });
      } finally {
        await fileHandle.close();
      }

      await verifySha256(dest, spec.sha256);
    }
  } catch (e) {
    await fsp.rm(partDir, { recursive: true, force: true });
    throw e;
  }

  // Swap the verified .part dir into place without ever leaving no model: back up
  // any existing dir, move .part in, drop the backup — restoring on failure.
  const bakDir = path.join(root, `${sanitize(modelId)}.bak`);
  await fsp.rm(bakDir, { recursive: true, force: true });
  const hadExisting = fs.existsSync(finalDir);
  if (hadExisting) {
    try {
      await fsp.rename(finalDir, bakDir);
    } catch (e) {
      await fsp.rm(partDir, { recursive: true, force: true });
      throw new Error(`Nie udało się podmienić modelu: ${e.message}`);
    }
  }
  try {
    await fsp.rename(partDir, finalDir);
  } catch (e) {
    if (hadExisting) {
      try {
        await fsp.rename(bakDir, finalDir);
      } catch {
        /* best-effort restore */
      }
    }
    await fsp.rm(partDir, { recursive: true, force: true });
    throw new Error(`Nie udało się podmienić modelu: ${e.message}`);
  }
  await fsp.rm(bakDir, { recursive: true, force: true });

  events.emit('model-download-progress', {
    modelId,
    percent: 100,
    bytesPerSec: 0,
    etaSec: 0,
    done: true,
  });

  return finalDir;
}

/** Delete a downloaded model directory. */
async function deleteModel({ modelId }) {
  const dir = modelDir(modelId);
  await fsp.rm(dir, { recursive: true, force: true });
}

module.exports = { listModels, downloadModel, deleteModel };
