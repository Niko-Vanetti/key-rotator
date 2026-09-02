import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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
import { SessionsTreeProvider } from './ui/sessionsTreeProvider.js';
import { DashboardPanel, type DashboardCallbacks } from './ui/dashboardPanel.js';
import { ChatPanel } from './ui/chatPanel.js';
import type { ChatBackend, ActiveAccount } from './chat/chatSession.js';
import { AgentStore, isAgentSessionId, messageText } from './agent/agentStore.js';
import { McpConnection, type McpServerConfig } from './agent/mcpClient.js';
import { listSkillNames, findSkills } from './agent/tools.js';
import { parseSnippet, snippetHasData } from './core/snippetParser.js';
import { analyzeViability } from './agent/aiTools.js';
import { inferNvidiaProfile, type NvidiaModelProfile } from './agent/nvidiaProfiles.js';

const HISTORY_KEY = 'keyRotator.history';

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
  // Lista de API keys en orden ALFABÉTICO por etiqueta (= modelo). Los modelos
  // se gestionan en el Dashboard; la barra lateral solo muestra los Chats.
  const sortedMeta = () => [...keyManager.getAllMeta()].sort((a, b) => a.label.localeCompare(b.label));

  // Seed the transcript scan cache from the last run so the Chats view and
  // panel open instantly even on a cold start (no re-reading MB of jsonl).

  // --- agent (NVIDIA Build / OpenRouter con herramientas) -------------------
  // Herramienta INDEPENDIENTE de Claude Code: sus chats viven en una carpeta
  // visible de Documentos, y el árbol de Chats lista SOLO estos (nunca los de
  // Claude Code — borrar aquí jamás toca el almacén de Claude).
  const agentChatsDir = path.join(os.homedir(), 'Documents', 'KeyRotator Chats');
  // Migración: sesiones creadas cuando el almacén vivía en globalStorage.
  try {
    const oldDir = vscode.Uri.joinPath(context.globalStorageUri, 'agent-sessions').fsPath;
    if (fs.existsSync(oldDir)) {
      fs.mkdirSync(agentChatsDir, { recursive: true });
      for (const f of fs.readdirSync(oldDir).filter((f) => f.endsWith('.json'))) {
        const dest = path.join(agentChatsDir, f);
        if (!fs.existsSync(dest)) fs.renameSync(path.join(oldDir, f), dest);
      }
    }
  } catch {
    // best-effort migration
  }
  const agentStore = new AgentStore(agentChatsDir);
  // Carpeta ÚNICA de trabajo por defecto (pedida por el usuario): todo lo que
  // el agente genere (scripts, temporales, resultados) vive aquí.
  const agentDefaultCwd = () => path.join(os.homedir(), 'Documents', 'KeyRotator');

  // --- MCP y Skills PROPIOS de KeyRotator -----------------------------------
  // Config propia (herramienta independiente), editable desde el dashboard;
  // los botones "Sincronizar con Claude" copian desde ~/.claude.json y
  // ~/.claude/skills. Los MCP gestionados por claude.ai (Canva/Gmail/Drive)
  // son OAuth y NO se pueden lanzar aquí: solo servidores con command+args.
  const krConfigDir = path.join(os.homedir(), 'Documents', 'KeyRotator Config');
  const krMcpFile = path.join(krConfigDir, 'mcp.json');
  const krSkillsDir = path.join(krConfigDir, 'skills');
  const claudeSkillsDir = path.join(os.homedir(), '.claude', 'skills');
  const ensureConfigDirs = () => {
    fs.mkdirSync(krSkillsDir, { recursive: true });
    if (!fs.existsSync(krMcpFile)) fs.writeFileSync(krMcpFile, JSON.stringify({ mcpServers: {} }, null, 2), 'utf-8');
  };
  const readKrMcp = (): Record<string, McpServerConfig> => {
    try {
      const j = JSON.parse(fs.readFileSync(krMcpFile, 'utf-8')) as { mcpServers?: Record<string, McpServerConfig> };
      return j.mcpServers ?? {};
    } catch {
      return {};
    }
  };
  const writeKrMcp = (servers: Record<string, McpServerConfig>) => {
    ensureConfigDirs();
    fs.writeFileSync(krMcpFile, JSON.stringify({ mcpServers: servers }, null, 2), 'utf-8');
    mcpConnections.forEach((c) => c.dispose());
    mcpConnections.clear(); // reconecta con la config nueva
  };

  const mcpConnections = new Map<string, McpConnection>();
  const loadMcpServers = (): Record<string, McpServerConfig> => {
    const servers = readKrMcp();
    const override = vscode.workspace.getConfiguration('keyRotator').get<string>('chatMcpConfig', '').trim();
    if (override) {
      try {
        const j = JSON.parse(fs.readFileSync(override, 'utf-8')) as { mcpServers?: Record<string, McpServerConfig> };
        for (const [name, cfg] of Object.entries(j.mcpServers ?? {})) if (cfg?.command) servers[name] = cfg;
      } catch {
        /* bad path — ignore */
      }
    }
    return servers;
  };
  const mcpEnabled = () => vscode.workspace.getConfiguration('keyRotator').get<boolean>('agentUseMcp', true);
  // Resolve every linked server's tools into namespaced agent tools. Cached
  // connections are reused; a failing server is skipped, never fatal.
  const getAgentMcpTools = async () => {
    if (!mcpEnabled()) return [];
    const servers = loadMcpServers();
    const out: { def: unknown; call: (argsJson: string) => Promise<string> }[] = [];
    for (const [server, cfg] of Object.entries(servers)) {
      let conn = mcpConnections.get(server);
      if (!conn) {
        conn = new McpConnection(server, cfg);
        mcpConnections.set(server, conn);
      }
      try {
        const tools = await conn.listTools();
        for (const t of tools) {
          const name = `mcp__${server}__${t.name}`.replace(/[^a-zA-Z0-9_]/g, '_');
          out.push({
            def: {
              type: 'function',
              function: {
                name,
                description: `[MCP ${server}] ${t.description}`.slice(0, 1024),
                parameters: t.inputSchema,
              },
            },
            call: (argsJson: string) => {
              let args: Record<string, unknown> = {};
              try {
                args = JSON.parse(argsJson || '{}');
              } catch {
                /* pass {} */
              }
              return conn!.callTool(t.name, args);
            },
          });
        }
      } catch {
        // server didn't start / list — skip it this turn
      }
    }
    return out;
  };
  context.subscriptions.push(new vscode.Disposable(() => mcpConnections.forEach((c) => c.dispose())));
  const allSessions = () =>
    agentStore
      .list()
      .map((s) => ({ id: s.id, name: s.title, cwd: '', mtime: s.updatedAt, filePath: '' }))
      .sort((a, b) => b.mtime - a.mtime);

  const sessionsProvider = new SessionsTreeProvider(() => allSessions());

  vscode.window.registerTreeDataProvider('keyRotatorChats', sessionsProvider);
  context.subscriptions.push(statusBar);

  let persistTimer: NodeJS.Timeout | undefined;
  const persistScanCache = () => {
    clearTimeout(persistTimer);
    persistTimer = undefined;
  };

  // Auto-sync the Chats list with the shared Claude store: watch
  // ~/.claude/projects and refresh when sessions are created/renamed/updated
  // Auto-refresh the Chats tree when the agent's Documents folder changes.
  // (No watcher on Claude Code's store: the tree no longer lists those chats.)
  try {
    fs.mkdirSync(agentChatsDir, { recursive: true });
    let agentWatchTimer: NodeJS.Timeout | undefined;
    const agentWatcher = fs.watch(agentChatsDir, () => {
      clearTimeout(agentWatchTimer);
      agentWatchTimer = setTimeout(() => sessionsProvider.refresh(), 700);
    });
    context.subscriptions.push(new vscode.Disposable(() => agentWatcher.close()));
  } catch {
    // watch unsupported — non-fatal
  }

  const refreshUI = () => {
    statusBar.update(keyManager.getAllMeta());
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

  /**
   * Analiza un modelo y GUARDA el veredicto en la cuenta, para que el
   * diagnóstico quede visible junto al modelo sin volver a probarlo. Se usa
   * tanto desde el botón "Probar" como al agregar un modelo nuevo.
   */
  async function runViabilityCheck(id: string): Promise<{ verdict: string; summary: string }> {
    const meta = keyManager.getAllMeta().find((a) => a.id === id);
    if (!meta || !isOpenAIProvider(meta.provider)) {
      return { verdict: 'no-viable', summary: 'no es un modelo de NVIDIA Build / OpenRouter' };
    }
    const key = await keyManager.getApiKey(id);
    const model = openAIModel(meta);
    if (!key || !model) {
      const summary = !key ? 'sin API key guardada' : 'sin modelo elegido';
      await keyManager.updateAccountMeta(id, {
        status: 'error',
        lastError: summary,
        viability: { verdict: 'no-viable', summary, at: Date.now() },
      });
      refreshUI();
      return { verdict: 'no-viable', summary };
    }
    const report = await analyzeViability(openAIEndpoint(meta), key, model);
    const summary = report.reasons.join(' · ');
    // 'no-concluyente' NO condena al modelo (fue el proveedor, no él): la
    // cuenta sigue activa y se puede volver a probar.
    await keyManager.updateAccountMeta(id, {
      status: report.verdict === 'no-viable' ? 'error' : 'active',
      lastError: report.verdict === 'no-viable' ? summary : undefined,
      viability: { verdict: report.verdict, summary, at: Date.now() },
    });
    refreshUI();
    return { verdict: report.verdict, summary };
  }

  const dashboardCallbacks: DashboardCallbacks = {
    getState: () => ({
      accounts: sortedMeta(),
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
    // Botón "Probar" del Dashboard: análisis de viabilidad real del modelo.
    testModel: (id: string) => runViabilityCheck(id),
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
    // Un pegado → cuenta lista (mismo motor que el comando 'Pegar código').
    addFromSnippet: (text: string, label?: string) => addAccountFromText(text, label),

    // ----- Director de la agencia -----
    getDirector: () =>
      vscode.workspace.getConfiguration('keyRotator').get<string>('agencyDirector', 'auto') || 'auto',
    setDirector: async (value: string) => {
      await vscode.workspace
        .getConfiguration('keyRotator')
        .update('agencyDirector', value || 'auto', vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(
        value && value !== 'auto'
          ? `KeyRotator: ${value} dirigirá la agencia.`
          : 'KeyRotator: director automático (el mejor disponible).'
      );
    },

    // ----- MCP (config propia de KeyRotator) -----
    listMcp: () =>
      Object.entries(readKrMcp()).map(([name, cfg]) => ({
        name,
        detail: [cfg.command, ...(cfg.args ?? [])].join(' ').slice(0, 120),
      })),
    addMcp: async (text: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return 'la configuración pegada no es JSON válido.';
      }
      const obj = parsed as Record<string, unknown> & { mcpServers?: Record<string, McpServerConfig> };
      const incoming = (obj.mcpServers ?? obj) as Record<string, McpServerConfig>;
      const servers = readKrMcp();
      let added = 0;
      for (const [name, cfg] of Object.entries(incoming)) {
        if (cfg && typeof cfg === 'object' && typeof (cfg as McpServerConfig).command === 'string') {
          servers[name] = cfg as McpServerConfig;
          added++;
        }
      }
      if (added === 0) return 'no encontré ningún servidor con "command". Revisa el formato.';
      writeKrMcp(servers);
      return null;
    },
    deleteMcp: async (name: string) => {
      const servers = readKrMcp();
      delete servers[name];
      writeKrMcp(servers);
    },
    editMcp: async () => {
      ensureConfigDirs();
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(krMcpFile));
    },
    syncMcpFromClaude: async () => {
      let claude: Record<string, McpServerConfig> = {};
      try {
        const j = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf-8')) as {
          mcpServers?: Record<string, McpServerConfig>;
        };
        claude = j.mcpServers ?? {};
      } catch {
        return 'no pude leer ~/.claude.json (¿existe?).';
      }
      const servers = readKrMcp();
      let n = 0;
      for (const [name, cfg] of Object.entries(claude)) {
        if (cfg?.command) {
          servers[name] = cfg;
          n++;
        }
      }
      writeKrMcp(servers);
      return n
        ? `${n} servidor(es) MCP importados de Claude. (Las integraciones OAuth de claude.ai — Canva, Gmail, Drive — no son importables.)`
        : 'Claude no tiene servidores MCP locales que importar (los de claude.ai son OAuth y no se pueden vincular).';
    },

    // ----- Skills (biblioteca propia de KeyRotator) -----
    listSkills: () =>
      listSkillNames([krSkillsDir]).map((name) => ({ name, detail: 'use_skill("' + name + '")' })),
    addSkill: async (name: string, text: string) => {
      const clean = name.trim().replace(/[^\w.-]+/g, '-');
      if (!clean) return 'nombre de skill inválido.';
      ensureConfigDirs();
      fs.mkdirSync(path.join(krSkillsDir, clean), { recursive: true });
      fs.writeFileSync(path.join(krSkillsDir, clean, 'SKILL.md'), text, 'utf-8');
      return null;
    },
    deleteSkill: async (name: string) => {
      const clean = name.replace(/[\\/]|\.\./g, '');
      try {
        fs.rmSync(path.join(krSkillsDir, clean), { recursive: true, force: true });
        fs.rmSync(path.join(krSkillsDir, `${clean}.md`), { force: true });
      } catch {
        // already gone
      }
    },
    editSkill: async (name: string) => {
      const clean = name.replace(/[\\/]|\.\./g, '');
      for (const p of [path.join(krSkillsDir, clean, 'SKILL.md'), path.join(krSkillsDir, `${clean}.md`)]) {
        if (fs.existsSync(p)) {
          await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(p));
          return;
        }
      }
    },
    syncSkillsFromClaude: async () => {
      ensureConfigDirs();
      const names = listSkillNames([claudeSkillsDir]);
      if (names.length === 0) return 'no encontré skills en ~/.claude/skills.';
      let n = 0;
      for (const name of names) {
        const src = path.join(claudeSkillsDir, name);
        try {
          fs.cpSync(src, path.join(krSkillsDir, name), { recursive: true });
          n++;
        } catch {
          // skip unreadable skill
        }
      }
      return `${n} skill(s) copiadas desde Claude a la biblioteca de KeyRotator.`;
    },
    /**
     * Importa TODAS las skills que haya en una carpeta (un repo entero, con
     * subcarpetas): cada carpeta con SKILL.md se copia completa y cada .md
     * suelto se registra como skill.
     */
    importSkillsFrom: async (dir?: string) => {
      let target = dir;
      if (!target) {
        const picked = await vscode.window.showOpenDialog({
          canSelectFolders: true,
          canSelectFiles: false,
          canSelectMany: false,
          openLabel: 'Importar skills de esta carpeta',
        });
        target = picked?.[0]?.fsPath;
      }
      if (!target) return '';
      if (!fs.existsSync(target)) return `no existe la ruta "${target}".`;
      // Si soltaron un archivo, se importa desde su carpeta contenedora.
      if (!fs.statSync(target).isDirectory()) target = path.dirname(target);
      ensureConfigDirs();
      const skills = findSkills(target);
      if (skills.length === 0) {
        return `no encontré skills en "${path.basename(target)}" (busco subcarpetas con SKILL.md o archivos .md).`;
      }
      let ok = 0;
      const failed: string[] = [];
      for (const s of skills) {
        const clean = s.name.replace(/[^\w.-]+/g, '-');
        try {
          if (s.isDir) {
            fs.cpSync(s.source, path.join(krSkillsDir, clean), { recursive: true });
          } else {
            fs.mkdirSync(path.join(krSkillsDir, clean), { recursive: true });
            fs.copyFileSync(s.source, path.join(krSkillsDir, clean, 'SKILL.md'));
          }
          ok++;
        } catch {
          failed.push(s.name);
        }
      }
      return failed.length
        ? `${ok} skill(s) importadas. No pude copiar: ${failed.join(', ')}.`
        : `${ok} skill(s) importadas desde "${path.basename(target)}".`;
    },
  };

  // --- chat backend ------------------------------------------------------

  type ChatMode = 'failover' | 'full' | 'profiles';

  /** Per-account CLAUDE_CONFIG_DIR (its own OAuth login) for `profiles` mode. */

  const PREFERRED_KEY = 'keyRotator.preferredChatAccount';
  const getPreferredId = (): string | undefined => context.globalState.get<string>(PREFERRED_KEY);
  const setPreferredId = (id: string | undefined) => context.globalState.update(PREFERRED_KEY, id);
  // The account a chat panel is effectively using: its per-panel pin, or the
  // globally-selected account (tree click) when the panel isn't pinned.
  const resolveMeta = (accountId?: string | null): AccountMeta | undefined => {
    const id = accountId || getPreferredId();
    return id ? keyManager.getAllMeta().find((a) => a.id === id) : undefined;
  };

  // --- OpenAI-compatible API chat accounts (OpenRouter, …) ------------------
  const OPENAI_ENDPOINTS: Record<string, string> = {
    openrouter: 'https://openrouter.ai/api/v1',
    openai: 'https://api.openai.com/v1',
    groq: 'https://api.groq.com/openai/v1',
    'together-ai': 'https://api.together.xyz/v1',
    nvidia: 'https://integrate.api.nvidia.com/v1',
  };
  const isOpenAIProvider = (provider: string): boolean => provider in OPENAI_ENDPOINTS;
  const OPENAI_DISPLAY_NAMES: Record<string, string> = {
    openrouter: 'OpenRouter',
    nvidia: 'NVIDIA Build',
  };
  const openAIEndpoint = (meta: AccountMeta): string =>
    (meta.endpoint && meta.endpoint.trim()) || OPENAI_ENDPOINTS[meta.provider] || OPENAI_ENDPOINTS.openrouter;
  const OAI_MODEL_KEY = 'keyRotator.openaiModelByAccount';
  // Request params (temperature, top_p, max_tokens, seed) captured from the
  // pasted sample code, applied to every request of that account.
  const OAI_PARAMS_KEY = 'keyRotator.openaiParamsByAccount';
  const NVIDIA_PROFILES_KEY = 'keyRotator.nvidiaProfilesByAccount';
  const getNvidiaProfiles = (): Record<string, NvidiaModelProfile> =>
    context.globalState.get<Record<string, NvidiaModelProfile>>(NVIDIA_PROFILES_KEY, {});
  const setNvidiaProfile = (profile: NvidiaModelProfile): void => {
    const profiles = getNvidiaProfiles();
    profiles[profile.accountId] = profile;
    void context.globalState.update(NVIDIA_PROFILES_KEY, profiles);
  };
  const getOaiParams = (accountId: string): Record<string, number> | undefined =>
    context.globalState.get<Record<string, Record<string, number>>>(OAI_PARAMS_KEY, {})[accountId];
  const setOaiParams = (accountId: string, params: Record<string, number>) => {
    const m = context.globalState.get<Record<string, Record<string, number>>>(OAI_PARAMS_KEY, {});
    m[accountId] = params;
    void context.globalState.update(OAI_PARAMS_KEY, m);
  };
  const getOaiModelMap = (): Record<string, string> =>
    context.globalState.get<Record<string, string>>(OAI_MODEL_KEY, {});
  const setOaiModel = (accountId: string, model: string) => {
    const m = getOaiModelMap();
    m[accountId] = model;
    void context.globalState.update(OAI_MODEL_KEY, m);
  };
  const openAIModel = (meta: AccountMeta): string => {
    // Per-account choice (set from the chat dropdown) wins, then the explicit
    // OpenRouter setting. NO hardcoded default: '' means "the user must pick
    // from the API-loaded list" and the chat refuses to send until then.
    const perAccount = getOaiModelMap()[meta.id];
    if (perAccount) return perAccount;
    if (meta.provider === 'openrouter') {
      return vscode.workspace.getConfiguration('keyRotator').get<string>('openRouterModel', '').trim();
    }
    return '';
  };

  // Migración de nombres: entradas viejas tipo "NVIDIA Build" pasan a llamarse
  // como su MODELO (cada key = un modelo, así se listan y ordenan).
  for (const a of keyManager.getAllMeta()) {
    if (isOpenAIProvider(a.provider)) {
      const model = openAIModel(a);
      if (model && a.label !== model) void keyManager.updateAccountMeta(a.id, { label: model });
    }
  }

  /**
   * The one-paste setup engine (dashboard box AND the 📋 command): parses the
   * sample code / bare key, asks for the real key if the sample carries a
   * placeholder, creates the account (endpoint+model+params included), makes
   * it the preferred chat account and opens the chat.
   */
  async function addAccountFromText(text: string, labelOverride?: string): Promise<{ ok: boolean; summary?: string }> {
    const parsed = parseSnippet(text);
    if (!snippetHasData(parsed)) {
      // Not NVIDIA/OpenRouter-shaped: maybe a bare key of another provider
      // (Anthropic, Gemini, …) — keep the old detection path working.
      const token = text.trim();
      if (token && !/\s/.test(token)) {
        const det = await dashboardCallbacks.detectProvider(token);
        if (det.provider) {
          const same = keyManager.getAllMeta().filter((a) => a.provider === det.provider);
          await keyManager.addAccount({
            id: randomUUID(),
            provider: det.provider,
            label: labelOverride || `${det.displayName} ${same.length + 1}`,
            apiKey: token,
            envVar: det.envVar,
            priority: same.length + 1,
            switchMode: 'confirm',
            status: 'active',
          });
          refreshUI();
          return { ok: true, summary: `Cuenta de ${det.displayName} agregada ✓` };
        }
      }
      void vscode.window.showErrorMessage(
        'KeyRotator: no encontré endpoint, modelo ni API key en lo pegado. Copia el bloque de código completo de build.nvidia.com.'
      );
      return { ok: false };
    }

    const provider = parsed.provider ?? 'nvidia';
    let apiKey = parsed.apiKey;
    if (!apiKey) {
      apiKey =
        (
          await vscode.window.showInputBox({
            title: 'Tu API key',
            prompt: `El código trae un placeholder — pega tu key real de ${provider === 'nvidia' ? 'NVIDIA Build (nvapi-…)' : 'OpenRouter (sk-or-…)'}`,
            password: true,
            ignoreFocusOut: true,
          })
        )?.trim() || null;
      if (!apiKey) return { ok: false };
    }

    const sameProvider = keyManager.getAllMeta().filter((a) => a.provider === provider);
    const id = randomUUID();
    // La entrada se llama como su MODELO (cada key = un modelo, pedido del
    // usuario); fallback al proveedor si el código pegado no traía modelo.
    const baseLabel = parsed.model || (provider === 'nvidia' ? 'NVIDIA Build' : 'OpenRouter');
    const label = labelOverride || baseLabel;
    await keyManager.addAccount({
      id,
      provider,
      label,
      apiKey,
      envVar: provider === 'nvidia' ? 'NVIDIA_API_KEY' : 'OPENROUTER_API_KEY',
      endpoint: parsed.baseUrl ?? undefined,
      priority: sameProvider.length + 1,
      switchMode: 'auto',
      status: 'active',
    });
    if (parsed.model) setOaiModel(id, parsed.model);
    if (Object.keys(parsed.params).length) setOaiParams(id, parsed.params);
    if (provider === 'nvidia') setNvidiaProfile(inferNvidiaProfile(id, parsed));
    await context.globalState.update('keyRotator.preferredChatAccount', id);
    refreshUI();
    ChatPanel.refreshIfOpen();
    const resumen = [
      `cuenta "${label}"`,
      parsed.model ? `modelo ${parsed.model}` : 'modelo: elígelo en el chat',
      Object.keys(parsed.params).length ? `params ${JSON.stringify(parsed.params)}` : null,
    ]
      .filter(Boolean)
      .join(' · ');
    void vscode.window.showInformationMessage(`KeyRotator: listo — ${resumen}. Abriendo el chat…`);
    // Diagnóstico automático en segundo plano: así el modelo ya aparece con su
    // veredicto y el usuario no tiene que pulsar "Probar" en cada uno.
    if (parsed.model) {
      void runViabilityCheck(id).then((v) => {
        DashboardPanel.refreshIfOpen();
        if (v.verdict === 'no-viable') {
          void vscode.window.showWarningMessage(`KeyRotator: ⛔ ${label} — ${v.summary}`);
        }
      });
    }
    await vscode.commands.executeCommand('keyRotator.openChat');
    return { ok: true, summary: `${resumen} ✓` };
  }



  /** Build the runnable account for an API-key model (one key = one model). */
  async function toActiveAccount(meta: AccountMeta): Promise<ActiveAccount | null> {
    const key = await keyManager.getApiKey(meta.id);
    if (!key) return null;
    return {
      id: meta.id,
      label: meta.label,
      openai: {
        apiKey: key,
        endpoint: openAIEndpoint(meta),
        model: openAIModel(meta),
        provider: meta.provider,
        params: getOaiParams(meta.id),
        profile: meta.provider === 'nvidia' ? getNvidiaProfiles()[meta.id] : undefined,
      },
    };
  }

  /** Resolve the model the next turn should use: the pinned one, else the first. */
  async function resolveActiveChatAccount(preferredId?: string | null): Promise<ActiveAccount | null> {
    const usable = () =>
      keyManager
        .getAllMeta()
        .filter((a) => isOpenAIProvider(a.provider) && a.status !== 'disabled')
        .sort((a, b) => a.label.localeCompare(b.label));

    // El panel puede estar fijado a un modelo; si no, vale el elegido global.
    const pref = preferredId ?? getPreferredId();
    const pinned = pref ? usable().find((a) => a.id === pref) : undefined;
    const meta = pinned ?? usable()[0];
    return meta ? toActiveAccount(meta) : null;
  }

  /** Mark `accountId` exhausted (with reason), rotate, return next model. */
  async function rotateChatFrom(accountId: string, reason?: string): Promise<ActiveAccount | null> {
    const accounts = keyManager.getAllMeta();
    const from = accounts.find((a) => a.id === accountId);
    if (!from || !isOpenAIProvider(from.provider)) return null;

    // Un problema de saldo es persistente ('error'); un límite de uso se
    // recupera solo ('rate-limited').
    const isCredit = /credit|saldo|billing|402|insufficient/i.test(reason ?? '');
    await keyManager.updateAccountMeta(accountId, {
      status: isCredit ? 'error' : 'rate-limited',
      lastError: reason || 'límite de uso alcanzado',
    });

    const next = pickNextAccount(applyRateLimit(accounts, accountId), from.provider, accountId);
    refreshUI();
    if (!next) {
      const broken = accounts
        .filter((a) => isOpenAIProvider(a.provider) && a.status !== 'active' && a.status !== 'disabled')
        .map((a) => `"${a.label}": ${a.lastError ?? 'límite alcanzado'}`)
        .join(' · ');
      void vscode.window.showErrorMessage(
        `KeyRotator: ningún modelo disponible ahora — ${broken || 'sin modelos activos'}.`
      );
      return null;
    }

    const active = await toActiveAccount(next);
    if (!active) return null;
    // El historial del Dashboard registra TODA rotación (antes solo las de Claude).
    await setHistory(
      addHistoryEntry(getHistory(), {
        timestamp: Date.now(),
        fromAccountId: accountId,
        fromLabel: from.label,
        toAccountId: next.id,
        toLabel: next.label,
        provider: from.provider,
        reason: 'rate-limit',
      })
    );
    refreshUI();
    return active;
  }

  /** Skills disponibles para el agente (propias primero, luego las de Claude). */
  const agentSkillNames = (): string[] => {
    const own = listSkillNames([krSkillsDir]);
    return own.length ? own : listSkillNames([claudeSkillsDir]);
  };

  const chatBackend: ChatBackend = {
    resolveActiveAccount: resolveActiveChatAccount,
    rotateFrom: rotateChatFrom,
    listSessions: () => allSessions(),
    loadHistory: async (id: string) => {
      const s = isAgentSessionId(id) ? agentStore.load(id) : null;
      if (!s) return null;
      return s.messages
        .filter((m) => (m.role === 'user' || m.role === 'assistant') && !!m.content)
        .map((m) => ({
          role: m.role as 'user' | 'assistant',
          text: messageText(m.content),
          attachments: m.attachments,
        }));
    },
    getSlashCommands: () => agentSkillNames(),
    listChatAccounts: () => {
      const activeId = getPreferredId();
      return keyManager
        .getAllMeta()
        .filter((a) => isOpenAIProvider(a.provider) && a.status !== 'disabled')
        .sort((a, b) => a.label.localeCompare(b.label))
        .map((a) => ({ id: a.id, label: a.label, active: a.id === activeId }));
    },
    getApiChatModel: (accountId: string) => {
      const meta = resolveMeta(accountId);
      if (!meta || !isOpenAIProvider(meta.provider)) return null;
      return openAIModel(meta);
    },
    // La cuenta ES el modelo (viene del código pegado): el selector muestra
    // SOLO ese modelo, no el catálogo del proveedor (los demás ni funcionan
    // con la key — pedido explícito del usuario).
    getApiChatModels: (accountId: string) => {
      const meta = resolveMeta(accountId);
      if (!meta || !isOpenAIProvider(meta.provider)) return null;
      const model = openAIModel(meta);
      return model ? [{ id: model, label: model }] : [];
    },
    refreshApiChatModels: async (accountId: string) => {
      const meta = resolveMeta(accountId);
      if (!meta || !isOpenAIProvider(meta.provider)) return null;
      const model = openAIModel(meta);
      return model ? [{ id: model, label: model }] : [];
    },
    setApiChatModel: (accountId: string, model: string) => {
      const meta = resolveMeta(accountId);
      if (meta && model) setOaiModel(meta.id, model);
    },
    // Cada API key = un modelo → el dropdown lista todas, orden alfabético.
    listApiAccountModels: () =>
      keyManager
        .getAllMeta()
        .filter((a) => isOpenAIProvider(a.provider))
        .map((a) => ({ accountId: a.id, model: openAIModel(a) || a.label }))
        .sort((x, y) => x.model.localeCompare(y.model)),
    listNvidiaProfiles: () => Object.values(getNvidiaProfiles()),
    getAgentContext: () => ({
      defaultCwd: agentDefaultCwd,
      promptPermission: async (message: string) => {
        const pick = await vscode.window.showWarningMessage(
          message,
          { modal: true },
          'Permitir',
          'Permitir todo en este chat'
        );
        if (pick === 'Permitir') return 'allow' as const;
        if (pick === 'Permitir todo en este chat') return 'allowAll' as const;
        return 'deny' as const; // Cancelar / cerrar el diálogo = denegar
      },
      store: agentStore,
      directorModel: () =>
        vscode.workspace.getConfiguration('keyRotator').get<string>('agencyDirector', 'auto').trim() || 'auto',
      // Plantilla de la agencia: un modelo por API key utilizable.
      roster: async () => {
        // Se excluyen los marcados en 'error' por "Probar modelos": si un
        // modelo no responde (p.ej. gemma-4-31b-it en esta cuenta) no debe
        // entrar al equipo y menos aún ser elegido director.
        const metas = keyManager
          .getAllMeta()
          .filter((a) => isOpenAIProvider(a.provider) && a.status !== 'disabled' && a.status !== 'error');
        const out = [];
        for (const meta of metas) {
          const model = openAIModel(meta);
          const apiKey = await keyManager.getApiKey(meta.id);
          if (!model || !apiKey) continue;
          out.push({
            accountId: meta.id,
            model,
            apiKey,
            endpoint: openAIEndpoint(meta),
            provider: meta.provider,
            params: getOaiParams(meta.id),
          });
        }
        return out;
      },
      // Biblioteca propia primero; si está vacía, las skills de Claude.
      skillNames: () => agentSkillNames(),
      skillRoots: () => [krSkillsDir, claudeSkillsDir],
      mcpTools: () => getAgentMcpTools(),
    }),
  };

  const activeChatAccountLabel = (): string => {
    // Herramienta NVIDIA/OpenRouter: la etiqueta es el modelo activo (la
    // cuenta preferida, o la primera de la lista alfabética).
    const api = keyManager.getAllMeta().filter((a) => isOpenAIProvider(a.provider));
    if (api.length > 0) {
      const pref = getPreferredId();
      const meta = api.find((a) => a.id === pref) ?? [...api].sort((x, y) => x.label.localeCompare(y.label))[0];
      return openAIModel(meta) || meta.label;
    }
    return 'Sin modelos — pega tu código de NVIDIA Build';
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

    // 🗑 en cada chat del árbol. Solo borra chats del AGENTE (carpeta propia
    // en Documentos) — KeyRotator nunca toca el almacén de Claude Code.
    vscode.commands.registerCommand(
      'keyRotator.deleteChat',
      async (node?: { session?: { id: string; name: string } }) => {
        const s = node?.session;
        if (!s || !isAgentSessionId(s.id)) return;
        const pick = await vscode.window.showWarningMessage(`¿Borrar el chat "${s.name}"?`, { modal: true }, 'Borrar');
        if (pick !== 'Borrar') return;
        agentStore.delete(s.id);
        sessionsProvider.refresh();
      }
    ),

    // Configuración en UN pegado: lee el código de ejemplo de build.nvidia.com
    // (o OpenRouter) del portapapeles y saca endpoint + key + modelo + params.
    vscode.commands.registerCommand('keyRotator.pasteSnippet', async () => {
      let text = (await vscode.env.clipboard.readText()).trim();
      if (!snippetHasData(parseSnippet(text))) {
        text =
          (
            await vscode.window.showInputBox({
              title: 'Pegar código (NVIDIA Build / OpenRouter)',
              prompt: 'Pega el código de ejemplo (Python/JS) tal cual, o solo tu API key',
              placeHolder: 'from openai import OpenAI … base_url="https://integrate.api.nvidia.com/v1" …',
              ignoreFocusOut: true,
            })
          )?.trim() || '';
        if (!text) return;
      }
      await addAccountFromText(text);
    }),



    vscode.commands.registerCommand('keyRotator.testAccount', async (node?: { account?: AccountMeta }) => {
      // "Probar modelos": análisis de viabilidad real de cada API key.
      const all = keyManager.getAllMeta().filter((a) => isOpenAIProvider(a.provider));
      const targets = node?.account?.id ? all.filter((a) => a.id === node.account!.id) : all;
      if (targets.length === 0) {
        vscode.window.showInformationMessage('KeyRotator: no hay cuentas que probar.');
        return;
      }
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'KeyRotator: probando modelos…' },
        async (progress) => {
          for (const meta of targets) {
            progress.report({ message: meta.label });
            // Modelos de NVIDIA/OpenRouter: análisis de VIABILIDAD real
            // (consistencia, velocidad, soporte de herramientas) — no un
            // listado, /v1/models miente (lista modelos que dan 404 o cuelgan).
            if (isOpenAIProvider(meta.provider)) {
              const key = await keyManager.getApiKey(meta.id);
              const model = openAIModel(meta);
              if (!key || !model) {
                const detail = !key ? 'sin API key guardada' : 'sin modelo elegido';
                await keyManager.updateAccountMeta(meta.id, { status: 'error', lastError: detail });
                void vscode.window.showInformationMessage(`⛔ ${meta.label}: ${detail}`);
                continue;
              }
              const report = await analyzeViability(openAIEndpoint(meta), key, model);
              const icon = report.verdict === 'recomendado' ? '✅' : report.verdict === 'usable' ? '⚠️' : '⛔';
              const summary = report.reasons.join(' · ');
              await keyManager.updateAccountMeta(meta.id, {
                status: report.verdict === 'no-viable' ? 'error' : 'active',
                lastError: report.verdict === 'no-viable' ? summary : undefined,
              });
              void vscode.window.showInformationMessage(`${icon} ${meta.label} — ${report.verdict}: ${summary}`);
              continue;
            }
          }
          refreshUI();
          ChatPanel.refreshIfOpen();
        }
      );
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

  // --- registry refresh ---------------------------------------------------

  void registry.refreshFromRemote();

  refreshUI();

  // Warm the scan cache in the background shortly after startup so any
  // sessions changed while VS Code was closed get re-scanned and persisted.
  setTimeout(() => {
    persistScanCache();
    sessionsProvider.refresh();
  }, 1500);
}

export function deactivate() {}
