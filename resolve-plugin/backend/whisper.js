// Node port of whisper.rs (S-09 Phase 4) — drives the bundled `whisperx-engine`
// onefile via child_process for in-panel transcription + forced alignment, with
// the same disciplines the Tauri path depends on:
//   - single global child (one transcription at a time) so a second run can't
//     orphan the first beyond cancel's reach;
//   - SIGTERM → 300 ms → SIGKILL reaper (a hard SIGKILL of the PyInstaller
//     bootloader orphans its torch worker and keeps stdout open);
//   - offline HF env on the non-diarize path (skips ~50 s of etag checks);
//   - the model/settings-aware v2 disk cache (a re-run of the same clip returns
//     instantly with the "Z cache! ⚡" marker).
// Node is event-driven (`stdout.on('data')`), so no 250 ms poll is needed — the
// reaper/mutex are the load-bearing parts to preserve.
//
// Command shapes mirror the Rust commands 1:1 (the renderer passes camelCase keys
// the adapter forwards verbatim); the result is the same
// `{ srt_content, words, segments, language }` payload the frontend reads.

const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const paths = require('./paths');
const events = require('./events');

// Engine/format cache version (matches whisper.rs `CACHE_VERSION`). Fresh
// Electron namespace, so no legacy whisper.cpp read-fallback is needed.
const CACHE_VERSION = 'v2';

// Sentinel prefix the frontend matches to tell a user cancel from a real failure.
const CANCELLED_MSG = 'ANULOWANO: Transkrypcja przerwana przez użytkownika.';

// Cap the retained stderr tail (chatty torch/ctranslate2/tqdm spew) so a long run
// can't grow the buffer without bound. 64 KB keeps ample diagnostic context.
const STDERR_TAIL_MAX_BYTES = 64 * 1024;

let whisperCallSeq = 0;

// Single global child + cancel flag (mirrors the Rust statics). A second
// concurrent run is rejected so cancel can always reach the in-flight child.
let transcribeChild = null;
let transcribeCancelled = false;

function ensureEngineFree() {
  if (transcribeChild) {
    throw new Error(
      'Transkrypcja już trwa. Poczekaj na jej zakończenie lub anuluj ją.',
    );
  }
}

// ── Hash + cache helpers (mirror whisper.rs) ─────────────────────────────────

/**
 * Video identity hash = SHA-256 of `size(u64 LE) || mtime_nanos(u128 LE) ||
 * first 1 MB`. Reproduces the Rust byte layout exactly (self-consistent within
 * the fresh Electron namespace, which is all the cache needs).
 * @param {string} filePath
 * @returns {string | null}
 */
function computeVideoHash(filePath) {
  try {
    const st = fs.statSync(filePath, { bigint: true });
    const h = crypto.createHash('sha256');
    const sizeBuf = Buffer.alloc(8);
    sizeBuf.writeBigUInt64LE(st.size);
    h.update(sizeBuf);
    const mtimeBuf = Buffer.alloc(16);
    mtimeBuf.writeBigUInt64LE(st.mtimeNs & 0xffffffffffffffffn, 0);
    mtimeBuf.writeBigUInt64LE(st.mtimeNs >> 64n, 8);
    h.update(mtimeBuf);
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(1024 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      h.update(buf.subarray(0, n));
    } finally {
      fs.closeSync(fd);
    }
    return h.digest('hex');
  } catch {
    return null;
  }
}

/**
 * Fold the full run signature into the video hash so re-running the SAME clip
 * with a DIFFERENT model/settings yields a DISTINCT cache entry (a fresh
 * transcription), not the previous run's result. Mirrors whisper.rs `variant_key`.
 * @param {string} videoHash @param {string} runSig @returns {string}
 */
function variantKey(videoHash, runSig) {
  const h = crypto.createHash('sha256');
  h.update(Buffer.from(videoHash, 'utf8'));
  h.update(Buffer.from([0]));
  h.update(Buffer.from(runSig, 'utf8'));
  return h.digest('hex');
}

