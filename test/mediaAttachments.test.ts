import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import {
  attachmentToDataUrl,
  extractAttachmentText,
  inspectAttachment,
  MAX_IMAGE_BYTES,
} from '../src/chat/mediaAttachments.js';

const inTemp = (fn: (dir: string) => void) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-media-'));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
};

test('inspectAttachment identifies images by signature and keeps ownership metadata', () => {
  inTemp((dir) => {
    const file = path.join(dir, 'clipboard.bin');
    fs.writeFileSync(file, Buffer.from('89504e470d0a1a0a00000000', 'hex'));
    const result = inspectAttachment(file, 'paste', true);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.attachment.kind, 'image');
    assert.equal(result.attachment.mime, 'image/png');
    assert.equal(result.attachment.owned, true);
    assert.equal(result.attachment.origin, 'paste');
    assert.ok(result.attachment.id);
  });
});

test('inspectAttachment rejects directories, empty files and oversized clipboard images before encoding', () => {
  inTemp((dir) => {
    assert.equal(inspectAttachment(dir, 'drop', false).ok, false);
    const empty = path.join(dir, 'empty.png');
    fs.writeFileSync(empty, '');
    assert.equal(inspectAttachment(empty, 'paste', true).ok, false);
    const large = path.join(dir, 'large.png');
    fs.writeFileSync(large, Buffer.from('89504e470d0a1a0a', 'hex'));
    fs.truncateSync(large, MAX_IMAGE_BYTES + 1);
    assert.equal(inspectAttachment(large, 'paste', true).ok, false);
  });
});

test('attachmentToDataUrl reads supported bounded images only', () => {
  inTemp((dir) => {
    const image = path.join(dir, 'x.dat');
    fs.writeFileSync(image, Buffer.from('ffd8ffe000104a464946', 'hex'));
    const inspected = inspectAttachment(image, 'picker', false);
    assert.equal(inspected.ok, true);
    if (!inspected.ok) return;
    assert.match(attachmentToDataUrl(inspected.attachment) ?? '', /^data:image\/jpeg;base64,/);

    const text = path.join(dir, 'x.txt');
    fs.writeFileSync(text, 'hello');
    const textResult = inspectAttachment(text, 'picker', false);
    assert.equal(textResult.ok, true);
    if (textResult.ok) assert.equal(attachmentToDataUrl(textResult.attachment), null);
  });
});

test('extractAttachmentText is bounded and rejects binary content', () => {
  inTemp((dir) => {
    const text = path.join(dir, 'notes.md');
    fs.writeFileSync(text, 'hola\nmundo');
    const inspected = inspectAttachment(text, 'picker', false);
    assert.equal(inspected.ok, true);
    if (!inspected.ok) return;
    assert.equal(extractAttachmentText(inspected.attachment), 'hola\nmundo');

    const binary = path.join(dir, 'fake.txt');
    fs.writeFileSync(binary, Buffer.from([0x41, 0, 0x42]));
    const binaryInspected = inspectAttachment(binary, 'picker', false);
    assert.equal(binaryInspected.ok, true);
    if (binaryInspected.ok) assert.equal(extractAttachmentText(binaryInspected.attachment), null);

    const long = path.join(dir, 'long.log');
    fs.writeFileSync(long, 'x'.repeat(120_000));
    const longInspected = inspectAttachment(long, 'picker', false);
    assert.equal(longInspected.ok, true);
    if (longInspected.ok) assert.equal(extractAttachmentText(longInspected.attachment)?.length, 100_000);
  });
});

test('inspectAttachment identifies documents, archives, audio and video without reading them as text', () => {
  inTemp((dir) => {
    const cases = [
      ['report.pdf', 'application/pdf', 'document'],
      ['slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'document'],
      ['bundle.zip', 'application/zip', 'archive'],
      ['voice.mp3', 'audio/mpeg', 'audio'],
      ['clip.mp4', 'video/mp4', 'video'],
    ] as const;
    for (const [name, mime, kind] of cases) {
      const file = path.join(dir, name);
      fs.writeFileSync(file, 'sample');
      const result = inspectAttachment(file, 'drop', false);
      assert.equal(result.ok, true);
      if (!result.ok) continue;
      assert.equal(result.attachment.mime, mime);
      assert.equal(result.attachment.kind, kind);
      assert.equal(extractAttachmentText(result.attachment), null);
    }
  });
});
