import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildImageRequest, explainImageError, extractImageB64, extractImageUrl, imageEndpoint } from './imageModels.js';

/**
 * Ejecuta una petición de imagen (generar o editar) contra NVIDIA Build y
 * guarda el resultado en disco. Ruta y forma de respuesta VERIFICADAS contra
 * la API real: POST https://ai.api.nvidia.com/v1/genai/<modelo> → 200 con
 * {artifacts:[{base64:…}]}.
 */

export interface ImageRunResult {
  ok: boolean;
  /** Ruta del archivo guardado (si salió bien). */
  file?: string;
  /** URL remota, si el proveedor devolvió enlace en vez de bytes. */
  url?: string;
  /** Mensaje para el usuario (error o detalle). */
  detail: string;
  ms: number;
}

/** Nombre de archivo único y seguro dentro de la carpeta de salidas. */
export function outputPath(dir: string, prompt: string): string {
  const base = prompt.replace(/[^\w\s-]+/g, '').trim().replace(/\s+/g, '-').slice(0, 40) || 'imagen';
  return path.join(dir, `${base}-${Date.now()}.png`);
}

/** Tipo MIME a partir de la extensión (pure, tested). */
export function mimeOf(file: string): string {
  const ext = path.extname(file).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return 'image/jpeg';
}

/**
 * Para EDITAR, NVIDIA no acepta la imagen en base64: hay que subirla a su
 * almacén de assets y referenciarla por id. Flujo verificado contra la API:
 *   1) POST /v2/nvcf/assets → {assetId, uploadUrl}
 *   2) PUT uploadUrl con los bytes
 *   3) usar `data:<mime>;example_id,<assetId>` en el campo `image`
 */
export async function uploadAsset(
  apiKey: string,
  bytes: Buffer,
  mime: string
): Promise<{ ok: true; assetId: string } | { ok: false; detail: string }> {
  try {
    const res = await fetch('https://api.nvcf.nvidia.com/v2/nvcf/assets', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({ contentType: mime, description: 'keyrotator-image-edit' }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return { ok: false, detail: `no se pudo preparar la subida (HTTP ${res.status})` };
    const { assetId, uploadUrl } = (await res.json()) as { assetId: string; uploadUrl: string };
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': mime, 'x-amz-meta-nvcf-asset-description': 'keyrotator-image-edit' },
      body: new Uint8Array(bytes),
      signal: AbortSignal.timeout(120_000),
    });
    if (!put.ok) return { ok: false, detail: `falló la subida de la imagen (HTTP ${put.status})` };
    return { ok: true, assetId };
  } catch (e) {
    return { ok: false, detail: `no se pudo subir la imagen: ${(e as Error).message}` };
  }
}

export async function runImage(opts: {
  apiKey: string;
  model: string;
  /** Exact hosted endpoint captured from the NVIDIA Build sample. */
  endpoint?: string;
  prompt: string;
  /** Ruta de la imagen de partida, para EDITARLA. */
  inputFile?: string;
  /** Carpeta donde guardar (se crea si no existe). */
  outDir: string;
  signal?: AbortSignal;
  /** Aviso de progreso (subida del asset, etc.). */
  onStatus?: (text: string) => void;
}): Promise<ImageRunResult> {
  const t0 = Date.now();
  if (!opts.prompt.trim()) return { ok: false, detail: 'Escribe qué imagen quieres.', ms: 0 };

  // Editar exige subir la imagen primero y referenciarla por id.
  let assetId: string | undefined;
  let mime: string | undefined;
  if (opts.inputFile) {
    opts.onStatus?.('Subiendo la imagen a NVIDIA…');
    mime = mimeOf(opts.inputFile);
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(opts.inputFile);
    } catch (e) {
      return { ok: false, detail: `no pude leer la imagen: ${(e as Error).message}`, ms: Date.now() - t0 };
    }
    const up = await uploadAsset(opts.apiKey, bytes, mime);
    if (!up.ok) return { ok: false, detail: up.detail, ms: Date.now() - t0 };
    assetId = up.assetId;
  }

  const body = buildImageRequest({ model: opts.model, prompt: opts.prompt, assetId, mime });
  opts.onStatus?.(assetId ? 'Editando la imagen…' : 'Generando la imagen…');
  // Los modelos de imagen de la capa gratuita devuelven 500 con frecuencia
  // (comprobado): se reintenta antes de darse por vencido.
  for (let attempt = 0; ; attempt++) {
    const r = await attemptImage(opts, body, assetId, t0);
    const retryable = !r.ok && /HTTP 5|momentáneo|no respondió/i.test(r.detail);
    if (r.ok || !retryable || attempt >= 2 || opts.signal?.aborted) return r;
    const wait = 3000 * (attempt + 1);
    opts.onStatus?.(`El servidor falló; reintento ${attempt + 1}/2 en ${wait / 1000}s…`);
    await new Promise((res) => setTimeout(res, wait));
  }
}

/** Un intento de la llamada de imagen. */
async function attemptImage(
  opts: {
    apiKey: string;
    model: string;
    endpoint?: string;
    outDir: string;
    prompt: string;
    signal?: AbortSignal;
  },
  body: Record<string, unknown>,
  assetId: string | undefined,
  t0: number
): Promise<ImageRunResult> {
  try {
    const res = await fetch(opts.endpoint || imageEndpoint(opts.model), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        // Necesario para que el modelo pueda leer el asset subido.
        ...(assetId ? { 'NVCF-INPUT-ASSET-REFERENCES': assetId } : {}),
      },
      body: JSON.stringify(body),
      // Generar una imagen tarda bastante más que un turno de texto.
      signal: opts.signal ?? AbortSignal.timeout(180_000),
    });
    const text = await res.text();
    const ms = Date.now() - t0;
    if (!res.ok) return { ok: false, detail: explainImageError(res.status, text, opts.model), ms };

    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return { ok: false, detail: 'el servidor devolvió una respuesta que no se pudo leer.', ms };
    }
    const b64 = extractImageB64(json);
    if (b64) {
      fs.mkdirSync(opts.outDir, { recursive: true });
      const file = outputPath(opts.outDir, opts.prompt);
      fs.writeFileSync(file, Buffer.from(b64, 'base64'));
      return { ok: true, file, detail: `imagen lista en ${(ms / 1000).toFixed(1)}s`, ms };
    }
    const url = extractImageUrl(json);
    if (url) return { ok: true, url, detail: `imagen generada (enlace) en ${(ms / 1000).toFixed(1)}s`, ms };
    return { ok: false, detail: 'la respuesta no traía ninguna imagen.', ms };
  } catch (e) {
    const ms = Date.now() - t0;
    const msg = (e as Error).message;
    return {
      ok: false,
      ms,
      detail: /abort|timeout/i.test(msg)
        ? `el modelo no respondió en ${Math.round(ms / 1000)}s. Prueba con otro modelo de imagen o reintenta.`
        : msg,
    };
  }
}
