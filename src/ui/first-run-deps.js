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
// (`transcription_ready`, `deps_status`), never a sidecar spawn.

import { toast } from './toast.js';
import { invoke, getInvoke, listen, dialogOpen } from '../platform/adapter.js';

// Once dismissed on this machine, the setup screen no longer auto-opens on
// launch (the user can still reopen it from the header "Zależności" button).
const DISMISS_LS_KEY = 'edl_deps_setup_dismissed';

/** @type {import('../deps/deps-spec.js').Dependency[]} */
let _specDeps = [];
/** @type {Record<string, {id:string,kind:string,required:boolean,present:boolean,stale:boolean,sizeBytes:number,stagedPath?:string}>} */
let _statusById = {};
/** @type {string|null} id of the dependency currently downloading (single-flight) */
let _downloadingId = null;
let _progressWired = false;

/**
 * Wire the first-run setup modal: open/close/skip, the variant override, the
 * deps-location picker, the download buttons, and the persistent
 * `dep-download-progress` listener. Auto-opens on first launch when a backend is
 * present, the screen was not previously dismissed, and transcription is not yet
 * ready. Call once on boot.
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
    skipBtn.addEventListener('click', () => {
      try {
        localStorage.setItem(DISMISS_LS_KEY, '1');
      } catch (e) {}
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
 * flag marks completion. No-op outside Tauri/Electron.
 * @returns {Promise<void>}
 */
async function wireProgress() {
  if (_progressWired) return;
  try {
    await listen('dep-download-progress', (e) => {
      const p = e.payload || {};
      const el = document.getElementById('dep-progress-' + cssId(p.id));
      if (!el) return;
      if (p.done) {
        el.textContent = 'Pobrano i zweryfikowano';
        return;
      }
      const mb = ((p.bytesPerSec || 0) / 1024 / 1024).toFixed(1);
      const eta = p.etaSec ? `${Math.round(p.etaSec)}s` : '—';
      el.textContent = `${Math.round(p.percent || 0)}% · ${mb} MB/s · ETA ${eta}`;
    });
    _progressWired = true;
  } catch (e) {
    // No backend (plain browser dev) — progress events never fire; the modal
    // simply never auto-opens (see maybeAutoOpen).
  }
}

/**
 * Auto-open the setup screen on first launch: only when a backend exists, the
 * user has not dismissed it, and transcription is not yet ready (deps missing).
 * Never blocks first paint — all reads are spawn-free.
 * @returns {Promise<void>}
 */
async function maybeAutoOpen() {
  const inv = await getInvoke();
  if (!inv) return; // plain browser dev — no deps machinery
  try {
    if (localStorage.getItem(DISMISS_LS_KEY) === '1') return;
  } catch (e) {}
  try {
    const ready = await invoke('transcription_ready');
    if (ready) return; // engine already resolvable (staged or bundled) — no nag
  } catch (e) {
    return; // can't tell → don't nag
  }
  openFirstRunDeps();
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
 * + the current/overridden variant, then paint the variant dropdown, the
 * location line, and the dependency list. Tolerant of a missing backend.
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
    const [spec, statuses, root, space, variant, override] = await Promise.all([
      invoke('load_deps_spec'),
      invoke('deps_status'),
      invoke('get_deps_root'),
      invoke('deps_root_space'),
      invoke('get_variant'),
      invoke('get_variant_override'),
    ]);
    _specDeps = (spec && spec.dependencies) || [];
    _statusById = {};
    for (const s of statuses || []) _statusById[s.id] = s;
    renderVariant(variant, override);
    renderLocation(root, space);
    renderDepsList();
  } catch (e) {
    if (listEl)
      listEl.innerHTML = `<div style="font-size:12px;color:var(--amber)">Nie można wczytać stanu zależności: ${escHtml(String(e))}</div>`;
  }
}

/**
 * Paint the variant dropdown selection + the "detected" note.
 * @param {string} variant effective variant (`gpu`|`cpu`)
 * @param {string} override persisted override (`gpu`|`cpu`|'')
 * @returns {void}
 */
function renderVariant(variant, override) {
  const sel = document.getElementById('depsVariantSelect');
  if (sel) sel.value = override === 'gpu' || override === 'cpu' ? override : '';
  const note = document.getElementById('depsVariantNote');
  if (note) {
    const label = variant === 'gpu' ? 'GPU (NVIDIA CUDA)' : 'CPU';
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
 * Pobierz/Ponów button, and a per-artifact progress line. Non-required entries
 * (the other variant, other platforms) are omitted.
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
      const btn = needs
        ? `<button class="btn btn-secondary" style="padding:6px 12px;font-size:12px;white-space:nowrap" data-download-dep="${escHtml(dep.id)}" ${busy ? 'disabled' : ''}>${st.stale ? 'Aktualizuj' : 'Pobierz'}</button>`
        : '';
      return `
<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-bottom:1px solid var(--surface2)">
  <div style="flex:1;min-width:0">
    <div style="font-size:13px;color:var(--text1)">${escHtml(depLabel(dep))}</div>
    <div style="font-size:11px;color:var(--text3)">${escHtml(fmtBytes(dep.sizeBytes || st.sizeBytes || 0))} · ${statusText}</div>
    <div id="dep-progress-${cssId(dep.id)}" style="font-size:11px;color:var(--text2);margin-top:2px"></div>
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
 * @param {import('../deps/deps-spec.js').Dependency} dep
 * @returns {string}
 */
function depLabel(dep) {
  if (dep.kind === 'engine')
    return dep.variantPredicate === 'gpu'
      ? 'Silnik WhisperX (GPU / CUDA)'
      : 'Silnik WhisperX (CPU)';
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
 * notify the transcription gate. Single-flight: disables the other buttons while
 * a download is in flight.
 * @param {string} id dependency id
 * @returns {Promise<boolean>} true on success
 */
async function downloadDep(id) {
  if (_downloadingId != null) return false;
  _downloadingId = id;
  renderDepsList();
  const progEl = document.getElementById('dep-progress-' + cssId(id));
  if (progEl) progEl.textContent = 'Rozpoczynanie…';
  try {
    await invoke('download_dependency', { depId: id });
    _downloadingId = null;
    await refreshDepsView();
    notifyDepsChanged();
    return true;
  } catch (e) {
    _downloadingId = null;
    if (progEl) progEl.textContent = 'Błąd: ' + e;
    toast('Pobieranie zależności nieudane: ' + e, 'error');
    renderDepsList();
    return false;
  }
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
