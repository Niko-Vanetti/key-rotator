import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

/**
 * Minimal MCP client (stdio transport, newline-delimited JSON-RPC 2.0) so the
 * agent can use the user's OWN MCP servers — the same `mcpServers` config that
 * Claude Code reads (~/.claude.json or keyRotator.chatMcpConfig). Note: the
 * claude.ai-MANAGED integrations (Canva, Gmail, Drive…) are OAuth-bound to
 * Claude's backend and cannot be linked from outside; only spawnable servers
 * from the config work here.
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpToolInfo {
  name: string; // original tool name on the server
  description: string;
  inputSchema: Record<string, unknown>;
}

/** Split a stdout buffer into complete JSON lines + the leftover (pure, tested). */
export function splitJsonLines(buf: string): { messages: unknown[]; rest: string } {
  const messages: unknown[] = [];
  let rest = buf;
  let nl: number;
  while ((nl = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (!line) continue;
    try {
      messages.push(JSON.parse(line));
    } catch {
      // servers sometimes log non-JSON to stdout — ignore those lines
    }
  }
  return { messages, rest };
}

/** Flatten a tools/call result into plain text for the model (pure, tested). */
export function contentToText(result: unknown): string {
  const r = result as { content?: { type?: string; text?: string }[]; isError?: boolean };
  const text = (r?.content ?? [])
    .map((c) => (typeof c?.text === 'string' ? c.text : ''))
    .filter(Boolean)
    .join('\n');
  const out = text || JSON.stringify(result ?? null).slice(0, 4000);
  return r?.isError ? `ERROR del servidor MCP: ${out}` : out;
}

export class McpConnection {
  private child: ChildProcessWithoutNullStreams | null = null;
  private buf = '';
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private initDone: Promise<void> | null = null;

  constructor(
    readonly serverName: string,
    private config: McpServerConfig
  ) {}

  private start(): void {
    if (this.child) return;
    this.child = spawn(this.config.command, this.config.args ?? [], {
      env: { ...process.env, ...(this.config.env ?? {}) },
      shell: process.platform === 'win32', // npx / .cmd need the shell on Windows
      windowsHide: true,
    });
    this.child.stdout.setEncoding('utf-8');
    this.child.stdout.on('data', (chunk: string) => {
      const { messages, rest } = splitJsonLines(this.buf + chunk);
      this.buf = rest;
      for (const m of messages) {
        const msg = m as { id?: number; result?: unknown; error?: { message?: string } };
        if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(msg.error.message ?? 'error MCP'));
          else p.resolve(msg.result);
        }
      }
    });
    this.child.on('close', () => {
      for (const p of this.pending.values()) p.reject(new Error(`el servidor MCP "${this.serverName}" se cerró`));
      this.pending.clear();
      this.child = null;
      this.initDone = null;
    });
  }

  private send(msg: Record<string, unknown>): void {
    this.child?.stdin.write(JSON.stringify(msg) + '\n');
  }

  private request(method: string, params?: Record<string, unknown>, timeoutMs = 30_000): Promise<unknown> {
    this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout de ${method} en "${this.serverName}"`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.send({ jsonrpc: '2.0', id, method, params: params ?? {} });
    });
  }

  private ensureInit(): Promise<void> {
    if (!this.initDone) {
      this.initDone = (async () => {
        await this.request('initialize', {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'KeyRotator', version: '0.1.0' },
        });
        this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      })();
    }
    return this.initDone;
  }

  async listTools(): Promise<McpToolInfo[]> {
    await this.ensureInit();
    const res = (await this.request('tools/list')) as {
      tools?: { name: string; description?: string; inputSchema?: Record<string, unknown> }[];
    };
    return (res?.tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema ?? { type: 'object', properties: {} },
    }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    await this.ensureInit();
    const res = await this.request('tools/call', { name, arguments: args }, 120_000);
    return contentToText(res);
  }

  dispose(): void {
    try {
      this.child?.kill();
    } catch {
      // already dead
    }
  }
}
