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

test('analyzeViability: solo timeouts → no-concluyente (reintenta antes de juzgar)', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error('The operation was aborted due to timeout');
  }) as typeof fetch;
  try {
    const r = await analyzeViability('https://x.test/v1', 'k'.repeat(20), 'google/gemma-4-31b-it');
    // 2 pruebas × (intento + reintento) = 4; nunca se prueba herramientas.
    assert.equal(calls, 4, 'cada prueba reintenta una vez ante un fallo transitorio');
    assert.equal(r.verdict, 'no-concluyente', 'un timeout no basta para condenar al modelo');
    assert.equal(r.supportsTools, null);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('analyzeViability: modelo realmente inválido (404) → no-viable sin reintentar', async () => {
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return new Response('{"detail":"Not Found"}', { status: 404 });
  }) as typeof fetch;
  try {
    const r = await analyzeViability('https://x.test/v1', 'k'.repeat(20), 'modelo/inexistente');
    assert.equal(calls, 2, 'un 404 real no se reintenta');
    assert.equal(r.verdict, 'no-viable');
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- escaneo de una carpeta de skills (repo completo) ----------------------

test('findSkills recorre un repo y encuentra carpetas con SKILL.md y .md sueltos', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { findSkills } = await import('../src/agent/tools.js');

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-repo-'));
  try {
    // Estructura típica de un repo de skills.
    const mk = (p: string, content = 'x') => {
      fs.mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      fs.writeFileSync(path.join(root, p), content);
    };
    mk('skills/ponytail/SKILL.md');
    mk('skills/ponytail/referencia.md');          // archivo de apoyo, no es otra skill
    mk('skills/niko-webdev/SKILL.md');
    mk('otras/humanizer.md');                      // .md suelto = skill
    mk('README.md');                               // documentación, NO es skill
    mk('LICENSE.md');                              // idem
    mk('.git/config');                             // se ignora
    mk('node_modules/paquete/SKILL.md');           // se ignora

    const found = findSkills(root);
    const names = found.map((f) => f.name);

    assert.ok(names.includes('ponytail'), 'debe encontrar la carpeta con SKILL.md');
    assert.ok(names.includes('niko-webdev'));
    assert.ok(names.includes('humanizer'), 'debe encontrar el .md suelto');
    assert.ok(!names.includes('README'), 'README no es una skill');
    assert.ok(!names.includes('LICENSE'), 'LICENSE no es una skill');
    assert.ok(!names.includes('paquete'), 'node_modules debe ignorarse');
    assert.ok(!names.includes('referencia'), 'no debe entrar dentro de una skill ya detectada');

    // La carpeta se marca como directorio (se copia entera con sus archivos).
    const pony = found.find((f) => f.name === 'ponytail')!;
    assert.equal(pony.isDir, true);
    const hum = found.find((f) => f.name === 'humanizer')!;
    assert.equal(hum.isDir, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findSkills detecta cuando la carpeta apuntada ES la skill', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { findSkills } = await import('../src/agent/tools.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-skill-'));
  try {
    fs.writeFileSync(path.join(root, 'SKILL.md'), 'contenido');
    const found = findSkills(root);
    assert.equal(found.length, 1);
    assert.equal(found[0].isDir, true);
    assert.equal(found[0].source, root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('findSkills devuelve vacío en una carpeta sin skills', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { findSkills } = await import('../src/agent/tools.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-vacio-'));
  try {
    fs.writeFileSync(path.join(root, 'notas.txt'), 'x');
    assert.deepEqual(findSkills(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ---- fiabilidad: el proveedor saturado NO es culpa del modelo --------------

test('todos los fallos transitorios (429/5xx/timeout) → no-concluyente, NO no-viable', () => {
  // El caso real: el mismo modelo salía "recomendado" y "no viable" en pruebas
  // distintas porque probar varios seguidos generaba 429 propios.
  const r = judgeViability({
    attempts: 2,
    successes: 0,
    latencyMs: null,
    supportsTools: null,
    transientFailures: 2,
    lastFailure: 'HTTP 429: Too Many Requests',
  });
  assert.equal(r.verdict, 'no-concluyente');
  assert.match(r.reasons[0], /NO significa que el modelo esté mal/);
  assert.match(r.reasons[0], /429/);
});

test('un fallo real (404) sí da no-viable aunque el otro fuera transitorio', () => {
  const r = judgeViability({
    attempts: 2,
    successes: 0,
    latencyMs: null,
    supportsTools: null,
    transientFailures: 1,
    lastFailure: 'HTTP 404: modelo no habilitado',
  });
  assert.equal(r.verdict, 'no-viable');
  assert.match(r.reasons[0], /404/);
});

test('sin datos de transitoriedad se mantiene el veredicto duro (compatibilidad)', () => {
  const r = judgeViability({ attempts: 2, successes: 0, latencyMs: null, supportsTools: null });
  assert.equal(r.verdict, 'no-viable');
});

test('pingModel marca 429 y 5xx como transitorios, y 404 como real', async () => {
  const { pingModel } = await import('../src/agent/aiTools.js');
  const realFetch = globalThis.fetch;
  const withStatus = (status: number, body = '{}') => {
    globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
    return pingModel('https://x.test/v1', 'k'.repeat(20), 'm');
  };
  try {
    assert.equal((await withStatus(429)).transient, true, '429 = límite, no culpa del modelo');
    assert.equal((await withStatus(500)).transient, true, '5xx = caída momentánea');
    assert.equal((await withStatus(404, '{"detail":"Not Found"}')).transient, false, '404 real = modelo inválido');
    // El 404 "Not found for account" de NVIDIA sí es intermitente (comprobado).
    const nv = await withStatus(404, '{"detail":"Function \'x\': Not found for account \'y\'"}');
    assert.equal(nv.transient, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- diagnósticos precisos (casos reales de la cuenta del usuario) ---------

test('modelo que responde sin texto = NO es de chat (diffusiongemma), no "caído"', () => {
  const r = judgeViability({
    attempts: 2,
    successes: 0,
    latencyMs: null,
    supportsTools: null,
    transientFailures: 0,
    lastFailure: 'respondió sin texto',
    failureKinds: ['empty', 'empty'],
  });
  assert.equal(r.verdict, 'no-viable');
  assert.match(r.reasons[0], /no es un modelo de chat/);
  assert.match(r.reasons[0], /imágenes, embeddings o reranking/);
  // El mensaje viejo mentía: el modelo SÍ responde, solo que sin texto.
  assert.doesNotMatch(r.reasons[0], /caído/);
});

test('404 "not found for account" persistente = no habilitado, con la acción a tomar', () => {
  const r = judgeViability({
    attempts: 2,
    successes: 0,
    latencyMs: null,
    supportsTools: null,
    transientFailures: 2,
    lastFailure: "HTTP 404: Function 'x': Not found for account 'y'",
    failureKinds: ['not-enabled', 'not-enabled'],
  });
  assert.equal(r.verdict, 'no-viable');
  assert.match(r.reasons[0], /no tiene habilitado este modelo/);
  assert.match(r.reasons[0], /Get API Key/);
  // Ya no dice "vuelve a intentarlo": reintentar no lo va a arreglar.
  assert.doesNotMatch(r.reasons[0], /Vuelve a intentarlo/);
});

test('un 429 mezclado con otro fallo sigue siendo no-concluyente', () => {
  const r = judgeViability({
    attempts: 2,
    successes: 0,
    latencyMs: null,
    supportsTools: null,
    transientFailures: 2,
    lastFailure: 'HTTP 429',
    failureKinds: ['rate-limit', 'timeout'],
  });
  assert.equal(r.verdict, 'no-concluyente');
});

test('pingModel clasifica cada tipo de fallo', async () => {
  const { pingModel } = await import('../src/agent/aiTools.js');
  const realFetch = globalThis.fetch;
  const probe = (status: number, body: string) => {
    globalThis.fetch = (async () => new Response(body, { status })) as typeof fetch;
    return pingModel('https://x.test/v1', 'k'.repeat(20), 'm');
  };
  try {
    assert.equal((await probe(429, '{}')).kind, 'rate-limit');
    assert.equal((await probe(500, '{}')).kind, 'server');
    assert.equal((await probe(404, '{"detail":"Not Found"}')).kind, 'invalid');
    assert.equal((await probe(404, '{"detail":"Function \'a\': Not found for account \'b\'"}')).kind, 'not-enabled');
    // 200 con respuesta vacía = modelo que no es de chat.
    const empty = await probe(200, JSON.stringify({ choices: [{ message: { content: '' } }] }));
    assert.equal(empty.kind, 'empty');
    assert.equal(empty.transient, undefined, 'vacío NO se reintenta: no va a cambiar');
    const ok = await probe(200, JSON.stringify({ choices: [{ message: { content: 'PONG' } }] }));
    assert.equal(ok.kind, 'ok');
    assert.equal(ok.ok, true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
