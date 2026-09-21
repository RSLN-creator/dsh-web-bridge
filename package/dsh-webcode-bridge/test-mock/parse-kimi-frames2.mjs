// parse-kimi-frames2.mjs — 只看正文与收尾帧（2026-09-21）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const file = process.argv[2] || path.join(os.tmpdir(), 'kimi-connect-response.bin');
const buf = fs.readFileSync(file);
const text = buf.toString('utf8');
const out = [];
for (let i = 0; i < text.length; i++) {
  if (text[i] === '{') {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let j = i; j < text.length; j++) {
      const c = text[j];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
    }
    if (end > 0) {
      const raw = text.slice(i, end + 1);
      if (raw.length < 6000) { try { out.push(JSON.parse(raw)); } catch {} }
      i = end;
    }
  }
}
// 找 block.text 正文帧 + done 帧 + tool 帧 + 错误帧
console.log('=== 正文/收尾/工具/错误帧 ===');
let n = 0;
for (const f of out) {
  const s = JSON.stringify(f);
  const isText = /"mask"\s*:\s*"block\.text|"text"\s*:\s*\{/.test(s) && !/"think"\s*:/.test(s);
  const isTool = /tool|cited|search/i.test(s);
  const isDone = f.done === true || (s.includes('"done"') && s.includes('true'));
  const isErr = /error|ERROR|fail/i.test(s);
  const isThinkDone = /STAGE_STATUS_END|MESSAGE_STATUS_COMPLETED|MESSAGE_STATUS_GENERATING/.test(s) && /assistant/.test(s);
  if (isText || isTool || isDone || isErr || isThinkDone) {
    console.log(`[${n}][${f.op}] ${s.slice(0, 420)}`);
    if (++n >= 40) { console.log('  …(截断)'); break; }
  }
}
console.log('\n=== assistant message 终态帧 ===');
for (const f of out) {
  const s = JSON.stringify(f);
  if (f.message && f.message.role === 'assistant' && /STATUS_(COMPLETED|GENERATING|ERROR)/.test(s)) {
    console.log(JSON.stringify(f).slice(0, 300));
  }
}
console.log('\n=== 尾部 12 帧 ===');
out.slice(-12).forEach((f, i) => console.log(`[t${i}][${f.op||f.io_op}] ${JSON.stringify(f).slice(0, 200)}`));