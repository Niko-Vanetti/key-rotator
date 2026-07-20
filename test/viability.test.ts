import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeViability, pingToolCalling, analyzeViability, type ViabilityFacts } from '../src/agent/aiTools.js';

// ---- judgeViability (pura, sin red) -----------------------------------------

test('no responde ninguna vez → no-viable', () => {
  const r = judgeViability({ attempts: 2, successes: 0, latencyMs: null, supportsTools: null });
  assert.equal(r.verdict, 'no-viable');
  assert.match(r.reasons[0], /no respondió ninguna de las 2/);
});

test('rápido, consistente y con herramientas → recomendado (el caso glm-5.2/deepseek-v4-pro)', () => {
  const r = judgeViability({ attempts: 2, successes: 2, latencyMs: 800, supportsTools: true });
  assert.equal(r.verdict, 'recomendado');
  assert.match(r.reasons[0], /responde rápido \(0\.8s\)/);
});

test('inconsistente (responde a veces) → usable con aviso (el caso gemma: a veces sí, a veces nunca)', () => {
  const r = judgeViability({ attempts: 2, successes: 1, latencyMs: 3000, supportsTools: true });
  assert.equal(r.verdict, 'usable');
  assert.match(r.reasons.join(' '), /inconsistente: solo respondió 1\/2/);
});

test('muy lento (>40s) → usable con aviso (el caso gemma cuando sí respondió: 120s)', () => {
  const r = judgeViability({ attempts: 2, successes: 2, latencyMs: 120_000, supportsTools: true });
  assert.equal(r.verdict, 'usable');
  assert.match(r.reasons.join(' '), /muy lento: 120s/);
});

test('algo lento (15-40s) se marca distinto de "muy lento"', () => {
  const r = judgeViability({ attempts: 2, successes: 2, latencyMs: 20_000, supportsTools: true });
  assert.equal(r.verdict, 'usable');
  assert.match(r.reasons.join(' '), /algo lento: 20s/);
  assert.doesNotMatch(r.reasons.join(' '), /muy lento/);
});

test('sin soporte de herramientas → usable con aviso claro para Modo agente', () => {
  const r = judgeViability({ attempts: 2, successes: 2, latencyMs: 900, supportsTools: false });
  assert.equal(r.verdict, 'usable');
  assert.match(r.reasons.join(' '), /no soporta herramientas/);
  assert.match(r.reasons.join(' '), /Modo agente/);
});

test('varios problemas a la vez se listan todos', () => {
  const r = judgeViability({ attempts: 2, successes: 1, latencyMs: 50_000, supportsTools: false });
  assert.equal(r.verdict, 'usable');
  assert.equal(r.reasons.length, 3);
});

// ---- pingToolCalling (fetch simulado) ---------------------------------------

test('pingToolCalling detecta tool_calls reales en la respuesta', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 'ping', arguments: '{}' } }] } }] }),
      { status: 200 }
    )) as typeof fetch;
  try {
    assert.equal(await pingToolCalling('https://x.test/v1', 'k', 'modelo-bueno'), true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('pingToolCalling es false si responde texto en vez de invocar la función', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: 'No puedo hacer eso.' } }] }), { status: 200 })) as typeof fetch;
  try {
    assert.equal(await pingToolCalling('https://x.test/v1', 'k', 'modelo-sin-tools'), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('pingToolCalling es false ante HTTP de error (el caso 400 "no function calling")', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response('bad request', { status: 400 })) as typeof fetch;
  try {
    assert.equal(await pingToolCalling('https://x.test/v1', 'k', 'm'), false);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- analyzeViability de punta a punta (fetch simulado) --------------------

test('analyzeViability: modelo sano → recomendado en 3 peticiones', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    if (calls <= 2) {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'PONG' } }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ choices: [{ message: { tool_calls: [{ function: { name: 'ping' } }] } }] }), { status: 200 });
  }) as typeof fetch;
  try {
    const r = await analyzeViability('https://x.test/v1', 'k', 'z-ai/glm-5.2');
    assert.equal(calls, 3, 'debe hacer exactamente 3 peticiones (2 pings + 1 de herramientas)');
    assert.equal(r.verdict, 'recomendado');
    assert.equal(r.successes, 2);
    assert.equal(r.supportsTools, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('analyzeViability: modelo muerto → no-viable, sin llegar a probar herramientas', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error('The operation was aborted due to timeout');
  }) as typeof fetch;
  try {
    const r = await analyzeViability('https://x.test/v1', 'k', 'google/gemma-4-31b-it');
    assert.equal(calls, 2, 'no debe gastar la 3ra petición si nunca respondió');
    assert.equal(r.verdict, 'no-viable');
    assert.equal(r.supportsTools, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});
