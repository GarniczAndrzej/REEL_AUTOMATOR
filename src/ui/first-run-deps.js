// First-run dependency setup (S-29 Phase 4). Thin-installer companion: on first
// launch the heavy native deps (CUDA/CPU WhisperX engine, FFmpeg, wav2vec2 align
// models) are NOT bundled — this surface reports detected hardware + the
// auto-picked variant (with a manual override), offers the deps-location picker,
// and downloads each required dependency with live per-artifact %/speed/ETA.
//
// It is DISMISSABLE ("Pomiń na razie") and gates ONLY transcription: import,
// SRT-paste, and export work with no deps. It reuses the model-manager progress
// pattern from `import/transcribe.js` (the `dep-download-progress` event mirrors
// `model-download-progress`, keyed by `id`). All strings are Polish.
//
// Readiness stays off the launch path (S-18): the auto-open decision and the
// transcription gate consult spawn-free presence/version reads
// (`variant_satisfied`, `deps_status`), never a sidecar spawn.
//
// S-30 made the auto-open VARIANT-aware. It used to consult `transcription_ready`,
// which is true as soon as *any* engine resolves — so a GPU box holding only the
// CPU engine was judged provisioned and never offered the GPU engine it should be
// running. It now consults `variant_satisfied` ("is the engine this hardware
// deserves actually resolvable"), while the transcribe button stays gated by
// `transcription_ready` ("can this machine transcribe at all"). The two answers
// deliberately differ: that box gets nagged AND keeps a working transcribe button.

import { toast } from './toast.js';
import { invoke, getInvoke, listen, dialogOpen } from '../platform/adapter.js';

// A dismissal ("Pomiń na razie") is scoped to the state it was made in: the deps
// `specVersion` and the resolved hardware variant. Either changing underneath the
// user re-opens the window exactly once. The old value was a bare `'1'` that never
// expired, permanently muting the nag even after the dep set or the machine changed.
const DISMISS_LS_KEY = 'edl_deps_setup_dismissed';

/** @typedef {{specVersion:number, variant:string}} DismissRecord */
/** @typedef {{vendor:string, name:string, vramBytes:number, computeCap:string|null, driverVersion:string|null, cudaUsable:boolean, variant:string, reason:string}} GpuInfo */

/** @type {import('../deps/deps-spec.js').Dependency[]} */
let _specDeps = [];
/** @type {Record<string, {id:string,kind:string,required:boolean,present:boolean,stale:boolean,sizeBytes:number,stagedPath?:string}>} */
let _statusById = {};
/** @type {string|null} id of the dependency currently downloading (single-flight) */
let _downloadingId = null;
/** @type {Set<string>} ids whose last download attempt failed — their button reads "Ponów" */
const _failedIds = new Set();
let _progressWired = false;
/** @type {DismissRecord|null} the state a dismissal would be scoped to, from the last refresh */
let _dismissState = null;

/**
 * Wire the first-run setup modal: open/close/skip, the variant override, the
 * deps-location picker, the download buttons, and the persistent
 * `dep-download-progress` listener. Auto-opens on first launch when a backend is
 * present, the screen was not dismissed for the CURRENT `{specVersion, variant}`,
 * and the resolved variant's engine is not yet provisioned. Call once on boot.
 * @returns {Promise<void>}
 */
export async function initFirstRunDeps() {
  const modal = document.getElementById('firstRunDepsModal');
  if (!modal) return;

  const openBtn = document.getElementById('depsSetupBtn');
  if (openBtn) openBtn.addEventListener('click', () => openFirstRunDeps());
  const closeBtn = document.getElementById('firstRunDepsClose');
  if (closeBtn) closeBtn.addEventListener('click', closeFirstRunDeps);
  const skipBtn = document.getElementById('firstRunDepsSkip');
  if (skipBtn)
    skipBtn.addEventListener('click', async () => {
      await persistDismissal();
      closeFirstRunDeps();
    });
  modal.addEventListener('click', (e) => {
    if (e.target === modal) closeFirstRunDeps();
  });

  const variantSel = document.getElementById('depsVariantSelect');
  if (variantSel)
    variantSel.addEventListener('change', () =>
      applyVariantOverride(variantSel.value),
    );
  const changeLocBtn = document.getElementById('depsChangeLocationBtn');
  if (changeLocBtn) changeLocBtn.addEventListener('click', changeDepsLocation);
  const downloadAllBtn = document.getElementById('depsDownloadAllBtn');
  if (downloadAllBtn)
    downloadAllBtn.addEventListener('click', downloadAllMissing);

  await wireProgress();
  await maybeAutoOpen();
}

