import { state, emit, subscribe } from '../state.js';
import { buildPrompt } from '../ai/prompt.js';
import { callGemini, callClaude, callOpenRouter } from '../ai/providers.js';
import { getApiKey } from '../ai/api-key.js';
import { withLlmCache, clearLlmCache } from '../ai/cache.js';
import { framesToTC } from '../parser/srt.js';
import { isFiller } from '../selection/fillers.js';
import {
  loadWaveform,
  drawWaveform,
  cachedPeaks,
  invalidateWaveform,
} from '../selection/waveform.js';
import {
  drawTimeline,
  frameFromX,
  reelSourceSpan,
} from '../selection/timeline.js';

// ── Undo / redo (F16 — covers reelsData, sentences) ────────────────────

const undoStack = [];
const redoStack = [];

export function snap() {
  return {
    reelsData: state.reelsData.map((r) => ({
      ...r,
      clip_ids: [...r.clip_ids],
    })),
    sentences: state.sentences.map((s) => ({ ...s })),
  };
}

export function pushUndo(before) {
  undoStack.push(before);
  redoStack.length = 0;
  if (undoStack.length > 50) undoStack.shift();
}

export function undo() {
  if (!undoStack.length) return;
  redoStack.push(snap());
  const prev = undoStack.pop();
  state.reelsData = prev.reelsData;
  state.sentences = prev.sentences;
  renderReels();
  emit();
}

export function redo() {
  if (!redoStack.length) return;
  undoStack.push(snap());
  const next = redoStack.pop();
  state.reelsData = next.reelsData;
  state.sentences = next.sentences;
  renderReels();
  emit();
}

// ── Timeline / preview state ────────────────────────────────────────

const playheadState = new Map(); // reelIdx → current playhead frame (source)
let activeReelIdx = null; // reel that owns the preview video
let previewVideoEl = null;
let isDraggingTimeline = false;
let cachedAssetUrl = '';

// ── Drag state ─────────────────────────────────────────────────────

let dragSrc = null;

// ── F14 — focused clip ─────────────────────────────────────────────

let focusedClip = null; // { reelIdx, clipIdx, sentenceId }

function setFocusedClip(reelIdx, clipIdx, sentenceId) {
  focusedClip = { reelIdx, clipIdx, sentenceId };
  document
    .querySelectorAll('.clip-row.focused')
    .forEach((el) => el.classList.remove('focused'));
  const row = document.querySelector(
    `.clip-row[data-reel-idx="${reelIdx}"][data-clip-idx="${clipIdx}"]`,
  );
  if (row) row.classList.add('focused');
}

// ── Trim state ─────────────────────────────────────────────────────

let trimState = null;
let trimWarnShown = false;

// ── Mutations ──────────────────────────────────────────────────────

function moveClip(srcReel, srcIdx, dstReel, dstBefore) {
  // No-op check
  if (srcReel === dstReel) {
    const adjusted = srcIdx < dstBefore ? dstBefore - 1 : dstBefore;
    if (adjusted === srcIdx) return;
  }
  const before = snap();
  const srcIds = state.reelsData[srcReel].clip_ids;
  const dstIds = state.reelsData[dstReel].clip_ids;
  const [id] = srcIds.splice(srcIdx, 1);
  let at = dstBefore;
  if (srcReel === dstReel && srcIdx < dstBefore) at--;
  dstIds.splice(Math.max(0, at), 0, id);
  pushUndo(before);
  renderReels();
  emit();
}

function removeClip(reelIdx, clipIdx) {
  const before = snap();
  state.reelsData[reelIdx].clip_ids.splice(clipIdx, 1);
  pushUndo(before);
  renderReels();
  emit();
}

function mergeWithNext(reelIdx, clipIdx) {
  const reel = state.reelsData[reelIdx];
  if (!reel) return;
  const id1 = reel.clip_ids[clipIdx];
  const id2 = reel.clip_ids[clipIdx + 1];
  if (id1 == null || id2 == null) return;
  const s1 = state.sentences.find((x) => x.id === id1);
  const s2 = state.sentences.find((x) => x.id === id2);
  if (!s1 || !s2) return;
  const before = snap();
  s1.text = s1.text + ' ' + s2.text;
  s1.end_frame = s2.end_frame;
  s1.end_tc = framesToTC(s1.end_frame, state.fps);
  s1.duration_frame = s1.end_frame - s1.start_frame;
  reel.clip_ids.splice(clipIdx + 1, 1);
  invalidateWaveform(id1);
  pushUndo(before);
  renderReels();
  emit();
}

function applyTrim(sentenceId, side, newFrame) {
  invalidateWaveform(sentenceId);
  const s = state.sentences.find((x) => x.id === sentenceId);
  if (!s) return;
  const fps = state.fps;
  if (side === 'start') {
    s.start_frame = Math.max(0, Math.min(newFrame, s.end_frame - 1));
    s.start_tc = framesToTC(s.start_frame, fps);
  } else {
    s.end_frame = Math.max(s.start_frame + 1, newFrame);
    s.end_tc = framesToTC(s.end_frame, fps);
  }
  s.duration_frame = s.end_frame - s.start_frame;
  renderReels();
  emit();
}

// ── Timeline helpers ───────────────────────────────────────────────

