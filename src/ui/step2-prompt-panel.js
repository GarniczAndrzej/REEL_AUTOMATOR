// Step-2 prompt panel: AI invocation, the JSON editor/paste paths, prompt
// download, and the progress log. Attaches its button listeners via
// initPromptPanel(). (R1 split — pure move; S-16 removed the A/B compare
// feature + AI-cache control.)

import { state, emit } from '../state.js';
import {
  buildPrompt,
  buildClusterPrompt,
  buildCuratePrompt,
} from '../ai/prompt.js';
import { saveTextToPath } from '../util/save-file.js';
import { validateReels, validateThemes } from '../ai/validate.js';
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

// S-25 Phase 4: below this segment count the 'auto' mode runs the legacy
// single-shot call so small jobs don't pay the two-call (cluster→curate)
// overhead. Tunable; initial guess from Phase-1/2 usage data.
const PIPELINE_AUTO_THRESHOLD = 150;
// Stage-1 coverage below this fraction (distinct clustered ids / total segments)
// logs a warning — under-coverage is the silent recall risk this slice targets.
const CLUSTER_COVERAGE_WARN = 0.5;

// Holds the AbortController for the active run; null when idle. Doubles as the
// single-run guard and the run-vs-cancel discriminator for the analyze button.
let analysisController = null;

// S-25 Phase 4: pipeline state retained AFTER a run so the per-bucket retry
// buttons keep working once the run has returned. Null outside a pipeline run.
// Shape: { buckets: Bucket[], sentences: Sentence[], apiKey: string, curateModel: string }
// — `sentences` is captured so a retry curates against the same segment set the
// run used (S-07: the core no longer reads state.sentences).
/**
 * @typedef {Object} Bucket
 * @property {number} index
 * @property {string} title
 * @property {number[]} candidate_ids - stable-sorted, id-filtered segment ids
 * @property {'pending'|'running'|'done'|'error'} status
 * @property {import('../state.js').Reel[]|null} reels - validated reels on success
 * @property {string|null} error
 */
let pipelineState = null;

// S-25 Phase 4: running token/cost totals across all steps of the current run
// (cluster + every bucket, plus retries). Reset at the start of each run; drives
// the quick cost summary in the usage box. Null before the first run.
/** @type {{prompt:number, completion:number, cost:number, steps:number, hasPricing:boolean}|null} */
let usageTotals = null;

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

// Decide single-shot vs cluster→curate pipeline for this run (S-25 Phase 4).
// 'single'/'pipeline' force a path; 'auto' collapses to single-shot below the
// segment-count threshold. Takes the segment set explicitly so the DOM/state-free
// core (`analyzeSentences`) can decide off its passed input, not `state`.
/** @param {import('../state.js').Sentence[]} sentences */
function shouldUsePipeline(sentences) {
  const mode = state.aiPipelineMode || 'auto';
  if (mode === 'single') return false;
  if (mode === 'pipeline') return true;
  return sentences.length >= PIPELINE_AUTO_THRESHOLD;
}

/** @param {'running' | 'idle'} mode */
function setAnalyzeBtnMode(mode) {
  const btn = document.getElementById('analyzeBtn');
  if (mode === 'running') {
    btn.textContent = 'Zatrzymaj';
    btn.classList.remove('btn-primary');
    btn.classList.add('btn-danger');
  } else {
    btn.textContent = 'Analizuj z OpenRouter →';
    btn.classList.remove('btn-danger');
    btn.classList.add('btn-primary');
  }
}

// Manual analyze-button entry. Reads the API key from the step-2 DOM input (its
// one DOM coupling) and delegates the actual run to the exported, DOM-free
// `runAnalysis` wrapper so auto-mode (S-07) and the button share one code path.
async function runAIAnalysis() {
  const apiKey =
    document.getElementById('apiKeyInput').value.trim() ||
    getApiKey('openrouter');
  await runAnalysis({ apiKey });
}

