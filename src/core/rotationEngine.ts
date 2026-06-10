import type { AccountMeta } from '../types.js';

/**
 * Pick the best eligible account to switch to for a given provider.
 * Eligible = same provider, status 'active', not the current account.
 * Picks the lowest `priority` number (1 = highest priority).
 */
export function pickNextAccount(
  accounts: AccountMeta[],
  provider: string,
  currentAccountId: string | null
): AccountMeta | null {
  const candidates = accounts
    .filter((a) => a.provider === provider)
    .filter((a) => a.status === 'active')
    .filter((a) => a.id !== currentAccountId)
    .sort((a, b) => a.priority - b.priority);

  return candidates[0] ?? null;
}

/**
 * Return a new array with the given account marked as rate-limited.
 */
export function applyRateLimit(accounts: AccountMeta[], accountId: string): AccountMeta[] {
  return accounts.map((a) => (a.id === accountId ? { ...a, status: 'rate-limited' as const } : a));
}

/**
 * Return a new array with the given account restored to active,
 * unless it was manually disabled.
 */
export function applyRecovery(accounts: AccountMeta[], accountId: string): AccountMeta[] {
  return accounts.map((a) => {
    if (a.id !== accountId) return a;
    if (a.status === 'disabled') return a;
    return { ...a, status: 'active' as const };
  });
}
