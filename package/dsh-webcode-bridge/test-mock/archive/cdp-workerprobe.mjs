// cdp-workerprobe.mjs — 定案探针:completion 请求的 CDP initiator(是否 worker 发起)
// + page.workers() 清单 + worker 内 XHR/fetch 是否原生(未包装)。
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

  const workers = page.workers();
  console.log('WORKERS:', workers.length);
  for (const w of workers) {
    let info = { url: w.url().slice(0, 140) };
    try {
      info.fetchNative = /native code/.test(await w.evaluate(() => String(self.fetch)));
      info.xhrSendNative = /native code/.test(await w.evaluate(() => String(XMLHttpRequest.prototype.send)));
    } catch (e) { info.evalErr = String(e?.message || e).slice(0, 100); }
    console.log(' WORKER:', JSON.stringify(info));
  }

  const cdp = await ctx.newCDPSession(page);
  await cdp.send('Network.enable');
  const initiators = [];
  cdp.on('Network.requestWillBeSent', (e) => {
    if (e.request.url.includes('chat/completion') && e.request.method === 'POST') {
      initiators.push({
        url: e.request.url.slice(0, 120),
        initiatorType: e.initiator?.type,
        initiatorStackUrls: (e.initiator?.stack?.callFrames || []).slice(0, 4).map(f => f.url.slice(0, 120)),
        workerFrameless: !e.frameId,
      });
    }
  });
  const input = page.locator('textarea').first();
  await input.fill('请只回复一个字:好');
  await input.press('Enter');
  await page.waitForTimeout(45000);
  console.log('INITIATORS:', JSON.stringify(initiators, null, 1));
  await cdp.detach().catch(() => {});
} finally { await browser.close().catch(() => {}); }
