import { mergeAdjacentClips } from '../parser/segments.js';
import { framesToTC } from '../parser/srt.js';

function _isDropFrame(fps) {
  return Math.abs(fps - 29.97) < 0.02 || Math.abs(fps - 59.94) < 0.02;
}

export function generateEDL({
  reelsData,
  sentences,
  fps,
  gapFrames,
  videoFilename,
  mergeThreshold,
}) {
  const fcm = _isDropFrame(fps) ? 'DROP FRAME' : 'NON-DROP FRAME';
  let out = `TITLE: REELS_EDL_AUTOMATOR\nFCM: ${fcm}\n\n`;
  let cursor = 3600 * fps;
  let eventNum = 1;

  for (const [reelIdx, reel] of reelsData.entries()) {
    const spans = mergeAdjacentClips(
      reel.clip_ids,
      sentences,
      reel.mergeThreshold ?? mergeThreshold,
    );
    out += `* ============================================\n`;
    out += `* REEL: ${reel.reel_name}\n`;
    out += `* ============================================\n`;
    for (const span of spans) {
      const dur = span.duration_frame;
      const recIn = cursor;
      const recOut = cursor + dur;
      const num = String(eventNum++).padStart(3, '0');
      out += `${num}  AX       V     C        `;
      out += `${framesToTC(span.start_frame, fps)} ${framesToTC(span.end_frame, fps)} `;
      out += `${framesToTC(recIn, fps)} ${framesToTC(recOut, fps)}\n`;
      out += `* FROM CLIP NAME: ${videoFilename}\n`;
      out += `* SEGMENT ID: ${span.ids.length === 1 ? span.ids[0] : span.ids.join(',')}\n`;
      out += `* TEXT: ${span.text.slice(0, 100)}\n`;
      out += `\n`;
      cursor += dur;
    }
    if (reelIdx < reelsData.length - 1) {
      cursor += gapFrames;
    }
  }

  return out.trimEnd() + '\n';
}
