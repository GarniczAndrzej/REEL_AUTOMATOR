// Step-2 segment operations: clip mutations, undo/redo, focus, drag-reorder,
// trim, and the NLE keyboard shortcuts. Owns its own mutable module state and
// attaches its listeners via initSegmentOps(listEl). (R1 split — pure move.)

import { state, emit } from '../state.js';
import { framesToTC } from '../parser/srt.js';
import {
  drawWaveform,
  cachedPeaks,
  invalidateWaveform,
} from '../selection/waveform.js';
import {
  renderReels,
  getPreviewVideo,
  getActiveReelIdx,
  getPlayhead,
} from './step2-reel-list.js';

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

// ── Init ───────────────────────────────────────────────────────────

export function initSegmentOps(list) {
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

    const previewVideoEl = getPreviewVideo();
    const activeReelIdx = getActiveReelIdx();

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
          const ph = getPlayhead(activeReelIdx);
          if (ph != null) {
            pushUndo(snap());
            applyTrim(focusedClip.sentenceId, 'start', ph);
          }
        }
        break;
      case 'o':
      case 'O':
        if (focusedClip && activeReelIdx !== null) {
          const ph = getPlayhead(activeReelIdx);
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
}
