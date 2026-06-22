// Import-section submodule: WhisperX transcription, the local model manager,
// the WhisperX advanced settings modal, diarization controls, force-align of an
// imported transcript, and transcript SRT/VTT export. (S-16 Phase 3a —
// structural split, no behavior change.)

import { state, emit } from '../../state.js';
import { toast } from '../toast.js';
import { segmentFromWords } from '../../parser/word-segments.js';
import { generateTranscriptVTT } from '../../exporters/transcript.js';
import { getApiKey, setApiKey } from '../../ai/api-key.js';
import { saveTextToPath } from '../../util/save-file.js';
import { exportTranscriptSrt } from '../export-srt.js';
import { populateVideoMeta } from '../../util/video-meta.js';
import {
  MIN_CHARS,
  renderSegments,
  mergeWordsIntoSentences,
  loadSRTContent,
  escHtml,
} from './segments.js';

export function initTranscribe() {
  // S-05 — transcript align + export
  document
    .getElementById('alignTranscriptBtn')
    .addEventListener('click', alignImportedTranscript);
  document
    .getElementById('exportSrtBtn')
    .addEventListener('click', exportTranscriptSrt);
  document
    .getElementById('exportVttBtn')
    .addEventListener('click', exportTranscriptVTT);

  // S-05 — Built-in WhisperX transcription + model manager
  document
    .getElementById('browseWhisperVideoBtn')
    .addEventListener('click', browseWhisperVideo);
  document.getElementById('whisperLanguage').addEventListener('change', (e) => {
    state.whisperLanguage = e.target.value;
  });
  document
    .getElementById('transcribeBtn')
    .addEventListener('click', transcribeWithWhisper);
  document
    .getElementById('cancelTranscribeBtn')
    .addEventListener('click', cancelTranscribe);
  // Phase 6 — diarization toggle + HF token
  const diarizeToggle = document.getElementById('diarizeToggle');
  diarizeToggle.checked = state.diarize;
  const hfTokenInput = document.getElementById('hfTokenInput');
  hfTokenInput.value = getApiKey('huggingface');
  document.getElementById('diarizeTokenRow').style.display = state.diarize
    ? ''
    : 'none';
  diarizeToggle.addEventListener('change', (e) => {
    state.diarize = e.target.checked;
    document.getElementById('diarizeTokenRow').style.display = e.target.checked
      ? ''
      : 'none';
    emit();
  });
  hfTokenInput.addEventListener('input', (e) => {
    setApiKey('huggingface', e.target.value.trim());
  });
  // S-18 — manual full self-test (heavy align), the only path that earns the
  // authoritative green "Silnik gotowy" badge. The launch probe is the cheap
  // cached capability check (see refreshEngineReadiness).
  const fullVerifyBtn = document.getElementById('fullEngineVerifyBtn');
  if (fullVerifyBtn) fullVerifyBtn.addEventListener('click', fullEngineVerify);
  initModelManager();
  initWhisperAdvanced();
}

// ── F1 Whisper transcription ──────────────────────────────────────

function syncTranscribeBtn() {
  const hasVideo = !!state._whisperVideoPath;
  const hasModel = !!state.modelId && !!_modelStatus[state.modelId]?.downloaded;
  document.getElementById('transcribeBtn').disabled = !(hasVideo && hasModel);
}

// ── S-05 model manager ────────────────────────────────────────────────

/** @type {Record<string,{downloaded:boolean,path?:string}>} */
let _modelStatus = {};
let _downloadingId = null;

async function initModelManager() {
  // Render the model list immediately. The launch badge is a pure cache READ
  // (whisperx_engine_cached) — it never spawns the sidecar, because even the
  // "cheap" probe pays a 37–67 s cold cost (290 MB onefile extraction + torch
  // import). The badge paints only from a prior "Pełna weryfikacja" result; a
  // miss invites the user to run it on demand. Kick it off without awaiting.
  await refreshModelStatus();
  await renderModelManager();
  refreshEngineReadiness();
}

