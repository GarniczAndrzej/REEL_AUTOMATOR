// FR-016 preset bar (S-03 Phase 3). Manages the preset picker + CRUD actions
// in the "Prompt dla AI" card. Import/export (Phase 4) wires into the two
// stub handlers at the bottom: presetImportBtn / presetExportBtn.

import { state, emit } from '../state.js';
import {
  loadPresets,
  savePresets,
  addPreset,
  updatePreset,
  removePreset,
} from '../ai/prompt-presets.js';
import { toast } from './toast.js';

/** @typedef {import('../ai/prompt-presets.js').PromptPreset} PromptPreset - re-exported for callers */

/**
 * Populate the picker `<select>` from `state.promptPresets` and re-wire event
 * listeners. Call after any mutation that changes the list. Selecting a preset
 * fills the `#userPrompt` textarea and updates `state.userPrompt`.
 */
export function renderPresetBar() {
  const picker = /** @type {HTMLSelectElement|null} */ (
    document.getElementById('presetPicker')
  );
  if (!picker) return;

  const presets = state.promptPresets;
  picker.innerHTML =
    `<option value="" disabled>— wybierz preset —</option>` +
    presets
      .map(
        (p) =>
          `<option value="${escHtml(p.id)}">${escHtml(p.name)}</option>`,
      )
      .join('');

  // Re-apply selected option if the current userPrompt matches a preset.
  const matched = presets.find((p) => p.userPrompt === state.userPrompt);
  if (matched) picker.value = matched.id;
}

/**
 * Wire all preset bar buttons. Call once on boot (after the DOM is ready).
 */
export function initPresetBar() {
  const picker = document.getElementById('presetPicker');
  const saveBtn = document.getElementById('presetSaveBtn');
  const dupBtn = document.getElementById('presetDuplicateBtn');
  const renameBtn = document.getElementById('presetRenameBtn');
  const deleteBtn = document.getElementById('presetDeleteBtn');
  const importBtn = document.getElementById('presetImportBtn');
  const exportBtn = document.getElementById('presetExportBtn');

  if (!picker) return;

  picker.addEventListener('change', () => {
    const id = /** @type {HTMLSelectElement} */ (picker).value;
    const preset = state.promptPresets.find((p) => p.id === id);
    if (!preset) return;
    state.userPrompt = preset.userPrompt;
    const promptEl = /** @type {HTMLTextAreaElement|null} */ (
      document.getElementById('userPrompt')
    );
    if (promptEl) promptEl.value = preset.userPrompt;
    emit();
  });

  saveBtn?.addEventListener('click', async () => {
    const name = await promptNative('Nazwa presetu:', 'Nowy preset');
    if (name === null || name.trim() === '') return;
    const preset = addPreset({ name: name.trim(), userPrompt: state.userPrompt });
    state.promptPresets = loadPresets();
    renderPresetBar();
    const pickerEl = /** @type {HTMLSelectElement|null} */ (
      document.getElementById('presetPicker')
    );
    if (pickerEl) pickerEl.value = preset.id;
    emit();
    toast(`Preset „${name.trim()}" zapisany.`, 'success');
  });

  dupBtn?.addEventListener('click', async () => {
    const id = getSelectedId();
    if (!id) {
      toast('Najpierw wybierz preset do zduplikowania.', 'info');
      return;
    }
    const source = state.promptPresets.find((p) => p.id === id);
    if (!source) return;
    const name = await promptNative('Nazwa kopii:', `${source.name} (kopia)`);
    if (name === null || name.trim() === '') return;
    addPreset({ name: name.trim(), userPrompt: source.userPrompt });
    state.promptPresets = loadPresets();
    renderPresetBar();
    emit();
    toast(`Zduplikowano jako „${name.trim()}".`, 'success');
  });

  renameBtn?.addEventListener('click', async () => {
    const id = getSelectedId();
    if (!id) {
      toast('Najpierw wybierz preset do zmiany nazwy.', 'info');
      return;
    }
    const source = state.promptPresets.find((p) => p.id === id);
    if (!source) return;
    const name = await promptNative('Nowa nazwa:', source.name);
    if (name === null || name.trim() === '') return;
    updatePreset(id, { name: name.trim() });
    state.promptPresets = loadPresets();
    renderPresetBar();
    const pickerEl = /** @type {HTMLSelectElement|null} */ (
      document.getElementById('presetPicker')
    );
    if (pickerEl) pickerEl.value = id;
    emit();
    toast(`Zmieniono nazwę na „${name.trim()}".`, 'success');
  });

  deleteBtn?.addEventListener('click', async () => {
    const id = getSelectedId();
    if (!id) {
      toast('Najpierw wybierz preset do usunięcia.', 'info');
      return;
    }
    const source = state.promptPresets.find((p) => p.id === id);
    if (!source) return;
    const confirmed = await confirmNative(
      `Usunąć preset „${source.name}"? Tej operacji nie można cofnąć.`,
      'Usuń preset',
    );
    if (!confirmed) return;
    removePreset(id);
    state.promptPresets = loadPresets();
    renderPresetBar();
    emit();
    toast(`Preset „${source.name}" usunięty.`, 'success');
  });

  // Import/export stubs — fully wired in Phase 4.
  importBtn?.addEventListener('click', () => importPresets());
  exportBtn?.addEventListener('click', () => exportPresets());

  renderPresetBar();
}

// ── Phase 4 stubs (replaced in Phase 4) ─────────────────────────────────────

/**
 * Import presets from a user-chosen `.json` file. Wired fully in Phase 4.
 * @returns {Promise<void>}
 */
async function importPresets() {
  toast('Import presetów dostępny od fazy 4.', 'info');
}

/**
 * Export the selected preset (or library) to a `.json` file. Wired in Phase 4.
 * @returns {Promise<void>}
 */
async function exportPresets() {
  toast('Eksport presetów dostępny od fazy 4.', 'info');
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** @returns {string} the currently selected preset id, or '' */
function getSelectedId() {
  const picker = /** @type {HTMLSelectElement|null} */ (
    document.getElementById('presetPicker')
  );
  return picker?.value || '';
}

/**
 * Show a native prompt dialog (Tauri) or fall back to `window.prompt`.
 * @param {string} message
 * @param {string} [defaultValue]
 * @returns {Promise<string|null>} null if cancelled
 */
async function promptNative(message, defaultValue = '') {
  try {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    // Tauri's `ask` is a boolean confirm; for text input we fall back to
    // window.prompt which works fine in the WKWebView for short text entry.
    // (There is no native text-input dialog in Tauri's plugin-dialog v2.)
    void ask; // imported but unused — kept for future reference
  } catch {
    // not in Tauri
  }
  return window.prompt(message, defaultValue);
}

/**
 * Show a native confirm dialog (Tauri `ask`) or fall back to `window.confirm`.
 * Mirrors the `deleteModel` precedent (`transcribe.js:254-263`).
 * @param {string} message
 * @param {string} [title]
 * @returns {Promise<boolean>}
 */
async function confirmNative(message, title = 'Potwierdź') {
  try {
    const { ask } = await import('@tauri-apps/plugin-dialog');
    return await ask(message, {
      title,
      kind: 'warning',
      okLabel: 'Usuń',
      cancelLabel: 'Anuluj',
    });
  } catch {
    return window.confirm(message);
  }
}

/** @param {string} s @returns {string} */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
