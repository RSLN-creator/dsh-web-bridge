// cdp-netprobe.mjs — 只读+单条消息探针:确认 deepseek 页面捕获脚本状态,
// 并在真实发送一条消息时枚举页面/worker 发出的 POST 请求(SSE 走向取证)。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const profileDir = process.argv[2] || path.join(process.env.DSH_HOME || path.join(process.env.HOME, '.dsh'), 'webcode-edge-profile');
const port = String(fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]).trim();
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 8000 });
try {
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page = pages[pages.length - 1]; // driver 最新会话页
  console.log('PAGE:', page.url());

  // 1) 捕获脚本是否在页面上、fetch/XHR 是否仍带包装
  const cap = await page.evaluate(() => ({
    installed: !!window.__webcodeCaptureInstalled,
    fetchSrc: (window.fetch || '').toString().slice(0, 300),
    xhrOpenSrc: (XMLHttpRequest.prototype.open || '').toString().slice(0, 200),
    hasServiceWorker: !!(navigator.serviceWorker && navigator.serviceWorker.controller),
  }));
  console.log('CAPTURE:', JSON.stringify(cap, null, 1));

  // 2) 发一条真实消息,枚举 60s 内的 POST(页面层)
  const posts = [];
  const onReq = (r) => { if (r.method() === 'POST') posts.push({ url: r.url().slice(0, 140), type: r.resourceType() }); };
  page.on('request', onReq);
  const input = page.locator('textarea').first();
  await input.fill('请只回复一个字:好');
  await input.press('Enter');
  await page.waitForTimeout(60000);
  page.off('request', onReq);
  console.log('POSTS(60s):', JSON.stringify(posts, null, 1));

  // 3) 60s 后页面是否出现回复文本
  const after = await page.evaluate(() => {
    const lastText = [...document.querySelectorAll('.markdown, [data-message-author-role="assistant"], .ds-markdown')].pop();
    return lastText ? (lastText.innerText || '').slice(0, 200) : null;
  });
  console.log('AFTER:', JSON.stringify(after));
} finally { await browser.close().catch(() => {}); }