/** Read a cached v2 payload, or null on any miss/error. @returns {object|null} */
function readCache(dir, v2Hash) {
  try {
    const text = fs.readFileSync(
      path.join(dir, CACHE_VERSION, `${v2Hash}.json`),
      'utf-8',
    );
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeCache(dir, v2Hash, payload) {
  try {
    const vdir = path.join(dir, CACHE_VERSION);
    fs.mkdirSync(vdir, { recursive: true });
    fs.writeFileSync(
      path.join(vdir, `${v2Hash}.json`),
      JSON.stringify(payload),
    );
  } catch {
    /* best-effort */
  }
}

// ── Progress + output shaping (mirror whisper.rs) ────────────────────────────

/** Map an engine `PROGRESS phase=… percent=…` reading onto a Polish label + the
 * overall bar (contiguous bands transcribe→align→diarize). */
function mapProgress(phase, pct) {
  const p = Math.min(Math.max(pct, 0), 100);
  switch (phase) {
    case 'transcribe':
      return [`Transkrypcja (WhisperX)… ${Math.trunc(p)}%`, 5 + p * 0.65];
    case 'align':
      return [`Dopasowanie słów… ${Math.trunc(p)}%`, 70 + p * 0.25];
    case 'diarize':
      return [`Rozpoznawanie mówców… ${Math.trunc(p)}%`, 95 + p * 0.05];
    default:
      return ['Przetwarzanie…', 5];
  }
}

function srtTimecode(sec) {
  const totalMs = Math.round(Math.max(sec, 0) * 1000);
  const ms = totalMs % 1000;
  const s = Math.trunc(totalMs / 1000) % 60;
  const m = Math.trunc(totalMs / 60000) % 60;
  const h = Math.trunc(totalMs / 3600000);
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** Build a plain SRT body from normalized engine segments (seconds → SRT TC). */
function buildSrtFromSegments(segments) {
  let out = '';
  let i = 0;
  for (const seg of segments) {
    const start = Number(seg.start) || 0;
    const end = seg.end != null ? Number(seg.end) : start;
    const text = (seg.text || '').trim();
    if (!text) continue;
    i += 1;
    out += `${i}\n`;
    out += `${srtTimecode(start)} --> ${srtTimecode(end)}\n`;
    out += `${text}\n\n`;
  }
  return out;
}

/** Flatten segment words into the legacy `[{text,start,end[,speaker]}]` shape. */
function flattenWords(segments) {
  const words = [];
  for (const seg of segments) {
    if (!Array.isArray(seg.words)) continue;
    for (const w of seg.words) {
      const text = (w.text || '').trim();
      const start = w.start;
      const end = w.end;
      if (
        text &&
        typeof start === 'number' &&
        typeof end === 'number' &&
        end >= start
      ) {
        const obj = { text, start, end };
        if (typeof w.speaker === 'string') obj.speaker = w.speaker;
        words.push(obj);
      }
    }
  }
  return words;
}

/** Translate an engine exit code into a distinct Polish error message. */
function engineErrorMessage(code, stderr) {
  switch (code) {
    case 10:
      return 'Model transkrypcji nie został znaleziony lub nie został jeszcze pobrany. Pobierz model w menedżerze modeli.';
    case 11:
      return 'Nie udało się zdekodować audio. Sprawdź plik źródłowy.';
    case 12:
      return 'Dopasowanie słów (alignment) nie powiodło się. Spróbuj ponownie lub zmień język.';
    case 13:
      return 'Rozpoznawanie mówców (diaryzacja) nie powiodło się. Sprawdź token Hugging Face i dostęp do modelu pyannote.';
    case 14:
      return 'Transkrypcja nie powiodła się. Sprawdź model i plik audio.';
    case 2:
      return 'Nieprawidłowe wywołanie silnika WhisperX (błąd argumentów).';
    default: {
      const tail = stderr.trim().split('\n').slice(-3).join(' | ');
      return `Silnik WhisperX zakończył się błędem. Szczegóły: ${tail}`;
    }
  }
}

// ── Model resolution (mirror models.rs helpers needed by transcribe) ─────────

function sanitizeModelId(id) {
  return String(id)
    .split('')
    .map((c) => (/[A-Za-z0-9._-]/.test(c) ? c : '_'))
    .join('');
}

function modelDir(modelId) {
  return path.join(paths.modelsRoot(), sanitizeModelId(modelId));
}

function isDownloaded(dir, sentinel) {
  const s = sentinel && sentinel.trim() ? sentinel : 'model.bin';
  try {
    return fs.statSync(path.join(dir, s)).isFile();
  } catch {
    return false;
  }
}

// ── Sidecar/ffmpeg child drivers ─────────────────────────────────────────────

/**
 * Run the bundled FFmpeg sidecar to completion, returning `{ ok }`. Pure
 * pass-through of args (the audio-extract call passes the same flags as
 * whisper.rs). stderr is captured but unused unless we need a message.
 * @param {string[]} args
 * @returns {Promise<{ ok: boolean }>}
 */
function runFfmpeg(args) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(paths.ffmpegPath(), args);
    } catch (e) {
      resolve({ ok: false });
      return;
    }
    child.on('error', () => resolve({ ok: false }));
    child.on('close', (code) => resolve({ ok: code === 0 }));
  });
}

