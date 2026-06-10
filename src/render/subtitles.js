import { mergeAdjacentClips } from '../parser/segments.js';

export function buildReelSrt(reel, sentences, fps, mergeThreshold) {
  const spans = mergeAdjacentClips(reel.clip_ids, sentences, mergeThreshold);
  let cursor = 0;
  const cues = [];
  let n = 1;

  for (const span of spans) {
    const sentenceObjs = span.ids
      .map((id) => sentences.find((s) => s.id === id))
      .filter(Boolean);
    const spanStartFrame = span.start_frame;
    for (const s of sentenceObjs) {
      const start = cursor + (s.start_frame - spanStartFrame) / fps;
      const end = cursor + (s.end_frame - spanStartFrame) / fps;
      cues.push({ n: n++, start, end, text: s.text });
    }
    cursor += (span.end_frame - span.start_frame) / fps;
  }

  return cues
    .map(
      (c) => `${c.n}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${c.text}\n`,
    )
    .join('\n');
}

function srtTime(secs) {
  const totalMs = Math.round(secs * 1000);
  const ms = totalMs % 1000;
  const totalS = Math.floor(totalMs / 1000);
  const s = totalS % 60;
  const totalM = Math.floor(totalS / 60);
  const m = totalM % 60;
  const h = Math.floor(totalM / 60);
  return (
    String(h).padStart(2, '0') +
    ':' +
    String(m).padStart(2, '0') +
    ':' +
    String(s).padStart(2, '0') +
    ',' +
    String(ms).padStart(3, '0')
  );
}
