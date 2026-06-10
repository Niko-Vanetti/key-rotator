import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  classifyEvent,
  isRateLimitBlock,
  isRateLimitResult,
  isRateLimitText,
  isNotLoggedIn,
} from './streamParser.js';
import type { SessionSummary, ChatMessage } from './sessionStore.js';

/** A resolved account ready to make a request (key held only transiently). */
export interface ActiveAccount {
  id: string;
  label: string;
  /** API key for `failover` mode. Omitted/empty in login/profile modes. */
  apiKey?: string;
  /**
   * When true the turn runs against the user's logged-in Claude (OAuth /
   * subscription) with full MCPs/skills — no API key is injected.
   */
  useLogin?: boolean;
  /**
   * `profiles` mode: per-account `CLAUDE_CONFIG_DIR` holding this account's own
   * OAuth login, so its claude.ai-managed MCPs (Canva, Drive, …) load and
   * failover can roll between accounts while keeping full features.
   */
  configDir?: string;
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
  /** Optional effort level (low|medium|high|xhigh|max) for `claude --effort`. */
  getEffort(): string | undefined;
  /** Absolute cwd for the claude process (where new sessions persist). */
  getCwd(): string;
  /** How to launch claude — resolved executable + base args (platform-specific). */
  getLauncher(): { command: string; baseArgs: string[]; useShell: boolean };
  /** Named sessions from the shared local store (for the sidebar). */
  listSessions(): SessionSummary[];
  /** Load one session's cwd + message thread for display. */
  loadHistory(id: string): { cwd: string; messages: ChatMessage[] } | null;
  /** Slash commands (skills) for the `/` autocomplete — read from disk, free. */
  getSlashCommands(): string[];
  /** Accounts available for the chat (for the account menu). */
  listChatAccounts(): { id: string; label: string; active: boolean }[];
  /** Auto-detect the models the active account's API key can use. */
  listModels(): Promise<{ id: string; label: string }[]>;
}

/** UI-facing callbacks for a single in-flight turn. */
export interface TurnHandlers {
  onDelta(text: string): void;
  onAccountSwitch(label: string, reason: string): void;
  onInfo(text: string): void;
  onError(text: string): void;
  onDone(fullText: string): void;
  /** Reports the actual model claude reported using (from the init event). */
  onModel(model: string): void;
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
  private sessionCwd: string | null = null;
  private modelOverride: string | null = null;
  private effortOverride: string | null = null;
  private busy = false;

  constructor(private backend: ChatBackend) {}

  /** Override the model for subsequent turns ('' / null → backend default). */
  setModel(model: string | null): void {
    this.modelOverride = model && model.length > 0 ? model : null;
  }

  /** Override the effort level for subsequent turns ('' / null → default). */
  setEffort(effort: string | null): void {
    this.effortOverride = effort && effort.length > 0 ? effort : null;
  }

  get currentSessionId(): string | null {
    return this.sessionId;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** Reset so the next message starts a brand-new claude session. */
  reset(): void {
    this.sessionId = null;
    this.sessionCwd = null;
  }

  /**
   * Point the chat at an existing Claude session (from the shared store) so the
   * next message continues it via `--resume`, running in its original cwd so
   * the transcript stays in the same project file the native app reads.
   */
  setActiveSession(id: string | null, cwd?: string | null): void {
    this.sessionId = id;
    this.sessionCwd = cwd && cwd.length > 0 ? cwd : null;
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

        if (outcome.kind === 'notLoggedIn') {
          if (account.configDir) {
            handlers.onError(
              `La cuenta "${account.label}" no tiene sesión iniciada. Ejecuta el comando "KeyRotator: Log in Account (Chat)" y elige "${account.label}" para iniciar sesión una vez.`
            );
          } else {
            handlers.onError(
              `No hay sesión de Claude iniciada. Inicia sesión con el CLI claude (o configura una API key con saldo y usa el modo "failover").`
            );
          }
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
  ): Promise<
    | { kind: 'ok'; text: string }
    | { kind: 'rateLimit' }
    | { kind: 'notLoggedIn' }
    | { kind: 'error'; message: string }
  > {
    return new Promise((resolve) => {
      const { command, baseArgs, useShell } = this.backend.getLauncher();
      const args = [...baseArgs, '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
      if (this.sessionId) {
        args.push('--resume', this.sessionId);
      }
      const model = this.modelOverride ?? this.backend.getModel();
      if (model) {
        args.push('--model', model);
      }
      const effort = this.effortOverride ?? this.backend.getEffort();
      if (effort) {
        args.push('--effort', effort);
      }

      // Build the child env per auth mode:
      // - failover: inject the account's API key for billing.
      // - full/profiles: strip the API key so the OAuth login is used.
      // - profiles: also point CLAUDE_CONFIG_DIR at this account's login dir.
      const env: NodeJS.ProcessEnv = { ...process.env };
      if (account.apiKey && !account.useLogin && !account.configDir) {
        env.ANTHROPIC_API_KEY = account.apiKey;
      } else {
        delete env.ANTHROPIC_API_KEY;
      }
      if (account.configDir) {
        env.CLAUDE_CONFIG_DIR = account.configDir;
      }

      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(command, args, {
          // Resume in the session's own cwd so the transcript is written to the
          // same project file native Claude Code reads (mutual continuity).
          cwd: this.sessionCwd || this.backend.getCwd(),
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

      const finish = (
        r:
          | { kind: 'ok'; text: string }
          | { kind: 'rateLimit' }
          | { kind: 'notLoggedIn' }
          | { kind: 'error'; message: string }
      ) => {
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
              if (ev.model) handlers.onModel(ev.model);
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
                const errText = `${ev.text} ${JSON.stringify(ev.raw.api_error_status ?? '')}`;
                if (isRateLimitResult(ev.raw)) {
                  finish({ kind: 'rateLimit' });
                } else if (isNotLoggedIn(errText)) {
                  finish({ kind: 'notLoggedIn' });
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
        } else if (isNotLoggedIn(stderrBuf)) {
          finish({ kind: 'notLoggedIn' });
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
