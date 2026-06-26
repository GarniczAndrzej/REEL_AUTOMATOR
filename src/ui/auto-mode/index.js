// Auto-mode entry point (S-07, Phase 1→3). Wires the "Tryb automatyczny" sidebar
// button: it opens the floating config panel (stage + output selection); the
// panel's "Uruchom" button drives the gated launch. The button is enabled once
// an input (video/SRT) is present — the OpenRouter key is only required when the
// Analiza AI stage is selected, validated at launch. Registered in main.js
// before initSurface() so the button reflects state from the first render.

import { state, subscribe } from '../../state.js';
import { runAutoPipeline } from './orchestrator.js';
import {
  openForConfig,
  setStartHandler,
  setBatchHandler,
} from './progress-panel.js';
import { validateSelection } from './config.js';
import { runBatch } from './batch.js';
import { toast } from '../toast.js';
import { dialogAsk } from '../../platform/adapter.js';

export function initAutoMode() {
  const btn = document.getElementById('autoModeBtn');
  if (!btn) return;
  // The sidebar button opens the config panel; the panel's Uruchom launches a
  // single-document run, Uruchom wsadowo launches the batch (Phase 4).
  btn.addEventListener('click', openForConfig);
  setStartHandler(launchAutoRun);
  setBatchHandler(launchBatchRun);
  // Reflect real state on every change (not running).
  subscribe(() => syncAutoBtn(btn));
  syncAutoBtn(btn);
}

/**
 * The sidebar button only OPENS the config panel — a single-document input is no
 * longer required to open it, because the panel is also where a headless batch
 * (which needs no loaded document) is assembled. Both launch paths validate
 * their own preconditions. The button is only gated while a run is live.
 * @param {HTMLButtonElement} btn
 */
function syncAutoBtn(btn) {
  btn.disabled = state.autoMode.running;
}

/**
 * Gated launch invoked by the panel's "Uruchom" button. Validates the current
 * stage/output selection, then runs the pre-run overwrite gate before driving
 * the pipeline. NEVER window.confirm — it crashes the WKWebView (lessons.md);
 * use the async plugin-dialog ask().
 * @returns {Promise<void>}
 */
async function launchAutoRun() {
  if (state.autoMode.running) return;

  const check = validateSelection();
  if (!check.ok) {
    toast(check.msg || 'Nieprawidłowy wybór etapów.', 'info');
    return;
  }

  // Pre-run gate: protect existing work. Only prompt when the Analiza AI stage
  // would overwrite existing reels — text-only / export-only runs don't touch
  // them.
  if (state.autoMode.stages.analysis && state.reelsData.length) {
    const proceed = await dialogAsk(
      'Istnieją już reelsy. Nadpisać je nowym biegiem automatycznym?',
      {
        title: 'Tryb automatyczny',
        kind: 'warning',
        okLabel: 'Nadpisz',
        cancelLabel: 'Anuluj',
      },
    );
    if (!proceed) return;
  }
  await runAutoPipeline();
}

/**
 * Gated batch launch invoked by the panel's "Uruchom wsadowo" button. `runBatch`
 * owns its own validation (queue non-empty, outputs selected, key when timeline
 * outputs are requested) and the one-time folder pick, so this is a thin guard.
 * @returns {Promise<void>}
 */
async function launchBatchRun() {
  if (state.autoMode.running) return;
  await runBatch();
}
