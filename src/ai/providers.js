import { GEMINI_MODEL, CLAUDE_MODEL } from './models.js';

export async function callGemini(apiKey, prompt) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(apiKey)}`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 16384 },
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Gemini API error ' + resp.status);
  }
  const data = await resp.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

export async function callClaude(apiKey, prompt) {
  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 16384,
      messages: [{ role: 'user', content: prompt }],
      system: 'Jesteś ekspertem od montażu wideo. Zwracasz TYLKO czysty JSON bez komentarzy ani markdown.',
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || 'Claude API error ' + resp.status);
  }
  const data = await resp.json();
  return data.content?.[0]?.text || '';
}

export async function callOpenRouter(apiKey, prompt, orModel) {
  if (!orModel) throw new Error('Nie wybrano modelu OpenRouter!');
  const resp = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': 'Bearer ' + apiKey,
      'HTTP-Referer': window.location.href,
      'X-Title': 'Reels EDL Automator',
    },
    body: JSON.stringify({
      model: orModel,
      max_tokens: 16384,
      temperature: 0.3,
      messages: [
        { role: 'system', content: 'Jesteś ekspertem od montażu wideo. Zwracasz TYLKO czysty JSON bez komentarzy ani markdown.' },
        { role: 'user', content: prompt },
      ],
    }),
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({}));
    throw new Error(err.error?.message || 'OpenRouter API error ' + resp.status);
  }
  const data = await resp.json();
  if (data.error) throw new Error(data.error.message || 'OpenRouter error');
  return data.choices?.[0]?.message?.content || '';
}
