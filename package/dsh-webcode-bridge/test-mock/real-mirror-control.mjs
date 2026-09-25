#!/usr/bin/env node
// real-mirror-control.mjs — 对照实验：正在运行的真实镜像（deepseek.localhost:8931）
// 与独立探针实例（127.0.0.1:8932）在同一个无登录浏览器里各加载一次，
// 对比「SPA 是否发起 /api/ 数据请求」——隔离 origin 形态与实例差异两个变量。
import { createRequire } from 'node:module';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const exe = resolveBrowserExecutable();
const browser = await chromium.launch({ headless: true, executablePath: exe?.path || undefined });

async function probe(label, url) {
  const ctx = await browser.newContext({ viewport: { width: 1320, height: 940 } });
  const page = await ctx.newPage();
  const reqs = [];
  const errs = [];
  page.on('request', (r) => reqs.push(r.url()));
  page.on('pageerror', (e) => errs.push(String(e?.message || e).slice(0, 160)));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('[ce] ' + String(m.text()).slice(0, 160)); });
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await page.waitForTimeout(10_000);
  } catch (e) { errs.push('goto: ' + String(e?.message || e).slice(0, 120)); }
  const api = reqs.filter((u) => u.includes('/api/'));
  const composer = await page.locator('textarea').count().catch(() => -1);
  const text = await page.evaluate(() => String(document.body.innerText).slice(0, 200).replace(/\s+/g, ' ')).catch(() => '');
  console.log(`\n=== ${label} ===`);
  console.log('requests total:', reqs.length, '| /api/ calls:', api.length);
  for (const a of api.slice(0, 10)) console.log('  API:', a.slice(0, 140));
  console.log('composer:', composer, '| errors:', errs.length);
  console.log('page text:', text);
  await ctx.close();
}

await probe('真实镜像 deepseek.localhost:8931', 'http://deepseek.localhost:8931/');
await probe('独立探针 127.0.0.1:8932', 'http://127.0.0.1:8932/');
await browser.close();
