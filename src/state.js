/**
 * A single word with frame-converted timing, produced by the WhisperX engine's
 * forced alignment and persisted on its sentence (.reelproj schema v4).
 * @typedef {Object} Word
 * @property {string} text
 * @property {number} start_frame
 * @property {number} end_frame
 * @property {string} [speaker] - diarization speaker label (opt-in, additive)
 */

/**
 * A parsed transcript segment. Produced by `parseSRT`/`parseVTT` (imported
 * transcripts) and by `segmentFromWords` (engine output); both converge on this
 * shape, consumed by the exporters and the reel editor.
 * @typedef {Object} Sentence
 * @property {number} id
 * @property {string} text
 * @property {number} start_frame
 * @property {number} end_frame
 * @property {number} duration_frame
 * @property {string} start_tc
 * @property {string} end_tc
 * @property {number} [source_idx] - F18 multi-source index (0 = primary)
 * @property {Word[]} [words] - word-level timings (engine/align path only)
 */

import { DEFAULT_SCORING_GUIDANCE } from './ai/prompt.js';

/**
 * A scored reel produced by AI selection (S-01). All scored fields are
 * optional for backward-compat — older projects / providers may omit them.
 * @typedef {Object} Reel
 * @property {string} reel_name
 * @property {number[]} clip_ids - sentence ids selected for this reel
 * @property {number} [virality_score] - overall 0–100
 * @property {{hook:number, flow:number, value:number, trend:number}} [scores] - axis sub-scores
 * @property {string} [reason] - one-sentence justification
 * @property {{hook?:number, body?:number, punchline?:number}} [markers] - each value is a member of clip_ids
 */

export const state = {
  // step 1
  srtName: null,
  srtContent: null,
  fps: 25,
  videoFilename: '',
  gapFrames: 60,
  sentences: [],

  // step 2
  userPrompt: `Stwórz viralowe reelsy sprzedażowe z tego webinaru.

Zasady:
- Każdy Reel: HOOK (mocny wstęp) → BODY (rozwinięcie) → CTA (wezwanie do działania)
- Długość: 30–90 sekund
- Możesz zmieniać kolejność segmentów zachowując logiczny sens
- Szukaj emocjonalnych momentów, konkretnych liczb, historii i CTA
- Stwórz tyle Reelsów ile możesz z wartościowego materiału`,
  // FR-015: editable global scoring guidance. Defaults to the machine guidance;
  // boot override comes from loadSettings(); round-trips in .reelproj v6.
  systemPrompt: DEFAULT_SCORING_GUIDANCE,
  reelsData: [],

  // step 3
  videoPath: '',
  videoResolution: '1920x1080',
  projectName: 'Reels',
  mergeThreshold: 12,
  edlContent: '',
  xmlContent: '',
  luaContent: '',

  // openrouter
  orAllModels: [],
  orSelectedModel: null,

  // Phase 4 F1 / S-05 model manager
  modelId: '', // selected managed faster-whisper model id (S-05)
  whisperLanguage: 'pl',
  diarize: false, // opt-in speaker diarization (S-05 Phase 6)

  // S-05 Phase 7 — WhisperX advanced-settings modal. A minimal high-value
  // subset of engine tuning knobs; omitted/empty values fall back to the
  // engine's defaults (untouched modal = no behavior change). The perf/device
  // knobs (device, computeType) are persisted PER-MACHINE in localStorage
  // (`edl_whisper_advanced`), never in .reelproj; the rest are live in state.
  whisperAdvanced: {
    device: '', // '' = auto, 'cpu' = wymuś CPU
    computeType: '', // '' = domyślny (float16 GPU / int8 CPU); float16|int8|int8_float16|float32
    beamSize: null, // null = domyślny (5)
    initialPrompt: '', // '' = brak
    vadOnset: null, // null = domyślny (0.5)
    vadOffset: null, // null = domyślny (0.363)
    minSpeakers: null, // diaryzacja: null = auto
    maxSpeakers: null, // diaryzacja: null = auto
  },
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit() {
  listeners.forEach((fn) => fn(state));
}
