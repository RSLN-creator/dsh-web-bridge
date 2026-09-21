// parse-kimi-frames.mjs — 容错解析 kimi Connect RPC 二进制流，列出所有 JSON 帧（2026-09-21）。
//
// 目的：确证 kimi 网页真实返回的帧 JSON 结构（正文在哪个字段、done 标志、会话 id），
// 为 KimiConnectDecoder 提供第一手证据，不猜。
//
// 方法：原始 Buffer 里所有合法 JSON 帧独立 JSON.parse（不依赖固定的 5 字节头，
// 因为实际流的帧头可能有页脚/分段前缀）。对每个能 parse 的 {..} 用括号配平提取。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = process.argv[2] || path.join(os.tmpdir(), 'kimi-connect-response.bin');
const buf = fs.readFileSync(file);
console.log('文件:', file, buf.length, 'bytes');

// 用括号配平提取所有独立 JSON 对象
const text = buf.toString('utf8');
const frames = [];
const extract = (s) => {
  const out = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '{') {
      let depth = 0, inStr = false, esc = false, end = -1;
      for (let j = i; j < s.length; j++) {
        const c = s[j];
        if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{') depth++;
        else if (c === '}') { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end > 0) {
        const raw = s.slice(i, end + 1);
        if (raw.length < 6000) { try { out.push(JSON.parse(raw)); } catch {} }
        i = end;
      }
    }
  }
  return out;
};

for (const j of extract(text)) frames.push(j);
console.log('解析出 JSON 对象:', frames.length, '/ 总 { 出现:', (text.match(/\{/g) || []).length);

const ops = {};
for (const f of frames) { const k = f.io_op || f.op || f.type || 'obj'; ops[k] = (ops[k] || 0) + 1; }
console.log('op 分布:', JSON.stringify(ops));

console.log('\n=== 类别筛选 ===');
const groups = { heartbeat: 0, chatMeta: 0, message: 0, blockText: 0, done: 0, other: 0 };
for (const f of frames) {
  const s = JSON.stringify(f);
  if (f.heartbeat) groups.heartbeat++;
  else if (f.chat && !f.message && !f.block) groups.chatMeta++;
  else if (f.message && (f.message.role === 'assistant' || f.message.role)) groups.message++;
  else if (f.block) groups.blockText++;
  else if (f.done) groups.done++;
  else groups.other++;
}
console.log('分组:', JSON.stringify(groups));

console.log('\n=== message / block 相关帧（前 25 条，含正文）===');
let n = 0;
for (const f of frames) {
  const s = JSON.stringify(f);
  if (/message|block|text|content|tool|cited/i.test(s) && !f.heartbeat) {
    console.log(`[${n}] ${s.slice(0, 380)}`);
    if (++n >= 25) { console.log('  …(截断)'); break; }
  }
}
if (!n) {
  console.log('（无内容帧，可能是空回复或格式异常）');
  console.log('\n=== 前 8 帧原始 ===');
  frames.slice(0, 8).forEach((f, i) => console.log(`[${i}] ${JSON.stringify(f).slice(0, 300)}`));
}