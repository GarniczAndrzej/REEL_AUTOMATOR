// Shared "save to a chosen location" helper. Every save in the app routes
// through here so the user always picks the destination via the native dialog —
// nothing is ever silently dumped into ~/Downloads. The actual write goes
// through the Rust `save_text_file` command (avoids fs-plugin scope friction on
// a freshly chosen path).

import { toast } from '../ui/toast.js';

/**
 * @param {object} opts
 * @param {string} opts.defaultName Suggested file name (extension drives the
 *   default filter when `filters` is omitted).
 * @param {string} opts.content Text to write.
 * @param {{name:string,extensions:string[]}[]} [opts.filters] Dialog filters.
 * @returns {Promise<boolean>} true if written, false if the user cancelled.
 */
export async function saveTextToPath({ defaultName, content, filters }) {
  try {
    const { save } = await import('@tauri-apps/plugin-dialog');
    const ext = (defaultName.split('.').pop() || '').toLowerCase();
    const path = await save({
      defaultPath: defaultName,
      filters:
        filters ||
        (ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined),
    });
    if (!path) return false; // user cancelled the dialog
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('save_text_file', { path, content });
    return true;
  } catch (e) {
    toast('Nie udało się zapisać pliku: ' + e, 'error');
    return false;
  }
}

/**
 * Ask the user to pick a destination folder once via the native directory
 * dialog (S-07 multi-output / batch export). Honors the save-location rule —
 * nothing is ever auto-dumped to ~/Downloads.
 * @returns {Promise<string|null>} the chosen folder path, or null if cancelled.
 */
export async function pickFolder() {
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false });
    return typeof picked === 'string' ? picked : null;
  } catch (e) {
    toast('Nie udało się wybrać folderu: ' + e, 'error');
    return null;
  }
}

/**
 * Write one text file into a previously chosen folder — no per-file dialog.
 * Used by multi-output single-video export (S-07 Phase 3) and batch (Phase 4),
 * which call `pickFolder()` once then `saveTextToFolder(...)` per file.
 * @param {object} opts
 * @param {string} opts.folder Destination folder path (from `pickFolder`).
 * @param {string} opts.name File name (with extension) to write inside it.
 * @param {string} opts.content Text to write.
 * @returns {Promise<boolean>} true if written, false on error.
 */
export async function saveTextToFolder({ folder, name, content }) {
  try {
    const { join } = await import('@tauri-apps/api/path');
    const path = await join(folder, name);
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('save_text_file', { path, content });
    return true;
  } catch (e) {
    toast('Nie udało się zapisać pliku „' + name + '”: ' + e, 'error');
    return false;
  }
}
