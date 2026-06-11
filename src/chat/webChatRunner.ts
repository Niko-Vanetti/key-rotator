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

export class WebChatRunner {
  private child: ChildProcessWithoutNullStreams | null = null;
  private rl: readline.Interface | null = null;
  private ready: Promise<void> | null = null;
  /** Handlers for the in-flight `send`/`status` (serialized one at a time). */
  private active: WebTurnHandlers | null = null;
  private statusResolve: ((ready: boolean) => void) | null = null;

  constructor(
    private nodePath: string,
    private daemonPath: string,
    private provider: string,
    private profileDir: string
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
          env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
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
    let o: { type?: string; text?: string; ready?: boolean; ok?: boolean; message?: string };
    try {
      o = JSON.parse(line);
    } catch {
      return;
    }
    switch (o.type) {
      case 'ready':
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

  /** Send one user turn; streams deltas and resolves on done/error/login. */
  async send(text: string, handlers: WebTurnHandlers): Promise<void> {
    await this.ensure();
    if (this.active) {
      handlers.onError('Espera a que termine la respuesta anterior.');
      return;
    }
    this.active = handlers;
    this.write({ cmd: 'send', text });
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
