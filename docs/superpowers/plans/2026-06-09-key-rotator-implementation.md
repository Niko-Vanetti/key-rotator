# KeyRotator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a working VS Code extension (`.vsix`) that manages multiple AI provider API keys, auto-detects providers from key patterns (with Gemini Flash fallback), and rotates keys on rate-limit detection — with StatusBar, TreeView and WebView dashboard UI.

**Architecture:** TypeScript VS Code extension bundled with esbuild. Core logic (key detection, rotation engine, stats) is pure, dependency-free, and unit-tested with Node's built-in test runner (`node:test`). VS Code-API-dependent code (SecretStorage, TreeView, WebView, StatusBar) wraps that core logic as thin adapters.

**Tech Stack:** TypeScript, VS Code Extension API (^1.85), esbuild, Node built-in test runner, @vscode/vsce for packaging.

---

## Design Adjustment: Rate Limit Detection

The original spec described "monitoring output channels" for rate-limit errors. **VS Code's public API does not allow reading another extension's output channel content** — there is no API for this. The implementation instead uses:

1. **Periodic health-check pings** (configurable interval, default 5 min) — lightweight request to each provider's cheapest endpoint (e.g. `GET /v1/models` for OpenAI-compatible, `GET /v1/models` for Anthropic, Ollama `GET /api/tags`). A 429/quota response marks the account `rate-limited` and triggers rotation if in `auto` mode.
2. **Manual "Report Rate Limit" command** (`keyRotator.reportRateLimit`) — also bound to a click on the StatusBar item — for cases the user notices a limit before the next health check (e.g. Claude Code shows an error in chat).

This keeps "automatic rotation on rate limit" working without relying on a nonexistent API, while staying faithful to the spec's intent.

---

## File Structure

```
key-rotator/
  package.json
  tsconfig.json
  esbuild.js
  .vscodeignore
  .gitignore
  README.md
  data/
    patterns.json              # provider pattern registry (seed data)
  src/
    types.ts                   # shared interfaces (Account, ProviderPattern, HistoryEntry)
    extension.ts               # activation entry point, wires everything
    core/
      keyDetector.ts            # pattern match + Gemini Flash fallback (pure logic)
      rotationEngine.ts          # priority-based rotation decisions (pure logic)
      statsTracker.ts             # history + stats aggregation (pure logic)
    storage/
      keyManager.ts              # CRUD over SecretStorage + globalState
      registryUpdater.ts          # fetch/merge patterns.json from GitHub raw
    monitor/
      rateLimitMonitor.ts         # health-check polling + manual report command
    ui/
      statusBar.ts                # StatusBar item
      accountsTreeProvider.ts     # TreeView provider
      dashboardPanel.ts           # WebView panel controller
      media/
        dashboard.html
        dashboard.css
        dashboard.js
  test/
    keyDetector.test.ts
    rotationEngine.test.ts
    statsTracker.test.ts
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `esbuild.js`
- Create: `.gitignore`
- Create: `.vscodeignore`
- Create: `src/extension.ts` (stub)

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "key-rotator",
  "displayName": "KeyRotator",
  "description": "Manage and auto-rotate AI provider API keys (Claude, OpenAI, Gemini, Ollama, and more) on rate limits.",
  "version": "0.1.0",
  "publisher": "niko-local",
  "engines": { "vscode": "^1.85.0" },
  "categories": ["Other"],
  "activationEvents": ["onStartupFinished"],
  "main": "./dist/extension.js",
  "contributes": {
    "viewsContainers": {
      "activitybar": [
        { "id": "keyRotator", "title": "KeyRotator", "icon": "$(key)" }
      ]
    },
    "views": {
      "keyRotator": [
        { "id": "keyRotatorAccounts", "name": "Accounts" }
      ]
    },
    "commands": [
      { "command": "keyRotator.addAccount", "title": "KeyRotator: Add Account", "icon": "$(add)" },
      { "command": "keyRotator.editAccount", "title": "KeyRotator: Edit Account", "icon": "$(edit)" },
      { "command": "keyRotator.deleteAccount", "title": "KeyRotator: Delete Account", "icon": "$(trash)" },
      { "command": "keyRotator.activateAccount", "title": "KeyRotator: Activate Account", "icon": "$(check)" },
      { "command": "keyRotator.disableAccount", "title": "KeyRotator: Disable Account", "icon": "$(circle-slash)" },
      { "command": "keyRotator.openDashboard", "title": "KeyRotator: Open Dashboard", "icon": "$(dashboard)" },
      { "command": "keyRotator.reportRateLimit", "title": "KeyRotator: Report Rate Limit on Active Account" },
      { "command": "keyRotator.rotateNow", "title": "KeyRotator: Rotate Now" }
    ],
    "menus": {
      "view/title": [
        { "command": "keyRotator.addAccount", "when": "view == keyRotatorAccounts", "group": "navigation" },
        { "command": "keyRotator.openDashboard", "when": "view == keyRotatorAccounts", "group": "navigation" }
      ],
      "view/item/context": [
        { "command": "keyRotator.activateAccount", "when": "view == keyRotatorAccounts && viewItem == account", "group": "inline" },
        { "command": "keyRotator.editAccount", "when": "view == keyRotatorAccounts && viewItem == account" },
        { "command": "keyRotator.disableAccount", "when": "view == keyRotatorAccounts && viewItem == account" },
        { "command": "keyRotator.deleteAccount", "when": "view == keyRotatorAccounts && viewItem == account" }
      ]
    },
    "configuration": {
      "title": "KeyRotator",
      "properties": {
        "keyRotator.healthCheckIntervalMinutes": {
          "type": "number",
          "default": 5,
          "description": "How often to ping providers to check for rate limits."
        },
        "keyRotator.geminiApiKey": {
          "type": "string",
          "default": "",
          "description": "Optional: Gemini API key used to identify unknown API key prefixes via AI."
        },
        "keyRotator.preferPrimary": {
          "type": "boolean",
          "default": true,
          "description": "When the highest-priority account recovers from a rate limit, automatically rotate back to it."
        }
      }
    }
  },
  "scripts": {
    "compile": "node esbuild.js",
    "watch": "node esbuild.js --watch",
    "package": "node esbuild.js --production && npx @vscode/vsce package",
    "test": "node --import tsx --test test/**/*.test.ts"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/vscode": "^1.85.0",
    "esbuild": "^0.21.0",
    "tsx": "^4.7.0",
    "typescript": "^5.4.0",
    "@vscode/vsce": "^2.24.0"
  }
}
```

- [ ] **Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "module": "Node16",
    "moduleResolution": "Node16",
    "target": "ES2022",
    "lib": ["ES2022"],
    "outDir": "out",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Create `esbuild.js`**

```js
const esbuild = require('esbuild');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

async function main() {
  const ctx = await esbuild.context({
    entryPoints: ['src/extension.ts'],
    bundle: true,
    format: 'cjs',
    minify: production,
    sourcemap: !production,
    platform: 'node',
    outfile: 'dist/extension.js',
    external: ['vscode'],
    logLevel: 'info',
  });
  if (watch) {
    await ctx.watch();
  } else {
    await ctx.rebuild();
    await ctx.dispose();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
```

- [ ] **Step 4: Create `.gitignore`**

```
node_modules/
dist/
out/
*.vsix
.vscode-test/
```

- [ ] **Step 5: Create `.vscodeignore`**

```
.vscode/**
src/**
test/**
docs/**
out/**
node_modules/**
.gitignore
tsconfig.json
esbuild.js
**/*.map
**/*.ts
```

- [ ] **Step 6: Create stub `src/extension.ts`**

```typescript
import * as vscode from 'vscode';

export function activate(context: vscode.ExtensionContext) {
  console.log('KeyRotator activated');
}

export function deactivate() {}
```

- [ ] **Step 7: Install dependencies**

Run: `npm install`
Expected: `node_modules/` populated, no errors.

- [ ] **Step 8: Verify it compiles**

