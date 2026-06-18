// Single chokepoint for API-key storage (S-11, FR-035).
//
// Secrets live in the macOS Keychain (service `reel-automator`, account =
// provider id) via the Rust `keychain.rs` commands — never plaintext on disk.
// The frontend keeps a module-level in-memory cache so `getApiKey()` stays
// synchronous for the sync call sites (settings modal load/save, transcribe
// setup); `hydrateKeys()` fills that cache from the Keychain once at boot and
// runs a one-time localStorage→Keychain migration of any legacy plaintext key.
//
// Outside Tauri (plain `vite` browser dev) there is no Keychain: the cache is
// the only store, seeded read-only from localStorage so a dev session works,
// and nothing new is ever written to plaintext.

import { toast } from '../ui/toast.js';

const STORAGE_PREFIX = 'edl_apikey_';

/** Providers whose keys are managed by this accessor (one line to add more). */
const PROVIDERS = ['openrouter', 'huggingface'];

/** provider → key string. Hydrated at boot; the source of truth for reads. */
const cache = new Map();

/**
 * Lazily import the Tauri `invoke`. Mirrors `src/ai/cache.js`'s pattern.
 * @returns {Promise<((cmd: string, args?: object) => Promise<any>) | null>}
 */
async function tauriInvoke() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke;
  } catch {
    return null; // not in Tauri
  }
}

/**
 * Read a stored API key for a provider. Synchronous — serves from the cache
 * hydrated at boot. No signature change from the pre-S-11 accessor.
 * @param {string} provider - provider id (e.g. 'openrouter', 'huggingface')
 * @returns {string} the stored key, or '' when none is set
 */
export function getApiKey(provider) {
  return cache.get(provider) ?? '';
}

/**
 * Persist an API key for a provider. Updates the in-memory cache synchronously
 * (so the next sync `getApiKey()` sees it at once), then writes through to the
 * Keychain. On a Keychain failure we keep the cached value for the session and
 * surface a Polish toast — the chosen "toast + keep in memory" behavior.
 * @param {string} provider - provider id
 * @param {string} key - the API key to store
 * @returns {Promise<void>}
 */
export async function setApiKey(provider, key) {
  cache.set(provider, key);
  const invoke = await tauriInvoke();
  if (!invoke) return; // browser dev: cache-only, never write plaintext
  try {
    await invoke('set_credential', { provider, secret: key });
  } catch (e) {
    console.error('[api-key] set_credential failed:', e);
    toast('Nie udało się zapisać klucza w Keychain — działa tylko w tej sesji', 'error');
  }
}

/**
 * Populate the cache from the Keychain and run the one-time plaintext
 * migration. Must be awaited at boot (see `main.js`) BEFORE any surface reads a
 * key synchronously, otherwise the first settings-modal open shows an empty
 * field until refresh.
 * @returns {Promise<void>}
 */
export async function hydrateKeys() {
  const invoke = await tauriInvoke();

  // Browser dev (no Keychain): seed the cache from localStorage read-only so a
  // session works; never delete the plaintext (it's the only store here).
  if (!invoke) {
    for (const provider of PROVIDERS) {
      const plain = localStorage.getItem(STORAGE_PREFIX + provider);
      if (plain) cache.set(provider, plain);
    }
    return;
  }

  for (const provider of PROVIDERS) {
    let secret = null;
    try {
      secret = await invoke('get_credential', { provider });
    } catch (e) {
      console.error('[api-key] get_credential failed:', e);
    }

    if (secret != null && secret !== '') {
      cache.set(provider, secret);
      continue;
    }

    // No Keychain entry — migrate a legacy plaintext key if one exists.
    const plain = localStorage.getItem(STORAGE_PREFIX + provider);
    if (!plain) continue;

    try {
      await invoke('set_credential', { provider, secret: plain });
      // Only delete plaintext AFTER a confirmed Keychain write (FR-035).
      localStorage.removeItem(STORAGE_PREFIX + provider);
      cache.set(provider, plain);
    } catch (e) {
      console.error('[api-key] migration failed for', provider, e);
      // Keep plaintext, keep the session working, retry next launch.
      cache.set(provider, plain);
      toast('Nie udało się przenieść klucza do Keychain — spróbuję ponownie przy następnym uruchomieniu', 'error');
    }
  }
}
