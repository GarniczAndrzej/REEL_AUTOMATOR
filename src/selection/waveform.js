// In-memory cache: sentenceId → Float32Array of RMS peaks
const cache = new Map();

export function invalidateWaveform(sentenceId) {
  cache.delete(sentenceId);
}

export function cachedPeaks(sentenceId) {
  return cache.get(sentenceId) ?? null;
}

export async function loadWaveform(
  sentenceId,
  videoPath,
  startS,
  endS,
  numSamples,
) {
  if (cache.has(sentenceId)) return cache.get(sentenceId);
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    const raw = await invoke('extract_waveform', {
      videoPath,
      startS,
      endS,
      numSamples,
    });
    const peaks = new Float32Array(raw);
    cache.set(sentenceId, peaks);
    return peaks;
  } catch {
    return null;
  }
}

// Draw waveform bars on canvas.
// trimStartFrac / trimEndFrac (0–1): region inside the trim shows as accent colour;
// outside (trimmed-off) shows as dimmed grey.
export function drawWaveform(
  canvas,
  peaks,
  trimStartFrac = 0,
  trimEndFrac = 1,
) {
  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  const midY = h / 2;
  const n = peaks.length;
  for (let i = 0; i < w; i++) {
    const peakIdx = Math.min(Math.floor((i / w) * n), n - 1);
    const amplitude = peaks[peakIdx];
    const barH = Math.max(1, amplitude * h * 0.9);
    const frac = i / w;
    const inTrim = frac >= trimStartFrac && frac < trimEndFrac;
    ctx.fillStyle = inTrim
      ? 'rgba(255,255,255,0.85)'
      : 'rgba(120,120,120,0.30)';
    ctx.fillRect(i, midY - barH / 2, 1, barH);
  }
}
