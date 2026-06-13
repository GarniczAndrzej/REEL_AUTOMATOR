import { state, emit } from '../state.js';
import { parseSRT, parseVTT, framesToTC } from '../parser/srt.js';
import { segmentFromWords } from '../parser/word-segments.js';
import {
  generateTranscriptSRT,
  generateTranscriptVTT,
} from '../exporters/transcript.js';
import { getApiKey, setApiKey } from '../ai/api-key.js';

export function init() {
  const srtFileInput = document.getElementById('srtFile');
  const dropZone = document.getElementById('dropZone');

  srtFileInput.addEventListener('change', () => {
    const f = srtFileInput.files[0];
    if (
      f &&
      (f.name.toLowerCase().endsWith('.srt') ||
        f.name.toLowerCase().endsWith('.vtt'))
    )
      loadSRTFile(f);
  });
  document.getElementById('clearFileBtn').addEventListener('click', clearFile);
  document.getElementById('parseBtn').addEventListener('click', doParseBtn);
  document
    .getElementById('downloadMdBtn')
    .addEventListener('click', downloadMD);
  document
    .getElementById('downloadJsonBtn')
    .addEventListener('click', downloadJSON);
  // S-05 — transcript align + export
  document
    .getElementById('alignTranscriptBtn')
    .addEventListener('click', alignImportedTranscript);
  document
    .getElementById('exportSrtBtn')
    .addEventListener('click', exportTranscriptSRT);
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
  initModelManager();

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () =>
    dropZone.classList.remove('drag-over'),
  );
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.srt') || file.name.endsWith('.vtt')))
      loadSRTFile(file);
  });

  document.getElementById('fpsSelect').addEventListener('change', (e) => {
    state.fps = +e.target.value;
    if (state.sentences.length) {
      const noteEl = document.getElementById('fpsNote');
      if (noteEl) {
        noteEl.textContent =
          '⚠ FPS zmieniony — kliknij „Analizuj SRT →" aby odświeżyć timekody.';
        noteEl.style.color = 'var(--amber)';
      }
    }
    emit();
  });
  document.getElementById('videoFilename').addEventListener('input', (e) => {
    state.videoFilename = e.target.value;
    emit();
  });
  document.getElementById('gapFrames').addEventListener('input', (e) => {
    state.gapFrames = +e.target.value;
    emit();
  });
  document.getElementById('minChars').addEventListener('input', (e) => {
    state.minChars = +e.target.value;
    emit();
  });

  // Project save/load
  document
    .getElementById('openProjectBtn')
    .addEventListener('click', openProject);
  document
    .getElementById('saveProjectBtn')
    .addEventListener('click', saveProject);
  document
    .getElementById('saveProjectAsBtn')
    .addEventListener('click', saveProjectAs);

  // F18 — multi-source
  document.getElementById('addSourceBtn').addEventListener('click', addSource);
}

function loadSRTFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    state.srtContent = e.target.result;
    state.srtName = file.name;
    state._srtIsVtt = file.name.toLowerCase().endsWith('.vtt');
    const vf = file.name.replace(/\.(srt|vtt)$/i, '');
    state.videoFilename = vf;
    state.videoFilename2 = vf;
    document.getElementById('videoFilename').value = vf;
    document.getElementById('videoFilename2').value = vf;
    document.getElementById('dropZone').style.display = 'none';
    document.getElementById('fileLoaded').style.display = 'flex';
    document.getElementById('fileName').textContent = file.name;
    document.getElementById('fileMeta').textContent =
      (file.size / 1024).toFixed(1) + ' KB';
    document.getElementById('parseBtn').disabled = false;
    document.getElementById('statusSrt').textContent = file.name;
    // Reset FPS note in case it was showing a stale warning
    const noteEl = document.getElementById('fpsNote');
    if (noteEl) {
      noteEl.textContent = 'Musi zgadzać się z twoim materiałem wideo!';
      noteEl.style.color = '';
    }
    emit();
  };
  reader.readAsText(file, 'utf-8');
}

