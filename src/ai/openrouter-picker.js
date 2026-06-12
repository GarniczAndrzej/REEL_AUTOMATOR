import { state, emit } from '../state.js';
import { getApiKey } from './api-key.js';

export function init() {
  document.getElementById('orLoadBtn').addEventListener('click', loadOrModels);
  document
    .getElementById('orModelSearch')
    .addEventListener('focus', openOrDropdown);
  document
    .getElementById('orModelSearch')
    .addEventListener('input', (e) => filterOrModels(e.target.value));
  document
    .getElementById('orSelectedBadge')
    .addEventListener('click', () =>
      document.getElementById('orModelSearch').focus(),
    );

  document.addEventListener('click', (e) => {
    const wrap = document.getElementById('orSearchWrap');
    if (wrap && !wrap.contains(e.target) && e.target.id !== 'orSelectedBadge')
      closeOrDropdown();
  });

  const savedModel = localStorage.getItem('edl_or_model') || '';
  if (savedModel) {
    state.orSelectedModel = savedModel;
    updateOrBadge(savedModel);
  }
  const cached = localStorage.getItem('edl_or_models_cache');
  if (cached) {
    try {
      state.orAllModels = JSON.parse(cached);
      renderOrDropdown(state.orAllModels);
      document.getElementById('orLoadBtn').textContent =
        state.orAllModels.length + ' modeli';
    } catch (e) {}
  }
}

async function loadOrModels() {
  const key =
    document.getElementById('apiKeyInput').value.trim() ||
    getApiKey('openrouter');
  const btn = document.getElementById('orLoadBtn');
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
    btn.textContent = state.orAllModels.length + ' modeli';
    renderOrDropdown(state.orAllModels);
    openOrDropdown();
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

function renderOrDropdown(models) {
  const dd = document.getElementById('orDropdown');
  if (!models.length) {
    dd.innerHTML =
      '<div class="or-model-item"><div class="or-model-id" style="color:var(--text3)">Brak wyników — wpisz inną frazę</div></div>';
    return;
  }
  dd.innerHTML = models
    .slice(0, 300)
    .map((m) => {
      const ctx = m.context_length
        ? (m.context_length / 1000).toFixed(0) + 'k ctx'
        : '';
      const price = m.pricing?.prompt
        ? '$' + (+m.pricing.prompt * 1e6).toFixed(3) + '/Mtok'
        : 'free?';
      const sel = m.id === state.orSelectedModel ? ' selected' : '';
      return `<div class="or-model-item${sel}" data-model-id="${esc(m.id)}">
      <div class="or-model-id">${esc(m.id)}<span class="or-model-price">${esc(price)}</span></div>
      <div class="or-model-ctx">${esc(m.name || '')} ${ctx ? '· ' + esc(ctx) : ''}</div>
    </div>`;
    })
    .join('');
  dd.querySelectorAll('.or-model-item').forEach((el) => {
    el.addEventListener('click', () => selectOrModel(el.dataset.modelId));
  });
}

function filterOrModels(q) {
  const filtered = q
    ? state.orAllModels.filter(
        (m) =>
          m.id.toLowerCase().includes(q.toLowerCase()) ||
          (m.name || '').toLowerCase().includes(q.toLowerCase()),
      )
    : state.orAllModels;
  renderOrDropdown(filtered);
  document.getElementById('orDropdown').classList.add('open');
}

function openOrDropdown() {
  if (!state.orAllModels.length) {
    loadOrModels();
    return;
  }
  document.getElementById('orDropdown').classList.add('open');
}

function closeOrDropdown() {
  document.getElementById('orDropdown').classList.remove('open');
  document.getElementById('orModelSearch').value = '';
}

function selectOrModel(id) {
  state.orSelectedModel = id;
  localStorage.setItem('edl_or_model', id);
  updateOrBadge(id);
  closeOrDropdown();
  emit();
}

export function updateOrBadge(id) {
  const badge = document.getElementById('orSelectedBadge');
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
