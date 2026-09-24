// real-user-image-probe.mjs — 真机：用**用户那张 942KB 的图**走桥，看图片是否真的
// 附加上网页（imageTransport），以及模型是否真的读到了。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = path.join(os.tmpdir(), 'wc-imgtest2');
const b64 = fs.readFileSync(path.join(dir, 'user-942k.b64'), 'utf8').trim();
const body = {
  model: 'deepseek:deepseek', stream: true,
  messages: [
    { role: 'system', content: '你是图片理解助手。只回答用户问的。' },
    { role: 'user', content: [
      { type: 'text', text: '这张图里画的是什么？一句话说清主体与颜色。' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } },
    ] },
  ],
};
const t0 = Date.now();
const res = await fetch('http://127.0.0.1:8931/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
let content = '', err = null, thinking = '';
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
    if (typeof d.reasoning_content === 'string') thinking += d.reasoning_content;
  }
}
console.log('[user-img] HTTP ' + res.status + ' total=' + (Date.now() - t0) + 'ms');
console.log('[user-img] error=' + (err ? JSON.stringify(err).slice(0, 400) : 'none'));
console.log('[user-img] reply=' + JSON.stringify(content.slice(0, 300)));
console.log('[user-img] thinkingHead=' + JSON.stringify(thinking.slice(0, 200)));
await new Promise((r) => setTimeout(r, 2500));
const st = await fetch('http://127.0.0.1:8931/__webcode/status').then((r) => r.json());
console.log('[user-img] imageTransport=' + JSON.stringify(st.driver.imageTransport));
console.log('[user-img] attachTransport=' + JSON.stringify(st.driver.attachTransport));
console.log('[user-img] lastEndReason=' + st.driver.lastEndReason);
