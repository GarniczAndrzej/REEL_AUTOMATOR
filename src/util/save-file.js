// Shared "save to a chosen location" helper. Every save in the app routes
// through here so the user always picks the destination via the native dialog —
// nothing is ever silently dumped into ~/Downloads. The actual write goes
// through the Rust `save_text_file` command (avoids fs-plugin scope friction on
// a freshly chosen path).

import { toast } from '../ui/toast.js';
import {
  invoke,
  dialogOpen,
  dialogSave,
  pathJoin,
} from '../platform/adapter.js';

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
    const ext = (defaultName.split('.').pop() || '').toLowerCase();
    const path = await dialogSave({
      defaultPath: defaultName,
      filters:
        filters ||
        (ext ? [{ name: ext.toUpperCase(), extensions: [ext] }] : undefined),
    });
    if (!path) return false; // user cancelled the dialog
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
    const picked = await dialogOpen({ directory: true, multiple: false });
    return typeof picked === 'string' ? picked : null;
  } catch (e) {
    toast('Nie udało się wybrać folderu: ' + e, 'error');
    return null;
  }
}

/**
 * Reveal a folder (or file) in the OS file manager (macOS Finder). Backs the
 * auto/batch "Otwórz folder docelowy" button shown after export completes.
 * @param {string} path Folder or file path to open.
 * @returns {Promise<void>}
 */
export async function openPath(path) {
  try {
    await invoke('open_path', { path });
  } catch (e) {
    toast('Nie udało się otworzyć folderu: ' + e, 'error');
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
    const path = await pathJoin(folder, name);
    await invoke('save_text_file', { path, content });
    return true;
  } catch (e) {
    toast('Nie udało się zapisać pliku „' + name + '”: ' + e, 'error');
    return false;
  }
}
