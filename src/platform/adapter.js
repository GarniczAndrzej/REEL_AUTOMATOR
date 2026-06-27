// Platform adapter (S-09) — the single host-detection + dispatch point for every
// backend call the shared frontend makes. It replaces the old implicit probe
// ("`await import('@tauri-apps/api/core')` throws ⇒ not in Tauri ⇒ silently
// no-op"), which broke under Electron: there the dynamic import RESOLVES (the dep
// is bundled) but the Tauri IPC isn't present, so cache.js / api-key.js /
// video-meta.js would have silently failed.
//
// Three hosts:
//   - Electron (DaVinci Resolve WI panel): preload.js exposes `window.bridge`.
//   - Tauri (the desktop app): no `window.bridge`; `@tauri-apps/api` resolves.
//   - Browser (plain `vite` dev): no `window.bridge`; `@tauri-apps/api` throws.
//
// Detection is explicit and cheap: presence of `window.bridge` ⇒ Electron;
// otherwise we lazily import the Tauri API (preserving the exact Tauri-vs-browser
// degrade semantics the old call sites relied on). Behavior under Tauri is
// unchanged — every Tauri path below is byte-for-byte the prior lazy-import.

/**
 * The Electron bridge exposed by preload.js, or undefined under Tauri/browser.
 * @returns {undefined | {
 *   invoke: (command: string, args?: object) => Promise<any>,
 *   on: (channel: string, listener: (payload: any) => void) => () => void,
 *   dialog: {
 *     open: (opts?: object) => Promise<string|string[]|null>,
 *     save: (opts?: object) => Promise<string|null>,
 *     ask: (message: string, opts?: object) => Promise<boolean>,
 *   },
 * }}
 */
function bridge() {
  return typeof window !== 'undefined' ? window.bridge : undefined;
}

/**
 * True when running inside the Electron WI panel (a `window.bridge` is present).
 * Synchronous — safe for capability gating in render paths.
 * @returns {boolean}
 */
export function isElectron() {
  return !!bridge();
}

/**
 * Resolve a backend invoke function for the current host, or `null` when there
 * is no backend at all (plain browser dev). Mirrors the old
 * `await import('@tauri-apps/api/core')` → invoke-or-null contract used by the
 * degrade-tolerant layers (cache.js / api-key.js).
 * @returns {Promise<((command: string, args?: object) => Promise<any>) | null>}
 */
export async function getInvoke() {
  const b = bridge();
  if (b) return (command, args) => b.invoke(command, args);
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    return invoke;
  } catch {
    return null; // plain browser dev — no backend
  }
}

/**
 * Invoke a backend command. Throws when no backend is present — callers that need
 * to degrade gracefully (no-op outside Tauri/Electron) should use `getInvoke()`
 * and null-check instead.
 * @param {string} command - backend command name (matches the Tauri Rust command)
 * @param {object} [args] - command arguments
 * @returns {Promise<any>} the command's return value (same shape as Tauri's)
 */
export async function invoke(command, args) {
  const inv = await getInvoke();
  if (!inv) throw new Error(`[adapter] no backend available for "${command}"`);
  return inv(command, args);
}

// ── Native dialogs (return shapes mirror @tauri-apps/plugin-dialog) ──────────

/**
 * Native open dialog (file or directory). Returns the chosen path, an array when
 * `multiple`, or `null` when cancelled — the @tauri-apps/plugin-dialog contract.
 * @param {object} [options]
 * @returns {Promise<string|string[]|null>}
 */
export async function dialogOpen(options) {
  const b = bridge();
  if (b) return b.dialog.open(options);
  const { open } = await import('@tauri-apps/plugin-dialog');
  return open(options);
}

/**
 * Native save dialog. Returns the chosen path or `null` when cancelled.
 * @param {object} [options]
 * @returns {Promise<string|null>}
 */
export async function dialogSave(options) {
  const b = bridge();
  if (b) return b.dialog.save(options);
  const { save } = await import('@tauri-apps/plugin-dialog');
  return save(options);
}

/**
 * Native confirm dialog. Resolves `true` when the user accepts.
 * @param {string} message
 * @param {object} [options] - { title, kind, okLabel, cancelLabel }
 * @returns {Promise<boolean>}
 */
export async function dialogAsk(message, options) {
  const b = bridge();
  if (b) return b.dialog.ask(message, options);
  const { ask } = await import('@tauri-apps/plugin-dialog');
  return ask(message, options);
}

