// Node reimplementation of project.rs (S-09 Phase 1). Reads/writes the .reelproj
// JSON file. Matches the Tauri command shapes exactly:
//   load_project({ path }) -> parsed JSON object (consumed by applyProjectData)
//   save_project({ path, payload }) -> writes the JSON, returns nothing

const fs = require('fs/promises');

/** @param {{ path: string }} args @returns {Promise<object>} */
async function loadProject({ path }) {
  const raw = await fs.readFile(path, 'utf-8');
  return JSON.parse(raw);
}

/** @param {{ path: string, payload: object }} args @returns {Promise<void>} */
async function saveProject({ path, payload }) {
  await fs.writeFile(path, JSON.stringify(payload, null, 2), 'utf-8');
}

module.exports = { loadProject, saveProject };
