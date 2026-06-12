import { state, subscribe, emit } from './state.js';
import * as step1 from './ui/step1-import.js';
import * as step2 from './ui/step2-analyze.js';
import * as step3 from './ui/step3-export.js';
import { init as initOrPicker } from './ai/openrouter-picker.js';
import { getApiKey, setApiKey } from './ai/api-key.js';

export function goStep(n) {
  [1, 2, 3].forEach((i) => {
    document.getElementById('panel' + i).classList.toggle('active', i === n);
    document.getElementById('nav' + i).classList.toggle('active', i === n);
  });
  if (n === 3) step3.updateSummary();
}

document.addEventListener('DOMContentLoaded', async () => {
  // Register nav first — before inits, so a throwing init never blocks navigation
  document.getElementById('nav1').addEventListener('click', () => goStep(1));
  document.getElementById('nav2').addEventListener('click', () => goStep(2));
  document.getElementById('nav3').addEventListener('click', () => goStep(3));
  document.addEventListener('reel:goStep', (e) => goStep(e.detail));

  try {
    step1.init();
  } catch (e) {
    console.error('[step1.init]', e);
  }
  try {
    step2.init();
  } catch (e) {
    console.error('[step2.init]', e);
    const p2 = document.getElementById('panel2');
    if (p2)
      p2.insertAdjacentHTML(
        'afterbegin',
        `<div style="background:#c0392b;color:#fff;padding:10px 14px;border-radius:6px;margin-bottom:12px;font-size:13px;">
        ⚠ Błąd inicjalizacji kroku 2: ${e.message}<br>
        <small>Otwórz DevTools (Cmd+Option+I) aby zobaczyć szczegóły.</small>
      </div>`,
      );
  }
  try {
    step3.init();
  } catch (e) {
    console.error('[step3.init]', e);
  }
  try {
    initOrPicker();
  } catch (e) {
    console.error('[initOrPicker]', e);
  }

  // API key bar
  const modelSelect = document.getElementById('modelSelect');
  const apiKeyInput = document.getElementById('apiKeyInput');

  modelSelect.addEventListener('change', () => {
    state.currentProvider = modelSelect.value;
    const wrap = document.getElementById('orModelWrap');
    if (state.currentProvider === 'gemini') {
      apiKeyInput.placeholder = 'Google AI Studio API key...';
      wrap.classList.remove('visible');
    } else if (state.currentProvider === 'claude') {
      apiKeyInput.placeholder = 'Anthropic API key (sk-ant-...)...';
      wrap.classList.remove('visible');
    } else {
      apiKeyInput.placeholder = 'OpenRouter API key (sk-or-...)...';
      wrap.classList.add('visible');
    }
    loadApiKey();
  });

  document
    .getElementById('saveApiKeyBtn')
    .addEventListener('click', saveApiKey);

  // Load persisted key on boot
  loadApiKey();

  // Subscribe to state changes → update sidebar status
  subscribe((s) => {
    document.getElementById('statusSrt').textContent = s.srtName || 'brak';
    document.getElementById('statusSegs').textContent = s.sentences.length;
    document.getElementById('statusReels').textContent = s.reelsData.length;
  });

  // ── F16 — Global undo/redo (works from any step) ──────────────────
  document.addEventListener('keydown', (e) => {
    const mod = navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey;
    if (!mod) return;
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      step2.undo();
    }
    if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
      e.preventDefault();
      step2.redo();
    }
  });
});

function saveApiKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) {
    showStatus('Pusty klucz — nie zapisano', 'err');
    return;
  }
  setApiKey(state.currentProvider, key);
  showStatus('Zapisano ✓', 'ok');
}

function loadApiKey() {
  const key = getApiKey(state.currentProvider);
  document.getElementById('apiKeyInput').value = key;
  const s = document.getElementById('apiStatus');
  if (key) {
    s.textContent = 'Klucz załadowany';
    s.className = 'api-status ok';
  } else {
    s.textContent = '';
    s.className = 'api-status';
  }
}

function showStatus(msg, type) {
  const s = document.getElementById('apiStatus');
  s.textContent = msg;
  s.className = 'api-status ' + type;
  setTimeout(() => {
    s.className = 'api-status';
    s.textContent = '';
  }, 2500);
}
