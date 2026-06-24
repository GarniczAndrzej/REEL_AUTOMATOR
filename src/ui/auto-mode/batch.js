// Auto-mode batch queue (S-07, Phase 4). Processes N videos sequentially in a
// headless mode that writes each video's selected outputs to ONE folder picked
// once at start — without ever touching the single-document surface. Each video
// is driven through the same callable units the single-video orchestrator uses
// (`transcribeDocument` → `analyzeSentences`), but into LOCAL `sentences`/`reels`
// (no `commitReels`, no document-field `emit()`), so the live document is left
// untouched. Transcription is sequential by necessity: `transcribe_video` has one
// global progress event + one global cancel reaper, so concurrency is impossible.
// All strings are Polish.

import { state, emit } from '../../state.js';
import { toast } from '../toast.js';
import { getApiKey } from '../../ai/api-key.js';
import {
  transcribeDocument,
  whisperAdvancedArgs,
} from '../import/transcribe.js';
import { analyzeSentences } from '../step2-analyze.js';
import {
  generateTranscriptVTT,
  generateWordJSON,
  generateSegmentsMd,
} from '../../exporters/transcript.js';
import { buildSrtContent } from './srt-mode.js';
import { generateEDL } from '../../exporters/edl.js';
import { generateXML } from '../../exporters/xml.js';
import { generateLua } from '../../exporters/lua.js';
import { pickFolder, saveTextToFolder } from '../../util/save-file.js';
import { showPanel, updateStage, showOpenFolder } from './progress-panel.js';

// Top-level batch guard, symmetric with the orchestrator's single-run guard. A
// second launch while a batch (or single run) is live is rejected, not parallelised.
let batchRunning = false;

// Accepted video container extensions. The native picker filters to these, but
// we re-check on add because a drag, a typed path, or a screenshot temp file can
// still slip a non-video in — and `transcribe_video` would then hard-fail mid-run.
const VIDEO_EXTS = ['mp4', 'mov', 'mkv', 'm4v', 'webm', 'avi', 'mpg', 'mpeg'];

/** @param {string} path @returns {boolean} true when the path is a video file. */
function isVideoPath(path) {
  const ext = (path.split('.').pop() || '').toLowerCase();
  return VIDEO_EXTS.includes(ext);
}

/**
 * Per-batch cancel router (mirrors the orchestrator's AutoRunController). The
 * panel's per-stage cancel button calls `cancelStage(stageId)`; a transcription
 * cancel reaps the live `transcribe_video` (rejects with ANULOWANO), an AI cancel
 * aborts the current video's analysis. Either stops the WHOLE batch (Phase 4
 * default: upstream-cancel semantics — already-written files remain).
 */
class BatchController {
  constructor() {
    /** @type {string|null} */
    this.stage = null;
    /** @type {AbortController|null} */
    this.aiController = null;
  }
  /** @param {string} stageId @returns {Promise<void>} */
  async cancelStage(stageId) {
    if (stageId === 'transcribe') {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('cancel_transcription');
      } catch (e) {
        /* best-effort; the driver poll-loop reaps on the next tick */
      }
    } else if (stageId === 'analyze') {
      if (this.aiController) this.aiController.abort();
    }
  }
}

/**
 * Open the native multi-file picker and append the chosen videos to the batch
 * queue (de-duplicated by path). No-op while a run is live.
 * @returns {Promise<void>}
 */
export async function addVideosToBatch() {
  if (state.autoMode.running) return;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({
      multiple: true,
      filters: [
        {
          name: 'Wideo',
          extensions: ['mp4', 'mov', 'mkv', 'm4v', 'webm', 'avi'],
        },
      ],
    });
    if (!picked) return;
    const paths = Array.isArray(picked) ? picked : [picked];
    let added = 0;
    const rejected = [];
    for (const p of paths) {
      if (!isVideoPath(p)) {
        rejected.push(p.split('/').pop().split('\\').pop());
        continue;
      }
      if (state.autoMode.batchQueue.some((v) => v.path === p)) continue;
      const name = p.split('/').pop().split('\\').pop();
      state.autoMode.batchQueue.push({ path: p, name, status: 'pending' });
      added++;
    }
    if (rejected.length) {
      toast(`Pominięto pliki (nie wideo): ${rejected.join(', ')}`, 'info');
    }
    if (added) emit();
  } catch (e) {
    toast('Nie udało się dodać wideo: ' + e, 'error');
  }
}

/** @param {number} idx Remove one video from the queue. No-op while running. */
export function removeFromBatch(idx) {
  if (state.autoMode.running) return;
  state.autoMode.batchQueue.splice(idx, 1);
  emit();
}

