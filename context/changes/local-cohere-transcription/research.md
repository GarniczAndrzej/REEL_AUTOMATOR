---
date: 2026-06-24T23:40:00+02:00
researcher: Claude (Opus 4.8)
git_commit: 32a5c2097338eff2cbff64d1d06c2810ed4ea3f6
branch: master
repository: REEL_AUTOMATOR
topic: "Add Cohere transcription and integrate it into the WhisperX pipeline (Cohere = raw transcript, WhisperX = word alignment)"
tags: [research, codebase, whisper, transcription, alignment, cohere, providers, sidecar]
status: complete
last_updated: 2026-06-24
last_updated_by: Claude (Opus 4.8)
---

# Research: Add Cohere transcription, integrated into the WhisperX pipeline

**Date**: 2026-06-24T23:40:00+02:00
**Researcher**: Claude (Opus 4.8)
**Git Commit**: 32a5c2097338eff2cbff64d1d06c2810ed4ea3f6
**Branch**: master
**Repository**: REEL_AUTOMATOR

## Research Question

Add **Cohere** as a transcription provider and integrate it into the existing
WhisperX pipeline. Agreed scope (clarified up front): **Cohere produces the raw
transcript; WhisperX still performs word-level forced alignment** so downstream
frame math is unchanged. Comprehensive map of the transcription→alignment seam
(Rust + frontend + state + caching) plus external verification of the Cohere API.

## Summary

- **Cohere Transcribe is real** (`cohere-transcribe-03-2026`, 2B-param Conformer
  ASR, **14 languages incl. Polish**, Apache-2.0, downloadable open weights).
  Cloud endpoint: `POST https://api.cohere.com/v2/audio/transcriptions`
  (multipart `model`/`language`/`file`, Bearer auth, ≤25 MB, flac/mp3/mpeg/mpga/ogg/wav).
- **The cloud response is plain text only** — schema is `{ "text": string }`,
  **no segments, no word/segment timestamps**. This makes the "keep WhisperX for
  alignment" design a **requirement, not a preference**: Cohere supplies words,
  WhisperX supplies all timing.
- **The integration seam already exists**: `align_transcript` (`whisper.rs:699`)
  force-aligns an *imported* transcript to audio and returns the **exact same**
  `{srt_content, words, segments, language}` payload as `transcribe_video`. A
  Cohere transcript can flow straight into the existing align → `mergeWordsIntoSentences`
  → `state.sentences` path with no exporter/state changes downstream.
- **The one real gap**: `align_transcript`'s engine mode (`--align-only`) parses
  its input with an **SRT/VTT cue regex** (`whisperx_engine.py:434`,
  `_read_transcript_segments`). Cohere returns an undifferentiated blob with no
  cue lines, so it cannot be fed directly. We must either (a) wrap the blob as a
  single full-duration SRT cue, (b) sentence-split into pseudo-timed cues, or
  (c) add a plain-text mode to the engine. This is the central design decision
  for `/10x-plan`.
- **Adding the provider credential is trivial**: one entry in `PROVIDERS`
  (`src/ai/api-key.js:19`) reuses the entire Keychain stack (`keychain.rs`,
  service `reel-automator`, account = provider id). No backend credential work.
- **Hard constraints to design around**: 25 MB file cap (≈13 min of the app's
  current 16 kHz mono WAV — webinars overflow it; needs compressed encode and/or
  chunking), free-tier **rate limits** (production = paid Model Vault), and
  **no language auto-detect** (Cohere needs an explicit ISO-639-1 code; the app's
  `'auto'` default must map to a concrete language).
- **Unresolved interpretation**: the change-id is `local-cohere-transcription`.
  "Local" may mean running the **open-weights model in the sidecar** (offline, no
  25 MB/rate limits, but multi-GB weights — collides with the onefile lesson)
  rather than the cloud API. See Open Questions §1 — this changes the whole plan.

## Detailed Findings

### A. Cohere Transcribe — external verification (exa.ai + Cohere docs)

