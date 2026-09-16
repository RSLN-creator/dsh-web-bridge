// zero-progress.test.mjs — 「本轮零进展」收尾顺序的护栏（0.15.5）。
//
// ## 为什么需要它（这是真机抓到的缺陷，不是假想）
//
// 真机现场：子代理会话 `ecad7b6a`（continuable，走 webcode 桥接）
//   step1  usage = { inputTokens: 26263, outputTokens: 197 }   ← 正常，调了一次 pwsh
//   step2  usage = { inputTokens: 28555, outputTokens: 0 }     ← 零输出
//          blocks = ["reasoning(201)"]                          ← 只有思考，正文一个字符都没来
//   turn/end reason = completed                                 ← agent loop 认为本轮「无事完成」
// 后果：子代理零产出（两篇笔记 MISSING、`reference/` 无任何新克隆）。
//
// 根因不是某条判据写错，而是**两条判据的先后顺序**：
//   旧实现先判「正文空 + withheld > 0」→ 静默 stop；
//   后判「正文空 + 思考非空」→ 给归因提示。
// 网页把全部内容都从思考通道送来时，finalText 里是被边界探测认出的协议文本
// （withheld > 0），于是这一类轮次全落进前一条分支被静默吞掉。
//
// 顺序错了在行为上只是一个 if 的位置——**任何只看行为的断言都很难看见它**。
// 所以本文件同时钉两件事：
//   ① 纯函数 `zeroProgressDecision` 的返回值语义（含该形态）；
//   ② 源码里两条判据的**顺序**（thinkAcc 判定必须先于 withheld 判定）。
//
// ## 反向验证纪律（本项目 doc/comment-style.md §9.3）
// 只写正向断言的护栏不算完成。本文件必须**先证明能红**：
// 把 zeroProgressDecision 里的两条判据换回旧顺序，顺序契约用例必须失败。
// 反向验证记录见 doc/verify.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { zeroProgressDecision } from '../lib/zero-progress.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = path.join(HERE, '..', 'lib', 'index.js');
const ZP_SRC = path.join(HERE, '..', 'lib', 'zero-progress.js');

// ---- ① 顺序契约：thinking-only 优先于 protocol-withheld ---------------------

test('正文空 + 思考非空 + 有扣留协议 → thinking-only（旧顺序会静默吞掉这一类）', () => {
  // 这一条就是真机 ecad7b6a step2 的形态：thinkAcc 有内容、out 为空、withheld > 0。
  assert.equal(zeroProgressDecision({
    out: '', thinkAcc: 'Need to search the .tmp-plugins.json file for the specific repo names',
    withheld: 480, imageCount: 0,
  }), 'thinking-only');
});

test('正文空 + 思考非空 + 无扣留 → thinking-only', () => {
  assert.equal(zeroProgressDecision({ out: '', thinkAcc: 'thinking…', withheld: 0 }), 'thinking-only');
});

test('正文空 + 思考也空 + 有扣留 → protocol-withheld（断流轮，静默收束）', () => {
  assert.equal(zeroProgressDecision({ out: '', thinkAcc: '', withheld: 320 }), 'protocol-withheld');
});

// ---- ② 正常路径不得被误伤 ---------------------------------------------------

test('有正文 → has-content（长回复绝不被这条判据碰）', () => {
  assert.equal(zeroProgressDecision({ out: '好的，我来处理。', thinkAcc: 'x'.repeat(500), withheld: 900 }), 'has-content');
});

test('只有空白正文 → 不算 has-content', () => {
  assert.equal(zeroProgressDecision({ out: '   \n  ', thinkAcc: 'think' }), 'thinking-only');
});

test('只出图不出字（识图轮）→ has-content，不按零进展处理', () => {
  assert.equal(zeroProgressDecision({ out: '', thinkAcc: '', withheld: 0, imageCount: 1 }), 'has-content');
});

// ---- ③ 全空不被吞掉：交给 assertNonEmpty 抛「空回复」 -----------------------

test('正文/思考/扣留/图片全空 → has-content（让 assertNonEmpty 去抛，不在这里静默）', () => {
  assert.equal(zeroProgressDecision({ out: '', thinkAcc: '', withheld: 0, imageCount: 0 }), 'has-content');
});

test('缺参数（undefined）不崩，且按全空处理', () => {
  assert.equal(zeroProgressDecision({}), 'has-content');
  assert.equal(zeroProgressDecision(undefined), 'has-content');
});

// ---- ④ 接线判据：收尾分支必须真的调这个纯函数 -------------------------------

// 判据刻意选「真实调用点」而不是「源码里有这个名字」：本项目 0.15.0 的教训是
// 源码文本断言正好放过了 `projectRoster is not defined` 那个真缺陷。
// 但纯函数无法从外部观察是否被调用，因此这里退一步做**结构断言 + 语义断言组合**：
// 断言调用点存在，且 decision 的两个分支都被消费。
test('接线：收尾分支调用 zeroProgressDecision 且消费两个分支', () => {
  const src = fs.readFileSync(INDEX_SRC, 'utf8');
  assert.match(src, /zeroProgressDecision\(\{ out, thinkAcc, withheld/, '收尾处必须调用该纯函数');
  assert.match(src, /decision === 'thinking-only'/, "必须消费 'thinking-only' 分支");
  assert.match(src, /decision === 'protocol-withheld'/, "必须消费 'protocol-withheld' 分支");
});

test('接线：thinking-only 分支必须发归因提示（不是静默 return）', () => {
  const src = fs.readFileSync(INDEX_SRC, 'utf8');
  const branch = src.slice(src.indexOf("decision === 'thinking-only'"));
  const head = branch.slice(0, 400);
  assert.match(head, /thinkingOnlyNotice\(/, 'thinking-only 必须走 thinkingOnlyNotice 发提示');
  assert.match(head, /emitText\(/, '提示必须真的外发到会话');
});

// ---- ⑤ 顺序契约：源码里 thinkAcc 判定必须先于 withheld 判定 -----------------
//
// 真机缺陷的根因就是这个顺序。行为断言（①）在两条判据都还在时就能抓到它，
// 但如果有人「顺手」把两条判据合并或调整位置，行为断言可能仍然全绿——
// 所以这里额外做一次**顺序核对**，把「顺序即契约」写死在源码文本上。
test('顺序契约：thinkAcc 判定必须先于 withheld 判定（旧顺序会变红）', () => {
  const src = fs.readFileSync(ZP_SRC, 'utf8');
  const body = src.slice(src.indexOf('export function zeroProgressDecision'));
  const iThink = body.indexOf("if (think.trim()) return 'thinking-only'");
  const iWithheld = body.indexOf("if (withheld > 0) return 'protocol-withheld'");
  assert.ok(iThink >= 0, '必须存在 thinking-only 判定');
  assert.ok(iWithheld >= 0, '必须存在 protocol-withheld 判定');
  assert.ok(iThink < iWithheld,
    'thinking-only 判定必须先于 protocol-withheld（真机缺陷正是顺序颠倒，见本文件头部）');
});
