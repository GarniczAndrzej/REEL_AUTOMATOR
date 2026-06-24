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
import { addVideosToBatch, removeFromBatch } from './batch.js';

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
function hasBatch() {
  return state.autoMode.batchQueue.length > 0;
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
    <div class="auto-config-group auto-batch">
      <div class="auto-config-title">Tryb wsadowy</div>
      <div class="auto-config-hint">
        Dodaj wiele wideo, aby przetworzyć je po kolei do jednego folderu.
        Każde przechodzi przez zaznaczone niżej etapy i pliki wyjściowe.
      </div>
      <button class="auto-batch-add btn btn-secondary" type="button">
        + Dodaj wideo…
      </button>
      <div class="auto-batch-queue"></div>
    </div>
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
  container
    .querySelector('.auto-batch-add')
    ?.addEventListener('click', addVideosToBatch);
  // Delegate the per-row remove buttons (the queue list is re-rendered on every
  // state change, so a single delegated listener survives re-renders).
  container
    .querySelector('.auto-batch-queue')
    ?.addEventListener('click', (e) => {
      const btn = /** @type {HTMLElement} */ (e.target).closest(
        '.auto-batch-remove',
      );
      if (!btn || configLocked) return;
      const idx = Number(btn.dataset.idx);
      if (Number.isInteger(idx)) removeFromBatch(idx);
    });
  refreshConfig();
}

// Per-video status glyph for the batch queue rows (mirrors the panel icon set).
const BATCH_STATUS = {
  pending: '—',
  running: 'W toku…',
  done: '✓ Gotowe',
  error: '✗ Błąd',
};

/**
 * Re-render the batch queue rows from `state.autoMode.batchQueue`. Each row shows
 * the source video name, its current status, and a remove button (disabled while
 * a run is live). Cheap + idempotent — called from `refreshConfig`.
 * @returns {void}
 */
function renderBatchQueue() {
  if (!rootEl) return;
  const list = rootEl.querySelector('.auto-batch-queue');
  if (!list) return;
  const queue = state.autoMode.batchQueue;
  if (!queue.length) {
    list.innerHTML = `<div class="auto-batch-empty">Brak wideo w kolejce.</div>`;
    return;
  }
  list.innerHTML = queue
    .map(
      (v, i) => `
      <div class="auto-batch-row ${v.status}">
        <span class="auto-batch-name" title="${v.name}">${v.name}</span>
        <span class="auto-batch-status">${BATCH_STATUS[v.status] || ''}</span>
        <button class="auto-batch-remove" type="button" data-idx="${i}"
          title="Usuń z kolejki" aria-label="Usuń z kolejki"
          ${configLocked ? 'disabled' : ''}>✕</button>
      </div>`,
    )
    .join('');
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

  // Stage enablement (dependency rules). A queued batch supplies the input that
  // a single loaded document otherwise would, so each batched video transcribes
  // + segments + (optionally) analyses — the stage checkboxes must stay tickable
  // even when no single document is loaded.
  const batch = hasBatch();
  const stageEnabled = {
    transcription: hasVideo() || batch,
    segmentation: s.transcription || hasTranscript() || batch,
    analysis:
      s.segmentation || state.sentences.length > 0 || (batch && s.segmentation),
    export: true,
  };
  for (const id of Object.keys(stageEnabled)) {
    if (!stageEnabled[id] && s[id]) s[id] = false;
  }

  // Output enablement. For a single document the Eksport stage gates outputs;
  // for a batch, export is implicit (headless to disk), so outputs are gated by
  // the queue + the stages each video will run. Text outputs need a transcript
  // (always produced per video); timeline outputs need reels (Analiza AI).
  const textOk = (s.export && (s.transcription || hasTranscript())) || batch;
  const timelineOk =
    (s.export && (s.analysis || hasReels())) || (batch && s.analysis);
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

  const addBtn = rootEl.querySelector('.auto-batch-add');
  if (addBtn) addBtn.disabled = configLocked;
  renderBatchQueue();
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