**Product** (docs.cohere.com/docs/transcribe):
- Model id `cohere-transcribe-03-2026`, 2B params, Conformer encoder → lightweight
  Transformer decoder, audio-in / text-out.
- 14 languages: English, German, French, Italian, Spanish, Portuguese, Greek,
  Dutch, **Polish**, Vietnamese, Chinese, Arabic, Japanese, Korean.
- Max file size **25 MB**. License **Apache 2.0**. Open weights on HuggingFace
  (`CohereLabs/cohere-transcribe-03-2026`), runnable locally via Transformers
  (16 kHz audio input).
- Access: free via API (rate-limited); production via paid **Model Vault**.

**Cloud API** (docs.cohere.com/reference/create-audio-transcription — OpenAPI):
- `POST https://api.cohere.com/v2/audio/transcriptions`, `multipart/form-data`.
- Request fields: `model` (req), `language` (req, ISO-639-1 — **no auto-detect**),
  `file` (req; flac/mp3/mpeg/mpga/ogg/wav), `temperature` (optional 0–1).
- Auth: `Authorization: Bearer <key>` header.
- **200 response schema (verbatim)**:
  ```yaml
  audio_transcriptions_create_Response_200:
    properties:
      text: { type: string, description: "The transcribed text." }
    required: [text]
  ```
  → **plain text only. No timestamps, no segments, no words.**
- Python SDK path exists: `co = cohere.ClientV2(api_key)` →
  `co.audio.transcriptions.create(model=..., language=..., file=...)`. (We'd call
  the REST endpoint directly from JS via `fetch`, mirroring `callOpenRouter`.)

### B. The WhisperX transcription pipeline (backend, `src-tauri/src/`)

**`transcribe_video`** (`whisper.rs:370-583`) — the full ASR command:
- Params (flat, snake_cased from the JS invoke): `video_path`, `model_path?`,
  `model_id?`, `language`, `diarize?`, `hf_token?`, plus the Phase-7 advanced bag
  (`device`, `compute_type`, `beam_size`, `initial_prompt`, `vad_onset`,
  `vad_offset`, `min_speakers`, `max_speakers`).
- Flow: resolve model dir (`whisper.rs:397`) → settings-aware cache lookup
  (`whisper.rs:440-456`) → FFmpeg extracts **16 kHz mono pcm_s16le WAV**
  (`whisper.rs:469-475`) → drive the `whisperx-engine` sidecar (`whisper.rs:541`)
  → parse normalized engine JSON → build payload.
- **Return payload** (`whisper.rs:566-571`):
  `{ srt_content, words: [{text,start,end(,speaker)}], segments: [...], language }`.
  `srt_content` is derived from segments (`build_srt_from_segments`,
  `whisper.rs:79`); `words` are flattened seconds-domain (`flatten_words`,
  `whisper.rs:106`). The engine does transcription **and** alignment in one run.

**`drive_engine`** (`whisper.rs:292-368`) — the shared spawn/poll/cancel loop used
by both commands. Registers the child in a global `TRANSCRIBE_CHILD` mutex, pumps
stdout/stderr, parses `PROGRESS phase=… percent=…` lines into `transcribe-progress`
events, bounds stderr to a 64 KB tail (S-21 OOM fix), and reaps on cancel.

**Caching** (`whisper.rs:201-250`): `whisper-cache/v2/<hash>.json` where
`hash = variant_key(video_hash, run_sig)` — `video_hash` = file size + mtime +
SHA-256 of first 1 MB (`compute_video_hash:35`); `run_sig` folds model/language/
diarize/advanced knobs. Legacy whisper.cpp `<hash>.{srt,json}` entries still read
via fallback (`read_cache:214`). **A Cohere run would key its cache on
`(video_hash, {provider:'cohere', model, language})`** so a Cohere transcript and
a WhisperX transcript of the same clip never collide.

