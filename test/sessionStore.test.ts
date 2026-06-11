import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parseCustomTitle, parseCwd, parseHistory, syncSessionIntoStore } from '../src/chat/sessionStore.ts';

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

// ---- syncSessionIntoStore (profiles mode shares sessions across stores) ----

const SESSION = '11111111-2222-3333-4444-555555555555';
const SLUG = 'C--Users-Niko-Vanetti';

function makeHome(content?: string, mtimeSec?: number): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kr-store-'));
  if (content !== undefined) {
    const dir = path.join(home, 'projects', SLUG);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${SESSION}.jsonl`);
    fs.writeFileSync(file, content);
    if (mtimeSec !== undefined) fs.utimesSync(file, mtimeSec, mtimeSec);
  }
  return home;
}

test('syncSessionIntoStore copies a shared-store session into an empty profile store', () => {
  const shared = makeHome('{"cwd":"x"}\n');
  const profile = makeHome();
  assert.strictEqual(syncSessionIntoStore(SESSION, profile, [shared]), true);
  const copied = path.join(profile, 'projects', SLUG, `${SESSION}.jsonl`);
  assert.strictEqual(fs.readFileSync(copied, 'utf8'), '{"cwd":"x"}\n');
});

test('syncSessionIntoStore overwrites an older target copy with the newest one', () => {
  const now = Date.now() / 1000;
  const shared = makeHome('NEWER\n', now);
  const profile = makeHome('older\n', now - 3600);
  assert.strictEqual(syncSessionIntoStore(SESSION, profile, [shared]), true);
  const file = path.join(profile, 'projects', SLUG, `${SESSION}.jsonl`);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'NEWER\n');
});

test('syncSessionIntoStore leaves the target alone when it already has the newest copy', () => {
  const now = Date.now() / 1000;
  const shared = makeHome('stale\n', now - 3600);
  const profile = makeHome('FRESH\n', now);
  assert.strictEqual(syncSessionIntoStore(SESSION, profile, [shared]), true);
  const file = path.join(profile, 'projects', SLUG, `${SESSION}.jsonl`);
  assert.strictEqual(fs.readFileSync(file, 'utf8'), 'FRESH\n');
});

test('syncSessionIntoStore returns false when the session exists nowhere', () => {
  const shared = makeHome();
  const profile = makeHome();
  assert.strictEqual(syncSessionIntoStore(SESSION, profile, [shared]), false);
});
