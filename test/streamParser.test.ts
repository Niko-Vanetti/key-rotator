import { test } from 'node:test';
import assert from 'node:assert';
import {
  classifyEvent,
  isRateLimitBlock,
  isRateLimitResult,
  isRateLimitText,
} from '../src/chat/streamParser.ts';

test('classifies system:init with session and key source', () => {
  const ev = classifyEvent({
    type: 'system',
    subtype: 'init',
    session_id: 'abc-123',
    model: 'claude-sonnet-4-6',
    apiKeySource: 'ANTHROPIC_API_KEY',
  });
  assert.deepStrictEqual(ev, {
    kind: 'init',
    sessionId: 'abc-123',
    model: 'claude-sonnet-4-6',
    apiKeySource: 'ANTHROPIC_API_KEY',
  });
});

test('classifies a text content_block_delta', () => {
  const ev = classifyEvent({
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hola' } },
  });
  assert.deepStrictEqual(ev, { kind: 'delta', text: 'Hola' });
});

test('ignores non-text deltas', () => {
  const ev = classifyEvent({
    type: 'stream_event',
    event: { type: 'content_block_delta', delta: { type: 'thinking_delta', thinking: 'hmm' } },
  });
  assert.strictEqual(ev.kind, 'other');
});

test('assembles assistant text from content blocks', () => {
  const ev = classifyEvent({
    type: 'assistant',
    message: { content: [{ type: 'text', text: 'A' }, { type: 'text', text: 'B' }] },
  });
  assert.deepStrictEqual(ev, { kind: 'assistant', text: 'AB' });
});

test('classifies a successful result', () => {
  const ev = classifyEvent({ type: 'result', subtype: 'success', is_error: false, session_id: 's1', result: 'done' });
  assert.strictEqual(ev.kind, 'result');
  if (ev.kind === 'result') {
    assert.strictEqual(ev.isError, false);
    assert.strictEqual(ev.sessionId, 's1');
    assert.strictEqual(ev.text, 'done');
  }
});

test('rate_limit_event with allowed status is not a block', () => {
  const ev = classifyEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } });
  assert.strictEqual(ev.kind, 'rateLimit');
  if (ev.kind === 'rateLimit') {
    assert.strictEqual(isRateLimitBlock(ev.info), false);
  }
});

test('rate_limit_event with non-allowed status is a block', () => {
  assert.strictEqual(isRateLimitBlock({ status: 'rejected' }), true);
  assert.strictEqual(isRateLimitBlock({ status: 'blocked' }), true);
  assert.strictEqual(isRateLimitBlock({ status: 'allowed', overageStatus: 'blocked' }), true);
});

test('isRateLimitResult detects rate-limit errors only', () => {
  assert.strictEqual(
    isRateLimitResult({ is_error: true, api_error_status: { status: 429, message: 'rate limit exceeded' } }),
    true
  );
  assert.strictEqual(isRateLimitResult({ is_error: true, result: 'usage limit reached' }), true);
  // Credit / billing exhaustion should also roll over to the next account.
  assert.strictEqual(isRateLimitResult({ is_error: true, result: 'Credit balance is too low' }), true);
  assert.strictEqual(isRateLimitResult({ is_error: true, api_error_status: { status: 402 } }), true);
  assert.strictEqual(isRateLimitResult({ is_error: true, result: 'some other failure' }), false);
  assert.strictEqual(isRateLimitResult({ is_error: false, result: '429 mentioned but ok' }), false);
});

test('isRateLimitText matches stderr usage-limit messages', () => {
  assert.strictEqual(isRateLimitText('Error: rate limit reached for this key'), true);
  assert.strictEqual(isRateLimitText('Claude usage limit reached'), true);
  assert.strictEqual(isRateLimitText('command not found'), false);
});

test('unknown event types fall through to other', () => {
  assert.strictEqual(classifyEvent({ type: 'system', subtype: 'status', status: 'requesting' }).kind, 'status');
  assert.strictEqual(classifyEvent(null).kind, 'other');
  assert.strictEqual(classifyEvent({ type: 'mystery' }).kind, 'other');
});
