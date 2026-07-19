import * as vscode from 'vscode';
import type { Account } from '../types.js';

export type HealthStatus = 'ok' | 'rate-limited' | 'unreachable';

/**
 * Probes a provider's lightweight endpoint to check for rate-limit responses.
 * Uses a 'list models'-style endpoint where possible to avoid token cost.
 */
export async function checkAccountHealth(account: Account): Promise<HealthStatus> {
  const { url, headers } = buildProbeRequest(account);
  if (!url) return 'ok'; // unknown provider shape: skip active probing

  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (response.status === 429) return 'rate-limited';
    if (response.status >= 500) return 'unreachable';
    return 'ok';
  } catch {
    return 'unreachable';
  }
}

// Default base URL per OpenAI-compatible provider (mirrors OPENAI_ENDPOINTS in
// extension.ts); `account.endpoint` overrides it for Ollama/custom setups.
const OPENAI_COMPAT_DEFAULTS: Record<string, string> = {
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'together-ai': 'https://api.together.xyz/v1',
  groq: 'https://api.groq.com/openai/v1',
  nvidia: 'https://integrate.api.nvidia.com/v1',
};

function buildProbeRequest(account: Account): { url: string | null; headers: Record<string, string> } {
  switch (account.provider) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models',
        headers: { 'x-api-key': account.apiKey, 'anthropic-version': '2023-06-01' },
      };
    case 'openai':
    case 'openrouter':
    case 'together-ai':
    case 'groq':
    case 'qwen':
    case 'nvidia':
      return {
        url: (account.endpoint ?? OPENAI_COMPAT_DEFAULTS[account.provider] ?? 'https://api.openai.com/v1') + '/models',
        headers: { Authorization: `Bearer ${account.apiKey}` },
      };
    case 'google-gemini':
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${account.apiKey}`,
        headers: {},
      };
    case 'ollama':
      return { url: (account.endpoint ?? 'http://localhost:11434') + '/api/tags', headers: {} };
    default:
      return { url: null, headers: {} };
  }
}

/**
 * Runs checkAccountHealth for every active account on an interval,
 * invoking onResult for each. Returns a disposable to stop polling.
 */
export function startHealthCheckLoop(
  getAccounts: () => Promise<Account[]>,
  intervalMinutes: number,
  onResult: (accountId: string, status: HealthStatus) => void
): vscode.Disposable {
  const timer = setInterval(async () => {
    const accounts = await getAccounts();
    for (const account of accounts) {
      if (account.status === 'disabled') continue;
      const status = await checkAccountHealth(account);
      onResult(account.id, status);
    }
  }, intervalMinutes * 60 * 1000);

  return new vscode.Disposable(() => clearInterval(timer));
}
