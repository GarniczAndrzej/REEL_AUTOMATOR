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
