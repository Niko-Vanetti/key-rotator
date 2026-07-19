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

export interface AgentMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
}

/** Streaming accumulation state for one API call. */
export interface StreamState {
  content: string;
  toolCalls: Map<number, { id: string; name: string; args: string }>;
  finishReason: string | null;
  error: string | null;
}

export function newStreamState(): StreamState {
  return { content: '', toolCalls: new Map(), finishReason: null, error: null };
}

/** Fold one parsed SSE JSON payload into the state; returns the text delta (if any). */
export function accumulateChunk(state: StreamState, j: unknown): string {
  const obj = j as {
    error?: { message?: string };
    choices?: {
      finish_reason?: string | null;
      delta?: {
        content?: string | null;
        tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[];
      };
    }[];
  };
  if (obj?.error?.message) {
    state.error = String(obj.error.message);
    return '';
  }
  const choice = obj?.choices?.[0];
  if (!choice) return '';
  if (choice.finish_reason) state.finishReason = choice.finish_reason;
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
  return '';
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
  maxPerMinute?: number;
  throttleKey?: string;
  maxSteps?: number;
  signal?: AbortSignal;
  /** Extra request params from the pasted sample (temperature, top_p, …). */
  params?: Record<string, number>;
}

export type AgentTurnResult = { text: string } | { error: string; rateLimited?: boolean };

export async function runAgentTurn(opts: AgentTurnOpts): Promise<AgentTurnResult> {
  const maxSteps = opts.maxSteps ?? 25;
  const pieces: string[] = [];

  for (let step = 0; step < maxSteps; step++) {
    const res = await streamCall(opts);
    if ('error' in res) return res;

    if (res.state.content) pieces.push(res.state.content);
    const toolCalls = finishedToolCalls(res.state);

    if (toolCalls.length === 0) {
      // Final answer: persist it in the thread so resumed sessions keep it.
      opts.messages.push({ role: 'assistant', content: res.state.content || pieces.join('\n\n') });
      return { text: pieces.join('\n\n') };
    }

    opts.messages.push({
      role: 'assistant',
      content: res.state.content || null,
      tool_calls: toolCalls,
    });
    for (const tc of toolCalls) {
      opts.onToolStart(tc.function.name, tc.function.arguments);
      const result = await opts.execute(tc.function.name, tc.function.arguments);
      opts.messages.push({ role: 'tool', content: result, tool_call_id: tc.id });
    }
  }
  return {
    error: `El agente alcanzó el tope de ${maxSteps} pasos en un solo turno y se detuvo por seguridad. Divide la tarea o pídele que continúe.`,
  };
}

async function streamCall(
  opts: AgentTurnOpts
): Promise<{ state: StreamState } | { error: string; rateLimited?: boolean }> {
  if (opts.maxPerMinute && opts.throttleKey) {
    await waitForSlot(opts.throttleKey, opts.maxPerMinute);
  }
  const url = opts.endpoint.replace(/\/+$/, '') + '/chat/completions';
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
        tools: AGENT_TOOLS,
        stream: true,
        ...(opts.params ?? {}),
      }),
      signal: opts.signal,
    });
  } catch (e) {
    return { error: `sin conexión: ${(e as Error).message}` };
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let msg = body.slice(0, 300);
    try {
      msg = (JSON.parse(body) as { error?: { message?: string } })?.error?.message || msg;
    } catch {
      /* keep raw */
    }
    return { error: `HTTP ${res.status}: ${msg}`, rateLimited: res.status === 429 };
  }

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
        const delta = accumulateChunk(state, j);
        if (delta) opts.onDelta(delta);
        if (state.error) return { error: state.error };
      } catch {
        // partial JSON across chunks — wait for more
      }
    }
  }
  if (state.error) return { error: state.error };
  return { state };
}
