// Quick-export popover (S-16 Phase 3b, was step3-export.js). The export step is
// now a compact popover: EDL / XML / Lua up front, transcript (.srt/.vtt),
// segment .md and prompt-copy behind a "more" expander. The source-file card in
// the export section is read-only — its fps/filename/resolution are
// auto-detected at import (`probe_video_metadata`), so XML keeps real
// dimensions without manual entry. All generator fns are reused unchanged.

import { state, emit } from '../state.js';
import { generateEDL } from '../exporters/edl.js';
import { generateXML } from '../exporters/xml.js';
import { generateLua } from '../exporters/lua.js';
import { generateFCPXML } from '../exporters/fcpxml.js';
import {
  generateTranscriptVTT,
  generateSegmentsMd,
} from '../exporters/transcript.js';
import { buildPrompt } from '../ai/prompt.js';
import { saveTextToPath } from '../util/save-file.js';
import { toast } from './toast.js';
import { exportTranscriptSrt, transcriptBase } from './export-srt.js';

export function init() {
  // Export trigger now lives in the header (next to Settings) and the sidebar
  // step cue — openable at any stage, not just a final page section. Each
  // format guards its own prerequisites, so an early open is harmless.
  document
    .getElementById('openExportBtn')
    ?.addEventListener('click', openPopover);
  document.getElementById('nav3')?.addEventListener('click', openPopover);
  document
    .getElementById('exportClose')
    ?.addEventListener('click', closePopover);
  const modal = document.getElementById('exportModal');
  modal?.addEventListener('click', (e) => {
    if (e.target === modal) closePopover();
  });

  // Primary formats — generate + save, or copy.
  document
    .getElementById('exEdlGen')
    ?.addEventListener('click', () => saveFormat('edl'));
  document
    .getElementById('exEdlCopy')
    ?.addEventListener('click', () => copyFormat('edl'));
  document
    .getElementById('exXmlGen')
    ?.addEventListener('click', () => saveFormat('xml'));
  document
    .getElementById('exXmlCopy')
    ?.addEventListener('click', () => copyFormat('xml'));
  document
    .getElementById('exLuaGen')
    ?.addEventListener('click', () => saveFormat('lua'));
  document
    .getElementById('exLuaCopy')
    ?.addEventListener('click', () => copyFormat('lua'));
  document
    .getElementById('exFcpxmlGen')
    ?.addEventListener('click', () => saveFormat('fcpxml'));
  document
    .getElementById('exFcpxmlCopy')
    ?.addEventListener('click', () => copyFormat('fcpxml'));

  // "More" — transcript + segments + prompt.
  document
    .getElementById('exSrtBtn')
    ?.addEventListener('click', exportTranscriptSrt);
  document.getElementById('exVttBtn')?.addEventListener('click', exportVTT);
  document.getElementById('exMdBtn')?.addEventListener('click', exportMD);
  document.getElementById('exPromptBtn')?.addEventListener('click', copyPrompt);
}

// ── Popover open/close ─────────────────────────────────────────────

export function openPopover() {
  // Open at any stage — transcript/.md/prompt export is useful before reels
  // exist; the EDL/XML/Lua buttons each guard on `reelsData` themselves.
  updateSummary();
  const modal = document.getElementById('exportModal');
  if (modal) modal.style.display = 'flex';
}

function closePopover() {
  const modal = document.getElementById('exportModal');
  if (modal) modal.style.display = 'none';
}

