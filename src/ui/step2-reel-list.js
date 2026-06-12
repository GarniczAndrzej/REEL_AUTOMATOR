// Step-2 reel-list rendering plus the timeline/preview surface. Owns the
// playhead/preview module state and attaches the timeline scrub / play-pause
// listeners via initReelList(listEl). (R1 split — pure move.)

import { state, subscribe } from '../state.js';
import { framesToTC } from '../parser/srt.js';
import { isFiller } from '../selection/fillers.js';
import {
  loadWaveform,
  drawWaveform,
  cachedPeaks,
} from '../selection/waveform.js';
import {
  drawTimeline,
  frameFromX,
  reelSourceSpan,
} from '../selection/timeline.js';

// ── Timeline / preview state ────────────────────────────────────────

const playheadState = new Map(); // reelIdx → current playhead frame (source)
let activeReelIdx = null; // reel that owns the preview video
let previewVideoEl = null;
let isDraggingTimeline = false;
let cachedAssetUrl = '';

/** @returns {HTMLVideoElement|null} the shared preview <video> element */
export function getPreviewVideo() {
  return previewVideoEl;
}

/** @returns {number|null} the reel index that currently owns the preview */
export function getActiveReelIdx() {
  return activeReelIdx;
}

/** @param {number} ri reel index @returns {number|undefined} playhead frame */
export function getPlayhead(ri) {
  return playheadState.get(ri);
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

export function updateGapColors(ri) {
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

export function drawAllTimelines() {
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

export function initReelList(list) {
  initPreviewVideo();

  // ── Reel header toggle (delegated) ───────────────────────────────
  list.addEventListener('click', (e) => {
    if (e.target.closest('.clip-del-btn')) return;
    if (e.target.closest('.reel-threshold-wrap')) return;
    const h = e.target.closest('[data-toggle-reel]');
    if (!h) return;
    h.classList.toggle('expanded');
    h.nextElementSibling.classList.toggle('open');
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

  list.addEventListener('pointerup', () => {
    if (isDraggingTimeline) isDraggingTimeline = false;
  });

  list.addEventListener('pointercancel', () => {
    isDraggingTimeline = false;
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

export function scheduleWaveformLoad() {
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

export function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Render clip text with filler words struck-through in red (F4)
export function renderClipText(s) {
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
