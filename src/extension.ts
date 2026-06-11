import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as childProcess from 'node:child_process';
import * as readline from 'node:readline';
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
import { WebChatRunner, WEB_CAPS } from './chat/webChatRunner.js';
import { listNamedSessions, loadSessionAsync, listSlashCommands, seedScanCache, exportScanCache } from './chat/sessionStore.js';

const HISTORY_KEY = 'keyRotator.history';
const CHAT_PROVIDER = 'anthropic';

// Per-account model list cache (Models API results change rarely).
const modelsCache = new Map<string, { at: number; models: { id: string; label: string }[] }>();

const FALLBACK_MODELS = [
  { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6' },
  { id: 'claude-fable-5', label: 'Claude Fable 5' },
  { id: 'claude-opus-4-8', label: 'Claude Opus 4.8' },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5' },
];

export function activate(context: vscode.ExtensionContext) {
  const keyManager = new KeyManager(context);
  const registry = new RegistryUpdater(context);
  const statusBar = new StatusBarManager();
  const treeProvider = new AccountsTreeProvider(
    () => keyManager.getAllMeta(),
    () => context.globalState.get<string>('keyRotator.preferredChatAccount')
  );

  // Seed the transcript scan cache from the last run so the Chats view and
  // panel open instantly even on a cold start (no re-reading MB of jsonl).
  seedScanCache(context.globalState.get('keyRotator.scanCache', {}));

  const sessionsProvider = new SessionsTreeProvider(() => listNamedSessions());

  vscode.window.registerTreeDataProvider('keyRotatorAccounts', treeProvider);
  vscode.window.registerTreeDataProvider('keyRotatorChats', sessionsProvider);
  context.subscriptions.push(statusBar);

  let persistTimer: NodeJS.Timeout | undefined;
  const persistScanCache = () => {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(() => void context.globalState.update('keyRotator.scanCache', exportScanCache()), 2000);
  };

  const refreshUI = () => {
    statusBar.update(keyManager.getAllMeta());
    treeProvider.refresh();
    sessionsProvider.refresh();
    DashboardPanel.refreshIfOpen();
    persistScanCache();
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
    // Update the process env for the current extension host session. The chat
    // injects the key per-spawn; we intentionally do NOT write secrets into
    // .claude/settings.json (the old mirror risked leaking keys to disk and,
    // when the workspace is the home folder, contaminating global settings).
    process.env[account.envVar] = account.apiKey;
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
    const m = vscode.workspace.getConfiguration('keyRotator').get<string>('chatMode', 'full');
    return m === 'failover' || m === 'profiles' ? m : 'full';
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

  // --- web-chat accounts (DeepSeek, … driven via a headless browser) --------
  // Provider id is `<key>-web` (e.g. 'deepseek-web'); the daemon's provider key
  // is that without the suffix.
  const isWebProvider = (provider: string): boolean => provider.endsWith('-web');
  const webProviderKey = (provider: string): string => provider.replace(/-web$/, '');
  // Profile is keyed by PROVIDER (e.g. 'deepseek'), not account id: one web
  // login per provider is reused by every account of that provider, so the
  // single sign-in (their real DeepSeek session) just works.
  const webProfileDir = (provider: string): string => {
    const dir = vscode.Uri.joinPath(context.globalStorageUri, 'web-profiles', webProviderKey(provider)).fsPath;
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // best-effort
    }
    return dir;
  };
  const webDaemonPath = vscode.Uri.joinPath(
    context.extensionUri,
    'src',
    'ui',
    'media',
    'web-chat',
    'bridge.mjs'
  ).fsPath;
  const getWebBrowserPref = (): string =>
    vscode.workspace.getConfiguration('keyRotator').get<string>('webChatBrowser', 'auto') || 'auto';
  // Runners are cached by PROFILE dir (= provider), so two accounts of the same
  // provider share one browser/daemon and never fight over the locked profile.
  const webRunners = new Map<string, WebChatRunner>();
  const getWebRunner = (_accountId: string, provider: string, profile: string): WebChatRunner => {
    let r = webRunners.get(profile);
    if (!r) {
      r = new WebChatRunner(process.execPath, webDaemonPath, provider, profile, getWebBrowserPref());
      webRunners.set(profile, r);
    }
    return r;
  };

  /**
   * "Probar conexión" for a web account: confirm the login is live, then send a
   * real "Hola" and pass if the chat replies with non-error text.
   */
  async function testWebAccount(meta: AccountMeta): Promise<{ ok: boolean; detail: string }> {
    const runner = getWebRunner(meta.id, webProviderKey(meta.provider), webProfileDir(meta.provider));
    let ready: boolean;
    try {
      ready = await runner.isReady();
    } catch (e) {
      return { ok: false, detail: `no se pudo abrir el navegador (${(e as Error).message.slice(0, 50)})` };
    }
    if (!ready) {
      return { ok: false, detail: 'sin sesión — usa "Iniciar sesión (cuenta web)"' };
    }
    return new Promise<{ ok: boolean; detail: string }>((resolve) => {
      const timer = setTimeout(() => resolve({ ok: false, detail: 'sin respuesta (timeout)' }), 120000);
      runner.send('Hola', {
        onDelta: () => {},
        onDone: (full) => {
          clearTimeout(timer);
          const t = full.trim();
          resolve(t ? { ok: true, detail: `responde OK: "${t.slice(0, 40)}${t.length > 40 ? '…' : ''}"` } : { ok: false, detail: 'respuesta vacía' });
        },
        onError: (msg) => {
          clearTimeout(timer);
          resolve({ ok: false, detail: msg.slice(0, 80) });
        },
        onLoginNeeded: () => {
          clearTimeout(timer);
          resolve({ ok: false, detail: 'sin sesión iniciada' });
        },
      });
    });
  }

  /**
   * Open the headed browser so the user signs in once for a web account. Runs
   * the daemon's `login` command in a dedicated process (the persistent
   * profile can't be open headless and headed at once, so we tear down any
   * cached runner first and reopen it afterwards).
   */
  async function startWebLogin(_accountId: string, provider: string, label: string): Promise<void> {
    const dir = webProfileDir(provider);
    const key = webProviderKey(provider);
    // Free the chat runner so the headed login can own the (locked) profile.
    const existing = webRunners.get(dir);
    if (existing) {
      existing.dispose();
      webRunners.delete(dir);
    }
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: `Abriendo navegador para iniciar sesión en "${label}"…`, cancellable: false },
      () =>
        new Promise<void>((resolve) => {
          const child = childProcess.spawn(process.execPath, [webDaemonPath, key, dir], {
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', KR_WEB_BROWSER: getWebBrowserPref() },
          });
          const rl = readline.createInterface({ input: child.stdout });
          let started = false;
          rl.on('line', (line) => {
            let o: { type?: string; ok?: boolean; message?: string };
            try {
              o = JSON.parse(line);
            } catch {
              return;
            }
            if (o.type === 'ready' && !started) {
              started = true;
              child.stdin.write(JSON.stringify({ cmd: 'login' }) + '\n');
            } else if (o.type === 'login') {
              vscode.window.showInformationMessage(
                o.ok
                  ? `"${label}": sesión iniciada. Ya puedes chatear con esta cuenta en KeyRotator.`
                  : `"${label}": no se completó el inicio de sesión. Vuelve a intentarlo con "Iniciar sesión (cuenta web)".`
              );
              child.stdin.write(JSON.stringify({ cmd: 'quit' }) + '\n');
              setTimeout(() => child.kill(), 1500);
              resolve();
            } else if (o.type === 'fatal' || o.type === 'error') {
              vscode.window.showErrorMessage(`KeyRotator (web): ${o.message ?? 'error'}`);
              child.kill();
              resolve();
            }
          });
          child.on('error', (e) => {
            vscode.window.showErrorMessage(`KeyRotator (web): no se pudo abrir el navegador — ${e.message}`);
            resolve();
          });
          child.on('exit', () => resolve());
        })
    );
  }

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
  async function resolveActiveChatAccount(preferredId?: string | null): Promise<ActiveAccount | null> {
    const mode = getChatMode();

    // A panel pinned to a web account (DeepSeek, …) always uses the browser
    // daemon, independent of chatMode (which only governs the Claude paths).
    if (preferredId) {
      const pinned = keyManager.getAllMeta().find((a) => a.id === preferredId);
      if (pinned && isWebProvider(pinned.provider)) {
        return {
          id: pinned.id,
          label: pinned.label,
          web: { provider: webProviderKey(pinned.provider), profileDir: webProfileDir(pinned.provider) },
        };
      }
    }

    // Full mode: the user's default logged-in Claude — managed MCPs, single
    // account, no rotation.
    if (mode === 'full') {
      return { id: 'login', label: 'Claude (tu login)', useLogin: true };
    }

    const list = sortedActiveAnthropic();
    // Per-panel choice wins while that account is still usable.
    const meta = (preferredId ? list.find((a) => a.id === preferredId) : undefined) ?? list[0];
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

  /** Mark `accountId` exhausted (with reason), rotate, return next account. */
  async function rotateChatFrom(accountId: string, reason?: string): Promise<ActiveAccount | null> {
    const mode = getChatMode();
    // No cross-account rotation in full (single-login) mode.
    if (mode === 'full') return null;

    const accounts = keyManager.getAllMeta();
    const from = accounts.find((a) => a.id === accountId);
    // Credit/billing problems are persistent ('error', needs user action);
    // usage limits are temporary ('rate-limited', auto-recovers).
    const isCredit = /credit|saldo|billing|402|insufficient/i.test(reason ?? '');
    await keyManager.updateAccountMeta(accountId, {
      status: isCredit ? 'error' : 'rate-limited',
      lastError: reason || 'límite de uso alcanzado',
    });

    const next = pickNextAccount(applyRateLimit(accounts, accountId), CHAT_PROVIDER, accountId);
    if (!next) {
      refreshUI();
      // Surface a clear "your APIs are unusable, check why" notice.
      const broken = keyManager
        .getAllMeta()
        .filter((a) => a.provider === CHAT_PROVIDER && a.status !== 'active' && a.status !== 'disabled')
        .map((a) => `"${a.label}": ${a.lastError ?? 'límite alcanzado'}`)
        .join(' · ');
      void vscode.window
        .showErrorMessage(
          `KeyRotator: ninguna API de Anthropic se puede usar ahora — ${broken}. Revisa saldo/límites en la consola de Anthropic.`,
          'Probar cuentas'
        )
        .then((pick) => {
          if (pick === 'Probar cuentas') void vscode.commands.executeCommand('keyRotator.testAccount');
        });
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
    loadHistory: (id: string) => loadSessionAsync(id),
    getSlashCommands: () => listSlashCommands(),
    getCachedModels: (accountId?: string | null) => {
      // Instant, sync: persisted cache from the last successful detection.
      const list = sortedActiveAnthropic();
      const meta = (accountId ? list.find((a) => a.id === accountId) : undefined) ?? list[0];
      if (!meta) return FALLBACK_MODELS;
      const mem = modelsCache.get(meta.id);
      if (mem) return mem.models;
      const persisted = context.globalState.get<Record<string, { id: string; label: string }[]>>(
        'keyRotator.modelsByAccount',
        {}
      )[meta.id];
      return persisted && persisted.length > 0 ? persisted : FALLBACK_MODELS;
    },
    listModels: async (accountId?: string | null) => {
      // GitHub-Copilot-style detection via the Models API. Cached in memory
      // (15 min) and persisted to globalState so the dropdown is instant.
      const list = sortedActiveAnthropic();
      const meta = (accountId ? list.find((a) => a.id === accountId) : undefined) ?? list[0];
      if (!meta) return FALLBACK_MODELS;
      const cached = modelsCache.get(meta.id);
      if (cached && Date.now() - cached.at < 15 * 60_000) return cached.models;
      const key = await keyManager.getApiKey(meta.id);
      if (!key) return FALLBACK_MODELS;
      try {
        const res = await fetch('https://api.anthropic.com/v1/models?limit=100', {
          headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
          signal: AbortSignal.timeout(10000),
        });
        const json = (await res.json()) as { data?: { id: string; display_name?: string }[] };
        if (Array.isArray(json.data) && json.data.length > 0) {
          const models = json.data.map((m) => ({ id: m.id, label: m.display_name || m.id }));
          modelsCache.set(meta.id, { at: Date.now(), models });
          const all = context.globalState.get<Record<string, { id: string; label: string }[]>>(
            'keyRotator.modelsByAccount',
            {}
          );
          all[meta.id] = models;
          void context.globalState.update('keyRotator.modelsByAccount', all);
          return models;
        }
      } catch {
        // network / auth error — fall back
      }
      const prior = modelsCache.get(meta.id)?.models;
      return prior && prior.length > 0 ? prior : FALLBACK_MODELS;
    },
    listChatAccounts: () => {
      // Web accounts (DeepSeek, …) are always switchable regardless of chatMode.
      const web = keyManager
        .getAllMeta()
        .filter((a) => isWebProvider(a.provider))
        .map((a) => ({ id: a.id, label: a.label, active: false }));
      // In 'full' mode the Claude side always uses the user's login, so only
      // the web accounts are worth listing.
      if (getChatMode() === 'full') return web;
      const activeId = sortedActiveAnthropic()[0]?.id;
      const claude = keyManager
        .getAllMeta()
        .filter((a) => a.provider === CHAT_PROVIDER)
        .map((a) => ({ id: a.id, label: a.label, active: a.id === activeId }));
      return [...claude, ...web];
    },
    getWebRunner,
    getWebCapsFor: (accountId: string) => {
      const meta = keyManager.getAllMeta().find((a) => a.id === accountId);
      if (!meta || !isWebProvider(meta.provider)) return null;
      return WEB_CAPS[webProviderKey(meta.provider)] ?? null;
    },
  };

  const activeChatAccountLabel = (): string => {
    if (getChatMode() === 'full') return 'Claude (tu login)';
    return sortedActiveAnthropic()[0]?.label ?? 'Sin cuenta activa';
  };

  /** Swap an account's priority with its neighbor (dir -1 = up, +1 = down). */
  async function moveAccount(id: string | undefined, dir: -1 | 1): Promise<void> {
    if (!id) return;
    const all = keyManager.getAllMeta();
    const acc = all.find((a) => a.id === id);
    if (!acc) return;
    const group = all.filter((a) => a.provider === acc.provider).sort((a, b) => a.priority - b.priority);
    const idx = group.findIndex((a) => a.id === id);
    const neighbor = group[idx + dir];
    if (!neighbor) return; // already at the edge
    await keyManager.updateAccountMeta(acc.id, { priority: neighbor.priority });
    await keyManager.updateAccountMeta(neighbor.id, { priority: acc.priority });
    refreshUI();
  }

  /**
   * Real-world key check: (1) GET /v1/models validates the key itself, then
   * (2) a 1-token haiku message validates billing/limits (costs < $0.0001).
   */
  async function diagnoseAccount(accountId: string): Promise<{ ok: boolean; detail: string }> {
    const key = await keyManager.getApiKey(accountId);
    if (!key) return { ok: false, detail: 'no hay API key guardada' };
    try {
      const auth = await fetch('https://api.anthropic.com/v1/models?limit=1', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        signal: AbortSignal.timeout(10000),
      });
      if (auth.status === 401 || auth.status === 403) return { ok: false, detail: 'API key inválida o revocada' };

      const msg = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: AbortSignal.timeout(15000),
      });
      if (msg.ok) return { ok: true, detail: 'utilizable — key válida y con saldo' };
      const body = await msg.text();
      if (msg.status === 429) return { ok: false, detail: 'límite de uso alcanzado (429) — espera el reset' };
      if (/credit balance is too low/i.test(body)) return { ok: false, detail: 'sin saldo de API — recarga en console.anthropic.com → Billing' };
      if (msg.status === 400 && /billing|credit/i.test(body)) return { ok: false, detail: 'problema de facturación — revisa la consola' };
      return { ok: false, detail: `error ${msg.status}: ${body.slice(0, 120)}` };
    } catch (e) {
      return { ok: false, detail: `sin conexión o timeout (${(e as Error).message.slice(0, 60)})` };
    }
  }

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

    vscode.commands.registerCommand('keyRotator.moveAccountUp', async (node?: { account?: AccountMeta }) => {
      await moveAccount(node?.account?.id, -1);
    }),

    vscode.commands.registerCommand('keyRotator.moveAccountDown', async (node?: { account?: AccountMeta }) => {
      await moveAccount(node?.account?.id, +1);
    }),

    vscode.commands.registerCommand('keyRotator.testAccount', async (node?: { account?: AccountMeta }) => {
      // "Probar conexión": exercise whatever the account is hosted on right now.
      // Web accounts (DeepSeek, …) get a real "Hola" turn in their browser and
      // pass if the AI replies without an error; API accounts get a key/billing
      // probe.
      const all = keyManager.getAllMeta();
      let targets = node?.account?.id
        ? all.filter((a) => a.id === node.account!.id)
        : all.filter((a) => a.provider === CHAT_PROVIDER || isWebProvider(a.provider));
      if (targets.length === 0) {
        vscode.window.showInformationMessage('KeyRotator: no hay cuentas que probar.');
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'KeyRotator: probando conexión…' },
        async (progress) => {
          for (const meta of targets) {
            progress.report({ message: meta.label });
            const verdict = isWebProvider(meta.provider)
              ? await testWebAccount(meta)
              : await diagnoseAccount(meta.id);
            await keyManager.updateAccountMeta(meta.id, {
              status: verdict.ok ? 'active' : 'error',
              lastError: verdict.ok ? undefined : verdict.detail,
            });
            const icon = verdict.ok ? '✅' : '⛔';
            void vscode.window.showInformationMessage(`${icon} ${meta.label}: ${verdict.detail}`);
          }
          refreshUI();
          ChatPanel.refreshIfOpen();
        }
      );
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
        await keyManager.updateAccountMeta(id, { status: 'active', lastError: undefined });
      }
      await setPreferredId(id);
      refreshUI();
      ChatPanel.refreshIfOpen();
      vscode.window.showInformationMessage(`KeyRotator: el chat ahora usa "${acc?.label ?? id}".`);
    }),

    vscode.commands.registerCommand('keyRotator.loginProfile', async (node?: { account?: AccountMeta }) => {
      const accounts = keyManager.getAllMeta().filter((a) => a.provider === CHAT_PROVIDER);
      if (accounts.length === 0) {
        vscode.window.showInformationMessage('KeyRotator: agrega primero una cuenta de Anthropic.');
        return;
      }
      let picked: { label: string; id: string } | undefined = node?.account
        ? { label: node.account.label, id: node.account.id }
        : undefined;
      if (!picked) {
        picked = await vscode.window.showQuickPick(
          accounts.map((a) => ({ label: a.label, description: a.provider, id: a.id })),
          { placeHolder: 'Inicia sesión en el perfil de qué cuenta (modo chat "profiles")' }
        );
      }
      if (!picked) return;

      // Optional: pre-fill the email on the OAuth page so the browser opens
      // straight to the right Google/Anthropic account (helpful for the 2nd+
      // profile, where the browser may already have another account active).
      const email = await vscode.window.showInputBox({
        prompt: `Email de la cuenta de Claude.ai para "${picked.label}" (opcional)`,
        placeHolder: 'tu-correo@gmail.com — déjalo vacío para elegir en el navegador',
      });

      // Open a terminal scoped to this account's CLAUDE_CONFIG_DIR and run the
      // CLI login. `claude auth login` opens the browser automatically; the
      // OAuth credential is stored only in this dir, so each account keeps
      // its own login + claude.ai-managed MCPs.
      const dir = profileDir(picked.id);
      const terminal = vscode.window.createTerminal({
        name: `KeyRotator login: ${picked.label}`,
        env: { CLAUDE_CONFIG_DIR: dir },
      });
      terminal.show();
      const cmd = email?.trim() ? `claude auth login --claudeai --email "${email.trim()}"` : 'claude auth login --claudeai';
      terminal.sendText(cmd);
      vscode.window.showInformationMessage(
        `"${picked.label}": se abrirá tu navegador para iniciar sesión. Cuando termines ahí, vuelve a esta terminal — puede pedirte pegar un código.`
      );
    }),

    vscode.commands.registerCommand('keyRotator.addAccount', () => {
      DashboardPanel.createOrShow(context.extensionUri, dashboardCallbacks);
    }),

    // "Add Account (Login)": one click = pick a provider, create the account,
    // and open the browser to log in — no API key needed. Claude uses the CLI
    // OAuth; web providers (DeepSeek, …) drive their web chat in a browser.
    // The list is an array so more web chats can be added once verified.
    vscode.commands.registerCommand('keyRotator.addLoginAccount', async () => {
      type LoginProvider = { label: string; description: string; id: string; flow: 'claude' | 'web' };
      const LOGIN_PROVIDERS: LoginProvider[] = [
        { label: '$(sparkle) Claude (Claude.ai)', description: 'Usa tu suscripción — abre el navegador para iniciar sesión', id: CHAT_PROVIDER, flow: 'claude' },
        { label: '$(globe) DeepSeek (web)', description: 'Chat web de DeepSeek (V4) sin API — inicia sesión una vez en el navegador', id: 'deepseek-web', flow: 'web' },
      ];
      const picked = await vscode.window.showQuickPick(LOGIN_PROVIDERS, {
        placeHolder: '¿Qué cuenta quieres agregar?',
      });
      if (!picked) return;

      const sameProvider = keyManager.getAllMeta().filter((a) => a.provider === picked.id);
      const id = randomUUID();

      if (picked.flow === 'web') {
        const defaultName = `${webProviderKey(picked.id).replace(/^\w/, (c) => c.toUpperCase())} (cuenta ${sameProvider.length + 1})`;
        await keyManager.addAccount({
          id,
          provider: picked.id,
          label: defaultName,
          apiKey: '',
          envVar: '',
          priority: sameProvider.length + 1,
          switchMode: 'confirm',
          status: 'active',
        });
        refreshUI();
        ChatPanel.refreshIfOpen();
        await startWebLogin(id, picked.id, defaultName);
        return;
      }

      await keyManager.addAccount({
        id,
        provider: picked.id,
        label: `Claude (cuenta ${sameProvider.length + 1})`,
        apiKey: '',
        envVar: 'ANTHROPIC_API_KEY',
        priority: sameProvider.length + 1,
        switchMode: 'confirm',
        status: 'active',
      });

      // Login-only accounts only work in 'profiles' mode (isolated CLAUDE_CONFIG_DIR).
      if (getChatMode() !== 'profiles') {
        await vscode.workspace
          .getConfiguration('keyRotator')
          .update('chatMode', 'profiles', vscode.ConfigurationTarget.Global);
      }

      // Open a terminal scoped to this new account's CLAUDE_CONFIG_DIR. `claude
      // auth login --claudeai` opens the browser automatically; once the user
      // finishes there, the account is ready to use in chat.
      const dir = profileDir(id);
      const terminal = vscode.window.createTerminal({
        name: `KeyRotator login: ${sameProvider.length + 1}`,
        env: { CLAUDE_CONFIG_DIR: dir },
      });
      terminal.show();
      terminal.sendText('claude auth login --claudeai');
      vscode.window.showInformationMessage(
        'KeyRotator: cuenta creada — se abrirá tu navegador para iniciar sesión. Cuando termines ahí, vuelve a esta terminal.'
      );
      refreshUI();
      ChatPanel.refreshIfOpen();
    }),

    // Open the web-login browser for a web account (DeepSeek, …): a real,
    // headed Chromium window where the user signs in once; the session is
    // saved in the account's persistent profile.
    vscode.commands.registerCommand('keyRotator.webChatLogin', async (node?: { account?: AccountMeta }) => {
      let meta = node?.account;
      if (!meta || !isWebProvider(meta.provider)) {
        const webAccts = keyManager.getAllMeta().filter((a) => isWebProvider(a.provider));
        if (webAccts.length === 0) {
          vscode.window.showInformationMessage('KeyRotator: agrega primero una cuenta web (DeepSeek) con "Add Account (Login)".');
          return;
        }
        const picked = await vscode.window.showQuickPick(
          webAccts.map((a) => ({ label: a.label, description: a.provider, id: a.id, provider: a.provider })),
          { placeHolder: '¿En qué cuenta web quieres iniciar sesión?' }
        );
        if (!picked) return;
        meta = webAccts.find((a) => a.id === picked.id);
      }
      if (!meta) return;
      await startWebLogin(meta.id, meta.provider, meta.label);
    }),

    vscode.commands.registerCommand('keyRotator.activateAccount', async (node?: { account?: AccountMeta }) => {
      const id = node?.account?.id;
      if (!id) return;
      await keyManager.updateAccountMeta(id, { status: 'active', lastError: undefined });
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

    vscode.commands.registerCommand('keyRotator.editAccount', async (node?: { account?: AccountMeta }) => {
      let meta = node?.account;
      if (!meta) {
        const all = keyManager.getAllMeta();
        if (all.length === 0) {
          DashboardPanel.createOrShow(context.extensionUri, dashboardCallbacks);
          return;
        }
        const picked = await vscode.window.showQuickPick(
          all.map((a) => ({ label: a.label, description: a.provider, id: a.id })),
          { placeHolder: '¿Qué cuenta quieres renombrar?' }
        );
        if (!picked) return;
        meta = all.find((a) => a.id === picked.id);
      }
      if (!meta) return;
      const name = await vscode.window.showInputBox({
        prompt: `Nuevo nombre para "${meta.label}"`,
        value: meta.label,
        validateInput: (v) => (v.trim() ? undefined : 'El nombre no puede estar vacío'),
      });
      if (name === undefined) return;
      await keyManager.updateAccountMeta(meta.id, { label: name.trim() });
      refreshUI();
      ChatPanel.refreshIfOpen();
      DashboardPanel.refreshIfOpen();
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
        await keyManager.updateAccountMeta(accountId, { status: 'active', lastError: undefined });

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

  // Tear down any web-chat browser daemons when the extension unloads.
  context.subscriptions.push(
    new vscode.Disposable(() => {
      for (const r of webRunners.values()) r.dispose();
      webRunners.clear();
    })
  );

  // Changing the web browser preference rebuilds runners with the new browser.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('keyRotator.webChatBrowser')) {
        for (const r of webRunners.values()) r.dispose();
        webRunners.clear();
      }
    })
  );

  // --- registry refresh ---------------------------------------------------

  void registry.refreshFromRemote();

  refreshUI();

  // Warm the scan cache in the background shortly after startup so any
  // sessions changed while VS Code was closed get re-scanned and persisted.
  setTimeout(() => {
    listNamedSessions();
    persistScanCache();
    sessionsProvider.refresh();
  }, 1500);
}

export function deactivate() {}
