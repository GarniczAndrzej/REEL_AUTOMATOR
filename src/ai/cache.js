import { getInvoke } from '../platform/adapter.js';

async function sha256hex(str) {
  const buf = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(str),
  );
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

// Wraps an AI call with Tauri-backed disk cache.
// `callFn` returns { content: string, usage: object|null, finishReason: string|null }.
// Only the content string is persisted to disk — a cache HIT has no fresh usage,
// so it is reconstructed as { content, usage: null, finishReason: 'cached' } and
// callers treat fromCache===true as "usage unavailable" (show the cached badge).
// Returns { result: { content, usage, finishReason }, fromCache: boolean, hashShort: string }
export async function withLlmCache(cacheKey, callFn) {
  const hash = await sha256hex(cacheKey);
  const hashShort = hash.slice(0, 8);

  const invoke = await getInvoke();
  if (!invoke) {
    // No backend (plain browser dev) — call through without cache
    return { result: await callFn(), fromCache: false, hashShort };
  }

  try {
    const cached = await invoke('load_llm_cache', { hash });
    // A blank entry is a POISONED cache write from before the empty-response
    // guard below existed (a truncated reasoning response persisted as ''). Treat
    // it as a miss so an affected key self-heals on the next run instead of
    // replaying `JSON.parse('')` forever without ever hitting the network.
    if (cached != null && String(cached).trim())
      return {
        result: { content: cached, usage: null, finishReason: 'cached' },
        fromCache: true,
        hashShort,
      };
  } catch (e) {
    console.warn('LLM cache load failed:', e);
  }

  const result = await callFn();

  // Never persist an empty/blank body: caching a failed generation makes the
  // failure permanent and silent (every retry becomes a cache HIT).
  if (result.content && result.content.trim()) {
    try {
      await invoke('save_llm_cache', { hash, content: result.content });
    } catch (e) {
      console.warn('LLM cache save failed:', e);
    }
  }

  return { result, fromCache: false, hashShort };
}

export async function clearLlmCache() {
  try {
    const invoke = await getInvoke();
    if (invoke) await invoke('clear_llm_cache');
  } catch {}
}
