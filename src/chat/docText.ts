import * as zlib from 'node:zlib';

// Extrae texto plano de PDF y de Office (docx/xlsx/pptx) SIN dependencias:
// Node ya trae zlib, y ambos formatos comprimen con DEFLATE. No hace OCR —
// un PDF escaneado (solo imágenes) devuelve cadena vacía, y ahí no hay texto
// que sacar sin un modelo de visión.

/** Lee las entradas de un ZIP (docx/xlsx/pptx) vía su directorio central. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // End Of Central Directory: firma 0x06054b50, buscada desde el final
  // (puede haber comentario, así que barremos hasta 64 KB atrás).
  const eocdSig = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === eocdSig) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) return out;
  let p = buf.readUInt32LE(eocd + 16); // offset del directorio central
  while (p + 46 <= buf.length && buf.readUInt32LE(p) === 0x02014b50) {
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    // Cabecera local: los datos empiezan tras nombre + extra locales.
    if (buf.readUInt32LE(localOff) === 0x04034b50) {
      const lNameLen = buf.readUInt16LE(localOff + 26);
      const lExtraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lNameLen + lExtraLen;
      const raw = buf.subarray(dataStart, dataStart + compSize);
      try {
        out.set(name, method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw));
      } catch {
        /* entrada corrupta: la saltamos */
      }
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const decodeEntities = (s: string): string =>
  s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)));

/** Texto de todos los nodos que casan `tag` en un XML, en orden. */
function xmlText(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'g');
  const res: string[] = [];
  for (const m of xml.matchAll(re)) res.push(decodeEntities(m[1]));
  return res;
}

export function extractOoxmlText(buf: Buffer, mime: string): string {
  const files = unzip(buf);
  const get = (name: string) => files.get(name)?.toString('utf8') ?? '';
  const partsFor = (pred: (n: string) => boolean) =>
    [...files.keys()].filter(pred).sort();

  if (mime.includes('wordprocessingml')) {
    // docx: cada <w:p> es un párrafo; <w:t> lleva el texto.
    const xml = get('word/document.xml');
    return xml
      .split(/<\/w:p>/)
      .map((p) => xmlText(p, 'w:t').join(''))
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  if (mime.includes('presentationml')) {
    // pptx: un texto por diapositiva, <a:t> son los runs.
    return partsFor((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n))
      .map((n, i) => `--- Diapositiva ${i + 1} ---\n${xmlText(get(n), 'a:t').join(' ')}`)
      .join('\n\n')
      .trim();
  }

  if (mime.includes('spreadsheetml')) {
    // xlsx: las celdas de texto apuntan a sharedStrings; el resto es inline.
    const shared = xmlText(get('xl/sharedStrings.xml'), 't');
    const sheets = partsFor((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n));
    return sheets
      .map((n, si) => {
        const xml = get(n);
        const cells: string[] = [];
        for (const c of xml.matchAll(/<c\b[^>]*?(?:\st="([^"]*)")?[^>]*>([\s\S]*?)<\/c>/g)) {
          const type = c[1];
          const v = xmlText(c[2], 'v')[0] ?? xmlText(c[2], 't')[0] ?? '';
          if (v === '') continue;
          cells.push(type === 's' ? shared[Number(v)] ?? '' : v);
        }
        return cells.length ? `--- Hoja ${si + 1} ---\n${cells.join('\t')}` : '';
      })
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  return '';
}

/** Decodifica ASCII85 (filtro común en PDF; termina en `~>`). */
function ascii85Decode(buf: Buffer): Buffer | null {
  const out: number[] = [];
  let tuple = 0;
  let count = 0;
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i];
    if (c === 0x7e) break; // '~' → fin
    if (c <= 0x20) continue; // espacios ignorados
    if (c === 0x7a && count === 0) {
      out.push(0, 0, 0, 0); // 'z' = 4 ceros
      continue;
    }
    if (c < 0x21 || c > 0x75) return null; // fuera de rango → no es ASCII85
    tuple = tuple * 85 + (c - 0x21);
    if (++count === 5) {
      out.push((tuple >>> 24) & 0xff, (tuple >>> 16) & 0xff, (tuple >>> 8) & 0xff, tuple & 0xff);
      tuple = 0;
      count = 0;
    }
  }
  if (count > 0) {
    for (let i = count; i < 5; i++) tuple = tuple * 85 + 84;
    for (let i = 0; i < count - 1; i++) out.push((tuple >>> (24 - i * 8)) & 0xff);
  }
  return Buffer.from(out);
}

