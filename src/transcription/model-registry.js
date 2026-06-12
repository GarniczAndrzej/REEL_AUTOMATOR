// Curated registry of supported faster-whisper (CTranslate2) transcription
// models for the WhisperX engine. Download-on-demand (Phase 4) streams each
// `url` into the app data dir and verifies it against `sha256` before use.
//
// NOTE: `url` / `sha256` / `sizeBytes` are packaging-curated values. Fill them
// with the real single-file artifact URL + digest for your distribution before
// shipping; an empty `sha256` skips verification (dev only). The per-language
// alignment model is bundled in the sidecar (Phase 1), shown here as a
// status-only entry — never downloaded by the user.

/**
 * @typedef {Object} TranscriptionModel
 * @property {string} id          - faster-whisper model id passed to the engine `--model`
 * @property {string} label       - display name
 * @property {number} sizeBytes   - approximate download size
 * @property {string} url         - single-file download URL (curated)
 * @property {string} sha256      - expected hex digest ('' skips verification)
 */

/** @type {TranscriptionModel[]} */
export const MODEL_REGISTRY = [
  {
    id: 'small',
    label: 'Small (szybki, ~480 MB)',
    sizeBytes: 480_000_000,
    url: '',
    sha256: '',
  },
  {
    id: 'medium',
    label: 'Medium (zbalansowany, ~1.5 GB)',
    sizeBytes: 1_500_000_000,
    url: '',
    sha256: '',
  },
  {
    id: 'large-v3',
    label: 'Large-v3 (najlepsza jakość, ~3 GB)',
    sizeBytes: 3_000_000_000,
    url: '',
    sha256: '',
  },
];

/**
 * The per-language wav2vec2 alignment model bundled into the sidecar. Surfaced
 * in the manager as status-only (readiness comes from the engine self-check).
 */
export const ALIGNMENT_MODEL = {
  id: 'wav2vec2-align',
  label: 'Model dopasowania słów (wbudowany)',
  bundled: true,
};

/** @param {string} id @returns {TranscriptionModel|undefined} */
export function getModel(id) {
  return MODEL_REGISTRY.find((m) => m.id === id);
}

/** @param {number} bytes @returns {string} human-readable size */
export function formatBytes(bytes) {
  if (!bytes) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
