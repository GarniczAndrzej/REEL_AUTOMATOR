// Shared validate-before-use gate (FR-018) for every reel-ingest path. Pure,
// no DOM. Throws an Error with a descriptive Polish message on hard failure;
// missing scored fields are NOT failures (backward-compat).

const AXES = ['hook', 'flow', 'value', 'trend'];
const MARKER_KEYS = ['hook', 'body', 'punchline'];

function isInteger(n) {
  return typeof n === 'number' && Number.isInteger(n);
}

/**
 * Validate parsed LLM/JSON reel data against the available transcript.
 * @param {unknown} parsed - the JSON.parse result to validate
 * @param {import('../state.js').Sentence[]} sentences - state.sentences
 * @returns {import('../state.js').Reel[]} the validated array (same reference)
 * @throws {Error} Polish message naming the offending reel/field
 */
export function validateReels(parsed, sentences) {
  if (!Array.isArray(parsed)) {
    throw new Error('Oczekiwano tablicy JSON [] na najwyższym poziomie.');
  }
  if (!parsed.length) {
    throw new Error('Tablica reelsów jest pusta.');
  }

  const knownIds = new Set(sentences.map((s) => s.id));

  parsed.forEach((reel, i) => {
    const where = `Reel ${i + 1}`;
    if (!reel || typeof reel !== 'object') {
      throw new Error(`${where}: oczekiwano obiektu reela.`);
    }
    if (typeof reel.reel_name !== 'string' || !reel.reel_name.trim()) {
      throw new Error(`${where}: brak nazwy (reel_name).`);
    }
    if (!Array.isArray(reel.clip_ids) || !reel.clip_ids.length) {
      throw new Error(
        `${where} "${reel.reel_name}": clip_ids musi być niepustą tablicą.`,
      );
    }
    for (const id of reel.clip_ids) {
      if (!isInteger(id)) {
        throw new Error(
          `${where} "${reel.reel_name}": clip_ids zawiera nie-całkowitą wartość (${id}).`,
        );
      }
      if (!knownIds.has(id)) {
        throw new Error(
          `${where} "${reel.reel_name}": clip_id ${id} nie istnieje w transkrypcji.`,
        );
      }
    }

    // ── Scored fields — validated only when present ──────────────────
    if (reel.virality_score !== undefined) {
      const v = reel.virality_score;
      if (typeof v !== 'number' || v < 0 || v > 100) {
        throw new Error(
          `${where} "${reel.reel_name}": virality_score musi być liczbą 0–100.`,
        );
      }
    }
    if (reel.scores !== undefined) {
      if (!reel.scores || typeof reel.scores !== 'object') {
        throw new Error(
          `${where} "${reel.reel_name}": scores musi być obiektem.`,
        );
      }
      for (const axis of AXES) {
        if (
          reel.scores[axis] !== undefined &&
          typeof reel.scores[axis] !== 'number'
        ) {
          throw new Error(
            `${where} "${reel.reel_name}": scores.${axis} musi być liczbą.`,
          );
        }
      }
    }
    if (reel.reason !== undefined && typeof reel.reason !== 'string') {
      throw new Error(`${where} "${reel.reel_name}": reason musi być tekstem.`);
    }
    if (reel.markers !== undefined) {
      if (!reel.markers || typeof reel.markers !== 'object') {
        throw new Error(
          `${where} "${reel.reel_name}": markers musi być obiektem.`,
        );
      }
      const clipSet = new Set(reel.clip_ids);
      for (const key of MARKER_KEYS) {
        const m = reel.markers[key];
        if (m === undefined) continue;
        if (!isInteger(m)) {
          throw new Error(
            `${where} "${reel.reel_name}": markers.${key} musi być całkowitym clip_id.`,
          );
        }
        if (!clipSet.has(m)) {
          throw new Error(
            `${where} "${reel.reel_name}": markers.${key} (${m}) nie należy do clip_ids tego reela.`,
          );
        }
      }
    }
  });

  return parsed;
}

/**
 * Validate the Stage-1 cluster shape `{themes:[{title, candidate_ids[]}]}` (S-25
 * Phase 4) and drop hallucinated ids against the real segment set before buckets
 * are built. Separate from `validateReels` — raw clusters carry no `reel_name`
 * and would be rejected by it. Structural failures throw (Polish message); stray
 * ids are dropped silently (don't throw on a hallucinated id).
 * @param {unknown} parsed - the JSON.parse result to validate
 * @param {import('../state.js').Sentence[]} sentences - state.sentences
 * @returns {{title: string, candidate_ids: number[]}[]} validated, id-filtered themes
 * @throws {Error} Polish message on structural failure
 */
export function validateThemes(parsed, sentences) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(
      'Oczekiwano obiektu JSON { "themes": [...] } na najwyższym poziomie.',
    );
  }
  const themes = parsed.themes;
  if (!Array.isArray(themes) || !themes.length) {
    throw new Error('Pole "themes" musi być niepustą tablicą.');
  }

  const knownIds = new Set(sentences.map((s) => s.id));
  const out = [];

  themes.forEach((theme, i) => {
    const where = `Temat ${i + 1}`;
    if (!theme || typeof theme !== 'object') {
      throw new Error(`${where}: oczekiwano obiektu tematu.`);
    }
    if (typeof theme.title !== 'string' || !theme.title.trim()) {
      throw new Error(`${where}: brak tytułu (title).`);
    }
    if (!Array.isArray(theme.candidate_ids)) {
      throw new Error(
        `${where} "${theme.title}": candidate_ids musi być tablicą.`,
      );
    }
    // Keep only known integer ids; drop unknown/non-integer (hallucinated) and
    // dedupe so bucket prompts hash deterministically. A theme that ends up with
    // zero valid ids is dropped entirely (not an error).
    const seen = new Set();
    const validIds = theme.candidate_ids.filter((id) => {
      if (!isInteger(id) || !knownIds.has(id) || seen.has(id)) return false;
      seen.add(id);
      return true;
    });
    if (!validIds.length) return;
    out.push({ title: theme.title, candidate_ids: validIds });
  });

  if (!out.length) {
    throw new Error(
      'Żaden temat nie zawiera prawidłowych identyfikatorów segmentów.',
    );
  }
  return out;
}
