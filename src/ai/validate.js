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