/**
 * Attach the persistent `dep-download-progress` listener once. The payload
 * mirrors `model-download-progress` but is keyed by dependency `id`; a `done`
 * flag marks completion. Drives both the `%· MB/s · ETA` text and the determinate
 * bar (mirroring `#whisperProgressBox`). No-op outside Tauri/Electron.
 * @returns {Promise<void>}
 */
async function wireProgress() {
  if (_progressWired) return;
  try {
    await listen('dep-download-progress', (e) => {
      const p = e.payload || {};
      const el = document.getElementById('dep-progress-' + cssId(p.id));
      if (!el) return;
      const fill = document.getElementById('dep-bar-fill-' + cssId(p.id));
      if (p.done) {
        el.textContent = 'Pobrano i zweryfikowano';
        if (fill) fill.style.width = '100%';
        return;
      }
      const pct = Math.round(p.percent || 0);
      const mb = ((p.bytesPerSec || 0) / 1024 / 1024).toFixed(1);
      const eta = p.etaSec ? `${Math.round(p.etaSec)}s` : '—';
      el.textContent = `${pct}% · ${mb} MB/s · ETA ${eta}`;
      if (fill) fill.style.width = `${pct}%`;
    });
    _progressWired = true;
  } catch (e) {
    // No backend (plain browser dev) — progress events never fire; the modal
    // simply never auto-opens (see maybeAutoOpen).
  }
}

/**
 * Auto-open the setup screen: only when a backend exists, the RESOLVED variant's
 * engine (plus FFmpeg) is not yet provisioned, and the user has not dismissed the
 * window for this exact `{specVersion, variant}`. Never blocks first paint — all
 * reads are spawn-free (S-18).
 *
 * `variant_satisfied` — not `transcription_ready` — is the gate. A GPU box holding
 * only the CPU engine transcribes fine (so its button stays enabled) but is NOT
 * running the engine its hardware deserves, so it gets the window.
 * @returns {Promise<void>}
 */
async function maybeAutoOpen() {
  const inv = await getInvoke();
  if (!inv) return; // plain browser dev — no deps machinery
  try {
    const [spec, variant, satisfied] = await Promise.all([
      invoke('load_deps_spec'),
      invoke('get_variant'),
      invoke('variant_satisfied'),
    ]);
    _dismissState = {
      specVersion: Number(spec && spec.specVersion) || 0,
      variant: String(variant || ''),
    };
    if (satisfied) return; // the engine this hardware deserves is already there
    if (isDismissedFor(_dismissState)) return;
  } catch (e) {
    return; // can't tell → don't nag
  }
  openFirstRunDeps();
}

/**
 * Parse a stored dismissal. A legacy literal `'1'` (and any unparseable value) is a
 * dismissal for an UNKNOWN state, read as `{specVersion: 0, variant: ''}` — which
 * never matches a live record, so the window re-opens exactly once after the upgrade
 * and is then re-stored in the new shape. This is intentional: `specVersion` went
 * 1 → 2 in S-30 precisely so every existing install re-evaluates once.
 * @param {string} raw
 * @returns {DismissRecord}
 */
function parseDismissRecord(raw) {
  const UNKNOWN = { specVersion: 0, variant: '' };
  let o;
  try {
    o = JSON.parse(raw);
  } catch (e) {
    return UNKNOWN;
  }
  // The legacy value is the literal `'1'`, which parses to the NUMBER 1 — not a
  // throw, and not a record. Anything that is not an object is an unknown state.
  if (!o || typeof o !== 'object') return UNKNOWN;
  return {
    specVersion: Number(o.specVersion) || 0,
    variant: String(o.variant || ''),
  };
}

