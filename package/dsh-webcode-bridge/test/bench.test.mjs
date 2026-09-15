// bench.test.mjs — 提示词基准实验判据层的护栏（0.14.8）。
//
// 这一层最容易被做坏的两处，本文件各钉一条：
//   ① **判据必须机器可判**。若允许「看起来对」这种判据，实验就退化成模型自评，
//      而 arXiv 2502.06065 明确说 LLM 判断不了哪个变体更好。
//   ② **汇总不得输出百分比提升**。每格样本 ≤3 次时百分比是把噪声包装成结论，
//      本文件用反向断言把这条纪律钉死（断言输出里不含 'percent'/'提升' 字段）。
//
// 另一条来自 0.14.6 的教训：协议残片检测必须**复用生产正则**。本层的
// collectRun 直接调用 agent-preset 的 findProtocolStart，不另写模式表——
// 否则检测器与被保护的正则共享盲区，「没告警」就是假阴性。

import test from 'node:test';
import assert from 'node:assert/strict';
import { collectRun, judgeRun, summarizeRuns } from '../lib/bench.js';

/** 造一个「一次调用 + 一段正文」的正常 chunk 流。 */
function okChunks({ name = 'pwsh', args = { command: 'Get-Date', description: 'get date' }, text = '完成。' } = {}) {
  return [
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name, arguments: JSON.stringify(args) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}

// ---------------------------------------------------------------- collectRun

test('collectRun：抽出调用名与参数、正文、收尾方式', () => {
  const run = collectRun(okChunks());
  assert.deepEqual(run.calls.map((c) => c.name), ['pwsh']);
  assert.equal(run.calls[0].args.command, 'Get-Date');
  assert.equal(run.text, '完成。');
  assert.equal(run.finishKind, 'tool-calls');
  assert.deepEqual(run.leaks, []);
});

test('collectRun：只有 text-delta 没有 text 块时，正文仍被取到（兜底路径）', () => {
  // 旧写法把 delta 塞进同一个数组再过滤，等于把这条兜底路径丢掉：
  // 只出 delta 的异常流会被误判成「正文为空」，于是 maxTextChars 判据永远通过。
  const run = collectRun([
    { type: 'text-delta', index: 0, text: '前半' },
    { type: 'text-delta', index: 0, text: '后半' },
    { type: 'finish', reason: { kind: 'stop' } },
  ]);
  assert.equal(run.text, '前半后半');
  assert.equal(run.textChars, 4);
});

test('collectRun：text 块存在时以块为准，不把 delta 与块重复计算', () => {
  const run = collectRun([
    { type: 'text-delta', index: 0, text: '完成。' },
    { type: 'block-end', index: 0, block: { type: 'text', text: '完成。' } },
  ]);
  assert.equal(run.textChars, 3, '同一段正文只应计一次');
});

test('collectRun：协议残片用生产正则检出（与 0.14.6 的盲区教训同源）', () => {
  const run = collectRun([
    { type: 'block-end', index: 0, block: { type: 'text', text: '正文 </call> 之后' } },
  ]);
  assert.equal(run.leaks.length, 1, 'findProtocolStart 认得的残片必须被检出');
  assert.match(run.leaks[0], /<\/call>/);
});

test('collectRun：干净正文不误报（<calling> 不是锚点）', () => {
  const run = collectRun([
    { type: 'block-end', index: 0, block: { type: 'text', text: '这个函数叫 calling()，不是协议标签' } },
  ]);
  assert.deepEqual(run.leaks, []);
});

test('collectRun：正文含 2 处残片时命中 2 处（</call> 与 </call_call> 都在候选集里）', () => {
  // 覆盖的是 0.14.6 那批真机形态：候选集只有复数 `calls` 时这两种都漏。此处的
  // 意义不止「记得住残片」——它同时是无限循环的守卫：旧实现每轮都从下标 0 重新
  // 命中同一处，命中数根本不可能是 2（会一直涨到堆耗尽）。
  const run = collectRun([
    { type: 'block-end', index: 0, block: { type: 'text', text: 'a </call> b </call_call> c' } },
  ]);
  assert.equal(run.leaks.length, 2);
  assert.deepEqual(run.leaks, ['</call> b </call_call> c', '</call_call> c']);
});

test('collectRun：多处残片必须返回且命中数正确（不得无界循环 → 修前是 OOM 不是超时）', () => {
  // 5000 字符里散布 50 个 </call>。**刻意不用超时断言**：旧实现在这里会因为
  // from 被写成 "[object Object]1" 而每轮从 0 重新命中，堆耗尽后由 V8
  // `FATAL ERROR: Reached heap limit` 打死进程（本机实测 ~4GB / 669849ms），
  // 超时断言根本来不及判。所以判据必须是**返回值本身的正确性**：
  // 修复后命中数恰好等于散布数，且每条命中都真的含残片锚点。
  const parts = [];
  for (let i = 0; i < 50; i += 1) parts.push(`正文${i} </call> `, 'x'.repeat(100));
  const long = parts.join('');
  assert.ok(long.length >= 5000, `构造的长文本应达到 5000 字符，实际 ${long.length}`);
  const run = collectRun([{ type: 'block-end', index: 0, block: { type: 'text', text: long } }]);
  assert.equal(run.leaks.length, 50, '散布 50 个残片就应恰好命中 50 处（多一处即游标没推进）');
  assert.equal(run.leaks.every((h) => /<\/call>/.test(h)), true);
  assert.equal(run.textChars, long.length);
});

test('collectRun：参数是对象时直接采用（不重复解析）', () => {
  const run = collectRun([{ type: 'block-end', index: 0, block: { type: 'tool-call', name: 'read', arguments: { path: 'a.md' } } }]);
  assert.deepEqual(run.calls[0].args, { path: 'a.md' });
});

test('collectRun：参数坏 JSON 时 args 为 null 而不是抛错', () => {
  const run = collectRun([{ type: 'block-end', index: 0, block: { type: 'tool-call', name: 'read', arguments: '{坏' } }]);
  assert.equal(run.calls[0].args, null);
});

test('collectRun：空/畸形输入不抛错', () => {
  for (const v of [undefined, null, [], [null, 1, 'x', {}]]) {
    assert.doesNotThrow(() => collectRun(v));
  }
});

// ---------------------------------------------------------------- judgeRun

test('judgeRun：全部判据通过时 pass 且无失败项', () => {
  const run = collectRun(okChunks());
  const r = judgeRun({ expectCalls: ['pwsh'], expectFinish: 'tool-calls', expectNoLeak: true, requireArgs: [{ index: 0, keys: ['command', 'description'] }] }, run);
  assert.equal(r.pass, true, r.failures.join('; '));
  assert.deepEqual(r.failures, []);
});

test('judgeRun：调用序列不符时给出期望与实际的对照', () => {
  const run = collectRun(okChunks());
  const r = judgeRun({ expectCalls: ['read', 'edit'] }, run);
  assert.equal(r.pass, false);
  assert.match(r.failures[0], /期望 \[read, edit\]/);
  assert.match(r.failures[0], /实际 \[pwsh\]/);
});

test('judgeRun：缺少必填参数被单独指出（这是实测里占比最高的失败）', () => {
  const run = collectRun(okChunks({ args: { command: 'Get-Date' } }));
  const r = judgeRun({ requireArgs: [{ index: 0, keys: ['command', 'description'] }] }, run);
  assert.equal(r.pass, false);
  assert.match(r.failures[0], /缺少必填参数 description/);
});

test('judgeRun：参数值精确比对（含类型，字符串 "1" 不等于数字 1）', () => {
  const run = collectRun(okChunks({ args: { offset: '1' } }));
  assert.equal(judgeRun({ expectArgsAt: [{ index: 0, key: 'offset', value: 1 }] }, run).pass, false);
  assert.equal(judgeRun({ expectArgsAt: [{ index: 0, key: 'offset', value: '1' }] }, run).pass, true);
});

test('judgeRun：收尾方式与正文长度上限都可判', () => {
  const run = collectRun(okChunks({ text: '一二三四五' }));
  assert.equal(judgeRun({ expectFinish: 'stop' }, run).pass, false);
  assert.equal(judgeRun({ maxTextChars: 3 }, run).pass, false);
  assert.equal(judgeRun({ maxTextChars: 5 }, run).pass, true);
});

test('judgeRun：expectNoLeak 对残片判失败，并给出命中片段', () => {
  const run = collectRun([{ type: 'block-end', index: 0, block: { type: 'text', text: 'x </call_call> y' } }]);
  const r = judgeRun({ expectNoLeak: true }, run);
  assert.equal(r.pass, false);
  assert.match(r.failures[0], /协议残片/);
});

test('judgeRun：未声明的判据一律不判（避免「顺手多判一条」导致误报）', () => {
  const run = collectRun([]);
  assert.equal(judgeRun({}, run).pass, true);
  assert.equal(judgeRun(undefined, run).pass, true);
});

test('judgeRun：畸形输入不抛错', () => {
  assert.doesNotThrow(() => judgeRun({ expectCalls: ['x'] }, null));
  assert.doesNotThrow(() => judgeRun({ requireArgs: [{ index: 0, keys: ['a'] }] }, undefined));
});

test('judgeRun：failures 仍是字符串数组、文案逐字未变，failureKinds 等长对齐', () => {
  // **公开契约**：failures 必须保持 string[] 且文案逐字不变——未来 harness 直接读它。
  // failureKinds 只是并列新增，不能顶替或改写 failures。
  const run = collectRun(okChunks({ args: { command: 'Get-Date' } }));
  const r = judgeRun({ requireArgs: [{ index: 0, keys: ['command', 'description'] }] }, run);
  assert.equal(Array.isArray(r.failures), true);
  assert.equal(r.failures.every((f) => typeof f === 'string'), true);
  assert.deepEqual(r.failures, ['第 0 个调用缺少必填参数 description']);
  assert.equal(r.failureKinds.length, r.failures.length, '两者必须等长');
  assert.deepEqual(r.failureKinds, ['requireArgs']);
  // 七个判据同时失败时两个数组都要跟着长，且顺序一一对应。这里刻意让正文里带
  // 一处残片，否则 expectNoLeak 不会触发（它只在 leaks.length 非零时判失败）。
  const leaky = collectRun([
    { type: 'block-end', index: 0, block: { type: 'text', text: '正文 </call> 之后' } },
    { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'c1', name: 'pwsh', arguments: JSON.stringify({ command: 'Get-Date' }) } },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ]);
  const all = judgeRun({
    expectCalls: ['read'], expectFinish: 'stop', maxTextChars: 0,
    expectNoLeak: true, expectTextIncludes: ['不存在的正文'],
    requireArgs: [{ index: 0, keys: ['description'] }],
    expectArgsAt: [{ index: 0, key: 'command', value: 'x' }],
  }, leaky);
  assert.equal(all.failures.length, 7, '七条判据都该失败：' + JSON.stringify(all.failures));
  assert.equal(all.failures.length, all.failureKinds.length);
  assert.equal(all.failures.every((f) => typeof f === 'string'), true);
  assert.deepEqual(all.failureKinds, [
    'expectCalls', 'expectArgsAt', 'requireArgs', 'expectFinish',
    'maxTextChars', 'expectNoLeak', 'expectTextIncludes',
  ]);
});

