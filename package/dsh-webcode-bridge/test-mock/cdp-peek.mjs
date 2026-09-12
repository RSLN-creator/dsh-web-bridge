// cdp-peek.mjs — 只读探针:经 DevToolsActivePort 连上正在运行的无头 Edge,
// 枚举页面与对话现场(URL / 输入框 / 最后一条助手消息),绝不 close browser。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const profileDir = process.argv[2] || path.join(process.env.DSH_HOME || path.join(process.env.HOME, '.dsh'), 'webcode-edge-profile');
const port = String(fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split('\n')[0]).trim();
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 8000 });
try {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      let info = { url: p.url() };
      try {
        info.title = await p.title().catch(() => null);
        info.viewport = p.viewportSize();
        info.state = await p.evaluate(() => {
          const tas = [...document.querySelectorAll('textarea')].map(t => ({ ph: t.placeholder || '', len: (t.value || '').length }));
          const lastText = [...document.querySelectorAll('.markdown, [data-message-author-role="assistant"], .ds-markdown')].pop();
          const bodyChars = (document.body?.innerText || '').length;
          const genBtn = [...document.querySelectorAll('div[role="button"]')].map(b => (b.getAttribute('aria-label') || b.textContent || '').trim()).filter(Boolean).slice(0, 8);
          return { tas, bodyChars, lastText: lastText ? (lastText.innerText || '').slice(0, 400) : null, genBtn };
        });
      } catch (e) { info.evalError = String(e?.message || e).slice(0, 160); }
      console.log(JSON.stringify(info, null, 1));
    }
  }
} finally { await browser.close().catch(() => {}); }
