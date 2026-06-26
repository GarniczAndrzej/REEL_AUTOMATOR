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
import { saveTextToPath } from '../util/save-file.js';
import { invoke, dialogOpen, dialogAsk } from '../platform/adapter.js';

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
        (p) => `<option value="${escHtml(p.id)}">${escHtml(p.name)}</option>`,
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
    const preset = addPreset({
      name: name.trim(),
      userPrompt: state.userPrompt,
    });
    if (!preset) {
      toast('Nie udało się zapisać presetu.', 'error');
      return;
    }
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
    if (!addPreset({ name: name.trim(), userPrompt: source.userPrompt })) {
      toast('Nie udało się zduplikować presetu.', 'error');
      return;
    }
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
    if (!updatePreset(id, { name: name.trim() })) {
      toast('Nie udało się zmienić nazwy presetu.', 'error');
      return;
    }
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
    if (!removePreset(id)) {
      toast('Nie udało się usunąć presetu.', 'error');
      return;
    }
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

// ── Import / export (Phase 4) ─────────────────────────────────────────────────

/**
 * Export the selected preset to a `.json` file via a native save dialog.
 * Falls back to exporting the whole library when no preset is selected.
 * @returns {Promise<void>}
 */
async function exportPresets() {
  const id = getSelectedId();
  const list = state.promptPresets;
  const toExport = id ? list.filter((p) => p.id === id) : list;
  if (toExport.length === 0) {
    toast('Brak presetów do eksportu.', 'info');
    return;
  }
  const defaultName =
    toExport.length === 1
      ? `${toExport[0].name.replace(/[^a-z0-9ąćęłńóśźżA-ZĄĆĘŁŃÓŚŹŻ _-]/g, '_')}.json`
      : 'presety.json';
  const content = JSON.stringify(toExport, null, 2);
  const written = await saveTextToPath({
    defaultName,
    content,
    filters: [{ name: 'JSON', extensions: ['json'] }],
  });
  if (written) {
    toast(
      toExport.length === 1
        ? `Preset „${toExport[0].name}" wyeksportowany.`
        : `Wyeksportowano ${toExport.length} presetów.`,
      'success',
    );
  }
}

/**
 * Import presets from a user-chosen `.json` file. Validates each entry and
 * merges (appends with fresh IDs) into the current library.
 * @returns {Promise<void>}
 */
async function importPresets() {
  try {
    const path = await dialogOpen({
      filters: [{ name: 'JSON', extensions: ['json'] }],
      multiple: false,
    });
    if (!path) return;

    const raw = await invoke('load_text_file', { path });

    let parsed;
    try {
      parsed = JSON.parse(/** @type {string} */ (raw));
    } catch {
      toast('Nieprawidłowy plik JSON — nie można zaimportować.', 'error');
      return;
    }

    const entries = Array.isArray(parsed) ? parsed : [parsed];
    const valid = entries.filter(
      (e) =>
        e &&
        typeof e === 'object' &&
        typeof e.name === 'string' &&
        e.name.trim() !== '' &&
        typeof e.userPrompt === 'string',
    );

    if (valid.length === 0) {
      toast(
        'Plik nie zawiera żadnych prawidłowych presetów (wymagane pola: name, userPrompt).',
        'error',
      );
      return;
    }

    for (const entry of valid) {
      addPreset({ name: entry.name.trim(), userPrompt: entry.userPrompt });
    }
    state.promptPresets = loadPresets();
    renderPresetBar();
    emit();
    toast(
      valid.length === 1
        ? `Zaimportowano preset „${valid[0].name.trim()}".`
        : `Zaimportowano ${valid.length} presetów.`,
      'success',
    );
  } catch (e) {
    toast(`Błąd importu: ${e}`, 'error');
  }
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
 * Text-input prompt. Uses an in-app modal — `window.prompt` is unsupported in
 * Tauri's WKWebView and can crash the app (Tauri plugin-dialog v2 has no
 * text-input dialog, so there is no native equivalent to fall back to).
 * @param {string} message
 * @param {string} [defaultValue]
 * @returns {Promise<string|null>} null if cancelled
 */
