#!/usr/bin/env node
// ab-mirror-versions.mjs — 「左侧会话历史加载失败」A/B 定位：
// 同一浏览器、同一探针，分别加载 0.19.13（用户确认正常）与 0.19.14 的镜像实例，
// 对比「应用的 HTTP 客户端是否发起请求」。判定口径：页内 fetch 包装的调用数
// （页加载前注入探针），不是网络观测——应用发起但失败的调用也算「层活着」。
import http from 'node:http';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const WT13 = pathToFileURL(path.resolve(process.cwd(), '..', '..', '.tmp-wt-13', 'package', 'dsh-webcode-bridge', 'lib', 'mirror.js')).href;
const CUR = pathToFileURL(path.join(process.cwd(), 'lib', 'mirror.js')).href;

const { createMirror: mirror13 } = await import(WT13);
const { createMirror: mirror14 } = await import(CUR);

// 两份实例用同一个「无 cookie」桩：本 A/B 只看应用发不发起请求，不看回包内容。
const stub = () => [];
const servers = [];
async function serve(mirror, port) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://loopback');
    mirror.handle(req, res, u.pathname, u.search).then((h) => { if (!h) { res.writeHead(404); res.end(); } })
      .catch(() => { try { res.writeHead(500); res.end(); } catch {} });
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  servers.push(server);
  return port;
}
const p13 = await serve(mirror13({ siteOrigin: 'https://chat.deepseek.com', getToken: async () => 'ab-token', getCookies: stub, setCookies: stub, logger: { log() {}, warn() {} } }), 8941);
const p14 = await serve(mirror14({ siteOrigin: 'https://chat.deepseek.com', getToken: async () => 'ab-token', getCookies: stub, setCookies: stub, logger: { log() {}, warn() {} } }), 8942);

const exe = resolveBrowserExecutable();
const browser = await chromium.launch({ headless: true, executablePath: exe?.path || undefined });
const ctx = await browser.newContext({ viewport: { width: 1380, height: 960 } });
const page = await ctx.newPage();
await page.addInitScript(() => {
  window.__probe = { fetch: [] };
  const f0 = window.fetch.bind(window);
  window.fetch = function (...args) {
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || args[0]?.href || String(args[0]));
    window.__probe.fetch.push(String(url).slice(0, 110));
    return f0(...args);
  };
});
for (const [label, port] of [['0.19.13', p13], ['0.19.14', p14]]) {
  await page.goto(`http://localhost:${port}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForTimeout(12_000);
  const probe = await page.evaluate(() => window.__probe.fetch.splice(0));
  const appCalls = probe.filter((u) => !/\.js|\.css|\.woff|\.wasm|\.svg|__static|\/wr\//.test(u));
  console.log(`=== ${label} === 页内 fetch 总数 ${probe.length}，应用层（非静态） ${appCalls.length}`);
  for (const u of appCalls.slice(0, 8)) console.log('   APP:', u);
  for (const u of probe.slice(0, 4)) console.log('   any:', u);
}
await browser.close();
for (const s of servers) s.close();
