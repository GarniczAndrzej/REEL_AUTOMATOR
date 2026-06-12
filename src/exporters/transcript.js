// Transcript exporters — pure functions of (sentences, fps) → string.
// No DOM, no state import, no I/O (per the exporter rule), so regression tests
// stay simple. `.srt` optionally embeds word-level timing as a comment block
// when sentences carry words[].

/**
 * Format a frame count as an SRT/VTT timestamp.
 * @param {number} frames
 * @param {number} fps
 * @param {string} sep - millisecond separator (',' for SRT, '.' for VTT)
 * @returns {string}
 */
function frameToStamp(frames, fps, sep) {
  const totalMs = Math.round((Math.max(0, frames) / fps) * 1000);
  const ms = totalMs % 1000;
  const s = Math.floor(totalMs / 1000) % 60;
  const m = Math.floor(totalMs / 60000) % 60;
  const h = Math.floor(totalMs / 3600000);
  const p2 = (n) => String(n).padStart(2, '0');
  return `${p2(h)}:${p2(m)}:${p2(s)}${sep}${String(ms).padStart(3, '0')}`;
}

/**
 * Generate a valid, round-trippable `.srt` transcript from sentences. By
 * default the output is clean caption text (re-imports cleanly via `parseSRT`).
 * Pass `{includeWords:true}` to additionally append a non-standard
 * `NOTE WORDS:` line (per-word `text@start-end` in frames) for tooling — this
 * embeds word timing at the cost of standard re-import. Word-level data is also
 * durably persisted in the `.reelproj` (v4) regardless of this flag.
 * @param {import('../state.js').Sentence[]} sentences
 * @param {number} fps
 * @param {{includeWords?: boolean}} [opts]
 * @returns {string}
 */
export function generateTranscriptSRT(sentences, fps, opts = {}) {
  const includeWords = opts.includeWords === true;
  const out = [];
  sentences.forEach((s, i) => {
    out.push(String(i + 1));
    out.push(
      `${frameToStamp(s.start_frame, fps, ',')} --> ${frameToStamp(s.end_frame, fps, ',')}`,
    );
    out.push(s.text);
    if (includeWords && Array.isArray(s.words) && s.words.length) {
      const words = s.words
        .map((w) => `${w.text}@${w.start_frame}-${w.end_frame}`)
        .join(' ');
      out.push(`NOTE WORDS: ${words}`);
    }
    out.push('');
  });
  return out.join('\n');
}

/**
 * Generate a `.vtt` transcript from sentences.
 * @param {import('../state.js').Sentence[]} sentences
 * @param {number} fps
 * @returns {string}
 */
export function generateTranscriptVTT(sentences, fps) {
  const out = ['WEBVTT', ''];
  sentences.forEach((s, i) => {
    out.push(String(i + 1));
    out.push(
      `${frameToStamp(s.start_frame, fps, '.')} --> ${frameToStamp(s.end_frame, fps, '.')}`,
    );
    out.push(s.text);
    out.push('');
  });
  return out.join('\n');
}
