import { streamOpenAIChat, type OAIMessage } from './openaiChat.js';
import { runAgentTurn, type AgentMessage, type ContentPart } from '../agent/agentLoop.js';
import { AGENT_TOOLS, toolsFor, executeTool, agentSystemPrompt, readSkill } from '../agent/tools.js';
import {
  webSearch,
  fetchUrl,
  generateImage,
  deepResearch,
  imageToDataUrl,
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
import * as path from 'node:path';
import { canEditImages } from '../agent/imageModels.js';
import { runImage } from '../agent/imageRunner.js';
import {
  attachmentToDataUrl,
  extractAttachmentText,
  inspectAttachment,
  type MediaAttachment,
} from './mediaAttachments.js';
import { transcribeAudio } from './audioTranscribe.js';
import {
  profileAcceptsKind,
  type NvidiaModelProfile,
} from '../agent/nvidiaProfiles.js';

/** One conversation in the agent's store, as listed in the sidebar. */
export interface SessionSummary {
  id: string;
  name: string;
  mtime: number;
}

/** One message of a stored conversation, for rendering history. */
export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
  attachments?: MediaAttachment[];
}

/** A resolved account ready to make a request (key held only transiently). */
export interface ActiveAccount {
  id: string;
  label: string;
  /**
   * OpenAI-compatible API account (OpenRouter, …): the turn is a streaming
   * `/chat/completions` call instead of the `claude` CLI.
   */
  openai?: {
    apiKey: string;
    endpoint: string;
    model: string;
    provider: string;
    params?: Record<string, number>;
    profile?: NvidiaModelProfile;
  };
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
  /** Named sessions from the shared local store (for the sidebar). */
  listSessions(): SessionSummary[];
  /** Load one conversation's messages for display (async, non-blocking). */
  loadHistory(id: string): Promise<ChatMessage[] | null>;
  /** Slash commands (skills) for the `/` autocomplete — read from disk, free. */
  getSlashCommands(): string[];
  /** Accounts available for the chat (for the account menu). */
  listChatAccounts(): { id: string; label: string; active: boolean }[];
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
  /** NVIDIA Build contracts imported from the user's own sample snippets. */
  listNvidiaProfiles?(): NvidiaModelProfile[];
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
}

const MAX_FAILOVERS = 8;

/**
 * Owns one logical conversation: keeps its history and, for each user turn,
 * runs the agent loop billed to the active model's API key. On a rate limit it
 * rotates to the next key and continues the same conversation.
 */
export class ChatSession {
  private accountOverride: string | null = null;
  private busy = false;
  /** In-memory history for OpenAI-compatible (OpenRouter) turns, per panel. */
  private oaiMessages: OAIMessage[] = [];
  /** Agent conversation (NVIDIA/OpenRouter with tools), per panel. */
  private agentSession: AgentSession | null = null;
  /** Permission grants ("allow all") live per conversation. */
  private agentGate: PermissionGate | null = null;
  /** Aborts the in-flight turn (the chat's "Detener" button). */
  private abort: AbortController | null = null;
  /**
   * 'agency' = un director reparte el trabajo entre todos los modelos.
   * 'images' = generar/editar imágenes con los modelos de imagen.
   */
  private mode: 'individual' | 'agency' | 'images' = 'individual';
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






  get currentSessionId(): string | null {
    return this.agentSession?.id ?? null;
  }

  isBusy(): boolean {
    return this.busy;
  }

  /** Stop the in-flight turn (button "Detener"). Tools already run stay done. */
  stop(): void {
    this.abort?.abort();
  }

  /** Individual (one model) vs agency (a director orchestrates all of them). */
  setMode(mode: 'individual' | 'agency' | 'images'): void {
    this.mode = mode;
  }

  /** Turn deep research on/off for the next turns (bottom-bar switch). */
  setResearch(on: boolean): void {
    this.research = on;
  }

  get currentMode(): 'individual' | 'agency' | 'images' {
    return this.mode;
  }

  /** Modelo de imagen elegido en el modo imágenes. */
  private imageModel = '';
  setImageModel(id: string): void {
    this.imageModel = id;
  }
  get currentImageModel(): string {
    return this.imageModel;
  }

  /** Reset so the next message starts a brand-new claude session. */
  reset(): void {
    this.oaiMessages = [];
    this.agentSession = null;
    this.agentGate = null;
  }

