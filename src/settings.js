// Persisted app-settings store (S-16). Mirrors the `edl_whisper_advanced`
// precedent: a single JSON blob in localStorage holding app-level preferences
// that must survive sessions (merge-gap and project defaults). This is the one
// piece of net-new state plumbing in an otherwise presentation-only slice.
//
// Project data still lives in `.reelproj`; per-machine perf knobs still live in
// `edl_whisper_advanced`. This bag is for cross-session app/project defaults.

const LS_KEY = 'edl_app_settings';

/**
 * @typedef {Object} AppSettings
 * @property {number} [mergeThreshold] - default EDL merge-gap (frames)
 */

/**
 * Read the persisted settings bag. Always returns an object (never throws).
 * @returns {AppSettings}
 */
export function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    return {};
  }
}

/**
 * Merge `partial` into the persisted settings bag and write it back.
 * @param {AppSettings} partial
 * @returns {AppSettings} the merged, persisted settings
 */
export function saveSettings(partial) {
  const merged = { ...loadSettings(), ...(partial || {}) };
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(merged));
  } catch (e) {}
  return merged;
}
