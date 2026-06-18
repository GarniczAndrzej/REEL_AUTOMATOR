// Import-section submodule: subtitle file load, parse → sentences, segment
// preview, and transcript .md/.json download. Owns the shared helpers
// (MIN_CHARS, renderSegments, mergeWordsIntoSentences, loadSRTContent, escHtml)
// consumed by the sibling import submodules. (S-16 Phase 3a — structural split,
// no behavior change.)

import { state, emit } from '../../state.js';
import { parseSRT, parseVTT } from '../../parser/srt.js';
import { saveTextToPath } from '../../util/save-file.js';
import { syncAlignBtn } from './transcribe.js';

// Minimum sentence length (chars) for SRT/VTT/word segmentation. Formerly a
// rarely-touched UI knob (pruned in S-16, #7) but kept as a module-level
// constant so the parser signatures (`src/parser/*`, no-touch zone) keep
// receiving it.
export const MIN_CHARS = 20;

export function initSegments() {
  const srtFileInput = document.getElementById('srtFile');
  const dropZone = document.getElementById('dropZone');

  srtFileInput.addEventListener('change', () => {
    const f = srtFileInput.files[0];
    if (
      f &&
      (f.name.toLowerCase().endsWith('.srt') ||
        f.name.toLowerCase().endsWith('.vtt'))
    )
      loadSRTFile(f);
  });
  document.getElementById('clearFileBtn').addEventListener('click', clearFile);
  document.getElementById('parseBtn').addEventListener('click', doParseBtn);
  document
    .getElementById('downloadMdBtn')
    .addEventListener('click', downloadMD);
  document
    .getElementById('downloadJsonBtn')
    .addEventListener('click', downloadJSON);

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () =>
    dropZone.classList.remove('drag-over'),
  );
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file && (file.name.endsWith('.srt') || file.name.endsWith('.vtt')))
      loadSRTFile(file);
  });

  // fps / videoFilename / gapFrames inputs live in the settings modal and are
  // owned by settings-modal.js (one component owns its DOM). Not bound here.
}

function loadSRTFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (e) => {
    state.srtContent = e.target.result;
    state.srtName = file.name;
    state._srtIsVtt = file.name.toLowerCase().endsWith('.vtt');
    const vf = file.name.replace(/\.(srt|vtt)$/i, '');
    state.videoFilename = vf;
    document.getElementById('videoFilename').value = vf;
    document.getElementById('dropZone').style.display = 'none';
    document.getElementById('fileLoaded').style.display = 'flex';
    document.getElementById('fileName').textContent = file.name;
    document.getElementById('fileMeta').textContent =
      (file.size / 1024).toFixed(1) + ' KB';
    document.getElementById('parseBtn').disabled = false;
    document.getElementById('statusSrt').textContent = file.name;
    // Reset FPS note in case it was showing a stale warning
    const noteEl = document.getElementById('fpsNote');
    if (noteEl) {
      noteEl.textContent = 'Musi zgadzać się z twoim materiałem wideo!';
      noteEl.style.color = '';
    }
    emit();
  };
  reader.readAsText(file, 'utf-8');
}

function clearFile() {
  state.srtContent = null;
  state.srtName = null;
  state.sentences = [];
  document.getElementById('dropZone').style.display = '';
  document.getElementById('fileLoaded').style.display = 'none';
  document.getElementById('parseBtn').disabled = true;
  document.getElementById('segmentsCard').style.display = 'none';
  document.getElementById('srtFile').value = '';
  document.getElementById('statusSrt').textContent = 'brak';
  const noteEl = document.getElementById('fpsNote');
  if (noteEl) {
    noteEl.textContent = 'Musi zgadzać się z twoim materiałem wideo!';
    noteEl.style.color = '';
  }
  emit();
}

function _parseSubtitle(content, isVtt, fps, minLen) {
  return isVtt
    ? parseVTT(content, fps, minLen)
    : parseSRT(content, fps, minLen);
}

