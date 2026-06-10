import * as vscode from 'vscode';
import type { AccountMeta } from '../types.js';

type TreeNode = ProviderNode | AccountNode;

interface ProviderNode {
  kind: 'provider';
  provider: string;
}

interface AccountNode {
  kind: 'account';
  account: AccountMeta;
}

const STATUS_ICONS: Record<AccountMeta['status'], vscode.ThemeIcon> = {
  active: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green')),
  'rate-limited': new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow')),
  error: new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red')),
  disabled: new vscode.ThemeIcon('circle-slash'),
};

/**
 * TreeView grouping accounts by provider. Each account is a leaf with
 * a status icon and a context value of "account" for menu contributions.
 */
export class AccountsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(
    private getAccounts: () => AccountMeta[],
    private getPreferredId: () => string | undefined = () => undefined
  ) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'provider') {
      const item = new vscode.TreeItem(element.provider, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'provider';
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }

    const { account } = element;
    const item = new vscode.TreeItem(account.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'account';
    const isActiveChat = this.getPreferredId() === account.id;
    item.iconPath = isActiveChat
      ? new vscode.ThemeIcon('star-full', new vscode.ThemeColor('charts.green'))
      : STATUS_ICONS[account.status];
    item.description = isActiveChat ? '★ chat' : '';
    item.tooltip = isActiveChat
      ? `${account.label} — el chat usa esta API. Clic en otra para cambiar.`
      : `${account.label} — clic para que el chat use esta API.`;
    item.id = account.id;
    // Clicking the account makes the chat use its API.
    item.command = {
      command: 'keyRotator.setChatAccount',
      title: 'Usar esta API en el chat',
      arguments: [{ account }],
    };
    return item;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    const accounts = this.getAccounts();

    if (!element) {
      const providers = Array.from(new Set(accounts.map((a) => a.provider)));
      return providers.map((provider) => ({ kind: 'provider', provider }));
    }

    if (element.kind === 'provider') {
      return accounts
        .filter((a) => a.provider === element.provider)
        .sort((a, b) => a.priority - b.priority)
        .map((account) => ({ kind: 'account', account }));
    }

    return [];
  }
}