  /** Open a stored agent conversation so the next message continues it. */
  setActiveSession(id: string | null): void {
    this.agentSession = id ? this.backend.getAgentContext?.().store.load(id) ?? null : null;
    this.agentGate = null; // una conversación reanudada vuelve a pedir permisos
  }

  async sendMessage(text: string, handlers: TurnHandlers, attachments?: MediaAttachment[]): Promise<void> {
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

      // NVIDIA Build / OpenRouter → the file/command AGENT loop (tools).
      if (account.openai && AGENT_PROVIDERS.has(account.openai.provider)) {
        if (this.mode === 'images') await this.runImageTurn(text, account, handlers, attachments);
        else if (this.mode === 'agency') await this.runAgencyTurn(text, account, handlers, attachments);
        else await this.runAgentTurnFor(text, account, handlers, attachments);
        return;
      }

      // Other OpenAI-compatible accounts → plain streaming /chat/completions.
      if (account.openai) {
        await this.runOpenAITurn(text, account, handlers);
        return;
      }

      handlers.onError(
        `La cuenta "${account.label}" no es un modelo de API utilizable. Agrega un modelo pegando el código de build.nvidia.com u OpenRouter.`
      );
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
   * Tope de peticiones al modelo por turno de agencia (investigación +
   * trabajadores en paralelo + síntesis, cada uno multi-paso). Sin esto un
   * solo mensaje podía disparar ~90 llamadas; 40 deja margen de sobra para un
   * trabajo real y corta los descontroles.
   */
  private static readonly AGENCY_CALL_BUDGET = 40;

  /**
   * MODO IMÁGENES: genera una imagen desde el texto, o EDITA la que hayas
   * adjuntado (arrastrada, pegada con Ctrl+V o con el botón +). La imagen
   * resultante se guarda en la carpeta de trabajo y se muestra en el chat.
   */
  private async runImageTurn(
    text: string,
    account: ActiveAccount,
    handlers: TurnHandlers,
    attachments?: MediaAttachment[]
  ): Promise<void> {
    const ctx = this.backend.getAgentContext?.();
    const model = this.imageModel;
    if (!model) {
      handlers.onError('Elige abajo un modelo de imagen antes de enviar.');
      return;
    }
    const apiKey = account.openai?.apiKey;
    if (!apiKey) {
      handlers.onError('La cuenta activa no tiene API key.');
      return;
    }
    const inputFile = (attachments ?? []).find((a) => a.kind === 'image')?.path;
    const profile = account.openai?.profile;
    const canEdit = profile
      ? profile.capabilities.includes('image-edit')
      : canEditImages(model);
    if (inputFile && !canEdit) {
      handlers.onError(
        `"${model}" solo genera imágenes, no las edita. Para editar elige un modelo Kontext en el selector de abajo.`
      );
      return;
    }
    handlers.onModel(model);
    handlers.onStatus?.(inputFile ? 'Preparando la edición…' : 'Generando la imagen…');

    const outDir = path.join(ctx?.defaultCwd() ?? process.cwd(), 'salidas');
    if (ctx) {
      if (!this.agentSession) this.agentSession = newAgentSession(account.id, 'nvidia', model, ctx.defaultCwd());
      this.agentSession.messages.push({ role: 'user', content: text, attachments });
    }
    const res = await runImage({
      apiKey,
      model,
      endpoint: profile?.endpoint,
      prompt: text,
      inputFile,
      outDir,
      signal: this.abort?.signal,
      onStatus: (s) => handlers.onStatus?.(s),
    });

    if (!res.ok) {
      if (this.abort?.signal.aborted) {
        handlers.onInfo('⏹ Detenido por ti.');
        handlers.onDone('');
        return;
      }
      handlers.onError(res.detail);
      return;
    }
    // Se muestra en el chat (como data URL, que es lo que permite la CSP del
    // webview) y además queda guardada en disco.
    const title = inputFile ? 'Imagen editada' : 'Imagen generada';
    let body: string;
    if (res.file) {
      const dataUrl = imageToDataUrl(res.file);
      body = `${dataUrl ? `![${title}](${dataUrl})\n\n` : ''}📁 Guardada en: ${res.file}`;
    } else {
      body = `![${title}](${res.url})\n\n${res.url}`;
    }
    handlers.onDelta(`**${title}** — ${res.detail}\n\n${body}`);
    if (ctx && this.agentSession) {
      const generated = res.file ? inspectAttachment(res.file, 'generated', true) : null;
      this.agentSession.messages.push({
        role: 'assistant',
        content: `${title}: ${res.file ?? res.url ?? ''}`,
        attachments: generated?.ok ? [generated.attachment] : undefined,
      });
      ctx.store.save(this.agentSession);
    }
    handlers.onDone(`${title}: ${res.file ?? res.url ?? ''}`);
  }

  /**
   * MODO AGENCIA: el director (mejor modelo disponible) planifica qué modelo
   * hace cada parte, los trabajadores corren EN PARALELO con todas las
   * herramientas, y el director sintetiza la entrega final.
   */
  private async runAgencyTurn(
    text: string,
    account: ActiveAccount,
    handlers: TurnHandlers,
    attachments?: MediaAttachment[]
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
    s.messages.push({ role: 'user', content: text, attachments });

    const director = pickDirector(roster, ctx.directorModel?.())!;
    handlers.onModel(`agencia · director ${director.model}`);
    handlers.onInfo(`🏢 Modo agencia — director: ${director.model} · modelos disponibles: ${roster.length}`);

    // Presupuesto de llamadas COMPARTIDO por todo el turno (director +
    // trabajadores + síntesis). Se pasa a cada runAgentTurn de este turno.
    const budget = { remaining: ChatSession.AGENCY_CALL_BUDGET };

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
        budget,
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
      budget,
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
    // Presupuesto propio para el seguimiento (evaluación + respuesta del
    // especialista o director). runOne ya trae el suyo del turno que lo creó.
    const budget = { remaining: ChatSession.AGENCY_CALL_BUDGET };
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
          budget,
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
        budget,
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
      budget,
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
    attachments?: MediaAttachment[]
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
    const images = (attachments ?? []).filter((a) => a.kind === 'image');
    if (
      images.length > 0 &&
      oai.provider === 'nvidia' &&
      (!oai.profile || !profileAcceptsKind(oai.profile, 'image'))
    ) {
      handlers.onError(
        'Este modelo NVIDIA no declara soporte de vision. Importa el snippet de un modelo VLM o cambia de cuenta antes de adjuntar imagenes.'
      );
      return;
    }
    const others = (attachments ?? []).filter((a) => a.kind !== 'image');
    // Audio y vídeo → transcripción de voz local (Whisper); ffmpeg saca la
    // pista de audio incluso de un vídeo. El resto: texto extraído o su ruta.
    const modelCacheDir = path.join(path.dirname(ctx.defaultCwd()), 'KeyRotator Config', 'models');
    const extracted: string[] = [];
    for (const a of others) {
      if (a.kind === 'audio' || a.kind === 'video') {
        try {
          const transcript = await transcribeAudio(a.path, { modelCacheDir, onProgress: (m) => handlers.onInfo(m) });
          extracted.push(
            transcript ? `--- ${a.name} (transcripción) ---\n${transcript}` : `${a.name}: sin voz reconocible (${a.path})`
          );
        } catch (e) {
          handlers.onInfo(`⚠ No pude transcribir ${a.name}: ${(e as Error).message}`);
          extracted.push(`${a.name}: ${a.path}`);
        }
        continue;
      }
      const content = extractAttachmentText(a);
      extracted.push(content ? `--- ${a.name} ---\n${content}` : `${a.name}: ${a.path}`);
    }
    const userText = extracted.length ? `${text}\n\nArchivos adjuntos:\n${extracted.join('\n\n')}` : text;
    let userMessage: AgentMessage;
    if (images.length > 0) {
      const parts: ContentPart[] = [{ type: 'text', text: userText }];
      for (const img of images) {
        const url = attachmentToDataUrl(img);
        if (url) parts.push({ type: 'image_url', image_url: { url } });
      }
      userMessage = { role: 'user', content: parts, attachments };
    } else {
      userMessage = { role: 'user', content: userText, attachments };
    }
    s.messages.push(userMessage);
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

    // Binary image data is transient; metadata is enough to rebuild previews.
    if (Array.isArray(userMessage.content)) userMessage.content = userText;
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


}
