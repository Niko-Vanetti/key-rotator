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
import { DashboardPanel, type DashboardCallbacks } from './ui/dashboardPanel.js';
import { ChatPanel } from './ui/chatPanel.js';
import type { ChatBackend, ActiveAccount } from './chat/chatSession.js';

const HISTORY_KEY = 'keyRotator.history';
const CHAT_PROVIDER = 'anthropic';

export function activate(context: vscode.ExtensionContext) {
  const keyManager = new KeyManager(context);
  const registry = new RegistryUpdater(context);
  const statusBar = new StatusBarManager();
  const treeProvider = new AccountsTreeProvider(() => keyManager.getAllMeta());

  vscode.window.registerTreeDataProvider('keyRotatorAccounts', treeProvider);
  context.subscriptions.push(statusBar);

  const refreshUI = () => {
    statusBar.update(keyManager.getAllMeta());
    treeProvider.refresh();
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

  const getChatMode = (): 'full' | 'failover' =>
    vscode.workspace.getConfiguration('keyRotator').get<string>('chatMode', 'full') === 'failover'
      ? 'failover'
      : 'full';

  /** Resolve the account/credential the next turn should use. */
  async function resolveActiveChatAccount(): Promise<ActiveAccount | null> {
    // Full mode: use the logged-in Claude (OAuth/subscription) with full
    // MCPs/skills — no API key, no per-account rotation.
    if (getChatMode() === 'full') {
      return { id: 'login', label: 'Claude (tu login)', useLogin: true };
    }
    const candidates = keyManager
      .getAllMeta()
      .filter((a) => a.provider === CHAT_PROVIDER && a.status === 'active')
      .sort((a, b) => a.priority - b.priority);
    const meta = candidates[0];
    if (!meta) return null;
    const apiKey = await keyManager.getApiKey(meta.id);
    if (!apiKey) return null;
    return { id: meta.id, label: meta.label, apiKey };
  }

  /** Mark `accountId` rate-limited, rotate, and return the next account+key. */
  async function rotateChatFrom(accountId: string): Promise<ActiveAccount | null> {
    // No cross-account rotation in full (login) mode — OAuth can't hot-swap.
    if (getChatMode() === 'full') return null;
    const accounts = keyManager.getAllMeta();
    const from = accounts.find((a) => a.id === accountId);
    await keyManager.updateAccountMeta(accountId, { status: 'rate-limited' });

    const next = pickNextAccount(applyRateLimit(accounts, accountId), CHAT_PROVIDER, accountId);
    if (!next) {
      refreshUI();
      return null;
    }

    const full = await keyManager.getAccountWithKey(next.id);
    if (!full) {
      refreshUI();
      return null;
    }

    await applyEnvVar(full);
    await setHistory(
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
    getLauncher: () => ({
      // On Windows `claude` is a .cmd shim — resolve it via the shell. On
      // POSIX, spawning through the shell also resolves it from PATH.
      // `--bare` (failover mode) forces ANTHROPIC_API_KEY auth but disables
      // MCPs/hooks; full mode omits it to inherit the user's full Claude env.
      command: 'claude',
      baseArgs: getChatMode() === 'failover' ? ['--bare'] : [],
      useShell: true,
    }),
  };

  const activeChatAccountLabel = (): string => {
    if (getChatMode() === 'full') return 'Claude (tu login)';
    const candidates = keyManager
      .getAllMeta()
      .filter((a) => a.provider === CHAT_PROVIDER && a.status === 'active')
      .sort((a, b) => a.priority - b.priority);
    return candidates[0]?.label ?? 'Sin cuenta activa';
  };

  // --- commands ----------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand('keyRotator.openDashboard', () => {
      DashboardPanel.createOrShow(context.extensionUri, dashboardCallbacks);
    }),

    vscode.commands.registerCommand('keyRotator.openChat', () => {
      ChatPanel.createOrShow(context.extensionUri, chatBackend, activeChatAccountLabel);
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