function promptNative(message, defaultValue = '') {
  return openModal({
    message,
    defaultValue,
    withInput: true,
    okLabel: 'OK',
    cancelLabel: 'Anuluj',
  });
}

/**
 * Confirm dialog. Uses Tauri's native `ask` (the `deleteModel` precedent,
 * `transcribe.js:254-263`); falls back to the in-app modal outside Tauri.
 * Never uses `window.confirm` — it is unsupported in the WKWebView and can
 * crash the app.
 * @param {string} message
 * @param {string} [title]
 * @returns {Promise<boolean>}
 */
async function confirmNative(message, title = 'Potwierdź') {
  try {
    return await dialogAsk(message, {
      title,
      kind: 'warning',
      okLabel: 'Usuń',
      cancelLabel: 'Anuluj',
    });
  } catch {
    const res = await openModal({
      message,
      withInput: false,
      okLabel: 'Usuń',
      cancelLabel: 'Anuluj',
    });
    return res !== null;
  }
}

/**
 * Build a transient in-app modal overlay (replacement for the unsupported
 * `window.prompt` / `window.confirm`). With `withInput`, shows a text field and
 * resolves its value on OK / `null` on cancel. Without input it is a confirm:
 * resolves `''` on OK / `null` on cancel. Enter confirms, Escape / backdrop
 * cancels.
 * @param {{ message: string, defaultValue?: string, withInput?: boolean, okLabel?: string, cancelLabel?: string }} opts
 * @returns {Promise<string|null>}
 */
function openModal({
  message,
  defaultValue = '',
  withInput = false,
  okLabel = 'OK',
  cancelLabel = 'Anuluj',
}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;z-index:9999;display:flex;align-items:center;' +
      'justify-content:center;background:rgba(0,0,0,0.5);';

    const box = document.createElement('div');
    box.style.cssText =
      'background:var(--bg2,#1e1e24);color:var(--text,#fff);' +
      'border:1px solid var(--border,#3a3a44);border-radius:0;padding:18px;' +
      'width:min(420px,90vw);box-shadow:0 12px 40px rgba(0,0,0,0.4);';

    const label = document.createElement('div');
    label.textContent = message;
    label.style.cssText = 'font-size:14px;margin-bottom:12px;';
    box.appendChild(label);

    /** @type {HTMLInputElement|null} */
    let input = null;
    if (withInput) {
      input = document.createElement('input');
      input.type = 'text';
      input.value = defaultValue;
      input.style.cssText =
        'width:100%;box-sizing:border-box;padding:8px;font-size:13px;' +
        'margin-bottom:14px;background:var(--bg,#111);color:var(--text,#fff);' +
        'border:1px solid var(--border,#3a3a44);border-radius:0;';
      box.appendChild(input);
    }

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn btn-secondary';
    cancelBtn.textContent = cancelLabel;
    cancelBtn.style.cssText = 'padding:6px 14px;font-size:13px;';
    const okBtn = document.createElement('button');
    okBtn.className = 'btn';
    okBtn.textContent = okLabel;
    okBtn.style.cssText = 'padding:6px 14px;font-size:13px;';
    row.appendChild(cancelBtn);
    row.appendChild(okBtn);
    box.appendChild(row);
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const cleanup = () => {
      document.removeEventListener('keydown', onKey);
      overlay.remove();
    };
    /** @param {string|null} val */
    const done = (val) => {
      cleanup();
      resolve(val);
    };
    const onOk = () => done(input ? input.value : '');
    const onCancel = () => done(null);
    /** @param {KeyboardEvent} e */
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        onOk();
      }
    };

    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) onCancel();
    });
    document.addEventListener('keydown', onKey);

    if (input) {
      input.focus();
      input.select();
    } else {
      okBtn.focus();
    }
  });
}

/** @param {string} s @returns {string} */
function escHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
