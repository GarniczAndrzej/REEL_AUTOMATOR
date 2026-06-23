/**
 * @param {string} apiKey
 * @param {string} prompt
 * @param {string} orModel
 * @param {AbortSignal} [signal] Optional abort signal; aborting rejects the
 *   returned promise with an `AbortError`-named exception (propagated unchanged).
 * @param {boolean} [cacheControl=false] When true (S-25 Phase 5), the user
 *   message is sent as a single content block carrying
 *   `cache_control: {type:'ephemeral'}` so the large stable transcript prefix is
 *   billed at the cached rate on providers that honour prompt caching
 *   (Anthropic / Gemini 2.5 / Qwen). OpenRouter drops the marker for providers
 *   that ignore it — no error path. Cached-token counts surface via
 *   `usage.prompt_tokens_details.cached_tokens` (Phase-1 readout).
 * @returns {Promise<{ content: string, usage: object|null, finishReason: string|null }>}
 *   `usage` is `data.usage` verbatim (includes `prompt_tokens`,
 *   `completion_tokens`, and `prompt_tokens_details.cached_tokens` when present);
 *   `finishReason` is the provider's `finish_reason` (e.g. `'length'` on truncation).
 */
export async function callOpenRouter(
  apiKey,
  prompt,
  orModel,
  signal,
  cacheControl = false,
) {
  if (!orModel) throw new Error('Nie wybrano modelu OpenRouter!');
  const userContent = cacheControl
    ? [{ type: 'text', text: prompt, cache_control: { type: 'ephemeral' } }]
    : prompt;
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ' + apiKey,
      'HTTP-Referer': window.location.href,
      'X-Title': 'Reels EDL Automator',
    },
    body: JSON.stringify({
      model: orModel,
      max_tokens: 16384,
      temperature: 0.1,
      messages: [
        {
          role: 'system',
          content:
            'Jesteś ekspertem od montażu wideo. Zwracasz TYLKO czysty JSON bez komentarzy ani markdown.',
        },
        { role: 'user', content: userContent },
      ],
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(
      err.error?.message || 'OpenRouter API error ' + resp.status,
    );
  }
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || 'OpenRouter error');
  const choice = data.choices?.[0];
  return {
    content: choice?.message?.content || '',
    usage: data.usage || null,
    finishReason: choice?.finish_reason || null,
  };
}
