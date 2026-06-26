// Node reimplementation of the LLM disk cache (load/save/clear_llm_cache, S-09
// Phase 1). The frontend (src/ai/cache.js) already hashes the cache key
// (SHA-256) and passes `hash`; this layer only reads/writes
// `<userData>/llm-cache/<hash>.txt`. Fresh Electron namespace — first-run caches
// are cold by decision (no migration from the Tauri cache).
//
// Matches the Tauri command shapes:
//   load_llm_cache({ hash }) -> string | null (cached content)
//   save_llm_cache({ hash, content }) -> void
//   clear_llm_cache() -> void

const fsp = require('fs/promises');
const path = require('path');
const { app } = require('electron');

function cacheDir() {
  return path.join(app.getPath('userData'), 'llm-cache');
}

/** @param {{ hash: string }} args @returns {Promise<string|null>} */
async function loadLlmCache({ hash }) {
  try {
    return await fsp.readFile(path.join(cacheDir(), `${hash}.txt`), 'utf-8');
  } catch {
    return null; // miss
  }
}

/** @param {{ hash: string, content: string }} args @returns {Promise<void>} */
async function saveLlmCache({ hash, content }) {
  const dir = cacheDir();
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, `${hash}.txt`), content, 'utf-8');
}

/** @returns {Promise<void>} */
async function clearLlmCache() {
  try {
    await fsp.rm(cacheDir(), { recursive: true, force: true });
  } catch {
    /* nothing to clear */
  }
}

module.exports = { loadLlmCache, saveLlmCache, clearLlmCache };