function clearFile() {
  state.srtContent = null;
  state.srtName = null;
  state.sentences = [];
  document.getElementById('dropZone').style.display = '';
  document.getElementById('fileLoaded').style.display = 'none';
  document.getElementById('parseBtn').disabled = true;
  document.getElementById('segmentsCard').style.display = 'none';
  document.getElementById('srtFile').value = '';
  document.getElementById('statusSrt').textContent = 'brak';
  const noteEl = document.getElementById('fpsNote');
  if (noteEl) {
    noteEl.textContent = 'Musi zgadzać się z twoim materiałem wideo!';
    noteEl.style.color = '';
  }
  emit();
}

function _parseSubtitle(content, isVtt, fps, minChars) {
  return isVtt
    ? parseVTT(content, fps, minChars)
    : parseSRT(content, fps, minChars);
}

function doParseBtn() {
  if (!state.srtContent && (!state.sources || !state.sources.length)) return;

  if (state.sources && state.sources.length > 0) {
    // F18 — multi-source: parse primary + additional sources, merge with source_idx
    state.sentences = [];
    const primarySentences = state.srtContent
      ? _parseSubtitle(
          state.srtContent,
          state._srtIsVtt,
          state.fps,
          state.minChars,
        )
      : [];
    primarySentences.forEach((s) => {
      s.source_idx = 0;
    });
    state.sentences.push(...primarySentences);

    let idOffset = primarySentences.length;
    for (let si = 0; si < state.sources.length; si++) {
      const src = state.sources[si];
      if (!src.srtContent) continue;
      const srcSentences = _parseSubtitle(
        src.srtContent,
        src._isVtt,
        state.fps,
        state.minChars,
      );
      for (const s of srcSentences) {
        s.id = idOffset + s.id;
        s.source_idx = si + 1;
        state.sentences.push(s);
      }
      idOffset += srcSentences.length;
    }
  } else {
    // Single source (existing behavior)
    if (!state.srtContent) return;
    state.sentences = _parseSubtitle(
      state.srtContent,
      state._srtIsVtt,
      state.fps,
      state.minChars,
    );
    state.sentences.forEach((s) => {
      s.source_idx = 0;
    });
  }

  // Merge Whisper word timestamps into sentences when available (F4)
  if (state._pendingWhisperWords && state._pendingWhisperWords.length) {
    mergeWordsIntoSentences(
      state.sentences,
      state._pendingWhisperWords,
      state.fps,
    );
    state._pendingWhisperWords = null;
  }
  renderSegments();
  document.getElementById('statusSegs').textContent = state.sentences.length;
  document.getElementById('segmentsCard').style.display = 'block';
  // Reset FPS note after successful parse
  const noteEl = document.getElementById('fpsNote');
  if (noteEl) {
    noteEl.textContent = 'Musi zgadzać się z twoim materiałem wideo!';
    noteEl.style.color = '';
  }
  emit();
}

// Assign each Whisper word to its sentence by time overlap (F4)
// Words are only produced for the primary source (source_idx 0)
function mergeWordsIntoSentences(sentences, words, fps) {
  for (const s of sentences) {
    if ((s.source_idx ?? 0) !== 0) {
      s.words = [];
      continue;
    }
    const startS = s.start_frame / fps;
    const endS = s.end_frame / fps;
    s.words = words.filter(
      (w) =>
        (w.start + w.end) / 2 >= startS - 0.15 &&
        (w.start + w.end) / 2 <= endS + 0.15,
    );
  }
}

function renderSegments() {
  const preview = document.getElementById('segmentsPreview');
  preview.innerHTML = state.sentences
    .map(
      (s) =>
        `<div class="segment-row">
      <div class="seg-id">#${s.id}</div>
      <div class="seg-tc">${escHtml(s.start_tc)}</div>
      <div class="seg-text">${escHtml(s.text)}</div>
    </div>`,
    )
    .join('');
  document.getElementById('segCount').textContent =
    state.sentences.length + ' segmentów';
  syncAlignBtn();
}

