import { state, emit } from '../state.js';
import { generateEDL } from '../exporters/edl.js';
import { generateXML } from '../exporters/xml.js';
import { generateLua } from '../exporters/lua.js';
import { mergeAdjacentClips } from '../parser/segments.js';
import { renderMetadataList } from './step2-analyze.js';

export function init() {
  // Tab switching
  document
    .getElementById('tabBtnEdl')
    .addEventListener('click', () => switchTab('Edl'));
  document
    .getElementById('tabBtnXml')
    .addEventListener('click', () => switchTab('Xml'));
  document
    .getElementById('tabBtnLua')
    .addEventListener('click', () => switchTab('Lua'));
  document
    .getElementById('tabBtnMeta')
    .addEventListener('click', () => switchTab('Meta'));

  // Video filename inputs
  document.getElementById('videoFilename2').addEventListener('input', (e) => {
    state.videoFilename2 = e.target.value;
    emit();
  });
  document.getElementById('videoFullPath').addEventListener('input', (e) => {
    state.videoPath = e.target.value;
    emit();
  });
  document
    .getElementById('resolutionSelect')
    .addEventListener('change', (e) => {
      state.videoResolution = e.target.value;
      emit();
    });
  document.getElementById('projectName').addEventListener('input', (e) => {
    state.projectName = e.target.value;
    emit();
  });
  document.getElementById('mergeThreshold').addEventListener('input', (e) => {
    state.mergeThreshold = +e.target.value;
    emit();
  });

  // Browse video
  document
    .getElementById('browseVideoBtn')
    .addEventListener('click', browseVideo);

  // EDL
  document
    .getElementById('generateEdlBtn')
    .addEventListener('click', doGenerateEDL);
  document.getElementById('downloadEdlBtn').addEventListener('click', () => {
    if (state.edlContent)
      downloadFile(
        videoBase() + '_timeline.edl',
        state.edlContent,
        'text/plain',
      );
  });
  document
    .getElementById('copyEdlBtn')
    .addEventListener('click', () => copyEl('edlOutput'));

  // XML
  document
    .getElementById('generateXmlBtn')
    .addEventListener('click', doGenerateXML);
  document.getElementById('downloadXmlBtn').addEventListener('click', () => {
    if (state.xmlContent)
      downloadFile(
        videoBase() + '_timeline.xml',
        state.xmlContent,
        'application/xml',
      );
  });
  document
    .getElementById('copyXmlBtn')
    .addEventListener('click', () => copyEl('xmlOutput'));

  // Lua
  document
    .getElementById('generateLuaBtn')
    .addEventListener('click', doGenerateLua);
  document.getElementById('downloadLuaBtn').addEventListener('click', () => {
    if (state.luaContent)
      downloadFile(
        videoBase() + '_davinci.lua',
        state.luaContent,
        'text/plain',
      );
  });
  document
    .getElementById('copyLuaBtn')
    .addEventListener('click', () => copyEl('luaOutput'));

  // F6 metadata tab
  initMetadataTab();
}

export function updateSummary() {
  const totalClips = state.reelsData.reduce((a, r) => a + r.clip_ids.length, 0);
  document.getElementById('sumSegs').textContent =
    state.sentences.length + ' segmentów';
  document.getElementById('sumReels').textContent =
    state.reelsData.length + ' reelsów';
  document.getElementById('sumClips').textContent = totalClips + ' klipów';
  document.getElementById('videoFilename2').value = state.videoFilename2 || '';
  document.getElementById('videoFullPath').value = state.videoPath || '';
  document.getElementById('mergeThreshold').value = state.mergeThreshold;
  document.getElementById('projectName').value = state.projectName;

  // F6 — metadata tab
  if (state.reelsMetadata.length) renderMetadataList();
  syncMetadataExportBtn();
}

// ── helpers ────────────────────────────────────────────────────────

function switchTab(name) {
  document
    .querySelectorAll('.export-tab')
    .forEach((b) => b.classList.remove('active'));
  document
    .querySelectorAll('.export-panel')
    .forEach((p) => p.classList.remove('active'));
  document.getElementById('tabBtn' + name).classList.add('active');
  document.getElementById('tab' + name).classList.add('active');
}

// ── exporters ──────────────────────────────────────────────────────