Run: `npm run compile`
Expected: `dist/extension.js` created, no errors.

- [ ] **Step 9: Commit**

```bash
git add package.json tsconfig.json esbuild.js .gitignore .vscodeignore src/extension.ts package-lock.json
git commit -m "chore: scaffold VS Code extension project"
```

---

## Task 2: Shared Types

**Files:**
- Create: `src/types.ts`

- [ ] **Step 1: Write `src/types.ts`**

```typescript
export type SwitchMode = 'auto' | 'confirm';
export type AccountStatus = 'active' | 'rate-limited' | 'error' | 'disabled';

export interface Account {
  id: string;
  provider: string;        // e.g. "anthropic", "openai", "qwen"
  label: string;            // e.g. "Claude Cuenta 2"
  apiKey: string;           // stored only in SecretStorage; present transiently in memory
  endpoint?: string;        // for Ollama / custom OpenAI-compatible providers
  envVar: string;           // e.g. "ANTHROPIC_API_KEY"
  priority: number;         // 1 = highest priority
  switchMode: SwitchMode;
  status: AccountStatus;
}

// Account metadata persisted in globalState (apiKey lives in SecretStorage, keyed by id)
export type AccountMeta = Omit<Account, 'apiKey'>;

export interface ProviderPattern {
  prefix: string;
  provider: string;
  displayName: string;
  envVar: string;
  docsUrl?: string;
}

export interface DetectionResult {
  provider: string;
  displayName: string;
  envVar: string;
  source: 'pattern' | 'ai' | 'unknown';
}

export interface HistoryEntry {
  timestamp: number;
  fromAccountId: string | null;
  fromLabel: string | null;
  toAccountId: string;
  toLabel: string;
  provider: string;
  reason: 'rate-limit' | 'manual' | 'recovery';
}

export interface ProviderStats {
  provider: string;
  totalRotations: number;
  rotationsByAccount: Record<string, number>; // accountId -> count
}
```

- [ ] **Step 2: Commit**

```bash
git add src/types.ts
git commit -m "feat: add shared type definitions"
```

---

## Task 3: Provider Pattern Registry (seed data)

**Files:**
- Create: `data/patterns.json`

- [ ] **Step 1: Write `data/patterns.json`**

```json
[
  { "prefix": "sk-ant-", "provider": "anthropic", "displayName": "Anthropic / Claude", "envVar": "ANTHROPIC_API_KEY", "docsUrl": "https://docs.anthropic.com" },
  { "prefix": "AIza", "provider": "google-gemini", "displayName": "Google Gemini", "envVar": "GEMINI_API_KEY", "docsUrl": "https://ai.google.dev" },
  { "prefix": "hf_", "provider": "huggingface", "displayName": "HuggingFace", "envVar": "HF_TOKEN", "docsUrl": "https://huggingface.co/docs" },
  { "prefix": "gsk_", "provider": "groq", "displayName": "Groq", "envVar": "GROQ_API_KEY", "docsUrl": "https://console.groq.com/docs" },
  { "prefix": "r8_", "provider": "replicate", "displayName": "Replicate", "envVar": "REPLICATE_API_TOKEN", "docsUrl": "https://replicate.com/docs" },
  { "prefix": "co_", "provider": "cohere", "displayName": "Cohere", "envVar": "COHERE_API_KEY", "docsUrl": "https://docs.cohere.com" },
  { "prefix": "together_", "provider": "together-ai", "displayName": "Together AI", "envVar": "TOGETHER_API_KEY", "docsUrl": "https://docs.together.ai" },
  { "prefix": "sk-or-", "provider": "openrouter", "displayName": "OpenRouter", "envVar": "OPENROUTER_API_KEY", "docsUrl": "https://openrouter.ai/docs" },
  { "prefix": "sk-", "provider": "openai", "displayName": "OpenAI", "envVar": "OPENAI_API_KEY", "docsUrl": "https://platform.openai.com/docs" }
]
```

> Order matters: more specific prefixes (`sk-ant-`, `sk-or-`) must be listed before the generic `sk-` (OpenAI) so they match first.

- [ ] **Step 2: Commit**

```bash
git add data/patterns.json
git commit -m "feat: add seed provider pattern registry"
```

---

## Task 4: KeyDetector (pure logic + tests)

**Files:**
- Create: `src/core/keyDetector.ts`
- Test: `test/keyDetector.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/keyDetector.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { detectFromPatterns, formatGeminiPrompt, parseGeminiDetection } from '../src/core/keyDetector.ts';
import patterns from '../data/patterns.json' with { type: 'json' };

test('detects Anthropic key by prefix', () => {
  const result = detectFromPatterns('sk-ant-api03-abc123', patterns);
  assert.equal(result?.provider, 'anthropic');
  assert.equal(result?.envVar, 'ANTHROPIC_API_KEY');
});

test('prefers more specific prefix over generic one', () => {
  const result = detectFromPatterns('sk-or-v1-abc123', patterns);
  assert.equal(result?.provider, 'openrouter');
});

test('falls back to generic OpenAI prefix', () => {
  const result = detectFromPatterns('sk-abc123def456', patterns);
  assert.equal(result?.provider, 'openai');
});

test('returns null for unrecognized prefix', () => {
  const result = detectFromPatterns('qwen-xyz-12345', patterns);
  assert.equal(result, null);
});

test('builds a Gemini identification prompt', () => {
  const prompt = formatGeminiPrompt('qwen-xyz-12345');
  assert.match(prompt, /qwen-xyz-1234/);
  assert.match(prompt, /JSON/);
});

test('parses a well-formed Gemini JSON response', () => {
  const raw = '```json\n{"provider":"qwen","displayName":"Alibaba Qwen","envVar":"QWEN_API_KEY"}\n```';
  const result = parseGeminiDetection(raw);
  assert.deepEqual(result, {
    provider: 'qwen',
    displayName: 'Alibaba Qwen',
    envVar: 'QWEN_API_KEY',
    source: 'ai',
  });
});

test('returns null when Gemini response is not parseable', () => {
  const result = parseGeminiDetection('I am not sure what this is.');
  assert.equal(result, null);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/core/keyDetector.ts'"

- [ ] **Step 3: Write `src/core/keyDetector.ts`**

```typescript
import type { ProviderPattern, DetectionResult } from '../types.js';

/**
 * Match an API key string against the local pattern registry.
 * Patterns are checked in array order, so more specific prefixes
 * must be listed before generic ones in data/patterns.json.
 */
export function detectFromPatterns(apiKey: string, patterns: ProviderPattern[]): DetectionResult | null {
  for (const pattern of patterns) {
    if (apiKey.startsWith(pattern.prefix)) {
      return {
        provider: pattern.provider,
        displayName: pattern.displayName,
        envVar: pattern.envVar,
        source: 'pattern',
      };
    }
  }
  return null;
}

/**
 * Build the prompt sent to Gemini Flash to identify an unrecognized key prefix.
 * Only the first 12 characters are sent — never the full key.
 */
export function formatGeminiPrompt(apiKey: string): string {
  const prefix = apiKey.slice(0, 12);
  return [
    `An API key starts with this prefix: "${prefix}".`,
    'Identify which AI provider issues API keys with this prefix.',
    'Respond with ONLY a JSON object (no markdown, no extra text) in this exact shape:',
    '{"provider": "<lowercase-slug>", "displayName": "<Human Readable Name>", "envVar": "<CONVENTIONAL_ENV_VAR_NAME>"}',
    'If you do not recognize the prefix, respond with {"provider": null}.',
  ].join('\n');
}

/**
 * Parse a Gemini Flash response into a DetectionResult.
 * Handles responses wrapped in markdown code fences.
 */
