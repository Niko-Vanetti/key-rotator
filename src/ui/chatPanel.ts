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
 * Singleton WebView panel that hosts the failover-aware chat. The webview is
 * pure presentation; all process/rotation logic lives in ChatSession.
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

  static createOrShow(extensionUri: vscode.Uri, backend: ChatBackend, activeAccountLabel: () => string): void {
    if (ChatPanel.current) {
      ChatPanel.current.panel.reveal();
      return;
    }
    ChatPanel.current = new ChatPanel(extensionUri, backend, activeAccountLabel);
  }

  /** Re-push account/session state to the open panel (e.g. after a switch). */
  static refreshIfOpen(): void {
    const c = ChatPanel.current;
    if (!c) return;
    c.post({ type: 'meta', activeAccount: c.activeAccountLabel(), sessionId: c.session.currentSessionId });
    c.postSessions();
  }

  private post(msg: Record<string, unknown>): void {
    void this.panel.webview.postMessage(msg);
  }

  private postSessions(): void {
    const sessions = this.backend.listSessions().map((s) => ({ id: s.id, name: s.name, mtime: s.mtime }));
    this.post({ type: 'sessions', sessions, activeId: this.session.currentSessionId });
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        const cfg = vscode.workspace.getConfiguration('keyRotator');
        const model = cfg.get<string>('chatModel', '').trim();
        const effort = cfg.get<string>('chatEffort', '').trim();
        this.session.setModel(model || null);
        this.session.setEffort(effort || null);
        this.post({ type: 'meta', activeAccount: this.activeAccountLabel(), sessionId: this.session.currentSessionId });
        this.post({ type: 'config', model, effort });
        this.postSessions();
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

      case 'refreshSessions':
        this.postSessions();
        break;

      case 'selectSession': {
        if (!msg.id || this.session.isBusy()) return;
        const loaded = this.backend.loadHistory(msg.id);
        this.session.setActiveSession(msg.id, loaded?.cwd ?? null);
        this.post({ type: 'history', messages: loaded?.messages ?? [], activeId: msg.id });
        this.post({ type: 'meta', activeAccount: this.activeAccountLabel(), sessionId: msg.id });
        break;
      }

      case 'newSession':
        if (this.session.isBusy()) return;
        this.session.reset();
        this.post({ type: 'history', messages: [], activeId: null });
        this.post({ type: 'meta', activeAccount: this.activeAccountLabel(), sessionId: null });
        break;
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
          onError: (t) => this.post({ type: 'turnError', text: t }),
          onDone: (full) => {
            this.post({ type: 'done', text: full, sessionId: this.session.currentSessionId });
            // A new session may have just been created/updated in the shared
            // store; refresh the sidebar so it reflects the latest state.
            this.postSessions();
          },
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
