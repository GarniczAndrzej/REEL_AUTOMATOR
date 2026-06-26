// Settings modal (S-16 Phase 2). Houses the OpenRouter API key, the model
// picker, and the export merge-gap — moved out of the dense header api-bar so
// the header reads clean. Mirrors the `#whisperAdvancedModal` open/close
// pattern (`src/ui/step1-import.js:initWhisperAdvanced`).

import { state, emit } from '../state.js';
import { getApiKey, setApiKey } from '../ai/api-key.js';
import { loadSettings, saveSettings } from '../settings.js';
import {
  DEFAULT_SCORING_GUIDANCE,
  DEFAULT_CLUSTER_GUIDANCE,
  DEFAULT_CURATE_GUIDANCE,
} from '../ai/prompt.js';
import {
  init as initOrPicker,
  CLUSTER_CONFIG,
  CURATE_CONFIG,
} from '../ai/openrouter-picker.js';
import { populateVideoMeta } from '../util/video-meta.js';
import { toast } from './toast.js';

/**
 * Wire the settings modal: open/close, API key load/save, model-picker
 * visibility, and the persisted merge-gap control. Call once on boot.
 * @returns {void}
 */
export function initSettingsModal() {
  const apiKeyInput = document.getElementById('apiKeyInput');
  if (apiKeyInput) apiKeyInput.placeholder = 'OpenRouter API key (sk-or-...)';

  // The model picker wrap is hidden by default; OpenRouter is the only
  // provider since S-17, so reveal it unconditionally.
  const orWrap = document.getElementById('orModelWrap');
  if (orWrap) orWrap.classList.add('visible');

  // S-25 Phase 3: mount the cluster + curate model pickers for the cluster→curate
  // pipeline. They share the model list/cache with the legacy picker (mounted from
  // main.js); only the selection (state.aiModels.* + localStorage key) differs.
  initOrPicker(CLUSTER_CONFIG);
  initOrPicker(CURATE_CONFIG);

  const saveBtn = document.getElementById('saveApiKeyBtn');
  if (saveBtn) saveBtn.addEventListener('click', saveApiKey);

  // Merge-gap → state + settings bag (persists across sessions, S-16 #6).
  const mergeEl = document.getElementById('mergeThreshold');
  if (mergeEl) {
    mergeEl.addEventListener('input', (e) => {
      const n = +e.target.value;
      if (!Number.isFinite(n) || n < 0) return;
      state.mergeThreshold = n;
      saveSettings({ mergeThreshold: n });
      emit();
    });
  }

  // Boot seeding (S-03): restore a previously saved global system prompt,
  // falling back to the default scoring guidance when unset. No emit() here by
  // design — this is a pre-subscriber boot seed (runs before any listener is
  // registered), so the "emit after any mutation" rule does not apply.
  const savedSettings = loadSettings();
  state.systemPrompt = savedSettings.systemPrompt ?? DEFAULT_SCORING_GUIDANCE;
  // S-25 Phase 3: same boot-seed pattern for the cluster/curate guidances.
  state.clusterPrompt = savedSettings.clusterPrompt ?? DEFAULT_CLUSTER_GUIDANCE;
  state.curatePrompt = savedSettings.curatePrompt ?? DEFAULT_CURATE_GUIDANCE;
  // S-25 Phase 4: pipeline mode (auto/single/pipeline), same boot-seed pattern.
  state.aiPipelineMode = savedSettings.aiPipelineMode ?? 'auto';

  // System prompt (FR-015) → state + settings bag (persists across sessions).
  const sysPromptEl = document.getElementById('systemPrompt');
  if (sysPromptEl) {
    sysPromptEl.addEventListener('input', (e) => {
      state.systemPrompt = e.target.value;
      saveSettings({ systemPrompt: e.target.value });
      emit();
    });
  }

  // S-25 Phase 3: cluster + curate prompts → state + settings bag, mirroring
  // the systemPrompt write-through pattern above.
  bindPromptTextarea('clusterPrompt', 'clusterPrompt');
  bindPromptTextarea('curatePrompt', 'curatePrompt');

  // S-25 Phase 4: pipeline-mode selector → state + settings bag.
  const modeEl = document.getElementById('aiPipelineMode');
  if (modeEl) {
    modeEl.addEventListener('change', (e) => {
      state.aiPipelineMode = e.target.value;
      saveSettings({ aiPipelineMode: e.target.value });
      emit();
    });
  }

  // Project/source fields re-homed here (acceptance feedback). These inputs
  // live in this modal, so this module owns their bindings (one component owns
  // its DOM): fps (with the re-parse note), video filename, gap, path,
  // resolution and project name.
  const fpsEl = document.getElementById('fpsSelect');
  if (fpsEl) {
    fpsEl.addEventListener('change', (e) => {
      state.fps = +e.target.value;
      if (state.sentences.length) {
        const noteEl = document.getElementById('fpsNote');
        if (noteEl) {
          noteEl.textContent =
            'FPS zmieniony — kliknij „Analizuj SRT →" aby odświeżyć timekody.';
          noteEl.style.color = 'var(--amber)';
        }
      }
      emit();
    });
  }
  bindProjectInput('videoFilename', 'videoFilename');
  const gapEl = document.getElementById('gapFrames');
  if (gapEl) {
    gapEl.addEventListener('input', (e) => {
      state.gapFrames = +e.target.value;
      emit();
    });
  }
  bindProjectInput('videoPath', 'videoPath');
  bindProjectInput('videoResolution', 'videoResolution');
  bindProjectInput('projectName', 'projectName');
  document
    .getElementById('browseVideoMetaBtn')
    ?.addEventListener('click', browseVideoMeta);

  loadApiKey();

  const openBtn = document.getElementById('settingsBtn');
  const modal = document.getElementById('settingsModal');
  const closeBtn = document.getElementById('settingsClose');
  if (!openBtn || !modal || !closeBtn) return;

  const close = () => {
    modal.style.display = 'none';
  };
  openBtn.addEventListener('click', () => {
    fillSettingsForm();
    modal.style.display = 'flex';
  });
  closeBtn.addEventListener('click', close);
  modal.addEventListener('click', (e) => {
    if (e.target === modal) close();
  });
}

