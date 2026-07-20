import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeTool } from '../src/chat/chatSession.js';
import { isTransientStatus, retryDelay } from '../src/agent/agentLoop.js';

test('describeTool explica en español qué está haciendo la IA', () => {
  assert.equal(
    describeTool('web_search', '{"query":"mejores modelos 2026"}'),
    'Buscando en internet: "mejores modelos 2026"'
  );
  assert.equal(describeTool('read_file', '{"path":"/proyecto/rover.md"}'), 'Leyendo el archivo /proyecto/rover.md');
  assert.equal(describeTool('run_command', '{"command":"npm test"}'), 'Ejecutando: npm test');
  assert.match(describeTool('deep_research', '{"topic":"materiales rover"}'), /Investigando a fondo/);
  assert.match(describeTool('generate_image', '{"prompt":"a rover"}'), /Generando una imagen/);
  assert.equal(describeTool('mcp__context7__query-docs', '{}'), 'Usando la integración context7');
  assert.equal(describeTool('herramienta_rara', '{}'), 'Usando herramienta_rara');
});

test('describeTool recorta valores largos y tolera argumentos rotos', () => {
  const long = describeTool('web_search', JSON.stringify({ query: 'x'.repeat(200) }));
  assert.ok(long.length < 100, 'debe recortarse');
  assert.match(long, /…/);
  assert.equal(describeTool('read_file', 'no-json'), 'Leyendo el archivo ');
});

test('isTransientStatus marca solo los fallos que vale la pena reintentar', () => {
  // El 504 que rompió la planificación del director.
  assert.equal(isTransientStatus(504), true);
  assert.equal(isTransientStatus(502), true);
  assert.equal(isTransientStatus(503), true);
  assert.equal(isTransientStatus(429), true);
  assert.equal(isTransientStatus(408), true);
  // Errores del cliente: reintentar no arregla nada.
  assert.equal(isTransientStatus(400), false);
  assert.equal(isTransientStatus(401), false);
  assert.equal(isTransientStatus(404), false);
});

test('retryDelay crece exponencialmente con tope', () => {
  assert.equal(retryDelay(0), 2000);
  assert.equal(retryDelay(1), 4000);
  assert.equal(retryDelay(2), 8000);
  assert.equal(retryDelay(10), 15000); // tope
});

// ---- interruptor de investigación profunda + diagnóstico de errores --------

test('toolsFor quita deep_research salvo que el usuario lo active', async () => {
  const { toolsFor } = await import('../src/agent/tools.js');
  const names = (list: unknown[]) => list.map((t) => (t as { function: { name: string } }).function.name);
  assert.ok(!names(toolsFor(false)).includes('deep_research'), 'apagado: sin deep_research');
  assert.ok(names(toolsFor(true)).includes('deep_research'), 'encendido: con deep_research');
  // El resto de herramientas sigue disponible en ambos casos.
  for (const t of ['read_file', 'write_file', 'web_search', 'run_command']) {
    assert.ok(names(toolsFor(false)).includes(t), t + ' debe seguir estando');
  }
});

test('agentSystemPrompt cambia de modo directo a investigación', async () => {
  const { agentSystemPrompt } = await import('../src/agent/tools.js');
  const directo = agentSystemPrompt('C:\w', [], false);
  assert.match(directo, /MODO DIRECTO/);
  assert.match(directo, /NO uses herramientas web para saludos/);
  assert.doesNotMatch(directo, /INVESTIGACIÓN PROFUNDA ACTIVADA/);

  const hondo = agentSystemPrompt('C:\w', [], true);
  assert.match(hondo, /INVESTIGACIÓN PROFUNDA ACTIVADA/);
  assert.match(hondo, /deep_research/);
});

test('explainHttpError dice qué significa cada fallo (404 no es una caída)', async () => {
  const { explainHttpError } = await import('../src/agent/agentLoop.js');
  const e404 = explainHttpError(404, '', 'deepseek-ai/deepseek-v4-pro');
  assert.match(e404, /no existe en ese endpoint/);
  assert.match(e404, /deepseek-ai\/deepseek-v4-pro/);
  assert.doesNotMatch(e404, /caída momentánea/);
  assert.match(explainHttpError(401, '', 'm'), /key fue rechazada/);
  assert.match(explainHttpError(400, '', 'm'), /function calling/);
  assert.match(explainHttpError(413, '', 'm'), /demasiado grande/);
  assert.match(explainHttpError(500, 'boom', 'm'), /HTTP 500: boom/);
});

test('closestModels sugiere los ids parecidos al que falló', async () => {
  const { closestModels } = await import('../src/agent/aiTools.js');
  const disponibles = [
    'deepseek-ai/deepseek-v4',
    'deepseek-ai/deepseek-r2',
    'meta/llama-4-maverick',
    'google/gemma-4-31b-it',
  ];
  const near = closestModels('deepseek-ai/deepseek-v4-pro', disponibles);
  assert.equal(near[0], 'deepseek-ai/deepseek-v4');
  assert.ok(near.includes('deepseek-ai/deepseek-r2'));
  assert.ok(!near.includes('google/gemma-4-31b-it'), 'no debe sugerir familias ajenas');
  assert.deepEqual(closestModels('zzz/inexistente', disponibles), []);
});
