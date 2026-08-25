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
  /** Análisis de viabilidad real de un modelo (velocidad, consistencia, herramientas). */
  testModel(id: string): Promise<{ verdict: string; summary: string }>;
  toggleSwitchMode(id: string): Promise<void>;
  detectProvider(apiKey: string): Promise<DetectionResult>;
  generateId(): string;
  /** One-paste setup: sample code (or bare key) → configured account. */
  addFromSnippet(text: string, label?: string): Promise<{ ok: boolean; summary?: string }>;
  /** MCP servers available to the agent. */
  listMcp(): { name: string; detail: string }[];
  addMcp(text: string): Promise<string | null>; // returns an error message, or null
  deleteMcp(name: string): Promise<void>;
  editMcp(name: string): Promise<void>;
  syncMcpFromClaude(): Promise<string>;
  /** Skills the agent can load with use_skill. */
  listSkills(): { name: string; detail: string }[];
  addSkill(name: string, text: string): Promise<string | null>;
  deleteSkill(name: string): Promise<void>;
  editSkill(name: string): Promise<void>;
  syncSkillsFromClaude(): Promise<string>;
  /** Importa todas las skills de una carpeta (repo con subcarpetas). Sin `dir`, pregunta. */
  importSkillsFrom(dir?: string): Promise<string>;
  /** Agency director: 'auto' or a model id. */
  getDirector(): string;
  setDirector(value: string): Promise<void>;
}

interface IncomingMessage {
  type: string;
  id?: string;
  apiKey?: string;
  message?: string;
  text?: string;
  label?: string;
  name?: string;
  value?: string;
  paths?: string[];
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

  /** Evita solaparse si el dashboard se abre/refresca varias veces seguidas. */
  private rechecking = false;

  /**
   * Al abrir el dashboard, vuelve a probar EN SEGUNDO PLANO los modelos cuyo
   * veredicto falta o es viejo (>6 h), para que un modelo que se cayó no siga
   * marcado "recomendado". Secuencial (lo espacia el throttle de 35 rpm) y no
   * bloquea la vista. Solo modelos de NVIDIA/OpenRouter.
   */
  private async recheckStale(): Promise<void> {
    if (this.rechecking) return;
    this.rechecking = true;
    const STALE_MS = 6 * 60 * 60 * 1000;
    const now = Date.now();
    try {
      const accounts = this.callbacks.getState().accounts;
      const stale = accounts.filter(
        (a) =>
          (a.provider === 'nvidia' || a.provider === 'openrouter') &&
          (!a.viability || now - a.viability.at > STALE_MS)
      );
      for (const a of stale) {
        if (!DashboardPanel.current) return; // el panel se cerró
        const v = await this.callbacks.testModel(a.id);
        this.panel.webview.postMessage({ type: 'modelVerdict', id: a.id, ...v });
      }
      if (stale.length > 0) this.postState();
    } finally {
      this.rechecking = false;
    }
  }

  private postState(): void {
    this.panel.webview.postMessage({
      type: 'state',
      ...this.callbacks.getState(),
      director: this.callbacks.getDirector(),
    });
    this.panel.webview.postMessage({ type: 'mcpState', servers: this.callbacks.listMcp() });
    this.panel.webview.postMessage({ type: 'skillState', skills: this.callbacks.listSkills() });
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.postState();
        void this.recheckStale(); // en segundo plano, no bloquea la UI
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
      case 'addFromPaste': {
        if (!msg.text) return;
        const res = await this.callbacks.addFromSnippet(msg.text, msg.label);
        this.postState();
        this.panel.webview.postMessage({ type: 'pasteResult', ok: res.ok, summary: res.summary ?? '' });
        break;
      }
      case 'deleteAccount':
        if (!msg.id) return;
        await this.callbacks.deleteAccount(msg.id);
        this.postState();
        break;
      case 'testModel': {
        if (!msg.id) return;
        const v = await this.callbacks.testModel(msg.id);
        this.panel.webview.postMessage({ type: 'modelVerdict', id: msg.id, ...v });
        this.postState(); // refresca el estado (active/error) que el análisis pudo cambiar
        break;
      }
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
      case 'setDirector':
        await this.callbacks.setDirector(msg.value ?? 'auto');
        this.postState();
        break;
      // ----- MCP -----
      case 'addMcp': {
        if (!msg.text) return;
        const err = await this.callbacks.addMcp(msg.text);
        if (err) vscode.window.showErrorMessage(`KeyRotator: ${err}`);
        this.postState();
        break;
      }
      case 'deleteMcp':
        if (msg.name) await this.callbacks.deleteMcp(msg.name);
        this.postState();
        break;
      case 'editMcp':
        if (msg.name) await this.callbacks.editMcp(msg.name);
        this.postState();
        break;
      case 'syncMcp': {
        const summary = await this.callbacks.syncMcpFromClaude();
        vscode.window.showInformationMessage(`KeyRotator: ${summary}`);
        this.postState();
        break;
      }
      // ----- Skills -----
      case 'addSkill': {
        if (!msg.name || !msg.text) return;
        const err = await this.callbacks.addSkill(msg.name, msg.text);
        if (err) vscode.window.showErrorMessage(`KeyRotator: ${err}`);
        this.postState();
        break;
      }
      case 'deleteSkill':
        if (msg.name) await this.callbacks.deleteSkill(msg.name);
        this.postState();
        break;
      case 'editSkill':
        if (msg.name) await this.callbacks.editSkill(msg.name);
        break;
      case 'syncSkills': {
        const summary = await this.callbacks.syncSkillsFromClaude();
        vscode.window.showInformationMessage(`KeyRotator: ${summary}`);
        this.postState();
        break;
      }
      case 'importSkills': {
        // `paths` llega cuando se arrastró una carpeta (como URI file://);
        // sin él, se abre el selector de carpetas.
        const resolved = (msg.paths ?? []).map((p) => {
          try {
            return p.startsWith('file:') ? vscode.Uri.parse(p).fsPath : p;
          } catch {
            return p;
          }
        });
        const dirs: (string | undefined)[] = resolved.length ? resolved : [undefined];
        for (const d of dirs) {
          const summary = await this.callbacks.importSkillsFrom(d);
          if (summary) vscode.window.showInformationMessage(`KeyRotator: ${summary}`);
        }
        this.postState();
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