function frameToDisplayTime(frame, fps) {
  const secs = frame / fps;
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  const ms = Math.round((secs % 1) * 1000);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

function showPreviewPanel() {
  const panel = document.getElementById('previewPanel');
  if (panel) panel.style.display = 'block';
}

function hidePreviewPanel() {
  const panel = document.getElementById('previewPanel');
  if (panel) panel.style.display = 'none';
  if (previewVideoEl) previewVideoEl.pause();
}

function updatePreviewPanelSize() {
  if (!previewVideoEl) return;
  previewVideoEl.style.width = '320px';
  previewVideoEl.style.height = '180px';
}

async function updatePreviewVideoSrc() {
  if (!previewVideoEl || !state.videoPath) return;
  try {
    const { convertFileSrc } = await import('@tauri-apps/api/core');
    const url = convertFileSrc(state.videoPath);
    if (cachedAssetUrl !== url) {
      cachedAssetUrl = url;
      previewVideoEl.src = url;
      previewVideoEl.load();
    }
  } catch {
    // Not in Tauri context or asset protocol unavailable — video preview disabled
  }
}

function seekToFrame(ri, frame) {
  const reel = state.reelsData[ri];
  if (!reel) return;

  playheadState.set(ri, frame);
  activeReelIdx = ri;

  // Redraw this reel's timeline
  const canvas = document.querySelector(
    `.reel-timeline[data-reel-idx="${ri}"]`,
  );
  if (canvas) drawTimeline(canvas, reel, state.sentences, state.fps, frame);

  // Update tc display
  const tc = document.querySelector(`.tl-tc[data-reel-idx="${ri}"]`);
  if (tc) tc.textContent = frameToDisplayTime(frame, state.fps);

  // Seek video (readyState ≥ 1 means metadata loaded)
  if (previewVideoEl && previewVideoEl.readyState >= 1) {
    try {
      previewVideoEl.currentTime = frame / state.fps;
    } catch {}
  }

  showPreviewPanel();
}

function updateGapColors(ri) {
  const reel = state.reelsData[ri];
  if (!reel) return;
  const threshold = reel.mergeThreshold ?? state.mergeThreshold;
  document
    .querySelectorAll(`.clip-gap[data-reel-idx="${ri}"]`)
    .forEach((gap) => {
      const gapFrames = +gap.dataset.gapFrames;
      const willMerge = gapFrames <= threshold;
      gap.classList.toggle('will-merge', willMerge);
      gap.classList.toggle('separate', !willMerge);
      const label = gap.querySelector('.clip-gap-label');
      if (label) {
        label.textContent =
          gapFrames <= 0
            ? '0 kl. — scalony'
            : willMerge
              ? `${gapFrames} kl. — będzie scalony`
              : `${gapFrames} kl. — osobny span`;
      }
    });
}

function drawAllTimelines() {
  const list = document.getElementById('reelsList');
  list.querySelectorAll('.reel-timeline[data-reel-idx]').forEach((canvas) => {
    const ri = +canvas.dataset.reelIdx;
    const reel = state.reelsData[ri];
    if (!reel || !reel.clip_ids.length) return;
    const w = canvas.clientWidth;
    if (w > 0 && canvas.width !== w) canvas.width = w;
    drawTimeline(
      canvas,
      reel,
      state.sentences,
      state.fps,
      playheadState.get(ri),
    );
  });
}

function initPreviewVideo() {
  previewVideoEl = document.getElementById('previewVideo');
  if (!previewVideoEl) return;

  updatePreviewPanelSize();

  previewVideoEl.addEventListener('timeupdate', () => {
    if (activeReelIdx === null) return;
    const frame = Math.round(previewVideoEl.currentTime * state.fps);
    playheadState.set(activeReelIdx, frame);

    const canvas = document.querySelector(
      `.reel-timeline[data-reel-idx="${activeReelIdx}"]`,
    );
    const reel = state.reelsData[activeReelIdx];
    if (canvas && reel)
      drawTimeline(canvas, reel, state.sentences, state.fps, frame);

    const tc = document.querySelector(
      `.tl-tc[data-reel-idx="${activeReelIdx}"]`,
    );
    if (tc) tc.textContent = frameToDisplayTime(frame, state.fps);
  });

  previewVideoEl.addEventListener('pause', () => {
    if (activeReelIdx === null) return;
    const btn = document.querySelector(
      `.tl-play-btn[data-reel-idx="${activeReelIdx}"]`,
    );
    if (btn) btn.textContent = '▶';
  });

  previewVideoEl.addEventListener('ended', () => {
    if (activeReelIdx === null) return;
    const btn = document.querySelector(
      `.tl-play-btn[data-reel-idx="${activeReelIdx}"]`,
    );
    if (btn) btn.textContent = '▶';
  });

  previewVideoEl.addEventListener('play', () => {
    if (activeReelIdx === null) return;
    const btn = document.querySelector(
      `.tl-play-btn[data-reel-idx="${activeReelIdx}"]`,
    );
    if (btn) btn.textContent = '⏸';
  });

  // Hide panel when leaving step 2
  document.addEventListener('reel:goStep', (e) => {
    if (e.detail !== 2) hidePreviewPanel();
  });

  // Refresh video src whenever videoPath changes
  subscribe(() => updatePreviewVideoSrc());
  updatePreviewVideoSrc();
}

// ── Init ───────────────────────────────────────────────────────────

export function init() {
  console.log('[step2.init] start');
  const promptEl = document.getElementById('userPrompt');
  promptEl.value = state.userPrompt;
  promptEl.addEventListener('input', (e) => {
    state.userPrompt = e.target.value;
    emit();
  });

  document
    .getElementById('analyzeBtn')
    .addEventListener('click', runAIAnalysis);
  document
    .getElementById('clearLlmCacheBtn')
    .addEventListener('click', async () => {
      await clearLlmCache();
      alert('Cache AI wyczyszczony.');
    });
  document
    .getElementById('downloadPromptBtn')
    .addEventListener('click', downloadPromptTXT);
  document
    .getElementById('editJsonBtn')
    .addEventListener('click', editReelsJSON);
  document
    .getElementById('applyManualJsonBtn')
    .addEventListener('click', applyManualJSON);
  document
    .getElementById('applyPastedJsonBtn')
    .addEventListener('click', applyPastedJSON);
  document
    .getElementById('clearPastedJsonBtn')
    .addEventListener('click', clearPastedJSON);
  document.getElementById('goStep3Btn').addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('reel:goStep', { detail: 3 }));
  });

  initPreviewVideo();

  const list = document.getElementById('reelsList');

  // ── Reel header toggle (delegated) ───────────────────────────────
  list.addEventListener('click', (e) => {
    if (e.target.closest('.clip-del-btn')) return;
    if (e.target.closest('.reel-threshold-wrap')) return;
    const h = e.target.closest('[data-toggle-reel]');
    if (!h) return;
    h.classList.toggle('expanded');
    h.nextElementSibling.classList.toggle('open');
  });

  // ── Delete clip (delegated) ──────────────────────────────────────
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.clip-del-btn');
    if (!btn) return;
    removeClip(+btn.dataset.reelIdx, +btn.dataset.clipIdx);
  });

  // ── Merge with next (delegated) ──────────────────────────────────
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.clip-merge-btn');
    if (!btn) return;
    mergeWithNext(+btn.dataset.reelIdx, +btn.dataset.clipIdx);
  });

  // ── Per-reel threshold slider ─────────────────────────────────────
  list.addEventListener('input', (e) => {
    const slider = e.target.closest('.reel-threshold');
    if (!slider) return;
    const ri = +slider.dataset.reelIdx;
    const val = +slider.value;
    state.reelsData[ri].mergeThreshold = val;
    const valEl = slider.parentElement.querySelector('.reel-threshold-val');
    if (valEl) valEl.textContent = val;
    updateGapColors(ri);
  });

  // ── Drag-to-reorder ──────────────────────────────────────────────
  list.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.clip-row');
    if (!row) return;
    dragSrc = { reelIdx: +row.dataset.reelIdx, clipIdx: +row.dataset.clipIdx };
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    row.classList.add('dragging');
  });

  list.addEventListener('dragend', () => {
    list
      .querySelectorAll('.dragging')
      .forEach((el) => el.classList.remove('dragging'));
    list
      .querySelectorAll('.drag-over')
      .forEach((el) => el.classList.remove('drag-over'));
    list
      .querySelectorAll('.drop-target')
      .forEach((el) => el.classList.remove('drop-target'));
    dragSrc = null;
  });

  list.addEventListener('dragover', (e) => {
    if (!dragSrc) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    list
      .querySelectorAll('.drag-over')
      .forEach((el) => el.classList.remove('drag-over'));
    list
      .querySelectorAll('.drop-target')
      .forEach((el) => el.classList.remove('drop-target'));
    const row = e.target.closest('.clip-row');
    if (row && !row.classList.contains('dragging')) {
      row.classList.add('drag-over');
    } else {
      const clips = e.target.closest('.reel-clips[data-reel-idx]');
      if (clips) clips.classList.add('drop-target');
    }
  });

  list.addEventListener('dragleave', (e) => {
    if (e.relatedTarget && list.contains(e.relatedTarget)) return;
    list
      .querySelectorAll('.drag-over')
      .forEach((el) => el.classList.remove('drag-over'));
    list
      .querySelectorAll('.drop-target')
      .forEach((el) => el.classList.remove('drop-target'));
  });

  list.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!dragSrc) return;
    const row = e.target.closest('.clip-row:not(.dragging)');
    const clips = e.target.closest('.reel-clips[data-reel-idx]');
    if (row) {
      const dstReel = +row.dataset.reelIdx;
      const dstIdx = +row.dataset.clipIdx;
      const rect = row.getBoundingClientRect();
      const before =
        e.clientY < rect.top + rect.height / 2 ? dstIdx : dstIdx + 1;
      moveClip(dragSrc.reelIdx, dragSrc.clipIdx, dstReel, before);
    } else if (clips) {
      const dstReel = +clips.dataset.reelIdx;
      moveClip(
        dragSrc.reelIdx,
        dragSrc.clipIdx,
        dstReel,
        state.reelsData[dstReel].clip_ids.length,
      );
    }
    dragSrc = null;
  });

  // ── Trim handles ─────────────────────────────────────────────────
  list.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('.trim-handle');
    if (!handle) return;
    e.preventDefault();
    const sentenceId = +handle.dataset.sentenceId;
    const side = handle.dataset.side;
    const s = state.sentences.find((x) => x.id === sentenceId);
    if (!s) return;
    if (!trimWarnShown) {
      if (
        !confirm(
          'Trymowanie zmienia segmenty SRT — działanie nieodwracalne.\nCmd-Z cofa zmianę. Kontynuować?',
        )
      )
        return;
      trimWarnShown = true;
    }
    handle.setPointerCapture(e.pointerId);
    trimState = {
      sentenceId,
      side,
      startX: e.clientX,
      origFrame: side === 'start' ? s.start_frame : s.end_frame,
      currentFrame: side === 'start' ? s.start_frame : s.end_frame,
      preSnap: snap(),
    };
  });

  list.addEventListener('pointermove', (e) => {
    if (!trimState) return;
    const s = state.sentences.find((x) => x.id === trimState.sentenceId);
    if (!s) return;
    const fps = state.fps;
    const deltaFrames = Math.round(
      ((e.clientX - trimState.startX) * fps) / 100,
    );
    let newFrame = trimState.origFrame + deltaFrames;
    let trimStartFrac = 0,
      trimEndFrac = 1;
    if (trimState.side === 'start') {
      newFrame = Math.max(0, Math.min(newFrame, s.end_frame - 1));
      trimState.currentFrame = newFrame;
      const row = list.querySelector(
        `.clip-row[data-sentence-id="${trimState.sentenceId}"]`,
      );
      if (row)
        row.querySelector('.clip-tc').textContent =
          `#${s.id} ${framesToTC(newFrame, fps)}→${s.end_tc}`;
      trimStartFrac =
        (newFrame - s.start_frame) / Math.max(1, s.duration_frame);
    } else {
      newFrame = Math.max(s.start_frame + 1, newFrame);
      trimState.currentFrame = newFrame;
      const row = list.querySelector(
        `.clip-row[data-sentence-id="${trimState.sentenceId}"]`,
      );
      if (row)
        row.querySelector('.clip-tc').textContent =
          `#${s.id} ${s.start_tc}→${framesToTC(newFrame, fps)}`;
      trimEndFrac = (newFrame - s.start_frame) / Math.max(1, s.duration_frame);
    }
    const peaks = cachedPeaks(trimState.sentenceId);
    if (peaks) {
      const canvas = list.querySelector(
        `.clip-waveform[data-sentence-id="${trimState.sentenceId}"]`,
      );
      if (canvas) drawWaveform(canvas, peaks, trimStartFrac, trimEndFrac);
    }
  });

  list.addEventListener('pointerup', () => {
    if (!trimState) return;
    if (trimState.currentFrame !== trimState.origFrame) {
      pushUndo(trimState.preSnap);
      applyTrim(trimState.sentenceId, trimState.side, trimState.currentFrame);
    }
    trimState = null;
  });

  list.addEventListener('pointercancel', () => {
    trimState = null;
    isDraggingTimeline = false;
  });

  // ── Timeline scrubbing ───────────────────────────────────────────
  list.addEventListener('pointerdown', (e) => {
    const canvas = e.target.closest('.reel-timeline');
    if (!canvas) return;
    e.preventDefault();
    const ri = +canvas.dataset.reelIdx;
    canvas.setPointerCapture(e.pointerId);
    isDraggingTimeline = true;
    seekToFrame(
      ri,
      frameFromX(canvas, state.reelsData[ri], state.sentences, e.clientX),
    );
  });

  list.addEventListener('pointermove', (e) => {
    if (!isDraggingTimeline) return;
    const canvas = e.target.closest('.reel-timeline');
    if (!canvas) return;
    const ri = +canvas.dataset.reelIdx;
    seekToFrame(
      ri,
      frameFromX(canvas, state.reelsData[ri], state.sentences, e.clientX),
    );
  });

  list.addEventListener('pointerup', (e) => {
    if (isDraggingTimeline) isDraggingTimeline = false;
  });

  // ── Timeline play/pause button ───────────────────────────────────
  list.addEventListener('click', (e) => {
    const btn = e.target.closest('.tl-play-btn');
    if (!btn || !previewVideoEl) return;
    const ri = +btn.dataset.reelIdx;
    const reel = state.reelsData[ri];
    if (!reel) return;

    if (activeReelIdx !== ri) {
      // Switch active reel — seek to its current playhead (or first clip start)
      const { minFrame } = reelSourceSpan(reel, state.sentences);
      const ph = playheadState.get(ri) ?? minFrame;
      activeReelIdx = ri;
      if (previewVideoEl.readyState >= 1) {
        try {
          previewVideoEl.currentTime = ph / state.fps;
        } catch {}
      }
      showPreviewPanel();
    }

    if (previewVideoEl.paused) {
      previewVideoEl.play().catch(() => {});
    } else {
      previewVideoEl.pause();
    }
  });

  // ── Clip row click → set focus (F14) ─────────────────────────────
  list.addEventListener('click', (e) => {
    if (
      e.target.closest(
        '.clip-del-btn, .clip-merge-btn, .trim-handle, .clip-grip',
      )
    )
      return;
    const row = e.target.closest('.clip-row');
    if (!row) return;
    setFocusedClip(
      +row.dataset.reelIdx,
      +row.dataset.clipIdx,
      +row.dataset.sentenceId,
    );
  });

  // ── F14 — NLE keyboard shortcuts (no modifier) ────────────────────
  document.addEventListener('keydown', (e) => {
    if (!document.getElementById('panel2').classList.contains('active')) return;
    if (
      e.target.matches('input, textarea, select') ||
      e.target.closest('[contenteditable]')
    )
      return;

    switch (e.key) {
      case ' ':
        e.preventDefault();
        if (previewVideoEl) {
          if (previewVideoEl.paused) previewVideoEl.play().catch(() => {});
          else previewVideoEl.pause();
        }
        break;
      case 'i':
      case 'I':
        if (focusedClip && activeReelIdx !== null) {
          const ph = playheadState.get(activeReelIdx);
          if (ph != null) {
            pushUndo(snap());
            applyTrim(focusedClip.sentenceId, 'start', ph);
          }
        }
        break;
      case 'o':
      case 'O':
        if (focusedClip && activeReelIdx !== null) {
          const ph = playheadState.get(activeReelIdx);
          if (ph != null) {
            pushUndo(snap());
            applyTrim(focusedClip.sentenceId, 'end', ph);
          }
        }
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (focusedClip && focusedClip.clipIdx > 0) {
          const { reelIdx, clipIdx } = focusedClip;
          moveClip(reelIdx, clipIdx, reelIdx, clipIdx - 1);
          focusedClip.clipIdx = clipIdx - 1;
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (focusedClip) {
          const { reelIdx, clipIdx } = focusedClip;
          const reel = state.reelsData[reelIdx];
          if (reel && clipIdx < reel.clip_ids.length - 1) {
            moveClip(reelIdx, clipIdx, reelIdx, clipIdx + 2);
            focusedClip.clipIdx = clipIdx + 1;
          }
        }
        break;
      case 'x':
      case 'X':
        if (focusedClip) {
          removeClip(focusedClip.reelIdx, focusedClip.clipIdx);
          focusedClip = null;
        }
        break;
      case 'j':
      case 'J':
        if (previewVideoEl) {
          previewVideoEl.pause();
          previewVideoEl.currentTime = Math.max(
            0,
            previewVideoEl.currentTime - 5 / state.fps,
          );
        }
        break;
      case 'k':
      case 'K':
        if (previewVideoEl) previewVideoEl.pause();
        break;
      case 'l':
      case 'L':
        if (previewVideoEl) previewVideoEl.play().catch(() => {});
        break;
    }
  });

  document
    .getElementById('compareBtn')
    .addEventListener('click', openCompareModal);
  document
    .getElementById('compareModalClose')
    .addEventListener('click', closeCompareModal);
  document
    .getElementById('compareRunBtn')
    .addEventListener('click', runComparison);
  document
    .getElementById('compareUseA')
    .addEventListener('click', () => applyCompareResult('A'));
  document
    .getElementById('compareUseB')
    .addEventListener('click', () => applyCompareResult('B'));
  document
    .getElementById('compareMerge')
    .addEventListener('click', () => applyCompareResult('merge'));
  document
    .getElementById('compareProviderA')
    .addEventListener('change', syncCompareModelRow);
  document
    .getElementById('compareProviderB')
    .addEventListener('change', syncCompareModelRow);
  syncCompareModelRow();
  console.log('[step2.init] done');
}