function doParseBtn() {
  if (!state.srtContent) return;

  state.sentences = _parseSubtitle(
    state.srtContent,
    state._srtIsVtt,
    state.fps,
    MIN_CHARS,
  );
  state.sentences.forEach((s) => {
    s.source_idx = 0;
  });

  // Merge Whisper word timestamps into sentences when available (F4)
  if (state._pendingWhisperWords && state._pendingWhisperWords.length) {
    mergeWordsIntoSentences(
      state.sentences,
      state._pendingWhisperWords,
      state.fps,
    );
    state._pendingWhisperWords = null;
  }
  renderSegments();
  document.getElementById('statusSegs').textContent = state.sentences.length;
  document.getElementById('segmentsCard').style.display = 'block';
  // Reset FPS note after successful parse
  const noteEl = document.getElementById('fpsNote');
  if (noteEl) {
    noteEl.textContent = 'Musi zgadzać się z twoim materiałem wideo!';
    noteEl.style.color = '';
  }
  emit();
}

// Assign each Whisper word to its sentence by time overlap (F4)
// Words are only produced for the primary source (source_idx 0).
// The raw WhisperX words arrive in seconds (`{text, start, end, speaker?}`);
// convert them to the frame-based `Word` shape (`{text, start_frame,
// end_frame, speaker?}`) so this align path converges on the SAME shape that
// `segmentFromWords` (the transcribe path) produces — one `Word` shape
// everywhere downstream (exporters, .reelproj round-trip).
export function mergeWordsIntoSentences(sentences, words, fps) {
  for (const s of sentences) {
    if ((s.source_idx ?? 0) !== 0) {
      s.words = [];
      continue;
    }
    const startS = s.start_frame / fps;
    const endS = s.end_frame / fps;
    // Overlap test uses the raw seconds midpoint (±0.15s window), then the
    // matched words are frame-converted before being attached.
    s.words = words
      .filter(
        (w) =>
          (w.start + w.end) / 2 >= startS - 0.15 &&
          (w.start + w.end) / 2 <= endS + 0.15,
      )
      .map((w) => {
        const word = {
          text: w.text,
          start_frame: Math.round(w.start * fps),
          end_frame: Math.round(w.end * fps),
        };
        if (w.speaker != null) word.speaker = w.speaker;
        return word;
      });
  }
}

export function renderSegments() {
  const preview = document.getElementById('segmentsPreview');
  preview.innerHTML = state.sentences
    .map(
      (s) =>
        `<div class="segment-row">
      <div class="seg-id">#${s.id}</div>
      <div class="seg-tc">${escHtml(s.start_tc)}</div>
      <div class="seg-text">${escHtml(s.text)}</div>
    </div>`,
    )
    .join('');
  document.getElementById('segCount').textContent =
    state.sentences.length + ' segmentów';
  // Transcript export lives in the WhisperX card — reveal it once a transcript
  // exists (after transcription, import, or align).
  const exportRow = document.getElementById('whisperExportRow');
  if (exportRow) exportRow.style.display = state.sentences.length ? '' : 'none';
  syncAlignBtn();
}

async function downloadMD() {
  if (!state.sentences.length) return;
  let md = `# Segmenty SRT\n\nPlik: ${state.srtName || 'nieznany'}\nFPS: ${state.fps}\nSegmentów: ${state.sentences.length}\n\n---\n\n`;
  state.sentences.forEach((s) => {
    md += `**#${s.id}** \`${s.start_tc} → ${s.end_tc}\` (${(s.duration_frame / state.fps).toFixed(1)}s)\n\n${s.text}\n\n---\n\n`;
  });
  await saveTextToPath({ defaultName: 'segmenty.md', content: md });
}

async function downloadJSON() {
  if (!state.sentences.length) return;
  await saveTextToPath({
    defaultName: 'segments.json',
    content: JSON.stringify(state.sentences, null, 2),
  });
}

export function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function loadSRTContent(content, name) {
  state.srtContent = content;
  state.srtName = name;
  document.getElementById('dropZone').style.display = 'none';
  document.getElementById('fileLoaded').style.display = 'flex';
  document.getElementById('fileName').textContent = name;
  document.getElementById('fileMeta').textContent =
    (content.length / 1024).toFixed(1) + ' KB';
  document.getElementById('parseBtn').disabled = false;
  document.getElementById('statusSrt').textContent = name;
  emit();
}
