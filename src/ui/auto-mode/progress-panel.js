// Unified auto-mode progress panel (S-07, Phase 2+3). One in-app, non-blocking
// floating overlay that replaces the two disconnected legacy surfaces (the
// WhisperX `#whisperProgressBox` and the AI `#progressBox` bucket list) while an
// auto run is live. It is a small corner panel — NOT a modal and NOT a Tauri
// window: no backdrop, no focus trap, no blocked pointer events on the rest of
// the app, and dismissible via its close button. Each cancellable stage row
// carries a cancel button wired to `controller.cancelStage(stageId)`. Phase 3
// adds the stage/output config form (`config.js`) at the top and an "Uruchom"
// launch button; the form is locked while a run is live. The DOM is built once
// in JS (like the toast container) so there is no stale empty node in
// index.html. All strings are Polish.

import { state, subscribe } from '../../state.js';
import { renderConfig, refreshConfig, setConfigEnabled } from './config.js';
import { openPath } from '../../util/save-file.js';

// Fixed stage list. Segmentation runs inside the transcription unit, so its row
// is marked done right after transcription; `Eksport` runs last (Phase 3).
/** @type {{id:string,name:string,cancellable:boolean}[]} */
const STAGES = [
  { id: 'transcribe', name: 'Transkrypcja', cancellable: true },
  { id: 'segment', name: 'Segmentacja', cancellable: false },
  { id: 'analyze', name: 'Analiza AI', cancellable: true },
  { id: 'export', name: 'Eksport', cancellable: false },
];

// Status icon vocabulary reused from the S-25 bucket list ({pending,running,
// done,error}); `skipped` (–) marks a deselected stage. The CSS class is the
// status name (empty for pending).
const ICON = {
  pending: '…',
  running: '⏳',
  done: '✓',
  error: '✗',
  skipped: '–',
};

/** @type {HTMLElement|null} */
let panelEl = null;
/** @type {{cancelStage:(id:string)=>any}|null} */
let activeController = null;
/** @type {(()=>any)|null} */
let startHandler = null;
/** @type {(()=>any)|null} */
let batchHandler = null;
/** @type {string|null} */
let openFolderPath = null;

/**
 * Register the launch handler invoked by the panel's "Uruchom" button. Wired by
 * the auto-mode entry module (`index.js`) to its gated launch.
 * @param {()=>any} fn
 * @returns {void}
 */
export function setStartHandler(fn) {
  startHandler = fn;
}

/**
 * Register the handler invoked by the panel's "Uruchom wsadowo" button (Phase 4
 * batch). Wired by `index.js` to the gated batch launch.
 * @param {()=>any} fn
 * @returns {void}
 */
export function setBatchHandler(fn) {
  batchHandler = fn;
}

/**
 * Build the panel DOM once and append it to <body>. Idempotent — safe to call on
 * every run. Wires the close (dismiss) button and the per-stage cancel buttons.
 * @returns {HTMLElement}
 */
export function mountProgressPanel() {
  if (panelEl) return panelEl;
  panelEl = document.createElement('div');
  panelEl.id = 'autoProgressPanel';
  panelEl.className = 'auto-panel';
  panelEl.setAttribute('role', 'status');
  panelEl.setAttribute('aria-live', 'polite');

  const rows = STAGES.map(
    (s) => `
    <div class="auto-stage" data-stage="${s.id}">
      <div class="auto-stage-top">
        <span class="auto-stage-icon">${ICON.pending}</span>
        <span class="auto-stage-name">${s.name}</span>
        <span class="auto-stage-pct"></span>
        ${
          s.cancellable
            ? `<button class="auto-stage-cancel" type="button" title="Anuluj etap" aria-label="Anuluj etap" style="display:none">✕</button>`
            : ''
        }
      </div>
      <div class="auto-stage-detail"></div>
      <div class="auto-stage-bar"><div class="auto-stage-fill"></div></div>
    </div>`,
  ).join('');

  panelEl.innerHTML = `
    <div class="auto-panel-head">
      <span class="auto-panel-title">⚡ Tryb automatyczny</span>
      <button class="auto-panel-close" type="button" title="Zamknij" aria-label="Zamknij">×</button>
    </div>
    <div class="auto-panel-config"></div>
    <div class="auto-panel-stages">${rows}</div>
    <div class="auto-panel-foot">
      <button class="auto-panel-start btn btn-primary" type="button">▶ Uruchom</button>
      <button class="auto-panel-batch btn btn-primary" type="button" style="display:none">▶ Uruchom wsadowo</button>
      <button class="auto-panel-openfolder btn btn-secondary" type="button" style="display:none">📂 Otwórz folder docelowy</button>
    </div>`;

  document.body.appendChild(panelEl);

  renderConfig(panelEl.querySelector('.auto-panel-config'));

  panelEl
    .querySelector('.auto-panel-close')
    .addEventListener('click', hidePanel);
  panelEl.querySelector('.auto-panel-start').addEventListener('click', () => {
    if (!state.autoMode.running && startHandler) startHandler();
  });
  panelEl.querySelector('.auto-panel-batch').addEventListener('click', () => {
    if (!state.autoMode.running && batchHandler) batchHandler();
  });
  panelEl
    .querySelector('.auto-panel-openfolder')
    .addEventListener('click', () => {
      if (openFolderPath) openPath(openFolderPath);
    });
  panelEl.querySelectorAll('.auto-stage-cancel').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.auto-stage')?.dataset.stage;
      if (id && activeController) activeController.cancelStage(id);
    });
  });

  // Keep the config form's enablement + dependency greying in sync with state
  // (input/reels presence, run live/idle) on every change.
  subscribe(syncRunState);
  syncRunState();
  return panelEl;
}

