// Step-2 prompt panel: AI invocation, the JSON editor/paste paths, the A/B
// compare feature, prompt download, and the progress log. Attaches its button
// listeners via initPromptPanel(). (R1 split — pure move.)

import { state, emit } from '../state.js';
import { buildPrompt } from '../ai/prompt.js';
import { saveTextToPath } from '../util/save-file.js';
import { validateReels } from '../ai/validate.js';
import { callOpenRouter } from '../ai/providers.js';
import { getApiKey } from '../ai/api-key.js';
import { withLlmCache, clearLlmCache } from '../ai/cache.js';
import { renderReels, esc } from './step2-reel-list.js';
import { snap, pushUndo } from './step2-segment-ops.js';

// ── Init ───────────────────────────────────────────────────────────

export function initPromptPanel() {
  document
    .getElementById('analyzeBtn')
    .addEventListener('click', runAIAnalysis);
  document
    .getElementById('clearLlmCacheBtn')
    .addEventListener('click', async () => {
      await clearLlmCache();
      alert('Cache AI wyczyszczony.');
    });
  document
    .getElementById('downloadPromptBtn')
    .addEventListener('click', downloadPromptTXT);
  document
    .getElementById('editJsonBtn')
    .addEventListener('click', editReelsJSON);
  document
    .getElementById('applyManualJsonBtn')
    .addEventListener('click', applyManualJSON);
  document
    .getElementById('applyPastedJsonBtn')
    .addEventListener('click', applyPastedJSON);
  document
    .getElementById('clearPastedJsonBtn')
    .addEventListener('click', clearPastedJSON);

  document
    .getElementById('compareBtn')
    .addEventListener('click', openCompareModal);
  document
    .getElementById('compareModalClose')
    .addEventListener('click', closeCompareModal);
  document
    .getElementById('compareRunBtn')
    .addEventListener('click', runComparison);
  document
    .getElementById('compareUseA')
    .addEventListener('click', () => applyCompareResult('A'));
  document
    .getElementById('compareUseB')
    .addEventListener('click', () => applyCompareResult('B'));
  document
    .getElementById('compareMerge')
    .addEventListener('click', () => applyCompareResult('merge'));
  document
    .getElementById('compareProviderA')
    .addEventListener('change', syncCompareModelRow);
  document
    .getElementById('compareProviderB')
    .addEventListener('change', syncCompareModelRow);
  syncCompareModelRow();
}

// ── AI analysis ────────────────────────────────────────────────────

