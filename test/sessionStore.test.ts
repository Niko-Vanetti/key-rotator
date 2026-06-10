import { test } from 'node:test';
import assert from 'node:assert';
import { parseCustomTitle, parseCwd, parseHistory } from '../src/chat/sessionStore.ts';

const lines = (objs: unknown[]) => objs.map((o) => JSON.stringify(o));

test('parseCustomTitle returns the user-set title', () => {
  const ls = lines([
    { type: 'ai-title', aiTitle: 'Auto title', sessionId: 's1' },
    { type: 'custom-title', customTitle: 'MoneyBox', sessionId: 's1' },
    { type: 'user', message: { role: 'user', content: 'hi' } },
  ]);
  assert.strictEqual(parseCustomTitle(ls), 'MoneyBox');
});

test('parseCustomTitle returns null when there is no custom title', () => {
  const ls = lines([{ type: 'ai-title', aiTitle: 'Only auto', sessionId: 's1' }]);
  assert.strictEqual(parseCustomTitle(ls), null);
});

test('parseCwd returns the first recorded cwd', () => {
  const ls = lines([
    { type: 'queue-operation', sessionId: 's1' },
    { type: 'user', cwd: 'C:\\Users\\Niko Vanetti', message: { content: 'hi' } },
  ]);
  assert.strictEqual(parseCwd(ls), 'C:\\Users\\Niko Vanetti');
});

test('parseHistory extracts user/assistant text, deduped and filtered', () => {
  const ls = lines([
    { type: 'attachment', uuid: 'a0', message: { content: '<system reminder>' } },
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Hola' } },
    { type: 'user', uuid: 'u1', message: { role: 'user', content: 'Hola' } }, // dup
    { type: 'assistant', uuid: 'a1', message: { content: [{ type: 'text', text: 'Buenas' }, { type: 'tool_use', id: 'x' }] } },
    { type: 'user', uuid: 'u2', message: { role: 'user', content: '<command-stuff>' } }, // system-ish, skipped
    { type: 'system', uuid: 's', message: { content: 'noise' } },
  ]);
  const h = parseHistory(ls);
  assert.deepStrictEqual(h, [
    { role: 'user', text: 'Hola' },
    { role: 'assistant', text: 'Buenas' },
  ]);
});

test('parseHistory handles array and string content', () => {
  const ls = lines([
    { type: 'user', uuid: 'u1', message: { content: [{ type: 'text', text: 'array form' }] } },
    { type: 'assistant', uuid: 'a1', message: { content: 'string form' } },
  ]);
  assert.deepStrictEqual(parseHistory(ls), [
    { role: 'user', text: 'array form' },
    { role: 'assistant', text: 'string form' },
  ]);
});
