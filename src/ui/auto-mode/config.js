// Auto-mode stage + output config (S-07, Phase 3). Renders the stage checkboxes
// (Transkrypcja / Segmentacja / Analiza AI / Eksport) and the output multi-select
// (text: SRT / VTT / .md / słowo-JSON; timeline: EDL / XML / Lua) into the
// floating panel, writing the selection into `state.autoMode.stages/outputs`.
// Dependencies are auto-enforced: invalid combos are greyed out (and cleared from
// state), not silently dropped. Transcription is one toggle — it always carries
// its alignment + optional diarization + word settings from the Step-1 WhisperX
// box; there are no separate align/diarize toggles. All strings are Polish.

import { state, emit } from '../../state.js';
import { getApiKey } from '../../ai/api-key.js';

/** @type {{id:string,label:string}[]} */
const STAGE_DEFS = [
  { id: 'transcription', label: 'Transkrypcja' },
  { id: 'segmentation', label: 'Segmentacja' },
  { id: 'analysis', label: 'Analiza AI' },
  { id: 'export', label: 'Eksport' },
];
/** @type {{id:string,label:string}[]} */
const TEXT_OUTPUTS = [
  { id: 'srt', label: 'SRT' },
  { id: 'vtt', label: 'VTT' },
  { id: 'md', label: '.md' },
  { id: 'wordJson', label: 'słowo-JSON' },
];
/** @type {{id:string,label:string}[]} */
const TIMELINE_OUTPUTS = [
  { id: 'edl', label: 'EDL' },
  { id: 'xml', label: 'XML' },
  { id: 'lua', label: 'Lua' },
];

/** @type {HTMLElement|null} */
let rootEl = null;
// Force-disable every control while a run is live (read-only-during-run).
let configLocked = false;

function hasVideo() {
  return !!state._whisperVideoPath;
}
function hasTranscript() {
  return state.sentences.length > 0 || !!state.srtContent;
}
function hasReels() {
  return state.reelsData.length > 0;
}

/**
 * @param {{id:string,label:string}} def
 * @param {'stage'|'output'} kind
 * @returns {string}
 */
function checkboxRow(def, kind) {
  return `<label class="auto-config-row">
      <input type="checkbox" data-kind="${kind}" data-id="${def.id}" />
      <span>${def.label}</span>
    </label>`;
}

/**
 * Build the config form into `container` and wire change handlers. Call once
 * (the panel mounts it). Re-evaluating enablement is `refreshConfig`.
 * @param {HTMLElement} container
 * @returns {void}
 */
export function renderConfig(container) {
  rootEl = container;
  container.innerHTML = `
    <div class="auto-config-group">
      <div class="auto-config-title">Etapy</div>
      ${STAGE_DEFS.map((d) => checkboxRow(d, 'stage')).join('')}
    </div>
    <div class="auto-config-group">
      <div class="auto-config-title">Pliki wyjściowe</div>
      <div class="auto-config-sub">Tekst</div>
      ${TEXT_OUTPUTS.map((d) => checkboxRow(d, 'output')).join('')}
      <div class="auto-config-sub">Oś czasu</div>
      ${TIMELINE_OUTPUTS.map((d) => checkboxRow(d, 'output')).join('')}
    </div>`;
  container.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', onToggle);
  });
  refreshConfig();
}

/** @param {Event} e */
function onToggle(e) {
  const cb = /** @type {HTMLInputElement} */ (e.target);
  const id = cb.dataset.id;
  if (!id) return;
  if (cb.dataset.kind === 'stage') {
    state.autoMode.stages[id] = cb.checked;
  } else {
    state.autoMode.outputs[id] = cb.checked;
  }
  // emit() re-runs the panel's sync (→ refreshConfig), cascading dependencies.
  emit();
}

/**
 * Re-evaluate which checkboxes are enabled given the current state + selection,
 * clear any now-invalid selection from state, and reflect everything back into
 * the DOM. Cheap + idempotent — called on every state change.
 * @returns {void}
 */
export function refreshConfig() {
  if (!rootEl) return;
  const s = state.autoMode.stages;
  const o = state.autoMode.outputs;

  // Stage enablement (dependency rules): transcription needs a loaded video;
  // segmentation needs a transcript upstream; analysis needs segments upstream.
  const stageEnabled = {
    transcription: hasVideo(),
    segmentation: s.transcription || hasTranscript(),
    analysis: s.segmentation || state.sentences.length > 0,
    export: true,
  };
  for (const id of Object.keys(stageEnabled)) {
    if (!stageEnabled[id] && s[id]) s[id] = false;
  }

  // Output enablement depends on the (possibly just-cleared) stage flags. Text
  // outputs need a transcript; timeline outputs need reels (Analiza AI).
  const textOk = s.export && (s.transcription || hasTranscript());
  const timelineOk = s.export && (s.analysis || hasReels());
  const outEnabled = {
    srt: textOk,
    vtt: textOk,
    md: textOk,
    wordJson: textOk,
    edl: timelineOk,
    xml: timelineOk,
    lua: timelineOk,
  };
  for (const id of Object.keys(outEnabled)) {
    if (!outEnabled[id] && o[id]) o[id] = false;
  }

  rootEl.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    const el = /** @type {HTMLInputElement} */ (cb);
    const id = el.dataset.id;
    if (!id) return;
    if (el.dataset.kind === 'stage') {
      el.disabled = configLocked || !stageEnabled[id];
      el.checked = !!s[id];
    } else {
      el.disabled = configLocked || !outEnabled[id];
      el.checked = !!o[id];
    }
  });
}

/**
 * Lock (run live) / unlock (idle) all config controls.
 * @param {boolean} enabled
 * @returns {void}
 */
export function setConfigEnabled(enabled) {
  configLocked = !enabled;
  refreshConfig();
}

/**
 * Validate the current selection before a launch. Surfaces the first blocking
 * reason as a Polish message; the caller toasts it.
 * @returns {{ok:boolean, msg?:string}}
 */
export function validateSelection() {
  const s = state.autoMode.stages;
  if (!s.transcription && !s.segmentation && !s.analysis && !s.export) {
    return { ok: false, msg: 'Wybierz przynajmniej jeden etap.' };
  }
  if (s.export && !Object.values(state.autoMode.outputs).some(Boolean)) {
    return { ok: false, msg: 'Zaznacz przynajmniej jeden plik wyjściowy.' };
  }
  if (s.analysis && !getApiKey('openrouter')) {
    return {
      ok: false,
      msg: 'Brak klucza OpenRouter — wymagany do analizy AI.',
    };
  }
  return { ok: true };
}