/**
 * Was the window dismissed for exactly the current state? Either the dep set
 * (`specVersion`) or the machine's resolved variant changing re-opens it once.
 * @param {DismissRecord} current
 * @returns {boolean}
 */
function isDismissedFor(current) {
  let raw = null;
  try {
    raw = localStorage.getItem(DISMISS_LS_KEY);
  } catch (e) {
    return false;
  }
  if (!raw) return false;
  const rec = parseDismissRecord(raw);
  return (
    rec.specVersion === current.specVersion && rec.variant === current.variant
  );
}

/**
 * Record a "Pomiń na razie" against the state it was made in. When that state
 * cannot be read, write nothing — a dismissal we cannot scope is one we cannot
 * honor, and re-nagging next launch beats muting the window forever.
 * @returns {Promise<void>}
 */
async function persistDismissal() {
  let rec = _dismissState;
  if (!rec) {
    try {
      const [spec, variant] = await Promise.all([
        invoke('load_deps_spec'),
        invoke('get_variant'),
      ]);
      rec = {
        specVersion: Number(spec && spec.specVersion) || 0,
        variant: String(variant || ''),
      };
    } catch (e) {
      return;
    }
  }
  try {
    localStorage.setItem(DISMISS_LS_KEY, JSON.stringify(rec));
  } catch (e) {}
}

/**
 * Reveal the setup modal and (re)render its contents from live backend state.
 * @returns {void}
 */
export function openFirstRunDeps() {
  const modal = document.getElementById('firstRunDepsModal');
  if (!modal) return;
  modal.style.display = 'flex';
  refreshDepsView();
}

function closeFirstRunDeps() {
  const modal = document.getElementById('firstRunDepsModal');
  if (modal) modal.style.display = 'none';
}

/**
 * Load the active spec + per-dependency status + deps root + free/required space
 * + the current/overridden variant + the hardware profile, then paint the hardware
 * panel, the variant dropdown, the location line, and the dependency list. Tolerant
 * of a missing backend.
 * @returns {Promise<void>}
 */
async function refreshDepsView() {
  const listEl = document.getElementById('depsList');
  const inv = await getInvoke();
  if (!inv) {
    if (listEl)
      listEl.innerHTML =
        '<div style="font-size:12px;color:var(--text3)">Zarządzanie zależnościami jest dostępne tylko w aplikacji desktopowej.</div>';
    return;
  }
  try {
    const [spec, statuses, root, space, variant, override, hw] =
      await Promise.all([
        invoke('load_deps_spec'),
        invoke('deps_status'),
        invoke('get_deps_root'),
        invoke('deps_root_space'),
        invoke('get_variant'),
        invoke('get_variant_override'),
        invoke('gpu_info'),
      ]);
    _specDeps = (spec && spec.dependencies) || [];
    _statusById = {};
    for (const s of statuses || []) _statusById[s.id] = s;
    // Keep the dismissal scope in step with what is on screen: changing the
    // variant override re-renders through here, and a dismissal must be recorded
    // against the state the user is actually looking at.
    _dismissState = {
      specVersion: Number(spec && spec.specVersion) || 0,
      variant: String(variant || ''),
    };
    renderHardware(hw);
    renderVariant(variant, override);
    renderLocation(root, space);
    renderDepsList();
  } catch (e) {
    if (listEl)
      listEl.innerHTML = `<div style="font-size:12px;color:var(--amber)">Nie można wczytać stanu zależności: ${escHtml(String(e))}</div>`;
  }
}

/**
 * Paint the detected-hardware panel: the card, its VRAM, its driver, and the Polish
 * `reason` explaining which variant was picked and why. `reason` is authored in Rust
 * (`deps.rs::gpu_info`) — it is the single sentence that covers every branch
 * (NVIDIA above/below the driver floor, AMD, Intel, no GPU, an override, a persisted
 * "GPU unusable" demotion), so this function never re-derives it.
 * @param {GpuInfo|null|undefined} hw
 * @returns {void}
 */
