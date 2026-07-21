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
import type { WebChatRunner, WebCaps } from './webChatRunner.js';
import { streamOpenAIChat, type OAIMessage } from './openaiChat.js';
import { runAgentTurn, type ContentPart } from '../agent/agentLoop.js';
import { AGENT_TOOLS, toolsFor, executeTool, agentSystemPrompt, readSkill } from '../agent/tools.js';
import {
  webSearch,
  fetchUrl,
  generateImage,
  deepResearch,
  imageToDataUrl,
  isImageFile,
  suggestModels,
} from '../agent/aiTools.js';
import {
  pickDirector,
  extractJson,
  normalizePlan,
  resolveNames,
  teamFromPlan,
  routeToMember,
  routerPrompt,
  specialistPrompt,
  evaluationPrompt,
  parseVerdict,
  cvPrompt,
  parseCv,
  handoffBrief,
  findNewcomer,
  saysModelReady,
  looksLikeComplaint,
  directorResearchPrompt,
  directorSynthesisPrompt,
  type AgencyModel,
  type AgencyTeamMember,
} from '../agent/agency.js';
import { PermissionGate, type PermAnswer, type PermCategory } from '../agent/permissions.js';
import { newAgentSession, isAgentSessionId, type AgentSession, type AgentStore } from '../agent/agentStore.js';

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
  /**
   * OpenAI-compatible API account (OpenRouter, …): the turn is a streaming
   * `/chat/completions` call instead of the `claude` CLI.
   */
  openai?: { apiKey: string; endpoint: string; model: string; provider: string; params?: Record<string, number> };
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
  /** Static web caps (models+toggles) for an account, or null if not web. */
  getWebCapsFor?(accountId: string): WebCaps | null;
  /** Display name for a web account's provider (e.g. 'DeepSeek'), or null. */
  getWebProviderName?(accountId: string): string | null;
  /** Current model string for an OpenAI-compatible (OpenRouter) account, or null. */
  getApiChatModel?(accountId: string): string | null;
  /** Cached model catalog (free + DeepSeek) for an OpenAI account, or null. */
  getApiChatModels?(accountId: string): { id: string; label: string }[] | null;
  /** Refresh that catalog from the provider (background), or null if N/A. */
  refreshApiChatModels?(accountId: string): Promise<{ id: string; label: string }[] | null>;
  /** Persist the chosen model for an OpenAI account (from the chat dropdown). */
  setApiChatModel?(accountId: string, model: string): void;
  /**
   * Every OpenAI-compatible account as a {model→account} pair, alphabetical.
   * Each API key IS one model, so the chat's model dropdown lists these and
   * choosing one switches to that account. Empty for non-agent setups.
   */
  listApiAccountModels?(): { accountId: string; model: string }[];
  /** Agent support (NVIDIA Build / OpenRouter): permissions UI + own store. */
  getAgentContext?(): AgentBackendContext;
}

/** A user MCP tool exposed to the agent (namespaced `mcp__<server>__<tool>`). */
export interface AgentMcpTool {
  /** OpenAI function-tool definition (name already namespaced). */
  def: unknown;
  /** Runs it: server + original tool name resolved by the host. */
  call(argsJson: string): Promise<string>;
}

/** What the agent path needs from the extension host. */
export interface AgentBackendContext {
  /** Default working folder (Documents\KeyRotator). */
  defaultCwd(): string;
  /** Modal permission prompt → allow / allowAll / deny (undefined = deny). */
  promptPermission(message: string, category: PermCategory): Promise<PermAnswer | undefined>;
  /** The agent's own session store (separate from the Claude store). */
  store: AgentStore;
  /** Every usable model (one per API key) — the agency's roster. */
  roster(): Promise<AgencyModel[]>;
  /** Model id chosen to direct the agency, or 'auto' / undefined. */
  directorModel?(): string | undefined;
  /** Names of the available skills, for the system prompt. */
  skillNames(): string[];
  /** Directories to resolve a skill's markdown from (most specific first). */
  skillRoots(): string[];
  /** The user's linked MCP tools (from ~/.claude.json / config), namespaced. */
  mcpTools(): Promise<AgentMcpTool[]>;
}

/** Providers served by the AGENT loop (tools) instead of the plain chat. */
const AGENT_PROVIDERS = new Set(['nvidia', 'openrouter']);

