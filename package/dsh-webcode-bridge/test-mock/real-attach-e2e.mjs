// real-attach-e2e.mjs — 真机：正文超过 attachInlineLimitChars（60000）时，是否真的
// 走**附件投递**（而不是灌进输入框）。判据取驱动读数 attachTransport。
const marker = 'A7Z' + Date.now().toString(36).toUpperCase();
// 造一段 70k 字符的正文，末尾埋一个可核对的问题（附件里必须能读到它）
const filler = '这是一段用于验证附件投递的长文本。'.repeat(5000); // ≈ 80k 字符
const total = filler.length;
const body = {
  model: 'deepseek:deepseek',
  stream: true,
  messages: [
    { role: 'system', content: '你是助手。用户消息很长，请只回答最后那句指令，不要复述正文。' },
    { role: 'user', content: filler + '\n\n只回答这串字符：' + marker },
  ],
};
const t0 = Date.now();
const res = await fetch('http://127.0.0.1:8931/v1/chat/completions', {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});
console.log('[attach] HTTP ' + res.status + ' t+' + (Date.now() - t0) + 'ms  payload=' + total + ' chars');
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
    const p = line.slice(6).trim();
    if (p === '[DONE]') continue;
    let j; try { j = JSON.parse(p); } catch { continue; }
    if (j.error) { err = j.error; continue; }
    const d = j.choices?.[0]?.delta || {};
    if (typeof d.content === 'string') content += d.content;
    if (typeof j.content === 'string') content += j.content;
  }
}
console.log('[attach] firstByte=t+' + firstByte + ' total=' + (Date.now() - t0) + 'ms');
console.log('[attach] error=' + (err ? JSON.stringify(err).slice(0, 300) : 'none'));
console.log('[attach] content=' + JSON.stringify(content.slice(0, 200)));
console.log('[attach] marker echoed=' + content.includes(marker));
await new Promise(r => setTimeout(r, 2500));
const st = await fetch('http://127.0.0.1:8931/__webcode/status').then(r => r.json());
const d = st.driver || {};
console.log('[attach] attachTransport=' + JSON.stringify(d.attachTransport));
console.log('[attach] lastEndReason=' + d.lastEndReason + ' imageTransport=' + JSON.stringify(d.imageTransport));
