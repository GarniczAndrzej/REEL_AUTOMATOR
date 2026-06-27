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
  getResolve,
  getProjectManager,
  isAvailable,
};
