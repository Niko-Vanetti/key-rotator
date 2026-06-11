// Drives the production web-chat daemon over its real JSON-lines protocol,
// exactly as the extension will. Proves status -> send -> done end-to-end.
// Usage: node scripts/web-bridge-e2e.mjs <provider> <profileDir>
import { spawn } from 'node:child_process';
import path from 'node:path';
import readline from 'node:readline';

const [provider, profile] = process.argv.slice(2);
if (!provider || !profile) {
  console.error('usage: web-bridge-e2e.mjs <provider> <profileDir>');
  process.exit(2);
}
const daemon = path.join(process.cwd(), 'src', 'ui', 'media', 'web-chat', 'bridge.mjs');
const child = spawn(process.execPath, [daemon, provider, profile], { stdio: ['pipe', 'pipe', 'inherit'] });
const rl = readline.createInterface({ input: child.stdout });

const waitFor = (pred, ms) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout waiting for ' + pred)), ms);
    const onLine = (line) => {
      let o;
      try {
        o = JSON.parse(line);
      } catch {
        return;
      }
      if (pred(o)) {
        clearTimeout(t);
        rl.off('line', onLine);
        resolve(o);
      }
    };
    rl.on('line', onLine);
  });

const sendCmd = (o) => child.stdin.write(JSON.stringify(o) + '\n');

await waitFor((o) => o.type === 'ready', 15000);
console.log('daemon ready');

sendCmd({ cmd: 'status' });
const st = await waitFor((o) => o.type === 'status', 60000);
console.log('status:', JSON.stringify(st));
if (!st.ready) {
  console.error('FAIL: not logged in for', provider);
  sendCmd({ cmd: 'quit' });
  process.exit(1);
}

let streamed = '';
const rl2 = readline.createInterface({ input: process.stdin }); // unused; keep stdout clean
rl2.close();
rl.on('line', (line) => {
  let o;
  try {
    o = JSON.parse(line);
  } catch {
    return;
  }
  if (o.type === 'delta') streamed += o.text;
});

sendCmd({ cmd: 'send', text: 'Responde unicamente con la palabra LISTO en mayusculas, nada mas.' });
const done = await waitFor((o) => o.type === 'done' || o.type === 'error' || o.type === 'login_needed', 200000);
console.log('final:', JSON.stringify(done));
console.log('streamed length:', streamed.length);

sendCmd({ cmd: 'quit' });
if (done.type === 'done' && /LISTO/i.test(done.text)) {
  console.log('PASS: web daemon send/receive works end-to-end');
  process.exit(0);
}
console.error('FAIL: unexpected final outcome');
process.exit(1);
