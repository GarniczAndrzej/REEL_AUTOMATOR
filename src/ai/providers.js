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
 * @throws {Error} with `code === 'EMPTY_TRUNCATED'` when the model returned NO
 *   content because it exhausted the completion budget (reasoning models spend
 *   it on thinking tokens first). Throwing here — rather than returning `''` —
 *   keeps the empty body out of the LLM disk cache and gives the caller an
 *   actionable message instead of a downstream `JSON.parse('')` failure.
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
      // NO `max_tokens` on purpose. Any value we pick is the FULL completion
      // allowance, and reasoning models (Claude Opus/Sonnet 5, Gemini 2.5,
      // GPT-5, the `~vendor/*-latest` aliases) charge thinking tokens against it
      // BEFORE the first content token — so a self-imposed cap could burn out on
      // reasoning and return `content: ''` with `finish_reason: 'length'`.
      // Omitting the field is valid per the OpenRouter schema (it is optional,
      // and superseded by `max_completion_tokens`); the provider then applies the
      // model's own ceiling: context length minus the prompt.
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
  const content = choice?.message?.content || '';
  const finishReason = choice?.finish_reason || null;

  if (!content.trim()) {
    const err = new Error(
      finishReason === 'length'
        ? `Model „${orModel}" wyczerpał własny limit wyjścia na rozumowanie i nie zwrócił ` +
            'żadnej treści. Aplikacja nie narzuca już limitu odpowiedzi — to ceiling samego ' +
            'modelu. Wybierz model o większym limicie wyjścia, przełącz tryb analizy na ' +
            '„pipeline" (Ustawienia) albo skróć materiał.'
        : `Model „${orModel}" zwrócił pustą odpowiedź (finish_reason=${finishReason ?? 'brak'}).`,
    );
    err.code = 'EMPTY_TRUNCATED';
    throw err;
  }

  return { content, usage: data.usage || null, finishReason };
}
