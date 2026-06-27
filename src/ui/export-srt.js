// Shared transcript-SRT export decision (S-20). Both SRT export buttons route
// through here so the word-by-word toggle behaves identically from either entry
// point: the import-section "⬇ Eksport .srt" (transcribe.js) and the export
// popover "⬇ Transkrypcja .srt" (export-popover.js). Keeping the word/sentence +
// auto-align + Polish-feedback logic in one place stops the two paths drifting.
//
// `alignToWords` lives in import/transcribe.js, which also wires a button to this
// module — so it is pulled in via dynamic import (only when an align is actually
// needed) to avoid a static import cycle.

import { state } from '../state.js';
import { toast } from './toast.js';
import { saveTextToPath } from '../util/save-file.js';
import {
  generateTranscriptSRT,
  generateWordSRT,
} from '../exporters/transcript.js';

// True when at least one sentence carries a word with finite frame timing —
// i.e. frame-normalized word data the word exporter can actually emit.
function hasFrameWords() {
  return state.sentences.some(
    (s) =>
      Array.isArray(s.words) &&
      s.words.some(
        (w) => Number.isFinite(w.start_frame) && Number.isFinite(w.end_frame),
      ),
  );
}

/**
 * Default filename stem for transcript exports — the loaded SRT/VTT name minus
 * its extension, or a Polish fallback. Shared with export-popover.js (VTT).
 * @returns {string}
 */
export function transcriptBase() {
  return (state.srtName || 'transkrypcja').replace(/\.(srt|vtt)$/i, '');
}

/**
 * Build the transcript SRT honoring the word-by-word toggle — the single source
 * of the word-vs-sentence decision, shared by the file `.srt` export and the
 * Mode C Resolve subtitle push so neither silently degrades to phrases when
 * word-by-word is on. Mode OFF → sentence-level. Mode ON → per-word, auto-aligning
 * first when no frame-level word timing exists yet (heavy ~37–67s cold spawn,
 * behind an ask() confirmation). Returns the SRT string, or `null` when the
 * export should abort — every abort path surfaces a Polish toast, never silent.
 * @returns {Promise<{ content: string, wordLevel: boolean } | null>}
 */
export async function buildTranscriptSrt() {
  if (!state.sentences.length) {
    toast('Brak transkrypcji do eksportu.', 'info');
    return null;
  }
  // Mode OFF → sentence-level .srt.
  if (!state.whisperAdvanced.wordLevelSrtExport) {
    return {
      content: generateTranscriptSRT(state.sentences, state.fps),
      wordLevel: false,
    };
  }
  // Mode ON → word-by-word .srt. Needs frame-based words[]; auto-align when
  // missing (heavy, ~37–67s cold spawn) only when a video is loaded. We never
  // fall through to sentence-level here — word-by-word means word-by-word.
  if (!hasFrameWords()) {
    const videoPath = state.videoPath || state._whisperVideoPath;
    if (!videoPath) {
      toast(
        'Najpierw wybierz plik wideo, aby dopasować napisy do audio.',
        'info',
      );
      return null;
    }
    const { alignToWords } = await import('./import/transcribe.js');
    const ok = await alignToWords({ confirm: true });
    if (!ok) return null; // declined/cancelled/failed — alignToWords surfaced why
    if (!hasFrameWords()) {
      // Align finished but produced no frame-level word timing.
      toast(
        'Dopasowanie nie wygenerowało słów na poziomie ramek — eksport słowo-po-słowie niemożliwy.',
        'info',
      );
      return null;
    }
  }
  return {
    content: generateWordSRT(state.sentences, state.fps),
    wordLevel: true,
  };
}

/**
 * Save the transcript as `.srt`, honoring the word-by-word toggle (see
 * {@link buildTranscriptSrt}).
 * @returns {Promise<void>}
 */
export async function exportTranscriptSrt() {
  const built = await buildTranscriptSrt();
  if (!built) return;
  const saved = await saveTextToPath({
    defaultName: transcriptBase() + '.srt',
    content: built.content,
  });
  if (saved) {
    toast(
      built.wordLevel
        ? 'Zapisano napisy słowo-po-słowie'
        : 'Zapisano transkrypcję',
      'success',
    );
  }
}