// ── Progress events (mirrors @tauri-apps/api/event `listen`) ─────────────────

/**
 * Subscribe to a backend progress event. Returns an `unlisten()` function — the
 * same contract callers store and invoke in a `finally` block. Under Electron the
 * raw payload is re-wrapped as the Tauri-shaped `{ payload }` so handlers are
 * host-agnostic.
 * @param {string} channel - e.g. 'transcribe-progress', 'model-download-progress'
 * @param {(event: { payload: any }) => void} handler
 * @returns {Promise<() => void>} the unlisten function
 */
export async function listen(channel, handler) {
  const b = bridge();
  if (b) return b.on(channel, (payload) => handler({ payload }));
  const { listen: tauriListen } = await import('@tauri-apps/api/event');
  return tauriListen(channel, handler);
}

// ── Path join (mirrors @tauri-apps/api/path `join`) ──────────────────────────

/**
 * Join path segments using the host's path semantics. Async in both hosts
 * (Tauri's `join` is async; the Electron bridge round-trips to Node `path.join`).
 * @param {...string} parts
 * @returns {Promise<string>}
 */
export async function pathJoin(...parts) {
  const b = bridge();
  if (b) return b.invoke('path_join', { parts });
  const { join } = await import('@tauri-apps/api/path');
  return join(...parts);
}

// ── Resolve capability (DaVinci Resolve WI panel only) ───────────────────────

/** @typedef {{ available: boolean, fps: number|null }} ResolveCapability */

/** @type {ResolveCapability | undefined} memoized per session */
let _resolveCap;

/**
 * Probe the host for DaVinci Resolve scripting availability + the live timeline
 * frame rate. Memoized for the session. Under Tauri/browser (no Resolve host)
 * this resolves to `{ available: false, fps: null }` so the renderer keeps the
 * S-08 file-export behavior. The renderer uses `available` to choose API-drive
 * vs file-write and `fps` to seed `state.fps` before any export.
 * @returns {Promise<ResolveCapability>}
 */
export async function resolveCapability() {
  if (_resolveCap !== undefined) return _resolveCap;
  const inv = await getInvoke();
  if (!inv) return (_resolveCap = { available: false, fps: null });
  try {
    _resolveCap = await inv('resolve_capability', {});
  } catch {
    // Not the Resolve WI host (e.g. the Tauri app has no such command).
    _resolveCap = { available: false, fps: null };
  }
  return _resolveCap;
}

/**
 * Mode D (S-09 Phase 2): drive the Resolve scripting API to create a dated
 * Media-Pool folder with a single timeline holding every reel (separated by the
 * inter-reel gap from settings — same layout as the Lua export). The renderer
 * hands over a pure, 0-based clip + marker payload (`buildResolveTimeline` — the
 * regression-fenced Lua frame-math, NOT the EDL `3600*fps` CMX offset that would
 * push every clip an hour into the timeline); the Electron backend drives the
 * live API directly (`ImportMedia` → `CreateEmptyTimeline` → `AppendToTimeline` →
 * `AddMarker`) — no temp files, no FCPXML (`ImportTimelineFromFile` was rejected
 * live, errorCode 6). Electron WI host only — guarded by the caller on
 * `resolveCapability().available`.
 * @param {{
 *   folderName: string,
 *   mediaPaths: string[],
 *   fps: number,
 *   timeline: import('../exporters/resolve-payload.js').ResolveTimeline,
 * }} payload
 * @returns {Promise<{ created: number, folder: string, timeline: string }>}
 */
export async function resolveCreateReels(payload) {
  return invoke('resolve_create_reels', payload);
}

/**
 * Mode C (S-09 Phase 3): push the already-built 0-based `.srt` onto the current
 * Resolve timeline's subtitle track. Resolve's scripting API has no direct
 * subtitle-item creation, so the backend writes the SRT to a temp file and
 * imports it via the Media Pool (`timeline.ImportIntoTimeline` fallback) — never
 * `CreateSubtitlesFromAudio` (it re-transcribes and discards our text). 0-based,
 * no CMX offset. Electron WI host only — guarded by the caller on
 * `resolveCapability().available`.
 * @param {{ srt: string }} payload - the generated SRT text
 * @returns {Promise<{ imported: boolean, method: string }>}
 */
export async function resolveImportSubtitles(payload) {
  return invoke('resolve_import_subtitles', payload);
}