function renderHardware(hw) {
  const el = document.getElementById('depsHardwareInfo');
  if (!el) return;
  if (!hw) {
    el.textContent = 'Nie udało się wykryć sprzętu.';
    return;
  }
  const name =
    hw.vendor === 'none' || !hw.name ? 'Nie wykryto karty graficznej' : hw.name;
  /** @type {string[]} */
  const facts = [];
  if (hw.vramBytes) facts.push(`Pamięć: ${fmtBytes(hw.vramBytes)}`);
  if (hw.driverVersion) facts.push(`Sterownik: ${escHtml(hw.driverVersion)}`);
  if (hw.computeCap)
    facts.push(`Compute capability: ${escHtml(hw.computeCap)}`);
  el.innerHTML = `
<div style="color:var(--text1);font-size:13px;margin-bottom:4px">${escHtml(name)}</div>
${facts.length ? `<div style="color:var(--text3);font-size:11px;margin-bottom:6px">${facts.join(' · ')}</div>` : ''}
<div>${escHtml(hw.reason || '')}</div>`;
}

/**
 * Paint the variant dropdown selection + the "detected" note. The dropdown offers only
 * `gpu`/`cpu`: `gpu-full` is reachable from `REEL_ENGINE_VARIANT` alone, so it can be
 * the effective variant while the dropdown reads "Automatyczny".
 * @param {string} variant effective variant (`gpu`|`gpu-full`|`cpu`)
 * @param {string} override persisted UI override (`gpu`|`cpu`|'')
 * @returns {void}
 */
function renderVariant(variant, override) {
  const sel = document.getElementById('depsVariantSelect');
  if (sel) sel.value = override === 'gpu' || override === 'cpu' ? override : '';
  const note = document.getElementById('depsVariantNote');
  if (note) {
    const label =
      variant === 'gpu'
        ? 'GPU (NVIDIA CUDA)'
        : variant === 'gpu-full'
          ? 'GPU (NVIDIA CUDA + torch)'
          : 'CPU';
    note.textContent = `Wykryty wariant: ${label}. Automatycznie wybierany, gdy nie wymuszono ręcznie.`;
  }
}

/**
 * Paint the deps-location line + the free-vs-required space hint.
 * @param {string} root current deps root path
 * @param {{freeBytes:number, requiredBytes:number}} space
 * @returns {void}
 */
function renderLocation(root, space) {
  const pathEl = document.getElementById('depsRootPath');
  if (pathEl) pathEl.textContent = root || '—';
  const spaceEl = document.getElementById('depsSpaceInfo');
  if (spaceEl && space) {
    const free = fmtBytes(space.freeBytes);
    const req = fmtBytes(space.requiredBytes);
    const enough = space.freeBytes >= space.requiredBytes;
    spaceEl.textContent = `Wolne miejsce: ${free} · wymagane: ${req}`;
    spaceEl.style.color = enough ? 'var(--text3)' : 'var(--amber)';
  }
}

/**
 * Render one row per REQUIRED dependency: label, size, status badge, a
 * Pobierz/Aktualizuj/Ponów button, a determinate progress bar, and a per-artifact
 * progress line. Non-required entries (the other variant, other platforms) are
 * omitted. A dependency whose last attempt failed keeps an explicit "Ponów" — the
 * download is never silently restarted behind the user's back.
 * @returns {void}
 */
