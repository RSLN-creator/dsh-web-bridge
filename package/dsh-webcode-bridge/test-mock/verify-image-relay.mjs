// verify-image-relay.mjs — 重启后的**完整真机验证**（一次跑完，无需外部干预）：
//   ① 把用户的图交给 deepseek 网页端（经桥，不手工碰浏览器）
//   ② 等网页真的回复
//   ③ 读驱动读数 imageTransport（图到底有没有真的附加上网页）
//   ④ 连到网页把**页面上落下的东西**读出来：用户消息里的图片节点是否真的加载
//      （naturalWidth>0 / blob 预览在）、那条 user 消息的字符数（判据：不是整段上下文）
//
// 用法：node test-mock/verify-image-relay.mjs [图片路径] [可选：附加的大正文倍数]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';

const imgPath = process.argv[2] || path.join(os.tmpdir(), 'wc-imgtest2', 'user-942k.png');
const b64 = fs.readFileSync(imgPath).toString('base64');
const bytes = fs.statSync(imgPath).size;
const fillerMult = Number(process.argv[3] || 0);
const filler = fillerMult > 0 ? '历史上下文占位。'.repeat(fillerMult) : '';

const body = {
  model: 'deepseek:deepseek', stream: true,
  messages: [
    { role: 'system', content: '你是图片理解助手。只回答用户问的，不要解释过程。' },
    { role: 'user', content: [
      { type: 'text', text: (filler ? filler + '\n\n' : '') + '这张图里画的是什么？一句话说清主体与颜色。' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
    ] },
  ],
};
console.log('[verify] image=' + imgPath + ' (' + bytes + ' bytes)  大正文≈' + filler.length + ' 字符');

const t0 = Date.now();
const res = await fetch('http://127.0.0.1:8931/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
let content = '', err = null, firstByte = null;
const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  if (firstByte === null) firstByte = Date.now() - t0;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n'); buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const p = line.slice(6).trim(); if (p === '[DONE]') continue;
    let j; try { j = JSON.parse(p); } catch { continue; }
    if (j.error) { err = j.error; continue; }
    const d = j.choices?.[0]?.delta || {};
    if (typeof d.content === 'string') content += d.content;
  }
}
console.log('[verify] HTTP ' + res.status + ' firstByte=t+' + firstByte + ' total=' + (Date.now() - t0) + 'ms');
console.log('[verify] error=' + (err ? JSON.stringify(err).slice(0, 300) : 'none'));
console.log('[verify] 网页端回复=' + JSON.stringify(content.slice(0, 220)));
await new Promise((r) => setTimeout(r, 2500));

// ③ 驱动读数
const st = await fetch('http://127.0.0.1:8931/__webcode/status').then((r) => r.json());
console.log('[verify] imageTransport=' + JSON.stringify(st.driver.imageTransport));
console.log('[verify] attachTransport=' + JSON.stringify(st.driver.attachTransport));
console.log('[verify] lastEndReason=' + st.driver.lastEndReason + ' promptTransport=' + st.driver.promptTransport);

// ④ 页面事实
try {
  const port = fs.readFileSync(path.join(os.homedir(), '.dsh', 'webcode-edge-profile', 'DevToolsActivePort'), 'utf8').split('\n')[0].trim();
  const browser = await chromium.connectOverCDP('http://127.0.0.1:' + port, { timeout: 8000 });
  const page = browser.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes('deepseek.com'));
  if (page) {
    const facts = await page.evaluate(() => {
      const bubbles = [...document.querySelectorAll('[class*="message"]')].map((n) => (n.innerText || '').trim());
      const imgs = [...document.querySelectorAll('img')].map((i) => ({ nw: i.naturalWidth, nh: i.naturalHeight, blob: (i.src || '').startsWith('blob:') }));
      return {
        url: location.href,
        userMsgChars: (bubbles[0] || '').length,
        userMsgHead: (bubbles[0] || '').slice(0, 160),
        imgTotal: imgs.length,
        imgLoaded: imgs.filter((i) => i.nw > 0).length,
        imgBroken: imgs.filter((i) => i.nw === 0).length,
        blobPreview: imgs.filter((i) => i.blob && i.nw > 0).length,
      };
    });
    console.log('[verify] 页面事实=' + JSON.stringify(facts, null, 2));
  } else {
    console.log('[verify] 页面上找不到 deepseek 页面');
  }
  await browser.close();
} catch (e) {
  console.log('[verify] CDP 读取失败（不影响主判据）：' + e.message);
}