// ---------------------------------------------------------------- summarizeRuns

test('summarizeRuns：按变体聚合计数与失败类别', () => {
  const s = summarizeRuns([
    { variant: 'default', pass: true, failures: [], promptChars: 1000 },
    { variant: 'default', pass: false, failures: ['缺少必填参数 description'], promptChars: 1000 },
    { variant: 'reinstruct', pass: true, failures: [], promptChars: 1400 },
    { variant: 'reinstruct', pass: true, failures: [], promptChars: 1400 },
  ]);
  assert.equal(s.totalRuns, 4);
  assert.equal(s.totalPassed, 3);
  const dflt = s.variants.find((v) => v.variant === 'default');
  const rein = s.variants.find((v) => v.variant === 'reinstruct');
  assert.equal(dflt.runs, 2); assert.equal(dflt.passed, 1); assert.equal(dflt.failed, 1);
  assert.equal(rein.runs, 2); assert.equal(rein.passed, 2);
  // 这条 record 只有 failures、没有 failureKinds（老调用方形状）→ 走文案回落。
  // 回落规则必须认出「第 N 个调用缺少必填参数 X」这一族：此前它靠「取第一个冒号
  // 之前」猜类别，而这条文案没有冒号，于是整句被当类别名、还被 slice(0,24) 截成
  // '…descriptio'（2026-09-14 实测缺陷）。现在回落到稳定类别码 'requireArgs'。
  assert.equal(dflt.failureCounts.requireArgs, 1);
  // 明确断言：不得再出现被截断的键，也不得把整句文案当类别名。
  for (const key of Object.keys(dflt.failureCounts)) {
    assert.ok(!key.includes('descriptio'), '类别键不得是被截断的半截词：' + key);
    assert.ok(!key.includes('缺少必填参数 description'), '类别键不得是整句文案：' + key);
  }
  assert.equal(dflt.failureCounts['其他'], undefined, '已识别的文案不该落进兜底桶');
  // 老调用方还可能只留下被截过的片段（历史数据里就有这种形状）：同一族必须与
  // 完整文案落进同一个桶，否则同一批数据自己就会被拆成两类。
  const legacy = summarizeRuns([
    { variant: 'v', pass: false, failures: ['缺少必填参数 description'] },
    { variant: 'v', pass: false, failures: ['缺少必填参数 command'] },
  ]);
  assert.deepEqual(legacy.variants[0].failureCounts, { requireArgs: 2 });
  // 首轮长度是「精简 vs 默认」那一组的关键观测量，必须报 min/max/avg。
  assert.equal(dflt.promptCharsAvg, 1000);
  assert.equal(rein.promptCharsAvg, 1400);
});

