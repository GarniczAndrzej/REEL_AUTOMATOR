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

function transcriptBase() {
  return (state.srtName || 'transkrypcja').replace(/\.(srt|vtt)$/i, '');
}

/**
 * Save the transcript as `.srt`, honoring the word-by-word toggle.
 * Mode OFF → sentence-level. Mode ON → per-word, auto-aligning first when no
 * frame-level word timing exists yet (heavy ~37–67s cold spawn, behind an
 * ask() confirmation). Every abort path surfaces a Polish toast — never silent.
 * @returns {Promise<void>}
 */
export async function exportTranscriptSrt() {
  if (!state.sentences.length) {
    toast('Brak transkrypcji do eksportu.', 'info');
    return;
  }
  // Mode OFF → sentence-level .srt (unchanged behavior).
  if (!state.whisperAdvanced.wordLevelSrtExport) {
    const saved = await saveTextToPath({
      defaultName: transcriptBase() + '.srt',
      content: generateTranscriptSRT(state.sentences, state.fps),
    });
    if (saved) toast('Zapisano transkrypcję ✓', 'success');
    return;
  }
  // Mode ON → word-by-word .srt. Needs frame-based words[]; auto-align when
  // missing (heavy, ~37–67s cold spawn) only when a video is loaded.
  if (!hasFrameWords()) {
    const videoPath = state.videoPath || state._whisperVideoPath;
    if (!videoPath) {
      toast(
        'Najpierw wybierz plik wideo, aby dopasować napisy do audio.',
        'info',
      );
      return;
    }
    const { alignToWords } = await import('./import/transcribe.js');
    const ok = await alignToWords({ confirm: true });
    if (!ok) return; // declined/cancelled/failed — alignToWords already surfaced why
    if (!hasFrameWords()) {
      // Align finished but produced no frame-level word timing — previously this
      // returned silently. Tell the user why no per-word file was written.
      toast(
        'Dopasowanie nie wygenerowało słów na poziomie ramek — eksport słowo-po-słowie niemożliwy.',
        'info',
      );
      return;
    }
  }
  const saved = await saveTextToPath({
    defaultName: transcriptBase() + '.srt',
    content: generateWordSRT(state.sentences, state.fps),
  });
  if (saved) toast('Zapisano napisy słowo-po-słowie ✓', 'success');
}