**Sidecar / FFmpeg plumbing**: `engine.rs` — `ENGINE_SIDECAR = "whisperx-engine"`
(`engine.rs:16`), `with_hf_offline` (`engine.rs:38`), `align_model_dir`
(`engine.rs:54`). FFmpeg via `ffmpeg::run_ffmpeg_output`. Both sidecars +
`align_models/` are git-ignored (see lessons / memory).

**Command registration**: all in `lib.rs:36-59` (`transcribe_video`,
`align_transcript`, `cancel_transcription`, engine checks, models, keychain).

### C. The alignment seam — THE integration point

**`align_transcript`** (`whisper.rs:699-812`) is the existing "align an external
transcript" command and the natural home for Cohere output:
- Params: `video_path`, **`transcript: String`**, `language`, `is_vtt?`, `device?`.
- Flow: write `transcript` to a temp `.srt`/`.vtt` (`whisper.rs:718-722`) → FFmpeg
  extract WAV → drive engine with `--align-only --transcript <file> --language …`
  (`whisper.rs:746-751`) → return **the same** `{srt_content, words, segments,
  language}` shape (`whisper.rs:806-811`).
- `language=='auto'` falls back to `pl` (`whisper.rs:744`) — Polish-first; the
  bundled wav2vec2 align model is `pl`.

**Engine side** (`sidecar/whisperx_engine/whisperx_engine.py`):
- `cmd_align_only` (`:460`) → `_read_transcript_segments(path, language)` (`:434`)
  → `_align(...)` (`:277`) → `_normalize(...)` (`:305`).
- `_align` calls `whisperx.align(segments, align_model, metadata, audio, device)`
  — forced alignment of **`{start, end, text}` segments**; words get start/end/score
  back, normalized to `{text,start,end,score,speaker}`.
- **`_read_transcript_segments` is SRT/VTT-only** (`:448-456`): a regex
  `HH:MM:SS,mmm --> HH:MM:SS,mmm` keyed parser. Empty parse → `EXIT_USAGE`
  ("no segments parsed from transcript"). **This is the wall Cohere's plain-text
  blob hits.**

**Frontend already drives this seam**: `alignToWords()`
(`src/ui/import/transcribe.js:575-655`) calls
`invoke('align_transcript', { videoPath, transcript: state.srtContent, language,
isVtt, device })`, then `mergeWordsIntoSentences(state.sentences, result.words, fps)`
→ `renderSegments()`. A Cohere path reuses this verbatim once it has a transcript
that the engine can parse.

### D. Frontend transcription orchestration + state

- **Trigger chain**: `transcribeWithWhisper()` (`transcribe.js:807`) →
  `transcribeDocument({videoPath, modelId, language, diarize, hfToken, fps,
  ...whisperAdvancedArgs()})` (`transcribe.js:728`) → `invoke('transcribe_video')`.
  Returns `{srt_content, words, segments}`; segments → `segmentFromWords(...)` →
  `state.sentences` (`transcribe.js:788-794`).
- **Where a Cohere toggle plugs in**: `transcribeWithWhisper` is the branch point.
  A provider selector (`state.transcribeProvider: 'whisperx' | 'cohere'`) would
  route to either the current path or a new `transcribeWithCohere()` that:
  (1) extracts/encodes audio, (2) POSTs to Cohere, (3) turns `text` into a
  transcript the align seam accepts, (4) calls the align path, (5) merges words.
- **Relevant `state` fields** (`src/state.js`): `srtContent`, `srtName`,
  `sentences` (`Sentence[]` typedef `:11`), `fps`, `videoFilename`, `videoPath`,
  `_whisperVideoPath` (transient picker path), `modelId`, `whisperLanguage`
  (default `'pl'`), `diarize`, `whisperAdvanced{…}`, `_srtIsVtt`. The `Word`
  typedef (`:1`) is the aligned shape. **No transcription-provider field exists
  yet** — only the OpenRouter LLM picker (`orSelectedModel`, `aiModels`) is
  provider-aware, and that's for analysis, not transcription.
