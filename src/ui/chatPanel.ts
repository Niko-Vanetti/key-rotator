import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { ChatSession, type ChatBackend } from '../chat/chatSession.js';

interface IncomingMessage {
  type: string;
  text?: string;
  id?: string;
  value?: string;
  on?: boolean;
  paths?: string[];
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
  /** Files queued by the "+" menu to upload into the web chat on next send. */
  private pendingWebFiles: string[] = [];

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
      p.post(p.metaMsg(p.session.currentSessionId));
      p.post({ type: 'accounts', accounts: p.accountsForMenu() });
      p.postModels();
    }
  }

  private post(msg: Record<string, unknown>): void {
    void this.panel.webview.postMessage(msg);
  }

  private currentAccountLabel(): string {
    if (this.session.currentMode === 'agency') return '🏢 Modo agencia';
    if (this.accountId) {
      const acc = this.backend.listChatAccounts().find((a) => a.id === this.accountId);
      if (acc) return acc.label;
      const api = this.backend.listApiAccountModels?.().find((m) => m.accountId === this.accountId);
      if (api) return api.model;
    }
    return this.activeAccountLabel();
  }

  /**
   * Name for assistant bubbles: the account's model (z-ai/glm-5.2) or web
   * provider. Falls back to the GLOBALLY selected account when this panel has
   * no per-panel pin ('' → backend resolves the preferred one), and only says
   * 'Claude' when the active account really is Claude.
   */
  private currentAssistantName(): string {
    const name = this.backend.getWebProviderName?.(this.accountId ?? '');
    return name || 'Claude';
  }

  private metaMsg(sessionId: string | null, activeAccount?: string): Record<string, unknown> {
    return {
      type: 'meta',
      activeAccount: activeAccount ?? this.currentAccountLabel(),
      assistantName: this.currentAssistantName(),
      sessionId,
    };
  }

  private accountsForMenu(): { id: string; label: string; active: boolean }[] {
    const accounts = this.backend.listChatAccounts();
    if (!this.accountId) return accounts;
    return accounts.map((a) => ({ ...a, active: a.id === this.accountId }));
  }

  /**
   * Web accounts (DeepSeek, …) expose in-chat models + feature toggles instead
   * of the Claude model/effort controls. Post them so the webview swaps the
   * bottom-bar controls; for non-web accounts, tell it to show the Claude ones.
   */
  private postWebControls(): void {
    const caps = this.backend.getWebCapsFor?.(this.accountId ?? '') ?? null;
    if (!caps) {
      this.post({ type: 'webControls', web: false });
      return;
    }
    const model = caps.models[0]?.id ?? null;
    this.session.setWebModel(model);
    const onToggles: Record<string, boolean> = {};
    for (const t of caps.toggles) {
      const on = t.on === true;
      onToggles[t.id] = on;
      this.session.setWebToggle(t.id, on);
    }
    this.post({
      type: 'webControls',
      web: true,
      models: caps.models,
      toggles: caps.toggles,
      selectedModel: model,
      onToggles,
    });
  }

  /** Push models: cached list instantly, then network-refreshed in background. */
  private postModels(): void {
    // Cada API key ES un modelo: el dropdown "Modelo" lista TODOS los modelos
    // (uno por cuenta) y elegir uno cambia a esa cuenta (value = accountId).
    const apiModels = this.backend.listApiAccountModels?.() ?? [];
    const activeIsApi = this.backend.getApiChatModel?.(this.accountId ?? '') !== null && this.backend.getApiChatModel;
    if (apiModels.length > 0 && (activeIsApi || !this.accountId)) {
      this.session.setModel(null);
      const models = apiModels.map((m) => ({ id: m.accountId, label: m.model }));
      const selected = this.accountId && apiModels.some((m) => m.accountId === this.accountId)
        ? this.accountId
        : models[0].id;
      this.post({ type: 'models', models, selected, asAccounts: true });
      const selModel = apiModels.find((m) => m.accountId === selected)?.model ?? '';
      this.post({ type: 'model', model: selModel });
      return;
    }
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
    this.post(this.metaMsg(id));
  }

  private startNewSession(): void {
    if (this.session.isBusy()) return;
    this.session.reset();
    this.panel.title = 'Nuevo chat';
    this.post({ type: 'history', messages: [], activeId: null });
    this.post({ type: 'title', title: 'Nueva conversación' });
    this.post(this.metaMsg(null));
  }

  private async handleMessage(msg: IncomingMessage): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        const cfg = vscode.workspace.getConfiguration('keyRotator');
        const effort = cfg.get<string>('chatEffort', '').trim();
        this.session.setEffort(effort || null);
        this.post(this.metaMsg(this.session.currentSessionId));
        this.post({ type: 'config', effort });
        this.post({ type: 'accounts', accounts: this.accountsForMenu() });
        this.post({ type: 'slash', commands: this.backend.getSlashCommands() });
        this.postModels();
        this.postWebControls();
        if (this.pendingSessionId) {
          const id = this.pendingSessionId;
          this.pendingSessionId = null;
          void this.loadSession(id);
        }
        break;
      }

      case 'setModel': {
        const v = (msg.value ?? '').trim();
        // Agent providers: each model IS an account. If the picked value is an
        // API account id, switch to that account (= that model).
        const apiModels = this.backend.listApiAccountModels?.() ?? [];
        const picked = apiModels.find((m) => m.accountId === v);
        if (picked) {
          this.accountId = v;
          this.session.setAccount(v);
          this.post(this.metaMsg(this.session.currentSessionId));
          this.post({ type: 'accounts', accounts: this.accountsForMenu() });
          this.post({ type: 'model', model: picked.model });
          break;
        }
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
          this.post(this.metaMsg(this.session.currentSessionId));
          this.post({ type: 'accounts', accounts: this.accountsForMenu() });
          this.postModels();
          this.postWebControls();
        }
        break;
      case 'setWebModel': {
        const v = (msg.value ?? '').trim();
        this.session.setWebModel(v || null);
        this.post({ type: 'model', model: v });
        break;
      }
      case 'setWebToggle':
        if (msg.id) this.session.setWebToggle(msg.id, !!msg.on);
        break;
      case 'stop':
        this.session.stop();
        break;
      case 'setMode': {
        const mode = msg.value === 'agency' ? 'agency' : 'individual';
        this.session.setMode(mode);
        this.post({
          type: 'info',
          text:
            mode === 'agency'
              ? '🏢 Modo agencia activado: un director repartirá el trabajo entre todos tus modelos en paralelo.'
              : '👤 Modo individual: responde solo el modelo elegido abajo.',
        });
        this.post(this.metaMsg(this.session.currentSessionId));
        break;
      }
      case 'addAccount':
        await vscode.commands.executeCommand('keyRotator.addAccount');
        break;
      case 'pasteSnippet':
        await vscode.commands.executeCommand('keyRotator.pasteSnippet');
        break;
      case 'openDashboard':
        await vscode.commands.executeCommand('keyRotator.openDashboard');
        break;

      // ----- attach a file / image (the "+" menu) -----
      case 'attachFile':
      case 'attachImage': {
        const isImage = msg.type === 'attachImage';
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: true,
          openLabel: 'Adjuntar',
          filters: isImage ? { Imágenes: ['png', 'jpg', 'jpeg', 'webp', 'gif'] } : undefined,
        });
        if (!picked || picked.length === 0) break;
        const isWeb = this.backend.getWebCapsFor?.(this.accountId ?? '') != null;
        const isAgent = this.backend.getApiChatModel?.(this.accountId ?? '') != null;
        if (isWeb || isAgent) {
          // Web chat uploads the file; the agent gets it as an attachment
          // (images travel as vision parts, other files as paths to read).
          for (const u of picked) {
            this.pendingWebFiles.push(u.fsPath);
            this.post({ type: 'webAttach', name: u.fsPath.split(/[\\/]/).pop(), path: u.fsPath });
          }
        } else {
          // Claude CLI: reference the path with @ so it reads the file.
          this.post({ type: 'insert', text: picked.map((u) => `@${u.fsPath} `).join('') });
        }
        break;
      }
      // ----- arrastrar y soltar sobre el chat -----
      case 'dropFiles': {
        const paths = (msg.paths ?? [])
          .map((p) => {
            try {
              return p.startsWith('file:') ? vscode.Uri.parse(p).fsPath : p;
            } catch {
              return p;
            }
          })
          .filter((p) => {
            try {
              return fs.statSync(p).isFile();
            } catch {
              return false;
            }
          });
        if (paths.length === 0) {
          this.post({ type: 'info', text: 'No pude resolver la ruta de lo soltado (¿era una carpeta?).' });
          break;
        }
        for (const p of paths) {
          this.pendingWebFiles.push(p);
          this.post({ type: 'webAttach', name: p.split(/[\\/]/).pop(), path: p });
        }
        break;
      }
      case 'removeWebFile':
        if (msg.value) this.pendingWebFiles = this.pendingWebFiles.filter((p) => p !== msg.value);
        break;

      case 'send': {
        const text = (msg.text ?? '').trim();
        if (!text) return;
        const files = this.pendingWebFiles.slice();
        this.pendingWebFiles = [];
        await this.session.sendMessage(
          text,
          {
            onDelta: (t) => this.post({ type: 'delta', text: t }),
            onAccountSwitch: (label, reason) => {
              this.post({ type: 'switch', label, reason });
              this.post(this.metaMsg(this.session.currentSessionId, label));
            },
            onInfo: (t) => this.post({ type: 'info', text: t }),
            onModel: (m) => this.post({ type: 'model', model: m }),
            onUsage: (info) => this.post({ type: 'usage', info }),
            onError: (t) => this.post({ type: 'turnError', text: t }),
            onDone: (full) => this.post({ type: 'done', text: full, sessionId: this.session.currentSessionId }),
          },
          files
        );
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
