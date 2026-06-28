// Resolve scripting bootstrap + availability probe (S-09 Phase 1). The native
// WorkflowIntegration.node bridge is handed in from main.js (it talks to Resolve
// in-process — no "External scripting" preference needed). The Resolve scripting
// API is fully ASYNC (every call returns a promise — see the SDK SamplePlugin),
// so bootstrap()/capability() await each step.
//
// `bootstrap()` runs Initialize -> GetResolve -> GetProjectManager ->
// GetCurrentProject and caches the handles. `capability()` reports availability +
// the live timeline frame rate so the renderer can seed `state.fps` (Modes C/D
// need the authoritative fps, NOT the default 25) and choose API-drive vs the
// S-08 file-export fallback. One detection point; everything degrades to
// file-export when Resolve is absent (Resolve Free / non-Studio / missing .node).
//
// The Mode D/C/A drive code (Phases 2/3/5) builds on the accessors below.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PLUGIN_ID = 'com.brave.reelsautomator';

// Render preset Mode A loads to export timeline audio as QuickTime / AAC 320 kbps
// CBR / 48 kHz. Only the Resolve UI can author AAC + CBR + bitrate (the scripting
// API has no key for them — verified against the API docs), so the preset is
// authored once in the UI; user render presets are GLOBAL across projects on a
// machine, so LoadRenderPreset(name) then works in every project. When the preset
// isn't installed yet we auto-import a bundled copy (`resolve-plugin/presets/`).
// Matched leniently by name (the bundled export is "Automator Render").
const RENDER_PRESET_RE = /automator/i;

let WI = null;
let resolveApp = null;
let projectManager = null;
let available = false;

/** @param {any} wi - the loaded WorkflowIntegration.node, or null */
function setWorkflowIntegration(wi) {
  WI = wi || null;
}

/** Probe Resolve once at boot; caches the API handles. @returns {Promise<void>} */
async function bootstrap() {
  available = false;
  resolveApp = null;
  projectManager = null;
  if (!WI || typeof WI.Initialize !== 'function') return;
  try {
    const ok = await WI.Initialize(PLUGIN_ID);
    if (!ok) return;
    resolveApp = await WI.GetResolve();
    if (!resolveApp) return;
    projectManager = await resolveApp.GetProjectManager();
    const project =
      projectManager && (await projectManager.GetCurrentProject());
    available = !!project;
  } catch {
    available = false;
  }
}

// Read the live timeline frame rate. The exact setting key is verified against
// the live WI scripting scope during manual verification (Phase 1 check 1.10).
async function timelineFps() {
  try {
    const project =
      projectManager && (await projectManager.GetCurrentProject());
    if (!project) return null;
    const timeline =
      typeof project.GetCurrentTimeline === 'function'
        ? await project.GetCurrentTimeline()
        : null;
    let raw = null;
    if (timeline && typeof timeline.GetSetting === 'function') {
      raw = await timeline.GetSetting('timelineFrameRate');
    }
    if (
      (raw === null || raw === undefined || raw === '') &&
      typeof project.GetSetting === 'function'
    ) {
      raw = await project.GetSetting('timelineFrameRate');
    }
    const fps = Number(raw);
    return Number.isFinite(fps) && fps > 0 ? fps : null;
  } catch {
    return null;
  }
}

/**
 * Capability verdict consumed by the renderer through the platform adapter.
 * @returns {Promise<{ available: boolean, fps: number|null }>}
 */
async function capability() {
  return { available, fps: available ? await timelineFps() : null };
}

// ── Mode D — reels → timeline (S-09 Phase 2) ──────────────────────────────────
//
// The renderer hands us a pure single-timeline clip + marker payload
// (`buildResolveTimeline` — 0-based, the regression-fenced Lua frame-math, NOT
// EDL whose `3600*fps` CMX offset would push every clip an hour into the
// timeline). Every reel lands on ONE timeline, separated by the inter-reel gap
// from settings (already folded into each clip's `recordFrame` by the builder).
// We create a dated Media-Pool subfolder, import the source media once, then
// build the timeline **directly via the live API** — `ImportTimelineFromFile`
// (FCPXML) was rejected live (errorCode 6 "Unable to import a timeline" in the WI
// scripting scope, regardless of importOptions). Direct construction is the
// proven S-08 Lua blueprint (`lua.js:44-185`). Every Resolve scripting call is
// async, so awaited.
//
// Sequence (research.md Area 4): GetCurrentProject -> GetMediaPool ->
// GetRootFolder -> AddSubFolder -> SetCurrentFolder -> ImportMedia([paths])
// (capture the MediaPoolItem) -> CreateEmptyTimeline(uniqueName) ->
// SetCurrentTimeline -> AppendToTimeline([{mediaPoolItem,startFrame,endFrame,
// recordFrame}]) -> per marker AddMarker(frame, color, label, "", 1, "").