- **Model manager** (`transcribe.js:202-367`) is WhisperX-specific (faster-whisper
  CT2 dirs from `src/transcription/model-registry.js`). Cohere cloud needs **no**
  local model → the picker/model-manager is bypassed on the Cohere path (a local
  Cohere model, by contrast, would need a registry entry — see Open Q §1).
- **No standalone align trigger beyond `alignToWords`**: alignment is either inside
  `transcribe_video` (WhisperX path) or via the manual "Dopasuj do audio" button /
  word-SRT auto-align fallback. A Cohere run would call the align path itself.

### E. Credential + provider abstraction

- **API keys** (`src/ai/api-key.js`): `getApiKey(provider)` (sync, cache read,
  `:43`), `setApiKey(provider, key)` (async write-through, `:56`),
  `hydrateKeys()` (boot hydrate + one-time localStorage→Keychain migration, `:78`).
  **`const PROVIDERS = ['openrouter', 'huggingface']` (`:19`)** — the comment
  literally says "one line to add more". **Adding `'cohere'` here is the entire
  credential change**; the Keychain backend (`keychain.rs` get/set/delete, service
  `reel-automator`, account = provider) is already generic.
- **HF token is the precedent** for a second provider key driving transcription
  (used by diarization): UI input in `transcribe.js:54,66-68`, threaded as
  `hfToken` and passed to the engine via `HF_TOKEN` env (`whisper.rs:536`). A
  Cohere key would follow the same UI+plumbing pattern, but as a network header.
- **Provider call shape to mirror**: `callOpenRouter(apiKey, …)`
  (`src/ai/providers.js:19`) — `fetch` with `Authorization: 'Bearer ' + apiKey`,
  Polish error messages, JSON error extraction. A `callCohereTranscribe(apiKey,
  audioBlob, language)` would live alongside it (multipart instead of JSON).
- **Disk-cache wrapper**: `withLlmCache(cacheKey, callFn)` (`src/ai/cache.js:17`)
  caches only a content string keyed by SHA-256. It's shaped for LLM text; the
  Cohere transcript (a string) could reuse it, but the backend `whisper-cache`
  (§B) is the more natural home since it's already audio/settings-addressed.

### F. The critical gap + candidate approaches (Cohere text → alignable input)

`align_transcript` needs SRT/VTT; Cohere gives `{text}`. Options for `/10x-plan`:

1. **Single full-duration cue (smallest change, frontend-only)**: build
   `1\n00:00:00,000 --> <audio_dur>\n<text>\n\n` and pass as `transcript`.
   *Pro*: zero engine change, reuses `align_transcript` as-is. *Con*: needs audio
   duration — **`VideoMeta` has no duration** (`metadata.rs:12`, only fps/w/h), so
   we'd add a duration probe (ffprobe/FFmpeg). *Risk*: WhisperX aligns words
   within a single huge segment window — for long webinars this can be slow /
   memory-heavy / lower-quality; WhisperX historically prefers bounded segments.
2. **Sentence-split into pseudo-timed cues (frontend-only)**: split `text` into
   sentences, distribute evenly across duration, emit a multi-cue SRT. *Pro*: no
   engine change; bounded segment windows → better/faster alignment than (1).
   *Con*: pseudo-boundaries are guesses; `whisperx.align` clamps words to each
   cue's window, so a bad split can mis-time words near boundaries.
3. **New engine plain-text mode (`--transcript-text` / stdin)**: teach
   `cmd_align_only` to accept a raw transcript and build one full-audio segment
   internally (the engine already knows `audio` length via `_load_audio`). *Pro*:
   cleanest contract, no fake timestamps, no duration probe in Rust. *Con*: edits
   the frozen sidecar → a **sidecar rebuild** (`sidecar/build.sh`) and the 37–67 s
   cold-spawn / packaging discipline apply.

Recommendation to validate in planning: start with (1) or (3); (3) is more robust
for long content and avoids the frontend fabricating timing it doesn't have.

