import { state, emit } from '../state.js';
import { getApiKey } from './api-key.js';

// S-25 Phase 3: the picker was a singleton hard-wired to fixed DOM ids,
// `localStorage['edl_or_model']` and `state.orSelectedModel`. It is now
// parameterized by a per-mount config so multiple instances can coexist — the
// legacy single-shot picker plus the cluster + curate pickers for the
// cluster→curate pipeline. The model LIST (`state.orAllModels`) and its cache
// (`edl_or_models_cache`) stay shared across mounts; only the SELECTION differs.
//
// `get`/`set` are accessor functions rather than a flat `stateKey` string so a
// mount can target either a flat scalar (`state.orSelectedModel`) or a nested
// field (`state.aiModels.cluster`).
/**
 * @typedef {Object} PickerConfig
 * @property {string} searchId
 * @property {string} dropdownId
 * @property {string} badgeId
 * @property {string} searchWrapId
 * @property {string} loadBtnId
 * @property {string} lsKey - localStorage key for the persisted selection
 * @property {() => (string|null)} get - read the current selection from state
 * @property {(id: string) => void} set - write the selection into state
 */

/** @type {PickerConfig} */
export const LEGACY_CONFIG = {
  searchId: 'orModelSearch',
  dropdownId: 'orDropdown',
  badgeId: 'orSelectedBadge',
  searchWrapId: 'orSearchWrap',
  loadBtnId: 'orLoadBtn',
  lsKey: 'edl_or_model',
  get: () => state.orSelectedModel,
  set: (id) => {
    state.orSelectedModel = id;
  },
};

/** @type {PickerConfig} */
export const CLUSTER_CONFIG = {
  searchId: 'orModelSearch_cluster',
  dropdownId: 'orDropdown_cluster',
  badgeId: 'orSelectedBadge_cluster',
  searchWrapId: 'orSearchWrap_cluster',
  loadBtnId: 'orLoadBtn_cluster',
  lsKey: 'edl_or_model_cluster',
  get: () => state.aiModels.cluster,
  set: (id) => {
    state.aiModels.cluster = id;
  },
};

/** @type {PickerConfig} */
export const CURATE_CONFIG = {
  searchId: 'orModelSearch_curate',
  dropdownId: 'orDropdown_curate',
  badgeId: 'orSelectedBadge_curate',
  searchWrapId: 'orSearchWrap_curate',
  loadBtnId: 'orLoadBtn_curate',
  lsKey: 'edl_or_model_curate',
  get: () => state.aiModels.curate,
  set: (id) => {
    state.aiModels.curate = id;
  },
};

// Registry of mounted picker configs. The model list is shared, so a fresh load
// from any picker re-renders every mounted dropdown.
/** @type {PickerConfig[]} */
const mounts = [];

/**
 * Mount a model picker against the given config. Defaults to the legacy
 * single-shot picker so the existing `main.js` `init()` call keeps working.
 * Silently no-ops if the mount's markup is absent.
 * @param {PickerConfig} [config]
 * @returns {void}
 */
export function init(config = LEGACY_CONFIG) {
  const $ = (id) => document.getElementById(id);
  const search = $(config.searchId);
  const loadBtn = $(config.loadBtnId);
  const badge = $(config.badgeId);
  if (!search || !loadBtn || !badge) return; // markup not present — skip

  mounts.push(config);

  loadBtn.addEventListener('click', () => loadOrModels(config));
  search.addEventListener('focus', () => openOrDropdown(config));
  search.addEventListener('input', (e) =>
    filterOrModels(config, e.target.value),
  );
  badge.addEventListener('click', () => search.focus());

  document.addEventListener('click', (e) => {
    const wrap = $(config.searchWrapId);
    if (wrap && !wrap.contains(e.target) && e.target.id !== config.badgeId)
      closeOrDropdown(config);
  });

  const savedModel = localStorage.getItem(config.lsKey) || '';
  if (savedModel) {
    config.set(savedModel);
    updateOrBadge(config, savedModel);
  }
  const cached = localStorage.getItem('edl_or_models_cache');
  if (cached) {
    try {
      state.orAllModels = JSON.parse(cached);
      renderOrDropdown(config, state.orAllModels);
      loadBtn.textContent = state.orAllModels.length + ' modeli';
    } catch (e) {}
  }
}