function doGenerateEDL() {
  if (!state.reelsData.length) {
    alert('Brak danych reelsów! Wróć do kroku 2.');
    return;
  }
  const videoFile = state.videoFilename2 || 'source_video.mp4';
  state.edlContent = generateEDL({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    gapFrames: state.gapFrames,
    videoFilename: videoFile,
    mergeThreshold: state.mergeThreshold,
  });
  document.getElementById('edlOutput').textContent = state.edlContent;
  document.getElementById('edlCard').style.display = 'block';
  document.getElementById('statusEdl').textContent = 'gotowy';
  updateSummary();
  emit();
}

function doGenerateXML() {
  if (!state.reelsData.length) {
    alert('Brak danych reelsów!');
    return;
  }
  const videoFile = state.videoFilename2 || 'source_video.mp4';
  const videoPath = state.videoPath || videoFile;
  state.xmlContent = generateXML({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    videoFilename: videoFile,
    videoPath,
    videoResolution: state.videoResolution,
    projectName: state.projectName,
    mergeThreshold: state.mergeThreshold,
  });
  const preview =
    state.xmlContent.substring(0, 3000) +
    (state.xmlContent.length > 3000 ? '\n… (skrócono podgląd)' : '');
  document.getElementById('xmlOutput').textContent = preview;
  document.getElementById('xmlCard').style.display = 'block';
  document.getElementById('xmlSeqCount').textContent =
    state.reelsData.length + ' sekwencji';
  updateSummary();
  emit();
}

function doGenerateLua() {
  if (!state.reelsData.length) {
    alert('Brak danych reelsów!');
    return;
  }
  const videoPath = state.videoPath;
  if (!videoPath) {
    alert('Wpisz pełną ścieżkę do pliku wideo (pole "Pełna ścieżka" powyżej)!');
    return;
  }
  state.luaContent = generateLua({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    gapFrames: state.gapFrames,
    videoPath,
    projectName: state.projectName,
    mergeThreshold: state.mergeThreshold,
  });
  document.getElementById('luaOutput').textContent = state.luaContent;
  document.getElementById('luaCard').style.display = 'block';
  const totalClips = state.reelsData.reduce((a, r) => a + r.clip_ids.length, 0);
  document.getElementById('luaInfo').textContent =
    '1 timeline · ' +
    totalClips +
    ' klipów · ' +
    state.reelsData.length +
    ' reelsów';
  updateSummary();
  emit();
}

// ── file pickers ────────────────────────────────────────────────────

async function browseVideo() {
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
    state.videoPath = path;
    const name = path.split('/').pop().split('\\').pop();
    state.videoFilename2 = name;
    document.getElementById('videoFilename2').value = name;
    document.getElementById('videoFilename').value = name;
    document.getElementById('videoFullPath').value = path;
    emit();
  } catch (e) {
    alert('Nie udało się wybrać pliku: ' + e);
  }
}

// ── F6 Metadata export ───────────────────────────────────────────────

function syncMetadataExportBtn() {
  const btn = document.getElementById('downloadMetadataBtn');
  if (btn) btn.disabled = !state.reelsMetadata.length;
}

export function initMetadataTab() {
  const dlBtn = document.getElementById('downloadMetadataBtn');
  if (dlBtn) dlBtn.addEventListener('click', downloadMetadataJSON);
}

function downloadMetadataJSON() {
  if (!state.reelsMetadata.length) {
    alert('Brak metadanych — wygeneruj w Kroku 2!');
    return;
  }
  const filename = videoBase() + '_metadata.json';
  downloadFile(
    filename,
    JSON.stringify(state.reelsMetadata, null, 2),
    'application/json',
  );
}

// ── utilities ──────────────────────────────────────────────────────

function videoBase() {
  const name = state.videoFilename2 || 'reels';
  const lastDot = name.lastIndexOf('.');
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  return base || 'reels';
}

function downloadFile(name, content, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function copyEl(elId) {
  const el = document.getElementById(elId);
  navigator.clipboard
    .writeText(el.textContent)
    .then(() => {
      const btn = document.activeElement;
      const orig = btn.textContent;
      btn.textContent = '✓ Skopiowano!';
      setTimeout(() => (btn.textContent = orig), 1800);
    })
    .catch(() => alert('Nie udało się skopiować — zaznacz i skopiuj ręcznie.'));
}