/**
 * @param {{
 *   folderName: string,
 *   mediaPaths: string[],
 *   fps: number,
 *   timeline: import('../../src/exporters/resolve-payload.js').ResolveTimeline,
 * }} args
 * @returns {Promise<{ created: number, folder: string, timeline: string }>}
 */
async function createReels({ folderName, mediaPaths, timeline }) {
  if (!available || !projectManager) {
    throw new Error('Resolve API niedostępne');
  }
  if (!timeline || !Array.isArray(timeline.clips) || !timeline.clips.length) {
    throw new Error('Brak klipów do utworzenia timeline');
  }

  const project = await projectManager.GetCurrentProject();
  if (!project) throw new Error('Brak otwartego projektu');
  const mediaPool = await project.GetMediaPool();
  if (!mediaPool) throw new Error('Brak dostępu do Media Pool');

  // Dated subfolder under the root, then make it current so the imported media
  // and the timeline land inside it.
  const rootFolder = await mediaPool.GetRootFolder();
  const subFolder = await mediaPool.AddSubFolder(rootFolder, folderName);
  if (!subFolder) throw new Error('Nie można utworzyć folderu: ' + folderName);
  await mediaPool.SetCurrentFolder(subFolder);

  // Import the source media once into the current (dated) folder and capture the
  // MediaPoolItem every clip references (mirrors `lua.js:48-55`).
  let sourceItem = null;
  if (Array.isArray(mediaPaths) && mediaPaths.length) {
    const clipList = await mediaPool.ImportMedia(mediaPaths);
    sourceItem =
      Array.isArray(clipList) && clipList.length ? clipList[0] : null;
  }
  if (!sourceItem) {
    throw new Error('Nie można zaimportować pliku wideo do Media Pool');
  }

  // One timeline holding every reel, with a collision-free name.
  const { tl, name } = await createUniqueTimeline(
    mediaPool,
    project,
    timeline.name || 'Reels',
  );
  await project.SetCurrentTimeline(tl);

  // One AppendToTimeline batch — every span references the shared source item.
  // recordFrame is 0-based and already carries the inter-reel gaps.
  const clipInfo = timeline.clips.map((c) => ({
    mediaPoolItem: sourceItem,
    startFrame: c.startFrame,
    endFrame: c.endFrame,
    recordFrame: c.recordFrame,
  }));
  await mediaPool.AppendToTimeline(clipInfo);

  // hook/body/punchline markers across all reels at their 0-based timeline frames.
  for (const m of timeline.markers || []) {
    await tl.AddMarker(m.frame, m.color, m.label, '', 1, '');
  }

  return { created: 1, folder: folderName, timeline: name };
}

/**
 * Create an empty timeline with a collision-free name. Resolve's WI bridge
 * **rejects** a duplicate-name `CreateEmptyTimeline` with errorCode 6 ("Unable to
 * create a timeline") — it does NOT return null — so we first gather the existing
 * timeline names and pick a free "<base>", "<base>_2", … up front (mirror
 * `lua.js:88-98`), then create, still tolerating a late throw by bumping again.
 * @param {any} mediaPool
 * @param {any} project
 * @param {string} base - desired timeline name (the project name)
 * @returns {Promise<{ tl: any, name: string }>}
 */
async function createUniqueTimeline(mediaPool, project, base) {
  const existing = new Set();
  try {
    const count = Number(await project.GetTimelineCount()) || 0;
    for (let i = 1; i <= count; i++) {
      const tl = await project.GetTimelineByIndex(i);
      if (tl) existing.add(await tl.GetName());
    }
  } catch {
    // GetTimelineCount/GetTimelineByIndex unavailable — fall back to create-and-bump.
  }

  let suffix = 2;
  let name = base;
  while (existing.has(name)) name = `${base}_${suffix++}`;

  for (let tries = 0; tries < 1000; tries++) {
    try {
      const tl = await mediaPool.CreateEmptyTimeline(name);
      if (tl) return { tl, name };
    } catch {
      // Name taken (errorCode 6) or transient — bump the suffix and retry.
    }
    name = `${base}_${suffix++}`;
  }
  throw new Error('Nie można utworzyć timeline: ' + base);
}

