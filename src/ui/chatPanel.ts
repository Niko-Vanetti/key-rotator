import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ChatSession, type ChatBackend } from '../chat/chatSession.js';
import { imageProfiles } from '../agent/nvidiaProfiles.js';
import {
  attachmentToDataUrl,
  inspectAttachment,
  MAX_IMAGE_BYTES,
  type MediaAttachment,
  type MediaOrigin,
} from '../chat/mediaAttachments.js';

interface IncomingMessage {
  type: string;
  text?: string;
  id?: string;
  value?: string;
  on?: boolean;
  paths?: string[];
  research?: boolean;
  data?: string;
  mime?: string;
  name?: string;
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
  private pendingAttachments: MediaAttachment[] = [];
  private knownAttachments = new Map<string, MediaAttachment>();

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

  private queueAttachment(file: string, origin: MediaOrigin, owned: boolean): void {
    const result = inspectAttachment(file, origin, owned);
    if (!result.ok) {
      this.post({ type: 'info', text: result.message });
      if (owned) {
        try { fs.unlinkSync(file); } catch { /* best-effort */ }
      }
      return;
    }
    this.pendingAttachments.push(result.attachment);
    this.knownAttachments.set(result.attachment.id, result.attachment);
    this.post({
      type: 'webAttach',
      attachment: this.attachmentForWeb(result.attachment),
    });
  }

  private attachmentForWeb(attachment: MediaAttachment): Record<string, unknown> {
    this.knownAttachments.set(attachment.id, attachment);
    return {
      ...attachment,
      previewUri: attachmentToDataUrl(attachment) ?? undefined,
    };
  }

  private currentAccountLabel(): string {
    if (this.session.currentMode === 'agency') return '🏢 Modo agencia';
    if (this.session.currentMode === 'images') return '🎨 Modo imágenes';
    if (this.accountId) {
      const acc = this.backend.listChatAccounts().find((a) => a.id === this.accountId);
      if (acc) return acc.label;
      const api = this.backend.listApiAccountModels?.().find((m) => m.accountId === this.accountId);
      if (api) return api.model;
    }
    return this.activeAccountLabel();
  }

