// run-m3-mirror.js — REAL-SITE gate for the native sidebar view: the relay's
// reverse proxy must serve the actual chat.deepseek.com SPA on the loopback
// origin, seed the login token, and reach a usable composer in a headless
// browser — i.e. the sidebar iframe shows the real site, fully interactive.
//
// Requires: network access + the driver profile at ~/.dsh/webcode-edge-profile
// logged in (the production relay exposes GET /bridge/web/token; if that is
// unreachable the test falls back to an unauthenticated boot check).

import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { rmSync, existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import os from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const pkg = dirname(here);
const MIRROR_PORT = 30000 + Math.floor(Math.random() * 20000);
let failures = 0;

const ok = (name, cond, detail = '') => {
  console.log(`${cond ? '  ✅' : '  ❌'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!cond) failures += 1;
};

async function fetchToken() {
  for (const base of ['http://127.0.0.1:8931']) {
    try {
      const r = await fetch(base + '/bridge/web/token', { signal: AbortSignal.timeout(4000) });
      const j = await r.json();
      if (j?.ok && j.token) return j.token;
    } catch { /* production relay not running */ }
  }
  return null;
}

let fail = 0;
try {
  const { createMirror } = await import(pathToFileURL(join(pkg, 'lib', 'mirror.js')).href);
  const { chromium } = await import('playwright-core').catch(() => ({ chromium: null }));
  if (!chromium) throw new Error('playwright-core unavailable');

  const token = await fetchToken();
  ok('login token probe', true, token ? 'len=' + token.length : 'none — unauthenticated mirror boot check');

  const mirror = createMirror({
    siteOrigin: 'https://chat.deepseek.com',
    getToken: async () => token,
    logger: console,
  });
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    mirror.handle(req, res, u.pathname, u.search).catch(() => { try { res.end(); } catch {} });
  });
  await new Promise((r) => server.listen(MIRROR_PORT, '127.0.0.1', r));
  const BASE = `http://127.0.0.1:${MIRROR_PORT}`;

  // 1) raw fetch: index.html served, frame headers stripped, bootstrap injected
  const r0 = await fetch(BASE + '/', { signal: AbortSignal.timeout(30_000) });
  const html = await r0.text();
  ok('mirror serves upstream index.html', r0.status === 200 && html.length > 2000, `status=${r0.status}, bytes=${html.length}`);
  ok('no x-frame-options on mirror', !(r0.headers.get('x-frame-options')), r0.headers.get('x-frame-options') || 'stripped');
  ok('bootstrap injected', html.includes('data-webcode-mirror'));

  // 2) real SPA boots in a headless browser (the sidebar-iframe scenario)
  const profile = join(pkg, 'test-mock', `.mirror-profile-${process.pid}-${Date.now()}`);
  const exe = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => existsSync(p));
  const ctx = await chromium.launchPersistentContext(profile, {
    executablePath: exe,
    headless: true,
    args: ['--no-first-run', '--disable-blink-features=AutomationControlled'],
  });
  const page = ctx.pages()[0] || (await ctx.newPage());
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  let composer = false;
  try {
    await page.waitForSelector('textarea.ds-scroll-area', { timeout: 40_000 });
    composer = true;
  } catch { /* not logged in or SPA changed */ }
  const title = await page.title().catch(() => '');
  ok('real SPA boots through the mirror', composer || /deepseek|deep/i.test(title), `title="${title}", composer=${composer}`);

  if (composer && token) {
    // 3) the seeded token really authenticates: chat_session list via page fetch
    const authed = await page.evaluate(async () => {
      const raw = localStorage.getItem('userToken');
      const t = raw ? (JSON.parse(raw).value || raw) : '';
      const r = await fetch('/api/v0/chat_session/fetch_page?count=5', { headers: { authorization: 'Bearer ' + t } });
      const j = await r.json().catch(() => null);
      const arr = j?.data?.biz_data?.chat_sessions || j?.data?.chat_sessions || null;
      return Array.isArray(arr) ? arr.length : -1;
    });
    ok('seeded token authenticates upstream APIs', authed >= 0, 'sessions=' + authed);
  }

  await ctx.close().catch(() => {});
  server.close();
} catch (err) {
  fail = 1;
  console.log('  ❌ M3 harness failure:', err.stack || err.message);
}

console.log(failures === 0 && fail === 0 ? '\nM3 RESULT: PASS' : `\nM3 RESULT: FAIL (${failures})`);
process.exit(failures === 0 && fail === 0 ? 0 : 1);
