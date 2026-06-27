// Node port of waveform.rs (S-09 Phase 4) — decode a clip span to mono PCM via
// the FFmpeg sidecar and return `numSamples` RMS-peak buckets for the clip-trim
// waveform UI, disk-cached as `<key>.bin`. The renderer (src/selection/waveform.js)
// gets a plain number[] it wraps in a Float32Array. Fresh Electron cache namespace.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const paths = require('./paths');

let waveformSeq = 0;

/**
 * @param {{ videoPath:string, startS:number, endS:number, numSamples:number }} args
 * @returns {Promise<number[]>}
 */
async function extractWaveform({ videoPath, startS, endS, numSamples }) {
  if (endS <= startS || !numSamples) {
    return new Array(numSamples || 0).fill(0);
  }

  const key = cacheKey(videoPath, startS, endS, numSamples);
  if (key) {
    const cached = path.join(key.dir, `${key.name}.bin`);
    try {
      const bytes = await fsp.readFile(cached);
      const peaks = bytesToF32(bytes);
      if (peaks.length === numSamples) return peaks;
    } catch {
      /* miss */
    }
  }

  const peaks = await extract(videoPath, startS, endS, numSamples);

  if (key) {
    try {
      await fsp.writeFile(
        path.join(key.dir, `${key.name}.bin`),
        f32ToBytes(peaks),
      );
    } catch {
      /* best-effort */
    }
  }
  return peaks;
}

// ── Cache helpers ────────────────────────────────────────────────────────────

function cacheKey(filePath, startS, endS, numSamples) {
  const dir = paths.waveformCacheDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    return null;
  }
  const srcHash = sourceHash(filePath);
  if (!srcHash) return null;
  const startMs = Math.round(startS * 1000);
  const endMs = Math.round(endS * 1000);
  return { dir, name: `${srcHash}_${startMs}_${endMs}_${numSamples}` };
}

function sourceHash(filePath) {
  try {
    const st = fs.statSync(filePath, { bigint: true });
    const h = crypto.createHash('sha256');
    const sizeBuf = Buffer.alloc(8);
    sizeBuf.writeBigUInt64LE(st.size);
    h.update(sizeBuf);
    const mtimeBuf = Buffer.alloc(8);
    mtimeBuf.writeBigUInt64LE(st.mtimeNs / 1000000000n);
    h.update(mtimeBuf);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(1024 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      h.update(buf.subarray(0, n));
    } finally {
      fs.closeSync(fd);
    }
    return h.digest('hex').slice(0, 16);
  } catch {
    return null;
  }
}

function bytesToF32(bytes) {
  const out = [];
  for (let i = 0; i + 4 <= bytes.length; i += 4) {
    out.push(bytes.readFloatLE(i));
  }
  return out;
}

function f32ToBytes(peaks) {
  const buf = Buffer.alloc(peaks.length * 4);
  peaks.forEach((v, i) => buf.writeFloatLE(v, i * 4));
  return buf;
}

// ── Extraction ────────────────────────────────────────────────────────────────

function extract(videoPath, startS, endS, numSamples) {
  const duration = endS - startS;
  let sr = Math.ceil(numSamples / duration);
  sr = Math.max(sr, 100);

  const rawPath = path.join(
    os.tmpdir(),
    `reel_waveform_${process.pid}_${waveformSeq++}.raw`,
  );

  const args = [
    '-y',
    '-ss',
    startS.toFixed(6),
    '-to',
    endS.toFixed(6),
    '-i',
    videoPath,
    '-ac',
    '1',
    '-ar',
    String(sr),
    '-f',
    'f32le',
    '-vn',
    rawPath,
  ];

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(paths.ffmpegPath(), args);
    } catch {
      resolve(new Array(numSamples).fill(0));
      return;
    }
    child.on('error', () => resolve(new Array(numSamples).fill(0)));
    child.on('close', () => {
      let rawBytes;
      try {
        rawBytes = fs.readFileSync(rawPath);
      } catch {
        resolve(new Array(numSamples).fill(0));
        return;
      }
      fs.rm(rawPath, { force: true }, () => {});

      const total = Math.floor(rawBytes.length / 4);
      if (total === 0) {
        resolve(new Array(numSamples).fill(0));
        return;
      }
      const samples = new Float32Array(total);
      for (let i = 0; i < total; i++) samples[i] = rawBytes.readFloatLE(i * 4);

      const n = numSamples;
      const peaks = new Array(n);
      for (let i = 0; i < n; i++) {
        const lo = Math.floor((i * total) / n);
        const hi = Math.min(
          Math.max(Math.floor(((i + 1) * total) / n), lo + 1),
          total,
        );
        let sum = 0;
        for (let j = lo; j < hi; j++) sum += samples[j] * samples[j];
        const rms = Math.sqrt(sum / (hi - lo));
        peaks[i] = Math.min(rms, 1.0);
      }
      resolve(peaks);
    });
  });
}

module.exports = { extractWaveform };
