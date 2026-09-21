// analyze-kimi-connect.mjs — 解析已落盘的 kimi Connect RPC 响应，确证正文帧（2026-09-21）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = process.argv[2] || path.join(os.tmpdir(), 'kimi-connect-response.bin');
const buf = fs.readFileSync(file);
console.log('文件:', file, buf.length, 'bytes');
const frames = [];
let off = 0; let idx = 0;
while (off + 5 <= buf.length) {
  const flags = buf.readUInt8(off);
  const len = buf.readUInt32BE(off + 1);
  if (off + 5 + len > buf.length) break;
  const raw = buf.slice(off + 5, off + 5 + len);
  let json = null; let parseErr = null;
  try { json = JSON.parse(raw.toString('utf8')); } catch (e) { parseErr = String(e?.message || e).slice(0, 40); }
  frames.push({ idx, flags, len, json, parseErr, raw: raw.toString('utf8').slice(0, 120) });
  off += 5 + len; idx++;
  if (idx > 200) { console.log('  …(帧数过多截断)'); break; }
}
console.log('总帧数:', frames.length, '（后补帧不计）');

// 统计
const ops = {};
for (const f of frames) if (f.json) ops[f.json.io_op || f.json.op || f.json.type || '?'] = (ops[f.json.io_op || f.json.op || f.json.type || '?'] || 0) + 1;
console.log('帧 op 分布:', JSON.stringify(ops));

// 找带正文字段（text/content）的帧
console.log('\n=== 含正文/消息帧 ===');
let printed = 0;
for (const f of frames) {
  const j = f.json;
  if (!j) continue;
  const s = JSON.stringify(j);
  if (/text|content|message|assistant|cited|tool|search/i.test(s) && !/heartbeat/.test(s)) {
    console.log(`[帧${f.idx} flags=${f.flags} len=${f.len}] ${s.slice(0, 500)}`);
    if (++printed >= 40) { console.log('  …(正文帧过多截断)'); break; }
  }
}
if (!printed) console.log('（无匹配帧，全部帧如下）');
if (!printed) frames.forEach((f) => console.log(`[帧${f.idx}] ${JSON.stringify(f.json || f.parseErr || f.raw).slice(0, 300)}`));