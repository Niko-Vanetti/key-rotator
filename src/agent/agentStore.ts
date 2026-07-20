import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { AgentMessage } from './agentLoop.js';
import type { AgencyTeamMember } from './agency.js';

/**
 * The agent's OWN session store: one JSON file per conversation under
 * `<globalStorage>/agent-sessions/`. Completely separate from Claude Code's
 * `~/.claude/projects` — agent chats never touch the Claude store.
 * Ids are `agent-<uuid>` so the chat panel can route them.
 */

export interface AgentSession {
  id: string;
  title: string;
  accountId: string;
  provider: string;
  model: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  messages: AgentMessage[];
  /**
   * Agency mode: the permanent team for this conversation. Each member owns an
   * area, so later complaints about it route back to the same specialist.
   */
  team?: AgencyTeamMember[];
}

export interface AgentSessionSummary {
  id: string;
  title: string;
  provider: string;
  updatedAt: number;
}

export function newAgentSession(accountId: string, provider: string, model: string, cwd: string): AgentSession {
  const now = Date.now();
  return {
    id: `agent-${randomUUID()}`,
    title: '',
    accountId,
    provider,
    model,
    cwd,
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
}

/** Plain text of a message, flattening vision content parts (pure, tested). */
export function messageText(content: AgentMessage['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p.type === 'text' ? p.text : '[imagen]'))
      .join(' ')
      .trim();
  }
  return '';
}

/** Derive the sidebar title from the first user message (pure, tested). */
export function sessionTitle(session: Pick<AgentSession, 'title' | 'messages'>): string {
  if (session.title) return session.title;
  const first = messageText(session.messages.find((m) => m.role === 'user')?.content ?? '');
  const t = first.replace(/\s+/g, ' ').trim();
  return t ? (t.length > 60 ? t.slice(0, 57) + '…' : t) : 'Conversación del agente';
}

/** Parse a stored session file's JSON; null if the shape is wrong (pure, tested). */
export function parseAgentSession(raw: string): AgentSession | null {
  try {
    const j = JSON.parse(raw) as AgentSession;
    if (typeof j?.id !== 'string' || !j.id.startsWith('agent-')) return null;
    if (!Array.isArray(j.messages)) return null;
    return j;
  } catch {
    return null;
  }
}

export function isAgentSessionId(id: string): boolean {
  return id.startsWith('agent-');
}

export class AgentStore {
  constructor(private dir: string) {}

  private file(id: string): string {
    // Ids are internally generated (`agent-<uuid>`), but never trust them as
    // path components without sanitizing.
    return path.join(this.dir, id.replace(/[^a-zA-Z0-9-]/g, '') + '.json');
  }

  save(session: AgentSession): void {
    session.updatedAt = Date.now();
    session.title = sessionTitle(session);
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(this.file(session.id), JSON.stringify(session), 'utf-8');
  }

  load(id: string): AgentSession | null {
    try {
      return parseAgentSession(fs.readFileSync(this.file(id), 'utf-8'));
    } catch {
      return null;
    }
  }

  list(): AgentSessionSummary[] {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.endsWith('.json'));
    } catch {
      return [];
    }
    const out: AgentSessionSummary[] = [];
    for (const f of files) {
      try {
        const s = parseAgentSession(fs.readFileSync(path.join(this.dir, f), 'utf-8'));
        if (s) out.push({ id: s.id, title: sessionTitle(s), provider: s.provider, updatedAt: s.updatedAt });
      } catch {
        // skip unreadable file
      }
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  delete(id: string): void {
    try {
      fs.unlinkSync(this.file(id));
    } catch {
      // already gone
    }
  }

  /**
   * Cross-chat memory: case-insensitive text search over every stored
   * conversation. Returns per-session matches with short snippets.
   */
  search(query: string, maxSessions = 8): string {
    const q = query.trim().toLowerCase();
    if (!q) return 'ERROR: query vacía.';
    const out: string[] = [];
    for (const s of this.list()) {
      const full = this.load(s.id);
      if (!full) continue;
      const snippets: string[] = [];
      for (const m of full.messages) {
        if (m.role !== 'user' && m.role !== 'assistant') continue;
        const body = messageText(m.content);
        if (!body) continue;
        const idx = body.toLowerCase().indexOf(q);
        if (idx === -1) continue;
        const from = Math.max(0, idx - 80);
        snippets.push(`  [${m.role}] …${body.slice(from, idx + q.length + 120).replace(/\s+/g, ' ')}…`);
        if (snippets.length >= 3) break;
      }
      if (snippets.length) {
        out.push(`${s.id} — "${s.title}" (${new Date(s.updatedAt).toLocaleDateString()}):\n${snippets.join('\n')}`);
        if (out.length >= maxSessions) break;
      }
    }
    return out.length
      ? `Coincidencias en ${out.length} chat(s):\n\n${out.join('\n\n')}\n\nUsa read_chat(id) para el transcript completo.`
      : `Sin coincidencias para "${query}" en los chats guardados.`;
  }

  /** Full transcript of one conversation, formatted for the model. */
  transcript(id: string): string {
    const s = this.load(id);
    if (!s) return `ERROR: no existe el chat "${id}".`;
    const lines = s.messages
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .map((m) => ({ role: m.role, body: messageText(m.content) }))
      .filter((m) => m.body)
      .map((m) => `[${m.role === 'user' ? 'USUARIO' : 'ASISTENTE'}] ${m.body}`);
    const text = `Chat "${sessionTitle(s)}" (${new Date(s.updatedAt).toLocaleString()}):\n\n${lines.join('\n\n')}`;
    return text.length > 40_000 ? text.slice(-40_000) : text; // keep the tail (most recent)
  }
}
