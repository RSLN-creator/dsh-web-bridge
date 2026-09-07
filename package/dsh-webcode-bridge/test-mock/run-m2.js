// run-m2.js — M2 gate: the REAL extension (test build) driven inside real
// Edge, against the local mock DeepSeek site, through the real relay.
//
//   1. build test extension (.test-build, mock matches + auto consent)
//   2. start relay (standalone, port 8931) + mock site (port 8932)
//   3. launch Edge with --load-extension and open the mock page
//   4. negative check: a WS client WITHOUT consent must be refused
//   5. POST /v1/chat/completions (JSON + SSE) → must return the mock answer
//      streamed through: relay → WS → SW → content script → DOM → page XHR
//      → SSE capture → decoder → deltas → relay → HTTP response
//   6. assert THINK text never leaks into the answer

import { spawn } from 'node:child_process';
import { rmSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const BRIDGE_PORT = 30000 + Math.floor(Math.random() * 20000); // isolated from any stale relay on 8931
const MOCK_PORT = 8932;
const BASE = `http://127.0.0.1:${BRIDGE_PORT}`;
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const { WebSocket } = await import('ws');
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

let bridge = null;
let mock = null;
let edge = null;
try {
  console.log('  building test extension...');
  await new Promise((resolve, reject) => {
    const b = spawn(process.execPath, [join(pkg, 'test-mock/build-test-extension.js')], { stdio: 'inherit' });
    b.on('exit', (c) => (c === 0 ? resolve() : reject(new Error('build failed'))));
  });

  bridge = start('bin/bridge-standalone.js', [String(BRIDGE_PORT)]);
  mock = start('test-mock/mock-server.js', [String(MOCK_PORT)]);

  await waitFor(async () => (await (await fetch(`${BASE}/bridge/status`)).json()).running, 8000, 'relay');
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/`)).ok, 8000, 'mock site');

  // negative FIRST (relay allows a single client): WS without consent is refused
  const refused = await new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${BRIDGE_PORT}/bridge`);
    socket.on('open', () => socket.send(JSON.stringify({ type: 'hello', site: 'evil.test', consent: { accepted: false } })));
    socket.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'hello-rejected') { resolve(true); socket.close(); }
      else if (msg.type === 'hello-ok') { resolve(false); socket.close(); }
    });
    socket.on('close', (code) => { if (code === 4003) resolve(true); });
    setTimeout(() => resolve(false), 5000);
  });
  ok('consent gate refuses un-consented clients', refused);
  await delay(500);

  // launch Edge (fresh profile dir per run: an existing instance would hand
  // off and reuse stale extension code)
  const profile = join(pkg, 'test-mock', '.edge-profile-run');
  rmSync(profile, { recursive: true, force: true });
  const extBuild = join(pkg, 'test-mock', '.test-build');
  edge = spawn(EDGE, [
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--disable-extensions-except=' + extBuild,
    '--load-extension=' + extBuild,
    `http://127.0.0.1:${MOCK_PORT}/`,
  ], { stdio: 'ignore', detached: false });

  // extension WS must come up (consent auto-accepted in test build)
  await waitFor(async () => {
    const st = await (await fetch(`${BASE}/bridge/status`)).json();
    return st.extensionConnected && st.consent;
  }, 30_000, 'extension WS with consent');
  console.log('  ✅ real extension connected to relay with consent (Edge loaded MV3 SW)');

  // JSON completion through the whole chain
  const completion = await (await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-web', messages: [{ role: 'user', content: 'M2 冒烟 ABC123' }] }),
  })).json();
  const content = completion?.choices?.[0]?.message?.content || '';
  ok('end-to-end JSON completion via Edge extension', completion?.object === 'chat.completion' && content.includes('MOCK-ANSWER'), `chars=${content.length}`);
  ok('prompt reached the mock page', content.includes('M2 冒烟 ABC123'), content.slice(0, 80));
  ok('THINK fragments never leak', !content.includes('思考片段'), content.slice(0, 80));

  // SSE completion
  const sseResp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-web', stream: true, messages: [{ role: 'user', content: 'M2 流式' }] }),
  });
  const raw = await sseResp.text();
  const frames = raw.split('\n').filter((l) => l.startsWith('data: '));
  const text = frames.slice(0, -1).map((f) => { try { return JSON.parse(f.slice(6)).choices?.[0]?.delta?.content || ''; } catch { return ''; } }).join('');
  ok('end-to-end SSE completion via Edge extension', frames[frames.length - 1] === 'data: [DONE]' && text.includes('MOCK-ANSWER'), `frames=${frames.length}, chars=${text.length}`);

} catch (err) {
  failures += 1;
  console.log('  ❌ M2 harness failure:', err.message);
  if (bridge) console.log('  --- bridge ---\n' + bridge.getOut().slice(-1500));
  if (mock) console.log('  --- mock ---\n' + mock.getOut().slice(-800));
} finally {
  try { if (edge) { spawn('taskkill', ['/PID', String(edge.pid), '/T', '/F'], { stdio: 'ignore' }); } } catch {}
  try { mock?.child.kill(); bridge?.child.kill(); } catch {}
}

console.log(failures === 0 ? '\nM2 RESULT: PASS' : `\nM2 RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
