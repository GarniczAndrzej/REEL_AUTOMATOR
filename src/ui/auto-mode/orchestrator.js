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
import { stripExt } from '../../util/filename.js';
import { runAnalysis } from '../step2-analyze.js';
import {
  transcribeDocument,
  whisperAdvancedArgs,
  alignToWords,
} from '../import/transcribe.js';
import { loadSRTContent, renderSegments } from '../import/segments.js';
import {
  showPanel,
  hidePanel,
  updateStage,
  showOpenFolder,
} from './progress-panel.js';
import { generateEDL } from '../../exporters/edl.js';
import { generateXML } from '../../exporters/xml.js';
import { generateLua } from '../../exporters/lua.js';
import {
  generateTranscriptVTT,
  generateWordJSON,
  generateSegmentsMd,
} from '../../exporters/transcript.js';
import { buildSrtContent } from './srt-mode.js';
import { transcriptBase } from '../export-srt.js';
import {
  saveTextToPath,
  pickFolder,
  saveTextToFolder,
} from '../../util/save-file.js';

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
 * Drive the loaded document through the configured pipeline (S-07 Phase 3). Only
 * the stages ticked in `state.autoMode.stages` run; deselected stages are marked
 * "Pominięto". Branches on the input: a loaded video transcribes (+segments) when
 * Transkrypcja is selected; otherwise the loaded transcript is used (aligning to
 * audio when a video is available). When Eksport is selected, the chosen outputs
 * are written at the end. Auto-advance is free — each state mutation + emit()
 * reveals the next surface section.
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
  const stages = state.autoMode.stages;

  autoRunning = true;
  state.autoMode.running = true;
  state.autoMode.activeStage = null;
  emit();

  // Reveal the unified non-blocking panel and bind cancel routing to this run's
  // controller. The legacy inline surfaces stay hidden for the whole run.
  showPanel({ controller });

  try {
    const hasVideo = !!state._whisperVideoPath;
    if (stages.transcription && hasVideo) {
      const ok = await runTranscriptionStage(controller);
      if (!ok) return; // cancelled / failed upstream — nothing to analyse
    } else if (state.srtContent || state.sentences.length) {
      // Transcription skipped (deselected, or no video loaded): use the already
      // loaded transcript. Align to audio when a video is available for word
      // timings; otherwise proceed straight to the next selected stage.
      updateStage('transcribe', {
        status: 'skipped',
        percent: 0,
        label: stages.transcription ? 'Brak wideo' : 'Pominięto',
      });
      if (stages.segmentation && (state._whisperVideoPath || state.videoPath)) {
        setActiveStage(controller, 'align');
        updateStage('segment', {
          status: 'running',
          label: 'Dopasowanie do audio…',
        });
        await alignToWords();
      }
      updateStage('segment', {
        status: stages.segmentation ? 'done' : 'skipped',
        label: stages.segmentation
          ? state.sentences.length + ' segmentów'
          : 'Pominięto',
      });
    } else {
      hidePanel();
      toast('Najpierw wczytaj wideo lub plik SRT.', 'error');
      return;
    }

    // ── AI analysis stage ──────────────────────────────────────────────
    if (stages.analysis) {
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
      // A cancelled AI stage keeps already-committed buckets (S-25) but should
      // not auto-export a partial run — stop here.
      if (controller.aiController.signal.aborted) {
        updateStage('analyze', {
          status: 'error',
          percent: 100,
          label: 'Anulowano',
        });
        toast('Anulowano', 'info');
        return;
      }
      updateStage('analyze', {
        status: state.reelsData.length ? 'done' : 'error',
        percent: 100,
        label: state.reelsData.length
          ? state.reelsData.length + ' reelsów'
          : 'Brak reelsów',
      });
    } else {
      updateStage('analyze', { status: 'skipped', label: 'Pominięto' });
    }

    // ── Export stage ────────────────────────────────────────────────────
    if (stages.export) {
      await runExportStage(controller);
    } else {
      updateStage('export', { status: 'skipped', label: 'Pominięto' });
    }
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

/**
 * Export stage: build the selected outputs from the live document and write
 * them. Write policy (avoids a dialog-per-file): a single selected output uses
 * one native save dialog (`saveTextToPath`); two or more prompt once for a
 * folder (`pickFolder`) then write each file via `saveTextToFolder`.
 * @param {AutoRunController} controller
 * @returns {Promise<void>}
 */
async function runExportStage(controller) {
  setActiveStage(controller, 'export');
  updateStage('export', {
    status: 'running',
    label: 'Przygotowanie plików…',
    percent: 0,
  });

  const items = collectOutputs();
  if (!items.length) {
    updateStage('export', {
      status: 'error',
      label: 'Brak plików do zapisania',
    });
    toast('Brak plików do zapisania.', 'info');
    return;
  }

  if (items.length === 1) {
    const saved = await saveTextToPath({
      defaultName: items[0].name,
      content: items[0].content,
    });
    updateStage('export', {
      status: saved ? 'done' : 'error',
      percent: 100,
      label: saved ? 'Zapisano 1 plik' : 'Anulowano',
    });
    if (saved) toast('Zapisano plik', 'success');
    return;
  }

  const folder = await pickFolder();
  if (!folder) {
    updateStage('export', { status: 'error', label: 'Anulowano' });
    return;
  }
  let ok = 0;
  for (let i = 0; i < items.length; i++) {
    const done = await saveTextToFolder({
      folder,
      name: items[i].name,
      content: items[i].content,
    });
    if (done) ok++;
    updateStage('export', {
      status: 'running',
      percent: ((i + 1) / items.length) * 100,
      label: `${i + 1}/${items.length}`,
    });
  }
  updateStage('export', {
    status: ok === items.length ? 'done' : 'error',
    percent: 100,
    label: `Zapisano ${ok} z ${items.length}`,
  });
  if (ok) showOpenFolder(folder);
  toast(
    `Zapisano ${ok} z ${items.length} plików`,
    ok === items.length ? 'success' : 'info',
  );
}

/**
 * Build the `{name, content}` list for every selected output whose precondition
 * is met (text outputs need segments; timeline outputs need reels). Pure read of
 * the live document — used by single-video export this phase.
 * @returns {{name:string, content:string}[]}
 */
function collectOutputs() {
  const o = state.autoMode.outputs;
  const items = [];
  const tBase = transcriptBase();
  const vBase = videoBase();
  const haveSeg = state.sentences.length > 0;
  const haveReels = state.reelsData.length > 0;

  if (o.srt && haveSeg)
    items.push({
      name: tBase + '.srt',
      content: buildSrtContent(state.sentences, state.fps),
    });
  if (o.vtt && haveSeg)
    items.push({
      name: tBase + '.vtt',
      content: generateTranscriptVTT(state.sentences, state.fps),
    });
  if (o.md && haveSeg)
    items.push({ name: vBase + '_segmenty.md', content: buildSegmentsMd() });
  if (o.wordJson && haveSeg)
    items.push({
      name: tBase + '.words.json',
      content: generateWordJSON(state.sentences, state.fps),
    });
  if (o.edl && haveReels)
    items.push({ name: vBase + '_timeline.edl', content: genEDL() });
  if (o.xml && haveReels)
    items.push({ name: vBase + '_timeline.xml', content: genXML() });
  if (o.lua && haveReels) {
    const lua = genLua();
    if (lua != null) items.push({ name: vBase + '_davinci.lua', content: lua });
  }
  return items;
}

// ── per-format generators (mirror export-popover, fed from live `state`) ──────

function genEDL() {
  return generateEDL({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    gapFrames: state.gapFrames,
    videoFilename: state.videoFilename || 'source_video.mp4',
    mergeThreshold: state.mergeThreshold,
  });
}

function genXML() {
  const videoFile = state.videoFilename || 'source_video.mp4';
  return generateXML({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    videoFilename: videoFile,
    videoPath: state.videoPath || videoFile,
    videoResolution: state.videoResolution,
    projectName: state.projectName,
    mergeThreshold: state.mergeThreshold,
  });
}

function genLua() {
  if (!state.videoPath) {
    toast('Pomijam Lua: brak ścieżki wideo.', 'info');
    return null;
  }
  return generateLua({
    reelsData: state.reelsData,
    sentences: state.sentences,
    fps: state.fps,
    gapFrames: state.gapFrames,
    videoPath: state.videoPath,
    projectName: state.projectName,
    mergeThreshold: state.mergeThreshold,
  });
}

/**
 * Build the segment-listing `.md` from the live document via the shared pure
 * `generateSegmentsMd` (Phase 4 extracted it; batch reuses the same builder).
 * @returns {string}
 */
function buildSegmentsMd() {
  return generateSegmentsMd(state.sentences, state.fps, state.srtName);
}

/** Filename stem derived from the source video (matches export-popover). */
function videoBase() {
  return stripExt(state.videoFilename || 'reels');
}
