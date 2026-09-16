// cdp-freshcap.mjs — 定案探针:页面加载后重新注入一份新鲜的 XHR/fetch 包装,
// 发一条消息;若新鲜包装能捕获 chunk 而启动期的捕获不到,证明站点启动期
// 替换了 XHR 构造器/原型,启动期包装已脱离调用链。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const profileDir = process.argv[2] || path.join(process.env.DSH_HOME || path.join(process.env.HOME, '.dsh'), 'webcode-edge-profile');
const port = String(fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]).trim();
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 8000 });
try {
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const page = pages[pages.length - 1];
  console.log('PAGE:', page.url());

  const cap = await page.evaluate(() => ({
    xhrCtorSrc: String(XMLHttpRequest).slice(0, 150),
    fetchSrc: String(window.fetch).slice(0, 150),
  }));
  console.log('CTOR/FETCH:', JSON.stringify(cap, null, 1));

  await page.evaluate(() => {
    window.__freshCap = { start: 0, chunk: 0, end: 0, lens: [] };
    const emit = (phase, text) => {
      const c = window.__freshCap;
      if (phase === 'start') c.start++;
      else if (phase === 'chunk') { c.chunk++; c.lens.push((text || '').length); }
      else if (phase === 'end') c.end++;
    };
    const TARGETS = ['/api/v0/chat/completion'];
    const hit = (u) => TARGETS.some((t) => String(u || '').includes(t));
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (method, url) {
      try { this.__freshInfo = { method: String(method || '').toUpperCase(), url: String(url || '') }; } catch {}
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      const info = this.__freshInfo;
      if (info && info.method === 'POST' && hit(info.url)) {
        emit('start');
        let lastLen = 0;
        const drain = () => { try { const t = this.responseText; if (t.length > lastLen) { emit('chunk', t.slice(lastLen)); lastLen = t.length; } } catch {} };
        const timer = setInterval(drain, 30);
        this.addEventListener('loadend', () => { clearInterval(timer); drain(); emit('end'); });
      }
      return origSend.apply(this, arguments);
    };
  });

  const input = page.locator('textarea').first();
  await input.fill('请只回复一个字:好');
  await input.press('Enter');
  await page.waitForTimeout(40000);
  const fresh = await page.evaluate(() => window.__freshCap);
  console.log('FRESHCAP:', JSON.stringify(fresh));
} finally { await browser.close().catch(() => {}); }
