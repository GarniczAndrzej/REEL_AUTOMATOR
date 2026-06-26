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

// ── Accessors for the Mode D/C/A drive code (later phases) ────────────────────
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
  getResolve,
  getProjectManager,
  isAvailable,
};
