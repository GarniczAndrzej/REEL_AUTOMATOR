// Renderer event bridge for the Node backend ports (S-09 Phase 4). Tauri uses
// `app.emit(channel, payload)` → the frontend's `@tauri-apps/api/event` `listen`;
// under Electron the equivalent is `webContents.send(channel, payload)` →
// `ipcRenderer.on` (wired in preload.js `bridge.on`). main.js registers the
// panel's webContents here once the window exists; the WhisperX + model-manager
// ports call `emit()` to push `transcribe-progress` / `model-download-progress`.

let sender = null;

/** @param {import('electron').WebContents | null} webContents */
function setSender(webContents) {
  sender = webContents || null;
}

/**
 * Push a progress event to the panel renderer. Best-effort: a torn-down window
 * (panel closed mid-run) is a no-op, never a throw.
 * @param {string} channel
 * @param {any} payload
 */
function emit(channel, payload) {
  if (sender && !sender.isDestroyed()) {
    sender.send(channel, payload);
  }
}

module.exports = { setSender, emit };
