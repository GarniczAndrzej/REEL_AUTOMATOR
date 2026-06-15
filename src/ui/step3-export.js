import { state, emit } from '../state.js';
import { generateEDL } from '../exporters/edl.js';
import { generateXML } from '../exporters/xml.js';
import { generateLua } from '../exporters/lua.js';
import { mergeAdjacentClips } from '../parser/segments.js';
import { saveTextToPath } from '../util/save-file.js';
import { toast } from './toast.js';

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

  // Video filename inputs
  document
    .getElementById('videoFilenameExport')
    .addEventListener('input', (e) => {
      state.videoFilename = e.target.value;
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
  // Merge-gap now lives in the settings modal (S-16 Phase 2).

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
}

export function updateSummary() {
  const totalClips = state.reelsData.reduce((a, r) => a + r.clip_ids.length, 0);
  document.getElementById('sumSegs').textContent =
    state.sentences.length + ' segmentów';
  document.getElementById('sumReels').textContent =
    state.reelsData.length + ' reelsów';
  document.getElementById('sumClips').textContent = totalClips + ' klipów';
  document.getElementById('videoFilenameExport').value =
    state.videoFilename || '';
  document.getElementById('videoFullPath').value = state.videoPath || '';
  document.getElementById('projectName').value = state.projectName;
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
    toast('Brak danych reelsów! Wróć do kroku 2.', 'info');
    return;
  }
  const videoFile = state.videoFilename || 'source_video.mp4';
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
    toast('Brak danych reelsów!', 'info');
    return;
  }
  const videoFile = state.videoFilename || 'source_video.mp4';
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
    toast('Brak danych reelsów!', 'info');
    return;
  }
  const videoPath = state.videoPath;
  if (!videoPath) {
    toast(
      'Wpisz pełną ścieżkę do pliku wideo (pole "Pełna ścieżka" powyżej)!',
      'info',
    );
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
    state.videoFilename = name;
    document.getElementById('videoFilenameExport').value = name;
    document.getElementById('videoFilename').value = name;
    document.getElementById('videoFullPath').value = path;
    emit();
  } catch (e) {
    toast('Nie udało się wybrać pliku: ' + e, 'error');
  }
}

// ── utilities ──────────────────────────────────────────────────────

function videoBase() {
  const name = state.videoFilename || 'reels';
  const lastDot = name.lastIndexOf('.');
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  return base || 'reels';
}

async function downloadFile(name, content) {
  // Always prompt for a location — never silently save to ~/Downloads.
  const saved = await saveTextToPath({ defaultName: name, content });
  if (saved) toast('Zapisano plik ✓', 'success');
  return saved;
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
    .catch(() =>
      toast('Nie udało się skopiować — zaznacz i skopiuj ręcznie.', 'error'),
    );
}
