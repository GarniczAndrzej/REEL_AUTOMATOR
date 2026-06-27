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
 * Generate a word-by-word `.srt` — one cue per spoken word, for karaoke-style
 * Reels/TikTok captions. Timing rules (S-19, gapless fill-forward): the cue
 * start is pinned to the word's real audio onset (`start_frame`) and never
 * moved — so every cue lines up with speech. Each cue is then held forward
 * (to the right) until the NEXT word's onset, leaving no gap between cues: a
 * word stays on screen until the following word is actually spoken. The final
 * word has no successor to fill toward, so it keeps its own end with a 4-frame
 * floor. If a successor's onset is at or before the current word's start
 * (overlapping/diarized timing), the end is clamped to the start so the cue is
 * never reversed. Words are flattened in global order across sentence
 * boundaries, so fill respects real audio adjacency. Speaker labels are never
 * emitted. Pure function.
 * @param {import('../state.js').Sentence[]} sentences
 * @param {number} fps
 * @returns {string}
 */
export function generateWordSRT(sentences, fps) {
  const FLOOR_FRAMES = 4;
  const words = [];
  sentences.forEach((s) => {
    if (!Array.isArray(s.words)) return;
    s.words.forEach((w) => {
      if (
        typeof w.start_frame === 'number' &&
        typeof w.end_frame === 'number' &&
        Number.isFinite(w.start_frame) &&
        Number.isFinite(w.end_frame)
      ) {
        words.push(w);
      }
    });
  });
  const out = [];
  words.forEach((w, i) => {
    const start = w.start_frame;
    const next = words[i + 1];
    // Gapless fill-forward: hold this cue until the next word's onset (clamped
    // to `start` so an overlapping successor can't reverse the cue). The last
    // word has no successor, so it keeps its own end with the 4-frame floor.
    const end = next
      ? Math.max(start, next.start_frame)
      : Math.max(w.end_frame, start + FLOOR_FRAMES);
    out.push(String(i + 1));
    out.push(
      `${frameToStamp(start, fps, ',')} --> ${frameToStamp(end, fps, ',')}`,
    );
    out.push(w.text);
    out.push('');
  });
  return out.join('\n');
}

/**
 * Generate a word-level timing JSON from sentences — a machine-readable dump of
 * each segment plus its per-word frame timings (when present). Pure function;
 * stable shape for downstream tooling and the auto-mode "słowo-JSON" output.
 * @param {import('../state.js').Sentence[]} sentences
 * @param {number} fps
 * @returns {string}
 */
export function generateWordJSON(sentences, fps) {
  return JSON.stringify(
    {
      fps,
      sentences: sentences.map((s) => ({
        id: s.id,
        text: s.text,
        start_frame: s.start_frame,
        end_frame: s.end_frame,
        words: Array.isArray(s.words) ? s.words : [],
      })),
    },
    null,
    2,
  );
}

/**
 * Build the human-readable segment-listing `.md` for a transcript — one entry
 * per sentence with its timecode span, duration and text. Pure function (no DOM,
 * no state), so the export popover, the single-video auto-mode export, and the
 * Phase-4 batch all share one builder and a regression case can pin the output.
 * Output is byte-identical to the previous inline `export-popover.js` builder.
 * @param {import('../state.js').Sentence[]} sentences
 * @param {number} fps
 * @param {string} [srtName] - source file name shown in the header
 * @returns {string}
 */
export function generateSegmentsMd(sentences, fps, srtName) {
  let md = `# Segmenty SRT\n\nPlik: ${srtName || 'nieznany'}\nFPS: ${fps}\nSegmentów: ${sentences.length}\n\n---\n\n`;
  sentences.forEach((s) => {
    md += `**#${s.id}** \`${s.start_tc} → ${s.end_tc}\` (${(s.duration_frame / fps).toFixed(1)}s)\n\n${s.text}\n\n---\n\n`;
  });
  return md;
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