/**
 * Reflect run-live vs idle into the panel: lock the config form + disable the
 * Uruchom button while a run is in flight, re-enable when idle. Also re-runs the
 * dependency greying so the form tracks input/reels presence.
 * @returns {void}
 */
function syncRunState() {
  if (!panelEl) return;
  const running = state.autoMode.running;
  setConfigEnabled(!running);
  const start = panelEl.querySelector('.auto-panel-start');
  if (start) start.disabled = running;
  // The batch launch button only appears once videos are queued; its label
  // carries the queue count so the user sees how many will be processed.
  const batch = panelEl.querySelector('.auto-panel-batch');
  const n = state.autoMode.batchQueue.length;
  if (batch) {
    batch.style.display = n ? '' : 'none';
    batch.disabled = running;
    batch.textContent = `▶ Uruchom wsadowo (${n})`;
  }
  panelEl.classList.toggle('running', running);
}

/**
 * Open the panel in idle/config mode (no run bound): mount, reset the stage
 * rows, refresh the config form, and reveal. The "Uruchom" button launches.
 * @returns {void}
 */
export function openForConfig() {
  mountProgressPanel();
  activeController = null;
  showOpenFolder(null);
  for (const s of STAGES) {
    updateStage(s.id, { status: 'pending', percent: 0, label: '' });
  }
  refreshConfig();
  syncRunState();
  panelEl.classList.add('visible');
}

/**
 * Reset all rows to pending, bind the controller for cancel routing, and reveal
 * the panel.
 * @param {{ controller?: {cancelStage:(id:string)=>any} }} [opts]
 * @returns {void}
 */
export function showPanel({ controller } = {}) {
  mountProgressPanel();
  activeController = controller || null;
  showOpenFolder(null);
  for (const s of STAGES) {
    updateStage(s.id, { status: 'pending', percent: 0, label: '' });
  }
  syncRunState();
  panelEl.classList.add('visible');
}

/** Hide (dismiss) the panel without destroying it. @returns {void} */
export function hidePanel() {
  if (panelEl) panelEl.classList.remove('visible');
}

/**
 * Reveal (or hide) the "Otwórz folder docelowy" button. Called after an
 * export/batch finishes with the destination folder; passing a falsy path hides
 * it. The button opens the folder in Finder via the `open_path` command.
 * @param {string|null} path
 * @returns {void}
 */
export function showOpenFolder(path) {
  openFolderPath = path || null;
  if (!panelEl) return;
  const btn = panelEl.querySelector('.auto-panel-openfolder');
  if (btn) btn.style.display = openFolderPath ? '' : 'none';
}

/**
 * Update one stage row's status icon, detail label, and percent bar. Only the
 * provided fields change; a cancel button shows only while a cancellable stage is
 * `running`.
 * @param {string} stageId
 * @param {{ label?: string, percent?: number, status?: 'pending'|'running'|'done'|'error'|'skipped' }} [patch]
 * @returns {void}
 */
export function updateStage(stageId, { label, percent, status } = {}) {
  if (!panelEl) return;
  const row = panelEl.querySelector(`.auto-stage[data-stage="${stageId}"]`);
  if (!row) return;
  const def = STAGES.find((s) => s.id === stageId);

  if (status) {
    row.className = 'auto-stage' + (status !== 'pending' ? ' ' + status : '');
    const icon = row.querySelector('.auto-stage-icon');
    if (icon) icon.textContent = ICON[status] || ICON.pending;
    const cancel = row.querySelector('.auto-stage-cancel');
    if (cancel) {
      cancel.style.display =
        status === 'running' && def?.cancellable ? '' : 'none';
    }
  }
  if (label != null) {
    const detail = row.querySelector('.auto-stage-detail');
    if (detail) detail.textContent = label;
  }
  if (percent != null) {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    const fill = row.querySelector('.auto-stage-fill');
    if (fill) fill.style.width = p + '%';
    const pct = row.querySelector('.auto-stage-pct');
    if (pct) pct.textContent = p ? p + '%' : '';
  }
}
