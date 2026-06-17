const formatSentence = (s) => ({
  id: s.id,
  text: s.text,
  start_tc: s.start_tc,
  end_tc: s.end_tc,
  duration_frames: s.duration_frame,
});

// Machine-owned response-format example. ALWAYS injected by buildStaticBlock,
// independent of userPrompt / systemPrompt — editing prompts can never break the
// export pipeline because the JSON shape + validateReels stay machine-controlled.
const RESPONSE_FORMAT = `OCZEKIWANY FORMAT ODPOWIEDZI — zwróć TYLKO czysty JSON, zero komentarzy, zero markdown:
[
  {
    "reel_name": "Reel 1 - Tytuł tematu",
    "clip_ids": [1, 2, 5, 6],
    "virality_score": 82,
    "scores": { "hook": 85, "flow": 80, "value": 78, "trend": 84 },
    "reason": "Mocny hook i konkretna wartość w jednym zdaniu.",
    "markers": { "hook": 1, "body": 5, "punchline": 6 }
  },
  {
    "reel_name": "Reel 2 - Tytuł tematu",
    "clip_ids": [10, 11, 3],
    "virality_score": 67,
    "scores": { "hook": 70, "flow": 65, "value": 72, "trend": 60 },
    "reason": "Solidna historia, słabszy potencjał trendu.",
    "markers": { "hook": 10, "body": 11, "punchline": 3 }
  }
]`;

// Default editable scoring guidance (FR-015). Seeds `state.systemPrompt`; the
// user can override it in the settings modal. Unlike RESPONSE_FORMAT this is NOT
// machine-owned — emptying it cannot break export (the JSON example + segments +
// validateReels remain the safety guarantee).
export const DEFAULT_SCORING_GUIDANCE = `ZASADY OCENY:
- Oceń każdy Reel 0–100 w czterech osiach: hook (siła wstępu), flow (płynność i logika montażu), value (wartość merytoryczna), trend (potencjał viralowy / dopasowanie do trendów).
- "virality_score" to ogólna ocena 0–100 całego Reela (spójna z osiami).
- Selekcja MUSI zawierać segment z puentą (punchline) — nigdy nie ucinaj materiału przed kluczowym przekazem.
- "reason" to dokładnie jedno zdanie uzasadnienia po polsku.
- "markers.hook", "markers.body", "markers.punchline" to clip_id wybrane z listy "clip_ids" tego Reela (muszą do niej należeć).`;

// Build the "available segments" block (+ multi-source note). Independent of
// userPrompt — part of the cacheable static prefix.
function buildSegmentsSection(sentences, sources, primaryFilename) {
  let segmentsBlock;
  const hasMultipleSources = sources && sources.length > 0;

  if (hasMultipleSources) {
    // Group sentences by source_idx
    const sourceCount = sources.length + 1; // +1 for primary source (idx 0)
    const grouped = Array.from({ length: sourceCount }, () => []);
    for (const s of sentences) {
      const si = s.source_idx ?? 0;
      if (si < grouped.length) grouped[si].push(s);
    }
    const blocks = grouped
      .map((group, si) => {
        const label =
          si === 0
            ? `[ŹRÓDŁO 1]${primaryFilename ? ' — ' + primaryFilename : ''}`
            : `[ŹRÓDŁO ${si + 1}]${sources[si - 1]?.videoFilename ? ' — ' + sources[si - 1].videoFilename : ''}`;
        return `${label}\n${JSON.stringify(group.map(formatSentence), null, 2)}`;
      })
      .filter((_, si) => grouped[si].length > 0);
    segmentsBlock = blocks.join('\n\n');
  } else {
    segmentsBlock = JSON.stringify(sentences.map(formatSentence), null, 2);
  }

  const multiSourceNote = hasMultipleSources
    ? '\nWAŻNE: Nie łącz segmentów z różnych źródeł w jednym Reelu — każde [ŹRÓDŁO N] to osobny plik wideo.\n'
    : '';

  return { segmentsBlock, multiSourceNote };
}

// The machine-owned static block: multi-source note + segments + response
// format. ALWAYS injected, independent of any editable prompt text — this is the
// export-safety invariant (S-03 FR-015).
function buildStaticBlock(sentences, sources, primaryFilename) {
  const { segmentsBlock, multiSourceNote } = buildSegmentsSection(
    sentences,
    sources,
    primaryFilename,
  );
  return `${multiSourceNote}
DOSTĘPNE SEGMENTY (plik SRT zamieniony na zdania z timecodes):
${segmentsBlock}

${RESPONSE_FORMAT}`;
}

/**
 * String prompt for OpenRouter / download / disk-cache key. Order: editable
 * userPrompt → machine-owned segments + response format → editable scoring
 * guidance (systemPrompt). The response format + segments are always present
 * regardless of prompt text, so export safety never depends on prompt content.
 * @param {string} userPrompt
 * @param {string} systemPrompt scoring guidance (defaults to DEFAULT_SCORING_GUIDANCE)
 * @param {import('../state.js').Sentence[]} sentences
 * @param {Array|null} sources
 * @param {string} primaryFilename
 * @returns {string}
 */
export function buildPrompt(
  userPrompt,
  systemPrompt,
  sentences,
  sources = null,
  primaryFilename = '',
) {
  const guidance = systemPrompt ? `\n\n${systemPrompt}` : '';
  return `${userPrompt}
${buildStaticBlock(sentences, sources, primaryFilename)}${guidance}`;
}