// ── Mode C — transcript → subtitles track (S-09 Phase 3) ─────────────────────
//
// Resolve's scripting API exposes NO direct subtitle-item creation (verified
// 2026-06-27 against the live WI scope + the scripting reference):
// `ImportIntoTimeline` targets AAF/timeline files and `CreateSubtitlesFromAudio`
// re-transcribes the audio (discarding our WhisperX text — explicitly excluded by
// the plan). So the guaranteed path is to write our already-built 0-based `.srt`
// to a temp file and import it via the Media Pool, then append it onto a subtitle
// track. We try the Media-Pool import first (survives across Resolve versions)
// and fall back to `timeline.ImportIntoTimeline`, reporting which strategy worked
// so the Phase-3 manual check can document the live API surface. The SRT is
// 0-based (`transcript.js`) — never the EDL `3600*fps` CMX offset.

/**
 * Push the generated SRT onto the current timeline's subtitle track.
 * @param {{ srt: string }} args - the generated SRT text (0-based, no CMX offset)
 * @returns {Promise<{ imported: boolean, method: string }>}
 */
async function importSubtitles({ srt }) {
  if (!available || !projectManager) {
    throw new Error('Resolve API niedostępne');
  }
  if (typeof srt !== 'string' || !srt.trim()) {
    throw new Error('Brak napisów do wysłania');
  }

  const project = await projectManager.GetCurrentProject();
  if (!project) throw new Error('Brak otwartego projektu');
  const timeline =
    typeof project.GetCurrentTimeline === 'function'
      ? await project.GetCurrentTimeline()
      : null;
  if (!timeline) throw new Error('Brak aktywnej osi czasu');

  // Resolve reads the subtitles from a file on disk; cleaned up in `finally`.
  const tmpPath = path.join(os.tmpdir(), `reels-subtitles-${Date.now()}.srt`);
  await fs.promises.writeFile(tmpPath, srt, 'utf8');

  try {
    // Strategy 1 — Media Pool import + append. Importing an `.srt` yields a
    // subtitle MediaPoolItem; ensure a subtitle track exists, then append it.
    // The clip carries its own SRT timecodes, so it lands at the right frames.
    const mediaPool = await project.GetMediaPool();
    if (mediaPool) {
      let items = null;
      try {
        items = await mediaPool.ImportMedia([tmpPath]);
      } catch {
        items = null;
      }
      const subItem = Array.isArray(items) && items.length ? items[0] : null;
      if (subItem) {
        try {
          const count = Number(await timeline.GetTrackCount('subtitle')) || 0;
          if (count < 1) await timeline.AddTrack('subtitle');
        } catch {
          // GetTrackCount/AddTrack unavailable — let AppendToTimeline place it.
        }
        try {
          const appended = await mediaPool.AppendToTimeline([
            { mediaPoolItem: subItem },
          ]);
          if (appended) return { imported: true, method: 'media-pool' };
        } catch {
          // Append rejected — fall through to the direct timeline import.
        }
      }
    }

    // Strategy 2 — direct timeline import (older/edge versions). Historically
    // rejects `.srt` in the WI scope, but cheap to try before giving up.
    try {
      const ok = await timeline.ImportIntoTimeline(tmpPath, {});
      if (ok) return { imported: true, method: 'import-into-timeline' };
    } catch {
      // Both strategies exhausted below.
    }

    throw new Error(
      'Resolve odrzucił import napisów (brak bezpośredniego API napisów)',
    );
  } finally {
    fs.promises.unlink(tmpPath).catch(() => {});
  }
}

/**
 * Read the current timeline's In/Out marks. `GetMarkInOut()` returns frame
 * offsets from the timeline origin, e.g. `{video:{in:0,out:134}}` — the same
 * 0-based basis our SRT cues use, so the renderer can filter cues to the range
 * with no re-basing. Returns null when no In/Out is set (or the API is absent).
 * @returns {Promise<{ inFrame: number, outFrame: number } | null>}
 */
