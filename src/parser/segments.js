export function mergeAdjacentClips(clipIds, sentences, thresholdFrames = 12) {
  const droppedIds = clipIds.filter(id => !sentences.find(s => s.id === id));
  if (droppedIds.length) {
    console.warn(`mergeAdjacentClips: brakujące clip_ids [${droppedIds.join(', ')}] — pominięte`);
  }
  const clips = clipIds.map(id => sentences.find(s => s.id === id)).filter(Boolean);
  const spans = [];
  let prevClip = null;

  for (const clip of clips) {
    if (prevClip && clip.start_frame < prevClip.end_frame) {
      console.warn(`mergeAdjacentClips: clip #${clip.id} overlaps or precedes previous clip (start_frame=${clip.start_frame} < end_frame=${prevClip.end_frame}) — emitting as separate span`);
    }
    if (
      prevClip &&
      clip.start_frame >= prevClip.end_frame &&
      clip.start_frame - prevClip.end_frame <= thresholdFrames &&
      (prevClip.source_idx ?? 0) === (clip.source_idx ?? 0)  // F18: never merge across sources
    ) {
      const last = spans[spans.length - 1];
      last.end_frame = clip.end_frame;
      last.ids.push(clip.id);
      last.text += ' ' + clip.text;
    } else {
      spans.push({
        start_frame: clip.start_frame,
        end_frame: clip.end_frame,
        ids: [clip.id],
        text: clip.text,
        source_idx: clip.source_idx ?? 0,
      });
    }
    prevClip = clip;
  }
  return spans.map(s => ({ ...s, duration_frame: s.end_frame - s.start_frame }));
}
