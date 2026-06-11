import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { ChatSession, type ChatBackend } from '../chat/chatSession.js';

interface IncomingMessage {
  type: string;
  text?: string;
  id?: string;
  value?: string;
}

/**
 * Multi-instance WebView chat panel — one VS Code tab per conversation, like
 * native Claude Code. Each panel owns its own ChatSession and can be pinned to
 * a different account/API, so several chats can work in parallel on different
 * programs with different keys.
 */
export class ChatPanel {
  private static panels = new Set<ChatPanel>();
  private panel: vscode.WebviewPanel;
  private session: ChatSession;
  /** Per-panel account override (null = global preferred account). */
  private accountId: string | null = null;

  private constructor(
    private extensionUri: vscode.Uri,
    private backend: ChatBackend,
    private activeAccountLabel: () => string
  ) {
    this.session = new ChatSession(backend);
    this.panel = vscode.window.createWebviewPanel('keyRotatorChat', 'Nuevo chat', vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'ui', 'media')],
    });

    this.panel.webview.html = this.render();
    this.panel.onDidDispose(() => ChatPanel.panels.delete(this));
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
    ChatPanel.panels.add(this);
  }

  /** Reveal the most recent panel, or create one if none exist. */
  static createOrShow(extensionUri: vscode.Uri, backend: ChatBackend, activeAccountLabel: () => string): ChatPanel {
    const existing = [...ChatPanel.panels].pop();
    if (existing) {
      existing.panel.reveal();
      return existing;
    }
    return new ChatPanel(extensionUri, backend, activeAccountLabel);
  }

  /**
   * Open a session in its own tab. If a panel already shows that session it is
   * revealed; otherwise a NEW panel opens (multiple chats side by side).
   */
  static openSession(
    extensionUri: vscode.Uri,
    backend: ChatBackend,
    activeAccountLabel: () => string,
    id: string | null
  ): void {
    if (id) {
      for (const p of ChatPanel.panels) {
        if (p.session.currentSessionId === id) {
          p.panel.reveal();
          return;
        }
      }
    }
    const panel = new ChatPanel(extensionUri, backend, activeAccountLabel);
    // The webview posts 'ready' on load; loading immediately also works since
    // postMessage is queued, but defer to ready for ordering with config.
    if (id) panel.pendingSessionId = id;
  }

  private pendingSessionId: string | null = null;

  /** Re-push account state to every open panel (e.g. after a global switch). */
  static refreshIfOpen(): void {
    for (const p of ChatPanel.panels) {
      p.post({ type: 'meta', activeAccount: p.currentAccountLabel(), sessionId: p.session.currentSessionId });
      p.post({ type: 'accounts', accounts: p.accountsForMenu() });
    }
  }

  private post(msg: Record<string, unknown>): void {
    void this.panel.webview.postMessage(msg);
  }

  private currentAccountLabel(): string {
    if (this.accountId) {
      const acc = this.backend.listChatAccounts().find((a) => a.id === this.accountId);
      if (acc) return acc.label;
    }
    return this.activeAccountLabel();
  }

  private accountsForMenu(): { id: string; label: string; active: boolean }[] {
    const accounts = this.backend.listChatAccounts();
    if (!this.accountId) return accounts;
    return accounts.map((a) => ({ ...a, active: a.id === this.accountId }));
  }

  /** Push models: cached list instantly, then network-refreshed in background. */
  private postModels(): void {
    const apply = async (models: { id: string; label: string }[]) => {
      const cfg = vscode.workspace.getConfiguration('keyRotator');
      let selected = cfg.get<string>('chatModel', '').trim();
      if (!selected || !models.some((m) => m.id === selected)) {
        selected = models[0]?.id ?? '';
      }
      this.session.setModel(selected || null);
      this.post({ type: 'models', models, selected });
    };
    void apply(this.backend.getCachedModels(this.accountId));
    void this.backend.listModels(this.accountId).then((models) => apply(models));
  }

  private async loadSession(id: string): Promise<void> {
    if (this.session.isBusy()) return;
    const name = this.backend.listSessions().find((s) => s.id === id)?.name ?? 'Conversación';
    this.panel.title = name;
    // Immediate feedback: show the loading screen before any file I/O.
    this.post({ type: 'loading', title: name });
    this.post({ type: 'title', title: name });
    const loaded = await this.backend.loadHistory(id);
    this.session.setActiveSession(id, loaded?.cwd ?? null);
    this.post({ type: 'history', messages: loaded?.messages ?? [], activeId: id });
    this.post({ type: 'meta', activeAccount: this.currentAccountLabel(), sessionId: id });
  }

  private startNewSession(): void {
    if (this.session.isBusy()) return;
    this.session.reset();
    this.panel.title = 'Nuevo chat';
    this.post({ type: 'history', messages: [], activeId: null });
    this.post({ type: 'title', title: 'Nueva conversación' });
    this.post({ type: 'meta', activeAccount: this.currentAccountLabel(), sessionId: null });
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        const cfg = vscode.workspace.getConfiguration('keyRotator');
        const effort = cfg.get<string>('chatEffort', '').trim();
        this.session.setEffort(effort || null);
        this.post({ type: 'meta', activeAccount: this.currentAccountLabel(), sessionId: this.session.currentSessionId });
        this.post({ type: 'config', effort });
        this.post({ type: 'accounts', accounts: this.accountsForMenu() });
        this.post({ type: 'slash', commands: this.backend.getSlashCommands() });
        this.postModels();
        if (this.pendingSessionId) {
          const id = this.pendingSessionId;
          this.pendingSessionId = null;
          void this.loadSession(id);
        }
        break;
      }

      case 'setModel': {
        const v = (msg.value ?? '').trim();
        this.session.setModel(v || null);
        await vscode.workspace.getConfiguration('keyRotator').update('chatModel', v, vscode.ConfigurationTarget.Global);
        break;
      }

      case 'setEffort': {
        const v = (msg.value ?? '').trim();
        this.session.setEffort(v || null);
        await vscode.workspace.getConfiguration('keyRotator').update('chatEffort', v, vscode.ConfigurationTarget.Global);
        break;
      }

      case 'selectSession':
        if (msg.id) void this.loadSession(msg.id);
        break;

      case 'newSession':
        this.startNewSession();
        break;

      // ----- per-panel account menu -----
      case 'switchAccount':
        if (msg.id) {
          this.accountId = msg.id;
          this.session.setAccount(msg.id);
          this.post({ type: 'meta', activeAccount: this.currentAccountLabel(), sessionId: this.session.currentSessionId });
          this.post({ type: 'accounts', accounts: this.accountsForMenu() });
          this.postModels();
        }
        break;
      case 'addAccount':
        await vscode.commands.executeCommand('keyRotator.addAccount');
        break;
      case 'addLoginAccount':
        await vscode.commands.executeCommand('keyRotator.addLoginAccount');
        break;
      case 'openDashboard':
        await vscode.commands.executeCommand('keyRotator.openDashboard');
        break;

      // ----- attach a file (the "+" menu) -----
      case 'attachFile': {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Adjuntar' });
        if (picked && picked[0]) this.post({ type: 'insert', text: `@${picked[0].fsPath} ` });
        break;
      }

      case 'send': {
        const text = (msg.text ?? '').trim();
        if (!text) return;
        await this.session.sendMessage(text, {
          onDelta: (t) => this.post({ type: 'delta', text: t }),
          onAccountSwitch: (label, reason) => {
            this.post({ type: 'switch', label, reason });
            this.post({ type: 'meta', activeAccount: label, sessionId: this.session.currentSessionId });
          },
          onInfo: (t) => this.post({ type: 'info', text: t }),
          onModel: (m) => this.post({ type: 'model', model: m }),
          onUsage: (info) => this.post({ type: 'usage', info }),
          onError: (t) => this.post({ type: 'turnError', text: t }),
          onDone: (full) => this.post({ type: 'done', text: full, sessionId: this.session.currentSessionId }),
        });
        break;
      }
    }
  }

  private render(): string {
    const mediaUri = (file: string) =>
      this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'src', 'ui', 'media', file));

    const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'src', 'ui', 'media', 'chat.html').fsPath;
    let html = fs.readFileSync(htmlPath, 'utf-8');

    html = html
      .replace(/\{\{styleUri\}\}/g, mediaUri('chat.css').toString())
      .replace(/\{\{scriptUri\}\}/g, mediaUri('chat.js').toString())
      .replace(/\{\{cspSource\}\}/g, this.panel.webview.cspSource);

    return html;
  }
}