function renderDepsList() {
  const listEl = document.getElementById('depsList');
  if (!listEl) return;
  const required = _specDeps.filter((d) => _statusById[d.id]?.required);
  if (!required.length) {
    listEl.innerHTML =
      '<div style="font-size:12px;color:var(--text3)">Brak zależności wymaganych na tym sprzęcie.</div>';
    syncDownloadAll();
    return;
  }
  listEl.innerHTML = required
    .map((dep) => {
      const st = _statusById[dep.id] || {};
      const needs = !st.present || st.stale;
      const statusText = !st.present
        ? '<span style="color:var(--amber)">Brak</span>'
        : st.stale
          ? '<span style="color:var(--amber)">Nieaktualne</span>'
          : '<span style="color:var(--green)">Pobrane</span>';
      const busy = _downloadingId != null;
      const label = _failedIds.has(dep.id)
        ? 'Ponów'
        : st.stale
          ? 'Aktualizuj'
          : 'Pobierz';
      const btn = needs
        ? `<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;white-space:nowrap" data-download-dep="${escHtml(dep.id)}" ${busy ? 'disabled' : ''}>${label}</button>`
        : '';
      const downloading = _downloadingId === dep.id;
      return `
<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--surface2)">
  <div style="flex:1;min-width:0">
    <div style="font-size:13px;color:var(--text1)">${escHtml(depLabel(dep))}</div>
    <div style="font-size:11px;color:var(--text3)">${escHtml(fmtBytes(dep.sizeBytes || st.sizeBytes || 0))} · ${statusText}</div>
    <div id="dep-progress-${cssId(dep.id)}" style="font-size:11px;color:var(--text2);margin-top:2px"></div>
    <div id="dep-bar-${cssId(dep.id)}" style="display:${downloading ? 'block' : 'none'};height:6px;background:var(--surface2);overflow:hidden;margin-top:4px">
      <div id="dep-bar-fill-${cssId(dep.id)}" style="height:100%;width:0%;background:var(--accent);transition:width 0.3s"></div>
    </div>
  </div>
  ${btn}
</div>`;
    })
    .join('');
  listEl.querySelectorAll('[data-download-dep]').forEach((b) => {
    b.addEventListener('click', () => downloadDep(b.dataset.downloadDep));
  });
  syncDownloadAll();
}

/**
 * A human-readable Polish label for a dependency, derived from its kind/variant.
 * `gpu-full` is the dormant CUDA-torch build, reachable only via
 * `REEL_ENGINE_VARIANT=gpu-full` — it never appears on an auto-detected machine.
 * @param {import('../deps/deps-spec.js').Dependency} dep
 * @returns {string}
 */
function depLabel(dep) {
  if (dep.kind === 'engine') {
    if (dep.variantPredicate === 'gpu-full')
      return 'Silnik WhisperX (GPU / CUDA + torch)';
    return dep.variantPredicate === 'gpu'
      ? 'Silnik WhisperX (GPU / CUDA)'
      : 'Silnik WhisperX (CPU)';
  }
  if (dep.kind === 'ffmpeg') return 'FFmpeg';
  if (dep.kind === 'align-models') return 'Modele dopasowania słów (wav2vec2)';
  return dep.id;
}

/** Enable "Pobierz wszystko" only when something is missing/stale and idle. */
function syncDownloadAll() {
  const btn = document.getElementById('depsDownloadAllBtn');
  if (!btn) return;
  const anyNeeds = _specDeps.some((d) => {
    const st = _statusById[d.id];
    return st?.required && (!st.present || st.stale);
  });
  btn.disabled = _downloadingId != null || !anyNeeds;
}

/**
 * Download + stage one dependency (checksum-gated in Rust), then re-render and
 * notify the transcription gate. A staged ENGINE is additionally probed (see
 * `verifyEngine`). Single-flight: disables the other buttons while a download is in
 * flight. On failure the row keeps an explicit "Ponów" — nothing auto-restarts.
 * @param {string} id dependency id
 * @returns {Promise<boolean>} true on success
 */
async function downloadDep(id) {
  if (_downloadingId != null) return false;
  _downloadingId = id;
  _failedIds.delete(id);
  renderDepsList();
  const progEl = document.getElementById('dep-progress-' + cssId(id));
  if (progEl) progEl.textContent = 'Rozpoczynanie…';
  const dep = _specDeps.find((d) => d.id === id);
  try {
    await invoke('download_dependency', { depId: id });
    _downloadingId = null;
    await refreshDepsView();
    notifyDepsChanged();
    if (dep && dep.kind === 'engine') await verifyEngine();
    return true;
  } catch (e) {
    _downloadingId = null;
    _failedIds.add(id);
    renderDepsList();
    const el = document.getElementById('dep-progress-' + cssId(id));
    if (el) {
      el.textContent = 'Błąd: ' + e;
      el.style.color = 'var(--amber)';
    }
    toast('Pobieranie zależności nieudane: ' + e, 'error');
    return false;
  }
}