/** Human-readable "what it's doing" line for a tool call (pure, tested). */
export function describeTool(name: string, argsJson: string): string {
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(argsJson || '{}');
  } catch {
    /* sin argumentos legibles */
  }
  const short = (v: unknown, n = 60) => {
    const s = String(v ?? '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  };
  switch (name) {
    case 'web_search':
      return `Buscando en internet: "${short(a.query)}"`;
    case 'fetch_url':
      return `Leyendo ${short(a.url, 70)}`;
    case 'deep_research':
      return `Investigando a fondo: "${short(a.topic)}"`;
    case 'read_file':
      return `Leyendo el archivo ${short(a.path, 70)}`;
    case 'list_directory':
      return `Explorando la carpeta ${short(a.path ?? '.', 70)}`;
    case 'write_file':
      return `Escribiendo ${short(a.path, 70)}`;
    case 'delete_file':
      return `Borrando ${short(a.path, 70)}`;
    case 'run_command':
      return `Ejecutando: ${short(a.command, 70)}`;
    case 'set_working_folder':
      return `Cambiando la carpeta de trabajo a ${short(a.path, 70)}`;
    case 'generate_image':
      return `Generando una imagen: "${short(a.prompt)}"`;
    case 'use_skill':
      return `Cargando la skill "${short(a.name, 40)}"`;
    case 'search_chats':
      return `Recordando conversaciones sobre "${short(a.query, 40)}"`;
    case 'read_chat':
      return 'Releyendo una conversación anterior';
    default:
      return name.startsWith('mcp__') ? `Usando la integración ${name.split('__')[1] ?? name}` : `Usando ${name}`;
  }
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
  /**
   * Live "what am I doing right now" line (investigando, leyendo X, …). It
   * REPLACES the previous status instead of stacking notices, so the user
   * always sees the current activity and never a frozen empty bubble.
   * Empty string clears it.
   */
  onStatus?(text: string): void;
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
  /** Web-chat selection (DeepSeek model + feature toggles), per panel. */
  private webModel: string | null = null;
  private webToggles: Record<string, boolean> = {};
  /** In-memory history for OpenAI-compatible (OpenRouter) turns, per panel. */
  private oaiMessages: OAIMessage[] = [];
  /** Agent conversation (NVIDIA/OpenRouter with tools), per panel. */
  private agentSession: AgentSession | null = null;
  /** Permission grants ("allow all") live per conversation. */
  private agentGate: PermissionGate | null = null;
  /** Aborts the in-flight turn (the chat's "Detener" button). */
  private abort: AbortController | null = null;
  /** 'agency' = a director model plans and runs the others in parallel. */
  private mode: 'individual' | 'agency' = 'individual';
  /** Live-status bookkeeping for agency calls whose text isn't streamed out. */
  private agencyChars = 0;
  private lastStatusAt = 0;
  /**
   * Deep-research switch (bottom bar). OFF by default: without it even a
   * "hola" triggered web searches, so the tool is removed and the prompt tells
   * the model to answer directly.
   */
  private research = false;

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

  /** Set the web-chat model (DeepSeek: default|expert|vision) for next turns. */
  setWebModel(model: string | null): void {
    this.webModel = model && model.length > 0 ? model : null;
  }

  /** Set one web feature toggle (DeepSeek: deepthink|search) on/off. */
  setWebToggle(id: string, on: boolean): void {
    this.webToggles = { ...this.webToggles, [id]: on };
  }

  /** Resolve the active account and, if it's a web account, its capabilities. */
  async resolveWebCaps(): Promise<{ accountId: string; caps: WebCaps } | null> {
    const account = await this.backend.resolveActiveAccount(this.accountOverride);
    if (!account?.web) return null;
    const runner = this.backend.getWebRunner?.(account.id, account.web.provider, account.web.profileDir);
    if (!runner) return null;
    return { accountId: account.id, caps: await runner.getCaps() };
  }

  get currentSessionId(): string | null {
    return this.agentSession?.id ?? this.sessionId;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** Stop the in-flight turn (button "Detener"). Tools already run stay done. */
  stop(): void {
    this.abort?.abort();
  }

  /** Individual (one model) vs agency (a director orchestrates all of them). */
  setMode(mode: 'individual' | 'agency'): void {
    this.mode = mode;
  }

  /** Turn deep research on/off for the next turns (bottom-bar switch). */
  setResearch(on: boolean): void {
    this.research = on;
  }

  get currentMode(): 'individual' | 'agency' {
    return this.mode;
  }

  /** Reset so the next message starts a brand-new claude session. */
  reset(): void {
    this.sessionId = null;
    this.sessionCwd = null;
    this.oaiMessages = [];
    this.agentSession = null;
    this.agentGate = null;
  }

  /**
   * Point the chat at an existing Claude session (from the shared store) so the
   * next message continues it via `--resume`, running in its original cwd so
   * the transcript stays in the same project file the native app reads.
   * Agent sessions (`agent-*`) load from the agent's own store instead.
   */
  setActiveSession(id: string | null, cwd?: string | null): void {
    if (id && isAgentSessionId(id)) {
      this.agentSession = this.backend.getAgentContext?.().store.load(id) ?? null;
      this.agentGate = null; // resumed conversation asks permissions afresh
      this.sessionId = null;
      this.sessionCwd = null;
      return;
    }
    this.agentSession = null;
    this.agentGate = null;
    this.sessionId = id;
    this.sessionCwd = cwd && cwd.length > 0 ? cwd : null;
  }

  async sendMessage(text: string, handlers: TurnHandlers, attachments?: string[]): Promise<void> {
    if (this.busy) {
      handlers.onError('Espera a que termine la respuesta anterior.');
      return;
    }
    this.busy = true;
    this.abort = new AbortController();
    try {
      let account = await this.backend.resolveActiveAccount(this.accountOverride);
      if (!account) {
        handlers.onError(
          'Todavía no tienes ningún modelo. Pega el código de ejemplo de build.nvidia.com (u OpenRouter) con el botón 📋 de la vista API Keys, o "＋ Agregar modelo" en el menú del chat.'
        );
        return;
      }

      // Web-chat accounts (DeepSeek, …) are served by the browser daemon, not
      // the claude CLI — handle them on a separate path (no failover/sessions).
      if (account.web) {
        await this.runWebTurn(text, account, handlers, attachments);
        return;
      }

      // NVIDIA Build / OpenRouter → the file/command AGENT loop (tools).
      if (account.openai && AGENT_PROVIDERS.has(account.openai.provider)) {
        if (this.mode === 'agency') await this.runAgencyTurn(text, account, handlers, attachments);
        else await this.runAgentTurnFor(text, account, handlers, attachments);
        return;
      }

      // Other OpenAI-compatible accounts → plain streaming /chat/completions.
      if (account.openai) {
        await this.runOpenAITurn(text, account, handlers);
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
      this.abort = null;
    }
  }

  /**
   * Providers with a known hard per-account rpm cap get client-side throttled
   * so a burst of turns waits for a slot instead of tripping a 429 at all.
   * NVIDIA Build's free tier is 40 rpm; stay a few under it as margin.
   */
  private static readonly RPM_CAPS: Record<string, number> = { nvidia: 35 };

  /**
   * MODO AGENCIA: el director (mejor modelo disponible) planifica qué modelo
   * hace cada parte, los trabajadores corren EN PARALELO con todas las
   * herramientas, y el director sintetiza la entrega final.
   */
  private async runAgencyTurn(
    text: string,
    account: ActiveAccount,
    handlers: TurnHandlers,
    attachments?: string[]
  ): Promise<void> {
    const ctx = this.backend.getAgentContext?.();
    if (!ctx) {
      handlers.onError('El agente no está disponible en este entorno.');
      return;
    }
    const roster = await ctx.roster();
    if (roster.length === 0) {
      handlers.onError('No hay modelos configurados. Pega el código de build.nvidia.com para agregar al menos uno.');
      return;
    }
    if (!this.agentSession) {
      this.agentSession = newAgentSession(account.id, roster[0].provider, 'agencia', ctx.defaultCwd());
    }
    if (!this.agentGate) this.agentGate = new PermissionGate((m, c) => ctx.promptPermission(m, c));
    const s = this.agentSession;
    const gate = this.agentGate;
    s.messages.push({ role: 'user', content: text });

    const director = pickDirector(roster, ctx.directorModel?.())!;
    handlers.onModel(`agencia · director ${director.model}`);
    handlers.onInfo(`🏢 Modo agencia — director: ${director.model} · modelos disponibles: ${roster.length}`);

    // Llamada interna de la agencia: su texto no se transmite, pero SÍ hay que
    // reportar actividad o el chat parece congelado (el usuario no ve nada).
    const runOne = (m: AgencyModel, prompt: string, sys: string, who = m.model) =>
      runAgentTurn({
        endpoint: m.endpoint,
        apiKey: m.apiKey,
        model: m.model,
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: prompt },
        ],
        tools: this.agencyTools(),
        execute: (n, a) => this.agencyExecute(n, a, s, gate, m, ctx),
        onDelta: (t) => {
          this.agencyChars += t.length;
          const now = Date.now();
          if (now - this.lastStatusAt > 400) {
            this.lastStatusAt = now;
            handlers.onStatus?.(`${who} está deliberando… (${this.agencyChars.toLocaleString('es-DO')} caracteres)`);
          }
        },
        onToolStart: (n, a) => {
          this.agencyChars = 0;
          handlers.onStatus?.(`${who}: ${describeTool(n, a)}`);
          handlers.onInfo(`   🔧 ${who}: ${describeTool(n, a)}`);
        },
        onRetry: (info) => {
          handlers.onStatus?.(`${who}: ${info}`);
          handlers.onInfo(`   ⏳ ${who}: ${info}`);
        },
        onReasoning: (chars) => {
          const now = Date.now();
          if (now - this.lastStatusAt > 400) {
            this.lastStatusAt = now;
            handlers.onStatus?.(`${who} está razonando… (${chars.toLocaleString('es-DO')} caracteres)`);
          }
        },
        onToolDone: (n, chars) =>
          handlers.onStatus?.(`${who} procesa lo que devolvió ${n} (${chars.toLocaleString('es-DO')} caracteres)`),
        maxPerMinute: ChatSession.RPM_CAPS[m.provider],
        throttleKey: ChatSession.RPM_CAPS[m.provider] ? `${m.provider}:${m.accountId}` : undefined,
        params: m.params,
        signal: this.abort?.signal,
        maxSteps: 15,
      });

    // Si el equipo YA existe, este mensaje va al responsable del área: sale
    // él, se presenta, diagnostica y corrige. Sin rehacer la investigación.
    if (s.team && s.team.length > 0) {
      await this.runSpecialistTurn(text, s, gate, roster, director, handlers, ctx, runOne);
      return;
    }

    // 1) INVESTIGAR + FORMAR EL EQUIPO (el director usa la web de verdad y
    //    valida modelo por modelo, con la fecha de cada evidencia).
    handlers.onInfo('🔎 Etapa 1 — investigando qué modelo rinde mejor en cada parte (con evidencia reciente)…');
    handlers.onStatus?.(`Etapa 1: ${director.model} investiga al equipo`);
    const today = new Date().toLocaleDateString('es-DO', { year: 'numeric', month: 'long', day: 'numeric' });
    const planRes = await runOne(
      director,
      directorResearchPrompt(text, roster, today),
      `${agentSystemPrompt(s.cwd, ctx.skillNames())}\n\nEres el director de la agencia. Investiga con tus herramientas ANTES de decidir y termina respondiendo SOLO el JSON pedido, sin texto alrededor.`
    );
    if (this.abort?.signal.aborted) {
      handlers.onInfo('⏹ Detenido por ti.');
      handlers.onDone('');
      return;
    }
    if ('error' in planRes) {
      // El director se cayó (504 del gateway, timeout…). En vez de dejar al
      // usuario sin nada, se atiende la tarea en modo individual.
      handlers.onInfo(
        `⚠ El director (${director.model}) no pudo completar la planificación: ${planRes.error}. Sigo con un solo modelo para no dejarte sin respuesta.`
      );
      await this.runAgentTurnFor(text, account, handlers, attachments);
      return;
    }
    const plan = normalizePlan(extractJson(planRes.text), roster);
    if (!plan) {
      // El director no dio un plan usable → que trabaje él solo, sin fallar.
      handlers.onInfo('⚠ El director no devolvió un plan válido; ejecuto la tarea con él directamente.');
      await this.runAgentTurnFor(text, account, handlers, attachments);
      return;
    }
    if (plan.strategy) handlers.onInfo(`🧭 Estrategia: ${plan.strategy}`);
    // El equipo queda FIJO para esta conversación: cada quien con su área.
    s.team = teamFromPlan(plan);
    handlers.onInfo(
      `👥 Equipo de la agencia (permanente en este chat):\n${s.team
        .map((t) => `   • ${t.role} → ${t.model}\n     responsable de: ${t.scope}${t.evidence ? `\n     porque: ${t.evidence}` : ''}`)
        .join('\n')}`
    );

    // 2) PREPARAR EL ENTORNO: cargar las skills que el director pidió y avisar
    //    qué MCP hay disponibles, para que los trabajadores lleguen listos.
    let envBrief = '';
    const skillsWanted = resolveNames(plan.skills, ctx.skillNames());
    if (skillsWanted.length > 0) {
      handlers.onInfo(`🧰 Etapa 2 — preparando el entorno: cargando skills ${skillsWanted.join(', ')}`);
      const loaded = skillsWanted
        .map((n) => {
          const body = readSkill(n, ctx.skillRoots());
          return body.startsWith('ERROR') ? null : `### SKILL: ${n}\n${body.slice(0, 6000)}`;
        })
        .filter(Boolean);
      if (loaded.length) envBrief += `\n\nMETODOLOGÍAS OBLIGATORIAS PARA ESTE TRABAJO:\n${loaded.join('\n\n')}`;
    }
    let mcpNames: string[] = [];
    try {
      mcpNames = (await ctx.mcpTools()).map((t) => (t.def as { function: { name: string } }).function.name);
    } catch {
      mcpNames = [];
    }
    if (mcpNames.length) {
      handlers.onInfo(`🔌 Integraciones MCP disponibles para el equipo: ${mcpNames.length}`);
    }
    // Recomendaciones de modelos que el usuario NO tiene (nunca se instalan solas).
    if (plan.recommendations && plan.recommendations.length > 0) {
      handlers.onInfo(
        '💡 El director recomienda añadir estos modelos de build.nvidia.com (pega su código en KeyRotator y avísame en el chat para usarlos):\n' +
          plan.recommendations.map((r) => `   • ${r.model} — ${r.reason}`).join('\n')
      );
    }

    // 3) TRABAJAR EN PARALELO
    handlers.onStatus?.(`Etapa 3: ${plan.assignments.length} especialista(s) trabajando en paralelo`);
    const workerSys = (role: string) =>
      `${agentSystemPrompt(s.cwd, ctx.skillNames())}\n\nTrabajas como "${role}" dentro de una agencia. Haz TU parte completa y entrega el resultado final de tu parte, listo para integrarse. No preguntes nada: si falta un dato, decídelo con tu mejor criterio y sigue.${envBrief}`;
    const started = Date.now();
    const outputs = await Promise.all(
      plan.assignments.map(async (a) => {
        const m = roster.find((r) => r.model === a.model)!;
        const r = await runOne(m, a.task, workerSys(a.role));
        const output = 'error' in r ? `(falló: ${r.error})` : r.text;
        handlers.onInfo(`   ✅ ${a.role} (${a.model}) entregó ${output.length} caracteres`);
        // Cada miembro recuerda lo que entregó: así puede responder por su área.
        const member = s.team?.find((t) => t.role === a.role);
        if (member && !output.startsWith('(falló:')) member.lastWork = output.slice(0, 8000);
        return { role: a.role, model: a.model, output };
      })
    );
    if (this.abort?.signal.aborted) {
      handlers.onInfo('⏹ Detenido por ti.');
      handlers.onDone('');
      return;
    }
    const usable = outputs.filter((o) => !o.output.startsWith('(falló:'));
    if (usable.length === 0) {
      handlers.onError(`Ningún especialista pudo completar su parte:\n${outputs.map((o) => `• ${o.model}: ${o.output}`).join('\n')}`);
      return;
    }
    handlers.onInfo(`⏱ Trabajo en paralelo terminado en ${Math.round((Date.now() - started) / 1000)}s. Integrando…`);
    handlers.onStatus?.(`Etapa 4: ${director.model} integra las entregas`);

    // 4) SINTETIZAR (esta sí se transmite al usuario)
    const finalRes = await runAgentTurn({
      endpoint: director.endpoint,
      apiKey: director.apiKey,
      model: director.model,
      messages: [
        { role: 'system', content: agentSystemPrompt(s.cwd, ctx.skillNames()) },
        { role: 'user', content: directorSynthesisPrompt(text, usable) },
      ],
      tools: this.agencyTools(),
      execute: (n, a) => this.agencyExecute(n, a, s, gate, director, ctx),
      onDelta: (t) => handlers.onDelta(t),
      onToolStart: (n, a) => {
        handlers.onStatus?.(`Director: ${describeTool(n, a)}`);
        handlers.onInfo(`🔧 director: ${describeTool(n, a)}`);
      },
      onRetry: (info) => {
        handlers.onStatus?.(`Director: ${info}`);
        handlers.onInfo(`⏳ ${info}`);
      },
      maxPerMinute: ChatSession.RPM_CAPS[director.provider],
      throttleKey: ChatSession.RPM_CAPS[director.provider] ? `${director.provider}:${director.accountId}` : undefined,
      params: director.params,
      signal: this.abort?.signal,
    });
    const finalText = 'error' in finalRes ? '' : finalRes.text;
    s.messages.push({ role: 'assistant', content: finalText || '(sin síntesis)' });
    try {
      ctx.store.save(s);
    } catch {
      // best-effort
    }
    if ('error' in finalRes) {
      handlers.onError(`El director falló al integrar: ${finalRes.error}`);
      return;
    }
    handlers.onDone(finalText);
  }

  /**
   * Seguimiento con el equipo ya formado: el director decide de quién es el
   * asunto, y ESE especialista sale a hablar en primera persona, diagnostica
   * y corrige su parte. Si el asunto es de todos, responde el director.
   */
  private async runSpecialistTurn(
    text: string,
    s: AgentSession,
    gate: PermissionGate,
    roster: AgencyModel[],
    director: AgencyModel,
    handlers: TurnHandlers,
    ctx: AgentBackendContext,
    runOne: (m: AgencyModel, prompt: string, sys: string) => Promise<{ text: string } | { error: string }>
  ): Promise<void> {
    const team = s.team!;
    handlers.onInfo(`🏢 Equipo activo: ${team.map((t) => `${t.role} (${t.model})`).join(' · ')}`);
    handlers.onStatus?.('El director decide quién atiende esto');

    // 0) ¿Hay una vacante y el usuario dice que ya integró el modelo? Entonces
    //    el recién llegado toma el puesto y continúa el trabajo del anterior.
    if (s.vacancy && saysModelReady(text)) {
      const newcomer = findNewcomer(roster, team, s.vacancy.candidate);
      if (!newcomer) {
        handlers.onInfo(
          `⚠ Todavía no veo un modelo nuevo en tus API keys. Pega el código de "${s.vacancy.candidate}" en KeyRotator y vuelve a avisarme.`
        );
      } else {
        const v = s.vacancy;
        const member: AgencyTeamMember = {
          role: v.role,
          model: newcomer.model,
          scope: v.scope,
          evidence: `Contratado el ${new Date().toLocaleDateString('es-DO')}: ${v.reason}`,
          handoff: v.handoff,
        };
        const idx = team.findIndex((t) => t.role === v.role);
        if (idx >= 0) {
          member.predecessors = [
            ...(team[idx].predecessors ?? []),
            { model: team[idx].model, reason: v.reason },
          ];
          team[idx] = member;
        } else {
          team.push(member);
        }
        s.vacancy = null;
        handlers.onInfo(`🤝 ${newcomer.model} se incorpora como ${v.role} y continúa el trabajo pendiente.`);
        const model = newcomer;
        handlers.onModel(`${member.role} · ${member.model}`);
        const res = await runAgentTurn({
          endpoint: model.endpoint,
          apiKey: model.apiKey,
          model: model.model,
          messages: [
            {
              role: 'system',
              content: `${specialistPrompt(member, agentSystemPrompt(s.cwd, ctx.skillNames()))}\n\n${v.handoff ?? ''}`,
            },
            { role: 'user', content: text },
          ],
          tools: this.agencyTools(),
          execute: (n, a) => this.agencyExecute(n, a, s, gate, model, ctx),
          onDelta: (t) => handlers.onDelta(t),
          onToolStart: (n, a) => {
            handlers.onStatus?.(`${member.role}: ${describeTool(n, a)}`);
            handlers.onInfo(`   🔧 ${member.role}: ${describeTool(n, a)}`);
          },
          onRetry: (info) => {
            handlers.onStatus?.(`${member.role}: ${info}`);
            handlers.onInfo(`   ⏳ ${info}`);
          },
          maxPerMinute: ChatSession.RPM_CAPS[model.provider],
          throttleKey: ChatSession.RPM_CAPS[model.provider] ? `${model.provider}:${model.accountId}` : undefined,
          params: model.params,
          signal: this.abort?.signal,
        });
        if (!('error' in res) && res.text) member.lastWork = res.text.slice(0, 8000);
        this.finishAgencyTurn(s, ctx, res, handlers, member.role);
        return;
      }
    }

    // 1) ¿De quién es esto? (llamada corta al director; si falla, heurística)
    let owner: AgencyTeamMember | null = null;
    const routed = await runOne(
      director,
      routerPrompt(text, team),
      'Eres el director de la agencia. Respondes SOLO con el nombre del rol responsable, o TODOS.'
    );
    const reply = 'error' in routed ? '' : routed.text;
    if (!/todos/i.test(reply)) owner = routeToMember(reply, team, text);

    // 2) Habla el responsable (o el director si es transversal).
    const base = agentSystemPrompt(s.cwd, ctx.skillNames());
    if (!owner) {
      handlers.onInfo('🧭 Asunto general: responde el director.');
      const m = director;
      const res = await runAgentTurn({
        endpoint: m.endpoint,
        apiKey: m.apiKey,
        model: m.model,
        messages: [
          {
            role: 'system',
            content: `${base}\n\nEres el DIRECTOR de la agencia. Tu equipo: ${team
              .map((t) => `${t.role} (${t.model}) → ${t.scope}`)
              .join('; ')}. Atiende el mensaje del usuario tú mismo, o coordina lo necesario. Habla en primera persona como director.`,
          },
          { role: 'user', content: text },
        ],
        tools: this.agencyTools(),
        execute: (n, a) => this.agencyExecute(n, a, s, gate, m, ctx),
        onDelta: (t) => handlers.onDelta(t),
        onToolStart: (n, a) => {
        handlers.onStatus?.(`Director: ${describeTool(n, a)}`);
        handlers.onInfo(`🔧 director: ${describeTool(n, a)}`);
      },
      onRetry: (info) => {
        handlers.onStatus?.(`Director: ${info}`);
        handlers.onInfo(`⏳ ${info}`);
      },
        maxPerMinute: ChatSession.RPM_CAPS[m.provider],
        throttleKey: ChatSession.RPM_CAPS[m.provider] ? `${m.provider}:${m.accountId}` : undefined,
        params: m.params,
        signal: this.abort?.signal,
      });
      this.finishAgencyTurn(s, ctx, res, handlers, 'director');
      return;
    }

    // 2b) ¿Este responsable ya venía fallando? El director lo evalúa antes de
    //     dejarlo intentar otra vez: puede mantenerlo, reemplazarlo por otro
    //     modelo del equipo, o buscar un candidato que el usuario no tiene.
    owner.strikes = (owner.strikes ?? 0) + (looksLikeComplaint(text) ? 1 : 0);
    if ((owner.strikes ?? 0) >= 2) {
      handlers.onInfo(`⚖ El director evalúa a ${owner.role} (${owner.model}) tras ${owner.strikes} señalamientos…`);
      handlers.onStatus?.(`El director evalúa el desempeño de ${owner.role}`);
      const verdictRes = await runOne(
        director,
        evaluationPrompt(owner, text, roster),
        `${agentSystemPrompt(s.cwd, ctx.skillNames())}\n\nEres el director. Investiga si hace falta y responde SOLO la línea del veredicto.`
      );
      const verdict = 'error' in verdictRes ? { action: 'keep' as const } : parseVerdict(verdictRes.text, roster, owner.model);

      if (verdict.action === 'replace') {
        const prev = { ...owner };
        handlers.onInfo(`🔁 Relevo: ${prev.model} deja el puesto de ${owner.role}. Entra ${verdict.model}.\n   Motivo: ${verdict.reason}`);
        owner.predecessors = [...(prev.predecessors ?? []), { model: prev.model, reason: verdict.reason }];
        owner.model = verdict.model;
        owner.handoff = handoffBrief(prev, verdict.reason);
        owner.strikes = 0;
        owner.evidence = `Relevo del ${new Date().toLocaleDateString('es-DO')}: ${verdict.reason}`;
      } else if (verdict.action === 'hire') {
        handlers.onInfo('🔎 Ninguno de tus modelos da la talla para esto. Buscando candidato en NVIDIA Build…');
        handlers.onStatus?.('Buscando un candidato en NVIDIA Build');
        const today = new Date().toLocaleDateString('es-DO', { year: 'numeric', month: 'long', day: 'numeric' });
        const cvRes = await runOne(
          director,
          cvPrompt(owner.role, owner.scope, verdict.reason, roster, today),
          `${agentSystemPrompt(s.cwd, ctx.skillNames())}\n\nEres el director buscando personal. Investiga de verdad y responde en el formato pedido.`
        );
        const cv = 'error' in cvRes ? null : parseCv(cvRes.text);
        if (cv) {
          s.vacancy = {
            role: owner.role,
            scope: owner.scope,
            reason: verdict.reason,
            cv: cv.cv,
            candidate: cv.candidate,
            handoff: handoffBrief(owner, verdict.reason),
          };
          try {
            ctx.store.save(s);
          } catch {
            /* best-effort */
          }
          handlers.onDone(
            [
              `**Vacante abierta: ${owner.role}**`,
              '',
              `${owner.model} no está dando la talla para *${owner.scope}*. Motivo: ${verdict.reason}`,
              '',
              `### Candidato propuesto: \`${cv.candidate}\``,
              cv.cv,
              '',
              `👉 Si te parece, agrégalo en KeyRotator (pega su código de build.nvidia.com) y dime **"ya lo integré"** — tomará el puesto y continuará el trabajo desde donde quedó.`,
            ].join('\n')
          );
          return;
        }
        handlers.onInfo('⚠ No pude armar el currículum del candidato; sigo con el responsable actual.');
      }
    }

    const model = roster.find((r) => r.model === owner!.model) ?? director;
    handlers.onModel(`${owner.role} · ${owner.model}`);
    handlers.onInfo(`🙋 Sale el responsable: ${owner.role} (${owner.model}) — a cargo de ${owner.scope}`);
    const res = await runAgentTurn({
      endpoint: model.endpoint,
      apiKey: model.apiKey,
      model: model.model,
      messages: [
        { role: 'system', content: specialistPrompt(owner, base) },
        { role: 'user', content: text },
      ],
      tools: this.agencyTools(),
      execute: (n, a) => this.agencyExecute(n, a, s, gate, model, ctx),
      onDelta: (t) => handlers.onDelta(t),
      onToolStart: (n, a) => {
        handlers.onStatus?.(`${owner!.role}: ${describeTool(n, a)}`);
        handlers.onInfo(`   🔧 ${owner!.role}: ${describeTool(n, a)}`);
      },
      onRetry: (info) => {
        handlers.onStatus?.(`${owner!.role}: ${info}`);
        handlers.onInfo(`   ⏳ ${info}`);
      },
      maxPerMinute: ChatSession.RPM_CAPS[model.provider],
      throttleKey: ChatSession.RPM_CAPS[model.provider] ? `${model.provider}:${model.accountId}` : undefined,
      params: model.params,
      signal: this.abort?.signal,
    });
    if (!('error' in res) && res.text) owner.lastWork = res.text.slice(0, 8000);
    this.finishAgencyTurn(s, ctx, res, handlers, owner.role);
  }

  /** Persist + report the end of an agency turn. */
  private finishAgencyTurn(
    s: AgentSession,
    ctx: AgentBackendContext,
    res: { text: string } | { error: string },
    handlers: TurnHandlers,
    who: string
  ): void {
    const finalText = 'error' in res ? '' : res.text;
    if (finalText) s.messages.push({ role: 'assistant', content: finalText });
    try {
      ctx.store.save(s);
    } catch {
      // best-effort
    }
    if ('error' in res) {
      if (this.abort?.signal.aborted) {
        handlers.onInfo('⏹ Detenido por ti.');
        handlers.onDone('');
        return;
      }
      handlers.onError(`${who} falló: ${res.error}`);
      return;
    }
    handlers.onDone(finalText);
  }

  /** Tool set for agency workers (same built-ins; MCP stays in individual mode). */
  private agencyTools(): unknown[] {
    // La agencia investiga por diseño: su director necesita deep_research.
    return AGENT_TOOLS;
  }

  /** Tool execution for an agency worker, bound to its own account/key. */
  private agencyExecute(
    name: string,
    args: string,
    s: AgentSession,
    gate: PermissionGate,
    m: AgencyModel,
    ctx: AgentBackendContext
  ): Promise<string> {
    if (name === 'search_chats') {
      try {
        return Promise.resolve(ctx.store.search(String(JSON.parse(args || '{}').query ?? '')));
      } catch {
        return Promise.resolve('ERROR: query inválida.');
      }
    }
    if (name === 'read_chat') {
      try {
        return Promise.resolve(ctx.store.transcript(String(JSON.parse(args || '{}').id ?? '')));
      } catch {
        return Promise.resolve('ERROR: id inválido.');
      }
    }
    if (name === 'use_skill') {
      try {
        return Promise.resolve(readSkill(String(JSON.parse(args || '{}').name ?? ''), ctx.skillRoots()));
      } catch {
        return Promise.resolve('ERROR: nombre de skill inválido.');
      }
    }
    if (name === 'web_search' || name === 'fetch_url' || name === 'generate_image' || name === 'deep_research') {
      let a: Record<string, unknown> = {};
      try {
        a = JSON.parse(args || '{}');
      } catch {
        return Promise.resolve('ERROR: argumentos inválidos.');
      }
      if (name === 'web_search') return webSearch(String(a.query ?? ''), 12, a.recency ? String(a.recency) : undefined);
      if (name === 'fetch_url') return fetchUrl(String(a.url ?? ''));
      if (name === 'deep_research')
        return deepResearch(
          String(a.topic ?? ''),
          a.depth ? String(a.depth) : undefined,
          a.recency ? String(a.recency) : undefined
        );
      return generateImage(
        { getCwd: () => s.cwd, apiKey: m.apiKey, endpoint: m.endpoint, provider: m.provider },
        String(a.prompt ?? ''),
        a.model ? String(a.model) : undefined
      );
    }
    return executeTool(name, args, { getCwd: () => s.cwd, setCwd: (d) => (s.cwd = d), gate });
  }

  /** Serve a turn of the file/command agent (NVIDIA Build / OpenRouter). */
  private async runAgentTurnFor(
    text: string,
    account: ActiveAccount,
    handlers: TurnHandlers,
    attachments?: string[]
  ): Promise<void> {
    const ctx = this.backend.getAgentContext?.();
    if (!ctx) {
      handlers.onError('El agente no está disponible en este entorno.');
      return;
    }
    const oai = account.openai!;
    if (!oai.model) {
      handlers.onError(
        'Elige primero un modelo en el selector de abajo (la lista se carga desde la API de tu cuenta). Sin modelo elegido, el agente no envía nada.'
      );
      return;
    }
    if (!this.agentSession) {
      this.agentSession = newAgentSession(account.id, oai.provider, oai.model, ctx.defaultCwd());
    }
    if (!this.agentGate) {
      this.agentGate = new PermissionGate((msg, cat) => ctx.promptPermission(msg, cat));
    }
    const s = this.agentSession;
    const gate = this.agentGate;
    s.model = oai.model;
    if (s.messages.length === 0) {
      s.messages.push({ role: 'system', content: agentSystemPrompt(s.cwd, ctx.skillNames(), this.research) });
    }
    // Visión: las imágenes adjuntas viajan como partes image_url (data URL);
    // los demás adjuntos se mencionan por ruta para que el agente los lea.
    const images = (attachments ?? []).filter(isImageFile);
    const others = (attachments ?? []).filter((a) => !isImageFile(a));
    const userText = others.length ? `${text}\n\nArchivos adjuntos: ${others.join(', ')}` : text;
    if (images.length > 0) {
      const parts: ContentPart[] = [{ type: 'text', text: userText }];
      for (const img of images) {
        const url = imageToDataUrl(img);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      }
      s.messages.push({ role: 'user', content: parts });
    } else {
      s.messages.push({ role: 'user', content: userText });
    }
    handlers.onModel(oai.model);

    // The user's linked MCP tools (namespaced mcp__server__tool) join the
    // built-in file/skill/memory tools for this turn.
    let mcpTools: AgentMcpTool[] = [];
    try {
      mcpTools = await ctx.mcpTools();
    } catch {
      mcpTools = []; // a broken MCP server must not break the chat
    }
    const mcpByName = new Map(mcpTools.map((t) => [(t.def as { function: { name: string } }).function.name, t]));
    const tools = [...toolsFor(this.research), ...mcpTools.map((t) => t.def)];

    const execute = async (name: string, args: string): Promise<string> => {
      // Built-in memory tools resolve here (they need the store); skills read
      // from disk; MCP calls route to the linked server behind an approval.
      if (name === 'search_chats') {
        try {
          return ctx.store.search(String(JSON.parse(args || '{}').query ?? ''));
        } catch {
          return 'ERROR: query inválida.';
        }
      }
      if (name === 'read_chat') {
        try {
          return ctx.store.transcript(String(JSON.parse(args || '{}').id ?? ''));
        } catch {
          return 'ERROR: id inválido.';
        }
      }
      if (name === 'use_skill') {
        try {
          return readSkill(String(JSON.parse(args || '{}').name ?? ''), ctx.skillRoots());
        } catch {
          return 'ERROR: nombre de skill inválido.';
        }
      }
      // Web / imagen / investigación: sin permiso para leer (como Claude),
      // la generación de imagen escribe en la carpeta de trabajo.
      if (name === 'web_search' || name === 'fetch_url' || name === 'generate_image' || name === 'deep_research') {
        let a: Record<string, unknown> = {};
        try {
          a = JSON.parse(args || '{}');
        } catch {
          return 'ERROR: argumentos inválidos.';
        }
        const aiCtx = {
          getCwd: () => s.cwd,
          apiKey: oai.apiKey,
          endpoint: oai.endpoint,
          provider: oai.provider,
        };
        if (name === 'web_search')
          return webSearch(String(a.query ?? ''), 12, a.recency ? String(a.recency) : undefined);
        if (name === 'fetch_url') return fetchUrl(String(a.url ?? ''));
        if (name === 'deep_research') return deepResearch(String(a.topic ?? ''), a.depth ? String(a.depth) : undefined);
        return generateImage(aiCtx, String(a.prompt ?? ''), a.model ? String(a.model) : undefined);
      }
      const mcp = mcpByName.get(name);
      if (mcp) {
        if (!(await gate.ask('mcp', `${name} ${args.slice(0, 200)}`))) {
          return 'DENEGADO por el usuario. No insistas con esta integración.';
        }
        return mcp.call(args);
      }
      return executeTool(name, args, { getCwd: () => s.cwd, setCwd: (d) => (s.cwd = d), gate });
    };

    const cap = ChatSession.RPM_CAPS[oai.provider];
    handlers.onStatus?.(`Pensando con ${oai.model}`);
    let firstToken = true;
    const res = await runAgentTurn({
      endpoint: oai.endpoint,
      apiKey: oai.apiKey,
      model: oai.model,
      messages: s.messages,
      tools,
      execute,
      onDelta: (t) => {
        if (firstToken) {
          firstToken = false;
          handlers.onStatus?.('Escribiendo la respuesta');
        }
        handlers.onDelta(t);
      },
      onToolStart: (name, args) => {
        handlers.onStatus?.(describeTool(name, args));
        handlers.onInfo(`🔧 ${name} ${args.slice(0, 140)}`);
        firstToken = true; // tras la herramienta vuelve a "pensar"
      },
      onRetry: (info) => {
        handlers.onStatus?.(info);
        handlers.onInfo(`⏳ ${info}`);
      },
      onReasoning: (chars) => {
        const now = Date.now();
        if (now - this.lastStatusAt > 400) {
          this.lastStatusAt = now;
          handlers.onStatus?.(`${oai.model} está razonando… (${chars.toLocaleString('es-DO')} caracteres)`);
        }
      },
      onToolDone: (name, chars) =>
        handlers.onStatus?.(
          `${oai.model} está procesando lo que devolvió ${name} (${chars.toLocaleString('es-DO')} caracteres)`
        ),
      maxPerMinute: cap,
      throttleKey: cap ? `${oai.provider}:${account.id}` : undefined,
      params: oai.params,
      signal: this.abort?.signal,
    });

    // Persist whatever really happened (tools already ran even on error).
    try {
      ctx.store.save(s);
    } catch {
      // best-effort: a failed save must not eat the reply
    }
    if ('error' in res) {
      // "Detener" aborta el fetch → no es un fallo que reportar como error.
      if (this.abort?.signal.aborted || /abort/i.test(res.error)) {
        handlers.onInfo('⏹ Detenido por ti.');
        handlers.onDone('');
        return;
      }
      // Ante un 404 el id del modelo suele estar mal: preguntamos al proveedor
      // qué ids acepta la key y los sugerimos.
      let extra = '';
      if (/404/.test(res.error)) {
        handlers.onStatus?.('Comprobando qué modelos acepta tu API key…');
        extra = await suggestModels(oai.endpoint, oai.apiKey, oai.model);
      }
      handlers.onError(`Error de ${account.label}: ${res.error}${extra}`);
      return;
    }
    handlers.onDone(res.text);
  }

  /** Serve a turn from an OpenAI-compatible account (OpenRouter, NVIDIA Build, …). */
  private async runOpenAITurn(text: string, account: ActiveAccount, handlers: TurnHandlers): Promise<void> {
    if (!account.openai!.model) {
      handlers.onError('Elige primero un modelo en el selector de abajo (la lista se carga desde la API de tu cuenta).');
      return;
    }
    this.oaiMessages.push({ role: 'user', content: text });
    let current = account;
    for (let attempt = 0; attempt <= MAX_FAILOVERS; attempt++) {
      const oai = current.openai!;
      handlers.onModel(oai.model);
      const cap = ChatSession.RPM_CAPS[oai.provider];
      const res = await streamOpenAIChat({
        endpoint: oai.endpoint,
        apiKey: oai.apiKey,
        model: oai.model,
        messages: this.oaiMessages,
        onDelta: (t) => handlers.onDelta(t),
        maxPerMinute: cap,
        throttleKey: cap ? `${oai.provider}:${current.id}` : undefined,
        params: oai.params,
        signal: this.abort?.signal,
      });
      if ('error' in res) {
        if (res.rateLimited) {
          const next = await this.backend.rotateFrom(current.id, `límite de ${oai.provider} (${res.error})`);
          if (next?.openai) {
            handlers.onAccountSwitch(next.label, `límite de ${oai.provider}`);
            current = next;
            continue;
          }
        }
        // Keep the conversation consistent: drop the user turn we couldn't answer.
        this.oaiMessages.pop();
        handlers.onError(`Error de ${current.label}: ${res.error}`);
        return;
      }
      this.oaiMessages.push({ role: 'assistant', content: res.text });
      handlers.onDone(res.text);
      return;
    }
    this.oaiMessages.pop();
    handlers.onError('Demasiados cambios de cuenta seguidos. Detengo el intento para evitar un bucle.');
  }

  /** Serve a turn from a web-chat account via the browser daemon. */
  private runWebTurn(text: string, account: ActiveAccount, handlers: TurnHandlers, attachments?: string[]): Promise<void> {
    return new Promise((resolve) => {
      const runner = this.backend.getWebRunner?.(account.id, account.web!.provider, account.web!.profileDir);
      if (!runner) {
        handlers.onError('El soporte de chat web no está disponible.');
        resolve();
        return;
      }
      handlers.onModel(account.label);
      void runner.send(
        text,
        {
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
        },
        { model: this.webModel ?? undefined, toggles: this.webToggles, files: attachments }
      );
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
