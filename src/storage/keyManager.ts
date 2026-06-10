import * as vscode from 'vscode';
import type { Account, AccountMeta } from '../types.js';

const META_KEY = 'keyRotator.accounts';
const SECRET_PREFIX = 'keyRotator.secret.';

/**
 * Manages Account persistence: metadata in globalState, API keys in SecretStorage.
 * API keys never appear in globalState, history, or stats.
 */
export class KeyManager {
  constructor(private context: vscode.ExtensionContext) {}

  getAllMeta(): AccountMeta[] {
    return this.context.globalState.get<AccountMeta[]>(META_KEY, []);
  }

  private async setAllMeta(accounts: AccountMeta[]): Promise<void> {
    await this.context.globalState.update(META_KEY, accounts);
  }

  async getApiKey(accountId: string): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_PREFIX + accountId);
  }

  async addAccount(account: Account): Promise<void> {
    const { apiKey, ...meta } = account;
    const all = this.getAllMeta();
    all.push(meta);
    await this.setAllMeta(all);
    await this.context.secrets.store(SECRET_PREFIX + account.id, apiKey);
  }

  async updateAccountMeta(accountId: string, patch: Partial<AccountMeta>): Promise<void> {
    const all = this.getAllMeta();
    const updated = all.map((a) => (a.id === accountId ? { ...a, ...patch } : a));
    await this.setAllMeta(updated);
  }

  async updateApiKey(accountId: string, apiKey: string): Promise<void> {
    await this.context.secrets.store(SECRET_PREFIX + accountId, apiKey);
  }

  async deleteAccount(accountId: string): Promise<void> {
    const all = this.getAllMeta().filter((a) => a.id !== accountId);
    await this.setAllMeta(all);
    await this.context.secrets.delete(SECRET_PREFIX + accountId);
  }

  async getAccountWithKey(accountId: string): Promise<Account | undefined> {
    const meta = this.getAllMeta().find((a) => a.id === accountId);
    if (!meta) return undefined;
    const apiKey = await this.getApiKey(accountId);
    if (apiKey === undefined) return undefined;
    return { ...meta, apiKey };
  }
}
