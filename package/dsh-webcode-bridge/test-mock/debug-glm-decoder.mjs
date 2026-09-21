// debug-glm-decoder.mjs — 用真机捕获的 raw-frames.jsonl 喂 GlmDecoder，复现正文重复放大根因。
// 逐帧打印 emitText 的增量，定位「哪一帧触发了重复追加」。
import fs from 'node:fs';
import '../lib/decoder.js';

const GlmDecoder = globalThis.WebCodeStreamDecoders?.glm;
if (!GlmDecoder) { console.error('glm decoder not registered'); process.exit(1); }

const file = process.argv[2] || '.tmp/glm-replay/raw-frames.jsonl';
const raw = fs.readFileSync(file, 'utf8').trim();
const list = raw.startsWith('[') ? JSON.parse(raw) : framesFromJsonl(raw);

function framesFromJsonl(s) {
  return s.split('\n').map((l) => l.trim()).filter((l) => l && l.startsWith('{')).map((l) => JSON.parse(l));
}

const dec = new GlmDecoder();
const emitted = [];
dec.emitText = (t) => { emitted.push(['text', t]); };
dec.emitThink = (t) => { emitted.push(['think', t]); };
dec.pushImage = (i) => { emitted.push(['image', i]); };

let idx = 0;
const decisionLog = [];
for (const j of list) {
  idx++;
  // 打印本帧每个 text content 的决策
  let tIdx = 0;
  if (Array.isArray(j?.parts)) {
    for (const part of j.parts) {
      if (!part || !Array.isArray(part.content)) continue;
      for (const c of part.content) {
        if (!c || typeof c !== 'object') continue;
        if (String(c.type) === 'text') {
          tIdx++;
          const t = typeof c.text === 'string' ? c.text : '';
          const prev = dec.seen?.get('text') || '';
          let br;
          if (t === prev) br = 'same';
          else if (t.startsWith(prev)) br = 'append';
          else if (prev.startsWith(t)) br = 'stale';
          else br = 'NEW';
          decisionLog.push(`  f#${idx} t#${tIdx} status=${j.status} br=${br.padEnd(6)} prevlen=${prev.length} tlen=${t.length} pretext=${JSON.stringify(prev.slice(-18))}  t=${JSON.stringify(t.slice(0, 30))}`);
        }
      }
    }
  }
  try { dec.obj(j); } catch (e) { console.error('obj error at frame', idx, e.message); }
}
const res = dec.finish();
console.log('总帧数:', list.length);
console.log('--- 每帧 text 差分决策 ---');
for (const d of decisionLog) console.log(d);
console.log('全部 emit 事件数:', emitted.length);
const textTotal = emitted.filter(([k]) => k === 'text').reduce((n, [, t]) => n + t.length, 0);
console.log('text emit 总字符:', textTotal);
console.log('think emit 总字符:', emitted.filter(([k]) => k === 'think').reduce((n, [, t]) => n + t.length, 0));
console.log('\n--- text emit 序列（长度>0） ---');
let ti = 0;
for (const [k, t] of emitted) {
  if (k !== 'text' || !t) continue;
  ti++;
  console.log(`  text#${ti} len=${t.length}  ${JSON.stringify(t.slice(0, 50))}`);
}
console.log('\n--- 拼接后的完整 text ---');
console.log(JSON.stringify(res.text));
console.log('\nconversationId=', dec.conversationId, ' failed=', dec.failed, ' done=', dec.done);