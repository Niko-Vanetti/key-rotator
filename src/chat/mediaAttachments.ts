import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { extractDocumentText } from './docText.js';

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_TEXT_CHARS = 100_000;

export type MediaOrigin = 'picker' | 'paste' | 'drop' | 'generated';
export type MediaKind = 'image' | 'audio' | 'video' | 'document' | 'archive' | 'text' | 'unknown';

export interface MediaAttachment {
  id: string;
  name: string;
  path: string;
  mime: string;
  size: number;
  kind: MediaKind;
  origin: MediaOrigin;
  owned: boolean;
}

export type AttachmentInspection =
  | { ok: true; attachment: MediaAttachment }
  | { ok: false; message: string };

const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.css', '.csv', '.go', '.h', '.hpp', '.html', '.ini',
  '.java', '.js', '.json', '.jsx', '.log', '.md', '.mjs', '.ps1', '.py', '.rs',
  '.sh', '.sql', '.svg', '.toml', '.ts', '.tsx', '.txt', '.xml', '.yaml', '.yml',
]);

const byExtension = (file: string): { mime: string; kind: MediaKind } => {
  const ext = path.extname(file).toLowerCase();
  const exact: Record<string, { mime: string; kind: MediaKind }> = {
    '.docx': { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', kind: 'document' },
    '.xlsx': { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', kind: 'document' },
    '.pptx': { mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', kind: 'document' },
    '.pdf': { mime: 'application/pdf', kind: 'document' },
    '.zip': { mime: 'application/zip', kind: 'archive' },
    '.png': { mime: 'image/png', kind: 'image' },
    '.jpg': { mime: 'image/jpeg', kind: 'image' },
    '.jpeg': { mime: 'image/jpeg', kind: 'image' },
    '.gif': { mime: 'image/gif', kind: 'image' },
    '.webp': { mime: 'image/webp', kind: 'image' },
    '.mp3': { mime: 'audio/mpeg', kind: 'audio' },
    '.wav': { mime: 'audio/wav', kind: 'audio' },
    '.ogg': { mime: 'audio/ogg', kind: 'audio' },
    '.m4a': { mime: 'audio/mp4', kind: 'audio' },
    '.mp4': { mime: 'video/mp4', kind: 'video' },
    '.webm': { mime: 'video/webm', kind: 'video' },
    '.mov': { mime: 'video/quicktime', kind: 'video' },
  };
  if (exact[ext]) return exact[ext];
  if (TEXT_EXTENSIONS.has(ext)) return { mime: 'text/plain', kind: 'text' };
  return { mime: 'application/octet-stream', kind: 'unknown' };
};

const bySignature = (head: Buffer): { mime: string; kind: MediaKind } | null => {
  const hex = head.toString('hex');
  if (hex.startsWith('89504e470d0a1a0a')) return { mime: 'image/png', kind: 'image' };
  if (hex.startsWith('ffd8ff')) return { mime: 'image/jpeg', kind: 'image' };
  if (head.subarray(0, 6).toString('ascii') === 'GIF87a' || head.subarray(0, 6).toString('ascii') === 'GIF89a') {
    return { mime: 'image/gif', kind: 'image' };
  }
  if (head.subarray(0, 4).toString('ascii') === 'RIFF' && head.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mime: 'image/webp', kind: 'image' };
  }
  if (head.subarray(0, 4).toString('ascii') === '%PDF') return { mime: 'application/pdf', kind: 'document' };
  return null;
};

export function inspectAttachment(file: string, origin: MediaOrigin, owned: boolean): AttachmentInspection {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return { ok: false, message: 'Solo se pueden adjuntar archivos.' };
    if (stat.size === 0) return { ok: false, message: 'El archivo está vacío.' };
    const fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(Math.min(16, stat.size));
    try {
      fs.readSync(fd, head, 0, head.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const ext = byExtension(file);
    const detected = bySignature(head) ?? ext;
    if (origin === 'paste' && detected.kind === 'image' && stat.size > MAX_IMAGE_BYTES) {
      return { ok: false, message: 'La imagen pegada supera el límite de 20 MB.' };
    }
    return {
      ok: true,
      attachment: {
        id: randomUUID(),
        name: path.basename(file),
        path: path.resolve(file),
        mime: detected.mime,
        size: stat.size,
        kind: detected.kind,
        origin,
        owned,
      },
    };
  } catch (error) {
    return { ok: false, message: `No se pudo leer el archivo: ${(error as Error).message}` };
  }
}

export function attachmentToDataUrl(attachment: MediaAttachment): string | null {
  if (attachment.kind !== 'image' || attachment.size > MAX_IMAGE_BYTES) return null;
  if (!['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(attachment.mime)) return null;
  try {
    return `data:${attachment.mime};base64,${fs.readFileSync(attachment.path).toString('base64')}`;
  } catch {
    return null;
  }
}

const DOC_MIMES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
]);

export function extractAttachmentText(attachment: MediaAttachment): string | null {
  try {
    if (attachment.kind === 'text') {
      const bytes = fs.readFileSync(attachment.path);
      if (bytes.subarray(0, Math.min(bytes.length, 8192)).includes(0)) return null;
      return bytes.toString('utf8').slice(0, MAX_TEXT_CHARS);
    }
    if (attachment.kind === 'document' && DOC_MIMES.has(attachment.mime)) {
      const text = extractDocumentText(fs.readFileSync(attachment.path), attachment.mime);
      return text ? text.slice(0, MAX_TEXT_CHARS) : null;
    }
    return null;
  } catch {
    return null;
  }
}
