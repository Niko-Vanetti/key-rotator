// KeyRotator Web-Chat bridge daemon.
//
// Drives a real logged-in web chat (DeepSeek today; provider-extensible) in a
// persistent Chromium profile, and speaks JSON-lines over stdin/stdout so the
// extension can talk to it like it talks to the `claude` CLI:
//
//   stdin  (one JSON per line):
//     {"cmd":"status"}            -> {"type":"status","ready":bool,"url":...}
//     {"cmd":"login"}             -> opens a HEADED window; {"type":"login","ok":bool}
//     {"cmd":"send","text":"..."} -> {"type":"delta","text":...}* then
//                                    {"type":"done","text":full}
//                                    | {"type":"login_needed"} | {"type":"error",...}
//     {"cmd":"quit"}              -> exits
//
// Launch: node bridge.mjs <provider> <profileDir>
// Env: PW_CHROMIUM overrides the Chromium executable path.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const PROVIDER = process.argv[2] || 'deepseek';
const PROFILE = process.argv[3];
if (!PROFILE) {
  console.log(JSON.stringify({ type: 'fatal', message: 'missing profile dir' }));
  process.exit(2);
}

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

// --- provider config ------------------------------------------------------
// Each entry knows how to reach the chat, recognize the (non-chat) auth pages,
// find the composer, and read the latest assistant reply. Verified live for
// DeepSeek; add new providers here once their selectors are confirmed.
const PROVIDERS = {
  deepseek: {
    url: 'https://chat.deepseek.com',
    authPage: /sign_in|sign_up|forgot|reset|password|\/login|\/register/i,
    composer: 'textarea',
    reply: '.ds-assistant-message-main-content',
  },
};
const CFG = PROVIDERS[PROVIDER];
if (!CFG) {
  console.log(JSON.stringify({ type: 'fatal', message: `unknown provider ${PROVIDER}` }));
  process.exit(2);
}

// --- chromium discovery ---------------------------------------------------
function findChromium() {
  if (process.env.PW_CHROMIUM && fs.existsSync(process.env.PW_CHROMIUM)) return process.env.PW_CHROMIUM;
  const root = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'ms-playwright');
  let best = null;
  let bestN = -1;
  try {
    for (const d of fs.readdirSync(root)) {
      const m = /^chromium-(\d+)$/.exec(d);
      if (!m) continue;
      for (const exe of [
        path.join(root, d, 'chrome-win64', 'chrome.exe'),
        path.join(root, d, 'chrome-win', 'chrome.exe'),
        path.join(root, d, 'chrome-linux', 'chrome'),
        path.join(root, d, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'),
      ]) {
        if (fs.existsSync(exe) && Number(m[1]) > bestN) {
          best = exe;
          bestN = Number(m[1]);
        }
      }
    }
  } catch {
    /* no cache dir */
  }
  return best;
}

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// --- single persistent context (headed for login, headless for sending) ---
let cur = null; // { ctx, page, headless }

async function ensure(headless) {
  if (cur && cur.headless === headless) return cur;
  if (cur) {
    await cur.ctx.close().catch(() => {});
    cur = null;
  }
  const exe = findChromium();
  if (!exe) {
    send({ type: 'error', message: 'No encontré Chromium de Playwright. Ejecuta: npx playwright install chromium' });
    throw new Error('no chromium');
  }
  const ctx = await chromium.launchPersistentContext(PROFILE, {
    headless,
    executablePath: exe,
    args: ['--disable-blink-features=AutomationControlled'],
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  cur = { ctx, page, headless };
  return cur;
}

const isAuth = (url) => CFG.authPage.test(url);
const hasComposer = async (page) => (await page.locator(CFG.composer).count()) > 0;
const chatReady = async (page) => !isAuth(page.url()) && (await hasComposer(page));

async function gotoChat(page) {
  await page.goto(CFG.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(3500);
}

async function doStatus() {
  const { page } = await ensure(true);
  await gotoChat(page);
  send({ type: 'status', ready: await chatReady(page), url: page.url() });
}

async function doLogin() {
  const { page } = await ensure(false); // headed so the user can sign in
  await gotoChat(page);
  if (await chatReady(page)) {
    send({ type: 'login', ok: true });
    return;
  }
  // Wait until the chat composer is STABLY present (3 checks) or 8 min.
  const deadline = Date.now() + 480000;
  let streak = 0;
  while (Date.now() < deadline) {
    await page.waitForTimeout(1500);
    streak = (await chatReady(page)) ? streak + 1 : 0;
    if (streak >= 3) break;
  }
  send({ type: 'login', ok: streak >= 3 });
  // Drop the headed context so the next send reopens headless.
  if (cur) {
    await cur.ctx.close().catch(() => {});
    cur = null;
  }
}

async function doSend(text) {
  const { page } = await ensure(true);
  await gotoChat(page);
  if (isAuth(page.url()) || !(await hasComposer(page))) {
    send({ type: 'login_needed' });
    return;
  }
  const composer = page.locator(CFG.composer).first();
  const replies = page.locator(CFG.reply);
  const before = await replies.count();

  await composer.click();
  await composer.fill(text);
  await page.keyboard.press('Enter');

  // Wait for the new reply bubble (≤30s).
  const appear = Date.now() + 30000;
  while ((await replies.count()) <= before && Date.now() < appear) {
    await page.waitForTimeout(400);
  }
  if ((await replies.count()) <= before) {
    send({ type: 'error', message: 'No apareció respuesta del chat.' });
    return;
  }

  // Stream deltas: poll the new reply's text, emit the growth, finish when it
  // stays stable for 2.5s (cap 180s).
  let emitted = '';
  let stableSince = Date.now();
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) {
    await page.waitForTimeout(450);
    const now = (await replies.last().innerText().catch(() => emitted)) || emitted;
    if (now !== emitted) {
      if (now.startsWith(emitted)) send({ type: 'delta', text: now.slice(emitted.length) });
      else send({ type: 'delta', text: now }); // re-render: resend whole
      emitted = now;
      stableSince = Date.now();
    } else if (emitted && Date.now() - stableSince > 2500) {
      break;
    }
  }
  send({ type: 'done', text: emitted.trim() });
}

// --- command loop (serialized; one in-flight op at a time) ----------------
let chain = Promise.resolve();
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }
  if (msg.cmd === 'quit') {
    chain.finally(async () => {
      if (cur) await cur.ctx.close().catch(() => {});
      process.exit(0);
    });
    return;
  }
  chain = chain
    .then(async () => {
      if (msg.cmd === 'status') return doStatus();
      if (msg.cmd === 'login') return doLogin();
      if (msg.cmd === 'send') return doSend(String(msg.text ?? ''));
    })
    .catch((e) => send({ type: 'error', message: String(e?.message || e) }));
});

send({ type: 'ready', provider: PROVIDER });
