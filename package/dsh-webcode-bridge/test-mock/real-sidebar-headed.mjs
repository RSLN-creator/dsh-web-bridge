#!/usr/bin/env node
// real-sidebar-headed.mjs — 「左侧会话历史加载失败」定位第一步：
// headed（非 headless）浏览器加载**正在运行的真实镜像**（deepseek.localhost:8931，
// 0.19.14），排除 headless 检测干扰，看数据层（/api/ 请求）是否启动。
import { createRequire } from 'node:module';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const exe = resolveBrowserExecutable();
const browser = await chromium.launch({ headless: false, executablePath: exe?.path || undefined });
const ctx = await browser.newContext({ viewport: { width: 1380, height: 960 } });
const page = await ctx.newPage();
const reqs = [];
const errs = [];
page.on('request', (r) => reqs.push(r.url()));
page.on('pageerror', (e) => errs.push('[pageerror] ' + String(e?.message || e).slice(0, 200)));
page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + String(m.text()).slice(0, 200)); });
await page.goto('http://deepseek.localhost:8931/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
await page.waitForTimeout(14_000);
const api = reqs.filter((u) => u.includes('/api/'));
const text = await page.evaluate(() => String(document.body.innerText).slice(0, 260).replace(/\s+/g, ' ')).catch(() => '');
console.log('requests total:', reqs.length, '| /api/:', api.length);
for (const a of api.slice(0, 12)) console.log('  API:', a.slice(0, 150));
console.log('errors:', errs.length);
for (const e of errs.slice(0, 8)) console.log('  ', e);
console.log('page text:', text);
await browser.close();
