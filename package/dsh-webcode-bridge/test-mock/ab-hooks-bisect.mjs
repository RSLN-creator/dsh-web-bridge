#!/usr/bin/env node
// ab-hooks-bisect.mjs — 定位杀死应用初始化的钩子：基于当前 mirror.js 生成多个
// 「禁用单个钩子」的变体，各起一个实例（同一驱动 cookie），对比数据层是否启动。
// 判定口径：/api/v0/ 响应数（≥5 = 数据层活了）。
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';
import { createBrowserDriver } from '../lib/browser-driver.js';
import { getSite } from '../lib/providers.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const SRC = fs.readFileSync(path.resolve(process.cwd(), 'lib', 'mirror.js'), 'utf8');
const OUT = path.resolve(process.cwd(), '..', '..', '.tmp', 'hooktest');

/** 禁用表：每个钩子的「关掉」替换。单钩子存活测试 = 全关后放开一个。 */
const DISABLES = {
  fetch: [`if(fetch0)window.fetch=function(input,init){try{`, `if(false&&fetch0)window.fetch=function(input,init){try{`],
  xhr: [`XMLHttpRequest.prototype.open=function(method,url){try{`, `XMLHttpRequest.prototype.open=function(method,url){return open0.apply(this,arguments);try{`],
  ce: [`document.createElement=function(tag,opt){`, `document.createElement=function(tag,opt){return ce0(tag,opt);`],
  setattr: [`Element.prototype.setAttribute=function(name,value){`, `Element.prototype.setAttribute=function(name,value){return sa0.call(this,name,value);`],
  ih: [`if(ih0&&ih0.set&&ih0.get)Object.defineProperty`, `if(false&&ih0&&ih0.set&&ih0.get)Object.defineProperty`],
  wo: [`if(open0)window.open=`, `if(false&&open0)window.open=`],
};
const ALL = Object.keys(DISABLES);
const VARIANTS = ALL.map((keep) => [keep, ALL.filter((k) => k !== keep).map((k) => DISABLES[k])]);

const ports = [];
const variants = [];
for (const [name, pairs] of VARIANTS) {
  let out = SRC;
  for (const [from, to] of pairs) {
    if (!out.includes(from)) { console.log('ANCHOR-MISS', name, JSON.stringify(from.slice(0, 60))); process.exit(1); }
    out = out.split(from).join(to);
  }
  const file = path.join(OUT, `mirror-${name}.js`);
  fs.writeFileSync(file, out);
  variants.push({ name, file });
}

const driver = createBrowserDriver({
  site: 'https://chat.deepseek.com/', profileDir: path.join(os.homedir(), '.dsh', 'webcode-edge-profile'),
  headless: true, requestTimeoutMs: 120_000, logger: console,
});
let browser;
const servers = [];
try {
  const conn = await driver.connect();
  if (!conn.loggedIn) { console.log('NEED_LOGIN'); process.exit(3); }
  const site = getSite('deepseek');
  const exe = resolveBrowserExecutable();
  browser = await chromium.launch({ headless: true, executablePath: exe?.path || undefined });
  const ctx = await browser.newContext({ viewport: { width: 1380, height: 960 } });

  for (const v of variants) {
    const { createMirror } = await import(pathToFileURL(v.file).href);
    const mirror = createMirror({
      siteOrigin: 'https://chat.deepseek.com', getToken: () => driver.getToken(),
      assetOrigins: site?.staticOrigins || [], mountPrefix: '',
      getCookies: (o) => driver.profileCookies(o), setCookies: (h, o) => driver.writeProfileCookies(h, o),
      getUserAgent: () => driver.userAgent(),
      logger: { log: () => {}, warn: () => {} },
    });
    const port = 8950 + servers.length;
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://loopback');
      mirror.handle(req, res, u.pathname, u.search).then((h) => { if (!h) { res.writeHead(404); res.end(); } });
    });
    await new Promise((r) => server.listen(port, '127.0.0.1', r));
    servers.push(server);
    const page = await ctx.newPage();
    const api = [];
    page.on('response', (r) => { if (r.url().includes('/api/v0/')) api.push(r.status()); });
    await page.goto(`http://deepseek.localhost:${port}/`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(13_000);
    const text = await page.evaluate(() => String(document.body.innerText).slice(0, 120).replace(/\s+/g, ' '));
    console.log(`${v.name.padEnd(18)} /api/v0/ = ${String(api.length).padStart(2)}  alive=${api.length >= 5}  text="${text.slice(0, 60)}"`);
    await page.close();
  }
} catch (e) {
  console.log('ERR: ' + (e?.message || e));
} finally {
  try { browser && await browser.close(); } catch {}
  for (const s of servers) { try { s.close(); } catch {} }
  try { await driver.close(); } catch {}
}
