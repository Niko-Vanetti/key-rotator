import * as vscode from 'vscode';
import type { ProviderPattern } from '../types.js';
import seedPatterns from '../../data/patterns.json';

const PATTERNS_KEY = 'keyRotator.patterns';
const REGISTRY_URL = 'https://raw.githubusercontent.com/Niko-Vanetti/key-rotator/main/data/patterns.json';

/**
 * Loads provider patterns from globalState (falling back to the bundled seed),
 * and optionally refreshes them from the GitHub-hosted registry.
 */
export class RegistryUpdater {
  constructor(private context: vscode.ExtensionContext) {}

  getPatterns(): ProviderPattern[] {
    return this.context.globalState.get<ProviderPattern[]>(PATTERNS_KEY, seedPatterns as ProviderPattern[]);
  }

  async addLearnedPattern(pattern: ProviderPattern): Promise<void> {
    const current = this.getPatterns();
    if (current.some((p) => p.prefix === pattern.prefix)) return;
    await this.context.globalState.update(PATTERNS_KEY, [...current, pattern]);
  }

  /**
   * Fetch the latest registry from GitHub. Merges new entries by prefix;
   * never overwrites locally learned patterns. Fails silently (offline-friendly).
   */
  async refreshFromRemote(): Promise<void> {
    try {
      const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const remote = (await response.json()) as ProviderPattern[];
      const current = this.getPatterns();
      const known = new Set(current.map((p) => p.prefix));
      const merged = [...current, ...remote.filter((p) => !known.has(p.prefix))];
      await this.context.globalState.update(PATTERNS_KEY, merged);
    } catch {
      // offline or registry unavailable — keep using existing patterns
    }
  }
}
