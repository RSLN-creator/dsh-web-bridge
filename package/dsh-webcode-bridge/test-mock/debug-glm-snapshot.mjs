// debug-glm-snapshot.mjs — 复现 GlmDecoder 对真机抓包帧的去重是否失效。
// 用法：node test-mock/debug-glm-snapshot.mjs [sse-glm-*.log]
import fs from 'node:fs';
import path from 'node:path';

const file = process.argv[2]
  || path.join(process.env[process.platform === 'win32' ? 'TMP' : 'TMPDIR'] ?? '/tmp', 'glm-replay', 'sse-glm-1789973933106.log');
console.log('file:', file);
const lines = fs.readFileSync(file, 'utf8').split('\n').filter((x) => x.trim());

let idx = 0;
const frames = [];
for (const raw of lines) {
  let payload = raw;
  if (payload.startsWith('data:')) payload = payload.slice(5).trim();
  if (!payload.startsWith('{')) continue;
  let j; try { j = JSON.parse(payload); } catch { continue; }
  if (!j || typeof j !== 'object' || !Array.isArray(j.parts)) continue;
  frames.push({ idx: idx++, parts: j.parts });
}

// 打印每个 text 帧的全文 + 长度，标出 tool 帧边界
for (const f of frames) {
  const desc = [];
  for (const part of f.parts) {
    if (!Array.isArray(part.content)) continue;
    for (const c of part.content) {
      if (!c || typeof c !== 'object') continue;
      const type = String(c.type || '');
      if (type === 'text') {
        const t = String(c.text ?? '');
        desc.push(`TEXT[${t.length}] ${JSON.stringify(t)}`);
      } else if (type === 'think') {
        desc.push(`THINK len=${String(c.think ?? '').length}`);
      } else {
        desc.push(type);
      }
    }
  }
  console.log(`--- 帧 ${f.idx} ---`);
  for (const d of desc) console.log('   ' + d);
}