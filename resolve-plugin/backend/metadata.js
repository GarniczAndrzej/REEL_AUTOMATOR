// Node port of metadata.rs (S-09 Phase 4) — probe a source clip's fps + resolution
// from the FFmpeg sidecar's stream banner so the import flow auto-populates project
// settings. Tolerant by design: any unparseable field comes back `null` and the
// renderer keeps its editable default — a probe never blocks an import.

const { spawn } = require('child_process');
const paths = require('./paths');

/**
 * @param {{ path: string }} args
 * @returns {Promise<{ fps:number|null, width:number|null, height:number|null }>}
 */
async function probeVideoMetadata({ path: videoPath }) {
  // `ffmpeg -i <file>` with no output exits non-zero but prints the stream banner
  // (resolution, fps) to stderr — exactly what we parse. Ignore the exit code.
  const buf = await runFfmpegStderr(['-hide_banner', '-i', videoPath]);
  return parseMeta(buf);
}

function runFfmpegStderr(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(paths.ffmpegPath(), args);
    } catch {
      resolve('');
      return;
    }
    let buf = '';
    child.stdout.on('data', (b) => (buf += b.toString('utf8') + '\n'));
    child.stderr.on('data', (b) => (buf += b.toString('utf8') + '\n'));
    child.on('error', () => resolve(buf));
    child.on('close', () => resolve(buf));
  });
}

function parseMeta(stderr) {
  const videoLine = stderr.split('\n').find((l) => l.includes('Video:'));
  let width = null;
  let height = null;
  let fps = null;
  if (videoLine) {
    [width, height] = parseResolution(videoLine);
    fps = parseFps(videoLine);
  }
  return { fps, width, height };
}

// First `<digits>x<digits>` token (e.g. "1920x1080"), tolerating a trailing
// SAR/DAR suffix on the same comma-separated field.
function parseResolution(line) {
  for (const raw of line.split(/[, ]/)) {
    const tok = raw.trim();
    const m = tok.match(/^(\d+)x(\d+)$/);
    if (m) {
      const w = parseInt(m[1], 10);
      const h = parseInt(m[2], 10);
      if (w >= 16 && h >= 16) return [w, h];
    }
  }
  return [null, null];
}

// Number immediately preceding the `fps` token (e.g. "25 fps", "23.98 fps").
function parseFps(line) {
  const tokens = line
    .split(/[, ]/)
    .map((t) => t.trim())
    .filter((t) => t.length);
  const pos = tokens.indexOf('fps');
  if (pos <= 0) return null;
  const n = parseFloat(tokens[pos - 1]);
  return Number.isFinite(n) ? n : null;
}

module.exports = { probeVideoMetadata };
