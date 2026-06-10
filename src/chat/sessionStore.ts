import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Reads the SAME local Claude Code session store (`~/.claude/projects/...`)
 * that the native Claude Code uses, so KeyRotator's chat and the native app
 * see and continue each other's conversations. Parsing of the `.jsonl`
 * transcript is split into pure functions (testable) + thin fs wrappers.
 */

export interface SessionSummary {
  id: string;
  name: string; // custom title (the name you set), shown in the sidebar
  cwd: string; // the conversation's working dir — used to resume in-place
  mtime: number;
  filePath: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant';
  text: string;
}

/** Root of the shared session store (default Claude config home). */
export function defaultProjectsRoot(): string {
  const home = process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
  return path.join(home, 'projects');
}

/** Extract the user-set custom title from transcript lines, if any. */
export function parseCustomTitle(lines: string[]): string | null {
  let title: string | null = null;
  for (const l of lines) {
    let o: any;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (o?.type === 'custom-title') {
      title =
        o.customTitle ??
        Object.values(o).find((v) => typeof v === 'string' && v !== o.type && v !== o.sessionId) ??
        title;
    }
  }
  return title;
}

/** First recorded working directory of the conversation. */
export function parseCwd(lines: string[]): string | null {
  for (const l of lines) {
    let o: any;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if (typeof o?.cwd === 'string' && o.cwd) return o.cwd;
  }
  return null;
}

/**
 * Extract the user/assistant message thread for display. Skips tool calls,
 * attachments, system reminders (text starting with `<`), and de-dupes by uuid.
 */
export function parseHistory(lines: string[]): ChatMessage[] {
  const seen = new Set<string>();
  const out: ChatMessage[] = [];
  for (const l of lines) {
    let o: any;
    try {
      o = JSON.parse(l);
    } catch {
      continue;
    }
    if ((o?.type === 'user' || o?.type === 'assistant') && o.message) {
      if (o.uuid) {
        if (seen.has(o.uuid)) continue;
        seen.add(o.uuid);
      }
      const c = o.message.content;
      let t = '';
      if (typeof c === 'string') t = c;
      else if (Array.isArray(c)) t = c.filter((b: any) => b?.type === 'text' && typeof b.text === 'string').map((b: any) => b.text).join('');
      t = (t || '').trim();
      if (!t || t.startsWith('<')) continue;
      out.push({ role: o.type, text: t });
    }
  }
  return out;
}

function readLines(filePath: string): string[] {
  return fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
}

/** List sessions that have a custom title (the named ones), newest first. */
export function listNamedSessions(projectsRoot = defaultProjectsRoot()): SessionSummary[] {
  const out: SessionSummary[] = [];
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsRoot);
  } catch {
    return out;
  }
  for (const d of dirs) {
    const dirPath = path.join(projectsRoot, d);
    let files: string[];
    try {
      if (!fs.statSync(dirPath).isDirectory()) continue;
      files = fs.readdirSync(dirPath);
    } catch {
      continue;
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const filePath = path.join(dirPath, f);
      let lines: string[];
      let mtime: number;
      try {
        mtime = fs.statSync(filePath).mtimeMs;
        lines = readLines(filePath);
      } catch {
        continue;
      }
      const name = parseCustomTitle(lines);
      if (!name) continue; // only named sessions
      out.push({
        id: path.basename(f, '.jsonl'),
        name,
        cwd: parseCwd(lines) ?? '',
        mtime,
        filePath,
      });
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  return out;
}

/** Load one session's cwd + message thread by id (searches the store). */
export function loadSession(
  id: string,
  projectsRoot = defaultProjectsRoot()
): { cwd: string; messages: ChatMessage[] } | null {
  let dirs: string[];
  try {
    dirs = fs.readdirSync(projectsRoot);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const filePath = path.join(projectsRoot, d, `${id}.jsonl`);
    if (!fs.existsSync(filePath)) continue;
    const lines = readLines(filePath);
    return { cwd: parseCwd(lines) ?? '', messages: parseHistory(lines) };
  }
  return null;
}