function downloadMD() {
  if (!state.sentences.length) return;
  let md = `# Segmenty SRT\n\nPlik: ${state.srtName || 'nieznany'}\nFPS: ${state.fps}\nSegmentów: ${state.sentences.length}\n\n---\n\n`;
  state.sentences.forEach((s) => {
    md += `**#${s.id}** \`${s.start_tc} → ${s.end_tc}\` (${(s.duration_frame / state.fps).toFixed(1)}s)\n\n${s.text}\n\n---\n\n`;
  });
  downloadBlob('segmenty.md', md, 'text/markdown');
}

function downloadJSON() {
  if (!state.sentences.length) return;
  downloadBlob(
    'segments.json',
    JSON.stringify(state.sentences, null, 2),
    'application/json',
  );
}

// ── Project save/load ─────────────────────────────────────────────

let currentProjectPath = null;

async function openProject() {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
      filters: [{ name: 'Reelproj', extensions: ['reelproj'] }],
    });
    if (!path) return;
    const { invoke } = await import('@tauri-apps/api/core');
    const data = await invoke('load_project', { path });
    applyProjectData(data);
    currentProjectPath = path;
    addRecentProject(path);
  } catch (e) {
    alert('Nie udało się otworzyć projektu: ' + e);
  }
}

async function saveProject() {
  if (currentProjectPath) {
    await writeProject(currentProjectPath);
  } else {
    await saveProjectAs();
  }
}

async function saveProjectAs() {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const path = await save({
      filters: [{ name: 'Reelproj', extensions: ['reelproj'] }],
    });
    if (!path) return;
    await writeProject(path);
    currentProjectPath = path;
    addRecentProject(path);
  } catch (e) {
    alert('Nie udało się zapisać projektu: ' + e);
  }
}

async function writeProject(path) {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const payload = {
      // v4 adds per-sentence words[] (engine forced-alignment). v3 loads
      // tolerantly (no words → word-trim simply unavailable until re-aligned).
      version: 4,
      srtName: state.srtName,
      srtContent: state.srtContent,
      fps: state.fps,
      videoFilename: state.videoFilename,
      videoFilename2: state.videoFilename2,
      videoPath: state.videoPath,
      videoResolution: state.videoResolution,
      projectName: state.projectName,
      gapFrames: state.gapFrames,
      minChars: state.minChars,
      mergeThreshold: state.mergeThreshold,
      userPrompt: state.userPrompt,
      whisperLanguage: state.whisperLanguage,
      modelId: state.modelId,
      diarize: state.diarize,
      sentences: state.sentences,
      reelsData: state.reelsData,
      sources: state.sources || [],
    };
    await invoke('save_project', { path, payload });
  } catch (e) {
    alert('Nie udało się zapisać: ' + e);
  }
}

