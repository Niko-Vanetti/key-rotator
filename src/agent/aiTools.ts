import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * "AI-grade" tools beyond the filesystem: web fetch, web search, image
 * generation and deep research. All free/keyless by default (DuckDuckGo HTML,
 * r.jina.ai reader) except image generation, which reuses the account's own
 * NVIDIA Build key. Network failures return a message for the model, never throw.
 */

export interface AiToolContext {
  /** Working folder — generated images/reports land here. */
  getCwd(): string;
  /** The active account's key + endpoint (for NVIDIA image models). */
  apiKey: string;
  endpoint: string;
  provider: string;
}

const FETCH_CAP = 60_000;

/** Strip HTML to readable text (pure, tested). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(td|th)>/gi, '\t')
    // Inline tags disappear WITHOUT adding a space, or they split words
    // ("adi<b>ós</b>" must stay "adiós").
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n\s*\n+/g, '\n\n')
    .trim();
}

/** Parse DuckDuckGo's HTML result page into {title,url,snippet} (pure, tested). */
export function parseDuckResults(html: string, limit = 8): { title: string; url: string; snippet: string }[] {
  const out: { title: string; url: string; snippet: string }[] = [];
  const blocks = html.split(/<div[^>]*class="[^"]*\bresult\b[^"]*"/i).slice(1);
  for (const b of blocks) {
    const linkMatch = b.match(/<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;
    let url = linkMatch[1];
    // DDG wraps targets: /l/?uddg=<encoded>
    const wrapped = url.match(/[?&]uddg=([^&]+)/);
    if (wrapped) url = decodeURIComponent(wrapped[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    const snipMatch = b.match(/class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
    out.push({
      title: htmlToText(linkMatch[2]).slice(0, 200),
      url,
      snippet: snipMatch ? htmlToText(snipMatch[1]).slice(0, 300) : '',
    });
    if (out.length >= limit) break;
  }
  return out;
}

/** Unique, filesystem-safe name inside the working folder. */
function outPath(cwd: string, base: string, ext: string): string {
  const safe = base.replace(/[^\w\-]+/g, '_').slice(0, 40) || 'salida';
  const dir = path.join(cwd, 'salidas');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${safe}_${Date.now()}.${ext}`);
}

export async function fetchUrl(url: string): Promise<string> {
  if (!/^https?:\/\//i.test(url)) return 'ERROR: la URL debe empezar por http:// o https://';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (KeyRotator agent)' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return `ERROR: HTTP ${res.status} al abrir ${url}`;
    const type = res.headers.get('content-type') ?? '';
    const body = await res.text();
    const text = /json|text\/plain/.test(type) ? body : htmlToText(body);
    return text.length > FETCH_CAP ? text.slice(0, FETCH_CAP) + '\n…[truncado]' : text || '(sin contenido de texto)';
  } catch (e) {
    return `ERROR al abrir ${url}: ${(e as Error).message}`;
  }
}

/** DuckDuckGo's date filter (df) for a recency word (pure, tested). */
export function recencyParam(recency?: string): string {
  const r = (recency ?? '').toLowerCase();
  if (/dia|día|day|hoy|24h/.test(r)) return 'd';
  if (/semana|week/.test(r)) return 'w';
  if (/mes|month/.test(r)) return 'm';
  if (/año|ano|year/.test(r)) return 'y';
  return '';
}

/**
 * Web search. `recency` ('dia'|'semana'|'mes'|'año') applies the engine's date
 * filter — essential for "latest/most recent X" questions, where undated
 * results are usually stale.
 */
export async function webSearch(query: string, limit = 8, recency?: string): Promise<string> {
  const q = query.trim();
  if (!q) return 'ERROR: consulta vacía.';
  const df = recencyParam(recency);
  try {
    const url =
      'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(q) + (df ? `&df=${df}` : '');
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (KeyRotator agent)' },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return `ERROR: el buscador devolvió HTTP ${res.status}`;
    let results = parseDuckResults(await res.text(), limit);
    if (results.length === 0 && df) {
      // Nothing in that window — retry without the filter and say so.
      const wide = await webSearch(q, limit);
      return `Sin resultados en la ventana "${recency}". Resultados generales (verifica fechas):\n\n${wide}`;
    }
    if (results.length === 0) return `Sin resultados para "${q}".`;
    const header = df
      ? `Resultados filtrados a: último ${recency}. Hoy es ${new Date().toISOString().slice(0, 10)}.\n\n`
      : `Hoy es ${new Date().toISOString().slice(0, 10)}. OJO: estos resultados pueden ser antiguos — confirma la fecha antes de afirmar que algo es "lo más reciente".\n\n`;
    return header + results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
  } catch (e) {
    return `ERROR de búsqueda: ${(e as Error).message}`;
  }
}

/**
 * Image generation through NVIDIA Build's image models. Their invoke endpoints
 * return base64 in either `artifacts[].base64` or `data[].b64_json`, so both
 * shapes are handled; the file lands in <cwd>/salidas.
 */
export async function generateImage(
  ctx: AiToolContext,
  prompt: string,
  model = 'black-forest-labs/flux.1-dev'
): Promise<string> {
  if (!prompt.trim()) return 'ERROR: prompt vacío.';
  if (!ctx.apiKey) return 'ERROR: la cuenta activa no tiene API key.';
  const base = ctx.endpoint.replace(/\/v1\/?$/, '');
  const urls = [`${base}/v1/genai/${model}`, `${base}/v1/infer/${model}`];
  let lastErr = '';
  for (const url of urls) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ prompt, width: 1024, height: 1024, steps: 30, cfg_scale: 3.5, seed: 0 }),
        signal: AbortSignal.timeout(180_000),
      });
      const body = await res.text();
      if (!res.ok) {
        lastErr = `HTTP ${res.status}: ${body.slice(0, 200)}`;
        continue;
      }
      const json = JSON.parse(body) as {
        artifacts?: { base64?: string }[];
        data?: { b64_json?: string; url?: string }[];
        image?: string;
      };
      const b64 = json.artifacts?.[0]?.base64 ?? json.data?.[0]?.b64_json ?? json.image;
      if (!b64) {
        const remote = json.data?.[0]?.url;
        if (remote) return `Imagen generada (URL): ${remote}`;
        lastErr = `respuesta sin imagen: ${body.slice(0, 200)}`;
        continue;
      }
      const file = outPath(ctx.getCwd(), prompt.slice(0, 30), 'png');
      fs.writeFileSync(file, Buffer.from(b64.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
      return `Imagen generada y guardada en: ${file}`;
    } catch (e) {
      lastErr = (e as Error).message;
    }
  }
  return `ERROR generando la imagen con "${model}": ${lastErr}. Prueba otro modelo de imagen de build.nvidia.com (p.ej. stabilityai/stable-diffusion-3.5-large).`;
}

/** Source count per depth level (pure, tested). */
export function sourcesForDepth(depth?: string): number {
  const d = (depth ?? '').toLowerCase();
  if (d.startsWith('rap') || d.startsWith('quick')) return 3;
  if (d.startsWith('prof') || d.startsWith('deep')) return 8;
  return 5;
}

/**
 * Deep research: search, then read the top sources in parallel and return
 * numbered notes with citations. The model turns these into the final report
 * (and can save it with write_file).
 */
export async function deepResearch(topic: string, depth?: string, recency?: string): Promise<string> {
  const t = topic.trim();
  if (!t) return 'ERROR: tema vacío.';
  const want = sourcesForDepth(depth);
  const searchOut = await webSearch(t, want + 4, recency);
  if (searchOut.startsWith('ERROR') || searchOut.startsWith('Sin resultados')) return searchOut;

  const urls = [...searchOut.matchAll(/^\s+(https?:\/\/\S+)$/gm)].map((m) => m[1]).slice(0, want);
  const pages = await Promise.all(
    urls.map(async (u) => {
      const body = await fetchUrl(u);
      return { url: u, body: body.startsWith('ERROR') ? null : body.slice(0, 12_000) };
    })
  );
  const ok = pages.filter((p) => p.body);
  if (ok.length === 0) return `Búsqueda hecha pero no se pudo leer ninguna fuente.\n\n${searchOut}`;

  const notes = ok
    .map((p, i) => `--- FUENTE [${i + 1}] ${p.url} ---\n${p.body}`)
    .join('\n\n');
  return [
    `INVESTIGACIÓN sobre: ${t}`,
    `Fuentes leídas: ${ok.length} de ${urls.length} intentadas.`,
    '',
    'RESULTADOS DE BÚSQUEDA:',
    searchOut,
    '',
    'CONTENIDO DE LAS FUENTES:',
    notes,
    '',
    `INSTRUCCIÓN: hoy es ${new Date().toISOString().slice(0, 10)}. Redacta un informe profesional en español con: resumen ejecutivo, hallazgos organizados por tema, datos concretos CON SU FECHA, limitaciones, y una sección de Fuentes con las URLs numeradas [1], [2]… Cita [n] en el texto. Descarta o marca como dudoso todo dato del que no puedas establecer la fecha, y prioriza siempre lo más reciente. Si el usuario pidió un archivo, guárdalo con write_file (.md) o genera .docx con PowerShell.`,
  ].join('\n');
}

/** Reads an image file as a data URL for vision models (pure I/O, tested). */
export function imageToDataUrl(file: string): string | null {
  const ext = path.extname(file).toLowerCase().replace('.', '');
  const mime =
    ext === 'jpg' || ext === 'jpeg'
      ? 'image/jpeg'
      : ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'gif'
            ? 'image/gif'
            : null;
  if (!mime) return null;
  try {
    return `data:${mime};base64,${fs.readFileSync(file).toString('base64')}`;
  } catch {
    return null;
  }
}

/** Ranks available model ids by similarity to the one that failed (pure, tested). */
export function closestModels(wanted: string, available: string[], limit = 5): string[] {
  const w = wanted.toLowerCase();
  // Ojo: tokens de 2 caracteres SÍ cuentan — "v4" es justo lo que distingue
  // deepseek-v4 de deepseek-r2. Filtrarlos hacía perder la pista útil.
  const parts = w.split(/[^a-z0-9.]+/).filter((p) => p.length >= 2);
  return available
    .map((id) => {
      const s = id.toLowerCase();
      let score = 0;
      for (const p of parts) if (s.includes(p)) score += p.length;
      if (s.startsWith(w.split('/')[0])) score += 3; // misma familia/vendor
      return { id, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map((x) => x.id);
}

/**
 * On a 404 the model id is usually wrong: ask the provider which ids the key
 * really has and suggest the closest ones. Never throws.
 */
export async function suggestModels(endpoint: string, apiKey: string, wanted: string): Promise<string> {
  try {
    const res = await fetch(endpoint.replace(/\/+$/, '') + '/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return '';
    const json = (await res.json()) as { data?: { id: string }[] };
    const ids = (json.data ?? []).map((m) => m.id);
    if (ids.length === 0) return '';
    const near = closestModels(wanted, ids);
    return near.length
      ? `\n\nModelos parecidos que SÍ acepta tu key:\n${near.map((i) => `  • ${i}`).join('\n')}`
      : `\n\nTu key tiene ${ids.length} modelos disponibles, pero ninguno se parece a "${wanted}".`;
  } catch {
    return '';
  }
}

export function isImageFile(file: string): boolean {
  return /\.(png|jpe?g|webp|gif)$/i.test(file);
}