/**
 * SIGTERM → 300 ms → SIGKILL escalation for the PyInstaller engine child. SIGTERM
 * first so the bootloader forwards it to the torch worker for a clean shutdown;
 * the hard kill is the fallback. Single reaper used by both the cancel path and
 * `cancel_transcription`.
 * @param {import('child_process').ChildProcess} child
 */
function reapEngineChild(child) {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    child.once('close', done);
    try {
      child.kill('SIGTERM');
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
      // Give the close event a beat; resolve regardless so cancel never hangs.
      setTimeout(done, 50);
    }, 300);
  });
}

/**
 * Register the spawned engine child, pump stdout (the JSON payload) + capped,
 * line-buffered stderr (emitting `transcribe-progress` per PROGRESS line) until
 * it terminates or the run is cancelled, then deregister. Returns the accumulated
 * stdout/stderr + exit code (`null` when cancelled/closed without a code).
 * @returns {Promise<{ stdout: string, stderr: string, code: number|null }>}
 */
function driveEngine(child) {
  transcribeChild = child;
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let stderrLine = '';
    let settled = false;

    const finish = async (code) => {
      if (settled) return;
      settled = true;
      const c = transcribeChild;
      transcribeChild = null;
      if (transcribeCancelled && c) {
        await reapEngineChild(c);
      }
      resolve({ stdout, stderr, code });
    };

    child.stdout.on('data', (b) => {
      stdout += b.toString('utf8');
    });

    child.stderr.on('data', (b) => {
      const chunk = b.toString('utf8');
      // Bound the retained stderr to a tail (S-21 OOM amplifier).
      stderr += chunk;
      if (stderr.length > STDERR_TAIL_MAX_BYTES) {
        stderr = stderr.slice(stderr.length - STDERR_TAIL_MAX_BYTES);
      }
      // Line-buffer to parse PROGRESS lines reliably.
      stderrLine += chunk;
      let nl;
      while ((nl = stderrLine.indexOf('\n')) !== -1) {
        const line = stderrLine.slice(0, nl).trimEnd();
        stderrLine = stderrLine.slice(nl + 1);
        if (line.startsWith('PROGRESS ')) {
          const rest = line.slice('PROGRESS '.length);
          let phase = '';
          let percent = 0;
          for (const tok of rest.split(/\s+/)) {
            if (tok.startsWith('phase=')) phase = tok.slice(6);
            else if (tok.startsWith('percent=')) {
              percent = parseFloat(tok.slice(8)) || 0;
            }
          }
          const [label, overall] = mapProgress(phase, percent);
          events.emit('transcribe-progress', {
            phase,
            label,
            percent: overall,
          });
        }
      }
    });

    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

/**
 * Prepend the bundled `ffmpeg` dir to `env.PATH` so the engine's internal
 * whisperx.load_audio finds an `ffmpeg` (Resolve's GUI PATH has none). No-op if
 * the symlink dir can't be prepared (the engine then falls back to a system
 * ffmpeg, if any).
 * @param {NodeJS.ProcessEnv} env @returns {NodeJS.ProcessEnv}
 */
function withFfmpegOnPath(env) {
  const dir = paths.ffmpegPathDir();
  if (dir) env.PATH = dir + path.delimiter + (env.PATH || '');
  return env;
}

function tmpPath(tag, ext) {
  return path.join(
    os.tmpdir(),
    `reel_${tag}_${process.pid}_${whisperCallSeq++}.${ext}`,
  );
}

// ── Commands ─────────────────────────────────────────────────────────────────

/**
 * Port of transcribe_video. The renderer forwards camelCase keys verbatim.
 * @returns {Promise<{srt_content:string,words:any[],segments:any[],language:string}>}
 */
async function transcribeVideo(args) {
  const {
    videoPath,
    modelPath,
    modelId,
    language,
    diarize: diarizeArg,
    hfToken,
    device,
    computeType,
    beamSize,
    initialPrompt,
    vadOnset,
    vadOffset,
    minSpeakers,
    maxSpeakers,
    kind,
    sentinel,
    punctuation,
  } = args;

  ensureEngineFree();

  const isCohere = kind === 'cohere-transformers';

  // Resolve the engine model path: a managed id → its downloaded local dir
  // (gated by the registry sentinel); a raw modelPath is a dev fallback.
  let model;
  if (modelId) {
    const dir = modelDir(modelId);
    const sent = sentinel && sentinel.trim() ? sentinel : 'model.bin';
    if (!isDownloaded(dir, sent)) {
      throw new Error(
        'Wybrany model nie został pobrany. Pobierz go w menedżerze modeli.',
      );
    }
    model = dir;
  } else if (modelPath) {
    model = modelPath;
  } else {
    throw new Error('Nie wybrano modelu transkrypcji.');
  }

  // Cohere does not diarize in this slice; force it off.
  const diarize = !!diarizeArg && !isCohere;
  const token = (hfToken || '').trim();
  if (diarize && !token) {
    throw new Error(
      'Diaryzacja jest włączona, ale brak tokenu Hugging Face. Wprowadź token lub wyłącz diaryzację.',
    );
  }

  transcribeCancelled = false;

  // ── Cache lookup (model/settings-aware) ────────────────────────────────────
  const runSigObj = {
    model,
    language,
    diarize,
    beam_size: beamSize ?? null,
    initial_prompt: initialPrompt ?? null,
    vad_onset: vadOnset ?? null,
    vad_offset: vadOffset ?? null,
    compute_type: computeType ?? null,
    device: device ?? null,
    min_speakers: minSpeakers ?? null,
    max_speakers: maxSpeakers ?? null,
  };
  if (isCohere) {
    runSigObj.engine = 'cohere';
    runSigObj.punctuation = punctuation ?? true;
  }
  const runSig = JSON.stringify(runSigObj);

  let cacheKey = null; // { dir, v2Hash }
  const videoHash = computeVideoHash(videoPath);
  if (videoHash) {
    const dir = paths.whisperCacheDir();
    try {
      fs.mkdirSync(dir, { recursive: true });
      cacheKey = { dir, v2Hash: variantKey(videoHash, runSig) };
    } catch {
      /* cache disabled this run */
    }
  }

  if (cacheKey) {
    const cached = readCache(cacheKey.dir, cacheKey.v2Hash);
    if (cached) {
      events.emit('transcribe-progress', {
        phase: 'done',
        label: 'Z cache! ⚡',
        percent: 100,
      });
      return cached;
    }
  }

  // ── Audio extraction (FFmpeg sidecar) ──────────────────────────────────────
  events.emit('transcribe-progress', {
    phase: 'audio_extract',
    label: 'Ekstrakcja audio…',
    percent: 0,
  });

  const wavPath = tmpPath('audio', 'wav');
  const { ok } = await runFfmpeg([
    '-y',
    '-i',
    videoPath,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    wavPath,
  ]);
  if (!ok) {
    throw new Error(
      'Nie udało się wyekstrahować audio z wideo. Sprawdź plik źródłowy.',
    );
  }
  if (transcribeCancelled) {
    await fsp.rm(wavPath, { force: true });
    throw new Error(CANCELLED_MSG);
  }

  // ── Drive the WhisperX engine sidecar ──────────────────────────────────────
  events.emit('transcribe-progress', {
    phase: 'transcribe',
    label: 'Transkrypcja (WhisperX)…',
    percent: 5,
  });

  const langArg = language === 'auto' ? 'auto' : language;
  const engineArgs = [
    '--audio',
    wavPath,
    '--model',
    model,
    '--language',
    langArg,
  ];
  if (isCohere) {
    engineArgs.push('--engine', 'cohere');
    engineArgs.push(
      (punctuation ?? true) ? '--punctuation' : '--no-punctuation',
    );
  }
  if (diarize) engineArgs.push('--diarize');
  pushAdvancedArgs(engineArgs, {
    device,
    computeType,
    beamSize,
    initialPrompt,
    vadOnset,
    vadOffset,
    minSpeakers,
    maxSpeakers,
  });
  const alignDir = paths.alignModelDir();
  if (alignDir) engineArgs.push('--align-model-dir', alignDir);

  // Non-diarize runs force HF offline (skips ~50 s of etag checks); diarize passes
  // the token via env (not argv, so it's not visible in `ps`). The engine's
  // whisperx.load_audio shells out to a bare `ffmpeg`, so prepend a dir holding an
  // `ffmpeg` symlink — Resolve's minimal GUI PATH has none (exit 11 otherwise).
  const env = withFfmpegOnPath({ ...process.env });
  if (diarize) {
    env.HF_TOKEN = token;
  } else {
    env.HF_HUB_OFFLINE = '1';
    env.TRANSFORMERS_OFFLINE = '1';
  }

  let child;
  try {
    child = spawn(paths.enginePath(), engineArgs, { env });
  } catch (e) {
    await fsp.rm(wavPath, { force: true });
    throw new Error(`Nie udało się uruchomić silnika WhisperX: ${e.message}`);
  }

  const { stdout, stderr, code } = await driveEngine(child);
  await fsp.rm(wavPath, { force: true });

  if (transcribeCancelled) throw new Error(CANCELLED_MSG);
  if (code !== 0) throw new Error(engineErrorMessage(code, stderr));

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (e) {
    throw new Error(`Niepoprawna odpowiedź silnika WhisperX: ${e.message}`);
  }
  const segments = Array.isArray(parsed.segments) ? parsed.segments : [];
  const payload = {
    srt_content: buildSrtFromSegments(segments),
    words: flattenWords(segments),
    segments,
    language: parsed.language || language,
  };

  events.emit('transcribe-progress', {
    phase: 'done',
    label: 'Gotowe!',
    percent: 100,
  });

  if (cacheKey) writeCache(cacheKey.dir, cacheKey.v2Hash, payload);
  return payload;
}

/** Append the advanced-settings flags the user actually set (mirror Rust). */
function pushAdvancedArgs(out, a) {
  const pushStr = (flag, v) => {
    if (typeof v === 'string' && v.trim()) out.push(flag, v);
  };
  const pushNum = (flag, v) => {
    if (v != null) out.push(flag, String(v));
  };
  pushStr('--device', a.device);
  pushStr('--compute-type', a.computeType);
  pushNum('--beam-size', a.beamSize);
  pushStr('--initial-prompt', a.initialPrompt);
  pushNum('--vad-onset', a.vadOnset);
  pushNum('--vad-offset', a.vadOffset);
  pushNum('--min-speakers', a.minSpeakers);
  pushNum('--max-speakers', a.maxSpeakers);
}

/**
 * Port of align_transcript (no transcription, no cache). Force-aligns an imported
 * transcript to the audio via the engine's `--align-only` mode.
 * @returns {Promise<{srt_content:string,words:any[],segments:any[],language:string}>}
 */
async function alignTranscript(args) {
  const { videoPath, transcript, language, isVtt, device } = args;

  ensureEngineFree();
  transcribeCancelled = false;

  const wavPath = tmpPath('align', 'wav');
  const ext = isVtt ? 'vtt' : 'srt';
  const transcriptPath = tmpPath('align', ext);
  await fsp.writeFile(transcriptPath, transcript, 'utf-8');

  const cleanup = async () => {
    await fsp.rm(wavPath, { force: true });
    await fsp.rm(transcriptPath, { force: true });
  };

  events.emit('transcribe-progress', {
    phase: 'audio_extract',
    label: 'Ekstrakcja audio…',
    percent: 0,
  });

  const { ok } = await runFfmpeg([
    '-y',
    '-i',
    videoPath,
    '-ar',
    '16000',
    '-ac',
    '1',
    '-c:a',
    'pcm_s16le',
    wavPath,
  ]);
  if (!ok) {
    await cleanup();
    throw new Error(
      'Nie udało się wyekstrahować audio z wideo. Sprawdź plik źródłowy.',
    );
  }

  // Forced alignment needs an explicit (per-language wav2vec2) language; the app
  // is Polish-first and the bundled align model is `pl`, so `auto` → `pl`.
  const langArg = language === 'auto' ? 'pl' : language;
  const alignArgs = [
    '--align-only',
    '--audio',
    wavPath,
    '--transcript',
    transcriptPath,
    '--language',
    langArg,
  ];
  if (typeof device === 'string' && device.trim()) {
    alignArgs.push('--device', device);
  }
  const alignDir = paths.alignModelDir();
  if (alignDir) alignArgs.push('--align-model-dir', alignDir);

  // Bare-`ffmpeg` on PATH for whisperx.load_audio (see transcribeVideo).
  const env = withFfmpegOnPath({
    ...process.env,
    HF_HUB_OFFLINE: '1',
    TRANSFORMERS_OFFLINE: '1',
  });

  let child;
  try {
    child = spawn(paths.enginePath(), alignArgs, { env });
  } catch (e) {
    await cleanup();
    throw new Error(`Nie udało się uruchomić silnika WhisperX: ${e.message}`);
  }

  const { stdout, stderr, code } = await driveEngine(child);
  await cleanup();

  if (transcribeCancelled) throw new Error(CANCELLED_MSG);
  if (code !== 0) throw new Error(engineErrorMessage(code, stderr));

  let parsed;
  try {
    parsed = JSON.parse(stdout.trim());
  } catch (e) {
    throw new Error(`Niepoprawna odpowiedź silnika WhisperX: ${e.message}`);
  }
  const segments = Array.isArray(parsed.segments) ? parsed.segments : [];

  events.emit('transcribe-progress', {
    phase: 'done',
    label: 'Gotowe!',
    percent: 100,
  });

  return {
    srt_content: buildSrtFromSegments(segments),
    words: flattenWords(segments),
    segments,
    language: parsed.language || language,
  };
}

/**
 * Mark the run cancelled, then reap the engine child only if we still hold it
 * (the window before `driveEngine` took ownership, or the no-driver case). Once
 * the driver owns the child it is the reaper; `transcribeChild` is null here and
 * we return cleanly — driver and command never both kill.
 */
async function cancelTranscription() {
  transcribeCancelled = true;
  const child = transcribeChild;
  transcribeChild = null;
  if (child) await reapEngineChild(child);
}

module.exports = {
  transcribeVideo,
  alignTranscript,
  cancelTranscription,
  // Exposed for unit smoke (node --check covers syntax; these stay internal).
  _internals: { buildSrtFromSegments, flattenWords, mapProgress, variantKey },
};
