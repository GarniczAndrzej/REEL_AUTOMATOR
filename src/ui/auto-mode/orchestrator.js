// Auto-mode orchestrator (S-07, Phase 1). Sequences the existing pipeline stages
// for the loaded document — Transcription (video) | Align (imported SRT) → AI
// analysis — awaiting each, mutating `state` + `emit()`ing so the
// render-on-change surface auto-advances (no manual show/hide). Holds one
// AutoRunController that tracks the live stage and routes a per-stage cancel to
// the correct primitive (`cancel_transcription` for transcription;
// `AbortController.abort()` for AI). Progress reuses the existing inline surfaces
// this phase; the unified floating panel arrives in Phase 2.

import { state, emit } from '../../state.js';
import { toast } from '../toast.js';
import { getApiKey } from '../../ai/api-key.js';
import { runAnalysis } from '../step2-analyze.js';
import {
  transcribeDocument,
  whisperAdvancedArgs,
  alignToWords,
} from '../import/transcribe.js';
import { loadSRTContent, renderSegments } from '../import/segments.js';

// Top-level run guard: only one auto-pipeline at a time. The individual stages
// have their own guards, but a second LAUNCH must be rejected, not parallelised.
let autoRunning = false;

/**
 * Routes a per-stage cancel to the live stage's primitive and tracks which stage
 * is active. In Phase 1 the AI cancel is also reachable via the existing
 * run⇄stop analyze button (it aborts the same controller) and the transcription
 * cancel via the legacy `#cancelTranscribeBtn`; the unified per-stage cancel
 * buttons arrive with the Phase 2 panel.
 */
export class AutoRunController {
  constructor() {
    /** @type {string|null} */
    this.activeStage = null;
    /** @type {AbortController|null} */
    this.aiController = null;
  }

  /** @param {string} stageId @returns {Promise<void>} */
  async cancelStage(stageId) {
    if (stageId === 'transcribe') {
      // Upstream cancel aborts the whole run — downstream stages have no input.
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('cancel_transcription');
      } catch (e) {
        /* best-effort; the driver poll-loop reaps on the next tick */
      }
    } else if (stageId === 'analyze') {
      // AI cancel reuses S-25 partial-commit (completed buckets are kept).
      if (this.aiController) this.aiController.abort();
    }
  }
}

// Phase 1 reuses the inline WhisperX progress box for the transcription stage
// (Phase 2 swaps in the unified panel). Pure DOM, tolerant of missing nodes.
function showWhisperProgress(label, percent) {
  const box = document.getElementById('whisperProgressBox');
  if (box) box.style.display = 'block';
  const labelEl = document.getElementById('whisperProgressLabel');
  if (labelEl) labelEl.textContent = label;
  const fill = document.getElementById('whisperProgressFill');
  if (fill) fill.style.width = Math.round(percent) + '%';
}
function hideWhisperProgressSoon() {
  const box = document.getElementById('whisperProgressBox');
  if (box) setTimeout(() => (box.style.display = 'none'), 2000);
}

/** @param {AutoRunController} controller @param {string|null} stageId */
function setActiveStage(controller, stageId) {
  controller.activeStage = stageId;
  state.autoMode.activeStage = stageId;
  emit();
}

/**
 * Drive the loaded document through the fixed Phase-1 pipeline. Branches on the
 * input: a loaded video transcribes (+segments); an imported SRT skips
 * transcription and aligns when a video is available, else goes straight to
 * analysis. Then runs the AI analysis stage. Auto-advance is free — each state
 * mutation + emit() reveals the next surface section.
 * @param {{ controller?: AutoRunController }} [opts]
 * @returns {Promise<void>}
 */
export async function runAutoPipeline(opts = {}) {
  if (autoRunning) {
    toast('Bieg automatyczny już trwa.', 'info');
    return;
  }
  const controller = opts.controller || new AutoRunController();
  const apiKey = getApiKey('openrouter');

  autoRunning = true;
  state.autoMode.running = true;
  state.autoMode.activeStage = null;
  emit();

  try {
    const hasVideo = !!state._whisperVideoPath;
    if (hasVideo) {
      const ok = await runTranscriptionStage(controller);
      if (!ok) return; // cancelled / failed upstream — nothing to analyse
    } else if (state.srtContent || state.sentences.length) {
      // Imported-SRT branch: align to audio when a video is available for word
      // timings; otherwise proceed straight to analysis.
      if (state._whisperVideoPath || state.videoPath) {
        setActiveStage(controller, 'align');
        await alignToWords();
      }
    } else {
      toast('Najpierw wczytaj wideo lub plik SRT.', 'error');
      return;
    }

    // ── AI analysis stage ──────────────────────────────────────────────
    setActiveStage(controller, 'analyze');
    controller.aiController = new AbortController();
    await runAnalysis({ apiKey, signal: controller.aiController.signal });
  } finally {
    autoRunning = false;
    state.autoMode.running = false;
    state.autoMode.activeStage = null;
    controller.activeStage = null;
    emit();
  }
}

/**
 * Transcription stage: gather the Step-1 WhisperX settings, honour
 * `state.diarize` with token-absent degradation, run `transcribeDocument`, then
 * write its result into `state` + emit() (the surface reveals the review
 * section). Returns false on cancel / failure / empty result so the caller
 * aborts the run.
 * @param {AutoRunController} controller
 * @returns {Promise<boolean>}
 */
async function runTranscriptionStage(controller) {
  setActiveStage(controller, 'transcribe');

  // Diarization degradation: honour state.diarize, but skip (with a toast) when
  // no HF token is present rather than failing the whole run.
  let diarize = !!state.diarize;
  const hfToken = getApiKey('huggingface');
  if (diarize && !hfToken) {
    diarize = false;
    toast('Pomijam diaryzację: brak tokenu HuggingFace.', 'info');
  }

  // Surface the legacy cancel button for the transcription stage (Phase 1).
  const cancelBtn = document.getElementById('cancelTranscribeBtn');
  if (cancelBtn) cancelBtn.style.display = '';
  showWhisperProgress('Inicjalizacja…', 0);

  try {
    const result = await transcribeDocument(
      {
        videoPath: state._whisperVideoPath,
        modelId: state.modelId,
        language: state.whisperLanguage || 'pl',
        diarize,
        hfToken,
        fps: state.fps,
        ...whisperAdvancedArgs(),
      },
      { onProgress: showWhisperProgress },
    );

    loadSRTContent(result.srtContent, result.srtName);
    state.sentences = result.sentences;
    state._pendingWhisperWords = result.sentences.length ? null : result.words;
    renderSegments();
    const segs = document.getElementById('statusSegs');
    if (segs) segs.textContent = state.sentences.length;
    const card = document.getElementById('segmentsCard');
    if (card && state.sentences.length) card.style.display = 'block';
    showWhisperProgress('Gotowe! SRT wczytany.', 100);
    hideWhisperProgressSoon();
    emit();

    if (!state.sentences.length) {
      toast(
        'Transkrypcja nie zwróciła segmentów — przerwano bieg automatyczny.',
        'error',
      );
      return false;
    }
    return true;
  } catch (e) {
    const msg = String(e);
    if (msg.includes('ANULOWANO')) {
      showWhisperProgress('Anulowano transkrypcję.', 0);
      hideWhisperProgressSoon();
      toast('Anulowano', 'info');
    } else {
      showWhisperProgress('Błąd: ' + e, 0);
      toast('Transkrypcja nieudana: ' + e, 'error');
    }
    return false;
  } finally {
    if (cancelBtn) cancelBtn.style.display = 'none';
  }
}