// ── Render ─────────────────────────────────────────────────────────

export function renderReels() {
  const fps = state.fps;
  const list = document.getElementById('reelsList');

  list.innerHTML = state.reelsData
    .map((r, ri) => {
      const totalDur = r.clip_ids
        .reduce((acc, id) => {
          const s = state.sentences.find((x) => x.id === id);
          return acc + (s ? s.duration_frame / fps : 0);
        }, 0)
        .toFixed(1);

      const threshold = r.mergeThreshold ?? state.mergeThreshold;

      const clipsHtml = r.clip_ids.length
        ? r.clip_ids
            .map((id, ci) => {
              const s = state.sentences.find((x) => x.id === id);
              if (!s) return '';
              const dur = (s.duration_frame / fps).toFixed(2);
              const clipHtml = `<div class="clip-row" draggable="true"
  data-reel-idx="${ri}" data-clip-idx="${ci}" data-sentence-id="${id}">
  <div class="clip-grip" title="Przeciągnij aby zmienić kolejność">⠿</div>
  <div class="trim-handle trim-start" data-sentence-id="${id}" data-side="start" title="Przytnij lewy koniec — przeciągnij">◀</div>
  <div class="clip-body">
    <canvas class="clip-waveform" data-sentence-id="${id}" width="400" height="48"></canvas>
    <div class="clip-tc">#${s.id} ${esc(s.start_tc)}→${esc(s.end_tc)}</div>
    <div class="clip-dur">${dur}s</div>
    <div class="clip-txt">${renderClipText(s)}</div>
  </div>
  <div class="trim-handle trim-end" data-sentence-id="${id}" data-side="end" title="Przytnij prawy koniec — przeciągnij">▶</div>
  <button class="clip-del-btn" data-reel-idx="${ri}" data-clip-idx="${ci}" title="Usuń z reela">✕</button>
</div>`;

              if (ci < r.clip_ids.length - 1) {
                const nextS = state.sentences.find(
                  (x) => x.id === r.clip_ids[ci + 1],
                );
                if (nextS) {
                  const gapFrames = nextS.start_frame - s.end_frame;
                  const willMerge = gapFrames <= threshold;
                  const gapClass = willMerge ? 'will-merge' : 'separate';
                  const gapText =
                    gapFrames <= 0
                      ? '0 kl. — scalony'
                      : willMerge
                        ? `${gapFrames} kl. — będzie scalony`
                        : `${gapFrames} kl. — osobny span`;
                  const mergeBtn =
                    gapFrames > 0
                      ? `<button class="clip-merge-btn" data-reel-idx="${ri}" data-clip-idx="${ci}" title="Scal z następnym">⊕</button>`
                      : '';
                  return (
                    clipHtml +
                    `\n<div class="clip-gap ${gapClass}" data-reel-idx="${ri}" data-clip-idx="${ci}" data-gap-frames="${gapFrames}"><span class="clip-gap-icon">⬡</span> <span class="clip-gap-label">${gapText}</span>${mergeBtn}</div>`
                  );
                }
              }
              return clipHtml;
            })
            .join('')
        : '<div class="clip-empty">Upuść klipy tutaj</div>';

      const timelineHtml = r.clip_ids.length
        ? `
  <div class="reel-timeline-wrap" data-reel-idx="${ri}">
    <div class="reel-preview-bar">
      <button class="tl-play-btn" data-reel-idx="${ri}" title="Odtwórz / Pauza">▶</button>
      <span class="tl-tc" data-reel-idx="${ri}">--:--:--.---</span>
    </div>
    <canvas class="reel-timeline" data-reel-idx="${ri}" height="40"></canvas>
  </div>`
        : '';

      return `<div class="reel-card" data-reel-idx="${ri}">
  <div class="reel-header expanded" data-toggle-reel>
    <span class="reel-badge">REEL ${ri + 1}</span>
    <span class="reel-name">${esc(r.reel_name)}</span>
    <span class="reel-meta">${r.clip_ids.length} klipów • ${totalDur}s</span>
    <label class="reel-threshold-wrap" title="Próg scalania dla tego reela (override globalnego)">Próg: <input type="range" class="reel-threshold" data-reel-idx="${ri}" min="0" max="60" value="${threshold}"><span class="reel-threshold-val">${threshold}</span> kl.</label>
  </div>
  <div class="reel-clips open" data-reel-idx="${ri}">${clipsHtml}</div>${timelineHtml}
</div>`;
    })
    .join('');

  document.getElementById('reelsCount').textContent =
    state.reelsData.length + ' reelsów';
  scheduleWaveformLoad();
  requestAnimationFrame(() => drawAllTimelines());
}

