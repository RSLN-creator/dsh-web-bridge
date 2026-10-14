// zai-decoder.test.mjs — Z.ai 真机帧的 decoder 护栏（长期问题 #30 的关闭判据）。
//
// ## 为什么这个文件存在
//
// #30「Z.ai 真实流帧格式未录制」从 2026-09-27 挂到 2026-10-14：当时只有**站点前端 bundle 的
// 代码证据**（推断），没有任何 wire 证据，因此 `providers.js` 的 `decoder` 字段**刻意不改**
// ——「已知解不出」好过「猜着解不出」。
//
// 2026-10-14 取得真机帧（用户人工跑 `test-mock/zai-capture-frames.mjs`），逐字存为
// `test/fixtures/zai-real-frames/zai-chat-2026-10-14.txt`，本条护栏就钉在这份**真字节**上。
//
// ## 判据分两层（都要）
//
// ① **真帧能解出**：正文 `你好呀`、思考非空、`complete:true`；
// ② **不重复**：`delta_content` 是增量、`content` 是快照——两者混用会「整段播两遍」。
//    本夹具里只有增量，但护栏用**合成帧**把「快照形态」也钉住，否则那半个坑没有防线。
//
// 反向验证（先红后绿，2026-10-14 实跑）：把 `decoder: 'zai'` 换回 `'openai-sse'` ⇒ ③ 变红；
// 去掉 `phase==='thinking'` 分流 ⇒ ② 变红。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PKG = path.resolve(HERE, '..');
const FIXTURE = path.join(PKG, 'test', 'fixtures', 'zai-real-frames', 'zai-chat-2026-10-14.txt');

await import(pathToFileURL(path.join(PKG, 'lib', 'decoder.js')).href);
const D = globalThis.WebCodeStreamDecoders;

/** 用真机夹具跑一遍，返回 finish() 结果与增量统计。 */
function runOnFixture(kind, { chunkSize = 7 } = {}) {
  const raw = fs.readFileSync(FIXTURE, 'utf8');
  const deltas = []; const thinks = [];
  const d = new D[kind]({ onDelta: (t) => deltas.push(t), onThink: (t) => thinks.push(t), onImage: () => {} });
  // 按线上形状**分块**喂入：decoder 必须在任意切分点都能正确重装帧
  for (let i = 0; i < raw.length; i += chunkSize) d.push(raw.slice(i, i + chunkSize));
  const out = d.finish();
  return { out, deltas, thinks, raw };
}

test('① 真机夹具：zai decoder 解出正文与思考，且标记完成', () => {
  const { out } = runOnFixture('zai');
  assert.equal(out.complete, true, '应判完成（末帧 data.done=true）');
  assert.equal(out.text, '你好呀', '正文应为「你好呀」（真机页面渲染的正是这三个字）');
  assert.ok(out.thinking.length > 100, '思考应非空（夹具里有 8 条 phase=thinking 帧）');
});

test('② 增量不重复：正文只播一遍，思考也只播一遍', () => {
  const { out, deltas, thinks } = runOnFixture('zai');
  // 正文只出现一次（若把思考也当正文、或对累积串不做差分，这里会 >1）
  assert.equal(deltas.length, 1, '正文增量应恰好 1 条');
  assert.equal(deltas.join(''), '你好呀');
  assert.equal(out.text, deltas.join(''), '累积正文应等于增量之和（无重复）');
  // 思考：8 条增量、拼接后等于累积（同样不允许重复）
  assert.equal(thinks.join(''), out.thinking, '思考增量之和应等于累积思考（无重复）');
});

test('③ 快照形态也不重复播（合成帧：content 的语义）', () => {
  // `delta_content` 是增量、`content` 是快照 —— 站点前端解构里两个字段都在。
  // 本夹具只出现增量；这里补一组**累积形态**的合成帧，钉住「整段播两遍」那个坑。
  const d = new D.zai({ onDelta: () => {}, onThink: () => {}, onImage: () => {} });
  const frames = [
    { type: 'chat:completion', data: { delta_content: '你好', phase: 'answer' } },
    { type: 'chat:completion', data: { delta_content: '你好呀', phase: 'answer' } }, // 累积形态
    { type: 'chat:completion', data: { phase: 'done', done: true } },
  ];
  d.push(frames.map((f) => 'data: ' + JSON.stringify(f)).join('\n\n') + '\n\n');
  const out = d.finish();
  assert.equal(out.complete, true);
  assert.equal(out.text, '你好呀', '累积快照应只补新增后缀，不得整段重播（否则会得到「你好你好呀」）');
});

test('④ phase 分流：thinking 进思考、answer 进正文（不混）', () => {
  const { out } = runOnFixture('zai');
  assert.ok(!out.text.includes('The user is asking'), '思考内容不得混进正文');
  assert.ok(out.thinking.includes('The user is asking'), '思考内容应在思考里');
});

test('⑤ 任意切分点都解得出（流式重装的真实约束）', () => {
  for (const size of [1, 3, 17, 64, 997]) {
    const { out } = runOnFixture('zai', { chunkSize: size });
    assert.equal(out.text, '你好呀', `按 ${size} 字节切分时应仍解出正文`);
    assert.equal(out.complete, true, `按 ${size} 字节切分时应仍判完成`);
  }
});

test('⑥ 收尾认 data.done，不依赖 [DONE]（z.ai 不发 [DONE]）', () => {
  const { raw } = runOnFixture('zai');
  assert.ok(!raw.includes('[DONE]'), '夹具里确实没有 [DONE] —— 这正是要钉住的事实');
  const { out } = runOnFixture('zai');
  assert.equal(out.complete, true, '没有 [DONE] 也必须能判完成');
});

test('⑦ 注册表接线：providers.js 声明的 decoder 必须是 zai（不是 openai-sse）', async () => {
  const { SITES } = await import(pathToFileURL(path.join(PKG, 'lib', 'providers.js')).href);
  const zai = SITES.find((s) => s.id === 'zai');
  assert.equal(zai.decoder, 'zai', 'ZAI 的 decoder 必须指向本条 decoder（否则真帧解不出）');
  assert.ok(D.zai, '注册表里必须有 zai 这个 kind');
  // completionPaths 必须覆盖真机实际路径 /api/v2/chat/completions
  assert.ok(
    zai.completionPaths.some((p) => '/api/v2/chat/completions'.includes(p) || p === '/api/v2/chat/completions'),
    'completionPaths 必须覆盖真机的 /api/v2/chat/completions，实际为 ' + JSON.stringify(zai.completionPaths),
  );
});
