const formatSentence = (s) => ({
  id: s.id,
  text: s.text,
  start_tc: s.start_tc,
  end_tc: s.end_tc,
  duration_frames: s.duration_frame,
});

// Stage-1 (clustering) minified projection (S-25 Phase 5). Thematic clustering
// only needs id + text; the timecodes + duration_frames are export-only fields
// the cluster model never uses. Combined with a no-spacer serialization this
// roughly halves Stage-1 input tokens (~30–40 tok/segment vs ~70–80). The
// single-shot and Stage-2 paths keep the full `formatSentence` projection.
const formatSentenceMin = (s) => ({ id: s.id, text: s.text });

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

// Stage-1 (clustering) machine-owned response-format example. Elicits the
// lightweight `{themes:[{title, candidate_ids[]}]}` shape that `validateThemes`
// (Phase 4) consumes — NOT the scored reel schema. Always injected by the
// cluster static block independent of the editable cluster guidance.
const CLUSTER_RESPONSE_FORMAT = `OCZEKIWANY FORMAT ODPOWIEDZI — zwróć TYLKO czysty JSON, zero komentarzy, zero markdown:
{
  "themes": [
    { "title": "Temat 1 - krótki opis", "candidate_ids": [1, 2, 5, 6, 12] },
    { "title": "Temat 2 - krótki opis", "candidate_ids": [10, 11, 3, 20] }
  ]
}`;

// Default editable Stage-1 clustering guidance (S-25 Phase 3). Seeds
// `state.clusterPrompt`. Like DEFAULT_SCORING_GUIDANCE this is NOT machine-owned —
// the themes JSON example + segments + validateThemes remain the safety guarantee.
// INSTRUCTIONS are in English (per user note) — English tokenizes ~30% leaner
// than Polish, and the instruction block rides on every call. The model is told
// to keep its OUTPUT (titles) Polish, so the UI stays Polish.
export const DEFAULT_CLUSTER_GUIDANCE = `CLUSTERING RULES:
- Group the segments into thematically coherent clusters ("themes") that will later become Reels.
- Each theme is one potential Reel: a concise "title" plus a "candidate_ids" list of the segments that fit it.
- Combine segments that are related in content (same thread, story, concept) — order can be changed at a later stage.
- Aim for ~10 themes; ~15–25 of the strongest candidates per theme.
- Use ONLY existing segment ids from the list below. Never invent ids.
- Write each "title" value in Polish.`;

// Default editable Stage-2 (curation) guidance (S-25 Phase 3). Seeds
// `state.curatePrompt`. Curation must still elicit the scored reel schema. Kept
// standalone (not embedding the Polish DEFAULT_SCORING_GUIDANCE) so the whole
// instruction block is English for token efficiency; the model is told to keep
// "reason" / reel names Polish so the UI stays Polish.
export const DEFAULT_CURATE_GUIDANCE = `SCORING RULES:
- Score each Reel 0–100 on four axes: hook (opening strength), flow (editing smoothness and logic), value (substantive value), trend (viral potential / trend fit).
- "virality_score" is the overall 0–100 score for the whole Reel (consistent with the axes).
- The selection MUST contain the punchline segment — never cut the material before the key message.
- "reason" is exactly one sentence, written in Polish.
- "markers.hook", "markers.body", "markers.punchline" are clip_ids chosen from this Reel's "clip_ids" (they must belong to it).
- Write "reel_name" and "reason" in Polish.

CURATION RULE:
- You receive the segments of a single theme (cluster). Build the best possible Reel from them (HOOK → BODY → CTA), selecting only the strongest segments.`;

// Build the "available segments" block (+ multi-source note). Independent of
// userPrompt — part of the cacheable static prefix. `formatter` selects the
// segment projection (full `formatSentence` by default; `formatSentenceMin` for
// the Stage-1 cluster path) and `spacer` is the `JSON.stringify` indent (2 for
// pretty single-shot/curate output, 0 for the compact cluster serialization).
function buildSegmentsSection(
  sentences,
  sources,
  primaryFilename,
  formatter = formatSentence,
  spacer = 2,
) {
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
        return `${label}\n${JSON.stringify(group.map(formatter), null, spacer)}`;
      })
      .filter((_, si) => grouped[si].length > 0);
    segmentsBlock = blocks.join('\n\n');
  } else {
    segmentsBlock = JSON.stringify(sentences.map(formatter), null, spacer);
  }

  const multiSourceNote = hasMultipleSources
    ? '\nWAŻNE: Nie łącz segmentów z różnych źródeł w jednym Reelu — każde [ŹRÓDŁO N] to osobny plik wideo.\n'
    : '';

  return { segmentsBlock, multiSourceNote };
}

// The machine-owned static block: multi-source note + segments + response
// format. ALWAYS injected, independent of any editable prompt text — this is the
// export-safety invariant (S-03 FR-015). `responseFormat` selects the scored
// reel schema (default) or the Stage-1 themes schema (cluster path).
function buildStaticBlock(
  sentences,
  sources,
  primaryFilename,
  responseFormat = RESPONSE_FORMAT,
  formatter = formatSentence,
  spacer = 2,
) {
  const { segmentsBlock, multiSourceNote } = buildSegmentsSection(
    sentences,
    sources,
    primaryFilename,
    formatter,
    spacer,
  );
  return `${multiSourceNote}
DOSTĘPNE SEGMENTY (plik SRT zamieniony na zdania z timecodes):
${segmentsBlock}

${responseFormat}`;
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

/**
 * Stage-1 clustering prompt (S-25 Phase 3). Same structure as `buildPrompt` but
 * injects the themes RESPONSE_FORMAT so the model returns
 * `{themes:[{title, candidate_ids[]}]}` instead of scored reels. Stage-1 uses
 * the minified `{id, text}` projection serialized without indent (S-25 Phase 5)
 * — thematic clustering needs no timecodes/durations — roughly halving input
 * tokens vs the full single-shot projection.
 * @param {string} userPrompt
 * @param {string} clusterGuidance editable cluster guidance (defaults to DEFAULT_CLUSTER_GUIDANCE)
 * @param {import('../state.js').Sentence[]} sentences
 * @param {Array|null} sources
 * @param {string} primaryFilename
 * @returns {string}
 */
export function buildClusterPrompt(
  userPrompt,
  clusterGuidance,
  sentences,
  sources = null,
  primaryFilename = '',
) {
  const guidance = clusterGuidance ? `\n\n${clusterGuidance}` : '';
  return `${userPrompt}
${buildStaticBlock(sentences, sources, primaryFilename, CLUSTER_RESPONSE_FORMAT, formatSentenceMin, 0)}${guidance}`;
}

/**
 * Stage-2 curation prompt (S-25 Phase 3). Elicits the existing scored reel
 * schema (byte-identical to `buildPrompt`'s RESPONSE_FORMAT) over a single
 * theme bucket's segments. In Phase 4 callers pass only that bucket's subset.
 * @param {string} userPrompt
 * @param {string} curateGuidance editable curate guidance (defaults to DEFAULT_CURATE_GUIDANCE)
 * @param {import('../state.js').Sentence[]} sentences
 * @param {Array|null} sources
 * @param {string} primaryFilename
 * @returns {string}
 */
export function buildCuratePrompt(
  userPrompt,
  curateGuidance,
  sentences,
  sources = null,
  primaryFilename = '',
) {
  const guidance = curateGuidance ? `\n\n${curateGuidance}` : '';
  return `${userPrompt}
${buildStaticBlock(sentences, sources, primaryFilename)}${guidance}`;
}
