import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  classifyEvent,
  isRateLimitBlock,
  isRateLimitResult,
  isRateLimitText,
} from './streamParser.js';

/** A resolved account ready to make a request (key held only transiently). */
export interface ActiveAccount {
  id: string;
  label: string;
  /** API key for `failover` mode. Omitted/empty in `full` (login) mode. */
  apiKey?: string;
  /**
   * When true the turn runs against the user's logged-in Claude (OAuth /
   * subscription) with full MCPs/skills — no API key is injected.
   */
  useLogin?: boolean;
}

/**
 * Bridge the chat layer uses to talk to KeyRotator's account/rotation core,
 * implemented in extension.ts. Keeps ChatSession free of vscode/storage deps.
 */
export interface ChatBackend {
  /** The account the chat should currently bill to, or null if none usable. */
  resolveActiveAccount(): Promise<ActiveAccount | null>;
  /**
   * Mark `accountId` rate-limited, rotate to the next eligible account, and
   * return it (or null if every account is exhausted).
   */
  rotateFrom(accountId: string): Promise<ActiveAccount | null>;
  /** Optional model alias / id to pass to `claude --model`. */
  getModel(): string | undefined;
  /** Absolute cwd for the claude process (where sessions persist). */
  getCwd(): string;
  /** How to launch claude — resolved executable + base args (platform-specific). */
  getLauncher(): { command: string; baseArgs: string[]; useShell: boolean };
}

/** UI-facing callbacks for a single in-flight turn. */
export interface TurnHandlers {
  onDelta(text: string): void;
  onAccountSwitch(label: string, reason: string): void;
  onInfo(text: string): void;
  onError(text: string): void;
  onDone(fullText: string): void;
}

const MAX_FAILOVERS = 8;

/**
 * Owns one logical conversation: tracks the claude session id and, for each
 * user turn, spawns a one-shot `claude` process billed to the active account.
 * On a rate-limit signal it rotates to the next account and re-runs the same
 * turn with `--resume`, so the conversation continues seamlessly.
 */
export class ChatSession {
  private sessionId: string | null = null;
  private busy = false;

  constructor(private backend: ChatBackend) {}

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** Reset so the next message starts a brand-new claude session. */
  reset(): void {
    this.sessionId = null;
  }

  async sendMessage(text: string, handlers: TurnHandlers): Promise<void> {
    if (this.busy) {
      handlers.onError('Espera a que termine la respuesta anterior.');
      return;
    }
    this.busy = true;
    try {
      let account = await this.backend.resolveActiveAccount();
      if (!account) {
        handlers.onError('No hay ninguna cuenta activa. Agrega una cuenta de Anthropic en KeyRotator.');
        return;
      }

      for (let attempt = 0; attempt <= MAX_FAILOVERS; attempt++) {
        const outcome = await this.runTurn(text, account, handlers);

        if (outcome.kind === 'ok') {
          handlers.onDone(outcome.text);
          return;
        }

        if (outcome.kind === 'error') {
          handlers.onError(outcome.message);
          return;
        }

        // outcome.kind === 'rateLimit' → rotate and retry the same turn.
        const next = await this.backend.rotateFrom(account.id);
        if (!next) {
          if (account.useLogin) {
            handlers.onError(
              `Tu cuenta de Claude (${account.label}) llegó a su límite de uso. Espera a que se reinicie, o cambia "keyRotator.chatMode" a "failover" para rotar entre cuentas con API key.`
            );
          } else {
            handlers.onError(
              `Se agotaron todas las cuentas con API key disponibles. Última: ${account.label}. Revisa que tengan saldo de API (consola de Anthropic) o agrega otra cuenta.`
            );
          }
          return;
        }
        handlers.onAccountSwitch(next.label, 'límite alcanzado');
        account = next;
      }

      handlers.onError('Demasiados cambios de cuenta seguidos. Detengo el intento para evitar un bucle.');
    } finally {
      this.busy = false;
    }
  }

