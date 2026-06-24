// Auto-mode entry point (S-07, Phase 1→3). Wires the "Tryb automatyczny" sidebar
// button: it opens the floating config panel (stage + output selection); the
// panel's "Uruchom" button drives the gated launch. The button is enabled once
// an input (video/SRT) is present — the OpenRouter key is only required when the
// Analiza AI stage is selected, validated at launch. Registered in main.js
// before initSurface() so the button reflects state from the first render.

import { state, subscribe } from '../../state.js';
import { runAutoPipeline } from './orchestrator.js';
import { openForConfig, setStartHandler } from './progress-panel.js';
import { validateSelection } from './config.js';
import { toast } from '../toast.js';

export function initAutoMode() {
  const btn = document.getElementById('autoModeBtn');
  if (!btn) return;
  // The sidebar button opens the config panel; the panel's Uruchom launches.
  btn.addEventListener('click', openForConfig);
  setStartHandler(launchAutoRun);
  // Reflect real state on every change (input present, not running).
  subscribe(() => syncAutoBtn(btn));
  syncAutoBtn(btn);
}

/** @param {HTMLButtonElement} btn */
function syncAutoBtn(btn) {
  const hasInput =
    !!state._whisperVideoPath ||
    !!state.srtContent ||
    state.sentences.length > 0;
  btn.disabled = !hasInput || state.autoMode.running;
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
    const { ask } = await import('@tauri-apps/plugin-dialog');
    const proceed = await ask(
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
