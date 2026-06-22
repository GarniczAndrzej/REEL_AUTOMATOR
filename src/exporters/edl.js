import { mergeAdjacentClips } from '../parser/segments.js';
import { framesToTC, isDropFrame } from '../parser/srt.js';
import { MARKER_LABELS } from './markers.js';

export function generateEDL({
  reelsData,
  sentences,
  fps,
  gapFrames,
  videoFilename,
  mergeThreshold,
}) {
  const fcm = isDropFrame(fps) ? 'DROP FRAME' : 'NON-DROP FRAME';
  let out = `TITLE: REELS_EDL_AUTOMATOR\nFCM: ${fcm}\n\n`;
  let cursor = 3600 * fps;
  let eventNum = 1;

  // hook/body/punchline → EDL locator color + name. Labels come from the shared
  // canonical constant; the GREEN/BLUE/RED colors stay EDL-local (each format's
  // color vocabulary differs).
  const EDL_COLORS = { hook: 'GREEN', body: 'BLUE', punchline: 'RED' };
  const MARKER_DEFS = MARKER_LABELS.map(([key, name]) => [
    key,
    EDL_COLORS[key],
    name,
  ]);

  for (const [reelIdx, reel] of reelsData.entries()) {
    const spans = mergeAdjacentClips(
      reel.clip_ids,
      sentences,
      reel.mergeThreshold ?? mergeThreshold,
    );
    out += `* ============================================\n`;
    out += `* REEL: ${reel.reel_name}\n`;
    out += `* ============================================\n`;
    // clip_id → record-timeline frame, built while walking spans so the
    // 1-hour CMX-3600 offset and per-reel gaps are already baked into `cursor`.
    const recordFrameById = new Map();
    for (const span of spans) {
      const dur = span.duration_frame;
      const recIn = cursor;
      const recOut = cursor + dur;
      for (const id of span.ids) {
        const s = sentences.find((x) => x.id === id);
        if (s)
          recordFrameById.set(id, recIn + (s.start_frame - span.start_frame));
      }
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
    // Conditional marker emission — strictly skipped when reel.markers is
    // absent so marker-free EDLs stay byte-identical to legacy.
    if (reel.markers) {
      for (const [key, color, name] of MARKER_DEFS) {
        const cid = reel.markers[key];
        if (cid == null) continue;
        const recFrame = recordFrameById.get(cid);
        if (recFrame == null) continue;
        out += `* LOC: ${framesToTC(recFrame, fps)} ${color} ${name}\n`;
      }
    }
    if (reelIdx < reelsData.length - 1) {
      cursor += gapFrames;
    }
  }

  return out.trimEnd() + '\n';
}
