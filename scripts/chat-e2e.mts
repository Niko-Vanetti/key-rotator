// End-to-end check of the REAL ChatSession against the REAL logged-in profile:
//  1. fresh session in profiles mode (the "hola" case the user reported)
//  2. resume of a session that exists ONLY in the shared store (the bug:
//     used to die with «Error de claude: "desconocido"»; the sync fix must
//     copy it into the profile store so --resume works)
// Usage: node --import tsx scripts/chat-e2e.mts <profileDir> <sharedSessionId>
import { ChatSession, type ChatBackend, type TurnHandlers } from '../src/chat/chatSession.ts';

const [profileDir, sharedSessionId] = process.argv.slice(2);
if (!profileDir || !sharedSessionId) {
  console.error('usage: chat-e2e.mts <profileDir> <sharedSessionId>');
  process.exit(2);
}

const backend: ChatBackend = {
  resolveActiveAccount: async () => ({ id: 'acct-1', label: 'Claude (cuenta 1)', configDir: profileDir }),
  rotateFrom: async () => null,
  getModel: () => 'claude-haiku-4-5',
  getEffort: () => undefined,
  getCwd: () => 'C:\\Users\\dev',
  getLauncher: () => ({ command: 'claude', baseArgs: [], useShell: true }),
  listSessions: () => [],
  loadHistory: async () => null,
  getSlashCommands: () => [],
  listChatAccounts: () => [],
  getCachedModels: () => [],
  listModels: async () => [],
};

function run(label: string, session: ChatSession, text: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const handlers: TurnHandlers = {
      onDelta: () => {},
      onAccountSwitch: (l, r) => console.log(`[${label}] switch -> ${l} (${r})`),
      onInfo: (t) => console.log(`[${label}] info: ${t}`),
      onError: (t) => reject(new Error(`[${label}] ERROR: ${t}`)),
      onDone: (full) => resolve(full),
      onModel: () => {},
    };
    void session.sendMessage(text, handlers);
  });
}

// Case 1: fresh session in profiles mode.
const fresh = new ChatSession(backend);
const r1 = await run('fresh', fresh, 'Di exactamente: FUNCIONA');
console.log('CASE1 fresh-session reply:', JSON.stringify(r1.slice(0, 100)));
if (!/FUNCIONA/i.test(r1)) {
  console.error('FAIL: case 1 reply did not contain FUNCIONA');
  process.exit(1);
}

// Case 2: resume a shared-store-only session under the isolated profile.
const resumed = new ChatSession(backend);
resumed.setActiveSession(sharedSessionId, 'C:\\Users\\dev');
const r2 = await run('resume', resumed, 'Antes te pedí que dijeras una palabra en mayúsculas. Repítela, solo esa palabra.');
console.log('CASE2 cross-store resume reply:', JSON.stringify(r2.slice(0, 100)));
if (!/PING/i.test(r2)) {
  console.error('FAIL: case 2 reply did not recall PING — resume context lost');
  process.exit(1);
}

console.log('PASS: both chat turns returned real replies through ChatSession');
