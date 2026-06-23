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

  let invoke;
  try {
    ({ invoke } = await import('@tauri-apps/api/core'));
  } catch {
    // Not in Tauri — call through without cache
    return { result: await callFn(), fromCache: false, hashShort };
  }

  try {
    const cached = await invoke('load_llm_cache', { hash });
    if (cached != null)
      return {
        result: { content: cached, usage: null, finishReason: 'cached' },
        fromCache: true,
        hashShort,
      };
  } catch (e) {
    console.warn('LLM cache load failed:', e);
  }

  const result = await callFn();

  try {
    await invoke('save_llm_cache', { hash, content: result.content });
  } catch (e) {
    console.warn('LLM cache save failed:', e);
  }

  return { result, fromCache: false, hashShort };
}

export async function clearLlmCache() {
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    await invoke('clear_llm_cache');
  } catch {}
}