async function timelineInOut() {
  if (!available || !projectManager) return null;
  try {
    const project = await projectManager.GetCurrentProject();
    const timeline =
      project &&
      typeof project.GetCurrentTimeline === 'function' &&
      (await project.GetCurrentTimeline());
    if (!timeline || typeof timeline.GetMarkInOut !== 'function') return null;
    const mark = await timeline.GetMarkInOut();
    const v = mark && (mark.video || mark.audio);
    if (!v || typeof v.in !== 'number' || typeof v.out !== 'number')
      return null;
    if (v.in < 0 || v.out < 0 || v.out < v.in) return null;
    return { inFrame: v.in, outFrame: v.out };
  } catch {
    return null;
  }
}

// ── Mode A — collect active-timeline audio (S-09 Phase 5) ─────────────────────
//
// On the "Z osi czasu Resolve" button click we render the ACTIVE TIMELINE's audio
// MIX to a temp wav via the Resolve render API and feed it to the Phase-4
// transcription engine — no manual file picker. Render-to-file is the ONLY
// collect path: it captures the real timeline mix. We deliberately do NOT fall
// back to decoding Media-Pool source clips — on an edited/multi-clip timeline that
// yields source audio (wrong/partial transcription) with ambiguous clip order.
// When the render route is unavailable or fails, Mode A degrades to the existing
// manual file-import path (the renderer shows a Polish notice); it never silently
// decodes source media.
//
// The render honors the user's timeline In/Out marks (render only that range);
// with no marks set it renders the whole timeline. We render only OUR job (added,
// started by id, deleted in `finally`) and never touch the user's existing render
// queue (no DeleteAllRenderJobs).

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Find Resolve's built-in **"Audio Only"** render preset by its human-readable
 * name (case-insensitive) from the project's render-preset list, or null. Resolve
 * ships this factory preset on every install, so it's the guaranteed Linear-PCM
 * fallback. Never throws.
 * @param {any} project
 * @returns {Promise<string|null>}
 */
