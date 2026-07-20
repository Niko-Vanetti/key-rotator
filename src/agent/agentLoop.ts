import { waitForSlot } from '../chat/openaiChat.js';
import { AGENT_TOOLS } from './tools.js';

/**
 * The agent's call→execute-tools→reinject loop over an OpenAI-compatible
 * streaming API (NVIDIA Build / OpenRouter). Tool_call deltas arrive
 * fragmented across SSE chunks; `accumulateChunk` (pure, unit-tested)
 * assembles them by index.
 */

export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** Vision: a user message can carry text + images (OpenAI content parts). */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[] | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** Streaming accumulation state for one API call. */
export interface StreamState {
  content: string;
  /** Chain-of-thought emitted in `reasoning_content` (fallback for content). */
  reasoning: string;
  /** Last reasoning fragment, for the live "razonando…" status. */
  reasoningDelta?: string;
  toolCalls: Map<number, { id: string; name: string; args: string }>;
  finishReason: string | null;
  error: string | null;
}

export function newStreamState(): StreamState {
  return { content: '', reasoning: '', toolCalls: new Map(), finishReason: null, error: null };
}

/** Fold one parsed SSE JSON payload into the state; returns the text delta (if any). */
export function accumulateChunk(state: StreamState, j: unknown): string {
  const obj = j as {
    error?: { message?: string };
    choices?: {
      finish_reason?: string | null;
      delta?: {
        content?: string | null;
        /** Modelos "de razonamiento" de NVIDIA NIM (gemma, glm, deepseek…). */
        reasoning_content?: string | null;
        reasoning?: string | null;
        tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
      };
      /** Algunos endpoints devuelven el texto final aquí y no en delta. */
      message?: { content?: string | null; reasoning_content?: string | null };
    }[];
  };
  if (obj?.error?.message) {
    state.error = String(obj.error.message);
    return '';
  }
  const choice = obj?.choices?.[0];
  if (!choice) return '';
  if (choice.finish_reason) state.finishReason = choice.finish_reason;
  // Respuesta no-streaming embebida en el stream: tómala tal cual.
  if (choice.message && typeof choice.message.content === 'string' && choice.message.content) {
    state.content += choice.message.content;
    return choice.message.content;
  }
  const delta = choice.delta;
  if (!delta) return '';
  for (const tc of delta.tool_calls ?? []) {
    const idx = tc.index ?? 0;
    const cur = state.toolCalls.get(idx) ?? { id: '', name: '', args: '' };
    if (tc.id) cur.id = tc.id;
    if (tc.function?.name) cur.name += tc.function.name;
    if (tc.function?.arguments) cur.args += tc.function.arguments;
    state.toolCalls.set(idx, cur);
  }
  if (typeof delta.content === 'string' && delta.content) {
    state.content += delta.content;
    return delta.content;
  }
  // Razonamiento: se acumula aparte (no se muestra como respuesta), pero sirve
  // de RESPALDO cuando el modelo razona y no emite `content` — sin esto la
  // burbuja quedaba vacía con gemma y compañía.
  const think = delta.reasoning_content ?? delta.reasoning;
  if (typeof think === 'string' && think) {
    state.reasoning += think;
    state.reasoningDelta = think;
  }
  return '';
}

/** Final text of a turn: the content, or the reasoning if that's all we got. */
export function finalText(state: StreamState): string {
  if (state.content.trim()) return state.content;
  return state.reasoning.trim();
}

export function finishedToolCalls(state: StreamState): ToolCall[] {
  return [...state.toolCalls.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, c], i) => ({
      id: c.id || `call_${i}`,
      type: 'function' as const,
      function: { name: c.name, arguments: c.args },
    }));
}

