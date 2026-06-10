function reelSourceSpan(reel, sentences) {
  let minFrame = Infinity, maxFrame = -Infinity;
  for (const id of reel.clip_ids) {
    const s = sentences.find(x => x.id === id);
    if (!s) continue;
    if (s.start_frame < minFrame) minFrame = s.start_frame;
    if (s.end_frame > maxFrame) maxFrame = s.end_frame;
  }
  if (minFrame === Infinity) return { minFrame: 0, maxFrame: 0 };
  return { minFrame, maxFrame };
}

// Draw the source-timeline for a reel onto a canvas.
// Canvas intrinsic width must already be set to the desired pixel width before calling.
export function drawTimeline(canvas, reel, sentences, fps, playheadFrame) {
  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return;

  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, w, h);

  const { minFrame, maxFrame } = reelSourceSpan(reel, sentences);
  const totalSpan = maxFrame - minFrame;
  if (totalSpan <= 0) return;

  // Track background
  ctx.fillStyle = 'rgba(255,255,255,0.04)';
  ctx.fillRect(0, 0, w, h);

  // Clip blocks sorted by start_frame
  const clips = reel.clip_ids
    .map(id => sentences.find(s => s.id === id))
    .filter(Boolean)
    .sort((a, b) => a.start_frame - b.start_frame);

  for (const s of clips) {
    const x1 = (s.start_frame - minFrame) / totalSpan * w;
    const x2 = (s.end_frame - minFrame) / totalSpan * w;
    ctx.fillStyle = 'rgba(124,109,250,0.75)';
    ctx.fillRect(x1, 2, Math.max(2, x2 - x1), h - 4);
  }

  // Playhead — 2px white vertical line
  if (playheadFrame !== undefined) {
    const px = (playheadFrame - minFrame) / totalSpan * w;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(px - 1, 0, 2, h);
  }
}

// Convert a clientX coordinate (pointer event) to a source frame number for this reel.
export function frameFromX(canvas, reel, sentences, clientX) {
  const rect = canvas.getBoundingClientRect();
  const x = clientX - rect.left;
  const { minFrame, maxFrame } = reelSourceSpan(reel, sentences);
  const totalSpan = maxFrame - minFrame;
  if (totalSpan <= 0) return minFrame;
  const frac = Math.max(0, Math.min(1, x / rect.width));
  return Math.round(minFrame + frac * totalSpan);
}

export { reelSourceSpan };
