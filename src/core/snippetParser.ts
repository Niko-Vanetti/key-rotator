/**
 * Parses a pasted API sample snippet (like the Python examples that
 * build.nvidia.com and openrouter.ai show) and extracts EVERYTHING needed to
 * configure an account in one paste: endpoint, api key, model and request
 * params (temperature, top_p, max_tokens, seed). Pure — unit-tested.
 */

/** Only defined values are set: temperature, top_p, max_tokens, seed. */
export type SnippetParams = Record<string, number>;

export interface ParsedSnippet {
  baseUrl: string | null;
  /** Exact hosted invocation URL when the sample exposes or implies it. */
  invocationUrl: string | null;
  method: string | null;
  /** Recognized request fields only; values are never persisted here. */
  requestKeys: string[];
  /** Real key if present; null when the sample carries a placeholder. */
  apiKey: string | null;
  model: string | null;
  params: SnippetParams;
  provider: 'nvidia' | 'openrouter' | null;
}

const PLACEHOLDER = /^\$|^<|YOUR|API_KEY|APIKEY|xxxx/i;

export function parseSnippet(code: string): ParsedSnippet {
  const grab = (re: RegExp): string | null => {
    const m = code.match(re);
    return m ? m[1] : null;
  };

  // base_url = "..."  |  baseURL: '...'  |  --url https://.../v1/...
  let baseUrl =
    grab(/base_?url\s*[=:]\s*["']([^"']+)["']/i) ??
    grab(/(https?:\/\/(?:integrate|ai)\.api\.nvidia\.com\/v1(?:\/[^\s"'\\]+)*)/i) ??
    grab(/(https?:\/\/[\w.-]+\/v1)\b/);
  if (baseUrl) baseUrl = baseUrl.replace(/\/+$/, '');

  let invocationUrl = baseUrl;
  if (baseUrl && /chat\.completions\.create/i.test(code) && /\/v1$/i.test(baseUrl)) {
    invocationUrl = `${baseUrl}/chat/completions`;
  }
  const method =
    grab(/(?:--request|-X)\s+([A-Z]+)/i)?.toUpperCase() ??
    (/requests\.post\s*\(|chat\.completions\.create\s*\(/i.test(code) ? 'POST' : null);

  const requestFields = [
    'cfg_scale',
    'height',
    'image',
    'image_url',
    'max_tokens',
    'messages',
    'model',
    'prompt',
    'seed',
    'steps',
    'stream',
    'temperature',
    'top_p',
    'width',
  ];
  const requestKeys = requestFields.filter((key) => new RegExp(`(?:["']${key}["']|\\b${key}\\b)\\s*[=:]`, 'i').test(code));

  // api_key = "nvapi-..." — placeholders ($NVIDIA_API_KEY, <tu key>, …) don't count.
  let apiKey = grab(/api_?key\s*[=:]\s*["']([^"']+)["']/i);
  if (apiKey && PLACEHOLDER.test(apiKey)) apiKey = null;
  // A bare key anywhere in the paste also works (they often paste just the key).
  if (!apiKey) apiKey = grab(/\b(nvapi-[\w-]{20,})/) ?? grab(/\b(sk-or-[\w-]{20,})/);

  const model =
    grab(/["']?model["']?\s*[=:]\s*["']([^"']+)["']/i) ??
    (invocationUrl?.match(/\/v1\/genai\/([^?#\s]+)/i)?.[1] ?? null);

  const num = (name: string): number | undefined => {
    const v = grab(new RegExp(`["']?${name}["']?\\s*[=:]\\s*(-?[\\d.]+)`, 'i'));
    return v === null ? undefined : Number(v);
  };
  const params: SnippetParams = {};
  const t = num('temperature');
  if (t !== undefined) params.temperature = t;
  const p = num('top_p');
  if (p !== undefined) params.top_p = p;
  const mt = num('max_tokens');
  if (mt !== undefined) params.max_tokens = mt;
  const seed = num('seed');
  if (seed !== undefined) params.seed = seed;

  let provider: ParsedSnippet['provider'] = null;
  const hint = `${invocationUrl ?? baseUrl ?? ''} ${apiKey ?? ''}`;
  if (/nvidia\.com|nvapi-/.test(hint)) provider = 'nvidia';
  else if (/openrouter|sk-or-/.test(hint)) provider = 'openrouter';

  return { baseUrl, invocationUrl, method, requestKeys, apiKey, model, params, provider };
}

/** True when the paste contained anything usable at all. */
export function snippetHasData(s: ParsedSnippet): boolean {
  return !!(s.baseUrl || s.apiKey || s.model);
}
