// real-image-relay-probe.mjs — 真机：通过桥发一条**带图**的消息，发送完成后立刻
// 直连浏览器把「网页上真正落下的东西」读出来：
//   ① 用户消息的可见正文（判据：是不是被替换成「正文已作为附件 …」而不是全文）
//   ② 图片节点是否真的加载出来（naturalWidth>0），有没有空白/破图
//   ③ 附件节点（.md）是否真的挂在消息里
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const dir = path.join(os.tmpdir(), 'wc-imgtest');
const b64 = fs.readFileSync(path.join(dir, 'code.b64'), 'utf8').trim();
const marker = 'Q' + Date.now().toString(36).toUpperCase();

const body = {
  model: 'deepseek:deepseek', stream: true,
  messages: [
    { role: 'system', content: '你是图片识别助手，只回答用户问的。' },
    { role: 'user', content: [
      { type: 'text', text: '这张图里的字符是什么？只回字符本身。' },
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
console.log('[relay] HTTP ' + res.status + ' total=' + (Date.now() - t0) + 'ms  reply=' + JSON.stringify(content.slice(0, 80)));
console.log('[relay] error=' + (err ? JSON.stringify(err).slice(0, 200) : 'none'));

// 立刻直连浏览器读网页落下的东西
const port = fs.readFileSync(path.join(os.homedir(), '.dsh', 'webcode-edge-profile', 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 8000 });
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('deepseek.com'));
const seen = await page.evaluate(() => {
  const imgs = [...document.querySelectorAll('img')].map((i) => ({
    src: (i.src || '').slice(0, 60), nw: i.naturalWidth, nh: i.naturalHeight,
    blob: (i.src || '').startsWith('blob:'), alt: i.alt || '', cls: (i.className || '').toString().slice(0, 40),
  }));
  const bubbles = [...document.querySelectorAll('[class*="message"]')].map((n) => (n.innerText || '').trim());
  return {
    url: location.href,
    userMsg: bubbles[0] ? bubbles[0].slice(0, 400) : null,
    allMsgs: bubbles.map((t) => t.slice(0, 120)),
    imgTotal: imgs.length,
    imgOk: imgs.filter((i) => i.nw > 0).length,
    imgBroken: imgs.filter((i) => i.nw === 0),
    hasAttachmentText: /webcode-context|\.md/.test(document.body.innerText),
  };
});
console.log('[page] ' + JSON.stringify(seen, null, 2).slice(0, 2500));
await browser.close();

const st = await fetch('http://127.0.0.1:8931/__webcode/status').then((r) => r.json());
console.log('[driver] imageTransport=' + JSON.stringify(st.driver.imageTransport));
console.log('[driver] attachTransport=' + JSON.stringify(st.driver.attachTransport));
console.log('[driver] lastEndReason=' + st.driver.lastEndReason);