function applyProjectData(data) {
  if (data.srtName) state.srtName = data.srtName;
  if (data.srtContent) state.srtContent = data.srtContent;
  if (data.fps) state.fps = data.fps;
  if (data.videoFilename) state.videoFilename = data.videoFilename;
  if (data.videoFilename2) state.videoFilename2 = data.videoFilename2;
  if (data.videoPath) state.videoPath = data.videoPath;
  if (data.videoResolution) state.videoResolution = data.videoResolution;
  if (data.projectName) state.projectName = data.projectName;
  if (data.gapFrames != null) state.gapFrames = data.gapFrames;
  if (data.minChars != null) state.minChars = data.minChars;
  if (data.mergeThreshold != null) state.mergeThreshold = data.mergeThreshold;
  if (data.userPrompt) state.userPrompt = data.userPrompt;
  if (data.whisperLanguage) state.whisperLanguage = data.whisperLanguage;
  // Migration: prefer managed modelId; ignore stale raw whisperModelPath.
  if (data.modelId) state.modelId = data.modelId;
  if (data.diarize != null) state.diarize = data.diarize;
  if (data.sentences) state.sentences = data.sentences;
  if (data.reelsData) state.reelsData = data.reelsData;
  if (data.sources) state.sources = data.sources;

  // Sync DOM — Step 1 fields
  document.getElementById('fpsSelect').value = state.fps;
  document.getElementById('videoFilename').value = state.videoFilename || '';
  document.getElementById('gapFrames').value = state.gapFrames;
  document.getElementById('minChars').value = state.minChars;
  document.getElementById('userPrompt').value = state.userPrompt || '';
  const wlEl = document.getElementById('whisperLanguage');
  if (wlEl) wlEl.value = state.whisperLanguage || 'pl';
  const dtEl = document.getElementById('diarizeToggle');
  if (dtEl) {
    dtEl.checked = !!state.diarize;
    const row = document.getElementById('diarizeTokenRow');
    if (row) row.style.display = state.diarize ? '' : 'none';
  }
  renderModelManager();

  if (state.srtName) {
    document.getElementById('dropZone').style.display = 'none';
    document.getElementById('fileLoaded').style.display = 'flex';
    document.getElementById('fileName').textContent = state.srtName;
    document.getElementById('fileMeta').textContent = state.srtContent
      ? (state.srtContent.length / 1024).toFixed(1) + ' KB'
      : '';
    document.getElementById('parseBtn').disabled = false;
    document.getElementById('statusSrt').textContent = state.srtName;
  }
  if (state.sentences.length) {
    document.getElementById('segmentsCard').style.display = 'block';
    document.getElementById('segCount').textContent =
      state.sentences.length + ' segmentów';
    const preview = document.getElementById('segmentsPreview');
    preview.innerHTML = state.sentences
      .map(
        (s) =>
          `<div class="segment-row">
        <div class="seg-id">#${s.id}</div>
        <div class="seg-tc">${escHtml(s.start_tc)}</div>
        <div class="seg-text">${escHtml(s.text)}</div>
      </div>`,
      )
      .join('');
  }

  // F18 — restore additional sources UI
  if (state.sources && state.sources.length) {
    document.getElementById('additionalSourcesCard').style.display = '';
    renderAdditionalSources();
  }

  emit();
}

function addRecentProject(path) {
  try {
    const key = 'edl_recent_projects';
    const list = JSON.parse(localStorage.getItem(key) || '[]');
    const filtered = list.filter((p) => p !== path);
    filtered.unshift(path);
    localStorage.setItem(key, JSON.stringify(filtered.slice(0, 10)));
  } catch (e) {}
}

function downloadBlob(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
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
  // Render the model list immediately. The engine readiness probe spawns a cold
  // sidecar self-test (heavy: imports torch, loads the bundled align model, runs
  // a real forced-align) and can take tens of seconds — do NOT gate the model UI
  // on it. Kick it off without awaiting; it updates its own badge when it lands.
  await refreshModelStatus();
  await renderModelManager();
  refreshEngineReadiness();
}

async function refreshEngineReadiness() {
  const el = document.getElementById('engineReadyIndicator');
  if (!el) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const s = await invoke('whisperx_engine_check');
    if (s.ok) {
      el.textContent = `✓ Silnik gotowy (${s.device || 'cpu'}${s.gpu ? ', GPU' : ''})${s.alignment_model_ready ? ', model dopasowania wbudowany' : ''}`;
      el.style.color = 'var(--green)';
    } else {
      el.textContent =
        '⚠ Silnik WhisperX nie jest jeszcze zbudowany. Uruchom sidecar/build.sh.';
      el.style.color = 'var(--amber)';
    }
  } catch (e) {
    el.textContent = '⚠ Nie można sprawdzić silnika: ' + e;
    el.style.color = 'var(--amber)';
  }
}

