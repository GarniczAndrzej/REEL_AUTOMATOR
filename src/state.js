export const state = {
  // step 1
  srtName: null,
  srtContent: null,
  fps: 25,
  videoFilename: '',
  gapFrames: 60,
  minChars: 20,
  sentences: [],

  // step 2
  userPrompt: `Stwórz viralowe reelsy sprzedażowe z tego webinaru.

Zasady:
- Każdy Reel: HOOK (mocny wstęp) → BODY (rozwinięcie) → CTA (wezwanie do działania)
- Długość: 30–90 sekund
- Możesz zmieniać kolejność segmentów zachowując logiczny sens
- Szukaj emocjonalnych momentów, konkretnych liczb, historii i CTA
- Stwórz tyle Reelsów ile możesz z wartościowego materiału`,
  currentProvider: 'gemini',
  reelsData: [],

  // step 3
  videoFilename2: '',
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

  // Phase 4 F1
  whisperModelPath: '',
  whisperLanguage: 'pl',

  // F18 — additional video sources (source 0 = state.videoPath / state.srtContent)
  sources: [], // [{videoFilename, videoPath, srtName, srtContent}] for sources index 1+
};

const listeners = new Set();
export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
export function emit() {
  listeners.forEach((fn) => fn(state));
}