test('summarizeRuns：同一判据的不同 key 归入同一个桶（实际缺陷回归点）', () => {
  // 实际缺陷（2026-09-14 实测）：两条都属于 requireArgs，只是缺的 key 不同，
  // 旧分类器却给出 {"第 0 个调用缺少必填参数 descriptio":1, "…command":1}
  // ——同一类问题被算成 2 类，且第一个键被 24 字符硬截断切坏了词。
  // 分布表的用途是「哪条判据失败得多」，不是「出现了几种措辞」。
  const s = summarizeRuns([{
    variant: 'v', pass: false,
    failures: ['第 0 个调用缺少必填参数 description', '第 0 个调用缺少必填参数 command'],
  }]);
  const counts = s.variants[0].failureCounts;
  assert.equal(Object.keys(counts).length, 1, '同类失败必须只占一个桶：' + JSON.stringify(counts));
  assert.equal(counts.requireArgs, 2, '两条都该计入 requireArgs');
});

test('summarizeRuns：优先用显式 failureKinds 分桶（类别不依赖文案标点）', () => {
  // judgeRun 产出的形状：failures 给人读，failureKinds 给机器分桶。文案里有没有
  // 冒号都不该影响归桶结果——这是把类别从「文案推断」变成「显式数据」的意义。
  const s = summarizeRuns([{
    variant: 'v', pass: false,
    failures: ['第 0 个调用缺少必填参数 description', '正文含协议残片 1 处：</call>'],
    failureKinds: ['requireArgs', 'expectNoLeak'],
  }]);
  assert.deepEqual(s.variants[0].failureCounts, { requireArgs: 1, expectNoLeak: 1 });
});

