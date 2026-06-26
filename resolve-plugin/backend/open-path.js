// Node reimplementation of open_path (S-09 Phase 1) — reveal a folder/file in the
// OS file manager (macOS Finder), backing the "Otwórz folder docelowy" button.
// Tauri used the shell plugin; Electron uses shell.openPath, which is passed in
// from main.js (the sandboxed preload can't require it).

/**
 * @param {{ path: string }} args
 * @param {{ openPath: (p: string) => Promise<string> }} shell - Electron shell
 * @returns {Promise<void>}
 */
async function openPath({ path }, shell) {
  // shell.openPath resolves to an error string ('' on success).
  const err = await shell.openPath(path);
  if (err) throw new Error(err);
}

module.exports = { openPath };