async function loadOrModels(config) {
  const key =
    document.getElementById('apiKeyInput').value.trim() ||
    getApiKey('openrouter');
  const btn = document.getElementById(config.loadBtnId);
  btn.disabled = true;
  btn.textContent = 'Ładowanie…';
  try {
    const resp = await fetch('https://openrouter.ai/api/v1/models', {
      headers: key ? { Authorization: 'Bearer ' + key } : {},
    });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const data = await resp.json();
    state.orAllModels = (data.data || []).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    localStorage.setItem(
      'edl_or_models_cache',
      JSON.stringify(state.orAllModels),
    );
    // The list is shared — refresh every mounted picker's dropdown + button.
    for (const m of mounts) {
      renderOrDropdown(m, state.orAllModels);
      const b = document.getElementById(m.loadBtnId);
      if (b) b.textContent = state.orAllModels.length + ' modeli';
    }
    openOrDropdown(config);
    showStatus(state.orAllModels.length + ' modeli załadowanych', 'ok');
    emit();
  } catch (e) {
    btn.textContent = 'Błąd';
    showStatus('Błąd ładowania modeli: ' + e.message, 'err');
  } finally {
    btn.disabled = false;
  }
}

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderOrDropdown(config, models) {
  const dd = document.getElementById(config.dropdownId);
  if (!dd) return;
  if (!models.length) {
    dd.innerHTML =
      '<div class="or-model-item"><div class="or-model-id" style="color:var(--text3)">Brak wyników — wpisz inną frazę</div></div>';
    return;
  }
  const selectedId = config.get();
  dd.innerHTML = models
    .slice(0, 300)
    .map((m) => {
      const ctx = m.context_length
        ? (m.context_length / 1000).toFixed(0) + 'k ctx'
        : '';
      const price = m.pricing?.prompt
        ? '$' + (+m.pricing.prompt * 1e6).toFixed(3) + '/Mtok'
        : 'free?';
      const sel = m.id === selectedId ? ' selected' : '';
      return `<div class="or-model-item${sel}" data-model-id="${esc(m.id)}">
      <div class="or-model-id">${esc(m.id)}<span class="or-model-price">${esc(price)}</span></div>
      <div class="or-model-ctx">${esc(m.name || '')} ${ctx ? '· ' + esc(ctx) : ''}</div>
    </div>`;
    })
    .join('');
  dd.querySelectorAll('.or-model-item').forEach((el) => {
    el.addEventListener('click', () =>
      selectOrModel(config, el.dataset.modelId),
    );
  });
}

function filterOrModels(config, q) {
  const filtered = q
    ? state.orAllModels.filter(
        (m) =>
          m.id.toLowerCase().includes(q.toLowerCase()) ||
          (m.name || '').toLowerCase().includes(q.toLowerCase()),
      )
    : state.orAllModels;
  renderOrDropdown(config, filtered);
  document.getElementById(config.dropdownId).classList.add('open');
}

function openOrDropdown(config) {
  if (!state.orAllModels.length) {
    loadOrModels(config);
    return;
  }
  // Re-render so the per-instance selection highlight is current.
  renderOrDropdown(config, state.orAllModels);
  document.getElementById(config.dropdownId).classList.add('open');
}

function closeOrDropdown(config) {
  document.getElementById(config.dropdownId).classList.remove('open');
  document.getElementById(config.searchId).value = '';
}

function selectOrModel(config, id) {
  config.set(id);
  localStorage.setItem(config.lsKey, id);
  updateOrBadge(config, id);
  closeOrDropdown(config);
  emit();
}

/**
 * @param {PickerConfig} config
 * @param {string} id
 * @returns {void}
 */
export function updateOrBadge(config, id) {
  const badge = document.getElementById(config.badgeId);
  if (!badge) return;
  const short = id.length > 26 ? '…' + id.slice(-24) : id;
  badge.textContent = short;
  badge.title = id;
}

function showStatus(msg, type) {
  const s = document.getElementById('apiStatus');
  s.textContent = msg;
  s.className = 'api-status ' + type;
  setTimeout(() => (s.className = 'api-status'), 2500);
}
