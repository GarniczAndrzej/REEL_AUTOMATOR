// Step-2 orchestrator. Wires the three per-surface modules (reel-list,
// prompt-panel, segment-ops) and preserves the public surface main.js depends
// on: init / undo / redo. (R1 split — pure structural move, no behavior change.)

import { state, emit } from '../state.js';
import { initReelList } from './step2-reel-list.js';
import { initPromptPanel } from './step2-prompt-panel.js';
import { initSegmentOps, undo, redo } from './step2-segment-ops.js';
import { openPopover } from './export-popover.js';
import { initPresetBar } from './step2-preset-bar.js';

// Re-export the global undo/redo surface for main.js (`import * as step2`).
export { undo, redo };

export function init() {
  console.log('[step2.init] start');

  const promptEl = document.getElementById('userPrompt');
  promptEl.value = state.userPrompt;
  promptEl.addEventListener('input', (e) => {
    state.userPrompt = e.target.value;
    emit();
  });

  document.getElementById('toExportBtn').addEventListener('click', openPopover);

  const list = document.getElementById('reelsList');

  initPresetBar();
  initReelList(list);
  initPromptPanel();
  initSegmentOps(list);

  console.log('[step2.init] done');
}
