// Import-section submodule: `.reelproj` open / save / save-as, the v5 writer,
// tolerant load (applyProjectData), and the recent-projects list. (S-16 Phase
// 3a — structural split, no behavior change.)

import { state, emit } from '../../state.js';
import { toast } from '../toast.js';
import { escHtml } from './segments.js';
import { renderModelManager } from './transcribe.js';

export function initProjectIO() {
  document
    .getElementById('openProjectBtn')
    .addEventListener('click', openProject);
  document
    .getElementById('saveProjectBtn')
    .addEventListener('click', saveProject);
  document
    .getElementById('saveProjectAsBtn')
    .addEventListener('click', saveProjectAs);
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
    toast('Nie udało się otworzyć projektu: ' + e, 'error');
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
    toast('Nie udało się zapisać projektu: ' + e, 'error');
  }
}

async function writeProject(path) {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const payload = {
      // v5 (S-16) drops the consolidated/removed keys: the duplicate per-export
      // filename (folded into videoFilename), the min-sentence-length knob (now
      // a module constant), the multi-source `sources` repeater, and the
      // per-reel merge-threshold override (folded into the single global gap).
      // v3/v4 files still load — applyProjectData tolerates the legacy keys.
      // v6 (S-03) adds the editable systemPrompt (scoring guidance).
      version: 6,
      srtName: state.srtName,
      srtContent: state.srtContent,
      fps: state.fps,
      videoFilename: state.videoFilename,
      videoPath: state.videoPath,
      videoResolution: state.videoResolution,
      projectName: state.projectName,
      gapFrames: state.gapFrames,
      mergeThreshold: state.mergeThreshold,
      userPrompt: state.userPrompt,
      systemPrompt: state.systemPrompt,
      whisperLanguage: state.whisperLanguage,
      modelId: state.modelId,
      diarize: state.diarize,
      sentences: state.sentences,
      reelsData: state.reelsData,
    };
    await invoke('save_project', { path, payload });
  } catch (e) {
    toast('Nie udało się zapisać: ' + e, 'error');
  }
}

function applyProjectData(data) {
  // Reset per-project content first so loading a partial/older file over an
  // active session can't carry over the previous project's data for any key the
  // new file omits. App-level config (mergeThreshold, whisperLanguage, modelId,
  // diarize) is intentionally NOT reset — it has global/settings semantics.
  state.srtName = null;
  state.srtContent = null;
  state.videoFilename = '';
  state.videoPath = '';
  state.videoResolution = '1920x1080';
  state.projectName = 'Reels';
  state.sentences = [];
  state.reelsData = [];

  if (data.srtName) state.srtName = data.srtName;
  if (data.srtContent) state.srtContent = data.srtContent;
  if (data.fps) state.fps = data.fps;
  if (data.videoFilename) state.videoFilename = data.videoFilename;
  if (data.videoPath) state.videoPath = data.videoPath;
  if (data.videoResolution) state.videoResolution = data.videoResolution;
  if (data.projectName) state.projectName = data.projectName;
  if (data.gapFrames != null) state.gapFrames = data.gapFrames;
  // Legacy v3/v4 keys (the duplicate per-export filename, the min-sentence
  // knob) are simply ignored here — old files still carried videoFilename, so
  // the filename restores from that; the removed knobs never error on load.
  if (data.mergeThreshold != null) state.mergeThreshold = data.mergeThreshold;
  if (data.userPrompt) state.userPrompt = data.userPrompt;
  // v6 systemPrompt: assign-if-present (like userPrompt). Older files omit it,
  // so the global default / settings-bag value is kept.
  if (data.systemPrompt) state.systemPrompt = data.systemPrompt;
  if (data.whisperLanguage) state.whisperLanguage = data.whisperLanguage;
  if (data.modelId) state.modelId = data.modelId;
  if (data.diarize != null) state.diarize = data.diarize;
  if (data.sentences) state.sentences = data.sentences;
  if (data.reelsData) state.reelsData = data.reelsData;
  // Legacy `sources` (multi-source repeater, removed in S-16 3b) is ignored.

  // Sync DOM — Step 1 fields
  document.getElementById('fpsSelect').value = state.fps;
  document.getElementById('videoFilename').value = state.videoFilename || '';
  document.getElementById('gapFrames').value = state.gapFrames;
  document.getElementById('userPrompt').value = state.userPrompt || '';
  const sysPromptEl = document.getElementById('systemPrompt');
  if (sysPromptEl) sysPromptEl.value = state.systemPrompt || '';
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