// Single-video wrapper (S-07): the state-committing entry the orchestrator and
// the manual button both drive. Resolves the key (no DOM read — falls back to
// the keychain cache), guards prerequisites, owns the AbortController + progress
// reset, calls the DOM/state-free `analyzeSentences` core, then commits the
// returned reels. An external `signal` (auto-mode) is linked to the internal
// controller so the existing run⇄stop button still cancels an auto-driven run.
/**
 * @param {{ apiKey?: string, signal?: AbortSignal, onProgress?: (p:{label:string, percent:number})=>void }} [opts]
 *   `onProgress` (S-07, Phase 2) feeds the unified auto-mode panel's `Analiza AI`
 *   row; the manual button passes none (no-op).
 * @returns {Promise<void>}
 */
export async function runAnalysis({ apiKey, signal, onProgress } = {}) {
  const key = (apiKey || getApiKey('openrouter') || '').trim();
  if (!key) {
    toast('Otwórz „Ustawienia" i wklej API key OpenRouter!', 'error');
    return;
  }
  if (!state.sentences.length) {
    toast('Najpierw przeanalizuj plik SRT (Krok 1)!', 'error');
    return;
  }

  const usePipeline = shouldUsePipeline(state.sentences);

  // Validate the model(s) the chosen path needs. The pipeline falls back to the
  // single-shot model when a stage model is unset, so any one model is enough.
  if (usePipeline) {
    const clusterModel = state.aiModels.cluster || state.orSelectedModel;
    const curateModel = state.aiModels.curate || state.orSelectedModel;
    if (!clusterModel || !curateModel) {
      toast(
        'Wybierz modele klastrowania i kuracji w „Ustawienia" (lub model legacy).',
        'error',
      );
      return;
    }
  } else if (!state.orSelectedModel) {
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
  // Link an external (auto-mode) signal to the internal controller so a per-stage
  // cancel routed to either side aborts the live fetch.
  if (signal) {
    if (signal.aborted) controller.abort();
    else
      signal.addEventListener('abort', () => controller.abort(), {
        once: true,
      });
  }
  analysisController = controller;
  setAnalyzeBtnMode('running');

  // S-07, Phase 2: while an auto run owns the unified floating panel, suppress
  // the legacy inline #progressBox surface. The setPS/bucket DOM writes below
  // still run, but stay invisible inside the hidden box (no behavior change for
  // manual runs, which keep their surface).
  const progressBox = document.getElementById('progressBox');
  if (!state.autoMode.running) progressBox.classList.add('visible');
  setPS(1, 'running');
  setPS(2, '');
  setPS(3, '');
  logClear();
  document.getElementById('usageBox')?.classList.remove('visible');
  const bucketBox = document.getElementById('bucketList');
  if (bucketBox) bucketBox.innerHTML = '';
  pipelineState = null;
  usageTotals = {
    prompt: 0,
    completion: 0,
    cost: 0,
    steps: 0,
    hasPricing: false,
  };
  document.getElementById('reelsCard').style.display = 'none';
  document.getElementById('step2Next').style.display = 'none';

  try {
    const reels = await analyzeSentences({
      sentences: state.sentences,
      apiKey: key,
      signal: controller.signal,
      onProgress,
    });
    if (reels && reels.length) commitReels(reels);
  } finally {
    analysisController = null;
    setAnalyzeBtnMode('idle');
  }
}

// DOM/state-free analysis core (S-07): runs the S-25 cluster→curate pipeline or
// the legacy single-shot path against the PASSED segments, and RETURNS the
// validated reels (the partial set on a mid-run abort) instead of committing
// them. Never reads #apiKeyInput, never writes state.reelsData, never emit()s —
// so batch (Phase 4) can analyze a document without touching the live surface.
/**
 * @param {{ sentences: import('../state.js').Sentence[], apiKey: string, signal?: AbortSignal, onProgress?: (p:{label:string, percent:number})=>void }} args
 * @returns {Promise<import('../state.js').Reel[]>}
 */
export async function analyzeSentences({
  sentences,
  apiKey,
  signal,
  onProgress,
}) {
  if (shouldUsePipeline(sentences)) {
    return await runPipeline(sentences, apiKey, signal, onProgress);
  }
  return await runSingleShot(sentences, apiKey, signal, onProgress);
}

// Legacy single-shot path: one call → validate → RETURN reels (no commit; the
// `runAnalysis` wrapper owns the state write). Owns its own try/catch so the
// FR-018 paste-fix recovery stays byte-identical. Returns [] on cancel / failure.
async function runSingleShot(sentences, apiKey, signal, onProgress) {
  const orModel = state.orSelectedModel;
  const prompt = buildPrompt(
    state.userPrompt,
    state.systemPrompt,
    sentences,
    null,
    state.videoFilename || '',
  );
  log('Tryb: pojedyncze zapytanie.', 'info');
  log('Przygotowano prompt. Segmentów: ' + sentences.length, 'info');
  log('Model: ' + orModel, 'info');
  setPS(1, 'done');
  setPS(2, 'running');
  onProgress?.({ label: 'Wysyłanie zapytania…', percent: 15 });

  let rawResponse = '';
  try {
    const cacheKey = JSON.stringify({
      provider: 'openrouter',
      model: orModel || '',
      prompt,
    });
    const { result, fromCache, hashShort } = await withLlmCache(cacheKey, () =>
      callOpenRouter(apiKey, prompt, orModel, signal),
    );
    const { content: responseText, usage, finishReason } = result;

    rawResponse = responseText;
    if (fromCache) {
      log(`Odpowiedź z pamięci podręcznej (hash: ${hashShort})`, 'ok');
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
    onProgress?.({ label: 'Przetwarzanie odpowiedzi…', percent: 70 });

    const cleaned = responseText.replace(/```json|```/g, '').trim();
    const parsed = validateReels(JSON.parse(cleaned), sentences);
    setPS(3, 'done');
    log('Sparsowano ' + parsed.length + ' reelsów', 'ok');
    onProgress?.({ label: parsed.length + ' reelsów', percent: 100 });
    return parsed;
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
    return [];
  }
}

// S-25 Phase 4 — cluster→curate pipeline. Stage 1 clusters all segments into
// themes; Stage 2 curates each theme bucket into scored reels; the collected
// reels are RETURNED (the `runAnalysis` wrapper commits them — S-07). Owns its
// own error/abort handling: a Stage-1 failure routes to paste-fix (like
// single-shot); a Stage-2 abort returns the buckets already done (partial
// success).
async function runPipeline(sentences, apiKey, signal, onProgress) {
  const clusterModel = state.aiModels.cluster || state.orSelectedModel;
  const curateModel = state.aiModels.curate || state.orSelectedModel;

  log('Tryb: pipeline klaster → kuracja.', 'info');
  onProgress?.({ label: 'Klastrowanie…', percent: 5 });
  log('Segmentów: ' + sentences.length, 'info');
  log('Model klastrowania: ' + clusterModel, 'info');
  log('Model kuracji: ' + curateModel, 'info');

  // ── Stage 1: cluster ──────────────────────────────────────────────
  const clusterPrompt = buildClusterPrompt(
    state.userPrompt,
    state.clusterPrompt,
    sentences,
    null,
    state.videoFilename || '',
  );
  const clusterKey = JSON.stringify({
    provider: 'openrouter',
    model: clusterModel || '',
    prompt: clusterPrompt,
    stage: 'cluster',
    v: 1,
  });
  setPS(1, 'done');
  setPS(2, 'running');

  let themes;
  let clusterRaw = '';
  try {
    const { result, fromCache, hashShort } = await withLlmCache(
      clusterKey,
      () =>
        callOpenRouter(
          apiKey,
          clusterPrompt,
          clusterModel,
          signal,
          true, // cache_control on the stable transcript prefix (S-25 Phase 5)
        ),
    );
    const { content, usage, finishReason } = result;
    clusterRaw = content;
    if (fromCache) {
      log(`Klastrowanie z pamięci podręcznej (hash: ${hashShort})`, 'ok');
    } else {
      log(
        'Odpowiedź klastrowania otrzymana (' + content.length + ' znaków)',
        'info',
      );
    }
    if (finishReason === 'length') {
      log(
        'Klastrowanie ucięte przez limit tokenów (finish_reason=length).',
        'err',
      );
    }
    reportStepUsage('Etap 1 (klaster)', usage, clusterModel, fromCache);
    const cleaned = content.replace(/```json|```/g, '').trim();
    themes = validateThemes(JSON.parse(cleaned), sentences);
  } catch (e) {
    if (e.name === 'AbortError') {
      setPS(2, '');
      setPS(3, '');
      log('Anulowano.', 'info');
      toast('Anulowano analizę', 'info');
      return [];
    }
    setPS(2, 'err');
    setPS(3, 'err');
    log('BŁĄD klastrowania: ' + e.message, 'err');
    if (clusterRaw) {
      revealPasteFix(clusterRaw, 'Błąd walidacji klastrowania: ' + e.message);
      log(
        'Surowa odpowiedź klastrowania zachowana w polu „Wklej JSON od AI".',
        'err',
      );
    } else {
      log('Sprawdź API key i połączenie internetowe.', 'err');
    }
    return [];
  }

  // Coverage instrument: the fixed cluster defaults can leave most of a long
  // transcript unclustered — a silent recall risk. Log X/N explicitly and warn
  // below the threshold so under-coverage is visible (display only).
  const distinct = new Set();
  themes.forEach((t) => t.candidate_ids.forEach((id) => distinct.add(id)));
  const covered = distinct.size;
  const total = sentences.length;
  log(
    `Sklastrowano ${covered} / ${total} segmentów w ${themes.length} tematach.`,
    'ok',
  );
  if (total && covered / total < CLUSTER_COVERAGE_WARN) {
    log(
      `Niskie pokrycie (${Math.round((covered / total) * 100)}%) — część materiału może zostać pominięta.`,
      'err',
    );
  }

  // Buckets built from a STABLE-SORTED id list so per-bucket prompts hash
  // deterministically (cache reuse depends on it — Critical Implementation Details).
  /** @type {Bucket[]} */
  const buckets = themes.map((t, i) => ({
    index: i,
    title: t.title,
    candidate_ids: [...t.candidate_ids].sort((a, b) => a - b),
    status: 'pending',
    reels: null,
    error: null,
  }));
  pipelineState = { buckets, sentences, apiKey, curateModel };
  renderBucketList(buckets);
  setPS(2, 'done');
  setPS(3, 'running');
  onProgress?.({ label: 'Klastry gotowe', percent: 20 });

  // ── Stage 2: per-bucket curate ────────────────────────────────────
  // Percent maps the 20→95 band across the buckets so the auto-mode panel's
  // `Analiza AI` row advances as each theme is curated.
  let aborted = false;
  let done = 0;
  for (const bucket of buckets) {
    try {
      await runBucket(bucket, sentences, apiKey, curateModel, signal);
    } catch (e) {
      if (e.name === 'AbortError') {
        aborted = true;
        break;
      }
      bucket.status = 'error';
      bucket.error = e.message;
      updateBucketRow(bucket);
    }
    done += 1;
    onProgress?.({
      label: `Kuracja ${done}/${buckets.length}`,
      percent: 20 + Math.round((75 * done) / buckets.length),
    });
  }

  // Convergence: RETURN whatever validated. Completed buckets persist even when
  // some failed or the run was aborted mid-Stage-2 (the wrapper commits them).
  const all = collectPipelineReels();
  if (all.length) {
    const doneCount = buckets.filter((b) => b.status === 'done').length;
    log(
      'Złożono ' + all.length + ' reelsów z ' + doneCount + ' tematów.',
      'ok',
    );
    setPS(3, 'done');
  } else {
    setPS(3, 'err');
    log('Żaden temat nie zwrócił prawidłowych reelsów.', 'err');
  }
  const failed = buckets.filter((b) => b.status === 'error').length;
  if (aborted) {
    log('Anulowano — zachowano ukończone tematy.', 'info');
    toast('Anulowano — zachowano ukończone tematy', 'info');
  }
  if (failed) {
    log(
      `${failed} tematów nie powiodło się — kliknij „Ponów" przy nich.`,
      'err',
    );
  }
  logCostSummary();
  onProgress?.({ label: all.length + ' reelsów', percent: 100 });
  return all;
}

// Quick total-cost summary line into the log (the usage box shows the same live
// total). Cache-only runs report no billable cost.
function logCostSummary() {
  if (!usageTotals) return;
  const costStr = usageTotals.hasPricing
    ? '$' + usageTotals.cost.toFixed(4)
    : 'brak cennika';
  log(
    `Podsumowanie: ${usageTotals.steps} zapytań · wejście ${usageTotals.prompt} tok · wyjście ${usageTotals.completion} tok · łączny koszt ${costStr}`,
    'ok',
  );
}

// Curate a single theme bucket: send only its candidate segments to the curate
// model and validate the returned reels. Non-abort errors are caught and recorded
// on the bucket (per-bucket retry); an abort is rethrown so the Stage-2 loop can
// commit the buckets already done.
/**
 * @param {Bucket} bucket
 * @param {import('../state.js').Sentence[]} sentences
 * @param {string} apiKey
 * @param {string} curateModel
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
async function runBucket(bucket, sentences, apiKey, curateModel, signal) {
  bucket.status = 'running';
  bucket.error = null;
  updateBucketRow(bucket);
  try {
    const idSet = new Set(bucket.candidate_ids);
    const segs = sentences.filter((s) => idSet.has(s.id));
    const bucketPrompt = buildCuratePrompt(
      state.userPrompt,
      state.curatePrompt,
      segs,
      null,
      state.videoFilename || '',
    );
    const key = JSON.stringify({
      provider: 'openrouter',
      model: curateModel || '',
      prompt: bucketPrompt,
      stage: 'curate',
      v: 1,
    });
    const { result, fromCache } = await withLlmCache(key, () =>
      callOpenRouter(
        apiKey,
        bucketPrompt,
        curateModel,
        signal,
        true, // cache_control on the bucket's stable prefix (S-25 Phase 5)
      ),
    );
    const { content, usage, finishReason } = result;
    reportStepUsage(
      `Etap 2 — „${bucket.title}"`,
      usage,
      curateModel,
      fromCache,
    );
    if (finishReason === 'length') {
      log(
        `Temat „${bucket.title}": odpowiedź ucięta (finish_reason=length).`,
        'err',
      );
    }
    const cleaned = content.replace(/```json|```/g, '').trim();
    const reels = validateReels(JSON.parse(cleaned), sentences);
    bucket.reels = reels;
    bucket.status = 'done';
    log(
      `Temat „${bucket.title}": ${reels.length} reelsów${fromCache ? ' (z pamięci podręcznej)' : ''}`,
      'ok',
    );
  } catch (e) {
    if (e.name === 'AbortError') {
      // Did not complete — return it to pending and let the loop handle commit.
      bucket.status = 'pending';
      updateBucketRow(bucket);
      throw e;
    }
    bucket.status = 'error';
    bucket.error = e.message;
    log(`Temat „${bucket.title}" błąd: ${e.message}`, 'err');
  }
  updateBucketRow(bucket);
}

// Re-run ONLY one failed bucket (no Stage 1, no other buckets) and re-commit the
// full reel set. The recommit does not push a new undo snapshot — the first
// pipeline commit already captured pre-analysis state.
/** @param {number} index */
async function retryBucket(index) {
  if (!pipelineState) return;
  const bucket = pipelineState.buckets[index];
  if (!bucket || bucket.status === 'running') return;
  await runBucket(
    bucket,
    pipelineState.sentences,
    pipelineState.apiKey,
    pipelineState.curateModel,
  );
  const all = collectPipelineReels();
  if (all.length) {
    commitReels(all, false);
    log('Zaktualizowano: ' + all.length + ' reelsów.', 'ok');
  }
  logCostSummary();
}

// Concatenate the validated reels of every successful bucket, in bucket order.
/** @returns {import('../state.js').Reel[]} */
function collectPipelineReels() {
  const all = [];
  if (!pipelineState) return all;
  for (const b of pipelineState.buckets) {
    if (b.status === 'done' && b.reels) all.push(...b.reels);
  }
  return all;
}

// Shared convergence tail (the only place state.reelsData is written on a run).
// `pushHistory` is false on a pipeline retry recommit so retries don't pile up
// undo entries.
/**
 * @param {import('../state.js').Reel[]} reels
 * @param {boolean} [pushHistory=true]
 * @returns {void}
 */
function commitReels(reels, pushHistory = true) {
  // Snapshot pre-analysis state, then default fresh output to score-desc.
  // sortReels stamps ai_order, sets state.reelSort, pushes its own snapshot,
  // and re-renders — so undo returns to pre-analysis in two steps.
  if (pushHistory) pushUndo(snap());
  state.reelsData = reels;
  sortReels('score_desc');
  document.getElementById('statusReels').textContent = state.reelsData.length;
  document.getElementById('reelsCard').style.display = 'block';
  document.getElementById('step2Next').style.display = 'flex';
  emit();
}

// Render the per-bucket Stage-2 status list (one row per theme). Rows update in
// place via updateBucketRow as buckets run.
/** @param {Bucket[]} buckets */
function renderBucketList(buckets) {
  const box = document.getElementById('bucketList');
  if (!box) return;
  box.innerHTML = '';
  for (const b of buckets) {
    const row = document.createElement('div');
    row.id = 'bucket-row-' + b.index;
    box.appendChild(row);
    updateBucketRow(b);
  }
}

const BUCKET_ICON = { pending: '·', running: '…', done: '✓', error: '✗' };
const BUCKET_CLASS = {
  pending: '',
  running: 'running',
  done: 'ok',
  error: 'err',
};

/** @param {Bucket} bucket */
function updateBucketRow(bucket) {
  const row = document.getElementById('bucket-row-' + bucket.index);
  if (!row) return;
  row.className = 'bucket-row ' + (BUCKET_CLASS[bucket.status] || '');
  const count = bucket.reels ? ` (${bucket.reels.length})` : '';
  let html =
    `<span class="bucket-status">${BUCKET_ICON[bucket.status] || ''}</span>` +
    `<span class="bucket-title">${esc(bucket.title)}${count}</span>`;
  if (bucket.status === 'error') {
    html += `<button class="btn btn-secondary bucket-retry" data-bucket="${bucket.index}">Ponów</button>`;
  }
  row.innerHTML = html;
  if (bucket.status === 'error') {
    row
      .querySelector('.bucket-retry')
      ?.addEventListener('click', () => retryBucket(bucket.index));
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
    status.textContent = `Wczytano ${state.reelsData.length} reelsów`;
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
    toast('Prompt skopiowany do schowka', 'success');
  } catch {
    toast('Nie udało się skopiować — użyj „Eksportuj prompt .txt".', 'error');
  }
}

// Token + cost figures for one `usage` object against a model's pricing.
/**
 * @param {object|null} usage `data.usage` verbatim or null.
 * @param {string} model OpenRouter model id.
 * @returns {{prompt:number, completion:number, cached:number, cost:number, hasPricing:boolean}}
 */
function computeUsage(usage, model) {
  const prompt = usage?.prompt_tokens || 0;
  const completion = usage?.completion_tokens || 0;
  const cached = usage?.prompt_tokens_details?.cached_tokens || 0;
  const m = state.orAllModels.find((x) => x.id === model);
  const pPrice = +m?.pricing?.prompt || 0;
  const cPrice = +m?.pricing?.completion || 0;
  return {
    prompt,
    completion,
    cached,
    cost: prompt * pPrice + completion * cPrice,
    hasPricing: !!(pPrice || cPrice),
  };
}

// Compact Polish per-run token/cost readout (single-shot path). On a cache hit
// there is no fresh usage, so show a "z pamięci podręcznej" badge instead of
// fabricated numbers.
/**
 * @param {object|null} usage `data.usage` verbatim or null.
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
  const u = computeUsage(usage, model);
  const costStr = u.hasPricing ? '$' + u.cost.toFixed(4) : 'brak cennika';
  const cachedStr = u.cached ? ` (z cache: ${u.cached})` : '';
  box.innerHTML =
    `<span class="usage-item">Wejście: <b>${u.prompt}</b> tok${cachedStr}</span>` +
    `<span class="usage-item">Wyjście: <b>${u.completion}</b> tok</span>` +
    `<span class="usage-item">Szac. koszt: <b>${costStr}</b></span>` +
    modelTag;
}

// S-25 Phase 4: log a per-step in/out/cost line into the log box and fold real
// usage into the running pipeline totals + summary. Cache hits log a cached note
// and contribute nothing to the totals.
/**
 * @param {string} label step label, e.g. 'Etap 1 (klaster)'.
 * @param {object|null} usage `data.usage` verbatim or null.
 * @param {string} model OpenRouter model id used for the step.
 * @param {boolean} fromCache whether the result came from the disk cache.
 * @returns {void}
 */
function reportStepUsage(label, usage, model, fromCache) {
  if (fromCache || !usage) {
    log(`${label}: z pamięci podręcznej (bez kosztu)`, 'info');
  } else {
    const u = computeUsage(usage, model);
    const costStr = u.hasPricing ? '$' + u.cost.toFixed(4) : 'brak cennika';
    const cachedStr = u.cached ? ` (z cache: ${u.cached})` : '';
    log(
      `${label}: wejście ${u.prompt} tok${cachedStr} · wyjście ${u.completion} tok · koszt ${costStr}`,
      'info',
    );
    accumulateUsage(u);
  }
  renderUsageSummary();
}

// Fold one step's computed usage into the running totals (Phase 4 pipeline).
/** @param {{prompt:number, completion:number, cost:number, hasPricing:boolean}} u */
function accumulateUsage(u) {
  if (!usageTotals) return;
  usageTotals.prompt += u.prompt || 0;
  usageTotals.completion += u.completion || 0;
  usageTotals.cost += u.cost || 0;
  usageTotals.steps += 1;
  if (u.hasPricing) usageTotals.hasPricing = true;
}

// Render the running pipeline cost summary into the usage box (Phase 4). Updates
// in place after every billed step and after a retry.
function renderUsageSummary() {
  const box = document.getElementById('usageBox');
  if (!box || !usageTotals) return;
  box.classList.add('visible');
  const costStr = usageTotals.hasPricing
    ? '$' + usageTotals.cost.toFixed(4)
    : 'brak cennika';
  box.innerHTML =
    `<span class="usage-item">Σ wejście: <b>${usageTotals.prompt}</b> tok</span>` +
    `<span class="usage-item">Σ wyjście: <b>${usageTotals.completion}</b> tok</span>` +
    `<span class="usage-item">Łączny koszt: <b>${costStr}</b></span>` +
    `<span class="usage-model">${usageTotals.steps} zapytań</span>`;
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
