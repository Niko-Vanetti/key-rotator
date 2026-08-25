import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (name: string) => readFileSync(new URL(`../src/ui/media/${name}`, import.meta.url), 'utf8');

test('chat exposes the approved assistant workspace landmarks', () => {
  const html = read('chat.html');
  const css = read('chat.css');
  const js = read('chat.js');

  assert.match(html, /class="chat-identity"/);
  assert.match(html, /class="welcome-mark"/);
  assert.match(html, /class="command-dock"/);
  assert.match(html, /id="plusBtn"[^>]+aria-label=/);
  assert.match(html, /id="sendBtn"[^>]+aria-label=/);
  assert.match(css, /var\(--vscode-focusBorder/);
  assert.match(css, /@media \(max-width: 560px\)/);
  assert.match(css, /prefers-reduced-motion: reduce/);
  assert.match(html, /id="mediaViewer"[^>]+role="dialog"/);
  assert.match(html, /id="viewerImage"/);
  assert.match(html, /id="viewerClose"[^>]+aria-label=/);
  assert.match(html, /id="viewerPrev"[^>]+aria-label=/);
  assert.match(html, /id="viewerNext"[^>]+aria-label=/);
  assert.match(css, /\.attachment-tile/);
  assert.match(css, /\.media-viewer/);
  assert.match(js, /function openMediaViewer/);
});

test('dashboard exposes a compact operational workspace', () => {
  const html = read('dashboard.html');
  const css = read('dashboard.css');

  assert.match(html, /class="workspace-shell"/);
  assert.match(html, /class="dashboard-header"/);
  assert.match(html, /class="workspace-content"/);
  assert.match(html, /role="tablist"/);
  assert.match(css, /var\(--vscode-editor-background/);
  assert.match(css, /:focus-visible/);
  assert.match(css, /@media \(max-width: 640px\)/);
});