/**
 * Paint the engine-readiness badge from a status verdict.
 * @param {HTMLElement|null} el
 * @param {{ok:boolean, device?:string, gpu?:boolean, alignment_model_ready?:boolean}} status
 * @param {{authoritative:boolean}} opts - `authoritative` is true ONLY for the full
 *   `--selftest` path, which is the sole path allowed to paint the green "Silnik gotowy"
 *   tier. The cheap capability probe cannot `import whisperx`, so it cannot verify the
 *   frozen import chain (the false-positive documented in whisperx_engine.py) — it paints
 *   the distinct, non-authoritative amber "Silnik wykryty" tier instead.
 */
function renderEngineBadge(el, status, { authoritative }) {
  if (!el) return;
  if (status.ok) {
    const dev = `${status.device || 'cpu'}${status.gpu ? ', GPU' : ''}`;
    if (authoritative) {
      el.textContent = `✓ Silnik gotowy (${dev})${status.alignment_model_ready ? ', model dopasowania wbudowany' : ''}`;
      el.style.color = 'var(--green)';
    } else {
      el.textContent = `✓ Silnik wykryty (${dev}) — pełna weryfikacja zalecana`;
      el.style.color = 'var(--amber)';
    }
  } else {
    el.textContent =
      '⚠ Silnik WhisperX nie jest jeszcze zbudowany. Uruchom sidecar/build.sh.';
    el.style.color = 'var(--amber)';
  }
}

async function refreshEngineReadiness() {
  const el = document.getElementById('engineReadyIndicator');
  if (!el) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    // Pure cache read — never spawns the sidecar (see initModelManager). `null`
    // = no prior verification on this machine for the current engine version.
    const s = await invoke('whisperx_engine_cached');
    if (s) {
      // Cached verdict carries its own `authoritative` flag (true only when a
      // full self-test wrote it), so the badge paints the correct tier.
      renderEngineBadge(el, s, { authoritative: !!s.authoritative });
    } else {
      el.textContent =
        'Silnik niezweryfikowany — kliknij „Pełna weryfikacja silnika”.';
      el.style.color = 'var(--text3)';
    }
  } catch (e) {
    el.textContent = '⚠ Nie można sprawdzić silnika: ' + e;
    el.style.color = 'var(--amber)';
  }
}

