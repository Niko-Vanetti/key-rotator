import { test } from 'node:test';
import assert from 'node:assert';
import { addHistoryEntry, computeStats } from '../src/core/statsTracker.ts';
import type { HistoryEntry } from '../src/types.ts';

function entry(overrides: Partial<HistoryEntry>): HistoryEntry {
  return {
    timestamp: 1000,
    fromAccountId: 'a',
    fromLabel: 'Account A',
    toAccountId: 'b',
    toLabel: 'Account B',
    provider: 'anthropic',
    reason: 'rate-limit',
    ...overrides,
  };
}

test('addHistoryEntry prepends the new entry (most recent first)', () => {
  const history = [entry({ timestamp: 1000 })];
  const updated = addHistoryEntry(history, entry({ timestamp: 2000 }));
  assert.equal(updated.length, 2);
  assert.equal(updated[0].timestamp, 2000);
  assert.equal(updated[1].timestamp, 1000);
});

test('addHistoryEntry caps history at 500 entries', () => {
  const history: HistoryEntry[] = Array.from({ length: 500 }, (_, i) => entry({ timestamp: i }));
  const updated = addHistoryEntry(history, entry({ timestamp: 9999 }));
  assert.equal(updated.length, 500);
  assert.equal(updated[0].timestamp, 9999);
});

test('computeStats counts total rotations per provider', () => {
  const history = [
    entry({ provider: 'anthropic', toAccountId: 'b' }),
    entry({ provider: 'anthropic', toAccountId: 'a' }),
    entry({ provider: 'openai', toAccountId: 'c' }),
  ];
  const stats = computeStats(history);
  const anthropic = stats.find((s) => s.provider === 'anthropic');
  const openai = stats.find((s) => s.provider === 'openai');
  assert.equal(anthropic?.totalRotations, 2);
  assert.equal(openai?.totalRotations, 1);
});

test('computeStats counts rotations per destination account', () => {
  const history = [
    entry({ provider: 'anthropic', toAccountId: 'b' }),
    entry({ provider: 'anthropic', toAccountId: 'b' }),
    entry({ provider: 'anthropic', toAccountId: 'a' }),
  ];
  const stats = computeStats(history);
  const anthropic = stats.find((s) => s.provider === 'anthropic');
  assert.equal(anthropic?.rotationsByAccount['b'], 2);
  assert.equal(anthropic?.rotationsByAccount['a'], 1);
});

test('computeStats returns empty array for empty history', () => {
  assert.deepEqual(computeStats([]), []);
});
