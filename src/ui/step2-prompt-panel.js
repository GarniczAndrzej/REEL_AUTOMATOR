// Step-2 prompt panel: AI invocation, the JSON editor/paste paths, prompt
// download, and the progress log. Attaches its button listeners via
// initPromptPanel(). (R1 split — pure move; S-16 removed the A/B compare
// feature + AI-cache control.)

import { state, emit } from '../state.js';
import { buildPrompt } from '../ai/prompt.js';
import { saveTextToPath } from '../util/save-file.js';
import { validateReels } from '../ai/validate.js';
import { callOpenRouter } from '../ai/providers.js';
import { getApiKey } from '../ai/api-key.js';
import { withLlmCache } from '../ai/cache.js';
import { renderReels, esc } from './step2-reel-list.js';
import { snap, pushUndo } from './step2-segment-ops.js';
import { toast } from './toast.js';

// ── Init ───────────────────────────────────────────────────────────

export function initPromptPanel() {
  document
    .getElementById('analyzeBtn')
    .addEventListener('click', runAIAnalysis);
  document
    .getElementById('copyPromptBtn')
    ?.addEventListener('click', copyPromptMD);
  document
    .getElementById('downloadPromptBtn')
    .addEventListener('click', downloadPromptTXT);
  document
    .getElementById('applyPastedJsonBtn')
    .addEventListener('click', applyPastedJSON);
  document
    .getElementById('clearPastedJsonBtn')
    .addEventListener('click', clearPastedJSON);
}

// ── AI analysis ────────────────────────────────────────────────────

async function runAIAnalysis() {
  const apiKey =
    document.getElementById('apiKeyInput').value.trim() ||
    getApiKey('openrouter');
  if (!apiKey) {
    alert('Otwórz „⚙ Ustawienia" i wklej API key OpenRouter!');
    return;
  }
  if (!state.sentences.length) {
    alert('Najpierw przeanalizuj plik SRT (Krok 1)!');
    return;
  }
  if (!state.orSelectedModel) {
    alert(
      'Wybierz model OpenRouter! Kliknij "Załaduj modele" obok pola API key.',
    );
    return;
  }

  const analyzeBtn = document.getElementById('analyzeBtn');
  analyzeBtn.disabled = true;

  const progressBox = document.getElementById('progressBox');
  progressBox.classList.add('visible');
  setPS(1, 'running');
  setPS(2, '');
  setPS(3, '');
  logClear();
  document.getElementById('reelsCard').style.display = 'none';
  document.getElementById('step2Next').style.display = 'none';

  const prompt = buildPrompt(
    state.userPrompt,
    state.systemPrompt,
    state.sentences,
    null,
    state.videoFilename || '',
  );
  log('Przygotowano prompt. Segmentów: ' + state.sentences.length, 'info');
  log('Provider: OpenRouter / ' + state.orSelectedModel, 'info');
  setPS(1, 'done');
  setPS(2, 'running');

  let rawResponse = '';
  try {
    const orModel = state.orSelectedModel;
    log('Model: ' + orModel, 'info');

    const cacheKey = JSON.stringify({
      provider: 'openrouter',
      model: orModel || '',
      prompt,
    });
    const {
      result: responseText,
      fromCache,
      hashShort,
    } = await withLlmCache(cacheKey, () =>
      callOpenRouter(apiKey, prompt, orModel),
    );

    rawResponse = responseText;
    if (fromCache) {
      log(`Odpowiedź z pamięci podręcznej (hash: ${hashShort}) ⚡`, 'ok');
    } else {
      log(
        'Odpowiedź AI otrzymana (' + responseText.length + ' znaków)',
        'info',
      );
    }
    setPS(2, 'done');
    setPS(3, 'running');

    const cleaned = responseText.replace(/```json|```/g, '').trim();
    const parsed = validateReels(JSON.parse(cleaned), state.sentences);
    pushUndo(snap());
    state.reelsData = parsed;
    renderReels();
    document.getElementById('statusReels').textContent = state.reelsData.length;
    setPS(3, 'done');
    log('Sparsowano ' + state.reelsData.length + ' reelsów', 'ok');
    document.getElementById('reelsCard').style.display = 'block';
    document.getElementById('step2Next').style.display = 'flex';
    emit();
  } catch (e) {
    setPS(2, 'err');
    setPS(3, 'err');
    log('BŁĄD: ' + e.message, 'err');
    if (rawResponse) {
      // FR-018: validation/parse failed — keep the raw text for paste-and-fix.
      revealPasteFix(rawResponse, 'Błąd walidacji: ' + e.message);
      log(
        'Surowa odpowiedź zachowana w polu „Wklej JSON od AI" — popraw i zastosuj.',
        'err',
      );
    } else {
      log('Sprawdź API key i połączenie internetowe.', 'err');
    }
  } finally {
    analyzeBtn.disabled = false;
  }
}

