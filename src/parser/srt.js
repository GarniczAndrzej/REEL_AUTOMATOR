export function parseTime(str) {
  const [h, m, s] = str.replace(',', '.').split(':');
  return +h * 3600 + +m * 60 + parseFloat(s);
}

// Drop-frame applies to 29.97 and 59.94 only. Exported as the single source of
// truth for the predicate, shared by edl.js (FCM line) and fcpxml.js (tcFormat).
export function isDropFrame(fps) {
  return Math.abs(fps - 29.97) < 0.02 || Math.abs(fps - 59.94) < 0.02;
}

export function framesToTC(frames, fps) {
  frames = Math.max(0, Math.floor(frames));

  if (isDropFrame(fps)) {
    // SMPTE drop-frame timecode. Nominal integer rate N (30 or 60);
    // D = frames dropped at the start of each non-10th minute (2 or 4).
    const N = Math.round(fps); // 30 or 60
    const D = N === 60 ? 4 : 2;
    const framesPer10Min = N * 600 - 9 * D; // frames in one 10-min DF block
    const framesPerHour = framesPer10Min * 6;

    const h = Math.floor(frames / framesPerHour);
    frames %= framesPerHour;
    const tens = Math.floor(frames / framesPer10Min);
    frames %= framesPer10Min;

    let units, s, f;
    if (frames < N * 60) {
      // First minute of the 10-min block — no drop
      units = 0;
      s = Math.floor(frames / N);
      f = frames % N;
    } else {
      // Minutes 1-9 of the block — each has N*60-D frames
      frames -= N * 60;
      const framesPerMin = N * 60 - D;
      units = Math.floor(frames / framesPerMin) + 1;
      frames %= framesPerMin;
      const fr = frames + D; // re-add the dropped frames to normalise position
      s = Math.floor(fr / N);
      f = fr % N;
    }

    const m = tens * 10 + units;
    // Semicolon separator denotes drop-frame (SMPTE 12M convention)
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')};${String(f).padStart(2, '0')}`;
  }

  // NDF — use rounded integer fps so fractional rates (e.g. 23.976) don't
  // produce fractional modulo results. 23.976 rounds to 24 NDF by convention.
  const N = Math.round(fps);
  const h = Math.floor(frames / (3600 * N));
  const m = Math.floor((frames % (3600 * N)) / (60 * N));
  const s = Math.floor((frames % (60 * N)) / N);
  const f = frames % N;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}:${String(f).padStart(2, '0')}`;
}

export function parseVTT(vttText, fps, minChars) {
  // Strip WEBVTT header and NOTE/STYLE/REGION blocks, then delegate to parseSRT logic
  const normalized = vttText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // Remove header line and any block metadata before the first cue
  const stripped = normalized
    .replace(/^WEBVTT[^\n]*\n/, '')
    .replace(/NOTE[^\n]*\n[\s\S]*?(?=\n\n)/g, '')
    .replace(/STYLE[\s\S]*?(?=\n\n)/g, '')
    .replace(/REGION[\s\S]*?(?=\n\n)/g, '');
  // VTT cues: optional cue id (non-arrow line), then timestamp line, then text
  // Timestamps use HH:MM:SS.mmm or MM:SS.mmm and may have positioning cue settings after -->
  const pattern =
    /(?:[^\n]+\n)?(\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3}) --> (\d{1,2}:\d{2}:\d{2}[.,]\d{3}|\d{2}:\d{2}[.,]\d{3})[^\n]*\n([\s\S]*?)(?=\n\n|$)/g;
  const matches = [...stripped.matchAll(pattern)];

  const sentences = [];
  let current = [];
  let startTime = null;
  let sentenceId = 1;

  matches.forEach((m, i) => {
    const start = m[1],
      end = m[2];
    const text = m[3]
      .replace(/\n/g, ' ')
      .trim()
      .replace(/<[^>]+>/g, '')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&nbsp;/g, ' ');
    if (!text) return;

    if (startTime === null) startTime = parseTime(start);
    current.push(text);

    const endsWithPunct = /[.?!]$/.test(text.trim());
    const isLast = i === matches.length - 1;

    if (endsWithPunct || isLast) {
      const full = current.join(' ').trim();
      if (full.length >= minChars) {
        const endTime = parseTime(end);
        const sf = Math.round(startTime * fps);
        const ef = Math.round(endTime * fps);
        sentences.push({
          id: sentenceId++,
          text: full,
          start_frame: sf,
          end_frame: ef,
          duration_frame: ef - sf,
          start_tc: framesToTC(sf, fps),
          end_tc: framesToTC(ef, fps),
        });
      }
      current = [];
      startTime = null;
    }
  });

  return sentences;
}

export function parseSRT(srtText, fps, minChars) {
  const normalized = srtText.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  // No `m` flag: `$` matches only end-of-string, so `\n*$` doesn't prematurely
  // terminate multi-line cue bodies at end-of-line.
  const pattern =
    /(\d+)\n(\d{2}:\d{2}:\d{2}[,\.]\d{3}) --> (\d{2}:\d{2}:\d{2}[,\.]\d{3})\n([\s\S]*?)(?=\n\n|$)/g;
  const matches = [...normalized.matchAll(pattern)];

  const sentences = [];
  let current = [];
  let startTime = null;
  let sentenceId = 1;

  matches.forEach((m, i) => {
    const start = m[2],
      end = m[3];
    const text = m[4]
      .replace(/\n/g, ' ')
      .trim()
      .replace(/<[^>]+>/g, '');
    if (!text) return;

    if (startTime === null) startTime = parseTime(start);
    current.push(text);

    const endsWithPunct = /[.?!]$/.test(text.trim());
    const isLast = i === matches.length - 1;

    if (endsWithPunct || isLast) {
      const full = current.join(' ').trim();
      if (full.length >= minChars) {
        const endTime = parseTime(end);
        const sf = Math.round(startTime * fps);
        const ef = Math.round(endTime * fps);
        sentences.push({
          id: sentenceId++,
          text: full,
          start_frame: sf,
          end_frame: ef,
          duration_frame: ef - sf,
          start_tc: framesToTC(sf, fps),
          end_tc: framesToTC(ef, fps),
        });
      }
      current = [];
      startTime = null;
    }
  });

  return sentences;
}
