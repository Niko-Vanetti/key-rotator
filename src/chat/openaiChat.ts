/**
 * Minimal OpenAI-compatible chat streaming (used for OpenRouter and any
 * OpenAI-style endpoint). Streams assistant deltas via Server-Sent Events.
 * Pure-ish: only depends on global fetch, so it runs in the extension host.
 */

export interface OAIMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OAIStreamOptions {
  endpoint: string; // base URL, e.g. https://openrouter.ai/api/v1
  apiKey: string;
  model: string;
  messages: OAIMessage[];
  onDelta: (text: string) => void;
  signal?: AbortSignal;
}

/** Returns the full assistant text, or an error string. */
export async function streamOpenAIChat(
  opts: OAIStreamOptions
): Promise<{ text: string } | { error: string }> {
  const url = opts.endpoint.replace(/\/+$/, '') + '/chat/completions';
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter asks for these for attribution / rankings (optional).
        'HTTP-Referer': 'https://github.com/Nikorasu-Vanetti/key-rotator',
        'X-Title': 'KeyRotator',
      },
      body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: true }),
      signal: opts.signal,
    });
  } catch (e) {
    return { error: `sin conexión: ${(e as Error).message}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Surface the provider's message (rate limit, bad model id, no credit, …).
    let msg = body.slice(0, 300);
    try {
      const j = JSON.parse(body);
      msg = j?.error?.message || msg;
    } catch {
      /* keep raw */
    }
    return { error: `HTTP ${res.status}: ${msg}` };
  }

  const reader = res.body?.getReader();
  if (!reader) return { error: 'respuesta sin cuerpo' };
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') return { text: full };
      try {
        const j = JSON.parse(data);
        const delta = j?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          full += delta;
          opts.onDelta(delta);
        }
        if (j?.error?.message) return { error: String(j.error.message) };
      } catch {
        // partial JSON across chunks — wait for more
      }
    }
  }
  return { text: full };
}
