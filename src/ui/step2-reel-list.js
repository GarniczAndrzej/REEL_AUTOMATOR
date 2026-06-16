// Step-2 reel-list rendering. S-16 Phase 3b (#14) removed the per-reel scrub
// timeline, the play button, and the per-reel merge-threshold slider; a later
// acceptance pass removed the floating video preview. The S-16 phase-4
// declutter pass stripped the clip waveform, the trim handles, and the per-clip
// timecode — each clip row now shows just its transcript text (drag-reorder +
// delete + merge-gap remain). The reel header leads with the reel name; scores
// sit on the right.

import { state } from '../state.js';

// ── Init ───────────────────────────────────────────────────────────

export function initReelList(list) {
  // ── Reel header toggle (delegated) ───────────────────────────────
  list.addEventListener('click', (e) => {
    if (e.target.closest('.clip-del-btn')) return;
    const h = e.target.closest('[data-toggle-reel]');
    if (!h) return;
    h.classList.toggle('expanded');
    h.nextElementSibling.classList.toggle('open');
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

      const clipsHtml = r.clip_ids.length
        ? r.clip_ids
            .map((id, ci) => {
              const s = state.sentences.find((x) => x.id === id);
              if (!s) return '';
              const dur = (s.duration_frame / fps).toFixed(2);
              const clipHtml = `<div class="clip-row" draggable="true"
  data-reel-idx="${ri}" data-clip-idx="${ci}" data-sentence-id="${id}">
  <div class="clip-grip" title="Przeciągnij aby zmienić kolejność">⠿</div>
  <div class="clip-body">
    <div class="clip-txt">${renderClipText(s)}</div>
  </div>
  <div class="clip-dur">${dur}s</div>
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
    <span class="reel-name">${esc(r.reel_name)}</span>
    <span class="reel-meta">${r.clip_ids.length} klipów • ${totalDur}s</span>
    ${scoreBadge}
    ${axesHtml}
  </div>
  <div class="reel-clips open" data-reel-idx="${ri}">${clipsHtml}</div>
</div>`;
    })
    .join('');

  document.getElementById('reelsCount').textContent =
    state.reelsData.length + ' reelsów';
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