export interface AgentTurnOpts {
  endpoint: string;
  apiKey: string;
  model: string;
  /** Full thread INCLUDING the new user message; assistant/tool msgs are appended in place. */
  messages: AgentMessage[];
  /** Executes one tool call and returns the string result for the model. */
  execute(name: string, argsJson: string): Promise<string>;
  onDelta(text: string): void;
  /** Fired before each tool execution (for the UI activity line). */
  onToolStart(name: string, argsJson: string): void;
  /** Fired when a transient failure (504, timeout…) triggers a retry. */
  onRetry?(info: string): void;
  /** Fired while the model emits reasoning (chars so far) — keeps the UI alive. */
  onReasoning?(chars: number): void;
  maxPerMinute?: number;
  throttleKey?: string;
  maxSteps?: number;
  signal?: AbortSignal;
  /** Extra request params from the pasted sample (temperature, top_p, …). */
  params?: Record<string, number>;
  /** Full tool list for this turn (defaults to AGENT_TOOLS). */
  tools?: unknown[];
}

export type AgentTurnResult = { text: string } | { error: string; rateLimited?: boolean };

export async function runAgentTurn(opts: AgentTurnOpts): Promise<AgentTurnResult> {
  const maxSteps = opts.maxSteps ?? 25;
  const pieces: string[] = [];

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) return { text: pieces.join('\n\n') };
    const res = await streamCall(opts, opts.onRetry);
    if ('error' in res) return res;

    // Si el modelo solo razonó (sin `content`), usamos el razonamiento: es
    // preferible a devolver una burbuja vacía.
    const turnText = finalText(res.state);
    if (turnText) pieces.push(turnText);
    const toolCalls = finishedToolCalls(res.state);

    if (toolCalls.length === 0) {
      // Final answer: persist it in the thread so resumed sessions keep it.
      const answer = pieces.join('\n\n');
      opts.messages.push({ role: 'assistant', content: answer });
      // Nada de texto NI herramientas: el modelo se quedó mudo, dilo claro.
      if (!answer.trim()) {
        return {
          error:
            'el modelo terminó sin escribir nada. Suele pasar cuando no soporta herramientas (function calling): prueba con otro modelo de tu lista.',
        };
      }
      // El texto ya se emitió por onDelta salvo que viniera solo en reasoning.
      if (!res.state.content.trim() && res.state.reasoning.trim()) opts.onDelta(res.state.reasoning);
      return { text: answer };
    }

    opts.messages.push({
      role: 'assistant',
      content: res.state.content || null,
      tool_calls: toolCalls,
    });
    for (const tc of toolCalls) {
      // Stopped mid-turn: every tool_call still needs a tool result or the
      // thread breaks on the next request.
      if (opts.signal?.aborted) {
        opts.messages.push({ role: 'tool', content: 'Cancelado por el usuario.', tool_call_id: tc.id });
        continue;
      }
      opts.onToolStart(tc.function.name, tc.function.arguments);
      const result = await opts.execute(tc.function.name, tc.function.arguments);
      opts.messages.push({ role: 'tool', content: result, tool_call_id: tc.id });
    }
  }
  return {
    error: `El agente alcanzó el tope de ${maxSteps} pasos en un solo turno y se detuvo por seguridad. Divide la tarea o pídele que continúe.`,
  };
}

/** Gateway hiccups that are worth retrying (502/503/504, 408, 429). */
export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status === 502 || status === 503 || status === 504;
}

/**
 * Turns an HTTP failure into an actionable message (pure, tested). A 404 is
 * NOT a blip: it means that model id doesn't exist on that endpoint (or isn't
 * enabled for the key), which is exactly what happened with deepseek-v4-pro.
 */
export function explainHttpError(status: number, body: string, model: string): string {
  const detail = body ? `: ${body}` : '';
  switch (status) {
    case 404:
      return `el modelo "${model}" no existe en ese endpoint o tu API key no lo tiene habilitado (HTTP 404). Abre build.nvidia.com, copia el id EXACTO del modelo y vuelve a pegar su código en KeyRotator${detail}`;
    case 401:
    case 403:
      return `tu API key fue rechazada para "${model}" (HTTP ${status}). Revisa que la key sea válida y tenga acceso a ese modelo${detail}`;
    case 400:
      return `el modelo "${model}" rechazó la petición (HTTP 400). Suele pasar cuando el modelo NO soporta llamadas a herramientas (function calling); prueba con otro modelo${detail}`;
    case 413:
      return `la conversación es demasiado grande para "${model}" (HTTP 413). Empieza un chat nuevo o reduce los adjuntos${detail}`;
    default:
      return `HTTP ${status}${detail || ' (el servidor no dio detalle)'}`;
  }
}