// Manual full self-test: the heavy `--selftest` (loads the align model, runs a
// real forced-align) — also refreshes the Rust readiness cache. The only path
// that earns the authoritative green badge.
async function fullEngineVerify() {
  const el = document.getElementById('engineReadyIndicator');
  const btn = document.getElementById('fullEngineVerifyBtn');
  if (btn) btn.disabled = true;
  if (el) {
    el.textContent = 'Pełna weryfikacja silnika…';
    el.style.color = 'var(--text3)';
  }
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const s = await invoke('whisperx_engine_check');
    renderEngineBadge(el, s, { authoritative: true });
  } catch (e) {
    if (el) {
      el.textContent = '⚠ Nie można sprawdzić silnika: ' + e;
      el.style.color = 'var(--amber)';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function refreshModelStatus() {
  try {
    const { MODEL_REGISTRY } =
      await import('../../transcription/model-registry.js');
    const { invoke } = await import('@tauri-apps/api/core');
    const list = await invoke('list_models', {
      modelIds: MODEL_REGISTRY.map((m) => m.id),
    });
    _modelStatus = {};
    for (const s of list) _modelStatus[s.id] = s;
  } catch (e) {
    _modelStatus = {};
  }
  syncTranscribeBtn();
}

export async function renderModelManager() {
  const container = document.getElementById('modelManagerList');
  if (!container) return;
  const { MODEL_REGISTRY, formatBytes } =
    await import('../../transcription/model-registry.js');
  // Compact dropdown picker: one <option> per registry model, annotated with
  // size + download status. Selecting a downloaded model makes it active;
  // selecting a missing one surfaces the ⬇ Pobierz button beside the dropdown.
  const options = MODEL_REGISTRY.map((m) => {
    const st = _modelStatus[m.id] || {};
    const status = st.downloaded ? 'Pobrany' : 'Brak';
    const sel = state.modelId === m.id ? ' selected' : '';
    return `<option value="${m.id}"${sel}>${escHtml(m.label)} — ${status}</option>`;
  }).join('');

  const selModel = MODEL_REGISTRY.find((m) => m.id === state.modelId);
  const selDownloaded = !!(selModel && _modelStatus[selModel.id]?.downloaded);
  const showDownload = !!selModel && !selDownloaded;
  const disabledAttr = _downloadingId ? 'disabled' : '';

  container.innerHTML = `
<div style="display:flex;gap:8px;align-items:center;">
  <select id="modelSelect" style="flex:1;min-width:0;font-size:13px;" ${disabledAttr}>
    <option value=""${state.modelId ? '' : ' selected'} disabled>— wybierz model —</option>
    ${options}
  </select>
  ${
    showDownload
      ? `<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;white-space:nowrap;" data-download-model="${selModel.id}" ${disabledAttr}>⬇ Pobierz</button>`
      : ''
  }
  ${
    selDownloaded
      ? `<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;white-space:nowrap;" data-delete-model="${selModel.id}" ${disabledAttr}>🗑 Usuń</button>`
      : ''
  }
</div>
<div class="model-dl-progress" id="modelDlProgress" style="display:none;font-size:11px;color:var(--text2);margin-top:6px;"></div>`;

  const sel = container.querySelector('#modelSelect');
  if (sel) sel.addEventListener('change', () => selectModel(sel.value));
  const dlBtn = container.querySelector('[data-download-model]');
  if (dlBtn) {
    dlBtn.addEventListener('click', () =>
      downloadModel(dlBtn.dataset.downloadModel),
    );
  }
  const delBtn = container.querySelector('[data-delete-model]');
  if (delBtn) {
    delBtn.addEventListener('click', () =>
      deleteModel(delBtn.dataset.deleteModel),
    );
  }
}

async function deleteModel(id) {
  const { getModel } = await import('../../transcription/model-registry.js');
  const model = getModel(id);
  const label = model ? model.label : id;
  // Use Tauri's native dialog — window.confirm() does not reliably show a panel
  // in the WKWebView and can resolve without prompting.
  const { ask } = await import('@tauri-apps/plugin-dialog');
  const confirmed = await ask(
    `Usunąć model „${label}" z dysku? Tej operacji nie można cofnąć.`,
    {
      title: 'Usuń model',
      kind: 'warning',
      okLabel: 'Usuń',
      cancelLabel: 'Anuluj',
    },
  );
  if (!confirmed) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('delete_model', { modelId: id });
    if (state.modelId === id) {
      state.modelId = '';
      emit();
    }
    await refreshModelStatus();
    await renderModelManager();
  } catch (e) {
    toast('Nie udało się usunąć modelu: ' + e, 'error');
  }
}

function selectModel(id) {
  state.modelId = id;
  emit();
  renderModelManager();
  syncTranscribeBtn();
}

async function downloadModel(id) {
  const { getModel } = await import('../../transcription/model-registry.js');
  const model = getModel(id);
  if (!model) return;
  if (!model.repo || !model.files?.length) {
    toast(
      'Ten model nie ma jeszcze skonfigurowanego repozytorium/plików do pobrania (uzupełnij rejestr).',
      'info',
    );
    return;
  }
  _downloadingId = id;
  // Must await: renderModelManager() is async (awaits a dynamic import before
  // rewriting container.innerHTML). Without await, the querySelector below grabs
  // the pre-render node, which the pending innerHTML rewrite then detaches — so
  // every progress update writes to an orphaned element and the UI shows nothing.
  await renderModelManager();
  const progEl = document.getElementById('modelDlProgress');
  if (progEl) progEl.style.display = 'block';

  let unlisten;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    unlisten = await listen('model-download-progress', (e) => {
      if (e.payload.modelId !== id) return;
      const { percent, bytesPerSec, etaSec } = e.payload;
      if (progEl) {
        const mb = (bytesPerSec / 1024 / 1024).toFixed(1);
        const eta = etaSec ? `${Math.round(etaSec)}s` : '—';
        progEl.textContent = `${Math.round(percent)}% · ${mb} MB/s · ETA ${eta}`;
      }
    });
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('download_model', {
      modelId: id,
      repo: model.repo,
      files: model.files,
      totalBytes: model.sizeBytes || null,
    });
    if (progEl) progEl.textContent = '✓ Pobrano i zweryfikowano';
    await refreshModelStatus();
    selectModel(id);
  } catch (e) {
    if (progEl) progEl.textContent = 'Błąd: ' + e;
    toast('Pobieranie modelu nieudane: ' + e, 'error');
  } finally {
    if (unlisten) unlisten();
    _downloadingId = null;
    renderModelManager();
  }
}

