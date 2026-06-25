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
 * @property {ModelFile[]} files  - files comprising the model directory
 * @property {('whisperx-ct2'|'cohere-transformers')} [kind] - engine that loads
 *   this model; defaults to 'whisperx-ct2' (faster-whisper CT2) when omitted.
 * @property {string} [sentinel]  - file whose presence marks the model "ready"
 *   ('model.bin' for CT2, 'model.safetensors' for Cohere); defaults to 'model.bin'.
 * @property {boolean} [gated]    - true for HF gated repos that require an accepted
 *   license + a Bearer HF token at download time (Cohere). Public CT2 repos omit it.
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
  {
    // Distilled large-v3 (4-layer decoder): near-large-v3 quality at ~2× speed,
    // ~1.6 GB. Same CT2 file layout as large-v3. Manifest from the HF tree API
    // (deepdml/faster-whisper-large-v3-turbo-ct2, verified 2026-06-13); the
    // model.bin sha256 is its LFS blob oid.
    id: 'large-v3-turbo',
    label: 'Large-v3-turbo (szybki, jakość ≈ large-v3, ~1.6 GB)',
    repo: 'deepdml/faster-whisper-large-v3-turbo-ct2',
    sizeBytes: 1_621_665_983,
    files: [
      { name: 'config.json', sizeBytes: 2_263, sha256: '' },
      {
        name: 'model.bin',
        sizeBytes: 1_617_884_929,
        sha256:
          'e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da',
      },
      { name: 'preprocessor_config.json', sizeBytes: 340, sha256: '' },
      { name: 'tokenizer.json', sizeBytes: 2_710_337, sha256: '' },
      { name: 'vocabulary.json', sizeBytes: 1_068_114, sha256: '' },
    ],
  },
  {
    // Cohere `cohere-transcribe-03-2026` (2B Conformer ASR, Apache-2.0) run
    // OFFLINE inside the whisperx-engine sidecar via NATIVE transformers ≥5.4.0
    // (no trust_remote_code). Unlike the CT2 entries above this is a
    // transformers model dir, so its readiness sentinel is `model.safetensors`,
    // not `model.bin`. The manifest is the NATIVE set — the four `*_cohere_asr.py`
    // remote-code modules are deliberately NOT listed (transformers resolves
    // `cohere_asr` internally). The repo is GATED (`gated: auto`): the user must
    // accept the license once on the HF page and the download must send a Bearer
    // HF token (models.rs `download_model` hf_token param). Sizes + the
    // model.safetensors sha256 (its LFS oid) come from the HF tree API.
    id: 'cohere-pl',
    label: 'Cohere (Polski, offline)',
    repo: 'CohereLabs/cohere-transcribe-03-2026',
    kind: 'cohere-transformers',
    sentinel: 'model.safetensors',
    gated: true,
    sizeBytes: 4_134_229_509,
    files: [
      { name: 'config.json', sizeBytes: 3_998, sha256: '' },
      { name: 'generation_config.json', sizeBytes: 234, sha256: '' },
      {
        name: 'model.safetensors',
        sizeBytes: 4_131_862_976,
        sha256:
          '987bd3e141c7bfdb5a78f5db11397ee7737308357e6cc0a3f36a4979b158137a',
      },
      { name: 'preprocessor_config.json', sizeBytes: 420, sha256: '' },
      { name: 'processor_config.json', sizeBytes: 131, sha256: '' },
      { name: 'special_tokens_map.json', sizeBytes: 4_091, sha256: '' },
      { name: 'tokenizer.json', sizeBytes: 1_816_694, sha256: '' },
      { name: 'tokenizer.model', sizeBytes: 492_827, sha256: '' },
      { name: 'tokenizer_config.json', sizeBytes: 48_138, sha256: '' },
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