function scheduleWaveformLoad() {
  if (!state.videoPath) return;
  const fps = state.fps;
  const list = document.getElementById('reelsList');
  list
    .querySelectorAll('.clip-waveform[data-sentence-id]')
    .forEach((canvas) => {
      const sid = +canvas.dataset.sentenceId;
      const s = state.sentences.find((x) => x.id === sid);
      if (!s) return;
      const peaks = cachedPeaks(sid);
      if (peaks) {
        drawWaveform(canvas, peaks, 0, 1);
        return;
      }
      loadWaveform(
        sid,
        state.videoPath,
        s.start_frame / fps,
        s.end_frame / fps,
        400,
      ).then((p) => {
        if (!p) return;
        // Canvas may have been replaced by another renderReels call; re-query by sentenceId
        const el = list.querySelector(
          `.clip-waveform[data-sentence-id="${sid}"]`,
        );
        if (el) drawWaveform(el, p, 0, 1);
      });
    });
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Render clip text with filler words struck-through in red (F4)
function renderClipText(s) {
  const MAX = 120;
  if (!s.words || !s.words.length) {
    const t = s.text.substring(0, MAX);
    return esc(t) + (s.text.length > MAX ? '…' : '');
  }
  let html = '';
  let chars = 0;
  for (const w of s.words) {
    if (chars >= MAX) {
      html += '…';
      break;
    }
    const t = w.text.trim();
    if (!t) continue;
    const safe = esc(t);
    html += isFiller(t)
      ? `<s style="color:var(--red);opacity:0.7">${safe}</s> `
      : `${safe} `;
    chars += t.length + 1;
  }
  return html.trim();
}

// ── AI analysis ────────────────────────────────────────────────────

async function runAIAnalysis() {
  const apiKey =
    document.getElementById('apiKeyInput').value.trim() ||
    getApiKey(state.currentProvider);
  if (!apiKey) {
    alert('Wklej API key w nagłówku!');
    return;
  }
  if (!state.sentences.length) {
    alert('Najpierw przeanalizuj plik SRT (Krok 1)!');
    return;
  }
  if (state.currentProvider === 'openrouter' && !state.orSelectedModel) {
    alert(
      'Wybierz model OpenRouter! Kliknij "Załaduj modele" obok pola API key.',
    );
    return;
  }

  const analyzeBtn = document.getElementById('analyzeBtn');
  analyzeBtn.disabled = true;

  const progressBox = document.getElementById('progressBox');
  progressBox.classList.add('visible');
  setPS(1, 'running');
  setPS(2, '');
  setPS(3, '');
  logClear();
  document.getElementById('reelsCard').style.display = 'none';
  document.getElementById('step2Next').style.display = 'none';

  const prompt = buildPrompt(
    state.userPrompt,
    state.sentences,
    state.sources?.length ? state.sources : null,
    state.videoFilename || '',
  );
  log('Przygotowano prompt. Segmentów: ' + state.sentences.length, 'info');
  log(
    'Provider: ' +
      state.currentProvider +
      (state.currentProvider === 'openrouter'
        ? ' / ' + state.orSelectedModel
        : ''),
    'info',
  );
  setPS(1, 'done');
  setPS(2, 'running');

  try {
    const orModel = state.orSelectedModel;
    if (state.currentProvider === 'openrouter')
      log('Model: ' + orModel, 'info');

    const cacheKey = JSON.stringify({
      provider: state.currentProvider,
      model: orModel || '',
      prompt,
    });
    const {
      result: responseText,
      fromCache,
      hashShort,
    } = await withLlmCache(cacheKey, () => {
      if (state.currentProvider === 'gemini') return callGemini(apiKey, prompt);
      if (state.currentProvider === 'claude') return callClaude(apiKey, prompt);
      return callOpenRouter(apiKey, prompt, orModel);
    });

    if (fromCache) {
      log(`Odpowiedź z pamięci podręcznej (hash: ${hashShort}) ⚡`, 'ok');
    } else {
      log(
        'Odpowiedź AI otrzymana (' + responseText.length + ' znaków)',
        'info',
      );
    }
    setPS(2, 'done');
    setPS(3, 'running');

    const cleaned = responseText.replace(/```json|```/g, '').trim();
    pushUndo(snap());
    state.reelsData = JSON.parse(cleaned);
    renderReels();
    document.getElementById('statusReels').textContent = state.reelsData.length;
    setPS(3, 'done');
    log('Sparsowano ' + state.reelsData.length + ' reelsów', 'ok');
    document.getElementById('reelsCard').style.display = 'block';
    document.getElementById('step2Next').style.display = 'flex';
    emit();
  } catch (e) {
    setPS(2, 'err');
    setPS(3, 'err');
    log('BŁĄD: ' + e.message, 'err');
    log('Sprawdź API key i połączenie internetowe.', 'err');
  } finally {
    analyzeBtn.disabled = false;
  }
}

function editReelsJSON() {
  const card = document.getElementById('jsonEditorCard');
  card.style.display = card.style.display === 'none' ? 'block' : 'none';
  document.getElementById('jsonEditor').value = JSON.stringify(
    state.reelsData,
    null,
    2,
  );
}

function applyManualJSON() {
  try {
    const before = snap();
    state.reelsData = JSON.parse(document.getElementById('jsonEditor').value);
    pushUndo(before);
    renderReels();
    document.getElementById('statusReels').textContent = state.reelsData.length;
    document.getElementById('reelsCard').style.display = 'block';
    document.getElementById('step2Next').style.display = 'flex';
    document.getElementById('jsonEditorCard').style.display = 'none';
    log('JSON zastosowany: ' + state.reelsData.length + ' reelsów', 'ok');
    emit();
  } catch (e) {
    alert('Błąd parsowania JSON:\n' + e.message);
  }
}

function applyPastedJSON() {
  const raw = document.getElementById('pasteJsonInput').value.trim();
  const status = document.getElementById('pasteJsonStatus');
  if (!raw) {
    status.style.color = 'var(--red)';
    status.textContent = 'Pole jest puste.';
    return;
  }
  try {
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed)) throw new Error('Oczekiwano tablicy JSON []');
    if (!parsed.length) throw new Error('Tablica jest pusta');
    if (!parsed[0].clip_ids) throw new Error('Brak pola clip_ids w obiektach');
    const before = snap();
    state.reelsData = parsed;
    pushUndo(before);
    renderReels();
    document.getElementById('statusReels').textContent = state.reelsData.length;
    document.getElementById('reelsCard').style.display = 'block';
    document.getElementById('step2Next').style.display = 'flex';
    status.style.color = 'var(--green)';
    status.textContent = `✓ Wczytano ${state.reelsData.length} reelsów`;
    emit();
  } catch (e) {
    status.style.color = 'var(--red)';
    status.textContent = 'Błąd: ' + e.message;
  }
}

