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

/** The default Claude config home (`~/.claude` or $CLAUDE_CONFIG_DIR). */
export function defaultHome(): string {
  return process.env.CLAUDE_CONFIG_DIR?.trim() || path.join(os.homedir(), '.claude');
}

/** Root of the shared session store (default Claude config home). */
export function defaultProjectsRoot(): string {
  return path.join(defaultHome(), 'projects');
}

/**
 * List the user's slash commands for the `/` autocomplete by reading the local
 * skills directory — zero tokens, instant. These are exactly the skills the
 * native Claude Code exposes as `/name`.
 */
export function listSlashCommands(home = defaultHome()): string[] {
  const names = new Set<string>();
  try {
    for (const e of fs.readdirSync(path.join(home, 'skills'), { withFileTypes: true })) {
      if (e.isDirectory()) names.add(e.name);
    }
  } catch {
    /* no skills dir */
  }
  // A few common built-in commands so they autocomplete too.
  for (const b of ['init', 'review', 'security-review', 'compact', 'clear', 'help']) names.add(b);
  return [...names].sort((a, b) => a.localeCompare(b));
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
    // Cheap string pre-filter: skip tool results / attachments / system lines
    // without paying JSON.parse for them (transcripts can be huge).
    if (!l.includes('"type":"user"') && !l.includes('"type":"assistant"')) continue;
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

// mtime-keyed cache so repeated listings don't re-read unchanged transcripts
// (some are several MB — full per-line JSON.parse on every refresh was slow).
interface ScanEntry {
  mtime: number;
  name: string | null;
  cwd: string;
}
const scanCache = new Map<string, ScanEntry>();

/**
 * Fast metadata scan: finds the LATEST custom-title line via lastIndexOf and
 * the first cwd via regex, parsing at most one JSON line instead of all.
 */
function quickScan(filePath: string): { name: string | null; cwd: string } {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { name: null, cwd: '' };
  }
  let name: string | null = null;
  const idx = content.lastIndexOf('"custom-title"');
  if (idx !== -1) {
    const start = content.lastIndexOf('\n', idx) + 1;
    let end = content.indexOf('\n', idx);
    if (end === -1) end = content.length;
    name = parseCustomTitle([content.slice(start, end).trim()]);
  }
  let cwd = '';
  const m = content.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
  if (m) {
    try {
      cwd = JSON.parse('"' + m[1] + '"');
    } catch {
      /* malformed escape — leave empty */
    }
  }
  return { name, cwd };
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
      let mtime: number;
      try {
        mtime = fs.statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      let entry = scanCache.get(filePath);
      if (!entry || entry.mtime !== mtime) {
        entry = { mtime, ...quickScan(filePath) };
        scanCache.set(filePath, entry);
      }
      if (!entry.name) continue; // only named sessions
      out.push({ id: path.basename(f, '.jsonl'), name: entry.name, cwd: entry.cwd, mtime, filePath });
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