// FR-018 paste-and-fix: stash the raw response in the editable paste box, show
// the Polish error there, and scroll it into view. Never mutates reelsData.
function revealPasteFix(rawText, message) {
  const input = document.getElementById('pasteJsonInput');
  const status = document.getElementById('pasteJsonStatus');
  if (input && rawText != null) input.value = rawText;
  if (status) {
    status.style.color = 'var(--red)';
    status.textContent = message;
  }
  // The paste-JSON path is demoted behind a <details> (S-16 3b); open it so the
  // stashed raw response is visible for paste-and-fix.
  document.querySelector('.paste-json-details')?.setAttribute('open', '');
  document
    .getElementById('pasteJsonCard')
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function applyPastedJSON() {
  const raw = document.getElementById('pasteJsonInput').value.trim();
  const status = document.getElementById('pasteJsonStatus');
  if (!raw) {
    status.style.color = 'var(--red)';
    status.textContent = 'Pole jest puste.';
    return;
  }
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = validateReels(JSON.parse(cleaned), state.sentences);
    const before = snap();
    state.reelsData = parsed;
    pushUndo(before);
    renderReels();
    document.getElementById('statusReels').textContent = state.reelsData.length;
    document.getElementById('reelsCard').style.display = 'block';
    document.getElementById('step2Next').style.display = 'flex';
    status.style.color = 'var(--green)';
    status.textContent = `✓ Wczytano ${state.reelsData.length} reelsów`;
    emit();
  } catch (e) {
    status.style.color = 'var(--red)';
    status.textContent = 'Błąd: ' + e.message;
  }
}

function clearPastedJSON() {
  document.getElementById('pasteJsonInput').value = '';
  document.getElementById('pasteJsonStatus').textContent = '';
}

async function downloadPromptTXT() {
  if (!state.sentences.length) {
    alert('Najpierw przeanalizuj plik napisów (sekcja Import)!');
    return;
  }
  const content = buildPrompt(
    state.userPrompt,
    state.systemPrompt,
    state.sentences,
    null,
    state.videoFilename || '',
  );
  await saveTextToPath({ defaultName: 'PROMPT_DLA_AI.txt', content });
}

// #11 — copy-prompt-as-.md is the primary manual path (paste into ChatGPT /
// Gemini / Claude web when not using the API key).
async function copyPromptMD() {
  if (!state.sentences.length) {
    alert('Najpierw przeanalizuj plik napisów (sekcja Import)!');
    return;
  }
  const content = buildPrompt(
    state.userPrompt,
    state.systemPrompt,
    state.sentences,
    null,
    state.videoFilename || '',
  );
  try {
    await navigator.clipboard.writeText(content);
    toast('Prompt skopiowany do schowka ✓', 'success');
  } catch {
    toast('Nie udało się skopiować — użyj „Eksportuj prompt .txt".', 'error');
  }
}

function setPS(n, s) {
  const el = document.getElementById('ps' + n);
  el.className = 'p-step' + (s ? ' ' + s : '');
}
function logClear() {
  document.getElementById('logBox').innerHTML = '';
}
export function log(msg, type = '') {
  const box = document.getElementById('logBox');
  const d = document.createElement('div');
  d.className = 'log-line ' + type;
  d.textContent = '> ' + msg;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}
