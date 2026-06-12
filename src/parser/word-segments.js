import { framesToTC } from './srt.js';

/**
 * Build numbered, gap-free sentences directly from WhisperX word timestamps.
 *
 * Engine output (`segments[]` with per-word `start`/`end` in seconds) is the
 * source of truth; this converges on the SAME `Sentence[]` shape that
 * `parseSRT` produces so the exporters and reel editor are unchanged. Each
 * sentence additionally carries its `words[]` (frame-converted) for the S-06
 * word-level trim UI.
 *
 * Sentences are split on terminal punctuation once `minChars` is satisfied, and
 * tiled gap-free: each sentence's `end_frame` equals the next sentence's
 * `start_frame` (the final sentence ends at its last word). Frame math is the
 * canonical `Math.round(seconds * fps)` with no mid-pipeline rounding.
 *
 * @param {{start:number,end:number,text:string,words:{text:string,start:number,end:number,score?:number,speaker?:string}[]}[]} engineSegments
 * @param {number} fps
 * @param {number} minChars
 * @returns {import('../state.js').Sentence[]}
 */
export function segmentFromWords(engineSegments, fps, minChars) {
  // 1. Flatten all words in document order, keeping only timestamped tokens.
  /** @type {{text:string,start:number,end:number}[]} */
  const words = [];
  for (const seg of engineSegments || []) {
    for (const w of seg.words || []) {
      const text = String(w.text ?? '').trim();
      if (!text) continue;
      if (typeof w.start !== 'number' || typeof w.end !== 'number') continue;
      words.push({ text, start: w.start, end: w.end, speaker: w.speaker });
    }
  }
  if (!words.length) return [];

  // 2. Group words into sentences on terminal punctuation (after minChars).
  /** @type {{words:{text:string,start:number,end:number}[]}[]} */
  const groups = [];
  let current = [];
  let currentLen = 0;
  for (const w of words) {
    current.push(w);
    currentLen += w.text.length + 1;
    const endsSentence = /[.?!…]$/.test(w.text);
    if (endsSentence && currentLen >= minChars) {
      groups.push({ words: current });
      current = [];
      currentLen = 0;
    }
  }
  if (current.length) groups.push({ words: current });

  // 3. Frame-convert + tile gap-free. start_frame from the group's first word;
  //    end_frame from the NEXT group's first word (last group ends at its last
  //    word) so consecutive spans never leave a gap.
  const starts = groups.map((g) => Math.round(g.words[0].start * fps));
  const sentences = groups.map((g, i) => {
    const sf = starts[i];
    let ef =
      i < groups.length - 1
        ? starts[i + 1]
        : Math.round(g.words[g.words.length - 1].end * fps);
    if (ef < sf) ef = sf;
    return {
      id: i + 1,
      text: g.words.map((w) => w.text).join(' '),
      start_frame: sf,
      end_frame: ef,
      duration_frame: ef - sf,
      start_tc: framesToTC(sf, fps),
      end_tc: framesToTC(ef, fps),
      words: g.words.map((w) => {
        const word = {
          text: w.text,
          start_frame: Math.round(w.start * fps),
          end_frame: Math.round(w.end * fps),
        };
        // Diarization is opt-in (Phase 6): carry speaker only when present.
        if (w.speaker != null) word.speaker = w.speaker;
        return word;
      }),
    };
  });

  return sentences;
}
