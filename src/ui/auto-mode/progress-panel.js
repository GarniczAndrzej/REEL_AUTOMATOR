// Unified auto-mode progress panel (S-07, Phase 2). One in-app, non-blocking
// floating overlay that replaces the two disconnected legacy surfaces (the
// WhisperX `#whisperProgressBox` and the AI `#progressBox` bucket list) while an
// auto run is live. It is a small corner panel — NOT a modal and NOT a Tauri
// window: no backdrop, no focus trap, no blocked pointer events on the rest of
// the app, and dismissible via its close button. Each cancellable stage row
// carries a cancel button wired to `controller.cancelStage(stageId)`. The DOM is
// built once in JS (like the toast container) so there is no stale empty node in
// index.html. All strings are Polish.

// Fixed stage list. `Eksport` is added in Phase 3+; segmentation runs inside the
// transcription unit, so its row is marked done right after transcription.
/** @type {{id:string,name:string,cancellable:boolean}[]} */
const STAGES = [
  { id: 'transcribe', name: 'Transkrypcja', cancellable: true },
  { id: 'segment', name: 'Segmentacja', cancellable: false },
  { id: 'analyze', name: 'Analiza AI', cancellable: true },
];

// Status icon vocabulary reused from the S-25 bucket list ({pending,running,
// done,error}). The CSS class is the status name (empty for pending).
const ICON = { pending: '…', running: '⏳', done: '✓', error: '✗' };

/** @type {HTMLElement|null} */
let panelEl = null;
/** @type {{cancelStage:(id:string)=>any}|null} */
let activeController = null;

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
    <div class="auto-panel-stages">${rows}</div>`;

  document.body.appendChild(panelEl);

  panelEl
    .querySelector('.auto-panel-close')
    .addEventListener('click', hidePanel);
  panelEl.querySelectorAll('.auto-stage-cancel').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = btn.closest('.auto-stage')?.dataset.stage;
      if (id && activeController) activeController.cancelStage(id);
    });
  });
  return panelEl;
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
  for (const s of STAGES) {
    updateStage(s.id, { status: 'pending', percent: 0, label: '' });
  }
  panelEl.classList.add('visible');
}

/** Hide (dismiss) the panel without destroying it. @returns {void} */
export function hidePanel() {
  if (panelEl) panelEl.classList.remove('visible');
}

/**
 * Update one stage row's status icon, detail label, and percent bar. Only the
 * provided fields change; a cancel button shows only while a cancellable stage is
 * `running`.
 * @param {string} stageId
 * @param {{ label?: string, percent?: number, status?: 'pending'|'running'|'done'|'error' }} [patch]
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
