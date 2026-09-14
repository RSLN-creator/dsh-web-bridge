// composer-write.test.mjs — 「网页输入框写入」的决策护栏（0.14.5）。
//
// 背景（真机证据，非推测）：2026-09-14 的会话 `session-c710ef6e` 的 turn/end 里
// 留下了一条直接证据：
//
//   locator.fill: Timeout 30000ms exceeded
//   - locator resolved to <textarea rows="2" name="search" … placeholder="给 DeepSeek 发送消息 ">
//   - fill("# 可用本地工具…(+807789)
//
// 一次性把 80 万字符交给 fill() 时，Playwright 在网页侧整段卡住，30s 后超时；
// 卡住期间没有任何中间态可读，事后只看到一个光秃秃的超时。
//
// 修法是把「多少算太长」（composerWritePlan）与「卡住怎么判」（stallStep）
// 抽成纯函数——这两个判断是会随站点变化的阈值语义，写成可断言的数据比埋在
// 两个 async 循环里可靠（与 composerStrategy 的既有做法一致）。
//
// 为什么这些用例不是空转：它们钉住的是**边界与反例**，即「改坏了会怎样」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { composerWritePlan, stallStep, composerStrategy } from '../lib/browser-driver.js';

// ---------------------------------------------------------- composerWritePlan

test('写入计划：小消息走 single（fill 最快，不引入额外往返）', () => {
  const p = composerWritePlan({ length: 500, chunkChars: 20_000 });
  assert.equal(p.mode, 'single');
  assert.equal(p.chunks, 1);
  assert.equal(p.total, 500);
});

test('写入计划：恰好等于块上限仍是 single（off-by-one 不能把整条消息拆成两块）', () => {
  const p = composerWritePlan({ length: 20_000, chunkChars: 20_000 });
  assert.equal(p.mode, 'single');
  assert.equal(p.chunks, 1);
});

test('写入计划：超过上限一块即分块，块数按 ceil 计算', () => {
  assert.equal(composerWritePlan({ length: 20_001, chunkChars: 20_000 }).mode, 'chunked');
  assert.equal(composerWritePlan({ length: 20_001, chunkChars: 20_000 }).chunks, 2);
  assert.equal(composerWritePlan({ length: 60_000, chunkChars: 20_000 }).chunks, 3);
  // 真机那条：807789 字符、默认 20000 → 41 块
  assert.equal(composerWritePlan({ length: 807_789, chunkChars: 20_000 }).chunks, 41);
});

test('写入计划：0 长度是 single 且 0 块（空消息不该假装写了一块）', () => {
  const p = composerWritePlan({ length: 0 });
  assert.equal(p.mode, 'single');
  assert.equal(p.chunks, 0);
});

test('写入计划：非法 chunkChars 走默认，并 clamp 到 [1000, 200000]', () => {
  // 0 / NaN / 负数 → 默认 20000（不是「每 0 字符一块」的死循环）
  for (const bad of [0, NaN, -5, null, undefined, 'abc']) {
    assert.equal(composerWritePlan({ length: 100, chunkChars: bad }).chunkChars, 20_000, 'chunkChars=' + bad);
  }
  // 极小值被抬到 1000：配置成 1 会把「卡死」换成「每字符一次 CDP 往返」，更糟
  assert.equal(composerWritePlan({ length: 100, chunkChars: 1 }).chunkChars, 1_000);
  // 极大值被压到 200000：否则又回到「一次性写太长」
  assert.equal(composerWritePlan({ length: 100, chunkChars: 10_000_000 }).chunkChars, 200_000);
});

test('写入计划：负数长度按 0 处理（不得出现 chunks=-1）', () => {
  const p = composerWritePlan({ length: -100, chunkChars: 20_000 });
  assert.equal(p.total, 0);
  assert.equal(p.chunks, 0);
});

// ---------------------------------------------------------------- stallStep

test('停滞判定：长度在涨就重置计数（正常写入不得被判死）', () => {
  let s = stallStep(-1, 20_000, 0);
  assert.equal(s.stalled, 0);
  assert.equal(s.died, false);
  s = stallStep(s.prevLen, 40_000, s.stalled);
  assert.equal(s.stalled, 0);
  s = stallStep(s.prevLen, 60_000, s.stalled);
  assert.equal(s.died, false);
});

test('停滞判定：单块不涨只记 1，连续两块才判死（富文本一拍延迟不得误杀）', () => {
  // 这一条是给 doubao/kimi 的：tiptap/ProseMirror 插入大块后需要一拍才把内部
  // 文档同步到 DOM，单块回读偶尔读到旧长度。只判一块会把正常站点误杀。
  let s = stallStep(20_000, 20_000, 0);
  assert.equal(s.stalled, 1);
  assert.equal(s.died, false, '单块不涨就判死会误杀富文本站点');
  s = stallStep(s.prevLen, 20_000, s.stalled);
  assert.equal(s.stalled, 2);
  assert.equal(s.died, true, '连续两块不涨必须判死，否则退回 30s 超时');
});

test('停滞判定：长度**变短**也计入停滞（被网页清空同样是卡住）', () => {
  const s = stallStep(20_000, 5_000, 0);
  assert.equal(s.stalled, 1);
  assert.equal(s.prevLen, 5_000);
});

test('停滞判定：回读失败（null）不计数、不重置、不判死', () => {
  // 元素被替换/页面转场时 readComposer 返回 null。据 null 判死会把「读不到」
  // 误报成「写不进」——那是另一类故障，由超时与错误码负责。
  const s = stallStep(20_000, null, 1);
  assert.equal(s.stalled, 1, 'null 不得重置已有计数');
  assert.equal(s.died, false);
  assert.equal(s.prevLen, 20_000);
});

test('停滞判定：prevLen 非数字时按 -1 起算（首块必须算「在涨」）', () => {
  const s = stallStep(undefined, 1_000, 0);
  assert.equal(s.stalled, 0);
  assert.equal(s.prevLen, 1_000);
});

// ------------------------------------------------- 与 composerStrategy 的一致性

test('两条策略并存：field 与 editable 都要能被分块计划覆盖', () => {
  // 真机形态：deepseek=textarea（field）、doubao/kimi=contenteditable（editable）。
  // 分块逻辑对两者都生效，但走不同写入路径——这里锁住「形态判定不因分块而改变」。
  assert.equal(composerStrategy({ tag: 'textarea', editable: false }), 'field');
  assert.equal(composerStrategy({ tag: 'div', editable: true }), 'editable');
  for (const kind of ['field', 'editable']) {
    const p = composerWritePlan({ length: 100_000, chunkChars: 20_000, kind });
    assert.equal(p.mode, 'chunked');
    assert.equal(p.kind, kind);
    assert.equal(p.chunks, 5);
  }
});
