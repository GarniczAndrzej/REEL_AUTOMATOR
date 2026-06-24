// Auto-mode orchestrator (S-07, Phase 1+2). Sequences the existing pipeline
// stages for the loaded document — Transcription (video) | Align (imported SRT) →
// AI analysis — awaiting each, mutating `state` + `emit()`ing so the
// render-on-change surface auto-advances (no manual show/hide). Holds one
// AutoRunController that tracks the live stage and routes a per-stage cancel to
// the correct primitive (`cancel_transcription` for transcription;
// `AbortController.abort()` for AI). Phase 2: progress is fed into the unified
// non-blocking floating panel (`progress-panel.js`); the legacy inline surfaces
// are suppressed for the duration of an auto run.

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
import { showPanel, hidePanel, updateStage } from './progress-panel.js';

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

  // Reveal the unified non-blocking panel and bind cancel routing to this run's
  // controller. The legacy inline surfaces stay hidden for the whole run.
  showPanel({ controller });

  try {
    const hasVideo = !!state._whisperVideoPath;
    if (hasVideo) {
      const ok = await runTranscriptionStage(controller);
      if (!ok) return; // cancelled / failed upstream — nothing to analyse
    } else if (state.srtContent || state.sentences.length) {
      // Imported-SRT branch: transcription is skipped; align to audio when a
      // video is available for word timings; otherwise proceed straight to
      // analysis.
      updateStage('transcribe', {
        status: 'done',
        percent: 100,
        label: 'Pominięto (import SRT)',
      });
      if (state._whisperVideoPath || state.videoPath) {
        setActiveStage(controller, 'align');
        updateStage('segment', {
          status: 'running',
          label: 'Dopasowanie do audio…',
        });
        await alignToWords();
      }
      updateStage('segment', {
        status: 'done',
        label: state.sentences.length + ' segmentów',
      });
    } else {
      hidePanel();
      toast('Najpierw wczytaj wideo lub plik SRT.', 'error');
      return;
    }

    // ── AI analysis stage ──────────────────────────────────────────────
    setActiveStage(controller, 'analyze');
    controller.aiController = new AbortController();
    updateStage('analyze', {
      status: 'running',
      label: 'Analiza AI…',
      percent: 0,
    });
    await runAnalysis({
      apiKey,
      signal: controller.aiController.signal,
      onProgress: ({ label, percent }) =>
        updateStage('analyze', { status: 'running', label, percent }),
    });
    // runAnalysis swallows an abort (S-25 keeps already-committed buckets), so
    // success vs cancel is read from whether any reels landed.
    updateStage('analyze', {
      status: state.reelsData.length ? 'done' : 'error',
      percent: 100,
      label: state.reelsData.length
        ? state.reelsData.length + ' reelsów'
        : 'Brak reelsów',
    });
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

  // Per-stage cancel now lives on the panel's transcribe row (routes to
  // cancel_transcription via the controller); the legacy #cancelTranscribeBtn is
  // no longer surfaced for auto runs.
  updateStage('transcribe', {
    status: 'running',
    label: 'Inicjalizacja…',
    percent: 0,
  });

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
      {
        onProgress: (label, percent) =>
          updateStage('transcribe', { status: 'running', label, percent }),
      },
    );

    loadSRTContent(result.srtContent, result.srtName);
    state.sentences = result.sentences;
    state._pendingWhisperWords = result.sentences.length ? null : result.words;
    renderSegments();
    const segs = document.getElementById('statusSegs');
    if (segs) segs.textContent = state.sentences.length;
    const card = document.getElementById('segmentsCard');
    if (card && state.sentences.length) card.style.display = 'block';
    updateStage('transcribe', {
      status: 'done',
      percent: 100,
      label: 'Gotowe',
    });
    updateStage('segment', {
      status: 'done',
      label: state.sentences.length + ' segmentów',
    });
    emit();

    if (!state.sentences.length) {
      updateStage('segment', { status: 'error', label: 'Brak segmentów' });
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
      updateStage('transcribe', { status: 'error', label: 'Anulowano' });
      toast('Anulowano', 'info');
    } else {
      updateStage('transcribe', { status: 'error', label: 'Błąd: ' + e });
      toast('Transkrypcja nieudana: ' + e, 'error');
    }
    return false;
  }
}
