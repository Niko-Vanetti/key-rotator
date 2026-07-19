import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { resolveInside, isInside } from '../src/agent/pathGuard.js';
import { PermissionGate, type PermAnswer } from '../src/agent/permissions.js';
import {
  newStreamState,
  accumulateChunk,
  finishedToolCalls,
  runAgentTurn,
  type AgentMessage,
} from '../src/agent/agentLoop.js';
import { newAgentSession, sessionTitle, parseAgentSession } from '../src/agent/agentStore.js';

const BASE = path.resolve('C:\\Users\\test\\Documents\\Agente');

// ---- pathGuard --------------------------------------------------------------

test('resolveInside accepts relative paths inside the base', () => {
  assert.equal(resolveInside(BASE, 'notas.txt'), path.join(BASE, 'notas.txt'));
  assert.equal(resolveInside(BASE, 'sub/archivo.md'), path.join(BASE, 'sub', 'archivo.md'));
  assert.equal(resolveInside(BASE, '.'), BASE);
});

test('resolveInside rejects .. escapes and outside absolute paths', () => {
  assert.equal(resolveInside(BASE, '..\\secreto.txt'), null);
  assert.equal(resolveInside(BASE, '../../Windows/system32'), null);
  assert.equal(resolveInside(BASE, 'C:\\Windows\\system32'), null);
  assert.equal(resolveInside(BASE, 'sub/../../fuera.txt'), null);
});

test('resolveInside accepts absolute paths that stay inside', () => {
  assert.equal(resolveInside(BASE, path.join(BASE, 'x.txt')), path.join(BASE, 'x.txt'));
});

test('isInside is case-insensitive on Windows drive letters/segments', () => {
  if (process.platform === 'win32') {
    assert.equal(isInside(BASE, BASE.toLowerCase() + '\\a.txt'), true);
  }
});

// ---- PermissionGate ---------------------------------------------------------

function gateWith(answers: (PermAnswer | undefined)[]) {
  const asked: string[] = [];
  const gate = new PermissionGate(async (msg) => {
    asked.push(msg);
    return answers.shift();
  });
  return { gate, asked };
}

test('gate allows once without remembering', async () => {
  const { gate, asked } = gateWith(['allow', 'deny']);
  assert.equal(await gate.ask('write', 'a.txt'), true);
  assert.equal(await gate.ask('write', 'b.txt'), false);
  assert.equal(asked.length, 2); // asked both times
});

test('allowAll silences further prompts for that category only', async () => {
  const { gate, asked } = gateWith(['allowAll', 'deny']);
  assert.equal(await gate.ask('command', 'dir'), true);
  assert.equal(await gate.ask('command', 'del x'), true); // no prompt
  assert.equal(await gate.ask('delete', 'x.txt'), false); // other category still asks
  assert.equal(asked.length, 2);
});

test('reset clears allowAll grants; dismissing the popup denies', async () => {
  const { gate } = gateWith(['allowAll', undefined]);
  assert.equal(await gate.ask('write', 'a'), true);
  gate.reset();
  assert.equal(await gate.ask('write', 'b'), false); // dismissed → deny
});

// ---- stream accumulation ----------------------------------------------------

test('accumulateChunk assembles fragmented tool_calls by index', () => {
  const st = newStreamState();
  accumulateChunk(st, {
    choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_a', function: { name: 'read_', arguments: '' } }] } }],
  });
  accumulateChunk(st, {
    choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'file', arguments: '{"path":' } }] } }],
  });
  accumulateChunk(st, {
    choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.txt"}' } }] } }],
  });
  accumulateChunk(st, { choices: [{ finish_reason: 'tool_calls', delta: {} }] });
  const calls = finishedToolCalls(st);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].id, 'call_a');
  assert.equal(calls[0].function.name, 'read_file');
  assert.equal(calls[0].function.arguments, '{"path":"a.txt"}');
  assert.equal(st.finishReason, 'tool_calls');
});

test('accumulateChunk returns content deltas and accumulates them', () => {
  const st = newStreamState();
  assert.equal(accumulateChunk(st, { choices: [{ delta: { content: 'Hola ' } }] }), 'Hola ');
  assert.equal(accumulateChunk(st, { choices: [{ delta: { content: 'mundo' } }] }), 'mundo');
  assert.equal(st.content, 'Hola mundo');
});

