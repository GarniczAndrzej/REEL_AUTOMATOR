import { state, subscribe } from './state.js';
import * as step1 from './ui/step1-import.js';
import * as step2 from './ui/step2-analyze.js';
import * as step3 from './ui/export-popover.js';
import { init as initOrPicker } from './ai/openrouter-picker.js';
import { loadSettings } from './settings.js';
import {
  seedPresetsIfEmpty,
  migrateBuiltinPresets,
  loadPresets,
} from './ai/prompt-presets.js';
import { initSurface } from './ui/surface.js';
import { initSettingsModal } from './ui/settings-modal.js';
import { initAutoMode } from './ui/auto-mode/index.js';
import { hydrateKeys } from './ai/api-key.js';
import { toast } from './ui/toast.js';

document.addEventListener('DOMContentLoaded', async () => {
  // S-21 instrumentation: surface (never suppress) uncaught errors and rejected
  // promises. There were no global error handlers, so any async failure was
  // invisible. Log AND toast (Polish) — but do NOT preventDefault(), so the
  // console error stays visible (S-21 guardrail against silent crash-swallowing).
  window.addEventListener('error', (e) => {
    console.error('[window.error]', e.error || e.message, e);
    toast('Wystąpił nieoczekiwany błąd aplikacji.', 'error');
  });
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[unhandledrejection]', e.reason);
    toast('Nieobsłużony błąd operacji asynchronicznej.', 'error');
  });

  // Seed persisted app settings (S-16) before step inits read state. The
  // merge-gap survives sessions via the `edl_app_settings` bag; fall back to
  // the in-state default (12) when unset.
  const settings = loadSettings();
  if (settings.mergeThreshold != null)
    state.mergeThreshold = settings.mergeThreshold;

  // FR-016: seed built-in presets on first run, then run the one-time S-26
  // builtin migration for existing users (flag-guarded, idempotent), then load
  // the library (S-03 Phase 2).
  seedPresetsIfEmpty();
  migrateBuiltinPresets();
  state.promptPresets = loadPresets();

  // S-11/FR-035: hydrate API keys from the macOS Keychain (and run the one-time
  // localStorage→Keychain migration) BEFORE any step init / settings modal reads
  // a key synchronously via getApiKey().
  try {
    await hydrateKeys();
  } catch (e) {
    console.error('[hydrateKeys]', e);
  }

  try {
    step1.init();
  } catch (e) {
    console.error('[step1.init]', e);
  }
  try {
    step2.init();
  } catch (e) {
    console.error('[step2.init]', e);
    const review = document.getElementById('sectionReview');
    if (review)
      review.insertAdjacentHTML(
        'afterbegin',
        `<div style="background:var(--red);color:var(--text-on-light);padding:10px 14px;border-radius:0;margin-bottom:12px;font-size:13px;">
        Błąd inicjalizacji analizy: ${e.message}<br>
        <small>Otwórz DevTools (Cmd+Option+I) aby zobaczyć szczegóły.</small>
      </div>`,
      );
  }
  try {
    step3.init();
  } catch (e) {
    console.error('[step3.init]', e);
  }
  try {
    initOrPicker();
  } catch (e) {
    console.error('[initOrPicker]', e);
  }
  try {
    initSettingsModal();
  } catch (e) {
    console.error('[initSettingsModal]', e);
  }

  // S-07: wire the "Tryb automatyczny" launcher before initSurface() so the
  // button reflects state from the first render.
  try {
    initAutoMode();
  } catch (e) {
    console.error('[initAutoMode]', e);
  }

  // Progressive surface: reveals/gates sections from real state. Init last so
  // the step modules have rendered their markup first.
  try {
    initSurface();
  } catch (e) {
    console.error('[initSurface]', e);
  }

  // Subscribe to state changes → update sidebar status
  subscribe((s) => {
    document.getElementById('statusSrt').textContent = s.srtName || 'brak';
    document.getElementById('statusSegs').textContent = s.sentences.length;
    document.getElementById('statusReels').textContent = s.reelsData.length;
  });

  // ── F16 — Global undo/redo (works from any section) ──────────────────
  document.addEventListener('keydown', (e) => {
    const mod = navigator.platform.startsWith('Mac') ? e.metaKey : e.ctrlKey;
    if (!mod) return;
    if (e.target.matches('input, textarea, select')) return;
    if (e.key === 'z' && !e.shiftKey) {
      e.preventDefault();
      step2.undo();
    }
    if ((e.key === 'z' && e.shiftKey) || e.key === 'y') {
      e.preventDefault();
      step2.redo();
    }
  });
});