async function cancelTranscribe() {
  // Reset the UI immediately so the user can start again right away, instead of
  // waiting for the (now cancellable) backend promise to unwind. The backend
  // SIGTERMs the engine and the driver returns the cancelled state shortly.
  setWhisperProgress('Anulowano.', 0);
  document.getElementById('cancelTranscribeBtn').style.display = 'none';
  syncTranscribeBtn();
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('cancel_transcription');
  } catch (e) {
    // ignore
  }
}

// ── S-05 Phase 7 — WhisperX advanced settings modal ───────────────────
// Minimal high-value subset of engine knobs. Empty/default fields fall back to
// the engine's defaults (untouched modal = no behavior change). Only the
// per-machine perf knobs (device, computeType) are persisted to localStorage;
// they are deliberately NOT written to .reelproj (F3 decision).
const WHISPER_ADV_LS_KEY = 'edl_whisper_advanced';

/**
 * Default WhisperX advanced-settings bag (per-machine prefs + run knobs).
 * @returns {typeof import('../../state.js').state.whisperAdvanced}
 */
function defaultWhisperAdvanced() {
  return {
    device: '',
    computeType: '',
    beamSize: null,
    initialPrompt: '',
    vadOnset: null,
    vadOffset: null,
    minSpeakers: null,
    maxSpeakers: null,
    wordLevelSrtExport: false,
  };
}

/**
 * Hydrate the per-machine advanced prefs (device / computeType /
 * wordLevelSrtExport) from localStorage into state.whisperAdvanced.
 * @returns {void}
 */
function loadWhisperAdvancedFromLS() {
  try {
    const saved = JSON.parse(localStorage.getItem(WHISPER_ADV_LS_KEY) || '{}');
    if (typeof saved.device === 'string')
      state.whisperAdvanced.device = saved.device;
    if (typeof saved.computeType === 'string')
      state.whisperAdvanced.computeType = saved.computeType;
    if (typeof saved.wordLevelSrtExport === 'boolean')
      state.whisperAdvanced.wordLevelSrtExport = saved.wordLevelSrtExport;
  } catch (e) {}
}

/**
 * Persist only the per-machine advanced prefs to localStorage (never the
 * .reelproj-bound run settings).
 * @returns {void}
 */
function saveWhisperAdvancedToLS() {
  try {
    // Per-machine prefs only — never the .reelproj-bound run settings.
    localStorage.setItem(
      WHISPER_ADV_LS_KEY,
      JSON.stringify({
        device: state.whisperAdvanced.device,
        computeType: state.whisperAdvanced.computeType,
        wordLevelSrtExport: state.whisperAdvanced.wordLevelSrtExport,
      }),
    );
  } catch (e) {}
}

function initWhisperAdvanced() {
  loadWhisperAdvancedFromLS();
  const openBtn = document.getElementById('whisperAdvancedBtn');
  const modal = document.getElementById('whisperAdvancedModal');
  const closeBtn = document.getElementById('whisperAdvancedClose');
  if (!openBtn || !modal || !closeBtn) return;
  const close = () => {
    modal.style.display = 'none';
  };
  openBtn.addEventListener('click', () => {
    fillWhisperAdvancedForm();
    modal.style.display = 'flex';
  });
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
  // Live-persist the word-SRT toggle on change (not just on "Zapisz"), so the
  // flag sticks regardless of how the modal is dismissed (Zapisz / X / backdrop)
  // and survives a restart. Write ONLY the checkbox here — calling the full
  // applyWhisperAdvancedForm would capture the other unsaved fields and break
  // the Zapisz/Anuluj semantics the rest of the modal relies on.
  const wordSrtEl = document.getElementById('advWordLevelSrt');
  if (wordSrtEl) {
    wordSrtEl.addEventListener('change', (e) => {
      state.whisperAdvanced.wordLevelSrtExport = e.target.checked;
      saveWhisperAdvancedToLS();
      emit();
    });
  }
  document.getElementById('advSaveBtn').addEventListener('click', () => {
    applyWhisperAdvancedForm();
    saveWhisperAdvancedToLS();
    emit();
    close();
  });
  document.getElementById('advResetBtn').addEventListener('click', () => {
    state.whisperAdvanced = defaultWhisperAdvanced();
    fillWhisperAdvancedForm();
    saveWhisperAdvancedToLS();
    emit();
  });
}

