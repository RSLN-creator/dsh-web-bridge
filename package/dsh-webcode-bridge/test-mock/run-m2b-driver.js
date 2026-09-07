// run-m2b-driver.js — E2E gate for the in-package driver architecture:
// standalone relay + playwright-driven system Edge (headless) against the
// local mock DeepSeek site. No extension involved.
//
//   1. consent gate starts closed → requests must not dispatch
//   2. POST /bridge/consent → gate opens
//   3. POST /v1/chat/completions (JSON) → mock answer via driver
//   4. POST /v1/chat/completions (SSE)  → chunk frames + [DONE]
//   5. THINK fragments never leak

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const PORT = 30000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let failures = 0;

const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures += 1;
};

function start(script, args, env = {}) {
  const child = spawn(process.execPath, [join(pkg, script), ...args], {
    cwd: pkg, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  return { child, getOut: () => out };
}

async function waitFor(fn, ms, label) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch {}
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label);
    await delay(200);
  }
}

const profile = join(pkg, 'test-mock', '.driver-profile');
let bridge = null;
let mock = null;
try {
  rmSync(profile, { recursive: true, force: true });
  bridge = start('bin/bridge-standalone.js', [String(PORT)], {
    WEBCODE_SITE: 'http://127.0.0.1:8932/',
    WEBCODE_PROFILE_DIR: profile,
    WEBCODE_QUEUE_TIMEOUT_MS: '20000',
  });
  mock = start('test-mock/mock-server.js', ['8932']);

  await waitFor(async () => (await (await fetch(`${BASE}/bridge/status`)).json()).running, 10_000, 'relay');
  await waitFor(async () => (await fetch('http://127.0.0.1:8932/')).ok, 10_000, 'mock site');

  const st0 = await (await fetch(`${BASE}/bridge/status`)).json();
  ok('consent gate starts closed', st0.consent === false && st0.requireConsent === true);

  // without consent, a request must fail FAST (a queued 300s wait froze the
  // DSH UI once — never again)
  const tRefused = Date.now();
  const refusedResp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-web', messages: [{ role: 'user', content: '不应被派发' }] }),
  });
  const refusedBody = await refusedResp.json();
  ok('no dispatch before consent (fast fail)', refusedResp.status === 503 && refusedBody?.error?.message?.includes('consent not granted') && Date.now() - tRefused < 5000, `status=${refusedResp.status}, ${Date.now() - tRefused}ms`);

  // consent
  await fetch(`${BASE}/bridge/consent`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accepted: true }),
  });
  const st1 = await (await fetch(`${BASE}/bridge/status`)).json();
  ok('consent accepted', st1.consent === true);

  // JSON completion through the driver
  const completion = await (await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-web', messages: [{ role: 'user', content: 'M2b 驱动冒烟 XYZ789' }] }),
  })).json();
  const content = completion?.choices?.[0]?.message?.content || '';
  ok('end-to-end JSON via in-package driver', completion?.object === 'chat.completion' && content.includes('MOCK-ANSWER'), `chars=${content.length}`);
  ok('prompt reached the mock page', content.includes('XYZ789'), content.slice(0, 80));
  ok('THINK fragments never leak', !content.includes('思考片段'), content.slice(0, 80));

  // SSE completion
  const sseResp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-web', stream: true, messages: [{ role: 'user', content: 'M2b 流式' }] }),
  });
  const raw = await sseResp.text();
  const frames = raw.split('\n').filter((l) => l.startsWith('data: '));
  const text = frames.slice(0, -1).map((f) => { try { return JSON.parse(f.slice(6)).choices?.[0]?.delta?.content || ''; } catch { return ''; } }).join('');
  ok('end-to-end SSE via in-package driver', frames[frames.length - 1] === 'data: [DONE]' && text.includes('MOCK-ANSWER'), `frames=${frames.length}, chars=${text.length}`);

  const st2 = await (await fetch(`${BASE}/bridge/status`)).json();
  ok('driver healthy after turns', st2.driver?.running === true && st2.busy === false, JSON.stringify({ running: st2.driver?.running, busy: st2.busy }));
} catch (err) {
  failures += 1;
  console.log('  ❌ M2b harness failure:', err.message);
  if (bridge) console.log('  --- bridge ---\n' + bridge.getOut().slice(-2000));
  if (mock) console.log('  --- mock ---\n' + mock.getOut().slice(-600));
} finally {
  try { mock?.child.kill(); bridge?.child.kill(); } catch {}
}

console.log(failures === 0 ? '\nM2b RESULT: PASS' : `\nM2b RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