/** Clear the whole queue. No-op while running. @returns {void} */
export function clearBatch() {
  if (state.autoMode.running) return;
  state.autoMode.batchQueue = [];
  emit();
}

/**
 * Run the batch: pick a folder once, then process each queued video end-to-end
 * (transcribe → optional analyze → write selected outputs) into that folder,
 * sequentially. The single-document surface is never mutated. A per-stage cancel
 * stops the whole batch (already-written files remain).
 * @returns {Promise<void>}
 */
export async function runBatch() {
  if (state.autoMode.running || batchRunning) {
    toast('Bieg automatyczny już trwa.', 'info');
    return;
  }
  const queue = state.autoMode.batchQueue;
  if (!queue.length) {
    toast('Dodaj przynajmniej jedno wideo do kolejki.', 'info');
    return;
  }
  if (!state.modelId) {
    toast('Najpierw wybierz model transkrypcji (Whisper).', 'info');
    return;
  }

  const o = state.autoMode.outputs;
  const wantText = o.srt || o.vtt || o.md || o.wordJson;
  const wantTimeline = o.edl || o.xml || o.lua;
  if (!wantText && !wantTimeline) {
    toast('Zaznacz przynajmniej jeden plik wyjściowy.', 'info');
    return;
  }
  const apiKey = getApiKey('openrouter');
  // Timeline outputs need reels → analysis must run, which needs a key.
  const needAnalysis = wantTimeline;
  if (needAnalysis && !apiKey) {
    toast('Brak klucza OpenRouter — wymagany do wyjść osi czasu.', 'info');
    return;
  }

  // Pick the destination folder ONCE (save-location rule: nothing auto-dumps).
  const folder = await pickFolder();
  if (!folder) return;
  state.autoMode.batchFolder = folder;

  // Diarization degradation (computed once for the whole batch): honour
  // state.diarize but skip when no HF token rather than failing every video.
  let diarize = !!state.diarize;
  const hfToken = getApiKey('huggingface');
  if (diarize && !hfToken) {
    diarize = false;
    toast('Pomijam diaryzację: brak tokenu HuggingFace.', 'info');
  }

  const controller = new BatchController();
  batchRunning = true;
  state.autoMode.running = true;
  state.autoMode.activeStage = null;
  queue.forEach((v) => (v.status = 'pending'));
  emit();

  showPanel({ controller });

  let written = 0;
  let cancelled = false;
  try {
    for (let i = 0; i < queue.length; i++) {
      const video = queue[i];
      video.status = 'running';
      emit();
      resetStageRows();
      controller.stage = 'transcribe';
      state.autoMode.activeStage = 'transcribe';
      updateStage('transcribe', {
        status: 'running',
        percent: 0,
        label: `${i + 1}/${queue.length}: ${video.name}`,
      });

      // ── Transcription (+ word-driven segmentation) ──────────────────────
      let result;
      try {
        result = await transcribeDocument(
          {
            videoPath: video.path,
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
      } catch (e) {
        const msg = String(e);
        if (msg.includes('ANULOWANO')) {
          cancelled = true;
          video.status = 'error';
          updateStage('transcribe', { status: 'error', label: 'Anulowano' });
          break;
        }
        video.status = 'error';
        updateStage('transcribe', { status: 'error', label: 'Błąd: ' + e });
        toast(`Transkrypcja „${video.name}” nieudana: ${e}`, 'error');
        emit();
        continue; // skip this video, keep going with the rest of the queue
      }

      const sentences = result.sentences;
      updateStage('transcribe', {
        status: 'done',
        percent: 100,
        label: 'Gotowe',
      });
      updateStage('segment', {
        status: 'done',
        label: sentences.length + ' segmentów',
      });
      if (!sentences.length) {
        video.status = 'error';
        updateStage('segment', { status: 'error', label: 'Brak segmentów' });
        toast(`„${video.name}”: brak segmentów — pominięto.`, 'info');
        emit();
        continue;
      }

      // ── AI analysis (only when a timeline output is requested) ───────────
      let reels = [];
      if (needAnalysis) {
        controller.stage = 'analyze';
        state.autoMode.activeStage = 'analyze';
        controller.aiController = new AbortController();
        updateStage('analyze', {
          status: 'running',
          label: 'Analiza AI…',
          percent: 0,
        });
        reels = await analyzeSentences({
          sentences,
          apiKey,
          signal: controller.aiController.signal,
          onProgress: ({ label, percent }) =>
            updateStage('analyze', { status: 'running', label, percent }),
        });
        if (controller.aiController.signal.aborted) {
          cancelled = true;
          video.status = 'error';
          updateStage('analyze', { status: 'error', label: 'Anulowano' });
          break;
        }
        updateStage('analyze', {
          status: reels.length ? 'done' : 'error',
          percent: 100,
          label: reels.length ? reels.length + ' reelsów' : 'Brak reelsów',
        });
      } else {
        updateStage('analyze', { status: 'skipped', label: 'Pominięto' });
      }

      // ── Export: write the selected outputs into the chosen folder ───────
      controller.stage = 'export';
      state.autoMode.activeStage = 'export';
      const items = buildBatchItems({
        sentences,
        reels,
        videoPath: video.path,
        videoName: video.name,
        fps: state.fps,
      });
      updateStage('export', {
        status: 'running',
        label: 'Zapis plików…',
        percent: 0,
      });
      let ok = 0;
      for (let j = 0; j < items.length; j++) {
        const done = await saveTextToFolder({
          folder,
          name: items[j].name,
          content: items[j].content,
        });
        if (done) {
          ok++;
          written++;
        }
        updateStage('export', {
          status: 'running',
          percent: items.length ? ((j + 1) / items.length) * 100 : 100,
          label: `${ok}/${items.length}`,
        });
      }
      updateStage('export', {
        status: ok === items.length ? 'done' : 'error',
        percent: 100,
        label: `Zapisano ${ok} z ${items.length}`,
      });
      video.status = 'done';
      emit();
    }
  } finally {
    batchRunning = false;
    state.autoMode.running = false;
    state.autoMode.activeStage = null;
    controller.stage = null;
    emit();
  }

  // Offer to open the destination folder once any file landed (even a cancelled
  // batch may have written earlier videos — those files remain).
  if (written) showOpenFolder(folder);

  if (cancelled) {
    toast('Bieg wsadowy anulowany.', 'info');
  } else {
    toast(
      `Bieg wsadowy zakończony — zapisano ${written} plików.`,
      written ? 'success' : 'info',
    );
  }
}

/** Reset all four stage rows to pending between videos. @returns {void} */
function resetStageRows() {
  for (const id of ['transcribe', 'segment', 'analyze', 'export']) {
    updateStage(id, { status: 'pending', percent: 0, label: '' });
  }
}

/**
 * Build the `{name, content}` output list for ONE video from its local
 * `sentences`/`reels` (never the live `state` document). Text outputs always
 * emit; timeline outputs need reels. Filenames key off the source video name so
 * batch outputs never collide across videos.
 * @param {{ sentences:import('../../state.js').Sentence[], reels:import('../../state.js').Reel[], videoPath:string, videoName:string, fps:number }} ctx
 * @returns {{name:string, content:string}[]}
 */
function buildBatchItems({ sentences, reels, videoPath, videoName, fps }) {
  const o = state.autoMode.outputs;
  const base = stripExt(videoName);
  const haveReels = reels.length > 0;
  const items = [];

  if (o.srt)
    items.push({
      name: base + '.srt',
      content: buildSrtContent(sentences, fps),
    });
  if (o.vtt)
    items.push({
      name: base + '.vtt',
      content: generateTranscriptVTT(sentences, fps),
    });
  if (o.md)
    items.push({
      name: base + '_segmenty.md',
      content: generateSegmentsMd(sentences, fps, videoName),
    });
  if (o.wordJson)
    items.push({
      name: base + '.words.json',
      content: generateWordJSON(sentences, fps),
    });
  if (o.edl && haveReels)
    items.push({
      name: base + '_timeline.edl',
      content: generateEDL({
        reelsData: reels,
        sentences,
        fps,
        gapFrames: state.gapFrames,
        videoFilename: videoName,
        mergeThreshold: state.mergeThreshold,
      }),
    });
  if (o.xml && haveReels)
    items.push({
      name: base + '_timeline.xml',
      content: generateXML({
        reelsData: reels,
        sentences,
        fps,
        videoFilename: videoName,
        videoPath,
        videoResolution: state.videoResolution,
        projectName: state.projectName,
        mergeThreshold: state.mergeThreshold,
      }),
    });
  if (o.lua && haveReels)
    items.push({
      name: base + '_davinci.lua',
      content: generateLua({
        reelsData: reels,
        sentences,
        fps,
        gapFrames: state.gapFrames,
        videoPath,
        projectName: state.projectName,
        mergeThreshold: state.mergeThreshold,
      }),
    });
  return items;
}

/** @param {string} name @returns {string} filename stem (extension stripped). */
function stripExt(name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  return base || 'reels';
}
