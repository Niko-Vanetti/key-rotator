import { test } from 'node:test';
import assert from 'node:assert';
import { pickNextAccount, applyRateLimit, applyRecovery } from '../src/core/rotationEngine.ts';
import type { AccountMeta } from '../src/types.ts';

function makeAccount(overrides: Partial<AccountMeta>): AccountMeta {
  return {
    id: 'id-1',
    provider: 'anthropic',
    label: 'Account',
    envVar: 'ANTHROPIC_API_KEY',
    priority: 1,
    switchMode: 'auto',
    status: 'active',
    ...overrides,
  };
}

test('picks the active account with the lowest priority number', () => {
  const accounts = [
    makeAccount({ id: 'a', priority: 2, status: 'active' }),
    makeAccount({ id: 'b', priority: 1, status: 'active' }),
    makeAccount({ id: 'c', priority: 3, status: 'rate-limited' }),
  ];
  const next = pickNextAccount(accounts, 'anthropic', null);
  assert.equal(next?.id, 'b');
});

test('skips the currently active account when picking next', () => {
  const accounts = [
    makeAccount({ id: 'a', priority: 1, status: 'active' }),
    makeAccount({ id: 'b', priority: 2, status: 'active' }),
  ];
  const next = pickNextAccount(accounts, 'anthropic', 'a');
  assert.equal(next?.id, 'b');
});

test('ignores disabled and rate-limited accounts', () => {
  const accounts = [
    makeAccount({ id: 'a', priority: 1, status: 'rate-limited' }),
    makeAccount({ id: 'b', priority: 2, status: 'disabled' }),
    makeAccount({ id: 'c', priority: 3, status: 'active' }),
  ];
  const next = pickNextAccount(accounts, 'anthropic', null);
  assert.equal(next?.id, 'c');
});

test('only considers accounts for the given provider', () => {
  const accounts = [
    makeAccount({ id: 'a', provider: 'openai', priority: 1, status: 'active' }),
    makeAccount({ id: 'b', provider: 'anthropic', priority: 2, status: 'active' }),
  ];
  const next = pickNextAccount(accounts, 'anthropic', null);
  assert.equal(next?.id, 'b');
});

test('returns null when no eligible account exists', () => {
  const accounts = [makeAccount({ id: 'a', priority: 1, status: 'rate-limited' })];
  const next = pickNextAccount(accounts, 'anthropic', null);
  assert.equal(next, null);
});

test('applyRateLimit marks the account as rate-limited', () => {
  const accounts = [makeAccount({ id: 'a', status: 'active' })];
  const updated = applyRateLimit(accounts, 'a');
  assert.equal(updated[0].status, 'rate-limited');
});

test('applyRecovery restores a rate-limited account to active', () => {
  const accounts = [makeAccount({ id: 'a', status: 'rate-limited' })];
  const updated = applyRecovery(accounts, 'a');
  assert.equal(updated[0].status, 'active');
});

test('applyRecovery does not change a disabled account', () => {
  const accounts = [makeAccount({ id: 'a', status: 'disabled' })];
  const updated = applyRecovery(accounts, 'a');
  assert.equal(updated[0].status, 'disabled');
});
