// DaVinci Resolve Workflow Integration host (S-09 Phase 1) — Electron main process.
//
// Loads the native WorkflowIntegration.node bridge in-process (it does NOT
// require the user's "External scripting" preference — F-02 verified this live),
// creates the panel window with sandbox + context isolation (enforced from DR
// 19.0.2), points it at the built `src/` frontend (renderer/), and registers the
// IPC bridge the platform adapter (src/platform/adapter.js) dispatches into.
//
// Every Node-side backend command mirrors the Tauri Rust command's args + return
// shape 1:1, so the shared frontend stays unaware of the host. Phase 1 ports only
// the trivial fs/crypto/safeStorage commands the Mode D path + core UI need; the
// WhisperX sidecar + model manager land in Phase 4.

const path = require('path');
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');

const resolve = require('./backend/resolve');
const project = require('./backend/project');
const textFile = require('./backend/text-file');
const llmCache = require('./backend/llm-cache');
const credentials = require('./backend/credentials');
const openPath = require('./backend/open-path');
const events = require('./backend/events');
const whisper = require('./backend/whisper');
const models = require('./backend/models');
const engine = require('./backend/engine');
const waveform = require('./backend/waveform');
const metadata = require('./backend/metadata');

// ── Native Resolve bridge ────────────────────────────────────────────────────
// Bundled per-OS beside main.js. Absent on a fresh checkout/worktree (git-ignored,
// like the sidecars) — load defensively so a dev run without the .node doesn't
// hard-crash; Resolve features then report unavailable and the panel falls back
// to the S-08 file-export set. Initialize + the (async) Resolve handshake run in
// resolve.bootstrap() at app-ready.
let WorkflowIntegration = null;
try {
  WorkflowIntegration = require('./WorkflowIntegration.node');
} catch (e) {
  console.warn(
    '[resolve-plugin] WorkflowIntegration.node unavailable — file-export fallback only:',
    e.message,
  );
}
resolve.setWorkflowIntegration(WorkflowIntegration);

// ── IPC command dispatch (channel name === command name) ──────────────────────
// Each handler matches its Tauri Rust command's args + return shape exactly.
const handlers = {
  // project.rs
  load_project: (args) => project.loadProject(args),
  save_project: (args) => project.saveProject(args),
  // text file read/write (preset import + the export-write chokepoint)
  load_text_file: (args) => textFile.loadTextFile(args),
  save_text_file: (args) => textFile.saveTextFile(args),
  // reveal a folder/file in Finder
  open_path: (args) => openPath.openPath(args, shell),
  // LLM disk cache (frontend pre-hashes the key → we read/write by hash)
  load_llm_cache: (args) => llmCache.loadLlmCache(args),
  save_llm_cache: (args) => llmCache.saveLlmCache(args),
  clear_llm_cache: () => llmCache.clearLlmCache(),
  // credentials → Electron safeStorage (no native keyring .node to sign)
  get_credential: (args) => credentials.getCredential(args),
  set_credential: (args) => credentials.setCredential(args),
  delete_credential: (args) => credentials.deleteCredential(args),
  // Node path.join (adapter.pathJoin round-trips here)
  path_join: (args) => path.join(...(args.parts || [])),
  // Resolve availability + live timeline fps (Phase 1 capability probe)
  resolve_capability: () => resolve.capability(),
  // Mode D (Phase 2): dated folder + one timeline holding all reels (inter-reel
  // gap from settings), built directly via the live Resolve API (AppendToTimeline
  // + AddMarker) from a pure clip payload
  resolve_create_reels: (args) => resolve.createReels(args),
  // Mode C (Phase 3): push the generated 0-based SRT onto the current timeline's
  // subtitle track via Media-Pool import (ImportIntoTimeline fallback)
  resolve_import_subtitles: (args) => resolve.importSubtitles(args),
  // Mode C: current timeline In/Out marks (frame offsets) so the renderer can
  // push only the cues inside the selected range
  resolve_timeline_inout: () => resolve.timelineInOut(),
  // ── Mode B (Phase 4): WhisperX in-panel transcription ──────────────────────
  // whisper.rs — transcription, forced alignment, cancel (single global child +
  // SIGTERM→300ms→SIGKILL reaper; progress via the transcribe-progress event)
  transcribe_video: (args) => whisper.transcribeVideo(args),
  align_transcript: (args) => whisper.alignTranscript(args),
  cancel_transcription: () => whisper.cancelTranscription(),
  // engine.rs — readiness (cached read on the launch path; --selftest/--capability
  // spawn only on explicit user action)
  whisperx_engine_check: () => engine.whisperxEngineCheck(),
  whisperx_engine_capability: () => engine.whisperxEngineCapability(),
  whisperx_engine_cached: () => engine.whisperxEngineCached(),
  // models.rs — model manager (download emits model-download-progress)
  list_models: (args) => models.listModels(args),
  download_model: (args) => models.downloadModel(args),
  delete_model: (args) => models.deleteModel(args),
  // waveform.rs — clip-trim waveform peaks
  extract_waveform: (args) => waveform.extractWaveform(args),
  // metadata.rs — source fps/resolution probe (auto-populate on import)
  probe_video_metadata: (args) => metadata.probeVideoMetadata(args),
};

