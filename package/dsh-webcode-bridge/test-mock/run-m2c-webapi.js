// run-m2c-webapi.js — E2E gate for the web-side control plane over a REAL
// Edge (headless, fresh profile) against the local mock DeepSeek site.
//
//   1. consent → POST /bridge/web/sessions   (page-context userToken flow)
//   2. cross-site control request rejected (403)
//   3. POST /bridge/web/history → main line + branchCount
//   4. POST /bridge/web/import → unavailable without DSH host services
//   5. GET  /bridge/web/preview → real JPEG bytes from the driver page
//   6. POST /v1/chat/completions → turn lands in a tracked web session
//      (driver.lastTurn reflects the mock site's chat_session_id)

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const PORT = 30000 + Math.floor(Math.random() * 20000);
const MOCK_PORT = 30000 + Math.floor(Math.random() * 20000);
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

const profile = join(pkg, 'test-mock', '.driver-profile-m2c');
let bridge = null;
let mock = null;
try {
  rmSync(profile, { recursive: true, force: true });
  bridge = start('bin/bridge-standalone.js', [String(PORT)], {
    WEBCODE_SITE: `http://127.0.0.1:${MOCK_PORT}/`,
    WEBCODE_PROFILE_DIR: profile,
    WEBCODE_QUEUE_TIMEOUT_MS: '20000',
  });
  mock = start('test-mock/mock-server.js', [String(MOCK_PORT)]);

  await waitFor(async () => (await (await fetch(`${BASE}/bridge/status`)).json()).running, 10_000, 'relay');
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/`)).ok, 10_000, 'mock site');

  await fetch(`${BASE}/bridge/consent`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ accepted: true }),
  });

  // 1) sessions — page-context userToken flow (mock requires the Bearer token)
  const sess = await (await fetch(`${BASE}/bridge/web/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ count: 20 }),
  })).json();
  ok('web sessions via page-context auth', sess?.ok === true && sess.sessions?.[0]?.title?.includes('网页命名'), JSON.stringify(sess).slice(0, 160));

  // 2) cross-site guard on the control plane
  const csrf = await fetch(`${BASE}/bridge/web/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' }, body: '{}',
  });
  ok('cross-site control request rejected', csrf.status === 403, 'status=' + csrf.status);

  // 3) history with branch handling
  const hist = await (await fetch(`${BASE}/bridge/web/history`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-mock-12345678' }),
  })).json();
  ok('web history main-line + branches', hist?.ok === true && hist.count === 5 && hist.messages?.length === 4 && hist.branchCount === 1, `count=${hist.count}, line=${hist.messages?.length}, branch=${hist.branchCount}`);
  ok('branch message excluded from main line', !hist.messages?.some((m) => String(m.content).includes('重新生成的分支')), 'ok');

  // 4) import without DSH host services (standalone) → fixed unavailable text
  const imp = await (await fetch(`${BASE}/bridge/web/import`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sess-mock-12345678', workspaceId: 'ws-x' }),
  })).json();
  ok('import unavailable in standalone mode', imp?.ok === false && String(imp?.error || '').includes('不可用'), imp?.error);

  // 5) live preview — real JPEG from the driver page
  const pv = await fetch(`${BASE}/bridge/web/preview`);
  const buf = Buffer.from(await pv.arrayBuffer());
  ok('preview is a real JPEG', pv.status === 200 && (pv.headers.get('content-type') || '').includes('image/jpeg') && buf.length > 500, `bytes=${buf.length}`);
  const pvCsrf = await fetch(`${BASE}/bridge/web/preview`, { headers: { 'sec-fetch-site': 'cross-site' } });
  ok('preview cross-site rejected', pvCsrf.status === 403, 'status=' + pvCsrf.status);

  // 6) a real turn lands in a tracked web session
  const completion = await (await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'deepseek-web', messages: [{ role: 'user', content: 'M2c 会话追踪 XYZ999' }] }),
  })).json();
  const content = completion?.choices?.[0]?.message?.content || '';
  ok('completion via driver', completion?.object === 'chat.completion' && content.includes('MOCK-ANSWER'), `chars=${content.length}`);

  const st = await (await fetch(`${BASE}/bridge/status`)).json();
  ok('turn tracked to web session (naming source)', st?.driver?.lastTurn?.sessionId === 'sess-mock-12345678', JSON.stringify(st?.driver?.lastTurn));

  // sessions again — the fresh turn's session is in the live feed
  const sess2 = await (await fetch(`${BASE}/bridge/web/sessions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
  })).json();
  ok('sessions feed still live after turn', sess2?.ok === true && sess2.sessions?.length >= 2, `n=${sess2.sessions?.length}`);
} catch (err) {
  failures += 1;
  console.log('  ❌ M2c harness failure:', err.message);
  if (bridge) console.log('  --- bridge ---\n' + bridge.getOut().slice(-2500));
  if (mock) console.log('  --- mock ---\n' + mock.getOut().slice(-800));
} finally {
  try { mock?.child.kill(); bridge?.child.kill(); } catch {}
}

console.log(failures === 0 ? '\nM2c RESULT: PASS' : `\nM2c RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
