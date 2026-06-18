// Preset library for userPrompt (FR-016 / S-03). Backed by localStorage key
// `edl_prompt_presets`. Seeded with built-in Polish starters on first run;
// fully editable/deletable by the user.

const LS_KEY = 'edl_prompt_presets';

/** @typedef {import('../state.js').PromptPreset} PromptPreset */

/**
 * Built-in starter presets (Polish). Preset #1 mirrors the original
 * `state.userPrompt` default so the user sees no regression on first run.
 * @type {PromptPreset[]}
 */
export const BUILTIN_PRESETS = [
  {
    id: 'builtin-sprzedazowy',
    name: 'Sprzedażowy (webinar)',
    userPrompt: `Stwórz viralowe reelsy sprzedażowe z tego webinaru.

Zasady:
- Każdy Reel: HOOK (mocny wstęp) → BODY (rozwinięcie) → CTA (wezwanie do działania)
- Długość: 30–90 sekund
- Możesz zmieniać kolejność segmentów zachowując logiczny sens
- Szukaj emocjonalnych momentów, konkretnych liczb, historii i CTA
- Stwórz tyle Reelsów ile możesz z wartościowego materiału`,
  },
  {
    id: 'builtin-edukacyjny',
    name: 'Edukacyjny',
    userPrompt: `Wytnij z nagrania najcenniejsze fragmenty edukacyjne jako krótkie reelsy.

Zasady:
- Każdy Reel: jeden konkretny insight lub lekcja do zapamiętania
- Długość: 20–60 sekund
- Priorytetyzuj momenty „aha", definicje, porady krok po kroku
- Każdy Reel musi mieć jasny tytuł tematyczny
- Unikaj fragmentów, gdzie prowadzący pyta o pytania lub robi przerwy`,
  },
  {
    id: 'builtin-storytelling',
    name: 'Storytelling / historia',
    userPrompt: `Znajdź w nagraniu najmocniejsze fragmenty narracyjne i ułóż z nich emocjonalne reelsy.

Zasady:
- Każdy Reel: problem → zwrot akcji → rozwiązanie lub refleksja
- Długość: 45–90 sekund
- Szukaj anegdot, metafor, osobistych doświadczeń mówcy
- Hook musi wciągnąć widza w pierwszych 3 sekundach
- Zachowaj naturalny rytm narracji — nie urywaj w połowie zdania`,
  },
  {
    id: 'builtin-highlights',
    name: 'Najlepsze chwile (highlights)',
    userPrompt: `Wybierz absolutne perełki z nagrania — momenty, które warto obejrzeć niezależnie od kontekstu.

Zasady:
- Każdy Reel to jeden wyrazisty, samodzielny fragment
- Długość: 15–45 sekund
- Szukaj śmiesznych, zaskakujących lub bardzo konkretnych momentów
- Każdy Reel powinien działać bez znajomości reszty nagrania
- Im krótszy i bardziej treściwy — tym lepiej`,
  },
];

/**
 * Read the preset library from localStorage. Always returns an array (never throws).
 * @returns {PromptPreset[]}
 */
export function loadPresets() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Overwrite the entire preset library in localStorage.
 * @param {PromptPreset[]} list
 * @returns {boolean} true if the write succeeded, false if it threw (e.g. quota)
 */
export function savePresets(list) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}

/**
 * Seed the built-in presets if the store is absent (first run). Does nothing
 * if the user already has a library (even an empty one written by a prior session).
 */
export function seedPresetsIfEmpty() {
  try {
    if (localStorage.getItem(LS_KEY) === null) {
      savePresets(BUILTIN_PRESETS);
    }
  } catch {}
}

/**
 * Return a preset by id, or undefined if not found.
 * @param {string} id
 * @returns {PromptPreset | undefined}
 */
export function getPreset(id) {
  return loadPresets().find((p) => p.id === id);
}

/**
 * Append a new preset (assigns a fresh id via crypto.randomUUID).
 * @param {{ name: string, userPrompt: string }} preset
 * @returns {PromptPreset | null} the persisted preset, or null if the write failed
 */
export function addPreset({ name, userPrompt }) {
  const preset = { id: crypto.randomUUID(), name, userPrompt };
  return savePresets([...loadPresets(), preset]) ? preset : null;
}

/**
 * Overwrite an existing preset's fields by id. Unknown ids are a no-op.
 * @param {string} id
 * @param {Partial<Pick<PromptPreset, 'name' | 'userPrompt'>>} updates
 * @returns {boolean} true if the write succeeded
 */
export function updatePreset(id, updates) {
  const list = loadPresets().map((p) =>
    p.id === id ? { ...p, ...updates } : p,
  );
  return savePresets(list);
}

/**
 * Delete a preset by id. Unknown ids are a no-op.
 * @param {string} id
 * @returns {boolean} true if the write succeeded
 */
export function removePreset(id) {
  return savePresets(loadPresets().filter((p) => p.id !== id));
}
