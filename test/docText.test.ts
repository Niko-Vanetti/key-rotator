import assert from 'node:assert/strict';
import * as zlib from 'node:zlib';
import { test } from 'node:test';
import { extractDocumentText, extractPdfText, extractOoxmlText } from '../src/chat/docText.js';

const crc32 = (() => {
  const table = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  return (buf: Buffer): number => {
    let c = 0xffffffff;
    for (const b of buf) c = table[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

/** ZIP mínimo (una sola entrada, método stored) para probar el unzip. */
function makeZip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.from(content, 'utf8');
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    locals.push(local, nameBuf, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(Object.keys(entries).length, 8);
  eocd.writeUInt16LE(Object.keys(entries).length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, eocd]);
}

const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

test('extractPdfText reads an uncompressed content stream', () => {
  const pdf = Buffer.from(
    '%PDF-1.4\n1 0 obj\n<< /Length 44 >>\nstream\nBT (Hola) Tj (mundo) Tj ET\nendstream\nendobj\n',
    'latin1'
  );
  assert.equal(extractPdfText(pdf), 'Holamundo');
});

test('extractPdfText inflates a FlateDecode stream', () => {
  const body = zlib.deflateSync(Buffer.from('BT (Comprimido) Tj ET', 'latin1'));
  const pdf = Buffer.concat([Buffer.from('%PDF-1.5\nstream\n', 'latin1'), body, Buffer.from('\nendstream\n', 'latin1')]);
  assert.equal(extractPdfText(pdf), 'Comprimido');
});

test('extractOoxmlText pulls paragraphs from a docx', () => {
  const zip = makeZip({
    'word/document.xml':
      '<?xml version="1.0"?><w:document><w:body>' +
      '<w:p><w:r><w:t>Primera l&#237;nea</w:t></w:r></w:p>' +
      '<w:p><w:r><w:t xml:space="preserve">Segunda </w:t></w:r><w:r><w:t>parte</w:t></w:r></w:p>' +
      '</w:body></w:document>',
  });
  assert.equal(extractOoxmlText(zip, DOCX), 'Primera línea\nSegunda parte');
});

test('extractDocumentText returns null for non-document bytes', () => {
  assert.equal(extractDocumentText(Buffer.from('not a real pdf'), 'application/pdf'), null);
});
