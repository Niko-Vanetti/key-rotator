import type { HistoryEntry, ProviderStats } from '../types.js';

const MAX_HISTORY = 500;

/**
 * Add a new history entry to the front of the list (most recent first),
 * trimming the list to MAX_HISTORY entries.
 */
export function addHistoryEntry(history: HistoryEntry[], newEntry: HistoryEntry): HistoryEntry[] {
  return [newEntry, ...history].slice(0, MAX_HISTORY);
}

/**
 * Aggregate rotation history into per-provider stats:
 * total rotation count and a breakdown of how many times
 * each destination account was rotated into.
 */
export function computeStats(history: HistoryEntry[]): ProviderStats[] {
  const byProvider = new Map<string, ProviderStats>();

  for (const entry of history) {
    let stats = byProvider.get(entry.provider);
    if (!stats) {
      stats = { provider: entry.provider, totalRotations: 0, rotationsByAccount: {} };
      byProvider.set(entry.provider, stats);
    }
    stats.totalRotations += 1;
    stats.rotationsByAccount[entry.toAccountId] = (stats.rotationsByAccount[entry.toAccountId] ?? 0) + 1;
  }

  return Array.from(byProvider.values());
}
