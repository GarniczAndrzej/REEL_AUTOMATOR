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
import { sortReels, esc } from './step2-reel-list.js';
import { snap, pushUndo } from './step2-segment-ops.js';
import { toast } from './toast.js';

// ── Init ───────────────────────────────────────────────────────────

export function initPromptPanel() {
  document
    .getElementById('analyzeBtn')
    .addEventListener('click', onAnalyzeClick);
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

// Holds the AbortController for the active run; null when idle. Doubles as the
// single-run guard and the run-vs-cancel discriminator for the analyze button.
let analysisController = null;

// The analyze button toggles between "run" and "stop" modes during a run, so a
// single click handler dispatches by current state instead of swapping
// listeners (avoids double-bind bugs).
function onAnalyzeClick() {
  if (analysisController) {
    analysisController.abort();
  } else {
    runAIAnalysis();
  }
}

/** @param {'running' | 'idle'} mode */
function setAnalyzeBtnMode(mode) {
  const btn = document.getElementById('analyzeBtn');
  if (mode === 'running') {
    btn.textContent = '⏹ Zatrzymaj';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-danger');
  } else {
    btn.textContent = 'Analizuj z OpenRouter →';
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-primary');
  }
}

async function runAIAnalysis() {
  const apiKey =
    document.getElementById('apiKeyInput').value.trim() ||
    getApiKey('openrouter');
  if (!apiKey) {
    toast('Otwórz „⚙ Ustawienia" i wklej API key OpenRouter!', 'error');
    return;
  }
  if (!state.sentences.length) {
    toast('Najpierw przeanalizuj plik SRT (Krok 1)!', 'error');
    return;
  }
  if (!state.orSelectedModel) {
    toast(
      'Wybierz model OpenRouter! Kliknij "Załaduj modele" obok pola API key.',
      'error',
    );
    return;
  }

  // Re-entrancy guard: ignore a fresh run while one is in flight (the button is
  // in "Zatrzymaj" mode then, so a click cancels via onAnalyzeClick instead).
  if (analysisController) return;
  const controller = new AbortController();
  analysisController = controller;
  setAnalyzeBtnMode('running');

  const progressBox = document.getElementById('progressBox');
  progressBox.classList.add('visible');
  setPS(1, 'running');
  setPS(2, '');
  setPS(3, '');
  logClear();
  document.getElementById('usageBox')?.classList.remove('visible');
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
    const { result, fromCache, hashShort } = await withLlmCache(cacheKey, () =>
      callOpenRouter(apiKey, prompt, orModel, controller.signal),
    );
    const { content: responseText, usage, finishReason } = result;

    rawResponse = responseText;
    if (fromCache) {
      log(`Odpowiedź z pamięci podręcznej (hash: ${hashShort}) ⚡`, 'ok');
    } else {
      log(
        'Odpowiedź AI otrzymana (' + responseText.length + ' znaków)',
        'info',
      );
    }
    if (finishReason === 'length') {
      log(
        'Odpowiedź ucięta przez limit tokenów (finish_reason=length).',
        'err',
      );
    }
    renderUsage(usage, orModel, fromCache);
    setPS(2, 'done');
    setPS(3, 'running');

    const cleaned = responseText.replace(/```json|```/g, '').trim();
    const parsed = validateReels(JSON.parse(cleaned), state.sentences);
    // Snapshot pre-analysis state, then default fresh output to score-desc.
    // sortReels stamps ai_order, sets state.reelSort, pushes its own snapshot,
    // and re-renders — so undo returns to pre-analysis in two steps.
    pushUndo(snap());
    state.reelsData = parsed;
    sortReels('score_desc');
    document.getElementById('statusReels').textContent = state.reelsData.length;
    setPS(3, 'done');
    log('Sparsowano ' + state.reelsData.length + ' reelsów', 'ok');
    document.getElementById('reelsCard').style.display = 'block';
    document.getElementById('step2Next').style.display = 'flex';
    emit();
  } catch (e) {
    if (e.name === 'AbortError') {
      // User cancel — distinct from a real failure, no error dialog / paste-fix.
      // Leave existing state.reelsData untouched.
      setPS(2, '');
      setPS(3, '');
      log('Anulowano.', 'info');
      toast('Anulowano analizę', 'info');
    } else {
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
    }
  } finally {
    analysisController = null;
    setAnalyzeBtnMode('idle');
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
    // Default pasted output to score-desc (sortReels stamps + re-renders).
    sortReels('score_desc');
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
    toast('Najpierw przeanalizuj plik napisów (sekcja Import)!', 'error');
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
    toast('Najpierw przeanalizuj plik napisów (sekcja Import)!', 'error');
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

// Compact Polish post-run token/cost readout. On a cache hit there is no fresh
// usage, so show a "z pamięci podręcznej" badge instead of fabricated numbers.
/**
 * @param {object|null} usage `data.usage` verbatim (`prompt_tokens`,
 *   `completion_tokens`, `prompt_tokens_details.cached_tokens`) or null.
 * @param {string} model OpenRouter model id used for the run.
 * @param {boolean} fromCache whether the result came from the disk cache.
 */
function renderUsage(usage, model, fromCache) {
  const box = document.getElementById('usageBox');
  if (!box) return;
  box.classList.add('visible');
  const modelTag = `<span class="usage-model">${esc(model || '')}</span>`;
  if (fromCache || !usage) {
    box.innerHTML =
      '<span class="usage-badge">z pamięci podręcznej</span>' + modelTag;
    return;
  }
  const promptTok = usage.prompt_tokens || 0;
  const completionTok = usage.completion_tokens || 0;
  const cachedTok = usage.prompt_tokens_details?.cached_tokens || 0;
  const m = state.orAllModels.find((x) => x.id === model);
  const pPrice = +m?.pricing?.prompt || 0;
  const cPrice = +m?.pricing?.completion || 0;
  const cost = promptTok * pPrice + completionTok * cPrice;
  const costStr = pPrice || cPrice ? '$' + cost.toFixed(4) : 'brak cennika';
  const cachedStr = cachedTok ? ` (z cache: ${cachedTok})` : '';
  box.innerHTML =
    `<span class="usage-item">Wejście: <b>${promptTok}</b> tok${cachedStr}</span>` +
    `<span class="usage-item">Wyjście: <b>${completionTok}</b> tok</span>` +
    `<span class="usage-item">Szac. koszt: <b>${costStr}</b></span>` +
    modelTag;
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
