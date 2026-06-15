// Step-2 reel-list rendering plus the floating preview surface. S-16 Phase 3b
// (#14) removed the per-reel scrub timeline, the play button, and the per-reel
// merge-threshold slider: the list now reads as compact reel cards with
// component-score badges, and the floating preview is seeked by clicking a clip
// body. Owns the playhead/preview module state.

import { state, subscribe } from '../state.js';
import {
  loadWaveform,
  drawWaveform,
  cachedPeaks,
} from '../selection/waveform.js';

// ── Preview state ───────────────────────────────────────────────────

const playheadState = new Map(); // reelIdx → current playhead frame (source)
let activeReelIdx = null; // reel that owns the preview video
let previewVideoEl = null;
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

// ── Preview helpers ─────────────────────────────────────────────────

function showPreviewPanel() {
  const panel = document.getElementById('previewPanel');
  if (panel) panel.style.display = 'block';
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
    // Not in Tauri context or asset protocol unavailable — preview disabled
  }
}

function seekToFrame(ri, frame) {
  const reel = state.reelsData[ri];
  if (!reel) return;
  playheadState.set(ri, frame);
  activeReelIdx = ri;
  if (previewVideoEl && previewVideoEl.readyState >= 1) {
    try {
      previewVideoEl.currentTime = frame / state.fps;
    } catch {}
  }
  showPreviewPanel();
}

function initPreviewVideo() {
  previewVideoEl = document.getElementById('previewVideo');
  if (!previewVideoEl) return;

  updatePreviewPanelSize();

  previewVideoEl.addEventListener('timeupdate', () => {
    if (activeReelIdx === null) return;
    const frame = Math.round(previewVideoEl.currentTime * state.fps);
    playheadState.set(activeReelIdx, frame);
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
    const h = e.target.closest('[data-toggle-reel]');
    if (!h) return;
    h.classList.toggle('expanded');
    h.nextElementSibling.classList.toggle('open');
  });

  // ── Clip body click → seek the floating preview there ────────────
  list.addEventListener('click', (e) => {
    if (
      e.target.closest(
        '.clip-del-btn, .clip-merge-btn, .trim-handle, .clip-grip',
      )
    )
      return;
    const row = e.target.closest('.clip-row');
    if (!row) return;
    const ri = +row.dataset.reelIdx;
    const sid = +row.dataset.sentenceId;
    const s = state.sentences.find((x) => x.id === sid);
    if (s) seekToFrame(ri, s.start_frame);
  });
}

// ── Render ─────────────────────────────────────────────────────────

// Component-score axes (S-01 Reel.scores) rendered as compact badges beside the
// overall virality score. Each axis is optional/backward-compat (older projects
// may omit `scores`), so we render only the ones present.
function renderAxisBadges(scores) {
  if (!scores || typeof scores !== 'object') return '';
  const axes = [
    ['hook', 'H', 'Hook'],
    ['flow', 'F', 'Flow'],
    ['value', 'V', 'Value'],
    ['trend', 'T', 'Trend'],
  ];
  const parts = axes
    .filter(([k]) => typeof scores[k] === 'number')
    .map(
      ([k, label, title]) =>
        `<span class="reel-axis-badge" title="${title}">${label} ${Math.round(scores[k])}</span>`,
    );
  return parts.length ? `<span class="reel-axes">${parts.join('')}</span>` : '';
}

export function renderReels() {
  const fps = state.fps;
  const list = document.getElementById('reelsList');
  // Single global merge-gap (S-16 3b removed the per-reel override).
  const threshold = state.mergeThreshold;

  list.innerHTML = state.reelsData
    .map((r, ri) => {
      const totalDur = r.clip_ids
        .reduce((acc, id) => {
          const s = state.sentences.find((x) => x.id === id);
          return acc + (s ? s.duration_frame / fps : 0);
        }, 0)
        .toFixed(1);

      // S-01 read-only score display + component-axis badges.
      const hasScore = typeof r.virality_score === 'number';
      const scoreBadge = hasScore
        ? `<span class="reel-score-badge" title="Virality score">${Math.round(r.virality_score)}</span>`
        : `<span class="reel-score-badge muted" title="Brak oceny">brak oceny</span>`;
      const axesHtml = renderAxisBadges(r.scores);
      const reasonHtml =
        hasScore && r.reason
          ? `<span class="reel-reason">${esc(r.reason)}</span>`
          : '';

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

      return `<div class="reel-card" data-reel-idx="${ri}">
  <div class="reel-header expanded" data-toggle-reel>
    <span class="reel-badge">REEL ${ri + 1}</span>
    ${scoreBadge}
    ${axesHtml}
    <span class="reel-name">${esc(r.reel_name)}</span>
    <span class="reel-meta">${r.clip_ids.length} klipów • ${totalDur}s</span>
    ${reasonHtml}
  </div>
  <div class="reel-clips open" data-reel-idx="${ri}">${clipsHtml}</div>
</div>`;
    })
    .join('');

  document.getElementById('reelsCount').textContent =
    state.reelsData.length + ' reelsów';
  scheduleWaveformLoad();
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

export function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Render clip text, truncated at word boundaries (MAX chars).
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
    html += `${esc(t)} `;
    chars += t.length + 1;
  }
  return html.trim();
}
