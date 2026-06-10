import * as vscode from 'vscode';
import type { AccountMeta } from '../types.js';

/**
 * Shows the active account for the primary provider (anthropic if present,
 * otherwise the first provider with an active account) plus a count of
 * how many accounts of that provider are healthy.
 * Click triggers keyRotator.reportRateLimit.
 */
export class StatusBarManager {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'keyRotator.reportRateLimit';
    this.item.show();
  }

  update(accounts: AccountMeta[]): void {
    if (accounts.length === 0) {
      this.item.text = '$(key) KeyRotator: sin cuentas';
      this.item.backgroundColor = undefined;
      this.item.tooltip = 'Click para agregar una cuenta';
      return;
    }

    const provider = accounts.find((a) => a.provider === 'anthropic')?.provider ?? accounts[0].provider;
    const providerAccounts = accounts.filter((a) => a.provider === provider);
    const active = providerAccounts.filter((a) => a.status === 'active');
    const current = active[0];

    if (!current) {
      this.item.text = `$(error) ${provider}: 0/${providerAccounts.length}`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.item.tooltip = `Todas las cuentas de ${provider} están en límite. Click para ver opciones.`;
      return;
    }

    this.item.text = `$(key) ${current.label} [${active.length}/${providerAccounts.length}]`;
    this.item.backgroundColor = undefined;
    this.item.tooltip = `Cuenta activa: ${current.label}. Click para reportar rate limit.`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
