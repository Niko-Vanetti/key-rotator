export type SwitchMode = 'auto' | 'confirm';
export type AccountStatus = 'active' | 'rate-limited' | 'error' | 'disabled';

export interface Account {
  id: string;
  provider: string; // e.g. "anthropic", "openai", "qwen"
  label: string; // e.g. "Claude Cuenta 2"
  apiKey: string; // stored only in SecretStorage; present transiently in memory
  endpoint?: string; // for Ollama / custom OpenAI-compatible providers
  envVar: string; // e.g. "ANTHROPIC_API_KEY"
  priority: number; // 1 = highest priority
  switchMode: SwitchMode;
  status: AccountStatus;
  lastError?: string; // why the account became unusable (shown in UI)
  /**
   * Resultado del último análisis de viabilidad (velocidad, consistencia,
   * soporte de herramientas). Se guarda para que el diagnóstico quede visible
   * junto al modelo sin tener que volver a probarlo.
   */
  viability?: { verdict: string; summary: string; at: number };
}

// Account metadata persisted in globalState (apiKey lives in SecretStorage, keyed by id)
export type AccountMeta = Omit<Account, 'apiKey'>;

export interface ProviderPattern {
  prefix: string;
  provider: string;
  displayName: string;
  envVar: string;
  docsUrl?: string;
}

export interface DetectionResult {
  provider: string;
  displayName: string;
  envVar: string;
  source: 'pattern' | 'ai' | 'unknown';
}

export interface HistoryEntry {
  timestamp: number;
  fromAccountId: string | null;
  fromLabel: string | null;
  toAccountId: string;
  toLabel: string;
  provider: string;
  reason: 'rate-limit' | 'manual' | 'recovery';
}

export interface ProviderStats {
  provider: string;
  totalRotations: number;
  rotationsByAccount: Record<string, number>; // accountId -> count
}