async function refreshModelStatus() {
  try {
    const { MODEL_REGISTRY } =
      await import('../transcription/model-registry.js');
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

async function renderModelManager() {
  const container = document.getElementById('modelManagerList');
  if (!container) return;
  const { MODEL_REGISTRY, formatBytes } =
    await import('../transcription/model-registry.js');
  container.innerHTML = MODEL_REGISTRY.map((m) => {
    const st = _modelStatus[m.id] || {};
    const selected = state.modelId === m.id;
    const status = st.downloaded
      ? '<span style="color:var(--green);">✓ Pobrany</span>'
      : '<span style="color:var(--text3);">Brak</span>';
    const action = st.downloaded
      ? `<button class="btn ${selected ? 'btn-primary' : 'btn-secondary'}" style="padding:4px 10px;font-size:11px;" data-select-model="${m.id}">${selected ? '● Wybrany' : 'Wybierz'}</button>`
      : `<button class="btn btn-secondary" style="padding:4px 10px;font-size:11px;" data-download-model="${m.id}" ${_downloadingId ? 'disabled' : ''}>⬇ Pobierz</button>`;
    return `
<div class="card" style="padding:10px;display:flex;justify-content:space-between;align-items:center;gap:10px;${selected ? 'border-color:var(--accent);' : ''}" data-model-row="${m.id}">
  <div>
    <div style="font-size:13px;font-weight:600;">${escHtml(m.label)}</div>
    <div style="font-size:11px;color:var(--text3);">${escHtml(formatBytes(m.sizeBytes))} · ${status}</div>
    <div class="model-dl-progress" data-progress-for="${m.id}" style="display:none;font-size:11px;color:var(--text2);margin-top:4px;"></div>
  </div>
  <div>${action}</div>
</div>`;
  }).join('');

  container.querySelectorAll('[data-select-model]').forEach((btn) => {
    btn.addEventListener('click', () => selectModel(btn.dataset.selectModel));
  });
  container.querySelectorAll('[data-download-model]').forEach((btn) => {
    btn.addEventListener('click', () =>
      downloadModel(btn.dataset.downloadModel),
    );
  });
}

function selectModel(id) {
  state.modelId = id;
  emit();
  renderModelManager();
  syncTranscribeBtn();
}

async function downloadModel(id) {
  const { getModel } = await import('../transcription/model-registry.js');
  const model = getModel(id);
  if (!model) return;
  if (!model.repo || !model.files?.length) {
    alert(
      'Ten model nie ma jeszcze skonfigurowanego repozytorium/plików do pobrania (uzupełnij rejestr).',
    );
    return;
  }
  _downloadingId = id;
  // Must await: renderModelManager() is async (awaits a dynamic import before
  // rewriting container.innerHTML). Without await, the querySelector below grabs
  // the pre-render node, which the pending innerHTML rewrite then detaches — so
  // every progress update writes to an orphaned element and the UI shows nothing.
  await renderModelManager();
  const progEl = document.querySelector(`[data-progress-for="${id}"]`);
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
    alert('Pobieranie modelu nieudane: ' + e);
  } finally {
    if (unlisten) unlisten();
    _downloadingId = null;
    renderModelManager();
  }
}

async function cancelTranscribe() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('cancel_transcription');
    setWhisperProgress('Anulowano.', 0);
  } catch (e) {
    // ignore
  }
}

// ── S-05 transcript align + export ────────────────────────────────────

// Show "align to audio" only when a video and parsed sentences are both present.
function syncAlignBtn() {
  const btn = document.getElementById('alignTranscriptBtn');
  if (!btn) return;
  const hasVideo = !!(state._whisperVideoPath || state.videoPath);
  const hasSentences = state.sentences && state.sentences.length > 0;
  btn.style.display = hasVideo && hasSentences ? '' : 'none';
}

