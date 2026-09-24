// real-image-bigctx-probe.mjs — 真机复现「附件投递模式下 deepseek 仍看到完整上下文」：
// 一轮里同时有**大正文**（超过 60000 阈值）与**一张图**，读页面看正文到底是
// 被替换成一句附件说明，还是整段灌进了输入框。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const dir = path.join(os.tmpdir(), 'wc-imgtest');
const b64 = fs.readFileSync(path.join(dir, 'code.b64'), 'utf8').trim();
const marker = 'M' + Date.now().toString(36).toUpperCase();
const filler = ('历史对话内容占位。'.repeat(3000)); // ≈ 27k 字符
const big = filler + '\n\n' + filler + '\n\n' + filler; // ≈ 81k 字符
console.log('[probe] message chars≈' + big.length);

const body = {
  model: 'deepseek:deepseek', stream: true,
  messages: [
    { role: 'system', content: '你是助手。' },
    { role: 'user', content: [
      { type: 'text', text: big + '\n\n图里的字符是什么？只回字符本身。' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
    ] },
  ],
};
const t0 = Date.now();
const res = await fetch('http://127.0.0.1:8931/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
let content = '', err = null;
const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const p = line.slice(6).trim(); if (p === '[DONE]') continue;
    let j; try { j = JSON.parse(p); } catch { continue; }
    if (j.error) { err = j.error; continue; }
    const d = j.choices?.[0]?.delta || {};
    if (typeof d.content === 'string') content += d.content;
    if (typeof j.content === 'string') content += j.content;
  }
}
console.log('[probe] HTTP ' + res.status + ' total=' + (Date.now() - t0) + 'ms');
console.log('[probe] error=' + (err ? JSON.stringify(err).slice(0, 200) : 'none'));
console.log('[probe] reply=' + JSON.stringify(content.slice(0, 120)));

const port = fs.readFileSync(path.join(os.homedir(), '.dsh', 'webcode-edge-profile', 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 8000 });
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('deepseek.com'));
const seen = await page.evaluate(() => {
  const bubbles = [...document.querySelectorAll('[class*="message"]')].map((n) => (n.innerText || '').trim());
  const first = bubbles[0] || '';
  const imgs = [...document.querySelectorAll('img')].map((i) => ({ nw: i.naturalWidth, blob: (i.src || '').startsWith('blob:') }));
  return {
    userMsgChars: first.length,
    userMsgHead: first.slice(0, 220),
    userMsgTail: first.slice(-220),
    isAttachmentNote: /已作为附件|webcode-context/.test(first),
    mentionsFullHistory: /历史对话内容占位/.test(first),
    imgOk: imgs.filter((i) => i.nw > 0).length,
    imgBroken: imgs.filter((i) => i.nw === 0).length,
  };
});
console.log('[page] ' + JSON.stringify(seen, null, 2));
await browser.close();
const st = await fetch('http://127.0.0.1:8931/__webcode/status').then((r) => r.json());
console.log('[driver] imageTransport=' + JSON.stringify(st.driver.imageTransport));
console.log('[driver] attachTransport=' + JSON.stringify(st.driver.attachTransport));
