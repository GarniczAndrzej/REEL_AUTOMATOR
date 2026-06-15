// Shared video-metadata auto-populate (S-16 Phase 3b). Probes an imported video
// via the `probe_video_metadata` backend command (FFmpeg sidecar) and writes
// fps + resolution into state so the project settings auto-populate (#4/#5).
// Tolerant by design: any field the probe can't read leaves the corresponding
// state value at its current/editable default — a probe never blocks an import.

import { state } from '../state.js';

// The fps picker only offers discrete options; snap a fractional probe (23.976,
// 29.97, 59.94) to the nearest supported integer rate.
const FPS_OPTIONS = [24, 25, 30, 50, 60];

function snapFps(fps) {
  let best = FPS_OPTIONS[0];
  let bestDelta = Infinity;
  for (const opt of FPS_OPTIONS) {
    const d = Math.abs(opt - fps);
    if (d < bestDelta) {
      bestDelta = d;
      best = opt;
    }
  }
  return best;
}

/**
 * Set `videoPath` + `videoFilename` from a picked file, then probe it for fps +
 * resolution and fold those into state. Always sets path/filename; fps and
 * resolution update only when the probe yields plausible values.
 * @param {string} path absolute path to the source video
 * @returns {Promise<{fps:number|null, width:number|null, height:number|null}|null>}
 */
export async function populateVideoMeta(path) {
  if (!path) return null;
  state.videoPath = path;
  state.videoFilename = path.split('/').pop().split('\\').pop();
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const meta = await invoke('probe_video_metadata', { path });
    if (meta && typeof meta.fps === 'number' && meta.fps > 0) {
      state.fps = snapFps(meta.fps);
    }
    if (meta && meta.width && meta.height) {
      state.videoResolution = `${meta.width}x${meta.height}`;
    }
    return meta;
  } catch (e) {
    // Not in Tauri, sidecar missing, or unparseable file — keep editable
    // defaults rather than erroring the import.
    return null;
  }
}