function fillSettingsForm() {
  loadApiKey();
  setVal('mergeThreshold', state.mergeThreshold);
  setVal('fpsSelect', state.fps);
  setVal('videoFilename', state.videoFilename || '');
  setVal('gapFrames', state.gapFrames);
  setVal('videoPath', state.videoPath || '');
  setVal('videoResolution', state.videoResolution || '');
  setVal('projectName', state.projectName || '');
  setVal('systemPrompt', state.systemPrompt ?? DEFAULT_SCORING_GUIDANCE);
  setVal('clusterPrompt', state.clusterPrompt ?? DEFAULT_CLUSTER_GUIDANCE);
  setVal('curatePrompt', state.curatePrompt ?? DEFAULT_CURATE_GUIDANCE);
  setVal('aiPipelineMode', state.aiPipelineMode ?? 'auto');
}

function setVal(id, value) {
  const el = document.getElementById(id);
  if (el) el.value = value;
}

/**
 * Wire a text input to a `state` field: write-through on input + emit.
 * @param {string} id element id
 * @param {keyof typeof state} key state field
 * @returns {void}
 */
function bindProjectInput(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', (e) => {
    state[key] = e.target.value;
    emit();
  });
}

/**
 * Wire an editable prompt textarea to a `state` field with settings-bag
 * persistence (mirrors the systemPrompt write-through). S-25 Phase 3.
 * @param {string} id element id
 * @param {'clusterPrompt'|'curatePrompt'} key state + settings-bag field
 * @returns {void}
 */
function bindPromptTextarea(id, key) {
  const el = document.getElementById(id);
  if (!el) return;
  el.addEventListener('input', (e) => {
    state[key] = e.target.value;
    saveSettings({ [key]: e.target.value });
    emit();
  });
}

// Pick a video file and auto-detect fps + resolution; user can still override
// the populated fields afterwards. Mirrors the old export-card browse button.
async function browseVideoMeta() {
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
    await populateVideoMeta(path);
    fillSettingsForm();
    emit();
  } catch (e) {
    toast('Nie udało się wybrać pliku: ' + e, 'error');
  }
}

function saveApiKey() {
  const key = document.getElementById('apiKeyInput').value.trim();
  if (!key) {
    showStatus('Pusty klucz — nie zapisano', 'err');
    return;
  }
  setApiKey('openrouter', key);
  showStatus('Zapisano', 'ok');
}

function loadApiKey() {
  const input = document.getElementById('apiKeyInput');
  if (input) input.value = getApiKey('openrouter');
  const s = document.getElementById('apiStatus');
  if (!s) return;
  if (getApiKey('openrouter')) {
    s.textContent = 'Klucz załadowany';
    s.className = 'api-status ok';
  } else {
    s.textContent = '';
    s.className = 'api-status';
  }
}

function showStatus(msg, type) {
  const s = document.getElementById('apiStatus');
  if (!s) return;
  s.textContent = msg;
  s.className = 'api-status ' + type;
  setTimeout(() => {
    s.className = 'api-status';
    s.textContent = '';
  }, 2500);
}
