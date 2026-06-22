import { mergeAdjacentClips } from '../parser/segments.js';
import { isDropFrame } from '../parser/srt.js';
import { MARKER_LABELS } from './markers.js';

// Per-fps rational frameDuration table (FCPXML expresses every time as an exact
// `numerator/denominator s` fraction — never a decimal). Integer numerators
// keep the integer-frame invariant intact end-to-end. NTSC rates use the
// 1001/… form; whole rates use 100/… so frameDuration * rate === 1s exactly.
const FRAME_DURATION = [
  [23.976, 1001, 24000],
  [24, 100, 2400],
  [25, 100, 2500],
  [29.97, 1001, 30000],
  [30, 100, 3000],
  [50, 100, 5000],
  [59.94, 1001, 60000],
  [60, 100, 6000],
];

/**
 * @param {number} fps
 * @returns {[number, number]} `[num, den]` for one frame at `fps`
 */
function frameDurationFor(fps) {
  for (const [rate, num, den] of FRAME_DURATION) {
    if (Math.abs(fps - rate) < 0.02) return [num, den];
  }
  // Fallback for any other (integer-ish) rate: 100/(N*100) reduces to 1/N.
  const n = Math.round(fps) || 1;
  return [100, n * 100];
}

/**
 * Convert an integer frame count to an exact FCPXML rational seconds string.
 * Keeps integer numerators — never divides to a decimal. `0 → "0s"`.
 * @param {number} F integer frame count
 * @param {number} fps
 * @returns {string} e.g. `"4002/24000s"` or `"0s"`
 */
function framesToRational(F, fps) {
  const [num, den] = frameDurationFor(fps);
  return F === 0 ? '0s' : `${F * num}/${den}s`;
}

/**
 * Pure FCPXML 1.9 exporter for Final Cut Pro X (FCP 10.4.9+). One
 * `<project>`/`<sequence>` per reel (mirrors the xmeml exporter's per-reel
 * timelines) but using FCPXML's rational-time / `<asset-clip>` spine grammar.
 * Hook/body/punchline markers are clip-local (source-frame `start`, no color —
 * the label rides in `value`), gated on `reel.markers`.
 *
 * @param {object} opts
 * @param {import('../state.js').Reel[]} opts.reelsData
 * @param {import('../state.js').Sentence[]} opts.sentences
 * @param {number} opts.fps
 * @param {string} opts.videoFilename
 * @param {string} opts.videoPath absolute path — required for the `file://` media-rep src
 * @param {string} opts.videoResolution e.g. "1920x1080"
 * @param {string} opts.projectName
 * @param {number} opts.mergeThreshold
 * @returns {string}
 */
export function generateFCPXML({
  reelsData,
  sentences,
  fps,
  videoFilename,
  videoPath,
  videoResolution,
  projectName,
  mergeThreshold,
}) {
  const esc = (s) =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  let [vw, vh] = (videoResolution || '').split('x');
  if (!vw || !vh) {
    vw = '1920';
    vh = '1080';
  }

  // Absolute file:// URL for the source media-rep. videoPath is guaranteed
  // present by the genFCPXML wrapper (toast+null guard, like Lua).
  const absPath = videoPath.replace(/\\/g, '/');
  const withSlash = absPath.startsWith('/') ? absPath : '/' + absPath;
  const srcUrl = 'file://' + withSlash.replace(/ /g, '%20');

  const tcFmt = isDropFrame(fps) ? 'DF' : 'NDF';
  const frameDur = framesToRational(1, fps);
  const maxEndFrame = sentences.length
    ? Math.max(...sentences.map((s) => s.end_frame))
    : Math.round(fps * 60);

  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<!DOCTYPE fcpxml>');
  lines.push('<fcpxml version="1.9">');

  // Shared resources: one format + one asset, referenced by every reel's spine.
  lines.push('  <resources>');
  lines.push(
    `    <format id="r1" name="FFVideoFormat" frameDuration="${frameDur}" width="${esc(vw)}" height="${esc(vh)}"/>`,
  );
  lines.push(
    `    <asset id="r2" name="${esc(videoFilename)}" start="0s" duration="${framesToRational(maxEndFrame, fps)}" hasVideo="1" hasAudio="1" format="r1" videoSources="1" audioSources="1" audioChannels="2">`,
  );
  lines.push(`      <media-rep kind="original-media" src="${esc(srcUrl)}"/>`);
  lines.push('    </asset>');
  lines.push('  </resources>');

  lines.push(`  <event name="${esc(projectName)}">`);

  reelsData.forEach((reel) => {
    const spans = mergeAdjacentClips(
      reel.clip_ids,
      sentences,
      reel.mergeThreshold ?? mergeThreshold,
    );
    const reelDur = spans.reduce((a, s) => a + s.duration_frame, 0);

    // Group markers by the span (asset-clip) that contains their clip_id. A
    // marker is clip-local: its `start` is the source frame, clamped to the
    // clip's [start, start+duration]. Gated on reel.markers.
    const markersBySpan = new Map();
    if (reel.markers) {
      for (const [key, label] of MARKER_LABELS) {
        const cid = reel.markers[key];
        if (cid == null) continue;
        const s = sentences.find((x) => x.id === cid);
        if (!s) continue;
        const si = spans.findIndex((sp) => sp.ids.includes(cid));
        if (si < 0) continue;
        const span = spans[si];
        const lo = span.start_frame;
        const hi = span.start_frame + span.duration_frame;
        const mf = Math.min(Math.max(s.start_frame, lo), hi);
        const arr = markersBySpan.get(si) || [];
        arr.push({ start: framesToRational(mf, fps), label });
        markersBySpan.set(si, arr);
      }
    }

    lines.push(`    <project name="${esc(reel.reel_name)}">`);
    lines.push(
      `      <sequence format="r1" duration="${framesToRational(reelDur, fps)}" tcStart="0s" tcFormat="${tcFmt}">`,
    );
    lines.push('        <spine>');

    let cursor = 0;
    spans.forEach((span, si) => {
      const clipName = esc(
        `#${span.ids.join(',')} ${span.text.substring(0, 55)}`,
      );
      const attrs =
        `ref="r2" offset="${framesToRational(cursor, fps)}" name="${clipName}" ` +
        `start="${framesToRational(span.start_frame, fps)}" ` +
        `duration="${framesToRational(span.duration_frame, fps)}" ` +
        `format="r1" tcFormat="${tcFmt}"`;
      const markers = markersBySpan.get(si);
      if (markers && markers.length) {
        lines.push(`          <asset-clip ${attrs}>`);
        for (const m of markers) {
          lines.push(
            `            <marker start="${m.start}" duration="${frameDur}" value="${esc(m.label)}"/>`,
          );
        }
        lines.push('          </asset-clip>');
      } else {
        lines.push(`          <asset-clip ${attrs}/>`);
      }
      cursor += span.duration_frame;
    });

    lines.push('        </spine>');
    lines.push('      </sequence>');
    lines.push('    </project>');
  });

  lines.push('  </event>');
  lines.push('</fcpxml>');
  return lines.join('\n');
}
