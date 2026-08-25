import assert from 'node:assert/strict';
import test from 'node:test';
import { runImage } from '../src/agent/imageRunner.js';

test('runImage uses the exact endpoint imported from NVIDIA Build', async () => {
  const originalFetch = globalThis.fetch;
  let requested = '';
  globalThis.fetch = (async (input: string | URL | Request) => {
    requested = String(input);
    return new Response(JSON.stringify({ url: 'https://example.test/result.png' }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  try {
    const endpoint = 'https://ai.api.nvidia.com/v1/genai/example/new-image-model';
    const result = await runImage({
      apiKey: 'nvapi-test',
      model: 'example/new-image-model',
      endpoint,
      prompt: 'test',
      outDir: process.cwd(),
    });
    assert.equal(result.ok, true);
    assert.equal(requested, endpoint);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runImage EDITA: sube el asset, usa example_id y la cabecera de referencia', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-edit-'));
  const input = path.join(dir, 'base.jpg');
  fs.writeFileSync(input, Buffer.from([1, 2, 3]));
  const originalFetch = globalThis.fetch;
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  globalThis.fetch = (async (input2: string | URL | Request, init?: RequestInit) => {
    const url = String(input2);
    calls.push({
      url,
      method: init?.method || 'GET',
      headers: (init?.headers as Record<string, string>) || {},
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    // 1) crear asset  2) PUT bytes  3) llamada de imagen
    if (url.includes('/v2/nvcf/assets')) {
      return new Response(JSON.stringify({ assetId: 'asset-xyz', uploadUrl: 'https://s3.test/put' }), { status: 200 });
    }
    if (url === 'https://s3.test/put') return new Response('', { status: 200 });
    return new Response(JSON.stringify({ artifacts: [{ base64: Buffer.from('img').toString('base64') }] }), { status: 200 });
  }) as typeof fetch;

  try {
    const res = await runImage({
      apiKey: 'nvapi-test',
      model: 'black-forest-labs/flux.1-kontext-max',
      prompt: 'cámbiale el cielo a rojo',
      inputFile: input,
      outDir: dir,
    });
    assert.equal(res.ok, true);
    // Orden: asset → PUT → imagen.
    assert.match(calls[0].url, /\/v2\/nvcf\/assets$/);
    assert.equal(calls[1].url, 'https://s3.test/put');
    assert.equal(calls[1].method, 'PUT');
    const imageCall = calls[2];
    // La cabecera de referencia al asset subido va en la llamada de imagen.
    assert.equal(imageCall.headers['NVCF-INPUT-ASSET-REFERENCES'], 'asset-xyz');
    // El body referencia el asset con el token literal "example_id", NO base64.
    assert.match(imageCall.body || '', /"image":"data:image\/jpeg;example_id,asset-xyz"/);
    assert.doesNotMatch(imageCall.body || '', /base64/);
    // La imagen editada se guardó en disco.
    assert.ok(res.file && fs.existsSync(res.file));
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('runImage avisa claro si falla la subida del asset al editar', async () => {
  const os = await import('node:os');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-edit2-'));
  const input = path.join(dir, 'base.png');
  fs.writeFileSync(input, Buffer.from([1]));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input2: string | URL | Request) => {
    if (String(input2).includes('/v2/nvcf/assets')) return new Response('nope', { status: 403 });
    return new Response('{}', { status: 200 });
  }) as typeof fetch;
  try {
    const res = await runImage({
      apiKey: 'k',
      model: 'black-forest-labs/flux.1-kontext-max',
      prompt: 'x',
      inputFile: input,
      outDir: dir,
    });
    assert.equal(res.ok, false);
    assert.match(res.detail, /subida/i);
  } finally {
    globalThis.fetch = originalFetch;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
