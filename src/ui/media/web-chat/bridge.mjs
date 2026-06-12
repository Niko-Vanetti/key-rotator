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
import { execSync } from 'node:child_process';

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
    // In-chat models (role="radio" with data-model-type) and feature toggles
    // (.ds-toggle-button with aria-pressed). Verified live on chat.deepseek.com.
    models: [
      { id: 'default', label: 'Instant' },
      { id: 'expert', label: 'Experto' },
      { id: 'vision', label: 'Visión' },
    ],
    modelRadio: (id) => `div[role="radio"][data-model-type="${id}"]`,
    toggles: [
      { id: 'deepthink', label: 'Pensamiento Profundo' },
      { id: 'search', label: 'Búsqueda inteligente' },
    ],
    toggleSel: '.ds-toggle-button',
  },
};
const CFG = PROVIDERS[PROVIDER];
if (!CFG) {
  console.log(JSON.stringify({ type: 'fatal', message: `unknown provider ${PROVIDER}` }));
  process.exit(2);
}

// --- browser discovery ----------------------------------------------------
// We need a browser Playwright can drive. Prefer the user's own installed
// Chromium browser (so it's "their" browser, not a separate test Chromium),
// honoring their default; bundled Playwright Chromium is the last resort.
const firstExisting = (...cands) => cands.find((p) => p && fs.existsSync(p)) || null;
const PF = process.env['ProgramFiles'] || 'C:\\Program Files';
const PFx86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
const LAD = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');

