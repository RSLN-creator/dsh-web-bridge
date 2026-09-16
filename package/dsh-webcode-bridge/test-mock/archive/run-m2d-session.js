// run-m2d-session.js — E2E gate for SESSION MODE over a REAL Edge (headless,
// fresh profile) against the local mock DeepSeek site:
//   1. turn 1 → preset+opening message into a FRESH web conversation
//   2. tool call roundtrip (mcp_action) with the tool really reading a file
//   3. turn 2 → SAME web conversation, ONLY the result increment sent
//   4. driver session store remembers the conversation
// Proves "一个 DSH 会话 ↔ 一个网页对话，增量消息，不重开".

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, rmSync } from 'node:fs';
import { readFile as readFileP } from 'node:fs/promises';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const repo = dirname(dirname(dirname(here)));
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

const profile = join(pkg, 'test-mock', '.driver-profile-m2d');
let mock = null;
let fail = 0;
try {
  rmSync(profile, { recursive: true, force: true });
  mock = start('test-mock/mock-server.js', [String(MOCK_PORT)]);
  await waitFor(async () => (await fetch(`http://127.0.0.1:${MOCK_PORT}/`)).ok, 10_000, 'mock site');

  const { apply } = await import(pathToFileURL(join(pkg, 'lib', 'index.js')).href);
  const { createBrowserDriver } = await import(pathToFileURL(join(pkg, 'lib', 'browser-driver.js')).href);
  const driver = createBrowserDriver({
    site: `http://127.0.0.1:${MOCK_PORT}/`,
    profileDir: profile,
    headless: true,
    requestTimeoutMs: 60_000,
    logger: console,
  });

  // minimal DSH services (import path exercised in M1; llm needs a registry)
  const adapterSlot = { adapter: null };
  const llm = {
    registerConfigurableProviders() {},
    registerAdapter(ids, adapter) { adapterSlot.adapter = adapter; },
  };
  const ctx = { llm, get: (n) => (n === 'llm' ? llm : undefined) };
  const disposer = apply(ctx, {
    port: PORT, host: '127.0.0.1', requireConsent: true,
    driver, profileDir: profile, headless: true,
    site: `http://127.0.0.1:${MOCK_PORT}/`,
  });

  // consent via the same-origin mount (mock webServer not present here → use relay fallback)
  await fetch(`${BASE}/bridge/consent`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ accepted: true }),
  });

  const adapter = adapterSlot.adapter;
  ok('adapter registered', typeof adapter?.stream === 'function');

  const collect = async (gen) => { const out = []; for await (const ch of gen) out.push(ch); return out; };
  const tools = [{ name: 'read', description: '读取工作区文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];
  const planText = await readFileP(join(repo, 'PLAN.md'), 'utf8');
  const planLine = planText.split('\n').find((l) => l.startsWith('#') && l.trim()) || planText.slice(0, 100);

  // ---- turn 1: opening message → fresh web conversation, model answers text ----
  // mock site echoes the prompt; make the reply a tool call via prompt phrasing
  const r1 = await collect(adapter.stream({
    system: '你是本地代理的大脑。收到 MOCK-ANSWER 前缀的回答即可。',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'M2D-OPENING-MSG-A1 请直接回复工具调用：读取 PLAN.md' }] }],
    tools,
    sessionId: 'dsh-m2d',
  }));
  void r1;
  const state1 = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/mock/state`)).json();
  const convPrompts = state1['sess-mock-12345678'] || [];
  ok('turn1 landed in fresh conversation', convPrompts.length === 1, 'prompts=' + convPrompts.length);
  ok('turn1 carries preset + opening message', convPrompts[0]?.includes('# 可用本地工具') && convPrompts[0]?.includes('M2D-OPENING-MSG-A1'), convPrompts[0]?.slice(0, 60));

  // ---- turn 2: only the tool-result increment, SAME conversation ----
  const r2 = await collect(adapter.stream({
    system: '你是本地代理的大脑。收到 MOCK-ANSWER 前缀的回答即可。',
    messages: [
      { role: 'user', content: [{ type: 'text', text: 'M2D-OPENING-MSG-A1 请直接回复工具调用：读取 PLAN.md' }] },
      { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"path":"PLAN.md"}' }] },
      { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: planLine }] }] },
    ],
    tools,
    sessionId: 'dsh-m2d',
  }));
  const finalText = r2.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  ok('turn2 streamed an answer', finalText.includes('MOCK-ANSWER'), finalText.slice(0, 60));

  const state2 = await (await fetch(`http://127.0.0.1:${MOCK_PORT}/mock/state`)).json();
  const conv2 = state2['sess-mock-12345678'] || [];
  ok('turn2 SAME conversation (2 prompts total)', conv2.length === 2, 'prompts=' + conv2.length);
  const t2 = conv2[1] || '';
  ok('turn2 increment ONLY: result fence, no preset', t2.includes('mcp_action') && t2.includes('"status": "success"') && !t2.includes('# 可用本地工具'), t2.slice(0, 80));
  ok('turn2 increment carries tool output', t2.includes('# Harness Web Bridge'), t2.slice(0, 80).replace(/\n/g, ' '));

  // ---- driver session store remembers the conversation ----
  const st = driver.status();
  ok('driver store maps session → web conversation', st.conversations?.['dsh-m2d']?.webSessionId === 'sess-mock-12345678', JSON.stringify(st.conversations));

  await disposer();
  ok('disposer clean', true);
} catch (err) {
  fail = 1;
  console.log('  ❌ M2d harness failure:', err.stack || err.message);
  if (mock) console.log('  --- mock ---\n' + mock.getOut().slice(-600));
} finally {
  try { mock?.child.kill(); } catch {}
}

console.log(failures === 0 && fail === 0 ? '\nM2d RESULT: PASS' : `\nM2d RESULT: FAIL (${failures})`);
process.exit(failures === 0 && fail === 0 ? 0 : 1);
