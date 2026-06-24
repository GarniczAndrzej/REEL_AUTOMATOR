// Progressive single-surface controller (S-16 Phase 2). Replaces the old
// three-panel step switch: import → review → export now live on one
// continuous scrolling surface, with later sections revealed/gated from real
// state (`srtContent`/`sentences`/`reelsData`) rather than toggled by hand.
//
// Drives off the pub-sub `emit()` and batches re-renders through one rAF so a
// burst of mutations doesn't thrash the surface (see plan: Performance).

import { state, subscribe } from '../state.js';

/**
 * Section regions in document order. `gate` returns true once the section is
 * reachable; absent gate = always revealed (the import section).
 * @type {{id:string, nav:string, gate?:(s:typeof state)=>boolean}[]}
 */
const SECTIONS = [
  { id: 'sectionImport', nav: 'nav1' },
  { id: 'sectionReview', nav: 'nav2', gate: (s) => s.sentences.length > 0 },
];

let pendingFrame = null;

// S-07 read-only-during-run: the earlier-stage input controls that could mutate
// state.sentences mid-analyze (the race research warns about). Force-disabled
// while an auto run is live; their prior disabled state is restored on exit so
// each control's own enable logic resumes ownership. The analyze run⇄stop button
// and the transcription cancel button are deliberately NOT here — they must stay
// live to drive the run.
const AUTO_LOCK_IDS = [
  'transcribeBtn',
  'browseWhisperVideoBtn',
  'parseBtn',
  'clearFileBtn',
  'srtFile',
  'alignTranscriptBtn',
];
let autoLockActive = false;
/** @type {Record<string, boolean>} */
const autoLockPrev = {};

function applyAutoLock() {
  const running = state.autoMode.running;
  if (running && !autoLockActive) {
    autoLockActive = true;
    AUTO_LOCK_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el) {
        autoLockPrev[id] = el.disabled;
        el.disabled = true;
      }
    });
  } else if (!running && autoLockActive) {
    autoLockActive = false;
    AUTO_LOCK_IDS.forEach((id) => {
      const el = document.getElementById(id);
      if (el && id in autoLockPrev) el.disabled = autoLockPrev[id];
    });
  }
}

/**
 * Wire nav-cue clicks and the state-driven reveal/gate loop. Call once after
 * the step modules have rendered their markup.
 * @returns {void}
 */
export function initSurface() {
  SECTIONS.forEach(({ id, nav }) => {
    const navEl = document.getElementById(nav);
    if (navEl) navEl.addEventListener('click', () => scrollToSection(id));
  });
  subscribe(scheduleRender);
  render();
}

/**
 * Reveal a gated section and scroll it into view. No-op while the section is
 * still locked (precondition not met).
 * @param {string} id - section element id
 * @returns {void}
 */
export function scrollToSection(id) {
  const el = document.getElementById(id);
  if (!el || el.classList.contains('section-locked')) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function scheduleRender() {
  if (pendingFrame != null) return;
  pendingFrame = requestAnimationFrame(() => {
    pendingFrame = null;
    render();
  });
}

function render() {
  applyAutoLock();
  SECTIONS.forEach(({ id, gate }) => {
    const el = document.getElementById(id);
    if (!el) return;
    const revealed = !gate || gate(state);
    el.classList.toggle('section-locked', !revealed);
  });

  // Sidebar stepper is now an orientation cue: the furthest reached section is
  // "active", earlier ones are "done".
  const current = state.reelsData.length ? 3 : state.sentences.length ? 2 : 1;
  [1, 2, 3].forEach((i) => {
    const nav = document.getElementById('nav' + i);
    if (!nav) return;
    nav.classList.toggle('active', i === current);
    nav.classList.toggle('done', i < current);
  });
}