### G. Constraints to design around

- **25 MB cap**: current extraction is 16 kHz mono pcm_s16le WAV ≈ 1.92 MB/min →
  ~13 min ceiling. Webinars (the core use case — default prompt: "z tego webinaru")
  exceed it. Mitigations: encode to mp3/ogg (mono, low bitrate ≈ 0.24 MB/min →
  ~100 min) via the FFmpeg sidecar, and/or **chunk** the audio and stitch the text
  (chunking adds a stitch step + complicates caching/alignment windows).
- **Rate limits**: free API key is rate-limited; sustained/production use →
  paid Model Vault. Surface a Polish error on 429 (`TooManyRequestsError`).
- **No auto language detect**: Cohere requires an explicit ISO-639-1 code. The
  app's `whisperLanguage` defaults to `'pl'` but supports `'auto'` — map `'auto'`
  to a concrete language (default `pl`) before calling Cohere.
- **Cold-spawn still applies to the align step**: even on the Cohere path,
  WhisperX alignment spawns the sidecar (37–67 s cold — S-18 / memory
  `whisperx-cold-spawn-cost`). Keep it off any launch/critical path; it runs only
  on an explicit transcription action.

## Code References

- `src-tauri/src/whisper.rs:370` — `transcribe_video` (full ASR; payload shape `:566`)
- `src-tauri/src/whisper.rs:699` — `align_transcript` (**the integration seam**; transcript: String)
- `src-tauri/src/whisper.rs:292` — `drive_engine` (shared spawn/poll/cancel)
- `src-tauri/src/whisper.rs:201-250` — `variant_key` / `read_cache` / `write_cache` (whisper-cache v2)
- `src-tauri/src/whisper.rs:79,106` — `build_srt_from_segments`, `flatten_words` (payload derivation)
- `sidecar/whisperx_engine/whisperx_engine.py:434` — `_read_transcript_segments` (**SRT/VTT-only regex** — the gap)
- `sidecar/whisperx_engine/whisperx_engine.py:460` — `cmd_align_only`; `:277` `_align`; `:305` `_normalize`
- `src-tauri/src/lib.rs:36-59` — Tauri command registration
- `src-tauri/src/keychain.rs:18-43` — get/set/delete_credential (service `reel-automator`)
- `src-tauri/src/engine.rs:16,38,54` — `ENGINE_SIDECAR`, `with_hf_offline`, `align_model_dir`
- `src-tauri/src/metadata.rs:12` — `VideoMeta` (fps/width/height — **no duration**)
- `src/ui/import/transcribe.js:807` — `transcribeWithWhisper` (provider branch point)
- `src/ui/import/transcribe.js:728` — `transcribeDocument` (DOM-free unit, returns transcript)
- `src/ui/import/transcribe.js:575` — `alignToWords` (drives `align_transcript`; merges words)
- `src/ai/api-key.js:19` — `PROVIDERS` array (**one-line credential add**)
- `src/ai/api-key.js:43,56,78` — `getApiKey`/`setApiKey`/`hydrateKeys`
- `src/ai/providers.js:19` — `callOpenRouter` (network-call pattern to mirror)
- `src/ai/cache.js:17` — `withLlmCache` (string disk cache)
- `src/state.js:1,11` — `Word` / `Sentence` typedefs; `:152-173` transcription state fields
- `src/transcription/model-registry.js` — WhisperX CT2 model registry (Cohere-local would extend this)

## Architecture Insights

- **The pipeline is already provider-shaped at the seam, not at the trigger.** The
  exporters, segmentation, state, and `align_transcript` are all transcript-source
  agnostic — they consume `{srt_content, words, segments}`. The only place that is
  WhisperX-specific is *transcription itself*. So the clean cut is: add a second
  transcription producer that converges on the **same align input** and the **same
  output payload**. Everything downstream is untouched.