function registerIpc() {
  for (const [name, fn] of Object.entries(handlers)) {
    ipcMain.handle(name, (_event, args) => fn(args || {}));
  }
  // Native dialogs (mapped to @tauri-apps/plugin-dialog return shapes).
  ipcMain.handle('dialog:open', (_e, opts) => nativeOpen(opts || {}));
  ipcMain.handle('dialog:save', (_e, opts) => nativeSave(opts || {}));
  ipcMain.handle('dialog:ask', (_e, payload) => nativeAsk(payload || {}));
}

// ── Native dialogs → Tauri-plugin-dialog-compatible returns ───────────────────

async function nativeOpen(opts) {
  const properties = opts.directory ? ['openDirectory'] : ['openFile'];
  if (opts.multiple) properties.push('multiSelections');
  const res = await dialog.showOpenDialog({
    properties,
    filters: Array.isArray(opts.filters) ? opts.filters : undefined,
    defaultPath: opts.defaultPath,
  });
  if (res.canceled || !res.filePaths.length) return null;
  return opts.multiple ? res.filePaths : res.filePaths[0];
}

async function nativeSave(opts) {
  const res = await dialog.showSaveDialog({
    defaultPath: opts.defaultPath,
    filters: Array.isArray(opts.filters) ? opts.filters : undefined,
  });
  return res.canceled || !res.filePath ? null : res.filePath;
}

async function nativeAsk({ message, options }) {
  const o = options || {};
  const type =
    o.kind === 'warning'
      ? 'warning'
      : o.kind === 'error'
        ? 'error'
        : 'question';
  const res = await dialog.showMessageBox({
    type,
    buttons: [o.okLabel || 'OK', o.cancelLabel || 'Anuluj'],
    defaultId: 0,
    cancelId: 1,
    title: o.title || '',
    message: message || '',
  });
  return res.response === 0;
}

// ── Window + lifecycle ────────────────────────────────────────────────────────

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 920,
    title: 'Reels Automator',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // Quit the plugin process when the panel closes so reopening from the menu
  // spawns a fresh instance (matches the Resolve SDK SamplePlugin; avoids a
  // lingering zombie process on macOS).
  mainWindow.on('close', () => app.quit());
  // Route backend progress events (transcribe-progress, model-download-progress)
  // to this panel's renderer — the Electron analog of Tauri's app.emit().
  events.setSender(mainWindow.webContents);
  mainWindow.on('closed', () => events.setSender(null));
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  // One detection point: probe Resolve once at boot. The renderer reads the
  // verdict via `resolve_capability` and either drives the API or falls back to
  // file export.
  try {
    await resolve.bootstrap();
  } catch (e) {
    console.warn('[resolve-plugin] Resolve bootstrap failed:', e.message);
  }
  registerIpc();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS-only slice; follow the platform convention (the panel process stays
  // alive until Resolve tears it down).
  if (process.platform !== 'darwin') app.quit();
});
