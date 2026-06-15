// Lightweight non-blocking feedback primitive (S-16). Replaces informational
// `alert()` dialogs with transient, auto-dismissing, stacking toasts. Destructive
// confirmations stay on the native `confirm()`/`ask()` path — toasts never gate
// a decision, they only inform. All caller strings are Polish.

/**
 * Show a transient toast.
 * @param {string} message Polish message text.
 * @param {'success'|'error'|'info'} [type] Visual variant (default 'info').
 */
export function toast(message, type = 'info') {
  const container = ensureContainer();
  const el = document.createElement('div');
  el.className = 'toast toast-' + type;
  el.textContent = message;
  container.appendChild(el);
  // Force a reflow so the entry transition runs from the initial state.
  void el.offsetWidth;
  el.classList.add('toast-visible');
  const remove = () => {
    el.classList.remove('toast-visible');
    el.addEventListener('transitionend', () => el.remove(), { once: true });
    // Fallback in case the transition never fires.
    setTimeout(() => el.remove(), 400);
  };
  setTimeout(remove, 3200);
}

/** @returns {HTMLElement} the fixed toast container (created on first use). */
function ensureContainer() {
  let c = document.getElementById('toastContainer');
  if (!c) {
    c = document.createElement('div');
    c.id = 'toastContainer';
    document.body.appendChild(c);
  }
  return c;
}
