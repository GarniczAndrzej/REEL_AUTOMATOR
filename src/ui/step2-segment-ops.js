// Step-2 segment operations: clip mutations, undo/redo, focus, drag-reorder,
// trim, and the NLE keyboard shortcuts. Owns its own mutable module state and
// attaches its listeners via initSegmentOps(listEl). (R1 split — pure move.)

import { state, emit } from '../state.js';
import { framesToTC } from '../parser/srt.js';
import { invalidateWaveform } from '../selection/waveform.js';
import { renderReels } from './step2-reel-list.js';

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

  // ── Clip row click → set focus (F14) ─────────────────────────────
  list.addEventListener('click', (e) => {
    if (e.target.closest('.clip-del-btn, .clip-merge-btn, .clip-grip')) return;
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
    // Single surface (S-16): the NLE clip shortcuts only apply while reviewing
    // reels — gate on reels existing rather than a now-removed active panel.
    if (!state.reelsData.length) return;
    if (
      e.target.matches('input, textarea, select') ||
      e.target.closest('[contenteditable]')
    )
      return;

    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        if (focusedClip && focusedClip.clipIdx > 0) {
          const { reelIdx, clipIdx, sentenceId } = focusedClip;
          moveClip(reelIdx, clipIdx, reelIdx, clipIdx - 1);
          // renderReels() (inside moveClip) rebuilt the DOM, dropping the
          // .focused class — re-apply it to the row at the new position.
          setFocusedClip(reelIdx, clipIdx - 1, sentenceId);
        }
        break;
      case 'ArrowDown':
        e.preventDefault();
        if (focusedClip) {
          const { reelIdx, clipIdx, sentenceId } = focusedClip;
          const reel = state.reelsData[reelIdx];
          if (reel && clipIdx < reel.clip_ids.length - 1) {
            moveClip(reelIdx, clipIdx, reelIdx, clipIdx + 2);
            // Re-apply focus after the re-render so the glow follows the clip.
            setFocusedClip(reelIdx, clipIdx + 1, sentenceId);
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
    }
  });
}