  /** Run a single attempt of a turn against one account. */
  private runTurn(
    text: string,
    account: ActiveAccount,
    handlers: TurnHandlers
  ): Promise<{ kind: 'ok'; text: string } | { kind: 'rateLimit' } | { kind: 'error'; message: string }> {
    return new Promise((resolve) => {
      const { command, baseArgs, useShell } = this.backend.getLauncher();
      const args = [...baseArgs, '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
      if (this.sessionId) {
        args.push('--resume', this.sessionId);
      }
      const model = this.backend.getModel();
      if (model) {
        args.push('--model', model);
      }

      // In login (full) mode, run against the user's OAuth subscription with
      // full MCPs/skills — strip any inherited API key so it isn't used. In
      // failover mode, inject the active account's API key for billing.
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (account.useLogin || !account.apiKey) {
        delete env.ANTHROPIC_API_KEY;
      } else {
        env.ANTHROPIC_API_KEY = account.apiKey;
      }

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, args, {
          cwd: this.backend.getCwd(),
          shell: useShell,
          env,
        });
      } catch (err) {
        resolve({ kind: 'error', message: `No se pudo iniciar claude: ${(err as Error).message}` });
        return;
      }

      let settled = false;
      let stdoutBuf = '';
      let stderrBuf = '';
      let assembled = '';
      let rateLimited = false;

      const finish = (r: { kind: 'ok'; text: string } | { kind: 'rateLimit' } | { kind: 'error'; message: string }) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      child.stdout.setEncoding('utf-8');
      child.stdout.on('data', (chunk: string) => {
        stdoutBuf += chunk;
        let nl: number;
        while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
          const line = stdoutBuf.slice(0, nl).trim();
          stdoutBuf = stdoutBuf.slice(nl + 1);
          if (!line) continue;
          let obj: unknown;
          try {
            obj = JSON.parse(line);
          } catch {
            continue; // ignore non-JSON noise
          }
          const ev = classifyEvent(obj);
          switch (ev.kind) {
            case 'init':
              this.sessionId = ev.sessionId || this.sessionId;
              break;
            case 'delta':
              assembled += ev.text;
              handlers.onDelta(ev.text);
              break;
            case 'assistant':
              // The assembled deltas are the source of truth; assistant event
              // confirms the final text but we avoid double-emitting.
              if (!assembled && ev.text) {
                assembled = ev.text;
                handlers.onDelta(ev.text);
              }
              break;
            case 'rateLimit':
              if (isRateLimitBlock(ev.info)) rateLimited = true;
              break;
            case 'result':
              if (ev.sessionId) this.sessionId = ev.sessionId;
              if (ev.isError) {
                if (isRateLimitResult(ev.raw)) {
                  finish({ kind: 'rateLimit' });
                } else {
                  finish({ kind: 'error', message: `Error de claude: ${ev.text || JSON.stringify(ev.raw.api_error_status ?? 'desconocido')}` });
                }
              } else {
                finish({ kind: 'ok', text: assembled || ev.text });
              }
              break;
          }
        }
      });

      child.stderr.setEncoding('utf-8');
      child.stderr.on('data', (chunk: string) => {
        stderrBuf += chunk;
      });

      child.on('error', (err) => {
        finish({ kind: 'error', message: `No se pudo ejecutar claude: ${err.message}` });
      });

      child.on('close', (code) => {
        if (settled) return;
        if (rateLimited || isRateLimitText(stderrBuf)) {
          finish({ kind: 'rateLimit' });
        } else if (code === 0) {
          finish({ kind: 'ok', text: assembled });
        } else {
          finish({
            kind: 'error',
            message: stderrBuf.trim() || `claude terminó con código ${code}.`,
          });
        }
      });

      // Feed the user's message via stdin (text input mode) and close it.
      child.stdin.write(text);
      child.stdin.end();
    });
  }
}