export function parseGeminiDetection(raw: string): DetectionResult | null {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    return null;
  }
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.provider || !parsed.displayName || !parsed.envVar) {
      return null;
    }
    return {
      provider: parsed.provider,
      displayName: parsed.displayName,
      envVar: parsed.envVar,
      source: 'ai',
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All 6 tests in `keyDetector.test.ts` PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/keyDetector.ts test/keyDetector.test.ts
git commit -m "feat: add key pattern detection with Gemini fallback parsing"
```

---

## Task 5: RotationEngine (pure logic + tests)

**Files:**
- Create: `src/core/rotationEngine.ts`
- Test: `test/rotationEngine.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/rotationEngine.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { pickNextAccount, applyRateLimit, applyRecovery } from '../src/core/rotationEngine.ts';
import type { AccountMeta } from '../src/types.ts';

function makeAccount(overrides: Partial<AccountMeta>): AccountMeta {
  return {
    id: 'id-1',
    provider: 'anthropic',
    label: 'Account',
    envVar: 'ANTHROPIC_API_KEY',
    priority: 1,
    switchMode: 'auto',
    status: 'active',
    ...overrides,
  };
}

test('picks the active account with the lowest priority number', () => {
  const accounts = [
    makeAccount({ id: 'a', priority: 2, status: 'active' }),
    makeAccount({ id: 'b', priority: 1, status: 'active' }),
    makeAccount({ id: 'c', priority: 3, status: 'rate-limited' }),
  ];
  const next = pickNextAccount(accounts, 'anthropic', null);
  assert.equal(next?.id, 'b');
});

test('skips the currently active account when picking next', () => {
  const accounts = [
    makeAccount({ id: 'a', priority: 1, status: 'active' }),
    makeAccount({ id: 'b', priority: 2, status: 'active' }),
  ];
  const next = pickNextAccount(accounts, 'anthropic', 'a');
  assert.equal(next?.id, 'b');
});

test('ignores disabled and rate-limited accounts', () => {
  const accounts = [
    makeAccount({ id: 'a', priority: 1, status: 'rate-limited' }),
    makeAccount({ id: 'b', priority: 2, status: 'disabled' }),
    makeAccount({ id: 'c', priority: 3, status: 'active' }),
  ];
  const next = pickNextAccount(accounts, 'anthropic', null);
  assert.equal(next?.id, 'c');
});

test('only considers accounts for the given provider', () => {
  const accounts = [
    makeAccount({ id: 'a', provider: 'openai', priority: 1, status: 'active' }),
    makeAccount({ id: 'b', provider: 'anthropic', priority: 2, status: 'active' }),
  ];
  const next = pickNextAccount(accounts, 'anthropic', null);
  assert.equal(next?.id, 'b');
});

test('returns null when no eligible account exists', () => {
  const accounts = [
    makeAccount({ id: 'a', priority: 1, status: 'rate-limited' }),
  ];
  const next = pickNextAccount(accounts, 'anthropic', null);
  assert.equal(next, null);
});

test('applyRateLimit marks the account as rate-limited', () => {
  const accounts = [makeAccount({ id: 'a', status: 'active' })];
  const updated = applyRateLimit(accounts, 'a');
  assert.equal(updated[0].status, 'rate-limited');
});

test('applyRecovery restores a rate-limited account to active', () => {
  const accounts = [makeAccount({ id: 'a', status: 'rate-limited' })];
  const updated = applyRecovery(accounts, 'a');
  assert.equal(updated[0].status, 'active');
});

test('applyRecovery does not change a disabled account', () => {
  const accounts = [makeAccount({ id: 'a', status: 'disabled' })];
  const updated = applyRecovery(accounts, 'a');
  assert.equal(updated[0].status, 'disabled');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/core/rotationEngine.ts'"

- [ ] **Step 3: Write `src/core/rotationEngine.ts`**

```typescript
import type { AccountMeta } from '../types.js';

/**
 * Pick the best eligible account to switch to for a given provider.
 * Eligible = same provider, status 'active', not the current account.
 * Picks the lowest `priority` number (1 = highest priority).
 */
export function pickNextAccount(
  accounts: AccountMeta[],
  provider: string,
  currentAccountId: string | null
): AccountMeta | null {
  const candidates = accounts
    .filter((a) => a.provider === provider)
    .filter((a) => a.status === 'active')
    .filter((a) => a.id !== currentAccountId)
    .sort((a, b) => a.priority - b.priority);

  return candidates[0] ?? null;
}

/**
 * Return a new array with the given account marked as rate-limited.
 */
export function applyRateLimit(accounts: AccountMeta[], accountId: string): AccountMeta[] {
  return accounts.map((a) => (a.id === accountId ? { ...a, status: 'rate-limited' } : a));
}

/**
 * Return a new array with the given account restored to active,
 * unless it was manually disabled.
 */
export function applyRecovery(accounts: AccountMeta[], accountId: string): AccountMeta[] {
  return accounts.map((a) => {
    if (a.id !== accountId) return a;
    if (a.status === 'disabled') return a;
    return { ...a, status: 'active' };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All 8 tests in `rotationEngine.test.ts` PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/rotationEngine.ts test/rotationEngine.test.ts
git commit -m "feat: add rotation engine for selecting next account"
```

---

## Task 6: StatsTracker (pure logic + tests)

**Files:**
- Create: `src/core/statsTracker.ts`
- Test: `test/statsTracker.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// test/statsTracker.test.ts
import { test } from 'node:test';
import assert from 'node:assert';
import { addHistoryEntry, computeStats } from '../src/core/statsTracker.ts';
import type { HistoryEntry } from '../src/types.ts';

function entry(overrides: Partial<HistoryEntry>): HistoryEntry {
  return {
    timestamp: 1000,
    fromAccountId: 'a',
    fromLabel: 'Account A',
    toAccountId: 'b',
    toLabel: 'Account B',
    provider: 'anthropic',
    reason: 'rate-limit',
    ...overrides,
  };
}

test('addHistoryEntry prepends the new entry (most recent first)', () => {
  const history = [entry({ timestamp: 1000 })];
  const updated = addHistoryEntry(history, entry({ timestamp: 2000 }));
  assert.equal(updated.length, 2);
  assert.equal(updated[0].timestamp, 2000);
  assert.equal(updated[1].timestamp, 1000);
});

test('addHistoryEntry caps history at 500 entries', () => {
  const history: HistoryEntry[] = Array.from({ length: 500 }, (_, i) => entry({ timestamp: i }));
  const updated = addHistoryEntry(history, entry({ timestamp: 9999 }));
  assert.equal(updated.length, 500);
  assert.equal(updated[0].timestamp, 9999);
});

test('computeStats counts total rotations per provider', () => {
  const history = [
    entry({ provider: 'anthropic', toAccountId: 'b' }),
    entry({ provider: 'anthropic', toAccountId: 'a' }),
    entry({ provider: 'openai', toAccountId: 'c' }),
  ];
  const stats = computeStats(history);
  const anthropic = stats.find((s) => s.provider === 'anthropic');
  const openai = stats.find((s) => s.provider === 'openai');
  assert.equal(anthropic?.totalRotations, 2);
  assert.equal(openai?.totalRotations, 1);
});

test('computeStats counts rotations per destination account', () => {
  const history = [
    entry({ provider: 'anthropic', toAccountId: 'b' }),
    entry({ provider: 'anthropic', toAccountId: 'b' }),
    entry({ provider: 'anthropic', toAccountId: 'a' }),
  ];
  const stats = computeStats(history);
  const anthropic = stats.find((s) => s.provider === 'anthropic');
  assert.equal(anthropic?.rotationsByAccount['b'], 2);
  assert.equal(anthropic?.rotationsByAccount['a'], 1);
});

test('computeStats returns empty array for empty history', () => {
  assert.deepEqual(computeStats([]), []);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL with "Cannot find module '../src/core/statsTracker.ts'"

- [ ] **Step 3: Write `src/core/statsTracker.ts`**

```typescript
import type { HistoryEntry, ProviderStats } from '../types.js';

const MAX_HISTORY = 500;

/**
 * Add a new history entry to the front of the list (most recent first),
 * trimming the list to MAX_HISTORY entries.
 */
export function addHistoryEntry(history: HistoryEntry[], newEntry: HistoryEntry): HistoryEntry[] {
  return [newEntry, ...history].slice(0, MAX_HISTORY);
}

/**
 * Aggregate rotation history into per-provider stats:
 * total rotation count and a breakdown of how many times
 * each destination account was rotated into.
 */
export function computeStats(history: HistoryEntry[]): ProviderStats[] {
  const byProvider = new Map<string, ProviderStats>();

  for (const entry of history) {
    let stats = byProvider.get(entry.provider);
    if (!stats) {
      stats = { provider: entry.provider, totalRotations: 0, rotationsByAccount: {} };
      byProvider.set(entry.provider, stats);
    }
    stats.totalRotations += 1;
    stats.rotationsByAccount[entry.toAccountId] = (stats.rotationsByAccount[entry.toAccountId] ?? 0) + 1;
  }

  return Array.from(byProvider.values());
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm test`
Expected: All 5 tests in `statsTracker.test.ts` PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/statsTracker.ts test/statsTracker.test.ts
git commit -m "feat: add stats tracker for rotation history"
```

---

## Task 7: KeyManager (SecretStorage + globalState)

**Files:**
- Create: `src/storage/keyManager.ts`

- [ ] **Step 1: Write `src/storage/keyManager.ts`**

```typescript
import * as vscode from 'vscode';
import type { Account, AccountMeta } from '../types.js';

const META_KEY = 'keyRotator.accounts';
const SECRET_PREFIX = 'keyRotator.secret.';

/**
 * Manages Account persistence: metadata in globalState, API keys in SecretStorage.
 * API keys never appear in globalState, history, or stats.
 */
export class KeyManager {
  constructor(private context: vscode.ExtensionContext) {}

  getAllMeta(): AccountMeta[] {
    return this.context.globalState.get<AccountMeta[]>(META_KEY, []);
  }

  private async setAllMeta(accounts: AccountMeta[]): Promise<void> {
    await this.context.globalState.update(META_KEY, accounts);
  }

  async getApiKey(accountId: string): Promise<string | undefined> {
    return this.context.secrets.get(SECRET_PREFIX + accountId);
  }

  async addAccount(account: Account): Promise<void> {
    const { apiKey, ...meta } = account;
    const all = this.getAllMeta();
    all.push(meta);
    await this.setAllMeta(all);
    await this.context.secrets.store(SECRET_PREFIX + account.id, apiKey);
  }

  async updateAccountMeta(accountId: string, patch: Partial<AccountMeta>): Promise<void> {
    const all = this.getAllMeta();
    const updated = all.map((a) => (a.id === accountId ? { ...a, ...patch } : a));
    await this.setAllMeta(updated);
  }

  async updateApiKey(accountId: string, apiKey: string): Promise<void> {
    await this.context.secrets.store(SECRET_PREFIX + accountId, apiKey);
  }

  async deleteAccount(accountId: string): Promise<void> {
    const all = this.getAllMeta().filter((a) => a.id !== accountId);
    await this.setAllMeta(all);
    await this.context.secrets.delete(SECRET_PREFIX + accountId);
  }

  async getAccountWithKey(accountId: string): Promise<Account | undefined> {
    const meta = this.getAllMeta().find((a) => a.id === accountId);
    if (!meta) return undefined;
    const apiKey = await this.getApiKey(accountId);
    if (apiKey === undefined) return undefined;
    return { ...meta, apiKey };
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run compile`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/storage/keyManager.ts
git commit -m "feat: add KeyManager for SecretStorage-backed account persistence"
```

---

## Task 8: RegistryUpdater

**Files:**
- Create: `src/storage/registryUpdater.ts`

- [ ] **Step 1: Write `src/storage/registryUpdater.ts`**

```typescript
import * as vscode from 'vscode';
import type { ProviderPattern } from '../types.js';
import seedPatterns from '../../data/patterns.json' with { type: 'json' };

const PATTERNS_KEY = 'keyRotator.patterns';
const REGISTRY_URL = 'https://raw.githubusercontent.com/Niko-Vanetti/key-rotator/main/data/patterns.json';

/**
 * Loads provider patterns from globalState (falling back to the bundled seed),
 * and optionally refreshes them from the GitHub-hosted registry.
 */
export class RegistryUpdater {
  constructor(private context: vscode.ExtensionContext) {}

  getPatterns(): ProviderPattern[] {
    return this.context.globalState.get<ProviderPattern[]>(PATTERNS_KEY, seedPatterns as ProviderPattern[]);
  }

  async addLearnedPattern(pattern: ProviderPattern): Promise<void> {
    const current = this.getPatterns();
    if (current.some((p) => p.prefix === pattern.prefix)) return;
    await this.context.globalState.update(PATTERNS_KEY, [...current, pattern]);
  }

  /**
   * Fetch the latest registry from GitHub. Merges new entries by prefix;
   * never overwrites locally learned patterns. Fails silently (offline-friendly).
   */
  async refreshFromRemote(): Promise<void> {
    try {
      const response = await fetch(REGISTRY_URL, { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const remote = (await response.json()) as ProviderPattern[];
      const current = this.getPatterns();
      const known = new Set(current.map((p) => p.prefix));
      const merged = [...current, ...remote.filter((p) => !known.has(p.prefix))];
      await this.context.globalState.update(PATTERNS_KEY, merged);
    } catch {
      // offline or registry unavailable — keep using existing patterns
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run compile`
Expected: No type errors. (Note: `resolveJsonModule` and `"type": "json"` import attribute require TS 5.3+ and Node 20+, both satisfied here.)

- [ ] **Step 3: Commit**

```bash
git add src/storage/registryUpdater.ts
git commit -m "feat: add provider pattern registry updater"
```

---

## Task 9: RateLimitMonitor (health checks + manual report)

**Files:**
- Create: `src/monitor/rateLimitMonitor.ts`

- [ ] **Step 1: Write `src/monitor/rateLimitMonitor.ts`**

```typescript
import * as vscode from 'vscode';
import type { Account } from '../types.js';

export type HealthStatus = 'ok' | 'rate-limited' | 'unreachable';

/**
 * Probes a provider's lightweight endpoint to check for rate-limit responses.
 * Uses a 'list models'-style endpoint where possible to avoid token cost.
 */
export async function checkAccountHealth(account: Account): Promise<HealthStatus> {
  const { url, headers } = buildProbeRequest(account);
  if (!url) return 'ok'; // unknown provider shape: skip active probing

  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(8000) });
    if (response.status === 429) return 'rate-limited';
    if (response.status >= 500) return 'unreachable';
    return 'ok';
  } catch {
    return 'unreachable';
  }
}

function buildProbeRequest(account: Account): { url: string | null; headers: Record<string, string> } {
  switch (account.provider) {
    case 'anthropic':
      return {
        url: 'https://api.anthropic.com/v1/models',
        headers: { 'x-api-key': account.apiKey, 'anthropic-version': '2023-06-01' },
      };
    case 'openai':
    case 'openrouter':
    case 'together-ai':
    case 'groq':
    case 'qwen':
      return {
        url: (account.endpoint ?? 'https://api.openai.com/v1') + '/models',
        headers: { Authorization: `Bearer ${account.apiKey}` },
      };
    case 'google-gemini':
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models?key=${account.apiKey}`,
        headers: {},
      };
    case 'ollama':
      return { url: (account.endpoint ?? 'http://localhost:11434') + '/api/tags', headers: {} };
    default:
      return { url: null, headers: {} };
  }
}

/**
 * Runs checkAccountHealth for every active account on an interval,
 * invoking onResult for each. Returns a disposable to stop polling.
 */
export function startHealthCheckLoop(
  getAccounts: () => Account[],
  intervalMinutes: number,
  onResult: (accountId: string, status: HealthStatus) => void
): vscode.Disposable {
  const timer = setInterval(async () => {
    for (const account of getAccounts()) {
      if (account.status === 'disabled') continue;
      const status = await checkAccountHealth(account);
      onResult(account.id, status);
    }
  }, intervalMinutes * 60 * 1000);

  return new vscode.Disposable(() => clearInterval(timer));
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run compile`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/monitor/rateLimitMonitor.ts
git commit -m "feat: add health-check based rate limit monitor"
```

---

## Task 10: StatusBar

**Files:**
- Create: `src/ui/statusBar.ts`

- [ ] **Step 1: Write `src/ui/statusBar.ts`**

```typescript
import * as vscode from 'vscode';
import type { AccountMeta } from '../types.js';

/**
 * Shows the active account for the primary provider (anthropic if present,
 * otherwise the first provider with an active account) plus a count of
 * how many accounts of that provider are healthy.
 * Click triggers keyRotator.reportRateLimit.
 */
export class StatusBarManager {
  private item: vscode.StatusBarItem;

  constructor() {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
    this.item.command = 'keyRotator.reportRateLimit';
    this.item.show();
  }

  update(accounts: AccountMeta[]): void {
    if (accounts.length === 0) {
      this.item.text = '$(key) KeyRotator: sin cuentas';
      this.item.backgroundColor = undefined;
      this.item.tooltip = 'Click para agregar una cuenta';
      return;
    }

    const provider =
      accounts.find((a) => a.provider === 'anthropic')?.provider ?? accounts[0].provider;
    const providerAccounts = accounts.filter((a) => a.provider === provider);
    const active = providerAccounts.filter((a) => a.status === 'active');
    const current = active[0];

    if (!current) {
      this.item.text = `$(error) ${provider}: 0/${providerAccounts.length}`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground');
      this.item.tooltip = `Todas las cuentas de ${provider} están en límite. Click para ver opciones.`;
      return;
    }

    this.item.text = `$(key) ${current.label} [${active.length}/${providerAccounts.length}]`;
    this.item.backgroundColor = undefined;
    this.item.tooltip = `Cuenta activa: ${current.label}. Click para reportar rate limit.`;
  }

  dispose(): void {
    this.item.dispose();
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run compile`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/statusBar.ts
git commit -m "feat: add StatusBar manager"
```

---

## Task 11: Accounts TreeView

**Files:**
- Create: `src/ui/accountsTreeProvider.ts`

- [ ] **Step 1: Write `src/ui/accountsTreeProvider.ts`**

```typescript
import * as vscode from 'vscode';
import type { AccountMeta } from '../types.js';

type TreeNode = ProviderNode | AccountNode;

interface ProviderNode {
  kind: 'provider';
  provider: string;
}

interface AccountNode {
  kind: 'account';
  account: AccountMeta;
}

const STATUS_ICONS: Record<AccountMeta['status'], vscode.ThemeIcon> = {
  active: new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('charts.green')),
  'rate-limited': new vscode.ThemeIcon('warning', new vscode.ThemeColor('charts.yellow')),
  error: new vscode.ThemeIcon('error', new vscode.ThemeColor('charts.red')),
  disabled: new vscode.ThemeIcon('circle-slash'),
};

/**
 * TreeView grouping accounts by provider. Each account is a leaf with
 * a status icon and a context value of "account" for menu contributions.
 */
export class AccountsTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  constructor(private getAccounts: () => AccountMeta[]) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  getTreeItem(element: TreeNode): vscode.TreeItem {
    if (element.kind === 'provider') {
      const item = new vscode.TreeItem(element.provider, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'provider';
      item.iconPath = new vscode.ThemeIcon('folder');
      return item;
    }

    const { account } = element;
    const item = new vscode.TreeItem(account.label, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'account';
    item.iconPath = STATUS_ICONS[account.status];
    item.description = `prio ${account.priority} · ${account.switchMode}`;
    item.id = account.id;
    return item;
  }

  getChildren(element?: TreeNode): TreeNode[] {
    const accounts = this.getAccounts();

    if (!element) {
      const providers = Array.from(new Set(accounts.map((a) => a.provider)));
      return providers.map((provider) => ({ kind: 'provider', provider }));
    }

    if (element.kind === 'provider') {
      return accounts
        .filter((a) => a.provider === element.provider)
        .sort((a, b) => a.priority - b.priority)
        .map((account) => ({ kind: 'account', account }));
    }

    return [];
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npm run compile`
Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add src/ui/accountsTreeProvider.ts
git commit -m "feat: add accounts TreeView provider"
```

---

## Task 12: Dashboard WebView (Keys / History / Stats)

**Files:**
- Create: `src/ui/media/dashboard.html`
- Create: `src/ui/media/dashboard.css`
- Create: `src/ui/media/dashboard.js`
- Create: `src/ui/dashboardPanel.ts`

- [ ] **Step 1: Write `src/ui/media/dashboard.css`**

```css
body {
  font-family: var(--vscode-font-family);
  color: var(--vscode-foreground);
  padding: 0 16px;
}

.tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--vscode-panel-border);
  margin-bottom: 16px;
}

.tab {
  padding: 8px 16px;
  cursor: pointer;
  border: none;
  background: transparent;
  color: var(--vscode-foreground);
  border-bottom: 2px solid transparent;
}

.tab.active {
  border-bottom: 2px solid var(--vscode-focusBorder);
  font-weight: 600;
}

.panel { display: none; }
.panel.active { display: block; }

.account-card {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 8px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.account-card .meta { display: flex; flex-direction: column; gap: 4px; }
.account-card .label { font-weight: 600; }
.account-card .sub { font-size: 0.85em; opacity: 0.75; }

.badge {
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 0.75em;
  font-weight: 600;
}
.badge.active { background: var(--vscode-charts-green); color: #000; }
.badge.rate-limited { background: var(--vscode-charts-yellow); color: #000; }
.badge.error { background: var(--vscode-charts-red); color: #fff; }
.badge.disabled { background: var(--vscode-disabledForeground); color: #000; }

.actions button {
  margin-left: 4px;
  background: var(--vscode-button-secondaryBackground);
  color: var(--vscode-button-secondaryForeground);
  border: none;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
}

.actions button:hover { background: var(--vscode-button-secondaryHoverBackground); }

table { width: 100%; border-collapse: collapse; }
th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--vscode-panel-border); font-size: 0.9em; }

.stat-block { margin-bottom: 24px; }
.bar-row { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.bar-label { width: 140px; font-size: 0.85em; }
.bar-track { flex: 1; background: var(--vscode-panel-border); border-radius: 4px; overflow: hidden; height: 14px; }
.bar-fill { background: var(--vscode-charts-blue); height: 100%; }
.bar-value { width: 32px; text-align: right; font-size: 0.85em; }

.empty { opacity: 0.6; font-style: italic; padding: 16px 0; }

.add-form {
  border: 1px solid var(--vscode-panel-border);
  border-radius: 6px;
  padding: 12px;
  margin-bottom: 16px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
}
.add-form input, .add-form select {
  background: var(--vscode-input-background);
  color: var(--vscode-input-foreground);
  border: 1px solid var(--vscode-input-border);
  padding: 4px 8px;
  border-radius: 4px;
}
.add-form .full { grid-column: 1 / -1; }
.detect-hint { font-size: 0.8em; opacity: 0.8; grid-column: 1 / -1; }
```

- [ ] **Step 2: Write `src/ui/media/dashboard.html`**

```html
<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src {{cspSource}}; script-src {{cspSource}};" />
  <link rel="stylesheet" href="{{styleUri}}" />
  <title>KeyRotator</title>
</head>
<body>
  <div class="tabs">
    <button class="tab active" data-tab="keys">Keys</button>
    <button class="tab" data-tab="history">Historial</button>
    <button class="tab" data-tab="stats">Estadísticas</button>
  </div>

  <section id="keys" class="panel active">
    <div class="add-form">
      <input id="newLabel" placeholder="Nombre (ej: Claude Cuenta 2)" />
      <input id="newApiKey" placeholder="Pega la API key aquí" type="password" />
      <input id="newProvider" placeholder="Proveedor (auto-detectado)" />
      <input id="newEnvVar" placeholder="Variable de entorno (ej: ANTHROPIC_API_KEY)" />
      <input id="newEndpoint" placeholder="Endpoint (opcional, para Ollama/custom)" class="full" />
      <div class="detect-hint" id="detectHint"></div>
      <button id="addBtn" class="full">Agregar cuenta</button>
    </div>
    <div id="accountList"></div>
  </section>

  <section id="history" class="panel">
    <table id="historyTable">
      <thead><tr><th>Fecha</th><th>De</th><th>A</th><th>Proveedor</th><th>Razón</th></tr></thead>
      <tbody></tbody>
    </table>
    <div class="empty" id="historyEmpty">Sin rotaciones todavía.</div>
  </section>

  <section id="stats" class="panel">
    <div class="stat-block">
      <h3>Rotaciones por proveedor</h3>
      <div id="statsByProvider"></div>
    </div>
    <div class="stat-block">
      <h3>Cuenta más estable</h3>
      <div id="mostStable"></div>
    </div>
  </section>

  <script src="{{scriptUri}}"></script>
</body>
</html>
```

- [ ] **Step 3: Write `src/ui/media/dashboard.js`**

```javascript
const vscode = acquireVsCodeApi();

document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach((p) => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById(tab.dataset.tab).classList.add('active');
  });
});

const newApiKey = document.getElementById('newApiKey');
let detectTimer;
newApiKey.addEventListener('input', () => {
  clearTimeout(detectTimer);
  const value = newApiKey.value.trim();
  if (value.length < 6) return;
  detectTimer = setTimeout(() => {
    vscode.postMessage({ type: 'detectProvider', apiKey: value });
  }, 400);
});

document.getElementById('addBtn').addEventListener('click', () => {
  const label = document.getElementById('newLabel').value.trim();
  const apiKey = document.getElementById('newApiKey').value.trim();
  const provider = document.getElementById('newProvider').value.trim();
  const envVar = document.getElementById('newEnvVar').value.trim();
  const endpoint = document.getElementById('newEndpoint').value.trim();

  if (!label || !apiKey || !provider || !envVar) {
    vscode.postMessage({ type: 'error', message: 'Completá nombre, API key, proveedor y variable de entorno.' });
    return;
  }

  vscode.postMessage({ type: 'addAccount', account: { label, apiKey, provider, envVar, endpoint: endpoint || undefined } });

  document.getElementById('newLabel').value = '';
  document.getElementById('newApiKey').value = '';
  document.getElementById('newProvider').value = '';
  document.getElementById('newEnvVar').value = '';
  document.getElementById('newEndpoint').value = '';
  document.getElementById('detectHint').textContent = '';
});

function renderAccounts(accounts) {
  const list = document.getElementById('accountList');
  list.innerHTML = '';
  if (accounts.length === 0) {
    list.innerHTML = '<div class="empty">No hay cuentas configuradas todavía.</div>';
    return;
  }

  for (const acc of accounts) {
    const card = document.createElement('div');
    card.className = 'account-card';
    card.innerHTML = `
      <div class="meta">
        <span class="label">${acc.label}</span>
        <span class="sub">${acc.provider} · prioridad ${acc.priority} · ${acc.switchMode}</span>
      </div>
      <span class="badge ${acc.status}">${acc.status}</span>
      <div class="actions">
        <button data-action="toggleMode" data-id="${acc.id}">${acc.switchMode === 'auto' ? 'Auto' : 'Confirmar'}</button>
        <button data-action="delete" data-id="${acc.id}">Eliminar</button>
      </div>
    `;
    list.appendChild(card);
  }

  list.querySelectorAll('button[data-action="delete"]').forEach((btn) => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'deleteAccount', id: btn.dataset.id }));
  });
  list.querySelectorAll('button[data-action="toggleMode"]').forEach((btn) => {
    btn.addEventListener('click', () => vscode.postMessage({ type: 'toggleSwitchMode', id: btn.dataset.id }));
  });
}

function renderHistory(history) {
  const tbody = document.querySelector('#historyTable tbody');
  const empty = document.getElementById('historyEmpty');
  tbody.innerHTML = '';
  empty.style.display = history.length === 0 ? 'block' : 'none';

  for (const h of history) {
    const tr = document.createElement('tr');
    const date = new Date(h.timestamp).toLocaleString();
    tr.innerHTML = `<td>${date}</td><td>${h.fromLabel ?? '—'}</td><td>${h.toLabel}</td><td>${h.provider}</td><td>${h.reason}</td>`;
    tbody.appendChild(tr);
  }
}

function renderStats(stats) {
  const container = document.getElementById('statsByProvider');
  container.innerHTML = '';
  if (stats.length === 0) {
    container.innerHTML = '<div class="empty">Todavía no hay rotaciones registradas.</div>';
    document.getElementById('mostStable').innerHTML = '<div class="empty">—</div>';
    return;
  }

  const max = Math.max(...stats.map((s) => s.totalRotations));
  for (const s of stats) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    const pct = max === 0 ? 0 : (s.totalRotations / max) * 100;
    row.innerHTML = `
      <span class="bar-label">${s.provider}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
      <span class="bar-value">${s.totalRotations}</span>
    `;
    container.appendChild(row);
  }
}

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'state':
      renderAccounts(msg.accounts);
      renderHistory(msg.history);
      renderStats(msg.stats);
      break;
    case 'detection':
      document.getElementById('newProvider').value = msg.result.provider;
      document.getElementById('newEnvVar').value = msg.result.envVar;
      document.getElementById('detectHint').textContent =
        msg.result.source === 'pattern'
          ? `Detectado: ${msg.result.displayName} ✓`
          : msg.result.source === 'ai'
          ? `Identificado via IA: ${msg.result.displayName}`
          : 'No se pudo identificar el proveedor automáticamente.';
      break;
  }
});

vscode.postMessage({ type: 'ready' });
```

- [ ] **Step 4: Write `src/ui/dashboardPanel.ts`**

```typescript
import * as vscode from 'vscode';
import type { Account, AccountMeta, HistoryEntry, ProviderStats, DetectionResult } from '../types.js';

export interface DashboardState {
  accounts: AccountMeta[];
  history: HistoryEntry[];
  stats: ProviderStats[];
}

export interface DashboardCallbacks {
  getState(): DashboardState;
  addAccount(account: Account): Promise<void>;
  deleteAccount(id: string): Promise<void>;
  toggleSwitchMode(id: string): Promise<void>;
  detectProvider(apiKey: string): Promise<DetectionResult>;
  generateId(): string;
}

/**
 * Manages the singleton WebView panel for the KeyRotator dashboard.
 */
export class DashboardPanel {
  private static current: DashboardPanel | undefined;
  private panel: vscode.WebviewPanel;

  private constructor(
    private extensionUri: vscode.Uri,
    private callbacks: DashboardCallbacks
  ) {
    this.panel = vscode.window.createWebviewPanel('keyRotatorDashboard', 'KeyRotator', vscode.ViewColumn.One, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'src', 'ui', 'media')],
    });

    this.panel.webview.html = this.render();
    this.panel.onDidDispose(() => (DashboardPanel.current = undefined));
    this.panel.webview.onDidReceiveMessage((msg) => this.handleMessage(msg));
  }

  static createOrShow(extensionUri: vscode.Uri, callbacks: DashboardCallbacks): void {
    if (DashboardPanel.current) {
      DashboardPanel.current.panel.reveal();
      DashboardPanel.current.postState();
      return;
    }
    DashboardPanel.current = new DashboardPanel(extensionUri, callbacks);
  }

  static refreshIfOpen(): void {
    DashboardPanel.current?.postState();
  }

  private postState(): void {
    this.panel.webview.postMessage({ type: 'state', ...this.callbacks.getState() });
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.postState();
        break;
      case 'addAccount': {
        const accounts = this.callbacks.getState().accounts;
        const provider = msg.account.provider;
        const sameProvider = accounts.filter((a) => a.provider === provider);
        const priority = sameProvider.length + 1;
        await this.callbacks.addAccount({
          id: this.callbacks.generateId(),
          provider,
          label: msg.account.label,
          apiKey: msg.account.apiKey,
          envVar: msg.account.envVar,
          endpoint: msg.account.endpoint,
          priority,
          switchMode: 'confirm',
          status: 'active',
        });
        this.postState();
        break;
      }
      case 'deleteAccount':
        await this.callbacks.deleteAccount(msg.id);
        this.postState();
        break;
      case 'toggleSwitchMode':
        await this.callbacks.toggleSwitchMode(msg.id);
        this.postState();
        break;
      case 'detectProvider': {
        const result = await this.callbacks.detectProvider(msg.apiKey);
        this.panel.webview.postMessage({ type: 'detection', result });
        break;
      }
      case 'error':
        vscode.window.showErrorMessage(msg.message);
        break;
    }
  }

  private render(): string {
    const mediaUri = (file: string) =>
      this.panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'src', 'ui', 'media', file));

    const fs = require('fs') as typeof import('fs');
    const htmlPath = vscode.Uri.joinPath(this.extensionUri, 'src', 'ui', 'media', 'dashboard.html').fsPath;
    let html = fs.readFileSync(htmlPath, 'utf-8');

    html = html
      .replace(/\{\{styleUri\}\}/g, mediaUri('dashboard.css').toString())
      .replace(/\{\{scriptUri\}\}/g, mediaUri('dashboard.js').toString())
      .replace(/\{\{cspSource\}\}/g, this.panel.webview.cspSource);

    return html;
  }
}
```

- [ ] **Step 5: Verify it compiles**

Run: `npm run compile`
Expected: No type errors. (Note: media files are read at runtime via `fs`, not bundled — Task 13 will ensure they're packaged via `.vscodeignore` exclusions being narrow enough to keep `src/ui/media/**`.)

- [ ] **Step 6: Commit**

```bash
git add src/ui/media src/ui/dashboardPanel.ts
git commit -m "feat: add dashboard WebView with Keys, History and Stats tabs"
```

---

## Task 13: Fix .vscodeignore for media files

**Files:**
- Modify: `.vscodeignore`

The dashboard reads `dashboard.html/css/js` from `src/ui/media` at runtime via `fs.readFileSync`, but `.vscodeignore` (Task 1) excludes all of `src/**`. Carve out an exception.

- [ ] **Step 1: Update `.vscodeignore`**

```
.vscode/**
src/**
!src/ui/media/**
test/**
docs/**
out/**
node_modules/**
.gitignore
tsconfig.json
esbuild.js
**/*.map
**/*.ts
```

- [ ] **Step 2: Commit**

```bash
git add .vscodeignore
git commit -m "fix: include media assets in packaged extension"
```

---

## Task 14: extension.ts — wire everything together

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Write the full `src/extension.ts`**

```typescript
import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import type { Account, AccountMeta, HistoryEntry } from './types.js';
import { KeyManager } from './storage/keyManager.js';
import { RegistryUpdater } from './storage/registryUpdater.js';
import { detectFromPatterns, formatGeminiPrompt, parseGeminiDetection } from './core/keyDetector.js';
import { pickNextAccount, applyRateLimit, applyRecovery } from './core/rotationEngine.js';
import { addHistoryEntry, computeStats } from './core/statsTracker.js';
import { startHealthCheckLoop } from './monitor/rateLimitMonitor.js';
import { StatusBarManager } from './ui/statusBar.js';
import { AccountsTreeProvider } from './ui/accountsTreeProvider.js';
import { DashboardPanel } from './ui/dashboardPanel.js';

const HISTORY_KEY = 'keyRotator.history';

export function activate(context: vscode.ExtensionContext) {
  const keyManager = new KeyManager(context);
  const registry = new RegistryUpdater(context);
  const statusBar = new StatusBarManager();
  const treeProvider = new AccountsTreeProvider(() => keyManager.getAllMeta());

  vscode.window.registerTreeDataProvider('keyRotatorAccounts', treeProvider);

  const refreshUI = () => {
    statusBar.update(keyManager.getAllMeta());
    treeProvider.refresh();
    DashboardPanel.refreshIfOpen();
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
    // Update the process env for the current extension host session.
    process.env[account.envVar] = account.apiKey;

    // Mirror into .claude/settings.json when present (Claude Code integration).
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) return;

    const settingsUri = vscode.Uri.joinPath(folders[0].uri, '.claude', 'settings.json');
    try {
      const raw = await vscode.workspace.fs.readFile(settingsUri);
      const json = JSON.parse(Buffer.from(raw).toString('utf-8'));
      json.env = json.env ?? {};
      json.env[account.envVar] = account.apiKey;
      await vscode.workspace.fs.writeFile(settingsUri, Buffer.from(JSON.stringify(json, null, 2), 'utf-8'));
    } catch {
      // .claude/settings.json doesn't exist or isn't valid JSON — skip silently
    }
  }

  async function handleRateLimit(accountId: string): Promise<void> {
    const accounts = keyManager.getAllMeta();
    const account = accounts.find((a) => a.id === accountId);
    if (!account) return;

    const updated = applyRateLimit(accounts, accountId);
    await Promise.all(updated.map((a) => keyManager.updateAccountMeta(a.id, { status: a.status })));

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

  const dashboardCallbacks = {
    getState: () => ({
      accounts: keyManager.getAllMeta(),
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
        const data = await response.json();
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
  };

  // --- commands ----------------------------------------------------------

  context.subscriptions.push(
    vscode.commands.registerCommand('keyRotator.openDashboard', () => {
      DashboardPanel.createOrShow(context.extensionUri, dashboardCallbacks);
    }),

    vscode.commands.registerCommand('keyRotator.addAccount', () => {
      DashboardPanel.createOrShow(context.extensionUri, dashboardCallbacks);
    }),

    vscode.commands.registerCommand('keyRotator.activateAccount', async (node?: { account?: AccountMeta }) => {
      const id = node?.account?.id;
      if (!id) return;
      await keyManager.updateAccountMeta(id, { status: 'active' });
      refreshUI();
    }),

    vscode.commands.registerCommand('keyRotator.disableAccount', async (node?: { account?: AccountMeta }) => {
      const id = node?.account?.id;
      if (!id) return;
      await keyManager.updateAccountMeta(id, { status: 'disabled' });
      refreshUI();
    }),

    vscode.commands.registerCommand('keyRotator.deleteAccount', async (node?: { account?: AccountMeta }) => {
      const id = node?.account?.id;
      if (!id) return;
      await keyManager.deleteAccount(id);
      refreshUI();
    }),

    vscode.commands.registerCommand('keyRotator.editAccount', () => {
      DashboardPanel.createOrShow(context.extensionUri, dashboardCallbacks);
    }),

    vscode.commands.registerCommand('keyRotator.reportRateLimit', async () => {
      const accounts = keyManager.getAllMeta().filter((a) => a.status === 'active');
      if (accounts.length === 0) {
        vscode.window.showInformationMessage('KeyRotator: no hay cuentas activas.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        accounts.map((a) => ({ label: a.label, description: a.provider, id: a.id })),
        { placeHolder: '¿Qué cuenta llegó al límite?' }
      );
      if (picked) {
        await handleRateLimit(picked.id);
      }
    }),

    vscode.commands.registerCommand('keyRotator.rotateNow', async () => {
      const providers = Array.from(new Set(keyManager.getAllMeta().map((a) => a.provider)));
      const picked = await vscode.window.showQuickPick(providers, { placeHolder: 'Rotar cuenta de qué proveedor?' });
      if (picked) {
        await rotateProvider(picked, 'manual');
      }
    })
  );

  // --- health check loop --------------------------------------------------

  const intervalMinutes = vscode.workspace.getConfiguration('keyRotator').get<number>('healthCheckIntervalMinutes', 5);
  const preferPrimary = vscode.workspace.getConfiguration('keyRotator').get<boolean>('preferPrimary', true);

  const healthCheckDisposable = startHealthCheckLoop(
    () => {
      // health check needs full Account objects (with keys); resolved lazily per-account
      return keyManager.getAllMeta().map((meta) => ({ ...meta, apiKey: '' }));
    },
    intervalMinutes,
    async (accountId, status) => {
      const meta = keyManager.getAllMeta().find((a) => a.id === accountId);
      if (!meta) return;

      if (status === 'rate-limited' && meta.status === 'active') {
        await handleRateLimit(accountId);
      } else if (status === 'ok' && meta.status === 'rate-limited') {
        const accounts = applyRecovery(keyManager.getAllMeta(), accountId);
        await keyManager.updateAccountMeta(accountId, { status: 'active' });

        if (preferPrimary) {
          const all = accounts.filter((a) => a.provider === meta.provider);
          const highestPriority = all.sort((a, b) => a.priority - b.priority)[0];
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

  registry.refreshFromRemote();

  refreshUI();
}

export function deactivate() {}
```

> **Note on health checks:** `checkAccountHealth` needs the real API key, but `getAllMeta()` returns metadata only (no `apiKey`). The health-check loop above passes `apiKey: ''` as a placeholder, which would make every probe fail auth. Task 15 fixes this.

- [ ] **Step 2: Verify it compiles**

Run: `npm run compile`
Expected: No type errors (the placeholder `apiKey: ''` is a runtime issue, not a type issue — fixed in Task 15).

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "feat: wire extension activation, commands and rotation logic"
```

---

## Task 15: Fix health-check loop to use real API keys

**Files:**
- Modify: `src/monitor/rateLimitMonitor.ts`
- Modify: `src/extension.ts`

The health-check loop (Task 9) takes a synchronous `getAccounts(): Account[]`, but API keys live in `SecretStorage` behind an async API. Change `startHealthCheckLoop` to accept an async account-loader.

- [ ] **Step 1: Update `startHealthCheckLoop` signature in `src/monitor/rateLimitMonitor.ts`**

Replace the existing `startHealthCheckLoop` function with:

```typescript
export function startHealthCheckLoop(
  getAccounts: () => Promise<Account[]>,
  intervalMinutes: number,
  onResult: (accountId: string, status: HealthStatus) => void
): vscode.Disposable {
  const timer = setInterval(async () => {
    const accounts = await getAccounts();
    for (const account of accounts) {
      if (account.status === 'disabled') continue;
      const status = await checkAccountHealth(account);
      onResult(account.id, status);
    }
  }, intervalMinutes * 60 * 1000);

  return new vscode.Disposable(() => clearInterval(timer));
}
```

- [ ] **Step 2: Update the call site in `src/extension.ts`**

Replace:

```typescript
  const healthCheckDisposable = startHealthCheckLoop(
    () => {
      // health check needs full Account objects (with keys); resolved lazily per-account
      return keyManager.getAllMeta().map((meta) => ({ ...meta, apiKey: '' }));
    },
    intervalMinutes,
```

with:

```typescript
  const healthCheckDisposable = startHealthCheckLoop(
    async () => {
      const metas = keyManager.getAllMeta().filter((a) => a.status !== 'disabled');
      const full = await Promise.all(metas.map((m) => keyManager.getAccountWithKey(m.id)));
      return full.filter((a): a is Account => a !== undefined);
    },
    intervalMinutes,
```

- [ ] **Step 3: Verify it compiles**

Run: `npm run compile`
Expected: No type errors.

- [ ] **Step 4: Run full test suite**

Run: `npm test`
Expected: All tests across `keyDetector.test.ts`, `rotationEngine.test.ts`, `statsTracker.test.ts` PASS.

- [ ] **Step 5: Commit**

```bash
git add src/monitor/rateLimitMonitor.ts src/extension.ts
git commit -m "fix: load real API keys for health checks via async account loader"
```

---

## Task 16: README

**Files:**
- Create: `README.md`

- [ ] **Step 1: Write `README.md`**

```markdown
# KeyRotator

Extensión de VS Code para gestionar múltiples cuentas/API keys de proveedores de IA
(Claude/Anthropic, OpenAI, Gemini, Ollama, Qwen, OpenRouter, Groq, y cualquier otro
proveedor compatible) y rotar automáticamente entre ellas cuando una alcanza su límite
de uso.

## Características

- **StatusBar** con el estado de la cuenta activa — clic para reportar un rate limit manualmente.
- **TreeView** lateral con todas las cuentas agrupadas por proveedor.
- **Dashboard** (Keys / Historial / Estadísticas) para gestionar cuentas, ver el historial
  de rotaciones y estadísticas de uso.
- **Auto-detección de proveedor**: pegá una API key y se identifica automáticamente por
  patrón conocido (Anthropic, OpenAI, Gemini, Groq, HuggingFace, Replicate, Cohere,
  Together AI, OpenRouter). Si no se reconoce, usa Gemini Flash (gratis) para
  identificarlo por IA.
- **Rotación automática o con confirmación**, configurable por cuenta.
- **Chequeo de salud periódico** para detectar rate limits proactivamente.
- **Integración con Claude Code**: al rotar, actualiza `ANTHROPIC_API_KEY` en el entorno
  y en `.claude/settings.json` si existe.

## Instalación

```bash
npm install
npm run package
code --install-extension key-rotator-0.1.0.vsix
```

## Configuración

| Setting | Default | Descripción |
|---|---|---|
| `keyRotator.healthCheckIntervalMinutes` | `5` | Frecuencia de chequeo de salud por cuenta |
| `keyRotator.geminiApiKey` | `""` | API key de Gemini para identificación de proveedores desconocidos (opcional) |
| `keyRotator.preferPrimary` | `true` | Volver a la cuenta de mayor prioridad cuando se recupera |

## Seguridad

Las API keys se guardan exclusivamente en VS Code Secret Storage (cifrado por el
sistema operativo). Nunca se escriben en el historial, estadísticas, ni en archivos
del repositorio.

## Limitación conocida

VS Code no permite leer el output de otras extensiones, por lo que la detección de
rate limit usa chequeos de salud periódicos (`GET /v1/models` o equivalente) más un
comando manual ("Report Rate Limit") para casos detectados antes del próximo chequeo.
```

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: add README"
```

---

## Task 17: Package the extension

**Files:** none (build artifact)

- [ ] **Step 1: Run full test suite one more time**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 2: Production build + package**

Run: `npm run package`
Expected: `key-rotator-0.1.0.vsix` created in the project root, no errors.

> If `vsce package` fails due to missing `repository` field or `LICENSE`, add a minimal
> `"repository"` field pointing at a placeholder/local path in `package.json`, or pass
> `--allow-missing-repository` / `--no-yarn` flags as needed to `vsce package`.

- [ ] **Step 3: Commit the .vsix is NOT tracked by git** (it's in `.gitignore`)

Verify: `git status` shows `key-rotator-0.1.0.vsix` as untracked/ignored — this is expected,
the `.vsix` is a local build artifact the user installs manually.

---

## Task 18: Final verification

- [ ] **Step 1: Confirm full test suite passes**

Run: `npm test`
Expected: All tests across all 3 test files PASS, 0 failures.

- [ ] **Step 2: Confirm extension package builds cleanly**

Run: `npm run package`
Expected: `.vsix` file produced successfully.

- [ ] **Step 3: Confirm git log shows all commits**

Run: `git log --oneline`
Expected: One commit per task (scaffold, types, registry, keyDetector, rotationEngine,
statsTracker, keyManager, registryUpdater, rateLimitMonitor, statusBar, treeProvider,
dashboard, vscodeignore fix, extension wiring, health-check fix, README).
```