// Refreshes the export summary badges. Folded into the popover open. Source-file
// fields (fps/filename/path/resolution) now live in the Settings modal.
export function updateSummary() {
  const totalClips = state.reelsData.reduce((a, r) => a + r.clip_ids.length, 0);
  setText('sumSegs', state.sentences.length + ' segmentów');
  setText('sumReels', state.reelsData.length + ' reelsów');
  setText('sumClips', totalClips + ' klipów');
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ── Generators (reuse exporter fns unchanged) ──────────────────────

function genEDL() {
  return generateEDL({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    gapFrames: state.gapFrames,
    videoFilename: state.videoFilename || 'source_video.mp4',
    mergeThreshold: state.mergeThreshold,
  });
}

function genXML() {
  const videoFile = state.videoFilename || 'source_video.mp4';
  return generateXML({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    videoFilename: videoFile,
    videoPath: state.videoPath || videoFile,
    videoResolution: state.videoResolution,
    projectName: state.projectName,
    mergeThreshold: state.mergeThreshold,
  });
}

function genLua() {
  if (!state.videoPath) {
    toast(
      'Brak ścieżki wideo — wybierz plik wideo (sekcja Import lub „Przeglądaj").',
      'info',
    );
    return null;
  }
  return generateLua({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    gapFrames: state.gapFrames,
    videoPath: state.videoPath,
    projectName: state.projectName,
    mergeThreshold: state.mergeThreshold,
  });
}

function genFCPXML() {
  if (!state.videoPath) {
    toast(
      'Brak ścieżki wideo — wybierz plik wideo (sekcja Import lub „Przeglądaj").',
      'info',
    );
    return null;
  }
  const videoFile = state.videoFilename || 'source_video.mp4';
  return generateFCPXML({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    videoFilename: videoFile,
    videoPath: state.videoPath,
    videoResolution: state.videoResolution,
    projectName: state.projectName,
    mergeThreshold: state.mergeThreshold,
  });
}

const FORMATS = {
  edl: {
    gen: genEDL,
    ext: 'edl',
    suffix: '_timeline.edl',
    store: 'edlContent',
  },
  xml: {
    gen: genXML,
    ext: 'xml',
    suffix: '_timeline.xml',
    store: 'xmlContent',
  },
  lua: { gen: genLua, ext: 'lua', suffix: '_davinci.lua', store: 'luaContent' },
  fcpxml: {
    gen: genFCPXML,
    ext: 'fcpxml',
    suffix: '_timeline.fcpxml',
    store: 'fcpxmlContent',
  },
};

async function saveFormat(key) {
  if (!state.reelsData.length) {
    toast('Brak danych reelsów!', 'info');
    return;
  }
  const f = FORMATS[key];
  const content = f.gen();
  if (content == null) return; // genLua already surfaced the missing-path toast
  state[f.store] = content;
  emit();
  const saved = await saveTextToPath({
    defaultName: videoBase() + f.suffix,
    content,
  });
  if (saved) toast('Zapisano plik ✓', 'success');
}

async function copyFormat(key) {
  if (!state.reelsData.length) {
    toast('Brak danych reelsów!', 'info');
    return;
  }
  const f = FORMATS[key];
  const content = f.gen();
  if (content == null) return;
  state[f.store] = content;
  emit();
  await copyText(content);
}

// ── "More" — transcript / segments / prompt ────────────────────────
// SRT export (sentence vs word-by-word) lives in ./export-srt.js, shared with
// the import-section "⬇ Eksport .srt" button so the toggle behaves identically.

async function exportVTT() {
  if (!state.sentences.length) {
    toast('Brak transkrypcji do eksportu.', 'info');
    return;
  }
  const saved = await saveTextToPath({
    defaultName: transcriptBase() + '.vtt',
    content: generateTranscriptVTT(state.sentences, state.fps),
  });
  if (saved) toast('Zapisano transkrypcję ✓', 'success');
}

async function exportMD() {
  if (!state.sentences.length) {
    toast('Brak segmentów do eksportu.', 'info');
    return;
  }
  const saved = await saveTextToPath({
    defaultName: 'segmenty.md',
    content: generateSegmentsMd(state.sentences, state.fps, state.srtName),
  });
  if (saved) toast('Zapisano .md ✓', 'success');
}

async function copyPrompt() {
  if (!state.sentences.length) {
    toast('Brak segmentów — najpierw przeanalizuj napisy.', 'info');
    return;
  }
  const content = buildPrompt(
    state.userPrompt,
    state.systemPrompt,
    state.sentences,
    null,
    state.videoFilename || '',
  );
  await copyText(content, 'Prompt skopiowany ✓');
}

// ── utilities ──────────────────────────────────────────────────────

function videoBase() {
  const name = state.videoFilename || 'reels';
  const lastDot = name.lastIndexOf('.');
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  return base || 'reels';
}

async function copyText(content, okMsg = 'Skopiowano ✓') {
  try {
    await navigator.clipboard.writeText(content);
    toast(okMsg, 'success');
  } catch {
    toast('Nie udało się skopiować — zaznacz i skopiuj ręcznie.', 'error');
  }
}
