// Documented schema for the declarative heavy-dependency spec (`deps-spec.json`).
//
// This spec drives the thin-installer first-run download of the heavy native
// deps — the CUDA/CPU WhisperX engine variants, FFmpeg, and the wav2vec2 align
// models — that were previously bundled into the ~4 GB installer. It is the
// hardware-variant sibling of `src/transcription/model-registry.js`.
//
// SOURCE-OF-TRUTH BOUNDARY (F4): this spec covers ONLY the heavy hardware-variant
// deps — `engine`, `ffmpeg`, `align-models`. Transcription MODELS stay authored
// in `src/transcription/model-registry.js` and are downloaded via the model
// dropdown; deps-spec does NOT enumerate models and there is no `model` kind. The
// download *core* is shared (see `src-tauri/src/deps.rs` + `models.rs`), but the
// two specs are never both a source of truth for the same artifact.
//
// TRUST ANCHOR: the copy shipped inside the code-signed installer
// (`deps-spec.json`, embedded via `include_str!` in `deps.rs`) is authoritative
// for integrity. A remote `deps.json` may re-point an artifact's `url` or add new
// dependency ids, but for any `id` already present in the embedded copy the
// embedded `sha256`/`version` win (see `deps.rs::merge_specs`).
//
// HARD INTEGRITY CONSTRAINT (F2): unlike the model registry — where the small
// git-blob JSON files carry `sha256: ''` and verification is skipped — EVERY
// `sha256` under an `engine`/`ffmpeg`/`align-models` entry (both a single-file
// `sha256` and every `files[].sha256`) MUST be a non-empty pinned digest in a
// RELEASED spec. These artifacts are executables and torch-loaded align files: a
// code-execution surface. The Rust downloader (`download_dependency`) fail-closes
// on an empty hash for these kinds and refuses to stage the artifact. (An empty
// hash in the checked-in stub therefore means "not yet pinned — do not download.")

/**
 * @typedef {Object} DepFile
 * @property {string} name       - file path within the staged dir (single normal
 *   segment or forward-slash-joined relative path; never `..`/absolute)
 * @property {number} sizeBytes  - file size (feeds aggregate %/ETA)
 * @property {string} sha256     - expected lowercase-hex digest; MUST be non-empty
 *   in a released spec (empty ⇒ downloader refuses to stage)
 */

/**
 * @typedef {Object} Dependency
 * @property {string} id            - stable logical id (also the installed-manifest key)
 * @property {('engine'|'ffmpeg'|'align-models')} kind - dependency class
 * @property {('windows'|'macos')} platform - target OS
 * @property {string} arch          - target arch (`x86_64` | `aarch64`)
 * @property {('gpu'|'cpu'|'any')} variantPredicate - hardware variant this entry
 *   satisfies; `any` is required regardless of the resolved variant
 * @property {string} [url]         - single-file artifact URL (mutually exclusive
 *   with repo+files)
 * @property {string} [repo]        - base URL/repo for a multi-file artifact
 * @property {DepFile[]} [files]    - files comprising a multi-file artifact dir
 * @property {number} sizeBytes     - total artifact size (feeds %/ETA + free-space check)
 * @property {string} [sha256]      - single-file expected digest; MUST be non-empty
 *   in a released spec for these kinds (see HARD INTEGRITY CONSTRAINT)
 * @property {string} version       - artifact version; a bump vs the recorded
 *   installed version marks the staged copy stale → targeted re-download
 * @property {string} [sentinel]    - presence marker relative to the staged slot;
 *   for single-file kinds this is the staged file name; for `align-models` a file
 *   within the staged dir (empty ⇒ presence = staged dir exists)
 * @property {('engine-bin'|'ffmpeg-bin'|'align-models')} stageTo - logical staging
 *   slot; `deps.rs::staged_path` maps it to a concrete path under the deps root
 */

/**
 * @typedef {Object} DepsSpec
 * @property {number} specVersion
 * @property {Dependency[]} dependencies
 */

// The canonical spec document lives in `deps-spec.json` (embedded in the Rust
// binary as the offline/host-down fallback + integrity anchor). This file exists
// purely to document its shape in the same JSDoc-typedef style as
// `model-registry.js`; there is no runtime JS consumer of the spec (the resolver
// and downloader are entirely in Rust — `src-tauri/src/deps.rs`).
export {};
