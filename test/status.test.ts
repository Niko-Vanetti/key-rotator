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
