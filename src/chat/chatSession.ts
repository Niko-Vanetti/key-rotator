import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  classifyEvent,
  isRateLimitBlock,
  isRateLimitResult,
  isRateLimitText,
  isLimitMessageText,
  isNotLoggedIn,
} from './streamParser.js';
import { defaultHome, siblingProfileHomes, syncSessionIntoStore, type SessionSummary, type ChatMessage } from './sessionStore.js';
import type { WebChatRunner } from './webChatRunner.js';

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
  /**
   * Web-chat account (DeepSeek, …): the turn is served by driving a logged-in
   * web chat in a headless browser instead of the `claude` CLI. No API/key.
   */
  web?: { provider: string; profileDir: string };
}

/**
 * Bridge the chat layer uses to talk to KeyRotator's account/rotation core,
 * implemented in extension.ts. Keeps ChatSession free of vscode/storage deps.
 */
export interface ChatBackend {
  /**
   * The account the chat should bill to, or null if none usable. When
   * `preferredId` is given (per-panel account choice), that account is used
   * if still usable; otherwise falls back to the best available.
   */
  resolveActiveAccount(preferredId?: string | null): Promise<ActiveAccount | null>;
  /**
   * Mark `accountId` exhausted (with a human-readable reason: usage limit,
   * credit too low, …), rotate to the next eligible account, and return it
   * (or null if every account is exhausted).
   */
  rotateFrom(accountId: string, reason?: string): Promise<ActiveAccount | null>;
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
  /** Load one session's cwd + message thread for display (async, non-blocking). */
  loadHistory(id: string): Promise<{ cwd: string; messages: ChatMessage[] } | null>;
  /** Slash commands (skills) for the `/` autocomplete — read from disk, free. */
  getSlashCommands(): string[];
  /** Accounts available for the chat (for the account menu). */
  listChatAccounts(): { id: string; label: string; active: boolean }[];
  /** Cached model list for an account — sync and instant (may be fallback). */
  getCachedModels(accountId?: string | null): { id: string; label: string }[];
  /** Refresh the model list from the Models API (background, cached). */
  listModels(accountId?: string | null): Promise<{ id: string; label: string }[]>;
  /** Get (or lazily create) the web-chat daemon runner for a web account. */
  getWebRunner?(accountId: string, provider: string, profileDir: string): WebChatRunner;
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
  /** Optional: usage/limit info from rate_limit_event (resetsAt, status…). */
  onUsage?(info: Record<string, unknown>): void;
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
  private accountOverride: string | null = null;
  private busy = false;

  constructor(private backend: ChatBackend) {}

  /** Pin this chat to a specific account (per-panel autonomy). */
  setAccount(id: string | null): void {
    this.accountOverride = id;
  }

  get accountId(): string | null {
    return this.accountOverride;
  }

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
      let account = await this.backend.resolveActiveAccount(this.accountOverride);
      if (!account) {
        handlers.onError('No hay ninguna cuenta activa. Agrega una cuenta de Anthropic en KeyRotator.');
        return;
      }

      // Web-chat accounts (DeepSeek, …) are served by the browser daemon, not
      // the claude CLI — handle them on a separate path (no failover/sessions).
      if (account.web) {
        await this.runWebTurn(text, account, handlers);
        return;
      }