function clearPastedJSON() {
  document.getElementById('pasteJsonInput').value = '';
  document.getElementById('pasteJsonStatus').textContent = '';
}

// ── F8 — Compare two AI runs ───────────────────────────────────────

let compareResultA = null;
let compareResultB = null;

function openCompareModal() {
  document.getElementById('compareModal').style.display = 'flex';
  compareResultA = null;
  compareResultB = null;
  document.getElementById('compareDiff').style.display = 'none';
  document.getElementById('compareActions').style.display = 'none';
  document.getElementById('compareLog').style.display = 'none';
}

function closeCompareModal() {
  document.getElementById('compareModal').style.display = 'none';
}

function syncCompareModelRow() {
  ['A', 'B'].forEach((side) => {
    const sel = document.getElementById('compareProvider' + side);
    const row = document.getElementById('compareModelRow' + side);
    if (row)
      row.style.display = sel && sel.value === 'openrouter' ? '' : 'none';
  });
}

async function runComparison() {
  if (!state.sentences.length) {
    alert('Najpierw załaduj SRT (Krok 1)!');
    return;
  }
  const prompt = buildPrompt(
    state.userPrompt,
    state.sentences,
    state.sources?.length ? state.sources : null,
    state.videoFilename || '',
  );

  const getConfig = (side) => ({
    provider: document.getElementById('compareProvider' + side).value,
    key:
      document.getElementById('compareKey' + side).value.trim() ||
      getApiKey(document.getElementById('compareProvider' + side).value),
    model: document.getElementById('compareModel' + side)?.value.trim() || '',
  });

  const cfgA = getConfig('A');
  const cfgB = getConfig('B');
  if (!cfgA.key) {
    alert('Brak API key dla dostawcy A!');
    return;
  }
  if (!cfgB.key) {
    alert('Brak API key dla dostawcy B!');
    return;
  }

  const logEl = document.getElementById('compareLog');
  logEl.style.display = 'block';
  logEl.innerHTML = '<div>Uruchamiam oba dostawców równolegle…</div>';

  const callProvider = async (cfg) => {
    const cacheKey = JSON.stringify({
      provider: cfg.provider,
      model: cfg.model,
      prompt,
    });
    const { result } = await withLlmCache(cacheKey, () => {
      if (cfg.provider === 'gemini') return callGemini(cfg.key, prompt);
      if (cfg.provider === 'claude') return callClaude(cfg.key, prompt);
      return callOpenRouter(cfg.key, prompt, cfg.model);
    });
    return JSON.parse(result.replace(/```json|```/g, '').trim());
  };

  document.getElementById('compareRunBtn').disabled = true;
  try {
    [compareResultA, compareResultB] = await Promise.all([
      callProvider(cfgA).catch((e) => {
        throw new Error('A: ' + e.message);
      }),
      callProvider(cfgB).catch((e) => {
        throw new Error('B: ' + e.message);
      }),
    ]);
    logEl.innerHTML +=
      '<div style="color:var(--green)">✓ Oba dostawcy odpowiedzieli.</div>';
    renderCompareDiff(compareResultA, compareResultB);
  } catch (e) {
    logEl.innerHTML += `<div style="color:var(--red)">Błąd: ${esc(e.message)}</div>`;
  } finally {
    document.getElementById('compareRunBtn').disabled = false;
  }
}

