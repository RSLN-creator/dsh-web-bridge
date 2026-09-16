// real-probe-19-newui.mjs - 2026-09-10 新版 DeepSeek 网页 UI 侦察。
//
// 用户侧证据（F12 Console）：输入框附近只剩「深度思考 / 智能搜索」两个
// aria-pressed 开关，没有任何模型 pill -> 驱动第一步就找不到触发器，
// 抛 MODEL_UI_CHANGED: 未找到模型选择器。
//
// 本探针只读地回答三件事：
//   1) 页面上还有没有模型选择器（输入框附近 / 全页 / 顶部栏）
//   2) 真实 POST /api/v0/chat/completion 的请求体：model_type / thinking_enabled / search_enabled
//   3) 同一请求的 SSE 骨架（片段类型集合），确认解码器仍适用
//
// 用法: node test-mock/real-probe-19-newui.mjs [--profile <dir>] [--headed]

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const PROFILE = argOf('--profile', 'd:\\9_Code_Workspace\\dsh-webcode-bridge\\.edge-real-profile');
const HEADED = argv.includes('--headed');
const EDGE = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
].find((c) => fs.existsSync(c));

if (!EDGE) { console.error('system Edge not found'); process.exit(2); }

const ctx = await chromium.launchPersistentContext(PROFILE, {
  executablePath: EDGE,
  headless: !HEADED,
  args: ['--no-first-run', '--no-default-browser-check', '--disable-blink-features=AutomationControlled'],
  viewport: { width: 1280, height: 900 },
});
const page = ctx.pages()[0] || (await ctx.newPage());
let exitCode = 0;

const requests = [];
page.on('request', (req) => {
  if (req.method() !== 'POST') return;
  if (!req.url().includes('/api/v0/chat/')) return;
  let body = null;
  try { body = req.postDataJSON(); } catch { body = req.postData(); }
  requests.push({ url: req.url(), body });
});

try {
  await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await page.waitForSelector('textarea', { timeout: 25_000 });
  await page.waitForTimeout(1500);

  const dom = await page.evaluate(() => {
    const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
    const describe = (el) => {
      const r = el.getBoundingClientRect();
      return {
        tag: el.tagName,
        role: el.getAttribute('role'),
        aria: el.getAttribute('aria-label'),
        pressed: el.getAttribute('aria-pressed'),
        text: (el.textContent || '').trim().slice(0, 40),
        cls: String(el.className || '').slice(0, 60),
        x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      };
    };
    const ta = [...document.querySelectorAll('textarea')].find(visible);
    if (!ta) return { error: 'no visible textarea' };

    let box = ta;
    for (let i = 0; i < 3 && box.parentElement; i++) box = box.parentElement;
    const toolbar = [...box.querySelectorAll('button, [role="button"], [aria-pressed], [aria-label]')]
      .filter(visible).map(describe);

    const MODEL_WORDS = /快速模式|专家模式|识图模式|深度思考|Flash|DeepSeek|Vision|模型|Model/i;
    const candidates = [];
    for (const el of document.querySelectorAll('button, [role="button"], [aria-pressed], [aria-haspopup], [class*="select" i], [class*="model" i]')) {
      if (!visible(el)) continue;
      const text = (el.textContent || '').trim();
      const aria = el.getAttribute('aria-label') || '';
      const cls = String(el.className || '');
      if (!MODEL_WORDS.test(text + ' ' + aria + ' ' + cls)) continue;
      candidates.push(describe(el));
    }
    return {
      url: location.href,
      textareaCls: ta.className,
      toolbar,
      modelCandidates: candidates.slice(0, 25),
      bodyHasExpert: /专家模式/.test(document.body.innerText),
      bodyHasFlash: /快速模式|Flash/.test(document.body.innerText),
      bodyHasVision: /识图模式/.test(document.body.innerText),
    };
  });
  console.log('=== DOM ===');
  console.log(JSON.stringify(dom, null, 1));

  const sseTexts = [];
  page.on('response', async (resp) => {
    if (!resp.url().includes('/api/v0/chat/')) return;
    try { sseTexts.push(await resp.text()); } catch { /* stream consumed */ }
  });

  const ta = page.locator('textarea').first();
  await ta.click();
  await ta.fill('只回答两个字：收到');
  await ta.press('Enter');
  await page.waitForTimeout(12_000);

  console.log('=== REQUEST BODIES ===');
  console.log(JSON.stringify(requests, null, 1));

  const raw = sseTexts.join('');
  const fragTypes = new Set();
  const topKeys = new Set();
  let thinkingEnabled = null;
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    let j; try { j = JSON.parse(line.slice(5).trim()); } catch { continue; }
    const ops = Array.isArray(j?.v) ? j.v : [j];
    for (const op of ops) {
      if (!op || typeof op !== 'object') continue;
      if (op.v?.response) thinkingEnabled = op.v.response.thinking_enabled ?? thinkingEnabled;
      if (op.v?.response?.fragments) {
        const fr = op.v.response.fragments;
        for (const f of (Array.isArray(fr) ? fr : [fr])) if (f?.type) fragTypes.add(f.type);
      }
      for (const key of Object.keys(op)) topKeys.add(key);
    }
  }
  console.log('=== SSE ===');
  console.log(JSON.stringify({ bytes: raw.length, thinkingEnabled, fragmentTypes: [...fragTypes], topKeys: [...topKeys] }, null, 1));

  const reply = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('[class*="markdown" i], .ds-markdown')];
    return nodes.map((n) => (n.textContent || '').trim()).filter(Boolean).slice(-3);
  });
  console.log('=== REPLY ===');
  console.log(JSON.stringify(reply, null, 1));
} catch (err) {
  console.error('PROBE ERR:', err?.message);
  exitCode = 1;
} finally {
  if (!requests.length) { console.log('NOTE: 没有捕获到 /api/v0/chat/ POST'); exitCode = 1; }
  await ctx.close().catch(() => {});
  process.exit(exitCode);
}