      for (let attempt = 0; attempt <= MAX_FAILOVERS; attempt++) {
        const outcome = await this.runTurn(text, account, handlers);

        if (outcome.kind === 'ok') {
          // Profiles mode writes the transcript to the account's isolated
          // store; mirror it back to the shared store so the Chats sidebar
          // and native Claude Code keep seeing/continuing this conversation.
          if (account.configDir && this.sessionId) {
            try {
              syncSessionIntoStore(this.sessionId, defaultHome(), [account.configDir]);
            } catch {
              // best-effort
            }
          }
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
        const next = await this.backend.rotateFrom(account.id, outcome.reason);
        if (!next) {
          if (account.useLogin) {
            handlers.onError(
              `Tu cuenta de Claude (${account.label}) llegó a su límite de uso. Espera a que se reinicie, o cambia "keyRotator.chatMode" a "failover" para rotar entre cuentas con API key.`
            );
          } else {
            handlers.onError(
              `Ninguna API utilizable ahora. Última: ${account.label} (${outcome.reason || 'límite alcanzado'}). Usa "Probar cuenta" en el panel de Accounts para ver el estado real de cada key.`
            );
          }
          return;
        }
        handlers.onAccountSwitch(next.label, outcome.reason || 'límite alcanzado');
        account = next;
      }

      handlers.onError('Demasiados cambios de cuenta seguidos. Detengo el intento para evitar un bucle.');
    } finally {
      this.busy = false;
    }
  }

  /** Serve a turn from a web-chat account via the browser daemon. */
  private runWebTurn(text: string, account: ActiveAccount, handlers: TurnHandlers): Promise<void> {
    return new Promise((resolve) => {
      const runner = this.backend.getWebRunner?.(account.id, account.web!.provider, account.web!.profileDir);
      if (!runner) {
        handlers.onError('El soporte de chat web no está disponible.');
        resolve();
        return;
      }
      handlers.onModel(account.label);
      void runner.send(text, {
        onDelta: (t) => handlers.onDelta(t),
        onDone: (full) => {
          handlers.onDone(full);
          resolve();
        },
        onError: (t) => {
          handlers.onError(t);
          resolve();
        },
        onLoginNeeded: () => {
          handlers.onError(
            `La cuenta web "${account.label}" no tiene sesión iniciada. Usa "KeyRotator: Iniciar sesión (cuenta web)" para entrar una vez en el navegador.`
          );
          resolve();
        },
      });
    });
  }

  /** Run a single attempt of a turn against one account. */
  private runTurn(
    text: string,
    account: ActiveAccount,
    handlers: TurnHandlers
  ): Promise<
    | { kind: 'ok'; text: string }
    | { kind: 'rateLimit'; reason: string }
    | { kind: 'notLoggedIn' }
    | { kind: 'error'; message: string }
  > {
    return new Promise((resolve) => {
      const { command, baseArgs, useShell } = this.backend.getLauncher();
      const args = [...baseArgs, '-p', '--output-format', 'stream-json', '--include-partial-messages', '--verbose'];
      if (this.sessionId) {
        // Profiles mode uses an isolated session store per account; pull the
        // freshest transcript in from the shared store / other profiles so
        // --resume finds it (otherwise: "No conversation found").
        if (account.configDir) {
          try {
            syncSessionIntoStore(this.sessionId, account.configDir, [
              defaultHome(),
              ...siblingProfileHomes(account.configDir),
            ]);
          } catch {
            // best-effort; claude will report a clear error if missing
          }
        }
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
          | { kind: 'rateLimit'; reason: string }
          | { kind: 'notLoggedIn' }
          | { kind: 'error'; message: string }
      ) => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      const shortReason = (t: string) => (t || 'límite alcanzado').replace(/\s+/g, ' ').trim().slice(0, 100);

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
              handlers.onUsage?.(ev.info);
              break;
            case 'result':
              if (ev.sessionId) this.sessionId = ev.sessionId;
              if (ev.isError) {
                const errText = `${ev.text} ${JSON.stringify(ev.raw.api_error_status ?? '')}`;
                if (isRateLimitResult(ev.raw)) {
                  finish({ kind: 'rateLimit', reason: shortReason(ev.text) });
                } else if (isNotLoggedIn(errText)) {
                  finish({ kind: 'notLoggedIn' });
                } else {
                  finish({ kind: 'error', message: `Error de claude: ${ev.text || JSON.stringify(ev.raw.api_error_status ?? 'desconocido')}` });
                }
              } else {
                const finalText = assembled || ev.text;
                // Claude can return the limit notice as a SUCCESS whose text is
                // "You've hit your session limit · resets …" — rotate on it.
                if (isLimitMessageText(finalText)) {
                  finish({ kind: 'rateLimit', reason: shortReason(finalText) });
                } else {
                  finish({ kind: 'ok', text: finalText });
                }
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
          finish({ kind: 'rateLimit', reason: shortReason(stderrBuf || 'límite de uso') });
        } else if (isNotLoggedIn(stderrBuf)) {
          finish({ kind: 'notLoggedIn' });
        } else if (code === 0) {
          if (isLimitMessageText(assembled)) {
            finish({ kind: 'rateLimit', reason: shortReason(assembled) });
          } else {
            finish({ kind: 'ok', text: assembled });
          }
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
