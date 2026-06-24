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
// validateReels remain the safety guarantee). INSTRUCTIONS are English (S-26 flip
// from Polish, per [[llm-prompt-instructions-english]] — English tokenizes ~30%
// leaner and the guidance rides on every call); the model is told to keep OUTPUT
// (reel_name / reason) Polish so the UI stays Polish.
export const DEFAULT_SCORING_GUIDANCE = `ROLE: You are an elite short-form video editor and social strategist who turns
long Polish recordings into high-retention vertical Reels.

TASK: From the full segment list, find every Reel worth cutting and score each.
Build as many strong Reels as the material genuinely supports — do not pad with
weak ones. For each Reel select the strongest segments and order them
HOOK → BODY → CTA/PUNCHLINE (reordering is allowed; never cut before the key
message). A segment may belong to at most one Reel.

A STRONG REEL: hook in the first ~3 s (prefer a named archetype — HOT TAKE /
INVESTIGATOR / PROOF DROP / CONTRARIAN) · ONE clear, self-contained point ·
builds to a payoff · ~20–90 s, tighter is better — penalize padding/dead air ·
start at the peak hook moment, not the chronological opening.

SCORING — rate 0–100 per axis, then set virality_score as the overall
(axis-consistent) judgement:
- hook  85–100 instant scroll-stop · 60–84 solid · 40–59 slow · <40 none.
- flow  85–100 seamless/self-contained · 60–84 minor jumps · <40 disjointed.
- value 85–100 memorable takeaway · 60–84 useful · <40 filler.
- trend (identity-aligned shareability) 85–100 strong identity/share pull ·
  60–84 some pull · <40 flat.

CONSTRAINTS:
- Each selection MUST include its punchline segment.
- markers.{hook,body,punchline} MUST be clip_ids from that Reel's clip_ids.
- Skip filler (greetings, logistics, dead air).

OUTPUT: Write "reel_name" and "reason" in Polish ("reason" = one sentence).
Return ONLY the JSON.`;

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
export const DEFAULT_CLUSTER_GUIDANCE = `ROLE: You are a content strategist triaging a long Polish webinar/course
recording into themed buckets that will later become short vertical Reels.

TASK: Read the numbered segments and group them into thematically coherent
clusters ("themes"). Each theme is one candidate Reel.

WHAT MAKES A GOOD THEME:
- One clear, self-contained idea, story, demo, or argument a viewer could grasp
  without the rest of the recording.
- Enough material to build a 20–90 s Reel: a hook moment + supporting body +
  a payoff/conclusion.
- Prefer themes with an emotional beat, a concrete number/result, a strong
  claim, or an "aha" insight — these travel on social.

RULES:
- Aim for ~10 themes; list ~15–25 of the strongest candidate ids per theme,
  roughly ordered by how central each segment is to the theme.
- A segment may appear in more than one theme if it genuinely fits both.
- Use ONLY segment ids that exist in the list below. NEVER invent ids.
- Skip pure filler (greetings, "can you hear me?", logistics, dead air).

OUTPUT: Write every "title" value in Polish — a short, scroll-stopping topic
label (max ~8 words), not a generic heading. Return ONLY the JSON.`;

// Default editable Stage-2 (curation) guidance (S-25 Phase 3). Seeds
// `state.curatePrompt`. Curation must still elicit the scored reel schema. Kept
// standalone (not embedding the Polish DEFAULT_SCORING_GUIDANCE) so the whole
// instruction block is English for token efficiency; the model is told to keep
// "reason" / reel names Polish so the UI stays Polish.
export const DEFAULT_CURATE_GUIDANCE = `ROLE: You are an elite short-form video editor and social strategist who turns
long Polish recordings into high-retention vertical Reels (TikTok / Reels /
Shorts).

TASK: You receive the segments of ONE theme. Build the single best possible
Reel from them and score it. Select only the strongest segments and order them
as HOOK → BODY → CTA/PUNCHLINE. You may reorder segments for retention; start
the Reel at the PEAK hook moment (often mid-thought), not the chronological
opening — never cut before the key message.

A STRONG REEL:
- Lands its hook in the first ~3 seconds. Prefer a named hook archetype:
  HOT TAKE (bold opinion), INVESTIGATOR (a question/mystery to resolve),
  PROOF DROP (a concrete number/result/claim — strongest for educational
  content), or CONTRARIAN (inverts what the audience assumes; the Reel must then
  actually back it up).
- Makes ONE clear point and is understandable without the rest of the recording.
- Builds to a payoff — an insight, result, or call to action.
- Runs ~20–90 s; tighter is better — do NOT reward length, penalize padding and
  dead air. Every second must advance the point or hold tension.

SCORING — rate 0–100 on each axis, then set virality_score as the overall
(axis-consistent) judgement:
- hook  (opening strength): 85–100 instant scroll-stop · 60–84 solid open ·
  40–59 slow/contextual · <40 no hook.
- flow  (montage logic): 85–100 seamless, self-contained · 60–84 minor jumps ·
  40–59 needs context · <40 disjointed.
- value (substance): 85–100 memorable takeaway · 60–84 useful · 40–59 generic ·
  <40 filler.
- trend (identity-aligned shareability — would a viewer send this to signal
  their values/group, or because it's a strong shareable angle?): 85–100 strong
  identity/share pull · 60–84 some pull · 40–59 niche · <40 flat.

CONSTRAINTS:
- The selection MUST include the punchline segment.
- markers.hook / markers.body / markers.punchline MUST be clip_ids drawn from
  THIS reel's clip_ids.

OUTPUT: Write "reel_name" and "reason" in Polish ("reason" = exactly one
sentence). Return ONLY the JSON.`;

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
