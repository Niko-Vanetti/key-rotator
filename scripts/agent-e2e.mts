/**
 * E2E real del agente NVIDIA/OpenRouter: pide al modelo crear y releer un
 * archivo en una carpeta temporal, con permisos auto-aprobados.
 *
 * Uso:  node --import tsx scripts/agent-e2e.mts <api-key> <modelo> [endpoint]
 * Ej.:  node --import tsx scripts/agent-e2e.mts nvapi-... z-ai/glm-5.2
 *       (endpoint por defecto: https://integrate.api.nvidia.com/v1)
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { runAgentTurn, type AgentMessage } from '../src/agent/agentLoop.js';
import { executeTool, agentSystemPrompt } from '../src/agent/tools.js';
import { PermissionGate } from '../src/agent/permissions.js';

const [apiKey, model, endpoint = 'https://integrate.api.nvidia.com/v1'] = process.argv.slice(2);
if (!apiKey || !model) {
  console.error('Uso: node --import tsx scripts/agent-e2e.mts <api-key> <modelo> [endpoint]');
  process.exit(1);
}

const cwdBox = { dir: fs.mkdtempSync(path.join(os.tmpdir(), 'kr-agent-e2e-')) };
const gate = new PermissionGate(async (msg) => {
  console.log(`\n[PERMISO auto-aprobado] ${msg.split('\n')[0]}`);
  return 'allow';
});

const messages: AgentMessage[] = [
  { role: 'system', content: agentSystemPrompt(cwdBox.dir) },
  {
    role: 'user',
    content:
      'Crea un archivo llamado prueba.txt cuyo contenido sea exactamente la palabra CARPINCHO-4471, y después léelo para confirmar qué dice.',
  },
];

const res = await runAgentTurn({
  endpoint,
  apiKey,
  model,
  messages,
  execute: (name, args) =>
    executeTool(name, args, { getCwd: () => cwdBox.dir, setCwd: (d) => (cwdBox.dir = d), gate }),
  onDelta: (t) => process.stdout.write(t),
  onToolStart: (name, args) => console.log(`\n[TOOL] ${name} ${args}`),
});

console.log('\n---');
if ('error' in res) {
  console.error(`FALLO: ${res.error}`);
  process.exit(1);
}
const written = fs.readFileSync(path.join(cwdBox.dir, 'prueba.txt'), 'utf-8').trim();
console.log(`Archivo en disco: "${written}"`);
if (written !== 'CARPINCHO-4471') {
  console.error('FALLO: el contenido del archivo no coincide.');
  process.exit(1);
}
if (!/CARPINCHO-4471/.test(res.text)) {
  console.error('AVISO: el modelo no citó el contenido en su respuesta final (el archivo sí se escribió bien).');
}
fs.rmSync(cwdBox.dir, { recursive: true, force: true });
console.log('E2E OK: el agente escribió y releyó el archivo de verdad.');
