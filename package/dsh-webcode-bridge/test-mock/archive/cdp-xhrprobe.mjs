// cdp-xhrprobe.mjs — 验证 drain 假设:hook 主线程 XHR,记录 completion 请求的
// responseType / progress 事件里 responseText 可读性 / loadend 时序。
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

  await page.evaluate(() => {
    window.__xhrLog = [];
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function (m, u) {
      this.__wcP = String(m).toUpperCase() === 'POST' && String(u).includes('chat/completion');
      if (this.__wcP) this.__wcRec = { rt: null, progress: [], errors: [], readyStates: [], loadEndAt: null };
      return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function () {
      if (this.__wcP && this.__wcRec) {
        const rec = this.__wcRec;
        window.__xhrLog.push(rec);
        const snap = () => ({
          rt: this.responseType,
          rs: this.readyState,
          rtLen: (() => { try { return this.responseText.length; } catch (e) { return 'ERR:' + e.name; } })(),
          respLen: (() => { try { return this.response ? (this.response.byteLength ?? this.response.size ?? String(this.response).length) : 0; } catch (e) { return 'ERR:' + e.name; } })(),
        });
        this.addEventListener('progress', () => { if (rec.progress.length < 6) rec.progress.push(snap()); });
        this.addEventListener('readystatechange', () => { if (rec.readyStates.length < 8) rec.readyStates.push(snap()); });
        this.addEventListener('loadend', () => { rec.loadEndAt = Date.now(); rec.final = snap(); });
      }
      return origSend.apply(this, arguments);
    };
  });

  const input = page.locator('textarea').first();
  await input.fill('请只回复一个字:好');
  await input.press('Enter');
  await page.waitForTimeout(40000);
  const log = await page.evaluate(() => window.__xhrLog);
  console.log('XHRLOG:', JSON.stringify(log, null, 1));
} finally { await browser.close().catch(() => {}); }
