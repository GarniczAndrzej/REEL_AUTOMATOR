// Settings modal (S-16 Phase 2). Houses the OpenRouter API key, the model
// picker, and the export merge-gap — moved out of the dense header api-bar so
// the header reads clean. Mirrors the `#whisperAdvancedModal` open/close
// pattern (`src/ui/step1-import.js:initWhisperAdvanced`).

import { state, emit } from '../state.js';
import { getApiKey, setApiKey } from '../ai/api-key.js';
import { saveSettings } from '../settings.js';

/**
 * Wire the settings modal: open/close, API key load/save, model-picker
 * visibility, and the persisted merge-gap control. Call once on boot.
 * @returns {void}
 */
export function initSettingsModal() {
  const apiKeyInput = document.getElementById('apiKeyInput');
  if (apiKeyInput) apiKeyInput.placeholder = 'OpenRouter API key (sk-or-...)';

  // The model picker wrap is hidden by default; OpenRouter is the only
  // provider since S-17, so reveal it unconditionally.
  const orWrap = document.getElementById('orModelWrap');
  if (orWrap) orWrap.classList.add('visible');

  const saveBtn = document.getElementById('saveApiKeyBtn');
  if (saveBtn) saveBtn.addEventListener('click', saveApiKey);

  // Merge-gap → state + settings bag (persists across sessions, S-16 #6).
  const mergeEl = document.getElementById('mergeThreshold');
  if (mergeEl) {
    mergeEl.addEventListener('input', (e) => {
      state.mergeThreshold = +e.target.value;
      saveSettings({ mergeThreshold: state.mergeThreshold });
      emit();
    });
  }

  loadApiKey();

  const openBtn = document.getElementById('settingsBtn');
  const modal = document.getElementById('settingsModal');
  const closeBtn = document.getElementById('settingsClose');
  if (!openBtn || !modal || !closeBtn) return;

  const close = () => {
    modal.style.display = 'none';
  };
  openBtn.addEventListener('click', () => {
    fillSettingsForm();
    modal.style.display = 'flex';
  });
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
}

function fillSettingsForm() {
  loadApiKey();
  const mergeEl = document.getElementById('mergeThreshold');
  if (mergeEl) mergeEl.value = state.mergeThreshold;
}

function saveApiKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) {
    showStatus('Pusty klucz — nie zapisano', 'err');
    return;
  }
  setApiKey('openrouter', key);
  showStatus('Zapisano ✓', 'ok');
}

function loadApiKey() {
  const input = document.getElementById('apiKeyInput');
  if (input) input.value = getApiKey('openrouter');
  const s = document.getElementById('apiStatus');
  if (!s) return;
  if (getApiKey('openrouter')) {
    s.textContent = 'Klucz załadowany';
    s.className = 'api-status ok';
  } else {
    s.textContent = '';
    s.className = 'api-status';
  }
}

function showStatus(msg, type) {
  const s = document.getElementById('apiStatus');
  if (!s) return;
  s.textContent = msg;
  s.className = 'api-status ' + type;
  setTimeout(() => {
    s.className = 'api-status';
    s.textContent = '';
  }, 2500);
}
