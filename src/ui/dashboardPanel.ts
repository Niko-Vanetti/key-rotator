import * as vscode from 'vscode';
import * as fs from 'node:fs';
import type { Account, AccountMeta, HistoryEntry, ProviderStats, DetectionResult } from '../types.js';

export interface DashboardState {
  accounts: AccountMeta[];
  history: HistoryEntry[];
  stats: ProviderStats[];
}

export interface DashboardCallbacks {
  getState(): DashboardState;
  addAccount(account: Account): Promise<void>;
  deleteAccount(id: string): Promise<void>;
  toggleSwitchMode(id: string): Promise<void>;
  detectProvider(apiKey: string): Promise<DetectionResult>;
  generateId(): string;
}

interface IncomingMessage {
  type: string;
  id?: string;
  apiKey?: string;
  message?: string;
  account?: {
    label: string;
    apiKey: string;
    provider: string;
    envVar: string;
    endpoint?: string;
  };
}

/**
 * Manages the singleton WebView panel for the KeyRotator dashboard.
 */
export class DashboardPanel {
  private static current: DashboardPanel | undefined;
  private panel: vscode.WebviewPanel;

  private constructor(
    private extensionUri: vscode.Uri,
    private callbacks: DashboardCallbacks
  ) {
    this.panel = vscode.window.createWebviewPanel('keyRotatorDashboard', 'KeyRotator', vscode.ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'ui', 'media')],
    });

    this.panel.webview.html = this.render();
    this.panel.onDidDispose(() => (DashboardPanel.current = undefined));
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
  }

  static createOrShow(extensionUri: vscode.Uri, callbacks: DashboardCallbacks): void {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      DashboardPanel.current.postState();
      return;
    }
    DashboardPanel.current = new DashboardPanel(extensionUri, callbacks);
  }

  static refreshIfOpen(): void {
    DashboardPanel.current?.postState();
  }

  private postState(): void {
    this.panel.webview.postMessage({ type: 'state', ...this.callbacks.getState() });
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.postState();
        break;
      case 'addAccount': {
        if (!msg.account) return;
        const accounts = this.callbacks.getState().accounts;
        const provider = msg.account.provider;
        const sameProvider = accounts.filter((a) => a.provider === provider);
        const priority = sameProvider.length + 1;
        await this.callbacks.addAccount({
          id: this.callbacks.generateId(),
          provider,
          label: msg.account.label,
          apiKey: msg.account.apiKey,
          envVar: msg.account.envVar,
          endpoint: msg.account.endpoint,
          priority,
          switchMode: 'confirm',
          status: 'active',
        });
        this.postState();
        break;
      }
      case 'deleteAccount':
        if (!msg.id) return;
        await this.callbacks.deleteAccount(msg.id);
        this.postState();
        break;
      case 'toggleSwitchMode':
        if (!msg.id) return;
        await this.callbacks.toggleSwitchMode(msg.id);
        this.postState();
        break;
      case 'detectProvider': {
        if (!msg.apiKey) return;
        const result = await this.callbacks.detectProvider(msg.apiKey);
        this.panel.webview.postMessage({ type: 'detection', result });
        break;
      }
      case 'error':
        if (msg.message) vscode.window.showErrorMessage(msg.message);
        break;
    }
  }

  private render(): string {
    const mediaUri = (file: string) =>
      this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'src', 'ui', 'media', file));

    const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'src', 'ui', 'media', 'dashboard.html').fsPath;
    let html = fs.readFileSync(htmlPath, 'utf-8');

    html = html
      .replace(/\{\{styleUri\}\}/g, mediaUri('dashboard.css').toString())
      .replace(/\{\{scriptUri\}\}/g, mediaUri('dashboard.js').toString())
      .replace(/\{\{cspSource\}\}/g, this.panel.webview.cspSource);

    return html;
  }
}