// Force-align an imported transcript to the audio to obtain word timestamps.
async function alignImportedTranscript() {
  const videoPath = state._whisperVideoPath || state.videoPath;
  if (!videoPath) {
    alert('Najpierw wybierz plik wideo, aby dopasować transkrypcję do audio.');
    return;
  }
  if (!state.srtContent) {
    alert('Brak transkrypcji do dopasowania.');
    return;
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
    });
    // Merge resulting word timestamps onto the imported sentences.
    mergeWordsIntoSentences(state.sentences, result.words || [], state.fps);
    renderSegments();
    setWhisperProgress('Dopasowano słowa do audio!', 100);
    setTimeout(() => {
      document.getElementById('whisperProgressBox').style.display = 'none';
    }, 2000);
    emit();
  } catch (e) {
    const msg = String(e);
    if (msg.includes('ANULOWANO')) {
      setWhisperProgress('Anulowano.', 0);
    } else {
      setWhisperProgress('Błąd: ' + e, 0);
      alert('Dopasowanie nieudane: ' + e);
    }
  } finally {
    if (unlisten) unlisten();
  }
}

function exportTranscriptSRT() {
  if (!state.sentences || !state.sentences.length) {
    alert('Brak transkrypcji do eksportu.');
    return;
  }
  const srt = generateTranscriptSRT(state.sentences, state.fps);
  const base = (state.srtName || 'transkrypcja').replace(/\.(srt|vtt)$/i, '');
  downloadBlob(base + '.srt', srt, 'application/x-subrip');
}