// Known Chromium-family browsers and where their executables live (Windows).
const BROWSERS = {
  'opera-gx': () => firstExisting(path.join(LAD, 'Programs', 'Opera GX', 'opera.exe')),
  opera: () => firstExisting(path.join(LAD, 'Programs', 'Opera', 'opera.exe')),
  msedge: () =>
    firstExisting(
      path.join(PFx86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(PF, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    ),
  brave: () =>
    firstExisting(
      path.join(PF, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe'),
      path.join(LAD, 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')
    ),
  vivaldi: () => firstExisting(path.join(LAD, 'Vivaldi', 'Application', 'vivaldi.exe')),
  chrome: () =>
    firstExisting(
      path.join(PF, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(PFx86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(LAD, 'Google', 'Chrome', 'Application', 'chrome.exe')
    ),
};

// Windows default-browser ProgId -> our browser key.
const PROGID_MAP = [
  [/Opera.*GX/i, 'opera-gx'],
  [/Opera/i, 'opera'],
  [/MSEdge/i, 'msedge'],
  [/Brave/i, 'brave'],
  [/Vivaldi/i, 'vivaldi'],
  [/Chrome/i, 'chrome'],
];

function defaultBrowserKey() {
  try {
    const out = execSync(
      'reg query "HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice" /v ProgId',
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const m = /ProgId\s+REG_SZ\s+(\S+)/i.exec(out);
    if (m) {
      for (const [rx, key] of PROGID_MAP) if (rx.test(m[1])) return key;
    }
  } catch {
    /* no default detectable */
  }
  return null;
}

function bundledChromium() {
  const root = path.join(LAD, 'ms-playwright');
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
      ]) {
        if (fs.existsSync(exe) && Number(m[1]) > bestN) {
          best = exe;
          bestN = Number(m[1]);
        }
      }
    }
  } catch {
    /* no cache */
  }
  return best;
}

// The everyday user-data-dir of each browser (where the user's Google session
// lives). Used by the "real profile" mode so login is one-click with Google.
const APPDATA = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const REAL_PROFILE = {
  'opera-gx': path.join(APPDATA, 'Opera Software', 'Opera GX Stable'),
  opera: path.join(APPDATA, 'Opera Software', 'Opera Stable'),
  chrome: path.join(LAD, 'Google', 'Chrome', 'User Data'),
  msedge: path.join(LAD, 'Microsoft', 'Edge', 'User Data'),
  brave: path.join(LAD, 'BraveSoftware', 'Brave-Browser', 'User Data'),
  vivaldi: path.join(LAD, 'Vivaldi', 'User Data'),
};

// The browser key picked by the last findBrowser() call (for real-profile mode).
let CHOSEN_KEY = null;

// Resolve which browser to launch. `pref` comes from the KeyRotator setting
// (env KR_WEB_BROWSER): 'auto', a known key, or an absolute exe path.
function findBrowser() {
  CHOSEN_KEY = null;
  if (process.env.PW_CHROMIUM && fs.existsSync(process.env.PW_CHROMIUM)) return process.env.PW_CHROMIUM;
  const pref = (process.env.KR_WEB_BROWSER || 'auto').trim();
  if (pref && pref !== 'auto') {
    if (/[\\/]/.test(pref) && fs.existsSync(pref)) return pref; // explicit path
    if (BROWSERS[pref]) {
      const p = BROWSERS[pref]();
      if (p) {
        CHOSEN_KEY = pref;
        return p;
      }
    }
  }
  // Auto: the OS default browser, if it's a Chromium we can drive…
  const def = defaultBrowserKey();
  if (def && BROWSERS[def]) {
    const p = BROWSERS[def]();
    if (p) {
      CHOSEN_KEY = def;
      return p;
    }
  }
  // …else the first installed real browser (Chrome last, since it's often the
  // one people keep only for testing)…
  for (const key of ['opera-gx', 'opera', 'msedge', 'brave', 'vivaldi', 'chrome']) {
    const p = BROWSERS[key]();
    if (p) {
      CHOSEN_KEY = key;
      return p;
    }
  }
  // …else the bundled Playwright Chromium.
  return bundledChromium();
}

// A user-facing browser name for messages.
const BROWSER_NAMES = { 'opera-gx': 'Opera GX', opera: 'Opera', msedge: 'Microsoft Edge', brave: 'Brave', vivaldi: 'Vivaldi', chrome: 'Chrome' };

const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');

// --- single persistent context (headed for login, headless for sending) ---
let cur = null; // { ctx, page, headless }

async function ensure(headless) {
  if (cur && cur.headless === headless) return cur;
  if (cur) {
    await cur.ctx.close().catch(() => {});
    cur = null;
  }
  const exe = findBrowser();
  if (!exe) {
    send({
      type: 'error',
      message:
        'No encontré un navegador Chromium (Opera/Edge/Brave/Chrome) ni el Chromium de Playwright. Instala uno o ejecuta: npx playwright install chromium',
    });
    throw new Error('no browser');
  }

  // Real-profile mode: drive the user's everyday browser profile (their Google
  // session is there → one-click login), instead of the isolated profile.
  let userDataDir = PROFILE;
  let usingReal = false;
  if (process.env.KR_WEB_REAL_PROFILE === '1' && CHOSEN_KEY && REAL_PROFILE[CHOSEN_KEY] && fs.existsSync(REAL_PROFILE[CHOSEN_KEY])) {
    userDataDir = REAL_PROFILE[CHOSEN_KEY];
    usingReal = true;
  }

  let ctx;
  try {
    ctx = await chromium.launchPersistentContext(userDataDir, {
      headless,
      executablePath: exe,
      args: ['--disable-blink-features=AutomationControlled'],
      viewport: { width: 1280, height: 900 },
      userAgent: UA,
    });
  } catch (e) {
    const name = BROWSER_NAMES[CHOSEN_KEY] || 'tu navegador';
    if (usingReal && /singleton|already in use|ProcessSingleton|cannot create|in use|lock/i.test(String(e?.message))) {
      send({
        type: 'error',
        message: `Cierra ${name} por completo (incluido el icono de la bandeja del sistema: clic derecho → Salir) para que KeyRotator pueda usar tu perfil. Luego reintenta.`,
      });
    } else {
      send({ type: 'error', message: `No se pudo abrir ${name}: ${String(e?.message || e).slice(0, 120)}` });
    }
    throw e;
  }
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  cur = { ctx, page, headless };
  return cur;
}

const isAuth = (url) => CFG.authPage.test(url);
const hasComposer = async (page) => (await page.locator(CFG.composer).count()) > 0;
const chatReady = async (page) => !isAuth(page.url()) && (await hasComposer(page));

async function gotoChat(page) {
  await page.goto(CFG.url, { waitUntil: 'domcontentloaded' }).catch(() => {});
  await page.waitForTimeout(1200);
}

// Poll for the chat to become ready (logged in + composer present). A single
// fixed wait gave false "not logged in" when DeepSeek loaded slowly.
async function waitChatReady(page, ms = 14000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await chatReady(page)) return true;
    await page.waitForTimeout(500);
  }
  return chatReady(page);
}

async function doStatus() {
  const { page } = await ensure(true);
  await gotoChat(page);
  const ready = await waitChatReady(page);
  send({ type: 'status', ready, url: page.url() });
}

async function doLogin() {
  const { page } = await ensure(false); // headed so the user can sign in
  await gotoChat(page);
  if (await waitChatReady(page, 6000)) {
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

// Apply the requested in-chat model + feature toggles before sending.
async function applyOpts(page, opts) {
  if (!opts) return;
  if (opts.model && CFG.models && CFG.modelRadio) {
    const radio = page.locator(CFG.modelRadio(opts.model)).first();
    if (await radio.count()) {
      if ((await radio.getAttribute('aria-checked')) !== 'true') {
        await radio.click().catch(() => {});
        await page.waitForTimeout(300);
      }
    }
  }
  if (opts.toggles && CFG.toggles && CFG.toggleSel) {
    for (const tg of CFG.toggles) {
      if (!(tg.id in opts.toggles)) continue;
      const want = !!opts.toggles[tg.id];
      const btn = page.locator(`${CFG.toggleSel}:has(span:text-is(${JSON.stringify(tg.label)}))`).first();
      if (await btn.count()) {
        const pressed = (await btn.getAttribute('aria-pressed')) === 'true';
        if (pressed !== want) {
          await btn.click().catch(() => {});
          await page.waitForTimeout(200);
        }
      }
    }
  }
}

async function doSend(text, opts) {
  const { page } = await ensure(true);
  await gotoChat(page);
  if (!(await waitChatReady(page))) {
    send({ type: 'login_needed' });
    return;
  }
  await applyOpts(page, opts);
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
  if (msg.cmd === 'caps') {
    send({ type: 'caps', provider: PROVIDER, models: CFG.models ?? [], toggles: CFG.toggles ?? [] });
    return;
  }
  chain = chain
    .then(async () => {
      if (msg.cmd === 'status') return doStatus();
      if (msg.cmd === 'login') return doLogin();
      if (msg.cmd === 'send') return doSend(String(msg.text ?? ''), msg.opts);
    })
    .catch((e) => send({ type: 'error', message: String(e?.message || e) }));
});

send({
  type: 'ready',
  provider: PROVIDER,
  models: CFG.models ?? [],
  toggles: CFG.toggles ?? [],
});
