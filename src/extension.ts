import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Account, AccountMeta, HistoryEntry } from './types.js';
import { KeyManager } from './storage/keyManager.js';
import { RegistryUpdater } from './storage/registryUpdater.js';
import { detectFromPatterns, formatGeminiPrompt, parseGeminiDetection } from './core/keyDetector.js';
import { pickNextAccount, applyRateLimit, applyRecovery } from './core/rotationEngine.js';
import { addHistoryEntry, computeStats } from './core/statsTracker.js';
import { startHealthCheckLoop } from './monitor/rateLimitMonitor.js';
import { StatusBarManager } from './ui/statusBar.js';
import { AccountsTreeProvider } from './ui/accountsTreeProvider.js';
import { SessionsTreeProvider } from './ui/sessionsTreeProvider.js';
import { DashboardPanel, type DashboardCallbacks } from './ui/dashboardPanel.js';
import { ChatPanel } from './ui/chatPanel.js';
import type { ChatBackend, ActiveAccount } from './chat/chatSession.js';
import { listNamedSessions, loadSession, listSlashCommands } from './chat/sessionStore.js';

const HISTORY_KEY = 'keyRotator.history';
const CHAT_PROVIDER = 'anthropic';

export function activate(context: vscode.ExtensionContext) {
  const keyManager = new KeyManager(context);
  const registry = new RegistryUpdater(context);
  const statusBar = new StatusBarManager();
  const treeProvider = new AccountsTreeProvider(
    () => keyManager.getAllMeta(),
    () => context.globalState.get<string>('keyRotator.preferredChatAccount')
  );

  const sessionsProvider = new SessionsTreeProvider(() => listNamedSessions());

  vscode.window.registerTreeDataProvider('keyRotatorAccounts', treeProvider);
  vscode.window.registerTreeDataProvider('keyRotatorChats', sessionsProvider);
  context.subscriptions.push(statusBar);

  const refreshUI = () => {
    statusBar.update(keyManager.getAllMeta());
    treeProvider.refresh();
    sessionsProvider.refresh();
    DashboardPanel.refreshIfOpen();
  };

  const getHistory = (): HistoryEntry[] => context.globalState.get<HistoryEntry[]>(HISTORY_KEY, []);
  const setHistory = (history: HistoryEntry[]) => context.globalState.update(HISTORY_KEY, history);

  // --- rotation core ---------------------------------------------------

  async function rotateProvider(provider: string, reason: HistoryEntry['reason']): Promise<void> {
    const accounts = keyManager.getAllMeta();
    const current = accounts.find((a) => a.provider === provider && a.status === 'active');
    const next = pickNextAccount(accounts, provider, current?.id ?? null);

    if (!next) {
      vscode.window.showErrorMessage(`KeyRotator: todas las cuentas de ${provider} están en límite.`);
      refreshUI();
      return;
    }

    const fullAccount = await keyManager.getAccountWithKey(next.id);
    if (!fullAccount) return;

    await applyEnvVar(fullAccount);

    const entry: HistoryEntry = {
      timestamp: Date.now(),
      fromAccountId: current?.id ?? null,
      fromLabel: current?.label ?? null,
      toAccountId: next.id,
      toLabel: next.label,
      provider,
      reason,
    };
    await setHistory(addHistoryEntry(getHistory(), entry));

    vscode.window.showInformationMessage(`⚡ KeyRotator: rotado a ${next.label}`);
    refreshUI();
  }

  async function applyEnvVar(account: Account): Promise<void> {
    // Update the process env for the current extension host session.
    process.env[account.envVar] = account.apiKey;

    // Mirror into .claude/settings.json when present (Claude Code integration).
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    const settingsUri = vscode.Uri.joinPath(folders[0].uri, '.claude', 'settings.json');
    try {
      const raw = await vscode.workspace.fs.readFile(settingsUri);
      const json = JSON.parse(Buffer.from(raw).toString('utf-8'));
      json.env = json.env ?? {};
      json.env[account.envVar] = account.apiKey;
      await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(JSON.stringify(json, null, 2), 'utf-8'));
    } catch {
      // .claude/settings.json doesn't exist or isn't valid JSON — skip silently
    }
  }

  async function handleRateLimit(accountId: string): Promise<void> {
    const accounts = keyManager.getAllMeta();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;

    const updated = applyRateLimit(accounts, accountId);
    const updatedAccount = updated.find((a) => a.id === accountId);
    if (updatedAccount) {
      await keyManager.updateAccountMeta(accountId, { status: updatedAccount.status });
    }

    if (account.switchMode === 'auto') {
      await rotateProvider(account.provider, 'rate-limit');
    } else {
      const choice = await vscode.window.showWarningMessage(
        `Rate limit en ${account.label}. ¿Rotar a la siguiente cuenta?`,
        'Sí',
        'No',
        'Ver todas las opciones'
      );
      if (choice === 'Sí') {
        await rotateProvider(account.provider, 'rate-limit');
      } else if (choice === 'Ver todas las opciones') {
        DashboardPanel.createOrShow(context.extensionUri, dashboardCallbacks);
      } else {
        refreshUI();
      }
    }
  }

  // --- dashboard callbacks ----------------------------------------------

  const dashboardCallbacks: DashboardCallbacks = {
    getState: () => ({
      accounts: keyManager.getAllMeta(),
      history: getHistory(),
      stats: computeStats(getHistory()),
    }),
    addAccount: async (account: Account) => {
      await keyManager.addAccount(account);
      refreshUI();
    },
    deleteAccount: async (id: string) => {
      await keyManager.deleteAccount(id);
      refreshUI();
    },
    toggleSwitchMode: async (id: string) => {
      const account = keyManager.getAllMeta().find((a) => a.id === id);
      if (!account) return;
      const next = account.switchMode === 'auto' ? 'confirm' : 'auto';
      await keyManager.updateAccountMeta(id, { switchMode: next });
      refreshUI();
    },
    detectProvider: async (apiKey: string) => {
      const patterns = registry.getPatterns();
      const fromPattern = detectFromPatterns(apiKey, patterns);
      if (fromPattern) return fromPattern;

      const geminiKey = vscode.workspace.getConfiguration('keyRotator').get<string>('geminiApiKey');
      if (!geminiKey) {
        return { provider: '', displayName: '', envVar: '', source: 'unknown' as const };
      }

      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: formatGeminiPrompt(apiKey) }] }] }),
            signal: AbortSignal.timeout(10000),
          }
        );
        const data = (await response.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
        const result = parseGeminiDetection(text);
        if (result) {
          await registry.addLearnedPattern({
            prefix: apiKey.slice(0, 8),
            provider: result.provider,
            displayName: result.displayName,
            envVar: result.envVar,
          });
          return result;
        }
      } catch {
        // network error or bad response — fall through to unknown
      }
      return { provider: '', displayName: '', envVar: '', source: 'unknown' as const };
    },
    generateId: () => randomUUID(),
  };

  // --- chat backend ------------------------------------------------------

  type ChatMode = 'failover' | 'full' | 'profiles';
  const getChatMode = (): ChatMode => {
    const m = vscode.workspace.getConfiguration('keyRotator').get<string>('chatMode', 'failover');
    return m === 'full' || m === 'profiles' ? m : 'failover';
  };

  /** Per-account CLAUDE_CONFIG_DIR (its own OAuth login) for `profiles` mode. */
  const profileDir = (accountId: string): string => {
    const dir = vscode.Uri.joinPath(context.globalStorageUri, 'profiles', accountId).fsPath;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // best-effort
    }
    return dir;
  };

  const PREFERRED_KEY = 'keyRotator.preferredChatAccount';
  const getPreferredId = (): string | undefined => context.globalState.get<string>(PREFERRED_KEY);
  const setPreferredId = (id: string | undefined) => context.globalState.update(PREFERRED_KEY, id);

  const sortedActiveAnthropic = (): AccountMeta[] => {
    const list = keyManager
      .getAllMeta()
      .filter((a) => a.provider === CHAT_PROVIDER && a.status === 'active')
      .sort((a, b) => a.priority - b.priority);
    // Float the user-selected account to the front, if it's still active.
    const pref = getPreferredId();
    if (pref) {
      const i = list.findIndex((a) => a.id === pref);
      if (i > 0) list.unshift(list.splice(i, 1)[0]);
    }
    return list;
  };

  /** Resolve the account/credential the next turn should use. */
  async function resolveActiveChatAccount(): Promise<ActiveAccount | null> {
    const mode = getChatMode();

    // Full mode: the user's default logged-in Claude — managed MCPs, single
    // account, no rotation.
    if (mode === 'full') {
      return { id: 'login', label: 'Claude (tu login)', useLogin: true };
    }

    const meta = sortedActiveAnthropic()[0];
    if (!meta) return null;

    // Profiles mode: per-account OAuth login dir → managed MCPs + rotation.
    if (mode === 'profiles') {
      return { id: meta.id, label: meta.label, configDir: profileDir(meta.id) };
    }

    // Failover mode: API key billing.
    const apiKey = await keyManager.getApiKey(meta.id);
    if (!apiKey) return null;
    return { id: meta.id, label: meta.label, apiKey };
  }

  /** Mark `accountId` rate-limited, rotate, and return the next account. */
  async function rotateChatFrom(accountId: string): Promise<ActiveAccount | null> {
    const mode = getChatMode();
    // No cross-account rotation in full (single-login) mode.
    if (mode === 'full') return null;

    const accounts = keyManager.getAllMeta();
    const from = accounts.find((a) => a.id === accountId);
    await keyManager.updateAccountMeta(accountId, { status: 'rate-limited' });

    const next = pickNextAccount(applyRateLimit(accounts, accountId), CHAT_PROVIDER, accountId);
    if (!next) {
      refreshUI();
      return null;
    }

    const logSwitch = async () =>
      setHistory(
        addHistoryEntry(getHistory(), {
          timestamp: Date.now(),
          fromAccountId: accountId,
          fromLabel: from?.label ?? null,
          toAccountId: next.id,
          toLabel: next.label,
          provider: CHAT_PROVIDER,
          reason: 'rate-limit',
        })
      );

    if (mode === 'profiles') {
      await logSwitch();
      refreshUI();
      return { id: next.id, label: next.label, configDir: profileDir(next.id) };
    }

    // Failover (API key) mode.
    const full = await keyManager.getAccountWithKey(next.id);
    if (!full) {
      refreshUI();
      return null;
    }
    await applyEnvVar(full);
    await logSwitch();
    refreshUI();
    return { id: next.id, label: next.label, apiKey: full.apiKey };
  }

  const chatBackend: ChatBackend = {
    resolveActiveAccount: resolveActiveChatAccount,
    rotateFrom: rotateChatFrom,
    getModel: () => {
      const m = vscode.workspace.getConfiguration('keyRotator').get<string>('chatModel', '').trim();
      return m || undefined;
    },
    getEffort: () => {
      const e = vscode.workspace.getConfiguration('keyRotator').get<string>('chatEffort', '').trim();
      return e || undefined;
    },
    getCwd: () => {
      // Prefer the open workspace folder so the chat inherits project-level
      // context (CLAUDE.md, project MCPs, skills). Fall back to an isolated
      // dir under globalStorage when no folder is open.
      const folder = vscode.workspace.workspaceFolders?.[0];
      if (folder) return folder.uri.fsPath;
      const dir = vscode.Uri.joinPath(context.globalStorageUri, 'chat-sessions');
      try {
        fs.mkdirSync(dir.fsPath, { recursive: true });
      } catch {
        // best-effort; claude will still run from this path
      }
      return dir.fsPath;
    },
    getLauncher: () => {
      const cfg = vscode.workspace.getConfiguration('keyRotator');
      // `--bare` (failover mode) forces ANTHROPIC_API_KEY auth but disables the
      // managed claude.ai MCPs/hooks; full mode omits it to inherit the login.
      const baseArgs: string[] = getChatMode() === 'failover' ? ['--bare'] : [];

      // Load the user's own MCP servers — works even under --bare, so the API
      // mode keeps custom MCPs (the claude.ai-managed ones still need 'full').
      const mcpConfig = cfg.get<string>('chatMcpConfig', '').trim();
      if (mcpConfig) baseArgs.push('--mcp-config', mcpConfig);

      // Escape hatch for --plugin-dir / --add-dir / --agents / --settings etc.
      const extra = cfg.get<string[]>('chatExtraArgs', []);
      if (Array.isArray(extra)) baseArgs.push(...extra.filter((a) => typeof a === 'string' && a.length > 0));

      return {
        // On Windows `claude` is a .cmd shim — resolve it via the shell. On
        // POSIX, spawning through the shell also resolves it from PATH.
        command: 'claude',
        baseArgs,
        useShell: true,
      };
    },
    listSessions: () => listNamedSessions(),
    loadHistory: (id: string) => loadSession(id),
    getSlashCommands: () => listSlashCommands(),
    listModels: async () => {
      // GitHub-Copilot-style: detect the models the active key can use via the
      // Anthropic Models API. Falls back to a known set on error / no key.
      const fallback = [
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
        { id: 'claude-fable-5', label: 'Claude Fable 5' },
        { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
        { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
      ];
      const meta = sortedActiveAnthropic()[0];
      if (!meta) return fallback;
      const key = await keyManager.getApiKey(meta.id);
      if (!key) return fallback;
      try {
        const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(10000),
        });
        const json = (await res.json()) as { data?: { id: string; display_name?: string }[] };
        if (Array.isArray(json.data) && json.data.length > 0) {
          return json.data.map((m) => ({ id: m.id, label: m.display_name || m.id }));
        }
      } catch {
        // network / auth error — fall back
      }
      return fallback;
    },
    listChatAccounts: () => {
      const activeId = sortedActiveAnthropic()[0]?.id;
      return keyManager
        .getAllMeta()
        .filter((a) => a.provider === CHAT_PROVIDER)
        .map((a) => ({ id: a.id, label: a.label, active: a.id === activeId }));
    },
  };

  const activeChatAccountLabel = (): string => {
    if (getChatMode() === 'full') return 'Claude (tu login)';
    return sortedActiveAnthropic()[0]?.label ?? 'Sin cuenta activa';
  };

  // --- commands ----------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand('keyRotator.openDashboard', () => {
      DashboardPanel.createOrShow(context.extensionUri, dashboardCallbacks);
    }),

    vscode.commands.registerCommand('keyRotator.openChat', () => {
      ChatPanel.createOrShow(context.extensionUri, chatBackend, activeChatAccountLabel);
    }),

    vscode.commands.registerCommand('keyRotator.openChatSession', (node?: { id?: string }) => {
      ChatPanel.openSession(context.extensionUri, chatBackend, activeChatAccountLabel, node?.id ?? null);
    }),

    vscode.commands.registerCommand('keyRotator.newChatSession', () => {
      ChatPanel.openSession(context.extensionUri, chatBackend, activeChatAccountLabel, null);
    }),

    vscode.commands.registerCommand('keyRotator.setChatAccount', async (node?: { account?: AccountMeta }) => {
      // Clicking an account in the tree makes the chat use its API.
      let id = node?.account?.id;
      if (!id) {
        const accounts = keyManager.getAllMeta().filter((a) => a.provider === CHAT_PROVIDER);
        const picked = await vscode.window.showQuickPick(
          accounts.map((a) => ({ label: a.label, description: a.provider, id: a.id })),
          { placeHolder: '¿Qué API usar en el chat?' }
        );
        id = picked?.id;
      }
      if (!id) return;
      const acc = keyManager.getAllMeta().find((a) => a.id === id);
      // Make sure the chosen account is usable (not disabled).
      if (acc && acc.status === 'disabled') {
        await keyManager.updateAccountMeta(id, { status: 'active' });
      }
      await setPreferredId(id);
      refreshUI();
      ChatPanel.refreshIfOpen();
      vscode.window.showInformationMessage(`KeyRotator: el chat ahora usa "${acc?.label ?? id}".`);
    }),

    vscode.commands.registerCommand('keyRotator.loginProfile', async () => {
      const accounts = keyManager.getAllMeta().filter((a) => a.provider === CHAT_PROVIDER);
      if (accounts.length === 0) {
        vscode.window.showInformationMessage('KeyRotator: agrega primero una cuenta de Anthropic.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        accounts.map((a) => ({ label: a.label, description: a.provider, id: a.id })),
        { placeHolder: 'Inicia sesión en el perfil de qué cuenta (modo chat "profiles")' }
      );
      if (!picked) return;

      // Open a terminal scoped to this account's CLAUDE_CONFIG_DIR and run the
      // interactive login. The OAuth credential is stored only in that dir, so
      // each account keeps its own login + claude.ai-managed MCPs.
      const dir = profileDir(picked.id);
      const terminal = vscode.window.createTerminal({
        name: `KeyRotator login: ${picked.label}`,
        env: { CLAUDE_CONFIG_DIR: dir },
      });
      terminal.show();
      terminal.sendText('claude /login');
      vscode.window.showInformationMessage(
        `Iniciando sesión para "${picked.label}". Completa el login en el navegador; cuando termine, ya puedes usar el chat con esta cuenta.`
      );
    }),

    vscode.commands.registerCommand('keyRotator.addAccount', () => {
      DashboardPanel.createOrShow(context.extensionUri, dashboardCallbacks);
    }),

    vscode.commands.registerCommand('keyRotator.activateAccount', async (node?: { account?: AccountMeta }) => {
      const id = node?.account?.id;
      if (!id) return;
      await keyManager.updateAccountMeta(id, { status: 'active' });
      refreshUI();
    }),

    vscode.commands.registerCommand('keyRotator.disableAccount', async (node?: { account?: AccountMeta }) => {
      const id = node?.account?.id;
      if (!id) return;
      await keyManager.updateAccountMeta(id, { status: 'disabled' });
      refreshUI();
    }),

    vscode.commands.registerCommand('keyRotator.deleteAccount', async (node?: { account?: AccountMeta }) => {
      const id = node?.account?.id;
      if (!id) return;
      await keyManager.deleteAccount(id);
      refreshUI();
    }),

    vscode.commands.registerCommand('keyRotator.editAccount', () => {
      DashboardPanel.createOrShow(context.extensionUri, dashboardCallbacks);
    }),

    vscode.commands.registerCommand('keyRotator.reportRateLimit', async () => {
      const accounts = keyManager.getAllMeta().filter((a) => a.status === 'active');
      if (accounts.length === 0) {
        vscode.window.showInformationMessage('KeyRotator: no hay cuentas activas.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        accounts.map((a) => ({ label: a.label, description: a.provider, id: a.id })),
        { placeHolder: '¿Qué cuenta llegó al límite?' }
      );
      if (picked) {
        await handleRateLimit(picked.id);
      }
    }),

    vscode.commands.registerCommand('keyRotator.rotateNow', async () => {
      const providers = Array.from(new Set(keyManager.getAllMeta().map((a) => a.provider)));
      const picked = await vscode.window.showQuickPick(providers, { placeHolder: 'Rotar cuenta de qué proveedor?' });
      if (picked) {
        await rotateProvider(picked, 'manual');
      }
    })
  );

  // --- health check loop --------------------------------------------------

  const intervalMinutes = vscode.workspace.getConfiguration('keyRotator').get<number>('healthCheckIntervalMinutes', 5);
  const preferPrimary = vscode.workspace.getConfiguration('keyRotator').get<boolean>('preferPrimary', true);

  const healthCheckDisposable = startHealthCheckLoop(
    async () => {
      const metas = keyManager.getAllMeta().filter((a) => a.status !== 'disabled');
      const full = await Promise.all(metas.map((m) => keyManager.getAccountWithKey(m.id)));
      return full.filter((a): a is Account => a !== undefined);
    },
    intervalMinutes,
    async (accountId, status) => {
      const meta = keyManager.getAllMeta().find((a) => a.id === accountId);
      if (!meta) return;

      if (status === 'rate-limited' && meta.status === 'active') {
        await handleRateLimit(accountId);
      } else if (status === 'ok' && meta.status === 'rate-limited') {
        const accounts = applyRecovery(keyManager.getAllMeta(), accountId);
        await keyManager.updateAccountMeta(accountId, { status: 'active' });

        if (preferPrimary) {
          const all = accounts.filter((a) => a.provider === meta.provider);
          const highestPriority = [...all].sort((a, b) => a.priority - b.priority)[0];
          if (highestPriority?.id === accountId) {
            await rotateProvider(meta.provider, 'recovery');
          }
        }
        refreshUI();
      }
    }
  );
  context.subscriptions.push(healthCheckDisposable);

  // --- registry refresh ---------------------------------------------------

  void registry.refreshFromRemote();

  refreshUI();
}

export function deactivate() {}
