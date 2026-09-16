// repro-first-request.js — minimal repro: first JSON request after connect.
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const PORT = 30000 + Math.floor(Math.random() * 20000);

function start(cmd, args) {
  const child = spawn(process.execPath, [join(pkg, cmd), ...args], { cwd: pkg, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; process.stdout.write('[child] ' + d); });
  child.stderr.on('data', (d) => { out += d; process.stdout.write('[child-err] ' + d); });
  return { child };
}

const bridge = start('bin/bridge-standalone.js', [String(PORT)]);
const fake = start('test/fake-extension.js', ['--port', String(PORT)]);
await delay(2500);

const t0 = Date.now();
const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek-web', messages: [{ role: 'user', content: '首请求复现' }] }),
}).catch((e) => ({ error: e.message }));
console.log('JSON elapsed', Date.now() - t0, 'ms →', typeof res.error !== 'undefined' ? 'ERR ' + res.error : res.status);

// second request immediately (mimic M1 order: JSON then SSE)
const t1 = Date.now();
const res2 = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ model: 'deepseek-web', stream: true, messages: [{ role: 'user', content: '次请求' }] }),
});
await res2.text();
console.log('SSE elapsed', Date.now() - t1, 'ms →', res2.status);

fake.child.kill(); bridge.child.kill();
process.exit(0);