/** Descomprime un stream de PDF probando los filtros usuales (Flate, ASCII85
 *  y la cadena ASCII85→Flate que usa reportlab). */
function decodePdfStream(raw: Buffer): Buffer {
  const tryInflate = (b: Buffer): Buffer | null => {
    try {
      return zlib.inflateSync(b);
    } catch {
      return null;
    }
  };
  const flate = tryInflate(raw);
  if (flate) return flate;
  // ASCII85 (p.ej. reportlab): se reconoce por su terminador '~>'.
  if (raw.subarray(Math.max(0, raw.length - 8)).includes(0x7e)) {
    const a85 = ascii85Decode(raw);
    if (a85) return tryInflate(a85) ?? a85;
  }
  return raw;
}

/** Deshace los escapes de una cadena literal de PDF: \n \t \( \) \\ \ddd */
const unescapePdf = (s: string): string =>
  s.replace(/\\(\d{1,3}|.)/g, (_, e: string) => {
    if (/^\d{1,3}$/.test(e)) return String.fromCharCode(parseInt(e, 8) & 0xff);
    const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f' };
    return map[e] ?? e;
  });

/** Fracción de caracteres legibles (para descartar streams binarios). */
function printableRatio(s: string): number {
  if (!s) return 0;
  let ok = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 9 || c === 10 || c === 13 || (c >= 32 && c <= 126) || c >= 160) ok++;
  }
  return ok / s.length;
}

/** Saca el texto visible de un content-stream ya descomprimido, o '' si el
 *  stream es binario (fuente/imagen embebida) y no texto de página. */
function pdfStreamText(buf: Buffer): string {
  // Solo nos interesan los streams de contenido: llevan operadores de texto.
  if (!/\bBT\b|\bTj\b|\bTJ\b/.test(buf.toString('latin1', 0, Math.min(buf.length, 4096)))) return '';
  const s = buf.toString('latin1');
  const out: string[] = [];
  // Cadenas literales (...) — el caso común de Tj/TJ.
  for (const m of s.matchAll(/\((?:\\.|[^\\()])*\)/g)) {
    out.push(unescapePdf(m[0].slice(1, -1)));
  }
  // Cadenas hexadecimales <...> de operadores de texto.
  for (const m of s.matchAll(/<([0-9A-Fa-f\s]+)>/g)) {
    const hex = m[1].replace(/\s/g, '');
    if (hex.length >= 2 && hex.length % 2 === 0) {
      let t = '';
      for (let i = 0; i < hex.length; i += 2) t += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
      out.push(t);
    }
  }
  const text = out.join('');
  return printableRatio(text) >= 0.8 ? text : '';
}

export function extractPdfText(buf: Buffer): string {
  const chunks: string[] = [];
  let idx = 0;
  while ((idx = buf.indexOf('stream', idx)) !== -1) {
    if (buf.toString('latin1', idx - 3, idx) === 'end') {
      idx += 6;
      continue;
    }
    let start = idx + 6;
    if (buf[start] === 0x0d) start++;
    if (buf[start] === 0x0a) start++;
    const end = buf.indexOf('endstream', start);
    if (end === -1) break;
    const decoded = decodePdfStream(buf.subarray(start, end));
    const t = pdfStreamText(decoded).trim();
    if (t) chunks.push(t);
    idx = end + 9;
  }
  return chunks.join('\n').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** Devuelve texto extraído según el MIME, o null si no se pudo. */
export function extractDocumentText(buf: Buffer, mime: string): string | null {
  try {
    const text = mime === 'application/pdf' ? extractPdfText(buf) : extractOoxmlText(buf, mime);
    return text.length ? text : null;
  } catch {
    return null;
  }
}