- **Plain-text ASR forces a "transcribe elsewhere, time it here" split.** Because
  Cohere returns no timing, WhisperX alignment is load-bearing — exactly the
  agreed design. This is architecturally clean (single timing authority = the
  bundled `pl` wav2vec2 model) and keeps the integer-frame invariant intact, since
  words still arrive via `mergeWordsIntoSentences(..., fps)`.
- **Credential + caching infra is already generic** (Keychain by provider id;
  content/settings-addressed disk caches). The cost is concentrated in two new
  pieces: the Cohere network call (multipart, errors, 25 MB/rate-limit handling)
  and the **text→alignable-input bridge** (§F).

## Historical Context (from prior changes)

- `context/archive/2026-06-12-builtin-whisperx-transcription/` (S-05) — built the
  WhisperX sidecar, model manager, word alignment, opt-in diarization. **Packaging
  deviation**: baking the 2.4 GB align model into the PyInstaller onefile produced
  an unloadable 2.6 GB Mach-O; fix = ship `align_models/` beside the binary
  (`bundle.resources`, `--align-model-dir`). **Directly relevant** if "local
  Cohere" means bundling 2B open weights (Open Q §1).
- `context/archive/2026-06-16-s-18/` (S-18) — every sidecar spawn costs 37–67 s
  cold; launch badge is cache-read-only. The Cohere path's align step inherits
  this — keep it off the critical path.
- `context/archive/2026-06-19-app-crash-fix/` (S-21) — bounded `stderr_buf`,
  single-reaper cancel, `[PANIC]` hook. Any new sidecar invocation must respect
  the single-reaper / cancel discipline in `drive_engine`.
- `context/archive/2026-06-18-keychain-credentials/` (S-11) — the Keychain stack a
  Cohere key reuses; lesson: `keyring` 3.x needs `apple-native` enabled (already
  is). See memory `keyring-needs-apple-native`.
- `context/foundation/roadmap.md` — parked **"A/B provider comparison + merge"**
  and **"Two-stage long-form chunking"** (the latter promoted for *AI analysis* in
  S-25). A Cohere transcription provider is adjacent to the parked A/B-provider
  idea but is a distinct, transcription-layer change.

## Related Research

- `context/archive/2026-06-12-builtin-whisperx-transcription/research.md` — original
  WhisperX integration research (engine contract, packaging).
- `context/archive/2026-06-22-auto-mode-pipeline/research.md` — how transcription
  fits the one-click auto pipeline (a Cohere path must also slot into auto-mode's
  `stages.transcription`).

## Open Questions

1. **"Local" Cohere vs cloud API — decide before planning.** The change-id is
   `local-cohere-transcription`, and Cohere Transcribe ships **open weights**
   (Apache-2.0, HF `CohereLabs/cohere-transcribe-03-2026`). Does "local" mean:
   (a) **cloud API** (`api.cohere.com`, this research's default — needs a key,
   25 MB cap, rate limits, online), or (b) **the open model running offline in the
   sidecar** (no caps/limits/online, but ~multi-GB weights → collides with the
   onefile lesson; needs a model-manager registry entry + a new engine mode)?
   These are very different plans. **Recommend confirming with the user.**
2. **Text→align bridge** (§F): single full-duration cue (needs a duration probe),
   pseudo-timed sentence cues, or a new engine plain-text mode? Affects whether the
   sidecar must be rebuilt.
3. **Long audio > 25 MB (cloud path only)**: compressed encode alone, or chunk +
   stitch? Chunking complicates the align windows and caching.
4. **Where does the provider toggle live** — the Step-1 WhisperX box, or the
   settings modal alongside the OpenRouter picker? And does the Cohere path expose
   any of the WhisperX advanced knobs (most are ASR-only and irrelevant; only the
   align `device` override carries over)?
5. **Caching**: reuse the backend `whisper-cache/v2` keyed by
   `(video_hash, {provider:'cohere', model, language})`, or a separate store? The
   v2 scheme already supports this via `run_sig`.
