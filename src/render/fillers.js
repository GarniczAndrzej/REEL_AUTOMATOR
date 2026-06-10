// Pure fillers — always safe to strip (hesitation sounds, non-words)
export const ALWAYS_FILLERS = new Set([
  'yyy',
  'yyyy',
  'yyyyy',
  'yyyyyy',
  'eee',
  'eeee',
  'eeeee',
  'eh',
  'eeh',
  'uhm',
  'um',
  'ym',
  'ymm',
  'hmm',
  'hm',
  'aha',
  'aa',
  'aaa',
  'aaaa',
  'oj',
  'ojej',
  'ooo',
  'kurde',
]);

// Context-dependent fillers — may be content words; require explicit opt-in to strip
export const CONTEXT_FILLERS = new Set([
  'no',
  'noo',
  'nooo',
  'wiesz',
  'wiecie',
  'taki',
  'taka',
  'takie',
  'taką',
  'takiego',
  'tego',
  'tej',
  'znaczy',
  'prawda',
  'jakby',
  'jakieś',
  'jakiś',
  'właśnie',
]);

export const POLISH_FILLERS = new Set([...ALWAYS_FILLERS, ...CONTEXT_FILLERS]);

export function isFiller(word, useContextFillers = false) {
  const w = word.toLowerCase().replace(/^[,.!?…\s]+|[,.!?…\s]+$/g, '');
  return ALWAYS_FILLERS.has(w) || (useContextFillers && CONTEXT_FILLERS.has(w));
}

// Given merged spans from mergeAdjacentClips, expand into micro-spans that skip
// filler words. Gracefully falls back to the full span when no words[] are present.
export function expandSpansWithFillerRemoval(mergedSpans, sentences, fps) {
  const out = [];
  for (const span of mergedSpans) {
    let hasAnyWords = false;
    const micro = [];
    let openStart = null;
    let openEnd = null;

    for (const id of span.ids) {
      const s = sentences.find((x) => x.id === id);
      if (!s) continue;
      if (!s.words || !s.words.length) {
        if (openStart === null) openStart = s.start_frame / fps;
        openEnd = s.end_frame / fps;
        continue;
      }
      hasAnyWords = true;
      // Emit any pending no-words span before mixing in word timestamps
      if (openStart !== null) {
        if (openEnd > openStart)
          micro.push({ in_s: openStart, out_s: openEnd });
        openStart = null;
        openEnd = null;
      }
      for (const w of s.words) {
        if (isFiller(w.text)) {
          if (openStart !== null && openEnd > openStart) {
            micro.push({ in_s: openStart, out_s: openEnd });
          }
          openStart = null;
          openEnd = null;
        } else {
          if (openStart === null) openStart = w.start;
          openEnd = w.end;
        }
      }
    }
    if (openStart !== null && openEnd > openStart)
      micro.push({ in_s: openStart, out_s: openEnd });

    const si = span.source_idx ?? 0;
    if (!hasAnyWords || !micro.length) {
      out.push({
        in_s: span.start_frame / fps,
        out_s: span.end_frame / fps,
        source_idx: si,
      });
    } else {
      out.push(...micro.map((m) => ({ ...m, source_idx: si })));
    }
  }
  return out;
}