/**
 * Populate the advanced-settings modal inputs from state.whisperAdvanced.
 * @returns {void}
 */
function fillWhisperAdvancedForm() {
  const a = state.whisperAdvanced;
  document.getElementById('advForceCpu').checked = a.device === 'cpu';
  document.getElementById('advComputeType').value = a.computeType || '';
  document.getElementById('advBeamSize').value = a.beamSize ?? '';
  document.getElementById('advInitialPrompt').value = a.initialPrompt || '';
  document.getElementById('advVadOnset').value = a.vadOnset ?? '';
  document.getElementById('advVadOffset').value = a.vadOffset ?? '';
  document.getElementById('advMinSpeakers').value = a.minSpeakers ?? '';
  document.getElementById('advMaxSpeakers').value = a.maxSpeakers ?? '';
  document.getElementById('advWordLevelSrt').checked = !!a.wordLevelSrtExport;
}

/**
 * Read the advanced-settings modal inputs back into state.whisperAdvanced.
 * @returns {void}
 */
function applyWhisperAdvancedForm() {
  const numOrNull = (id) => {
    const v = document.getElementById(id).value.trim();
    if (v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const a = state.whisperAdvanced;
  a.device = document.getElementById('advForceCpu').checked ? 'cpu' : '';
  a.computeType = document.getElementById('advComputeType').value || '';
  a.beamSize = numOrNull('advBeamSize');
  a.initialPrompt = document.getElementById('advInitialPrompt').value.trim();
  a.vadOnset = numOrNull('advVadOnset');
  a.vadOffset = numOrNull('advVadOffset');
  a.minSpeakers = numOrNull('advMinSpeakers');
  a.maxSpeakers = numOrNull('advMaxSpeakers');
  a.wordLevelSrtExport = document.getElementById('advWordLevelSrt').checked;
}

// Map the advanced settings to the engine invoke params (Tauri snake_cases the
// keys). Empty values become null so the engine omits the corresponding flag.
function whisperAdvancedArgs() {
  const a = state.whisperAdvanced;
  return {
    device: a.device || null,
    computeType: a.computeType || null,
    beamSize: a.beamSize ?? null,
    initialPrompt: a.initialPrompt || null,
    vadOnset: a.vadOnset ?? null,
    vadOffset: a.vadOffset ?? null,
    minSpeakers: a.minSpeakers ?? null,
    maxSpeakers: a.maxSpeakers ?? null,
  };
}

// ── S-05 transcript align + export ────────────────────────────────────

// Show "align to audio" only when a video and parsed sentences are both present.
export function syncAlignBtn() {
  const btn = document.getElementById('alignTranscriptBtn');
  if (!btn) return;
  const hasVideo = !!(state._whisperVideoPath || state.videoPath);
  const hasSentences = state.sentences && state.sentences.length > 0;
  const show = hasVideo && hasSentences;
  btn.style.display = show ? '' : 'none';
  const note = document.getElementById('alignTranscriptNote');
  if (note) note.style.display = show ? '' : 'none';
}

/**
 * Force-align the imported transcript to the audio to obtain word timestamps.
 * Shared by the manual "Dopasuj do audio" button and the word-SRT export
 * auto-align fallback. Shows the whisperProgressBox progress UI and merges the
 * resulting (frame-normalized) words onto state.sentences. Returns true on
 * success, false on missing prerequisites / cancel / failure (surfaced via
 * toast + progress label; never throws to the caller).
 * @param {{ confirm?: boolean }} [opts] When `confirm` is true (the word-SRT
 *   export auto-align fallback), shows an async ask() notice about the 37–67s
 *   cold-spawn cost before starting; declining returns false without spawning.
 *   The manual "Dopasuj do audio" button passes no opts (no extra prompt — the
 *   click is already explicit).
 * @returns {Promise<boolean>}
 */
export async function alignToWords(opts = {}) {
  const videoPath = state._whisperVideoPath || state.videoPath;
  if (!videoPath) {
    toast(
      'Najpierw wybierz plik wideo, aby dopasować transkrypcję do audio.',
      'info',
    );
    return false;
  }
  if (!state.srtContent) {
    toast('Brak transkrypcji do dopasowania.', 'info');
    return false;
  }
  // Export-driven fallback: warn about the cold-spawn wait before showing the
  // progress box. NEVER window.confirm — it hard-crashes the WKWebView (see
  // context/foundation/lessons.md); use the async plugin-dialog ask().
  if (opts.confirm) {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    const proceed = await ask(
      'Brak słów na poziomie ramek. Dopasowanie napisów do audio może potrwać 37–67 s przy pierwszym uruchomieniu. Kontynuować?',
      {
        title: 'Dopasuj do audio',
        kind: 'info',
        okLabel: 'Dopasuj',
        cancelLabel: 'Anuluj',
      },
    );
    if (!proceed) return false;
  }
  document.getElementById('whisperProgressBox').style.display = 'block';
  setWhisperProgress('Dopasowanie do audio…', 0);

  let unlisten;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    unlisten = await listen('transcribe-progress', (e) => {
      const { label, percent } = e.payload;
      setWhisperProgress(label, percent);
    });
    const { invoke } = await import('@tauri-apps/api/core');
    const result = await invoke('align_transcript', {
      videoPath,
      transcript: state.srtContent,
      language: state.whisperLanguage || 'pl',
      isVtt: !!state._srtIsVtt,
      // Only the device override is relevant to align-only (torch align stage);
      // compute_type/beam/VAD are transcription-only.
      device: state.whisperAdvanced.device || null,
    });
    // Merge resulting word timestamps onto the imported sentences.
    mergeWordsIntoSentences(state.sentences, result.words || [], state.fps);
    renderSegments();
    setWhisperProgress('Dopasowano słowa do audio!', 100);
    setTimeout(() => {
      document.getElementById('whisperProgressBox').style.display = 'none';
    }, 2000);
    emit();
    return true;
  } catch (e) {
    const msg = String(e);
    if (msg.includes('ANULOWANO')) {
      setWhisperProgress('Anulowano.', 0);
      // Mirror the success path: don't leave the progress box stuck on screen
      // after a cancel — hide it shortly after surfacing "Anulowano.".
      setTimeout(() => {
        document.getElementById('whisperProgressBox').style.display = 'none';
      }, 2000);
    } else {
      setWhisperProgress('Błąd: ' + e, 0);
      toast('Dopasowanie nieudane: ' + e, 'error');
    }
    return false;
  } finally {
    if (unlisten) unlisten();
  }
}

// Manual "Dopasuj do audio" button handler — thin wrapper over alignToWords().
async function alignImportedTranscript() {
  await alignToWords();
}

/**
 * Write a transcript to a user-chosen location via the native save dialog.
 * @param {'srt'|'vtt'} ext
 * @param {string} content
 */
function saveTranscriptToPath(ext, content) {
  const base = (state.srtName || 'transkrypcja').replace(/\.(srt|vtt)$/i, '');
  return saveTextToPath({ defaultName: `${base}.${ext}`, content });
}

// SRT export (sentence vs word-by-word) is handled by the shared
// ./export-srt.js → exportTranscriptSrt, wired to #exportSrtBtn in initTranscribe.

async function exportTranscriptVTT() {
  if (!state.sentences || !state.sentences.length) {
    toast('Brak transkrypcji do eksportu.', 'info');
    return;
  }
  await saveTranscriptToPath(
    'vtt',
    generateTranscriptVTT(state.sentences, state.fps),
  );
}

async function browseWhisperVideo() {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
      filters: [
        {
          name: 'Wideo',
          extensions: ['mp4', 'mov', 'mkv', 'avi', 'mxf', 'm4v', 'webm'],
        },
      ],
    });
    if (!path) return;
    state._whisperVideoPath = path;
    document.getElementById('whisperVideoPath').value = path;
    // Auto-populate the project settings from the file itself (#4/#5): fps +
    // resolution come from the FFmpeg probe, filename + path from the picker.
    // Tolerant — on probe failure the fields keep their editable defaults.
    await populateVideoMeta(path);
    document.getElementById('videoFilename').value = state.videoFilename || '';
    const fpsEl = document.getElementById('fpsSelect');
    if (fpsEl) fpsEl.value = String(state.fps);
    syncTranscribeBtn();
    syncAlignBtn();
    emit();
  } catch (e) {
    toast('Nie udało się wybrać pliku: ' + e, 'error');
  }
}

