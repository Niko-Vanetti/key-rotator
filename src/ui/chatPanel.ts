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
 * Singleton WebView panel hosting the chat. Chat-only (sessions live in the
 * activity-bar tree); all process/rotation logic lives in ChatSession.
 */
export class ChatPanel {
  private static current: ChatPanel | undefined;
  private panel: vscode.WebviewPanel;
  private session: ChatSession;

  private constructor(
    private extensionUri: vscode.Uri,
    private backend: ChatBackend,
    private activeAccountLabel: () => string
  ) {
    this.session = new ChatSession(backend);
    this.panel = vscode.window.createWebviewPanel('keyRotatorChat', 'KeyRotator Chat', vscode.ViewColumn.One, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'ui', 'media')],
    });

    this.panel.webview.html = this.render();
    this.panel.onDidDispose(() => (ChatPanel.current = undefined));
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
  }

  static createOrShow(extensionUri: vscode.Uri, backend: ChatBackend, activeAccountLabel: () => string): ChatPanel {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal();
    } else {
      ChatPanel.current = new ChatPanel(extensionUri, backend, activeAccountLabel);
    }
    return ChatPanel.current;
  }

  /** Open the panel on a specific session (or a new one when id is null). */
  static openSession(
    extensionUri: vscode.Uri,
    backend: ChatBackend,
    activeAccountLabel: () => string,
    id: string | null
  ): void {
    const panel = ChatPanel.createOrShow(extensionUri, backend, activeAccountLabel);
    if (id) panel.loadSession(id);
    else panel.startNewSession();
  }

  /** Re-push account state to the open panel (e.g. after switching account). */
  static refreshIfOpen(): void {
    const c = ChatPanel.current;
    if (!c) return;
    c.post({ type: 'meta', activeAccount: c.activeAccountLabel(), sessionId: c.session.currentSessionId });
  }

  private post(msg: Record<string, unknown>): void {
    void this.panel.webview.postMessage(msg);
  }

  /** Detect the active key's models and push them to the dropdown (Copilot-style). */
  private async postModels(): Promise<void> {
    const models = await this.backend.listModels();
    const cfg = vscode.workspace.getConfiguration('keyRotator');
    let selected = cfg.get<string>('chatModel', '').trim();
    if (!selected || !models.some((m) => m.id === selected)) {
      selected = models[0]?.id ?? '';
      if (selected) await cfg.update('chatModel', selected, vscode.ConfigurationTarget.Global);
    }
    this.session.setModel(selected || null);
    this.post({ type: 'models', models, selected });
  }

  private loadSession(id: string): void {
    if (this.session.isBusy()) return;
    const loaded = this.backend.loadHistory(id);
    const name = this.backend.listSessions().find((s) => s.id === id)?.name ?? 'Conversación';
    this.session.setActiveSession(id, loaded?.cwd ?? null);
    this.post({ type: 'history', messages: loaded?.messages ?? [], activeId: id });
    this.post({ type: 'title', title: name });
    this.post({ type: 'meta', activeAccount: this.activeAccountLabel(), sessionId: id });
  }

  private startNewSession(): void {
    if (this.session.isBusy()) return;
    this.session.reset();
    this.post({ type: 'history', messages: [], activeId: null });
    this.post({ type: 'title', title: 'Nueva conversación' });
    this.post({ type: 'meta', activeAccount: this.activeAccountLabel(), sessionId: null });
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        const cfg = vscode.workspace.getConfiguration('keyRotator');
        const effort = cfg.get<string>('chatEffort', '').trim();
        this.session.setEffort(effort || null);
        this.post({ type: 'meta', activeAccount: this.activeAccountLabel(), sessionId: this.session.currentSessionId });
        this.post({ type: 'config', effort });
        this.post({ type: 'accounts', accounts: this.backend.listChatAccounts() });
        this.post({ type: 'slash', commands: this.backend.getSlashCommands() });
        void this.postModels();
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
        if (msg.id) this.loadSession(msg.id);
        break;

      case 'newSession':
        this.startNewSession();
        break;

      // ----- account menu -----
      case 'switchAccount':
        if (msg.id) {
          await vscode.commands.executeCommand('keyRotator.setChatAccount', { account: { id: msg.id } });
          this.post({ type: 'meta', activeAccount: this.activeAccountLabel(), sessionId: this.session.currentSessionId });
          this.post({ type: 'accounts', accounts: this.backend.listChatAccounts() });
          // Different account → its key may expose different models.
          void this.postModels();
        }
        break;
      case 'addAccount':
        await vscode.commands.executeCommand('keyRotator.addAccount');
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
