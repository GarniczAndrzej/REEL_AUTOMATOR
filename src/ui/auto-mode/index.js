// Auto-mode entry point (S-07, Phase 1). Wires the "Tryb automatyczny" sidebar
// button: enabled only when an input (video/SRT) + an OpenRouter key are present;
// on launch runs the async pre-run gate (overwrite ask() when reels already
// exist) then drives `runAutoPipeline`. Registered in main.js before
// initSurface() so the button reflects state from the first render.

import { state, subscribe } from '../../state.js';
import { getApiKey } from '../../ai/api-key.js';
import { runAutoPipeline } from './orchestrator.js';

export function initAutoMode() {
  const btn = document.getElementById('autoModeBtn');
  if (!btn) return;
  btn.addEventListener('click', onLaunch);
  // Reflect real state on every change (input present + key present, not running).
  subscribe(() => syncAutoBtn(btn));
  syncAutoBtn(btn);
}

/** @param {HTMLButtonElement} btn */
function syncAutoBtn(btn) {
  const hasInput =
    !!state._whisperVideoPath ||
    !!state.srtContent ||
    state.sentences.length > 0;
  const hasKey = !!getApiKey('openrouter');
  btn.disabled = !(hasInput && hasKey) || state.autoMode.running;
}

async function onLaunch() {
  if (state.autoMode.running) return;
  // Pre-run gate: protect existing work. NEVER window.confirm — it crashes the
  // WKWebView (lessons.md); use the async plugin-dialog ask(). Friction-free
  // first run: only prompt when reels already exist.
  if (state.reelsData.length) {
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
