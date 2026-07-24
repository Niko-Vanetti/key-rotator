/**
 * Modo imágenes: generar y EDITAR imágenes con los modelos de NVIDIA Build.
 *
 * Los modelos de imagen no viven en `/v1/chat/completions` ni salen en
 * `/v1/models` (que solo lista los de chat): se invocan por su propia ruta
 * `genai`. Por eso el modo imágenes tiene su propio catálogo y su propio
 * camino de ejecución, separado del chat.
 */

/** Un modelo de imagen conocido, con lo que sabe hacer. */
export interface ImageModel {
  id: string;
  label: string;
  /** true = acepta una imagen de entrada para editarla (image-to-image). */
  canEdit: boolean;
  /** Descripción corta para la UI. */
  note: string;
}

/**
 * Catálogo de modelos de imagen de NVIDIA Build. Se ofrece al usuario aunque
 * su cuenta aún no los tenga habilitados: al usarlos se le dice exactamente
 * qué hacer si hace falta activarlos.
 */
export const IMAGE_MODELS: ImageModel[] = [
  {
    id: 'black-forest-labs/flux.1-kontext-max',
    label: 'FLUX.1 Kontext Max — editar imágenes',
    canEdit: true,
    note: 'El mejor para EDITAR: le pasas una imagen y le dices qué cambiar.',
  },
  {
    id: 'black-forest-labs/flux.1-kontext-dev',
    label: 'FLUX.1 Kontext Dev — editar imágenes',
    canEdit: true,
    note: 'Edición de imágenes con instrucciones en texto.',
  },
  {
    id: 'black-forest-labs/flux.1-dev',
    label: 'FLUX.1 Dev — generar',
    canEdit: false,
    note: 'Generación de alta calidad a partir de un texto.',
  },
  {
    id: 'black-forest-labs/flux.1-schnell',
    label: 'FLUX.1 Schnell — generar (rápido)',
    canEdit: false,
    note: 'Muy rápido, pocos pasos. Ideal para probar ideas.',
  },
  {
    id: 'stabilityai/stable-diffusion-3.5-large',
    label: 'Stable Diffusion 3.5 Large — generar',
    canEdit: false,
    note: 'Generación general.',
  },
];

/**
 * Patrones de nombre que delatan un modelo de imagen (pure, tested).
 * OJO: "diffusion" a secas NO vale. Se comprobó en vivo que
 * `google/diffusiongemma-26b-a4b-it` es un LLM de TEXTO (usa difusión para
 * generar texto, no imágenes): él mismo responde "I cannot draw or generate
 * images. I am Gemma 4… my output is limited to text only".
 */
const IMAGE_PATTERNS =
  /(flux|stable-?diffusion|sdxl|kontext|imagen|consistory|\bsana\b|shuttle|dall-?e|midjourney|picasso)/i;
/** Modelos que el nombre sugiere de imagen pero NO lo son (verificado). */
const NOT_IMAGE = /diffusiongemma|diffusion-?llm|text-?diffusion/i;

/** ¿Este id parece un modelo de imagen? (pure, tested) */
export function isImageModel(id: string): boolean {
  if (NOT_IMAGE.test(id)) return false;
  return IMAGE_PATTERNS.test(id);
}

/** ¿Este id soporta edición (imagen de entrada)? (pure, tested) */
export function canEditImages(id: string): boolean {
  const known = IMAGE_MODELS.find((m) => m.id.toLowerCase() === id.toLowerCase());
  if (known) return known.canEdit;
  // Kontext es la familia de edición de Black Forest Labs.
  return /kontext|edit|inpaint|instruct-pix2pix/i.test(id);
}

/** Metadatos de un modelo, conocido o no (pure, tested). */
export function describeImageModel(id: string): ImageModel {
  const known = IMAGE_MODELS.find((m) => m.id.toLowerCase() === id.toLowerCase());
  if (known) return known;
  return {
    id,
    label: id,
    canEdit: canEditImages(id),
    note: canEditImages(id) ? 'Edición de imágenes.' : 'Generación de imágenes.',
  };
}

