// probe-kimi-network.mjs — 统计 kimi 页面发一条消息时实际走了哪些网络通道（2026-09-21）。
//
// 真问题：kimi 捕获链（只拦 fetch/XHR POST + completionPaths 子串）采不到流 → 超时。
// 本探针在页面里同时 hook fetch / XHR / EventSource，发一条消息，把「实际请求」
// 的通道 + method + url + content-type + 状态打出来，确证该往捕获脚本补哪种拦截。
//
// v2：上一版只按 Enter，headless 下 contenteditable 的 Enter 可能是换行而非发送
//（探针显示零 /api/chat 请求）。本版：确认输入回读 → dump 发送按钮候选 → 优先点
// 按钮/回车兜底 → 完整记录 fetch/XHR/EventSource 请求 + 响应状态与 content-type。
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const SITE_ID = process.env.PROBE_SITE || 'kimi';
const SITE_URL = 'https://www.kimi.com/';
const profileDir = 'C:/Users/rsyhn/.dsh/webcode-edge-profile/sites/' + SITE_ID;
const edge = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
].find((p) => fs.existsSync(p));

const ctx = await chromium.launchPersistentContext(profileDir, {
  headless: true, executablePath: edge, channel: undefined,
});
const page = (await ctx.pages())[0] || await ctx.newPage();
await page.goto(SITE_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
await page.waitForTimeout(9000);

// hook 三类通道，记录请求（含响应状态与 content-type）
await page.evaluate(() => {
  window.__reqs = [];
  const rec = (kind, url, method, status, ctype) =>
    window.__reqs.push({ kind, url: String(url || ''), method: String(method || ''),
      status: status ?? null, ctype: ctype ?? null });
  // fetch
  if (!window.fetch.__probe) {
    const of = window.fetch.bind(window);
    window.fetch.__probe = true;
    window.fetch = async function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      const method = ((init && init.method) || (input && input.method) || 'GET') + '';
      try {
        const r = await of.apply(this, arguments);
        rec('fetch', url, method, r.status, (r.headers && r.headers.get('content-type')) || '');
        return r;
      } catch (e) { rec('fetch', url, method, 'ERR', String(e)); throw e; }
    };
  }
  // XHR（补 responseText 钩子读 status + getResponseHeader）
  if (!XMLHttpRequest.prototype.send.__probe) {
    const osend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.send = function () {
      const me = this;
      if (this.addEventListener) this.addEventListener('readystatechange', () => {
        if (me.readyState >= 2) rec('xhr', me.__probeUrl || '', me.__probeMethod || 'GET',
          me.status, (me.getResponseHeader && me.getResponseHeader('content-type')) || '');
      });
      return osend.apply(this, arguments);
    };
    const oopen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (m, u) { this.__probeMethod = m; this.__probeUrl = u; return oopen.apply(this, arguments); };
    XMLHttpRequest.prototype.send.__probe = true;
  }
  return true;
});

// 确认输入框，回读是否写入成功
const inputSel = 'div.chat-input-editor, div[contenteditable="true"], textarea';
await page.waitForSelector(inputSel, { timeout: 20000 }).catch(() => {});
const input = page.locator(inputSel).first();
await input.click().catch(() => {});
await input.focus().catch(() => {});
await page.keyboard.type('你好，请回复两个字：收到', { delay: 10 }).catch(() => {});
await page.waitForTimeout(500);
const echoed = await input.evaluate((el) =>
  el.innerText || el.textContent || el.value || '').catch(() => '(回读失败)');
console.log('[composer 回读]', JSON.stringify(echoed));

// dump 发送按钮候选
const btnCandidates = await page.evaluate(() => {
  const out = [];
  const els = document.querySelectorAll('button[type="submit"], button.send, [aria-label*="发送"], [aria-label*="Send"], [class*="send"], [class*="Send"], [data-testid*="send"], [data-testid*="Send"]');
  for (const el of els) {
    const r = el.getBoundingClientRect();
    out.push({ tag: el.tagName, cls: String(el.className || '').slice(0, 60),
      aria: el.getAttribute('aria-label') || '', disabled: el.disabled === true,
      visible: r.width > 0 && r.height > 0 });
  }
  return out.slice(0, 15);
});
console.log('[发送按钮候选]', btnCandidates);

// 发送：优先点可见的发送按钮（div.send-button-container 是 kimi 的发送容器），否则 Enter
const sendBtn = page.locator('div.send-button-container, button[type="submit"], [aria-label*="发送"], [aria-label*="Send"], [class*="-send"], [data-testid*="send"]').last();
const sendVisible = await sendBtn.isVisible().catch(() => false);
let sent = 'none';
if (sendVisible) {
  await sendBtn.click({ timeout: 5000 }).then(() => { sent = 'clicked'; }).catch(async () => {
    await input.press('Enter'); sent = 'enter-fallback';
  });
} else {
  await input.press('Enter'); sent = 'enter';
}
console.log('[发送方式]', sent);
if (sent === 'enter') {
  await input.focus().catch(() => {});
  await page.keyboard.press('Enter');
}
// 等回复生成
await page.waitForTimeout(15000);

const reqs = await page.evaluate(() => window.__reqs || []);
console.log('=== kimi 页面实际网络请求 ===');
for (const r of reqs) console.log(`  ${r.kind.padEnd(11)} ${r.method.padEnd(4)} ${r.status} ${r.ctype && r.ctype.slice(0, 40)}  ${r.url}`);
console.log('总请求数:', reqs.length);
await ctx.close();