test('summarizeRuns：failureKinds 与 failures 不等长时按文案回落（不按下标错位）', () => {
  // 长度不等说明数据本身不自洽，此时按类别码取会张冠李戴；宁可回落到文案推断。
  const s = summarizeRuns([{
    variant: 'v', pass: false,
    failures: ['调用序列不符：期望 [a]，实际 [b]'],
    failureKinds: ['requireArgs', 'expectNoLeak'],
  }]);
  assert.deepEqual(s.variants[0].failureCounts, { expectCalls: 1 });
});

test('summarizeRuns：失败原因按类别归并（同一问题两种措辞不重复计数）', () => {
  const s = summarizeRuns([
    { variant: 'v', pass: false, failures: ['调用序列不符：期望 [a]，实际 [b]'] },
    { variant: 'v', pass: false, failures: ['调用序列不符：期望 [c]，实际 [d]'] },
  ]);
  assert.deepEqual(s.variants[0].failureCounts, { expectCalls: 2 });
});

test('summarizeRuns：leakRuns 与正文长度可核对', () => {
  const s = summarizeRuns([
    { variant: 'v', pass: false, failures: [], promptChars: 10, run: { leaks: ['</call>'], calls: [1] } },
    { variant: 'v', pass: true, failures: [], promptChars: 20, run: { leaks: [], calls: [1, 2] } },
  ]);
  assert.equal(s.variants[0].leakRuns, 1);
  assert.equal(s.variants[0].promptCharsMin, 10);
  assert.equal(s.variants[0].promptCharsMax, 20);
});

test('summarizeRuns：明确声明不做显著性检验（反向断言，防「顺手加个百分比」）', () => {
  const s = summarizeRuns([{ variant: 'v', pass: true, failures: [] }]);
  assert.equal(s.disclosure.significant, false);
  assert.match(s.disclosure.note, /不做显著性检验/);
  // 输出里不得出现任何「提升/百分比」字段——那需要样本量支撑。
  const keys = JSON.stringify(s).toLowerCase();
  for (const banned of ['lift', 'improvement', 'deltapercent', '提升百分比']) {
    assert.ok(!keys.includes(banned), '汇总里出现了不该有的字段：' + banned);
  }
});

test('summarizeRuns：空输入不抛错且给出空结论', () => {
  const s = summarizeRuns([]);
  assert.equal(s.totalRuns, 0);
  assert.deepEqual(s.variants, []);
});