// Shared "save to a chosen location" helper. Every save in the app routes
// through here so the user always picks the destination via the native dialog —
// nothing is ever silently dumped into ~/Downloads. The actual write goes
// through the Rust `save_text_file` command (avoids fs-plugin scope friction on
// a freshly chosen path).

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
    alert('Nie udało się zapisać pliku: ' + e);
    return false;
  }
}
