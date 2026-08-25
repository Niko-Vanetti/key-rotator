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