/**
 * Ruta para invocar un modelo de imagen. VERIFICADO contra la API real:
 * `https://ai.api.nvidia.com/v1/genai/<modelo>` responde 200 con
 * `{artifacts:[{base64:…}]}`. Las otras rutas que probé —el
 * `/v1/images/generations` estilo OpenAI y el host `integrate`— devuelven
 * "404 page not found", así que NO son válidas para imágenes.
 */
export function imageEndpoint(model: string): string {
  return `https://ai.api.nvidia.com/v1/genai/${model}`;
}

/** Extrae la imagen en base64 de las distintas formas de respuesta (pure, tested). */
export function extractImageB64(json: unknown): string | null {
  const j = json as {
    artifacts?: { base64?: string; b64_json?: string }[];
    data?: { b64_json?: string; url?: string }[];
    image?: string;
    images?: string[];
b64_json?: string;
  };
  const raw =
    j?.artifacts?.[0]?.base64 ??
    j?.artifacts?.[0]?.b64_json ??
    j?.data?.[0]?.b64_json ??
    j?.images?.[0] ??
    j?.image ??
    j?.b64_json;
  if (typeof raw !== 'string' || !raw) return null;
  // A veces viene como data URL completa.
  return raw.replace(/^data:image\/\w+;base64,/, '');
}

/** URL remota, cuando el proveedor devuelve un enlace en vez de bytes (pure). */
export function extractImageUrl(json: unknown): string | null {
  const j = json as { data?: { url?: string }[]; url?: string };
  return j?.data?.[0]?.url ?? j?.url ?? null;
}

/**
 * Cuerpo de la petición. Si hay imagen de entrada se arma una petición de
 * EDICIÓN (image-to-image); si no, de generación (pure, tested).
 */
export function buildImageRequest(opts: {
  model: string;
  prompt: string;
  /**
   * Id del asset ya subido a NVIDIA (no base64). Descubierto probando la API:
   * kontext responde 422 «Expected: example_id, got: base64» si se manda la
   * imagen en base64, y «Field required» si falta. También rechaza `mode`
   * («Extra inputs are not permitted»).
   */
  assetId?: string;
  /** Tipo de la imagen subida, para el prefijo data:. */
  mime?: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
}): Record<string, unknown> {
  const base: Record<string, unknown> = {
    prompt: opts.prompt,
    cfg_scale: 3.5,
    seed: opts.seed ?? 0,
    steps: opts.steps ?? (/schnell|turbo/i.test(opts.model) ? 4 : 30),
  };
  if (opts.assetId) {
    // Formato exacto que acepta la API (el token literal es "example_id").
    base.image = `data:${opts.mime ?? 'image/jpeg'};example_id,${opts.assetId}`;
    // Al editar, el tamaño lo hereda de la imagen: no se manda width/height.
    return base;
  }
  base.width = opts.width ?? 1024;
  base.height = opts.height ?? 1024;
  return base;
}

/** Mensaje de error legible para el usuario según el HTTP (pure, tested). */
export function explainImageError(status: number, body: string, model: string): string {
  if (status === 404 || /not found for account/i.test(body)) {
    return `tu cuenta no tiene habilitado "${model}". Entra a build.nvidia.com, abre ese modelo y genera la API key desde su página ("Get API Key").`;
  }
  if (status === 401 || status === 403) return `tu API key fue rechazada para "${model}" (HTTP ${status}).`;
  if (status === 429) return 'límite de peticiones del proveedor: espera unos segundos y reintenta.';
  if (status >= 500) return `el servidor de NVIDIA falló (HTTP ${status}); suele ser momentáneo, reintenta.`;
  if (status === 400) {
    return /image/i.test(body)
      ? `"${model}" rechazó la imagen de entrada: puede que no soporte edición. Usa un modelo Kontext para editar.`
      : `petición rechazada (HTTP 400): ${body.slice(0, 160)}`;
  }
  return `HTTP ${status}: ${body.slice(0, 160)}`;
}
