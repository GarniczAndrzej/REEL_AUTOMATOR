// Single chokepoint for API-key storage.
//
// Today the backing store is `localStorage` under the `edl_apikey_<provider>`
// keys. Keeping every read/write behind this helper lets S-11 swap the backing
// store to the OS keychain without touching providers/step1/step2 call sites.

const STORAGE_PREFIX = 'edl_apikey_';

/**
 * Read a stored API key for a provider.
 * @param {string} provider - provider id (e.g. 'gemini', 'claude', 'openrouter')
 * @returns {string} the stored key, or '' when none is set
 */
export function getApiKey(provider) {
  return localStorage.getItem(STORAGE_PREFIX + provider) || '';
}

/**
 * Persist an API key for a provider.
 * @param {string} provider - provider id (e.g. 'gemini', 'claude', 'openrouter')
 * @param {string} key - the API key to store
 * @returns {void}
 */
export function setApiKey(provider, key) {
  localStorage.setItem(STORAGE_PREFIX + provider, key);
}
