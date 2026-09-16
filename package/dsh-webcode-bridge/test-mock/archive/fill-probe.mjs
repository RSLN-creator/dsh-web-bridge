// fill-probe.mjs — 复现「长消息 fill+Enter 不发送」:分级长度测试
// 复用已运行后端的页面不可行(独立进程),所以独立拉起 driver(同 profile 会冲突——用 DSH 后端正在占用的 profile 不行)
// 改为:直接对运行中的 DSH 后端发不同长度的 OpenAI 请求,二分找出「还能发出」的长度上限。
import { readFileSync } from 'node:fs';

async function probe(n) {
  const filler = '长'.repeat(n);
  const body = JSON.stringify({ model: 'deepseek:flash', stream: false, messages: [{ role: 'user', content: '请只回复两个字:收到。忽略以下填充:' + filler }] });
  const t0 = Date.now();
  try {
    const resp = await fetch('http://127.0.0.1:8931/v1/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(120_000) });
    const j = await resp.json();
    const text = typeof j?.choices?.[0]?.message?.content === 'string' ? j.choices[0].message.content : JSON.stringify(j?.choices?.[0]?.message?.content ?? '');
    console.log(`len=${n} -> HTTP ${resp.status} in ${((Date.now()-t0)/1000).toFixed(1)}s | reply: ${text.slice(0, 40)}`);
    return resp.status === 200;
  } catch (e) {
    console.log(`len=${n} -> FAIL in ${((Date.now()-t0)/1000).toFixed(1)}s | ${e.message}`);
    return false;
  }
}

const sizes = [100, 1000, 5000, 20000, 60000];
for (const n of sizes) {
  const ok = await probe(n);
  if (!ok) { console.log('在', n, '字符处失败'); break; }
}