test('accumulateChunk captures provider errors', () => {
  const st = newStreamState();
  accumulateChunk(st, { error: { message: 'model not found' } });
  assert.equal(st.error, 'model not found');
});

test('two parallel tool calls keep separate indexes', () => {
  const st = newStreamState();
  accumulateChunk(st, {
    choices: [{ delta: { tool_calls: [
      { index: 0, id: 'a', function: { name: 'read_file', arguments: '{}' } },
      { index: 1, id: 'b', function: { name: 'list_directory', arguments: '{}' } },
    ] } }],
  });
  const calls = finishedToolCalls(st);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].function.name, 'read_file');
  assert.equal(calls[1].function.name, 'list_directory');
});

// ---- agent loop (with a fake fetch) ----------------------------------------

function sseResponse(lines: object[]): Response {
  const body = lines.map((l) => `data: ${JSON.stringify(l)}\n`).join('') + 'data: [DONE]\n';
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

test('runAgentTurn executes a tool then returns the final text', async () => {
  const realFetch = globalThis.fetch;
  let call = 0;
  globalThis.fetch = (async () => {
    call++;
    if (call === 1) {
      return sseResponse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"path":"a.txt"}' } }] } }] },
        { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
      ]);
    }
    return sseResponse([
      { choices: [{ delta: { content: 'El archivo dice: hola' } }] },
      { choices: [{ finish_reason: 'stop', delta: {} }] },
    ]);
  }) as typeof fetch;

  try {
    const messages: AgentMessage[] = [{ role: 'user', content: 'lee a.txt' }];
    const executed: string[] = [];
    const res = await runAgentTurn({
      endpoint: 'https://x.test/v1',
      apiKey: 'k',
      model: 'm',
      messages,
      execute: async (name, args) => {
        executed.push(`${name}:${args}`);
        return 'hola';
      },
      onDelta: () => {},
      onToolStart: () => {},
    });
    assert.deepEqual(executed, ['read_file:{"path":"a.txt"}']);
    assert.ok('text' in res && res.text === 'El archivo dice: hola');
    // thread: user, assistant(tool_calls), tool, (assistant final not appended — via return)
    assert.equal(messages[1].role, 'assistant');
    assert.equal(messages[2].role, 'tool');
    assert.equal(messages[2].tool_call_id, 'c1');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('runAgentTurn stops at maxSteps and reports it', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    sseResponse([
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'list_directory', arguments: '{}' } }] } }] },
      { choices: [{ finish_reason: 'tool_calls', delta: {} }] },
    ])) as typeof fetch;
  try {
    const res = await runAgentTurn({
      endpoint: 'https://x.test/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'loop' }],
      execute: async () => 'ok',
      onDelta: () => {},
      onToolStart: () => {},
      maxSteps: 3,
    });
    assert.ok('error' in res && /tope de 3 pasos/.test(res.error));
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('runAgentTurn flags 429 as rateLimited', async () => {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: { message: 'rate limit exceeded' } }), { status: 429 })) as typeof fetch;
  try {
    const res = await runAgentTurn({
      endpoint: 'https://x.test/v1',
      apiKey: 'k',
      model: 'm',
      messages: [{ role: 'user', content: 'hola' }],
      execute: async () => 'ok',
      onDelta: () => {},
      onToolStart: () => {},
    });
    assert.ok('error' in res && res.rateLimited === true);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- agentStore (pure parts) ------------------------------------------------

test('sessionTitle derives from first user message, capped at 60', () => {
  const s = newAgentSession('acc1', 'nvidia', 'z-ai/glm-5.2', 'C:\\x');
  assert.equal(sessionTitle(s), 'Conversación del agente');
  s.messages.push({ role: 'user', content: 'Organiza   mis\n descargas por favor' });
  assert.equal(sessionTitle(s), 'Organiza mis descargas por favor');
  s.messages[0].content = 'x'.repeat(100);
  assert.equal(sessionTitle(s).length, 58); // 57 + ellipsis
});

test('parseAgentSession validates shape and id prefix', () => {
  const s = newAgentSession('acc1', 'nvidia', 'm', 'C:\\x');
  assert.ok(parseAgentSession(JSON.stringify(s)));
  assert.equal(parseAgentSession('{"id":"otra-cosa","messages":[]}'), null);
  assert.equal(parseAgentSession('{"id":"agent-x"}'), null); // no messages array
  assert.equal(parseAgentSession('no es json'), null);
});
