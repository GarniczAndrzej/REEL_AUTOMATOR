// Preload for the Resolve WI panel (S-09 Phase 1). Runs sandboxed with context
// isolation (enforced from DR 19.0.2) — only `electron` is requireable here.
// Exposes a minimal `window.bridge` that the shared frontend's platform adapter
// (src/platform/adapter.js) detects and dispatches into. All real Node work
// happens in main.js via ipcMain.handle; this file only forwards.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('bridge', {
  // Generic backend command invoke (channel name === command name).
  invoke: (command, args) => ipcRenderer.invoke(command, args ?? {}),

  // Progress-event subscription. Returns an unsubscribe fn — the adapter hands it
  // back as the @tauri-apps/api/event `unlisten()` callers await + call in a
  // `finally`. The renderer-provided `listener` is invoked with the raw payload
  // (the adapter re-wraps it as Tauri's `{ payload }`).
  on: (channel, listener) => {
    const sub = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, sub);
    return () => ipcRenderer.removeListener(channel, sub);
  },

  // Native dialogs (shapes mirror @tauri-apps/plugin-dialog).
  dialog: {
    open: (opts) => ipcRenderer.invoke('dialog:open', opts ?? {}),
    save: (opts) => ipcRenderer.invoke('dialog:save', opts ?? {}),
    ask: (message, opts) =>
      ipcRenderer.invoke('dialog:ask', { message, options: opts ?? {} }),
  },
});
