// dump-kimi-connect-hex.mjs — dump kimi Connect RPC 响应头部 hex，确证帧边界（2026-09-21）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const file = process.argv[2] || path.join(os.tmpdir(), 'kimi-connect-response.bin');
const buf = fs.readFileSync(file);
console.log('文件:', file, buf.length, 'bytes');

function hex(off, n) {
  const end = Math.min(off + n, buf.length);
  const bytes = [];
  const ascii = [];
  for (let i = off; i < end; i++) {
    bytes.push(buf.readUInt8(i).toString(16).padStart(2, '0'));
    const c = buf.readUInt8(i);
    ascii.push(c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : '.');
  }
  return { bytes: bytes.join(' '), ascii: ascii.join('') };
}

console.log('=== 前 240 字节 hex ===');
for (let off = 0; off < Math.min(buf.length, 240); off += 24) {
  const h = hex(off, 24);
  console.log(`${String(off).padStart(4)}: ${h.bytes.padEnd(71)}  ${h.ascii}`);
}

// 尝试常见的流式帧边界：搜索所有可能的 `{` 起始，看其前 5 字节。
console.log("=== JSON { 出现位置与前缀 hex ===");
const searches = [];
for (let i = 0; i < buf.length; i++) {
  if (buf.readUInt8(i) === 0x7b /* '{' */) {
    const start = Math.max(0, i - 5);
    const h = hex(start, Math.min(9, buf.length - start));
    searches.push({ at: i, pre: h.bytes, preAscii: h.ascii });
  }
}
const compact = searches.slice(0, 60);
for (const s of compact) console.log(`at=${s.at} pre5+4: ${s.pre}  ascii=${s.preAscii}`);
console.log('总 { 出现次数:', searches.length, '（仅显示前 60）');