  /** Name for assistant bubbles: the active model (each API key IS a model). */
  private currentAssistantName(): string {
    return this.backend.getApiChatModel?.(this.accountId ?? '') || this.currentAccountLabel();
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
   * Modo imágenes: publica SOLO los modelos de imagen (el catálogo propio, no
   * las API keys de chat) y fija el primero como elegido.
   */
  private postImageModels(): void {
    const profiles = imageProfiles(this.backend.listNvidiaProfiles?.() ?? []);
    const models = profiles.map((profile) => ({
      id: profile.accountId,
      label: profile.model,
      note: profile.capabilities.includes('image-edit') ? 'Genera y edita' : 'Genera',
    }));
    const selected =
      (this.accountId && profiles.some((profile) => profile.accountId === this.accountId)
        ? this.accountId
        : models[0]?.id) ?? '';
    const profile = profiles.find((item) => item.accountId === selected);
    this.accountId = profile?.accountId ?? null;
    this.session.setAccount(this.accountId);
    this.session.setImageModel(profile?.model ?? '');
    this.post({ type: 'imageModels', models, selected });
    this.post({ type: 'model', model: profile?.model ?? '' });
    if (!profile) {
      this.post({
        type: 'info',
        text: 'Importa desde NVIDIA Build el snippet de un modelo de imagen para habilitar este modo.',
      });
    }
  }

  /** Cada API key ES un modelo: el dropdown los lista y elegir uno cambia de cuenta. */
  private postModels(): void {
    const apiModels = this.backend.listApiAccountModels?.() ?? [];
    if (apiModels.length === 0) {
      this.post({ type: 'models', models: [], selected: '' });
      this.post({ type: 'model', model: '' });
      return;
    }
    const models = apiModels.map((m) => ({ id: m.accountId, label: m.model }));
    const selected =
      this.accountId && apiModels.some((m) => m.accountId === this.accountId)
        ? this.accountId
        : models[0].id;
    this.post({ type: 'models', models, selected, asAccounts: true });
    this.post({ type: 'model', model: apiModels.find((m) => m.accountId === selected)?.model ?? '' });
  }

  private async loadSession(id: string): Promise<void> {
    if (this.session.isBusy()) return;
    const name = this.backend.listSessions().find((s) => s.id === id)?.name ?? 'Conversación';
    this.panel.title = name;
    // Immediate feedback: show the loading screen before any file I/O.
    this.post({ type: 'loading', title: name });
    this.post({ type: 'title', title: name });
    const loaded = await this.backend.loadHistory(id);
    this.session.setActiveSession(id);
    const messages = (loaded ?? []).map((m) => ({
      ...m,
      attachments: m.attachments?.map((a) => this.attachmentForWeb(a)),
    }));
    this.post({ type: 'history', messages, activeId: id });
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
        this.post(this.metaMsg(this.session.currentSessionId));
        this.post({ type: 'accounts', accounts: this.accountsForMenu() });
        this.post({ type: 'mode', mode: this.session.currentMode });
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
        // Cada modelo ES una cuenta: elegirlo cambia la API key en uso.
        const v = (msg.value ?? '').trim();
        const picked = (this.backend.listApiAccountModels?.() ?? []).find((m) => m.accountId === v);
        if (!picked) break;
        this.accountId = v;
        this.session.setAccount(v);
        this.post(this.metaMsg(this.session.currentSessionId));
        this.post({ type: 'accounts', accounts: this.accountsForMenu() });
        this.post({ type: 'model', model: picked.model });
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
        }
        break;
      case 'stop':
        this.session.stop();
        break;
      case 'setResearch':
        this.session.setResearch(!!msg.on);
        this.post({
          type: 'info',
          text: msg.on
            ? '🔬 Investigación profunda ACTIVADA: buscará en la web y contrastará fuentes antes de responder.'
            : '🔬 Investigación profunda desactivada: responderá directo (solo buscará si le pides algo que lo exija).',
        });
        break;
      case 'setImageModel': {
        const profile = imageProfiles(this.backend.listNvidiaProfiles?.() ?? [])
          .find((item) => item.accountId === (msg.value ?? '').trim());
        if (!profile) break;
        this.accountId = profile.accountId;
        this.session.setAccount(profile.accountId);
        this.session.setImageModel(profile.model);
        this.post({ type: 'model', model: profile.model });
        this.post(this.metaMsg(this.session.currentSessionId));
        break;
      }
      case 'setMode': {
        const mode = msg.value === 'agency' ? 'agency' : msg.value === 'images' ? 'images' : 'individual';
        this.session.setMode(mode);
        if (mode === 'images') this.postImageModels();
        const director = vscode.workspace.getConfiguration('keyRotator').get<string>('agencyDirector', 'auto');
        this.post({
          type: 'info',
          text:
            mode === 'agency'
              ? `🏢 Modo agencia activado. Director: ${director === 'auto' ? 'automático (el mejor disponible)' : director}. El modelo y el esfuerzo los decide la agencia — cambia el director en "Administrar modelos".`
              : '👤 Modo individual: responde solo el modelo elegido abajo.',
        });
        this.post({ type: 'mode', mode });
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

      // ----- adjuntar (botón "+") -----
      // UN solo camino: el tipo se deduce del archivo (imagen → visión,
      // documento/audio/vídeo → texto extraído o transcrito). Filtrar por
      // extensión solo escondía formatos que sí funcionan.
      case 'attachFile': {
        const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Adjuntar' });
        if (!picked || picked.length === 0) break;
        for (const u of picked) this.queueAttachment(u.fsPath, 'picker', false);
        break;
      }
      // ----- imagen pegada (Ctrl+V) o arrastrada sin ruta -----
      // El portapapeles entrega bytes, no una ruta: se guardan en un archivo
      // temporal para poder adjuntarlo como cualquier otra imagen.
      case 'pasteImage': {
        if (!msg.data) break;
        try {
          if (Buffer.byteLength(msg.data, 'base64') > MAX_IMAGE_BYTES) {
            this.post({ type: 'info', text: 'La imagen pegada supera el límite de 20 MB.' });
            break;
          }
          const ext = (msg.mime ?? 'image/png').split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png';
          const dir = path.join(os.homedir(), 'Documents', 'KeyRotator', 'adjuntos');
          fs.mkdirSync(dir, { recursive: true });
          const name = msg.name && /\.[a-z0-9]+$/i.test(msg.name) ? msg.name : `imagen-${Date.now()}.${ext}`;
          const file = path.join(dir, `${randomUUID()}-${name.replace(/[^\w.-]+/g, '_')}`);
          fs.writeFileSync(file, Buffer.from(msg.data, 'base64'));
          this.queueAttachment(file, 'paste', true);
        } catch (e) {
          this.post({ type: 'info', text: `No pude guardar la imagen pegada: ${(e as Error).message}` });
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
        for (const p of paths) this.queueAttachment(p, 'drop', false);
        break;
      }
      case 'removeWebFile': {
        if (!msg.value) break;
        const removed = this.pendingAttachments.find((a) => a.id === msg.value || a.path === msg.value);
        if (removed?.owned && removed.origin === 'paste') {
          try { fs.unlinkSync(removed.path); } catch { /* best-effort */ }
        }
        this.pendingAttachments = this.pendingAttachments.filter((a) => a.id !== msg.value && a.path !== msg.value);
        if (removed) this.knownAttachments.delete(removed.id);
        break;
      }
      case 'openAttachment':
      case 'revealAttachment': {
        const attachment = msg.id ? this.knownAttachments.get(msg.id) : undefined;
        if (!attachment || !fs.existsSync(attachment.path)) {
          this.post({ type: 'info', text: 'El archivo ya no está disponible en disco.' });
          break;
        }
        const uri = vscode.Uri.file(attachment.path);
        if (msg.type === 'openAttachment') await vscode.commands.executeCommand('vscode.open', uri);
        else await vscode.commands.executeCommand('revealFileInOS', uri);
        break;
      }

      case 'send': {
        const text = (msg.text ?? '').trim();
        if (!text) return;
        const files = this.pendingAttachments.slice();
        this.pendingAttachments = [];
        await this.session.sendMessage(
          text,
          {
            onDelta: (t) => this.post({ type: 'delta', text: t }),
            onAccountSwitch: (label, reason) => {
              this.post({ type: 'switch', label, reason });
              this.post(this.metaMsg(this.session.currentSessionId, label));
            },
            onInfo: (t) => this.post({ type: 'info', text: t }),
            onStatus: (t) => this.post({ type: 'status', text: t }),
            onModel: (m) => this.post({ type: 'model', model: m }),
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