async function transcribeWithWhisper() {
  const videoPath = state._whisperVideoPath;
  const modelId = state.modelId;
  const language = state.whisperLanguage || 'pl';

  if (!videoPath || !modelId) return;

  document.getElementById('transcribeBtn').disabled = true;
  document.getElementById('cancelTranscribeBtn').style.display = '';
  document.getElementById('whisperProgressBox').style.display = 'block';
  setWhisperProgress('Inicjalizacja…', 0);

  let unlisten;
  try {
    const { listen } = await import('@tauri-apps/api/event');
    unlisten = await listen('transcribe-progress', (e) => {
      const { label, percent } = e.payload;
      setWhisperProgress(label, percent);
    });

    const { invoke } = await import('@tauri-apps/api/core');
    // Returns { srt_content, words: [{text,start,end}], segments: [...] }
    const result = await invoke('transcribe_video', {
      videoPath,
      modelId,
      language,
      diarize: state.diarize,
      hfToken: state.diarize ? getApiKey('huggingface') : '',
      ...whisperAdvancedArgs(),
    });

    const rawBase = videoPath
      .split('/')
      .pop()
      .split('\\')
      .pop()
      .replace(/\.[^.]+$/, '');
    // Tag the transcript with the model id so re-transcribing the same clip
    // with a different model yields a distinct name (e.g. `_small` vs
    // `_large-v3-turbo`) instead of silently overwriting the previous one.
    const modelTag = String(modelId).replace(/[^a-zA-Z0-9_\-]/g, '_');
    const srtName =
      rawBase.replace(/[^a-zA-Z0-9_\-]/g, '_') + '_' + modelTag + '.srt';
    // Keep the derived SRT for display/save, but the engine path builds
    // sentences directly from word timestamps (no intermediate re-parse).
    loadSRTContent(result.srt_content, srtName);

    if (result.segments && result.segments.length) {
      // Word-driven segmentation: gap-free sentences carrying words[].
      state.sentences = segmentFromWords(result.segments, state.fps, MIN_CHARS);
      state.sentences.forEach((s) => {
        s.source_idx = 0;
      });
      // Engine path owns segmentation; the legacy merge path is retired here
      // (still used by the imported-transcript align path in Phase 5).
      state._pendingWhisperWords = null;
      renderSegments();
      document.getElementById('statusSegs').textContent =
        state.sentences.length;
      document.getElementById('segmentsCard').style.display = 'block';
      emit();
    } else {
      // Fallback (legacy/no segments): store flat words for merge after parse.
      state._pendingWhisperWords = result.words || [];
    }
    setWhisperProgress('Gotowe! SRT wczytany.', 100);
    setTimeout(() => {
      document.getElementById('whisperProgressBox').style.display = 'none';
    }, 2000);
  } catch (e) {
    const msg = String(e);
    if (msg.includes('ANULOWANO')) {
      // User cancel — distinct from a real failure, no error dialog.
      setWhisperProgress('Anulowano transkrypcję.', 0);
    } else {
      setWhisperProgress('Błąd: ' + e, 0);
      toast('Transkrypcja nieudana: ' + e, 'error');
    }
  } finally {
    if (unlisten) unlisten();
    document.getElementById('cancelTranscribeBtn').style.display = 'none';
    syncTranscribeBtn();
  }
}

function setWhisperProgress(label, percent) {
  document.getElementById('whisperProgressLabel').textContent = label;
  document.getElementById('whisperProgressFill').style.width =
    Math.round(percent) + '%';
}