function exportTranscriptVTT() {
  if (!state.sentences || !state.sentences.length) {
    alert('Brak transkrypcji do eksportu.');
    return;
  }
  const vtt = generateTranscriptVTT(state.sentences, state.fps);
  const base = (state.srtName || 'transkrypcja').replace(/\.(srt|vtt)$/i, '');
  downloadBlob(base + '.vtt', vtt, 'text/vtt');
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
    const name = path.split('/').pop().split('\\').pop();
    document.getElementById('whisperVideoPath').value = path;
    // Pre-fill video fields
    state.videoFilename = name;
    state.videoFilename2 = name;
    state.videoPath = path;
    document.getElementById('videoFilename').value = name;
    const vf2 = document.getElementById('videoFilename2');
    if (vf2) vf2.value = name;
    syncTranscribeBtn();
    syncAlignBtn();
  } catch (e) {
    alert('Nie udało się wybrać pliku: ' + e);
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
    });

    const rawBase = videoPath
      .split('/')
      .pop()
      .split('\\')
      .pop()
      .replace(/\.[^.]+$/, '');
    const srtName = rawBase.replace(/[^a-zA-Z0-9_\-]/g, '_') + '_whisper.srt';
    // Keep the derived SRT for display/save, but the engine path builds
    // sentences directly from word timestamps (no intermediate re-parse).
    loadSRTContent(result.srt_content, srtName);

    if (result.segments && result.segments.length) {
      // Word-driven segmentation: gap-free sentences carrying words[].
      state.sentences = segmentFromWords(
        result.segments,
        state.fps,
        state.minChars,
      );
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
      alert('Transkrypcja nieudana: ' + e);
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

// ── F18 — Multi-source ────────────────────────────────────────────────

function addSource() {
  if (!state.sources) state.sources = [];
  state.sources.push({
    videoFilename: '',
    videoPath: '',
    srtName: null,
    srtContent: null,
  });
  renderAdditionalSources();
  document.getElementById('additionalSourcesCard').style.display = '';
}

function removeSource(idx) {
  if (!state.sources) return;
  state.sources.splice(idx, 1);
  renderAdditionalSources();
  if (!state.sources.length) {
    document.getElementById('additionalSourcesCard').style.display = 'none';
  }
}

function renderAdditionalSources() {
  const container = document.getElementById('additionalSourcesList');
  if (!container) return;
  container.innerHTML = (state.sources || [])
    .map(
      (src, idx) => `
<div class="card" style="margin-top:10px;padding:14px;" data-src-idx="${idx}">
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
    <span style="font-size:13px;font-weight:600;color:var(--text2);">Źródło ${idx + 2}</span>
    <button class="btn btn-secondary" style="padding:3px 10px;font-size:11px;" data-remove-src="${idx}">✕ Usuń</button>
  </div>
  <div class="settings-grid">
    <div class="setting-item">
      <label>Plik napisów źródła ${idx + 2}</label>
      <div style="display:flex;gap:8px;align-items:center;">
        <span style="font-size:12px;color:${src.srtName ? 'var(--green)' : 'var(--text3)'};flex:1;">${src.srtName ? '✓ ' + escHtml(src.srtName) : 'Brak'}</span>
        <button class="btn btn-secondary" style="padding:5px 10px;font-size:11px;" data-browse-srt="${idx}">Wybierz SRT / VTT</button>
      </div>
    </div>
    <div class="setting-item">
      <label>Plik wideo źródła ${idx + 2}</label>
      <div style="display:flex;gap:8px;">
        <input type="text" value="${escHtml(src.videoPath || '')}" placeholder="/Users/…/video2.mp4" style="flex:1;font-size:12px;" data-src-video-path="${idx}" readonly>
        <button class="btn btn-secondary" style="padding:5px 10px;font-size:11px;" data-browse-video-src="${idx}">Przeglądaj</button>
      </div>
    </div>
  </div>
</div>`,
    )
    .join('');

  // Event delegation for remove / browse buttons
  container.querySelectorAll('[data-remove-src]').forEach((btn) => {
    btn.addEventListener('click', () => removeSource(+btn.dataset.removeSrc));
  });
  container.querySelectorAll('[data-browse-srt]').forEach((btn) => {
    btn.addEventListener('click', () =>
      browseSourceSRT(+btn.dataset.browseSrt),
    );
  });
  container.querySelectorAll('[data-browse-video-src]').forEach((btn) => {
    btn.addEventListener('click', () =>
      browseSourceVideo(+btn.dataset.browseVideoSrc),
    );
  });
}

async function browseSourceSRT(idx) {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
      filters: [{ name: 'Napisy', extensions: ['srt', 'vtt'] }],
    });
    if (!path) return;
    const { readTextFile } = await import('@tauri-apps/plugin-fs');
    const content = await readTextFile(path);
    if (!state.sources[idx]) return;
    state.sources[idx].srtContent = content;
    state.sources[idx].srtName = path.split('/').pop().split('\\').pop();
    state.sources[idx]._isVtt = path.toLowerCase().endsWith('.vtt');
    renderAdditionalSources();
    emit();
  } catch (e) {
    alert('Nie udało się wczytać pliku napisów: ' + e);
  }
}

async function browseSourceVideo(idx) {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const path = await open({
      filters: [
        {
          name: 'Wideo',
          extensions: ['mp4', 'mov', 'mkv', 'avi', 'mxf', 'r3d'],
        },
      ],
    });
    if (!path) return;
    if (!state.sources[idx]) return;
    state.sources[idx].videoPath = path;
    state.sources[idx].videoFilename = path.split('/').pop().split('\\').pop();
    renderAdditionalSources();
    emit();
  } catch (e) {
    alert('Nie udało się wybrać pliku: ' + e);
  }
}

function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function loadSRTContent(content, name) {
  state.srtContent = content;
  state.srtName = name;
  document.getElementById('dropZone').style.display = 'none';
  document.getElementById('fileLoaded').style.display = 'flex';
  document.getElementById('fileName').textContent = name;
  document.getElementById('fileMeta').textContent =
    (content.length / 1024).toFixed(1) + ' KB';
  document.getElementById('parseBtn').disabled = false;
  document.getElementById('statusSrt').textContent = name;
  emit();
}