/**
 * Probe the engine that was just staged and report the verdict in Polish. This is the
 * only moment the probe is worth paying for: it confirms the freshly-written binary can
 * see CUDA and that its bundled cuBLAS DLLs load. When it cannot, Rust persists the
 * `gpuUnusable` verdict — so the panel is repainted afterwards, because `gpu_info()`'s
 * `reason` is what explains the demotion. Never runs at boot (S-18).
 * @returns {Promise<void>}
 */
async function verifyEngine() {
  let st;
  try {
    st = await invoke('verify_staged_engine');
  } catch (e) {
    toast('Nie udało się zweryfikować silnika: ' + e, 'error');
    return;
  }
  // Mirrors Rust's `should_demote_engine`: the cuBLAS field is only meaningful for the
  // shipping `gpu` build, which bundles the DLLs. `gpu-full` gets its CUDA from the
  // cu128 torch wheel and truthfully reports `cublas: false` while running fine.
  const variant = String((_dismissState && _dismissState.variant) || '');
  const wantGpu = variant === 'gpu' || variant === 'gpu-full';
  const cublasFailed = variant === 'gpu' && st && st.cublas === false;
  const gpuOk = !!(st && st.gpu) && !cublasFailed;
  if (wantGpu && !gpuOk) {
    toast(
      'Silnik pobrano, ale nie udało się uruchomić CUDA na tej karcie — transkrypcja będzie działać na CPU.',
      'error',
    );
  } else {
    const ct2 = (st && (st.ct2_device || st.device)) || 'cpu';
    const torch = (st && st.torch_device) || 'cpu';
    toast(
      `Silnik zweryfikowany — transkrypcja: ${ct2}, dopasowanie: ${torch}.`,
      'success',
    );
  }
  await refreshDepsView();
  notifyDepsChanged();
}

/**
 * Download every missing/stale required dependency in sequence (one at a time so
 * progress stays legible and disk pressure is bounded). Stops on the first
 * failure (already surfaced by downloadDep).
 * @returns {Promise<void>}
 */
async function downloadAllMissing() {
  const pending = _specDeps
    .filter((d) => {
      const st = _statusById[d.id];
      return st?.required && (!st.present || st.stale);
    })
    .map((d) => d.id);
  for (const id of pending) {
    const ok = await downloadDep(id);
    if (!ok) return;
  }
}

/**
 * Persist the variant override (or clear it), then re-resolve the required set.
 * @param {string} value dropdown value (`''` auto | `gpu` | `cpu`)
 * @returns {Promise<void>}
 */
async function applyVariantOverride(value) {
  try {
    await invoke('set_variant_override', { variant: value || '' });
    await refreshDepsView();
    notifyDepsChanged();
  } catch (e) {
    toast('Nie udało się zapisać wyboru wariantu: ' + e, 'error');
  }
}

/**
 * Pick a new deps-location directory and persist it (Rust validates writability
 * + free space, rejecting a bad/too-small target with a Polish error).
 * @returns {Promise<void>}
 */
async function changeDepsLocation() {
  try {
    const dir = await dialogOpen({ directory: true });
    if (!dir) return;
    await invoke('set_deps_root', { path: dir });
    await refreshDepsView();
    notifyDepsChanged();
    toast('Zapisano nową lokalizację zależności.', 'success');
  } catch (e) {
    toast('Nie udało się ustawić lokalizacji: ' + e, 'error');
  }
}

/**
 * Broadcast that deps state changed so the transcription gate re-checks its
 * spawn-free readiness. A custom DOM event avoids a module import cycle with
 * `import/transcribe.js`.
 * @returns {void}
 */
function notifyDepsChanged() {
  document.dispatchEvent(new CustomEvent('deps-changed'));
}

// ── small helpers ─────────────────────────────────────────────────────

/** Escape HTML-special chars for safe innerHTML interpolation. */
function escHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[
        c
      ],
  );
}

/** Sanitize a dependency id into a DOM-id-safe token for the progress element. */
function cssId(id) {
  return String(id).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/** Format a byte count as a human-readable size (Polish decimal comma). */
function fmtBytes(n) {
  const b = Number(n) || 0;
  if (b < 1024) return `${b} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = b / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1).replace('.', ',')} ${units[i]}`;
}
