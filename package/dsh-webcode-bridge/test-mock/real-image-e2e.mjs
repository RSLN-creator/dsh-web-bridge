// real-image-e2e.mjs — 真机：通过桥的 OpenAI 兼容前端发一条**带图片**的消息，
// 观察整条链路（图片解析 → 网页附件上传 → 正文发送 → 流式回传）。
// 只读诊断，不做断言以外的副作用。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.join(os.tmpdir(), 'wc-imgtest');
const b64 = fs.readFileSync(path.join(dir, 'code.b64'), 'utf8').trim();
const dataUrl = 'data:image/png;base64,' + b64;

const body = {
  model: 'deepseek:deepseek',
  stream: true,
  messages: [
    { role: 'system', content: '你是图片识别助手。只回答用户问的内容，不要解释思路。' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '这张图里的字符是什么？只回字符本身。' },
        { type: 'image_url', image_url: { url: dataUrl } },
      ],
    },
  ],
};

const t0 = Date.now();
const res = await fetch('http://127.0.0.1:8931/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
console.log('[e2e] HTTP ' + res.status + ' ' + (res.headers.get('content-type') || '') + '  t+' + (Date.now() - t0) + 'ms');
if (!res.ok) {
  console.log('[e2e] body: ' + (await res.text()).slice(0, 2000));
  process.exit(1);
}

let content = '';
let think = '';
let images = 0;
const firstByteAt = { v: null };
const reader = res.body.getReader();
const dec = new TextDecoder();
let buf = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  if (firstByteAt.v === null) firstByteAt.v = Date.now() - t0;
  buf += dec.decode(value, { stream: true });
  const lines = buf.split('\n');
  buf = lines.pop() || '';
  for (const line of lines) {
    if (!line.startsWith('data: ')) continue;
    const payload = line.slice(6).trim();
    if (payload === '[DONE]') continue;
    let j;
    try { j = JSON.parse(payload); } catch { continue; }
    if (j.error) { console.log('[e2e] STREAM ERROR: ' + JSON.stringify(j.error).slice(0, 1500)); continue; }
    const delta = j.choices?.[0]?.delta || {};
    if (typeof j.content === 'string') content += j.content;
    if (typeof j.reasoning_content === 'string') think += j.reasoning_content;
    if (typeof delta.content === 'string') content += delta.content;
    if (typeof delta.reasoning_content === 'string') think += delta.reasoning_content;
    if (Array.isArray(j.images)) images += j.images.length;
  }
}
console.log('[e2e] first byte at t+' + firstByteAt.v + 'ms, total ' + (Date.now() - t0) + 'ms');
console.log('[e2e] content=' + JSON.stringify(content.slice(0, 400)));
console.log('[e2e] reasoning_chars=' + think.length + ' images_returned=' + images);
// 本轮之后的驱动读数（图片到底有没有真的送进去，读 imageTransport；正文投递读 attachTransport）
await new Promise(r => setTimeout(r, 2500));
const st = await fetch('http://127.0.0.1:8931/__webcode/status').then(r => r.json());
const d = st.driver || {};
console.log('[e2e] driver: lastEndReason=' + d.lastEndReason + ' imageTransport=' + JSON.stringify(d.imageTransport));
console.log('[e2e] driver: attachTransport=' + JSON.stringify(d.attachTransport) + ' lastTurnSession=' + (d.lastTurn?.sessionId || null));
console.log('[e2e] driver: domReplyChars=' + d.domReplyChars + ' lastRate=' + JSON.stringify(d.lastRate));
