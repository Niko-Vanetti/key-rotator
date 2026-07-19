import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as os from 'node:os';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { splitJsonLines, contentToText } from '../src/agent/mcpClient.js';
import { AgentStore, newAgentSession } from '../src/agent/agentStore.js';

test('splitJsonLines yields complete objects and keeps the partial tail', () => {
  const { messages, rest } = splitJsonLines('{"a":1}\n{"b":2}\n{"c":');
  assert.deepEqual(messages, [{ a: 1 }, { b: 2 }]);
  assert.equal(rest, '{"c":');
});

test('splitJsonLines skips non-JSON log lines', () => {
  const { messages } = splitJsonLines('server ready\n{"id":1}\n');
  assert.deepEqual(messages, [{ id: 1 }]);
});

test('contentToText flattens MCP content blocks and flags errors', () => {
  assert.equal(contentToText({ content: [{ type: 'text', text: 'hola' }, { type: 'text', text: 'mundo' }] }), 'hola\nmundo');
  assert.match(contentToText({ isError: true, content: [{ type: 'text', text: 'boom' }] }), /ERROR del servidor MCP: boom/);
});

test('AgentStore.search finds matches across chats and read_chat returns the transcript', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-mem-'));
  try {
    const store = new AgentStore(dir);
    const a = newAgentSession('acc', 'nvidia', 'm', 'C:\\w');
    a.messages.push({ role: 'system', content: 'sys' });
    a.messages.push({ role: 'user', content: 'Diseñemos el logo de PixelForge Studio' });
    a.messages.push({ role: 'assistant', content: 'Va, propongo un degradado azul.' });
    store.save(a);
    const b = newAgentSession('acc', 'nvidia', 'm', 'C:\\w');
    b.messages.push({ role: 'user', content: 'algo sin relación' });
    store.save(b);

    const hit = store.search('pixelforge');
    assert.match(hit, /Coincidencias en 1 chat/);
    assert.match(hit, new RegExp(a.id));

    const miss = store.search('inexistente-xyz');
    assert.match(miss, /Sin coincidencias/);

    const tx = store.transcript(a.id);
    assert.match(tx, /\[USUARIO\] Diseñemos el logo/);
    assert.match(tx, /\[ASISTENTE\] Va, propongo/);
    assert.doesNotMatch(tx, /\[system\]/i); // system messages excluded
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
