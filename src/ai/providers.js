/**
 * @param {string} apiKey
 * @param {string} prompt
 * @param {string} orModel
 * @param {AbortSignal} [signal] Optional abort signal; aborting rejects the
 *   returned promise with an `AbortError`-named exception (propagated unchanged).
 * @returns {Promise<string>}
 */
export async function callOpenRouter(apiKey, prompt, orModel, signal) {
  if (!orModel) throw new Error('Nie wybrano modelu OpenRouter!');
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
        { role: 'user', content: prompt },
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
  return data.choices?.[0]?.message?.content || '';
}
