// Import-section submodule: F18 multi-source repeater — add/remove additional
// video+subtitle sources and browse their files. (S-16 Phase 3a — structural
// split, no behavior change.)

import { state, emit } from '../../state.js';
import { escHtml } from './segments.js';

export function initMultiSource() {
  document.getElementById('addSourceBtn').addEventListener('click', addSource);
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

export function renderAdditionalSources() {
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
