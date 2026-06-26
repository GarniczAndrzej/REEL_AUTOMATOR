// Node reimplementation of save_text_file / load_text_file (S-09 Phase 1). The
// export-write chokepoint (src/util/save-file.js) and preset import
// (src/ui/step2-preset-bar.js) route through these. Matches the Tauri shapes:
//   save_text_file({ path, content }) -> writes UTF-8 text
//   load_text_file({ path }) -> returns the file's UTF-8 text

const fs = require('fs/promises');

/** @param {{ path: string, content: string }} args @returns {Promise<void>} */
async function saveTextFile({ path, content }) {
  await fs.writeFile(path, content, 'utf-8');
}

/** @param {{ path: string }} args @returns {Promise<string>} */
async function loadTextFile({ path }) {
  return fs.readFile(path, 'utf-8');
}

module.exports = { saveTextFile, loadTextFile };