function renderCompareDiff(runA, runB) {
  const idsA = new Set(runA.flatMap((r) => r.clip_ids));
  const idsB = new Set(runB.flatMap((r) => r.clip_ids));
  const all = [...new Set([...idsA, ...idsB])].sort((a, b) => a - b);

  const rows = all
    .map((id) => {
      const s = state.sentences.find((x) => x.id === id);
      const txt = s
        ? esc(s.text.substring(0, 60)) + (s.text.length > 60 ? '…' : '')
        : `id=${id}`;
      const inA = idsA.has(id),
        inB = idsB.has(id);
      const col = inA && inB ? 'both' : inA ? 'a-only' : 'b-only';
      return `<tr class="diff-row diff-${col}">
      <td style="padding:4px 8px;font-size:11px;color:var(--text2);">${id}</td>
      <td style="padding:4px 8px;font-size:11px;">${txt}</td>
      <td style="padding:4px 8px;text-align:center;">${inA ? '✓' : ''}</td>
      <td style="padding:4px 8px;text-align:center;">${inB ? '✓' : ''}</td>
    </tr>`;
    })
    .join('');

  const diffEl = document.getElementById('compareDiff');
  diffEl.style.display = 'block';
  diffEl.innerHTML = `
<div style="margin-bottom:8px;font-size:12px;color:var(--text2);">
  Dostawca A: ${runA.length} reelsów | Dostawca B: ${runB.length} reelsów<br>
  Tylko A: ${[...idsA].filter((id) => !idsB.has(id)).length} kl. | Tylko B: ${[...idsB].filter((id) => !idsA.has(id)).length} kl. | Wspólne: ${[...idsA].filter((id) => idsB.has(id)).length} kl.
</div>
<div style="max-height:260px;overflow-y:auto;border:1px solid var(--border);border-radius:6px;">
<table style="width:100%;border-collapse:collapse;">
  <thead><tr style="background:var(--surface2);">
    <th style="padding:6px 8px;font-size:11px;text-align:left;">#</th>
    <th style="padding:6px 8px;font-size:11px;text-align:left;">Tekst</th>
    <th style="padding:6px 8px;font-size:11px;">A</th>
    <th style="padding:6px 8px;font-size:11px;">B</th>
  </tr></thead>
  <tbody>${rows}</tbody>
</table>
</div>`;
  document.getElementById('compareActions').style.display = 'flex';
}

