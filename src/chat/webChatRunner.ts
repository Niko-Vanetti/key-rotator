import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import * as readline from 'node:readline';

/**
 * Talks to the web-chat bridge daemon (src/ui/media/web-chat/bridge.mjs), which
 * drives a logged-in web chat (DeepSeek, …) in a persistent Chromium profile.
 * One runner per web account; the daemon keeps the browser warm between turns.
 */
export interface WebTurnHandlers {
  onDelta(text: string): void;
  onDone(fullText: string): void;
  onError(text: string): void;
  onLoginNeeded(): void;
}

/** In-chat model + feature toggles the web provider exposes (e.g. DeepSeek). */
export interface WebCaps {
  models: { id: string; label: string }[];
  toggles: { id: string; label: string }[];
}

/** Per-turn selection of model + toggle states sent to the web chat. */
export interface WebOpts {
  model?: string;
  toggles?: Record<string, boolean>;
}

/**
 * Static capabilities per web provider, mirroring the daemon's PROVIDERS map
 * (bridge.mjs). Used to build the chat UI without launching a browser. Keep in
 * sync with the daemon — both were verified live against chat.deepseek.com.
 */
export const WEB_CAPS: Record<string, WebCaps> = {
  deepseek: {
    models: [
      { id: 'default', label: 'Instant' },
      { id: 'expert', label: 'Experto' },
      { id: 'vision', label: 'Visión' },
    ],
    toggles: [
      { id: 'deepthink', label: 'Pensamiento Profundo' },
      { id: 'search', label: 'Búsqueda inteligente' },
    ],
  },
};

export class WebChatRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private ready: Promise<void> | null = null;
  /** Handlers for the in-flight `send`/`status` (serialized one at a time). */
  private active: WebTurnHandlers | null = null;
  private statusResolve: ((ready: boolean) => void) | null = null;
  /** Models + toggles the provider supports, reported by the daemon on ready. */
  private caps: WebCaps = { models: [], toggles: [] };

  constructor(
    private nodePath: string,
    private daemonPath: string,
    private provider: string,
    private profileDir: string,
    /** Browser preference passed to the daemon (KeyRotator setting). */
    private browserPref: string = 'auto',
    /** Drive the user's real everyday browser profile (one-click Google). */
    private useRealProfile: boolean = false
  ) {}

  private ensure(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      try {
        this.child = spawn(this.nodePath, [this.daemonPath, this.provider, this.profileDir], {
          stdio: ['pipe', 'pipe', 'pipe'],
          // In the VS Code extension host `process.execPath` is the Code/Electron
          // binary; this flag makes it run the daemon as plain Node. Harmless
          // when nodePath is already a real node executable.
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: '1',
            KR_WEB_BROWSER: this.browserPref,
            KR_WEB_REAL_PROFILE: this.useRealProfile ? '1' : '0',
          },
        });
      } catch (e) {
        reject(e as Error);
        return;
      }
      this.child.on('error', (e) => {
        this.active?.onError(`No se pudo iniciar el navegador web: ${e.message}`);
        this.reset();
      });
      this.child.on('exit', () => this.reset());
      this.rl = readline.createInterface({ input: this.child.stdout });
      this.rl.on('line', (line) => this.onLine(line, resolve));
    });
    return this.ready;
  }

  private reset(): void {
    this.rl?.close();
    this.rl = null;
    this.child = null;
    this.ready = null;
    this.active = null;
    this.statusResolve = null;
  }

  private onLine(line: string, onReady: () => void): void {
    let o: {
      type?: string;
      text?: string;
      ready?: boolean;
      ok?: boolean;
      message?: string;
      models?: { id: string; label: string }[];
      toggles?: { id: string; label: string }[];
    };
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    switch (o.type) {
      case 'ready':
        this.caps = { models: o.models ?? [], toggles: o.toggles ?? [] };
        onReady();
        break;
      case 'delta':
        this.active?.onDelta(o.text ?? '');
        break;
      case 'done': {
        const h = this.active;
        this.active = null;
        h?.onDone(o.text ?? '');
        break;
      }
      case 'login_needed': {
        const h = this.active;
        this.active = null;
        h?.onLoginNeeded();
        break;
      }
      case 'error': {
        const h = this.active;
        this.active = null;
        h?.onError(o.message ?? 'error del navegador web');
        break;
      }
      case 'status':
        this.statusResolve?.(!!o.ready);
        this.statusResolve = null;
        break;
    }
  }

  private write(o: Record<string, unknown>): void {
    this.child?.stdin.write(JSON.stringify(o) + '\n');
  }

  /** True when the web profile has an active login (chat composer reachable). */
  async isReady(): Promise<boolean> {
    await this.ensure();
    return new Promise<boolean>((resolve) => {
      this.statusResolve = resolve;
      this.write({ cmd: 'status' });
      setTimeout(() => {
        if (this.statusResolve) {
          this.statusResolve = null;
          resolve(false);
        }
      }, 60000);
    });
  }

  /** The provider's models + toggles (available once the daemon has started). */
  async getCaps(): Promise<WebCaps> {
    await this.ensure();
    return this.caps;
  }

  /** Send one user turn; streams deltas and resolves on done/error/login. */
  async send(text: string, handlers: WebTurnHandlers, opts?: WebOpts): Promise<void> {
    await this.ensure();
    if (this.active) {
      handlers.onError('Espera a que termine la respuesta anterior.');
      return;
    }
    this.active = handlers;
    this.write({ cmd: 'send', text, opts: opts ?? {} });
  }

  dispose(): void {
    try {
      this.write({ cmd: 'quit' });
    } catch {
      /* ignore */
    }
    this.child?.kill();
    this.reset();
  }
}
