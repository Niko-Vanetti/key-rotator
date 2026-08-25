import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { generateImage, htmlToText, parseDuckResults, sourcesForDepth, imageToDataUrl, isImageFile } from '../src/agent/aiTools.js';
import { messageText, newAgentSession, sessionTitle } from '../src/agent/agentStore.js';
import { listSkillNames, readSkill } from '../src/agent/tools.js';

test('htmlToText strips markup, scripts and entities', () => {
  const out = htmlToText('<p>Hola&nbsp;&amp; adi<b>ós</b></p><script>var x=1</script><p>Segundo</p>');
  assert.match(out, /Hola & adiós/);
  assert.match(out, /Segundo/);
  assert.doesNotMatch(out, /var x/);
});

test('parseDuckResults extracts title, unwrapped url and snippet', () => {
  const html = `
    <div class="result results_links">
      <a class="result__a" href="/l/?uddg=https%3A%2F%2Fejemplo.com%2Fdoc">Título <b>uno</b></a>
      <a class="result__snippet">Un extracto útil</a>
    </div>
    <div class="result results_links">
      <a class="result__a" href="https://otro.com">Segundo</a>
      <a class="result__snippet">Otro extracto</a>
    </div>`;
  const r = parseDuckResults(html);
  assert.equal(r.length, 2);
  assert.equal(r[0].title, 'Título uno');
  assert.equal(r[0].url, 'https://ejemplo.com/doc');
  assert.equal(r[0].snippet, 'Un extracto útil');
  assert.equal(r[1].url, 'https://otro.com');
});

test('sourcesForDepth maps the depth words', () => {
  assert.equal(sourcesForDepth('rapida'), 3);
  assert.equal(sourcesForDepth('profunda'), 8);
  assert.equal(sourcesForDepth('deep'), 8);
  assert.equal(sourcesForDepth(undefined), 5);
  assert.equal(sourcesForDepth('normal'), 5);
});

test('isImageFile / imageToDataUrl handle real files and reject non-images', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-img-'));
  try {
    assert.equal(isImageFile('foto.PNG'), true);
    assert.equal(isImageFile('doc.txt'), false);
    // 1x1 transparent PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64'
    );
    const file = path.join(dir, 'x.png');
    fs.writeFileSync(file, png);
    const url = imageToDataUrl(file);
    assert.ok(url && url.startsWith('data:image/png;base64,'));
    const txt = path.join(dir, 'x.txt');
    fs.writeFileSync(txt, 'hola');
    assert.equal(imageToDataUrl(txt), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('generateImage uses the same verified NVIDIA genai endpoint as image mode', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-generate-'));
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(String(input));
    return new Response(
      JSON.stringify({ artifacts: [{ base64: 'iVBORw0KGgo=' }] }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    );
  }) as typeof fetch;
  try {
    const result = await generateImage(
      {
        getCwd: () => dir,
        apiKey: 'nvapi-test',
        endpoint: 'https://integrate.api.nvidia.com/v1',
        provider: 'nvidia',
      },
      'a lighthouse',
      'black-forest-labs/flux.1-dev'
    );
    assert.equal(urls[0], 'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev');
    assert.match(result, /guardada/i);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('messageText flattens vision content parts', () => {
  assert.equal(messageText('texto plano'), 'texto plano');
  assert.equal(
    messageText([
      { type: 'text', text: 'mira esto' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    ]),
    'mira esto [imagen]'
  );
  assert.equal(messageText(null), '');
});

test('sessionTitle works when the first message carries an image', () => {
  const s = newAgentSession('a', 'nvidia', 'm', 'C:\\w');
  s.messages.push({ role: 'user', content: [{ type: 'text', text: 'analiza la foto' }, { type: 'image_url', image_url: { url: 'data:x' } }] });
  assert.equal(sessionTitle(s), 'analiza la foto [imagen]');
});

test('listSkillNames + readSkill find skills in KeyRotator dirs', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-skills-'));
  try {
    fs.mkdirSync(path.join(root, 'mi-metodo'));
    fs.writeFileSync(path.join(root, 'mi-metodo', 'SKILL.md'), '# Mi método\nPaso 1');
    fs.writeFileSync(path.join(root, 'suelta.md'), '# Suelta');
    assert.deepEqual(listSkillNames([root]), ['mi-metodo', 'suelta']);
    assert.match(readSkill('mi-metodo', [root]), /Paso 1/);
    assert.match(readSkill('suelta', [root]), /# Suelta/);
    assert.match(readSkill('no-existe', [root]), /ERROR: no existe/);
    assert.match(readSkill('../escape', [root]), /inválido/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