function applyCompareResult(which) {
  let result;
  if (which === 'A') result = compareResultA;
  else if (which === 'B') result = compareResultB;
  else {
    // Merge: union of all clip_ids, de-duped per reel
    const allReels = [...(compareResultA || []), ...(compareResultB || [])];
    const merged = {};
    for (const r of allReels) {
      const key = r.reel_name;
      if (!merged[key]) merged[key] = { ...r, clip_ids: [] };
      for (const id of r.clip_ids) {
        if (!merged[key].clip_ids.includes(id)) merged[key].clip_ids.push(id);
      }
    }
    result = Object.values(merged);
  }
  if (!result) return;
  pushUndo(snap());
  state.reelsData = result;
  renderReels();
  document.getElementById('statusReels').textContent = state.reelsData.length;
  document.getElementById('reelsCard').style.display = 'block';
  document.getElementById('step2Next').style.display = 'flex';
  closeCompareModal();
  emit();
}

function downloadPromptTXT() {
  if (!state.sentences.length) {
    alert('Najpierw przeanalizuj SRT (Krok 1)!');
    return;
  }
  const content = buildPrompt(
    state.userPrompt,
    state.sentences,
    state.sources?.length ? state.sources : null,
    state.videoFilename || '',
  );
  const url = URL.createObjectURL(new Blob([content], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'PROMPT_DLA_AI.txt';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
}

function setPS(n, s) {
  const el = document.getElementById('ps' + n);
  el.className = 'p-step' + (s ? ' ' + s : '');
}
function logClear() {
  document.getElementById('logBox').innerHTML = '';
}
function log(msg, type = '') {
  const box = document.getElementById('logBox');
  const d = document.createElement('div');
  d.className = 'log-line ' + type;
  d.textContent = '> ' + msg;
  box.appendChild(d);
  box.scrollTop = box.scrollHeight;
}