/** Backoff for attempt n (0-based), in ms (pure, tested). */
export function retryDelay(attempt: number): number {
  return Math.min(2000 * 2 ** attempt, 15_000);
}

const MAX_TRANSIENT_RETRIES = 3;
/** Hard ceiling per request; long research turns still fit comfortably. */
const REQUEST_TIMEOUT_MS = 300_000;

async function streamCall(
  opts: AgentTurnOpts,
  onRetry?: (info: string) => void
): Promise<{ state: StreamState } | { error: string; rateLimited?: boolean }> {
  const url = opts.endpoint.replace(/\/+$/, '') + '/chat/completions';

  for (let attempt = 0; ; attempt++) {
    if (opts.maxPerMinute && opts.throttleKey) {
      await waitForSlot(opts.throttleKey, opts.maxPerMinute);
    }
    // Our own timeout as well as the caller's stop signal: a hung gateway must
    // not freeze the chat forever.
    const timer = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const signal = opts.signal ? anySignal([opts.signal, timer]) : timer;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${opts.apiKey}`,
          'Content-Type': 'application/json',
          'HTTP-Referer': 'https://github.com/Nikorasu-Vanetti/key-rotator',
          'X-Title': 'KeyRotator',
        },
        body: JSON.stringify({
          model: opts.model,
          messages: opts.messages,
          tools: opts.tools ?? AGENT_TOOLS,
          stream: true,
          ...(opts.params ?? {}),
        }),
        signal,
      });
    } catch (e) {
      if (opts.signal?.aborted) return { error: 'cancelado por el usuario' };
      // Network drop / our timeout → retry a few times before giving up.
      if (attempt < MAX_TRANSIENT_RETRIES) {
        const wait = retryDelay(attempt);
        onRetry?.(`sin respuesta (${(e as Error).message}) — reintento ${attempt + 1}/${MAX_TRANSIENT_RETRIES} en ${Math.round(wait / 1000)}s`);
        await sleep(wait);
        continue;
      }
      return { error: `sin conexión tras ${MAX_TRANSIENT_RETRIES} reintentos: ${(e as Error).message}` };
    }

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      let msg = body.slice(0, 300);
      try {
        msg = (JSON.parse(body) as { error?: { message?: string } })?.error?.message || msg;
      } catch {
        /* keep raw */
      }
      // 504 y compañía son caídas momentáneas del gateway: reintentar.
      if (isTransientStatus(res.status) && attempt < MAX_TRANSIENT_RETRIES && !opts.signal?.aborted) {
        const wait = retryDelay(attempt);
        onRetry?.(
          `el servidor devolvió ${res.status} — reintento ${attempt + 1}/${MAX_TRANSIENT_RETRIES} en ${Math.round(wait / 1000)}s`
        );
        await sleep(wait);
        continue;
      }
      return { error: explainHttpError(res.status, msg, opts.model), rateLimited: res.status === 429 };
    }
    return readStream(res, opts);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Combines abort signals (Node 18 lacks AbortSignal.any in some runtimes). */
function anySignal(signals: AbortSignal[]): AbortSignal {
  const ctrl = new AbortController();
  for (const s of signals) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener('abort', () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

async function readStream(
  res: Response,
  opts: AgentTurnOpts
): Promise<{ state: StreamState } | { error: string; rateLimited?: boolean }> {

  const reader = res.body?.getReader();
  if (!reader) return { error: 'respuesta sin cuerpo' };
  const decoder = new TextDecoder();
  const state = newStreamState();
  let buf = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (data === '[DONE]') {
        if (state.error) return { error: state.error };
        return { state };
      }
      try {
        const j = JSON.parse(data);
        state.reasoningDelta = undefined;
        const delta = accumulateChunk(state, j);
        if (delta) opts.onDelta(delta);
        else if (state.reasoningDelta) opts.onReasoning?.(state.reasoning.length);
        if (state.error) return { error: state.error };
      } catch {
        // partial JSON across chunks — wait for more
      }
    }
  }
  if (state.error) return { error: state.error };
  return { state };
}