async function runAIAnalysis() {
  const apiKey =
    document.getElementById('apiKeyInput').value.trim() ||
    getApiKey('openrouter');
  if (!apiKey) {
    alert('Wklej API key w nagłówku!');
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
    state.sentences,
    state.sources?.length ? state.sources : null,
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
  document
    .getElementById('pasteJsonCard')
    ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function editReelsJSON() {
  const card = document.getElementById('jsonEditorCard');
  card.style.display = card.style.display === 'none' ? 'block' : 'none';
  document.getElementById('jsonEditor').value = JSON.stringify(
    state.reelsData,
    null,
    2,
  );
}

function applyManualJSON() {
  try {
    const parsed = validateReels(
      JSON.parse(document.getElementById('jsonEditor').value),
      state.sentences,
    );
    const before = snap();
    state.reelsData = parsed;
    pushUndo(before);
    renderReels();
    document.getElementById('statusReels').textContent = state.reelsData.length;
    document.getElementById('reelsCard').style.display = 'block';
    document.getElementById('step2Next').style.display = 'flex';
    document.getElementById('jsonEditorCard').style.display = 'none';
    log('JSON zastosowany: ' + state.reelsData.length + ' reelsów', 'ok');
    emit();
  } catch (e) {
    alert('Błąd parsowania JSON:\n' + e.message);
  }
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

// ── F8 — Compare two AI runs ───────────────────────────────────────

let compareResultA = null;
let compareResultB = null;

function openCompareModal() {
  document.getElementById('compareModal').style.display = 'flex';
  compareResultA = null;
  compareResultB = null;
  document.getElementById('compareDiff').style.display = 'none';
  document.getElementById('compareActions').style.display = 'none';
  document.getElementById('compareLog').style.display = 'none';
}

function closeCompareModal() {
  document.getElementById('compareModal').style.display = 'none';
}

function syncCompareModelRow() {
  ['A', 'B'].forEach((side) => {
    const sel = document.getElementById('compareProvider' + side);
    const row = document.getElementById('compareModelRow' + side);
    if (row)
      row.style.display = sel && sel.value === 'openrouter' ? '' : 'none';
  });
}

async function runComparison() {
  if (!state.sentences.length) {
    alert('Najpierw załaduj SRT (Krok 1)!');
    return;
  }
  const prompt = buildPrompt(
    state.userPrompt,
    state.sentences,
    state.sources?.length ? state.sources : null,
    state.videoFilename || '',
  );

  const getConfig = (side) => ({
    provider: document.getElementById('compareProvider' + side).value,
    key:
      document.getElementById('compareKey' + side).value.trim() ||
      getApiKey(document.getElementById('compareProvider' + side).value),
    model: document.getElementById('compareModel' + side)?.value.trim() || '',
  });

  const cfgA = getConfig('A');
  const cfgB = getConfig('B');
  if (!cfgA.key) {
    alert('Brak API key dla dostawcy A!');
    return;
  }
  if (!cfgB.key) {
    alert('Brak API key dla dostawcy B!');
    return;
  }

  const logEl = document.getElementById('compareLog');
  logEl.style.display = 'block';
  logEl.innerHTML = '<div>Uruchamiam oba dostawców równolegle…</div>';

  const callProvider = async (cfg) => {
    const cacheKey = JSON.stringify({
      provider: cfg.provider,
      model: cfg.model,
      prompt,
    });
    const { result } = await withLlmCache(cacheKey, () =>
      callOpenRouter(cfg.key, prompt, cfg.model),
    );
    return validateReels(
      JSON.parse(result.replace(/```json|```/g, '').trim()),
      state.sentences,
    );
  };

  document.getElementById('compareRunBtn').disabled = true;
  try {
    [compareResultA, compareResultB] = await Promise.all([
      callProvider(cfgA).catch((e) => {
        throw new Error('A: ' + e.message);
      }),
      callProvider(cfgB).catch((e) => {
        throw new Error('B: ' + e.message);
      }),
    ]);
    logEl.innerHTML +=
      '<div style="color:var(--green)">✓ Oba dostawcy odpowiedzieli.</div>';
    renderCompareDiff(compareResultA, compareResultB);
  } catch (e) {
    logEl.innerHTML += `<div style="color:var(--red)">Błąd: ${esc(e.message)}</div>`;
  } finally {
    document.getElementById('compareRunBtn').disabled = false;
  }
}

function renderCompareDiff(runA, runB) {
  const idsA = new Set(runA.flatMap((r) => r.clip_ids));
  const idsB = new Set(runB.flatMap((r) => r.clip_ids));
  const all = [...new Set([...idsA, ...idsB])].sort((a, b) => a - b);

  const rows = all
    .map((id) => {
      const s = state.sentences.find((x) => x.id === id);
      const txt = s
        ? esc(s.text.substring(0, 60)) + (s.text.length > 60 ? '…' : '')
        : `id=${id}`;
      const inA = idsA.has(id),
        inB = idsB.has(id);
      const col = inA && inB ? 'both' : inA ? 'a-only' : 'b-only';
      return `<tr class="diff-row diff-${col}">
      <td style="padding:4px 8px;font-size:11px;color:var(--text2);">${id}</td>
      <td style="padding:4px 8px;font-size:11px;">${txt}</td>
      <td style="padding:4px 8px;text-align:center;">${inA ? '✓' : ''}</td>
      <td style="padding:4px 8px;text-align:center;">${inB ? '✓' : ''}</td>
    </tr>`;
    })
    .join('');

  const diffEl = document.getElementById('compareDiff');
  diffEl.style.display = 'block';
  diffEl.innerHTML = `
<div style="margin-bottom:8px;font-size:12px;color:var(--text2);">
  Dostawca A: ${runA.length} reelsów | Dostawca B: ${runB.length} reelsów<br>
  Tylko A: ${[...idsA].filter((id) => !idsB.has(id)).length} kl. | Tylko B: ${[...idsB].filter((id) => !idsA.has(id)).length} kl. | Wspólne: ${[...idsA].filter((id) => idsB.has(id)).length} kl.
</div>
<div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;">
<table style="width:100%;border-collapse:collapse;">
  <thead><tr style="background:var(--surface2);">
    <th style="padding:6px 8px;font-size:11px;text-align:left;">#</th>
    <th style="padding:6px 8px;font-size:11px;text-align:left;">Tekst</th>
    <th style="padding:6px 8px;font-size:11px;">A</th>
    <th style="padding:6px 8px;font-size:11px;">B</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
</div>`;
  document.getElementById('compareActions').style.display = 'flex';
}

function applyCompareResult(which) {
  let result;
  if (which === 'A') result = compareResultA;
  else if (which === 'B') result = compareResultB;
  else {
    // Merge: union of all clip_ids, de-duped per reel
    const allReels = [...(compareResultA || []), ...(compareResultB || [])];
    const merged = {};
    for (const r of allReels) {
      const key = r.reel_name;
      if (!merged[key]) merged[key] = { ...r, clip_ids: [] };
      for (const id of r.clip_ids) {
        if (!merged[key].clip_ids.includes(id)) merged[key].clip_ids.push(id);
      }
    }
    result = Object.values(merged);
  }
  if (!result) return;
  pushUndo(snap());
  state.reelsData = result;
  renderReels();
  document.getElementById('statusReels').textContent = state.reelsData.length;
  document.getElementById('reelsCard').style.display = 'block';
  document.getElementById('step2Next').style.display = 'flex';
  closeCompareModal();
  emit();
}

async function downloadPromptTXT() {
  if (!state.sentences.length) {
    alert('Najpierw przeanalizuj SRT (Krok 1)!');
    return;
  }
  const content = buildPrompt(
    state.userPrompt,
    state.sentences,
    state.sources?.length ? state.sources : null,
    state.videoFilename || '',
  );
  await saveTextToPath({ defaultName: 'PROMPT_DLA_AI.txt', content });
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