async function findBuiltinAudioOnlyPreset(project) {
  try {
    const l = await project.GetRenderPresetList();
    const names = Array.isArray(l) ? l.map(String) : [];
    return names.find((p) => /audio[\s_]*only/i.test(p)) || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the user's timeline In/Out into ABSOLUTE render MarkIn/MarkOut frames,
 * or null to render the whole timeline (no In/Out set / API absent). `GetMarkInOut`
 * may report 0-based offsets from the timeline origin OR absolute timeline frames
 * depending on the Resolve version, while render MarkIn/MarkOut are absolute
 * timeline frames — so we detect the basis against `GetStartFrame`/`GetEndFrame`
 * and normalize. Never throws.
 * @param {any} timeline
 * @returns {Promise<{ markIn: number, markOut: number } | null>}
 */
async function timelineRenderRange(timeline) {
  try {
    if (typeof timeline.GetMarkInOut !== 'function') return null;
    const mark = await timeline.GetMarkInOut();
    const v = mark && (mark.video || mark.audio);
    // Resolve OMITS the `in` field when the In point sits at frame 0 (observed
    // live: `{video:{out:9792}}`), so a missing `in` means 0, not "no range".
    if (!v || typeof v.out !== 'number') return null;
    const inOff = typeof v.in === 'number' ? v.in : 0;
    if (inOff < 0 || v.out < 0 || v.out < inOff) return null;

    const startRaw =
      typeof timeline.GetStartFrame === 'function'
        ? Number(await timeline.GetStartFrame())
        : 0;
    const endRaw =
      typeof timeline.GetEndFrame === 'function'
        ? Number(await timeline.GetEndFrame())
        : 0;
    const start = Number.isFinite(startRaw) && startRaw > 0 ? startRaw : 0;
    const end = Number.isFinite(endRaw) && endRaw > start ? endRaw : 0;

    // Already absolute when the marks sit inside [start, end] (and start > 0);
    // otherwise treat them as offsets from the timeline origin and add `start`.
    const looksAbsolute = start > 0 && inOff >= start && (!end || v.out <= end);
    const markIn = looksAbsolute ? inOff : start + inOff;
    const markOut = looksAbsolute ? v.out : start + v.out;
    return { markIn, markOut };
  } catch {
    return null;
  }
}

/** Newest file in `dir` whose name starts with `prefix` (absolute path), or null. */
function newestMatch(dir, prefix) {
  try {
    const entries = fs
      .readdirSync(dir)
      .filter((n) => n.startsWith(prefix))
      .map((n) => {
        const p = path.join(dir, n);
        let mtime = 0;
        try {
          mtime = fs.statSync(p).mtimeMs;
        } catch {
          /* skip unreadable entry */
        }
        return { p, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return entries.length ? entries[0].p : null;
  } catch {
    return null;
  }
}

/** Absolute path to the bundled "Automator" render-preset file, or null. */
function bundledPresetFile() {
  try {
    const dir = path.join(__dirname, '..', 'presets');
    const hit = fs.readdirSync(dir).find((n) => RENDER_PRESET_RE.test(n));
    return hit ? path.join(dir, hit) : null;
  } catch {
    return null;
  }
}

/**
 * Ensure the "Automator" render preset is available and return its exact name (or
 * null when it can't be made available). User render presets are global across
 * projects, so a one-time UI authoring shows up everywhere; if it isn't installed
 * on this machine yet, auto-import the bundled copy. NOTE: both LoadRenderPreset
 * and ImportRenderPreset RESET the render settings, so the caller must run this
 * BEFORE `SetRenderSettings`.
 * @param {any} project
 * @returns {Promise<string|null>}
 */
async function ensureRenderPreset(project) {
  const listNames = async () => {
    try {
      const l = await project.GetRenderPresetList();
      return Array.isArray(l) ? l.map(String) : [];
    } catch {
      return [];
    }
  };
  const find = (names) => names.find((p) => RENDER_PRESET_RE.test(p)) || null;

  let found = find(await listNames());
  if (found) return found;

  // Not installed on this machine — import the bundled preset file once.
  const presetFile = bundledPresetFile();
  if (presetFile) {
    const importer =
      typeof project.ImportRenderPreset === 'function'
        ? project
        : resolveApp && typeof resolveApp.ImportRenderPreset === 'function'
          ? resolveApp
          : null;
    if (importer) {
      try {
        await importer.ImportRenderPreset(presetFile);
      } catch {
        /* import failed — caller falls back to the built-in Audio Only preset */
      }
      found = find(await listNames());
      if (found) return found;
    }
  }
  return null;
}

/**
 * Render the active timeline's audio mix to a temp file (QuickTime/AAC via the
 * "Automator" render preset). Returns the absolute path on success; on any
 * unavailability/failure returns `{ ok: false, reason }` so the renderer degrades
 * to manual file import (never a blind source-clip decode).
 * @returns {Promise<{ ok: true, path: string } | { ok: false, reason: string }>}
 */
// The rendered WAV is RETURNED to the caller (it becomes the transcription input,
// consumed on a later, separate click), so it can't be deleted in this function's
// `finally` without racing the consumer. Instead, sweep any PRIOR run's output at
// the start of each collect: previous renders have already been transcribed (or
// abandoned) and are dead temp, so each Mode A click leaves at most one file
// behind rather than accumulating one per click. Never touches the dir we're about
// to create. Best-effort — a failed unlink just defers to the OS tmp reaper.
async function sweepStaleAudioDirs() {
  try {
    const tmp = os.tmpdir();
    const entries = await fs.promises.readdir(tmp);
    await Promise.all(
      entries
        .filter((name) => name.startsWith('reels-audio-'))
        .map((name) =>
          fs.promises
            .rm(path.join(tmp, name), { recursive: true, force: true })
            .catch(() => {}),
        ),
    );
  } catch {
    /* best-effort cleanup */
  }
}

async function collectTimelineAudio() {
  if (!available || !projectManager)
    return { ok: false, reason: 'unavailable' };
  let project = null;
  let jobId = null;
  try {
    await sweepStaleAudioDirs();
    project = await projectManager.GetCurrentProject();
    if (!project) return { ok: false, reason: 'no-project' };
    const timeline =
      typeof project.GetCurrentTimeline === 'function'
        ? await project.GetCurrentTimeline()
        : null;
    if (!timeline) return { ok: false, reason: 'no-timeline' };

    // The render API must be present in this WI scripting scope; if not, degrade
    // to manual import rather than guess at a source-clip decode.
    if (
      typeof project.SetRenderSettings !== 'function' ||
      typeof project.AddRenderJob !== 'function' ||
      typeof project.StartRendering !== 'function'
    ) {
      return { ok: false, reason: 'no-render-api' };
    }

    const tlName =
      (typeof timeline.GetName === 'function' && (await timeline.GetName())) ||
      'timeline';
    const safeName = String(tlName).replace(/[^A-Za-z0-9_-]/g, '_');
    const targetDir = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'reels-audio-'),
    );
    const customName = `reels_${safeName}_${Date.now()}`;

    // Format/codec come from the "Automator" render preset (QuickTime / AAC 320 kbps
    // CBR / 48 kHz) — only the UI can author AAC+CBR+bitrate, so we load the preset
    // rather than set them via scripting. LoadRenderPreset must run BEFORE
    // SetRenderSettings (it resets settings); SetRenderSettings below then overrides
    // only target/range.
    const presetName = await ensureRenderPreset(project);
    let presetLoaded = false;
    if (presetName && typeof project.LoadRenderPreset === 'function') {
      presetLoaded = (await project.LoadRenderPreset(presetName)) === true;
    }

    // Fallback when "Automator" isn't installed: Resolve's built-in **"Audio Only"**
    // preset, which renders Linear PCM (the path that worked before AAC was
    // requested) — a factory preset present on every install. The delivered file is
    // Linear PCM instead of AAC, but transcription is unaffected (it re-extracts to
    // 16 kHz mono regardless).
    if (!presetLoaded) {
      const audioOnly = await findBuiltinAudioOnlyPreset(project);
      if (audioOnly && typeof project.LoadRenderPreset === 'function') {
        presetLoaded = (await project.LoadRenderPreset(audioOnly)) === true;
      }
    }

    // Honor the user's In/Out marks — render only that range; render the whole
    // timeline only when no In/Out is set.
    const range = await timelineRenderRange(timeline);

    // Override only target + range with documented keys (TargetDir, CustomName,
    // ExportVideo/Audio, range) so the dict is never rejected. Format/codec/bitrate/
    // sample-rate come from the loaded preset; ExportVideo:false is insurance that
    // no video is encoded.
    const renderSettings = {
      TargetDir: targetDir,
      CustomName: customName,
      ExportVideo: false,
      ExportAudio: true,
    };
    if (range) {
      renderSettings.SelectAllFrames = false;
      renderSettings.MarkIn = range.markIn;
      renderSettings.MarkOut = range.markOut;
    } else {
      renderSettings.SelectAllFrames = true;
    }
    await project.SetRenderSettings(renderSettings);

    // Last resort only (neither preset loaded): nudge the sample rate to 48 kHz on
    // whatever the project's current format is. Skipped when a preset loaded (it
    // already owns the audio spec).
    if (!presetLoaded) {
      try {
        await project.SetRenderSettings({ AudioSampleRate: 48000 });
      } catch {
        /* best-effort */
      }
    }

    jobId = await project.AddRenderJob();
    if (!jobId) return { ok: false, reason: 'no-render-job' };

    const started = await project.StartRendering(jobId);
    if (started === false) return { ok: false, reason: 'render-start-failed' };

    // Poll until the render finishes. Cap the wait so a stuck job can't hang the
    // panel forever — audio-only renders complete quickly (600 × 500 ms = 5 min).
    for (let i = 0; i < 600; i++) {
      const inProgress =
        typeof project.IsRenderingInProgress === 'function'
          ? await project.IsRenderingInProgress()
          : false;
      if (!inProgress) break;
      await sleep(500);
    }

    if (typeof project.GetRenderJobStatus === 'function') {
      const status = await project.GetRenderJobStatus(jobId);
      const js = status && status.JobStatus;
      if (js && js !== 'Complete') {
        return { ok: false, reason: 'render-' + String(js).toLowerCase() };
      }
    }

    const out = newestMatch(targetDir, customName);
    if (!out) return { ok: false, reason: 'output-missing' };

    // The preset produced the QuickTime/AAC file directly — feed it straight to the
    // Phase-4 transcription engine (which re-extracts to 16 kHz mono regardless).
    return { ok: true, path: out };
  } catch (e) {
    return {
      ok: false,
      reason: 'error',
      message: String((e && e.message) || e),
    };
  } finally {
    // Remove only OUR job — never the user's other queued renders.
    if (jobId && project && typeof project.DeleteRenderJob === 'function') {
      try {
        await project.DeleteRenderJob(jobId);
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

// ── Accessors for the Mode C/A drive code (later phases) ──────────────────────
function getResolve() {
  return resolveApp;
}
function getProjectManager() {
  return projectManager;
}
function isAvailable() {
  return available;
}

module.exports = {
  setWorkflowIntegration,
  bootstrap,
  capability,
  createReels,
  importSubtitles,
  timelineInOut,
  collectTimelineAudio,
  getResolve,
  getProjectManager,
  isAvailable,
};
