// Curated registry of supported faster-whisper (CTranslate2) transcription
// models for the WhisperX engine. faster-whisper CT2 models are multi-file
// *directories*, so download-on-demand (Phase 4) streams every file in `files`
// from the HuggingFace `repo` into `whisper-models/<id>/` and verifies the big
// LFS `model.bin` against its `sha256` before the engine loads that local path.
//
// The per-file `sha256` is only set for `model.bin` (the LFS weights); the small
// JSON/txt files are plain git blobs (no content sha256 published), so they carry
// '' and skip verification. `sizeBytes` values come from the HF tree API and feed
// the aggregate %/ETA. The per-language alignment model is bundled in the sidecar
// (Phase 1), shown here as a status-only entry — never downloaded by the user.

/**
 * @typedef {Object} ModelFile
 * @property {string} name        - file name within the model dir
 * @property {number} sizeBytes   - file size (for aggregate progress)
 * @property {string} sha256      - expected hex digest ('' skips verification)
 */

/**
 * @typedef {Object} TranscriptionModel
 * @property {string} id          - logical model id (selected/persisted in state)
 * @property {string} label       - display name
 * @property {string} repo        - HuggingFace repo (resolve/main/<file>)
 * @property {number} sizeBytes   - approximate total download size
 * @property {ModelFile[]} files  - files comprising the CT2 model directory
 */

/** @type {TranscriptionModel[]} */
export const MODEL_REGISTRY = [
  {
    id: 'small',
    label: 'Small (szybki, ~480 MB)',
    repo: 'Systran/faster-whisper-small',
    sizeBytes: 486_212_372,
    files: [
      { name: 'config.json', sizeBytes: 2_370, sha256: '' },
      {
        name: 'model.bin',
        sizeBytes: 483_546_902,
        sha256:
          '3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671',
      },
      { name: 'tokenizer.json', sizeBytes: 2_203_239, sha256: '' },
      { name: 'vocabulary.txt', sizeBytes: 459_861, sha256: '' },
    ],
  },
  {
    id: 'medium',
    label: 'Medium (zbalansowany, ~1.5 GB)',
    repo: 'Systran/faster-whisper-medium',
    sizeBytes: 1_530_571_735,
    files: [
      { name: 'config.json', sizeBytes: 2_257, sha256: '' },
      {
        name: 'model.bin',
        sizeBytes: 1_527_906_378,
        sha256:
          '9b45e1009dcc4ab601eff815b61d80e60ce3fd8c74c1a14f4a282258286b51ae',
      },
      { name: 'tokenizer.json', sizeBytes: 2_203_239, sha256: '' },
      { name: 'vocabulary.txt', sizeBytes: 459_861, sha256: '' },
    ],
  },
  {
    id: 'large-v3',
    label: 'Large-v3 (najlepsza jakość, ~3 GB)',
    repo: 'Systran/faster-whisper-large-v3',
    sizeBytes: 3_090_835_702,
    files: [
      { name: 'config.json', sizeBytes: 2_394, sha256: '' },
      {
        name: 'model.bin',
        sizeBytes: 3_087_284_237,
        sha256:
          '69f74147e3334731bc3a76048724833325d2ec74642fb52620eda87352e3d4f1',
      },
      { name: 'preprocessor_config.json', sizeBytes: 340, sha256: '' },
      { name: 'tokenizer.json', sizeBytes: 2_480_617, sha256: '' },
      { name: 'vocabulary.json', sizeBytes: 1_068_114, sha256: '' },
    ],
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
