import { mergeAdjacentClips } from '../parser/segments.js';
import { MARKER_LABELS } from './markers.js';

// hook/body/punchline → DaVinci Resolve marker color name. Mirrors the Lua
// exporter's `LUA_MARKER_COLORS` (`lua.js:6`) — the live `timeline:AddMarker`
// API takes the same color vocabulary as the pasted Lua script.
const RESOLVE_MARKER_COLORS = { hook: 'Green', body: 'Blue', punchline: 'Red' };

/**
 * @typedef {Object} ResolveClip
 * @property {number} startFrame - source in-frame (clip span start)
 * @property {number} endFrame - source out-frame (clip span end)
 * @property {number} recordFrame - 0-based timeline frame the clip lands on
 *
 * @typedef {Object} ResolveMarker
 * @property {number} frame - 0-based timeline frame
 * @property {string} color - Resolve marker color name
 * @property {string} label - HOOK / BODY / PUNCHLINE
 *
 * @typedef {Object} ResolveTimeline
 * @property {string} name - timeline name (the project name; backend bumps on collision)
 * @property {ResolveClip[]} clips - every reel's spans, in order, on one timeline
 * @property {ResolveMarker[]} markers - hook/body/punchline markers across all reels
 */

/**
 * Build the single-timeline clip + marker payload the Electron backend feeds to
 * the live Resolve API (`AppendToTimeline` + `AddMarker`) for Mode D. This is the
 * direct-construction path: `ImportTimelineFromFile` rejects our FCPXML in the
 * WI scripting scope (errorCode 6), so we drive the same call sequence the
 * shipped Lua exporter already proves (`lua.js` — ImportMedia → CreateEmptyTimeline
 * → AppendToTimeline → AddMarker).
 *
 * Frame math mirrors `lua.js` exactly: **all reels land on one timeline**, the
 * record cursor runs continuously across reels with `gapFrames` of empty timeline
 * between consecutive reels (the inter-reel gap from settings, `state.gapFrames`).
 * recordFrame stays **0-based** — never the EDL `3600*fps` CMX offset
 * (`edl.js:15`), which would push every clip an hour into the timeline. A marker's
 * timeline frame = its span's record cursor + (sentence.start_frame −
 * span.start_frame) (`lua.js:142-150`).
 *
 * @param {object} opts
 * @param {import('../state.js').Reel[]} opts.reelsData
 * @param {import('../state.js').Sentence[]} opts.sentences
 * @param {number} opts.mergeThreshold
 * @param {number} opts.gapFrames - empty frames between consecutive reels
 * @param {string} opts.name - timeline name (the project name)
 * @returns {ResolveTimeline}
 */
export function buildResolveTimeline({
  reelsData,
  sentences,
  mergeThreshold,
  gapFrames,
  name,
}) {
  let cursor = 0;
  const clips = [];
  const markers = [];

  reelsData.forEach((reel, ri) => {
    const spans = mergeAdjacentClips(
      reel.clip_ids,
      sentences,
      reel.mergeThreshold ?? mergeThreshold,
    );

    const recordFrameById = new Map();
    for (const span of spans) {
      for (const id of span.ids) {
        const s = sentences.find((x) => x.id === id);
        if (s) {
          recordFrameById.set(id, cursor + (s.start_frame - span.start_frame));
        }
      }
      clips.push({
        startFrame: span.start_frame,
        endFrame: span.end_frame,
        recordFrame: cursor,
      });
      cursor += span.duration_frame;
    }

    if (reel.markers) {
      for (const [key, label] of MARKER_LABELS) {
        const cid = reel.markers[key];
        if (cid == null) continue;
        const frame = recordFrameById.get(cid);
        if (frame == null) continue;
        markers.push({ frame, color: RESOLVE_MARKER_COLORS[key], label });
      }
    }

    // Inter-reel gap (matches the Lua exporter) — none after the last reel.
    if (ri < reelsData.length - 1) cursor += gapFrames;
  });

  return { name, clips, markers };
}
