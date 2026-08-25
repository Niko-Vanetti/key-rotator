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
  /**
   * Client-side throttle: if set, blocks the request (waiting, not failing)
   * until it fits under this many requests/minute for `throttleKey`. Used to
   * stay under providers with a hard per-account rpm cap (e.g. NVIDIA
   * Build's free tier: 40 rpm) instead of relying on 429s + rotation alone.
   */
  maxPerMinute?: number;
  throttleKey?: string;
  /** Extra request params from the pasted sample (temperature, top_p, …). */
  params?: Record<string, number>;
}

/** rateLimited: true means the caller should try the next account. */
export type OAIStreamResult = { text: string } | { error: string; rateLimited?: boolean };

/** Returns the full assistant text, or an error (flagged when it's a 429). */
export async function streamOpenAIChat(opts: OAIStreamOptions): Promise<OAIStreamResult> {
  if (opts.maxPerMinute && opts.throttleKey) {
    await waitForSlot(opts.throttleKey, opts.maxPerMinute);
  }
  const url = opts.endpoint.replace(/\/+$/, '') + '/chat/completions';
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        // OpenRouter asks for these for attribution / rankings (optional).
        'HTTP-Referer': 'https://github.com/Niko-Vanetti/key-rotator',
        'X-Title': 'KeyRotator',
      },
      body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: true, ...(opts.params ?? {}) }),
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
    return { error: `HTTP ${res.status}: ${msg}`, rateLimited: res.status === 429 };
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

/** Sliding-window request timestamps, per throttle key (e.g. per provider). */
const requestLog = new Map<string, number[]>();

/** Waits until firing a request keeps `key` under `maxPerMinute` for the last 60s. */
export async function waitForSlot(key: string, maxPerMinute: number): Promise<void> {
  for (;;) {
    const now = Date.now();
    const log = (requestLog.get(key) ?? []).filter((t) => now - t < 60_000);
    if (log.length < maxPerMinute) {
      log.push(now);
      requestLog.set(key, log);
      return;
    }
    await new Promise((r) => setTimeout(r, log[0] + 60_000 - now + 50));
  }
}
