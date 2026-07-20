/**
 * Prueba REAL contra NVIDIA Build: mide si un modelo responde, si soporta
 * herramientas y dónde emite el texto (content vs reasoning_content).
 *
 *   node --import tsx scripts/probe-model.mts <api-key> [modelo...]
 *
 * Sin modelos, prueba los tres del usuario.
 */
import { runAgentTurn } from '../src/agent/agentLoop.js';

const [apiKey, ...cli] = process.argv.slice(2);
if (!apiKey) {
  console.error('Uso: node --import tsx scripts/probe-model.mts <nvapi-key> [modelo...]');
  process.exit(1);
}
const ENDPOINT = 'https://integrate.api.nvidia.com/v1';
const models = cli.length ? cli : ['google/gemma-4-31b-it', 'z-ai/glm-5.2', 'deepseek-ai/deepseek-v4-pro'];

/** Llamada cruda: ¿responde? ¿dónde viene el texto? */
async function raw(model: string, withTools: boolean) {
  const t0 = Date.now();
  const res = await fetch(ENDPOINT + '/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: 'Responde exactamente: PONG' }],
      stream: true,
      ...(withTools
        ? {
            tools: [
              {
                type: 'function',
                function: {
                  name: 'web_search',
                  description: 'Busca en internet',
                  parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
                },
              },
            ],
          }
        : {}),
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return { ok: false, ms: Date.now() - t0, detail: `HTTP ${res.status}: ${body.slice(0, 160)}` };
  }
  const text = await res.text();
  let content = '', reasoning = '', toolCalls = 0;
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const d = line.slice(5).trim();
    if (d === '[DONE]') continue;
    try {
      const j = JSON.parse(d);
      const delta = j?.choices?.[0]?.delta ?? {};
      if (typeof delta.content === 'string') content += delta.content;
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (delta.tool_calls) toolCalls += delta.tool_calls.length;
    } catch {
      /* fragmento parcial */
    }
  }
  return {
    ok: true,
    ms: Date.now() - t0,
    detail: `content=${content.length} reasoning=${reasoning.length} toolDeltas=${toolCalls} → "${(content || reasoning).trim().slice(0, 60)}"`,
  };
}

for (const model of models) {
  console.log(`\n=== ${model} ===`);
  for (const withTools of [false, true]) {
    const label = withTools ? 'CON herramientas' : 'sin herramientas';
    // Varios intentos: los 500 de NVIDIA son intermitentes y hay que medirlo.
    let okCount = 0;
    let last = '';
    const ATTEMPTS = 3;
    for (let i = 0; i < ATTEMPTS; i++) {
      try {
        const r = await raw(model, withTools);
        last = `${r.ms}ms ${r.detail}`;
        if (r.ok) okCount++;
        else console.log(`  ${label} intento ${i + 1}: FALLO ${r.detail}`);
      } catch (e) {
        last = (e as Error).message;
        console.log(`  ${label} intento ${i + 1}: EXCEPCIÓN ${last}`);
      }
    }
    console.log(`  ${label}: ${okCount}/${ATTEMPTS} OK — último: ${last}`);
  }

  // Camino real de la extensión (con reintentos incluidos).
  try {
    const res = await runAgentTurn({
      endpoint: ENDPOINT,
      apiKey,
      model,
      messages: [{ role: 'user', content: 'Di solamente: LISTO' }],
      execute: async () => 'ok',
      onDelta: () => {},
      onToolStart: () => {},
      onRetry: (i) => console.log(`  [reintento] ${i}`),
      maxSteps: 3,
    });
    console.log(`  camino de KeyRotator: ${'error' in res ? 'ERROR ' + res.error.slice(0, 140) : 'OK → "' + res.text.trim().slice(0, 60) + '"'}`);
  } catch (e) {
    console.log(`  camino de KeyRotator: EXCEPCIÓN ${(e as Error).message}`);
  }
}
