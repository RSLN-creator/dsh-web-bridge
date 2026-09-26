// repeat-detect.test.mjs — 钉住思维链「退化重复」检测（0.19.26，用户指令）。
//
// 这个检测的**代价不对称**：漏报只是回到既有的「整轮续跑」兜底（本来就有），
// 而误报会**打断一个正在正常输出的回复**。因此本文件里反例（不该触发）比正例更重要，
// 它们全部来自探针实测里**真实出现过的误报**，不是想出来的。
//
// 语料侧证据（不入库的一次性探针）：真实历史回复日志 4477 段 / 821,766 字符，
// 命中 0（0.00%）——即本判据在真实语料上没有误报面。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findDegenerateRepeat, tokenizeForRepeat } from '../lib/repeat-detect.js';

test('正例：真机形态的英文自我催促循环必须触发', () => {
  const text = 'Let me output the answer. '.repeat(2) + 'Let me output. OK. Writing. Go. '.repeat(30);
  const hit = findDegenerateRepeat(text);
  assert.ok(hit, '真机里最顽固的那种循环（lib/index.js:1372 记过）必须被抓到');
  assert.ok(hit.repeats >= 20, '重复次数应达到阈值，实得 ' + hit.repeats);
});

test('正例：任何语言/任何内容的固定周期重复都触发（通用，非词表）', () => {
  const cases = [
    ['Go. '.repeat(25), '英文短词'],
    ['继续'.repeat(25), '中文双字'],
    ['好的，我来处理。'.repeat(20), '中文整句'],
    ['TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO TODO', '大写词'],
  ];
  for (const [text, label] of cases) {
    assert.ok(findDegenerateRepeat(text), label + ' 应触发：' + JSON.stringify(text.slice(0, 30)));
  }
});

test('反例：正常中英文散文不得触发', () => {
  const cases = [
    'The user is asking about the repository state. I should check git status first, then look at the diff, and be careful not to miss uncommitted changes.',
    '用户问的是仓库状态。我应该先看 git status，再看 diff。这里要小心一点，不要漏掉未提交的改动，也不要凭记忆下结论。',
  ];
  for (const c of cases) assert.equal(findDegenerateRepeat(c), null, '不该触发：' + JSON.stringify(c.slice(0, 40)));
});

test('反例：markdown 列表 / 代码块等结构化内容不得触发（真实误报来源）', () => {
  const list = Array.from({ length: 25 }, (_, i) => `- item ${i}`).join('\n');
  const code = '```js\n' + Array.from({ length: 25 }, (_, i) => `const a${i} = ${i};`).join('\n') + '\n```';
  assert.equal(findDegenerateRepeat(list), null, '有序列表不是退化');
  assert.equal(findDegenerateRepeat(code), null, '代码块不是退化');
});

test('反例：纯装饰重复不得触发（探针实测的两个真实误报）', () => {
  // 这两条是 0.19.26 第一版判据的**实测误报**，催生了「周期里必须含实词字符」那条收窄。
  const dashes = 'Some thinking here about the problem and the plan.\n' + '-'.repeat(40);
  const tableRule = '思考：\n' + '| --- | --- | --- |\n'.repeat(25);
  assert.equal(findDegenerateRepeat(dashes), null, '长横线分隔线不是退化');
  assert.equal(findDegenerateRepeat(tableRule), null, '重复的表格分隔行不是退化');
});

test('反例：重复出现在中间、尾部已恢复正常时不得触发', () => {
  const text = 'Go. '.repeat(25) + ' 然后我决定不这么做了，改为直接输出结论。';
  assert.equal(findDegenerateRepeat(text), null,
    '只看尾部：循环已经结束就不再打断——本判据治的是「一直重复到被截断」');
});

test('阈值可配，且 20 是默认线（用户原话「20 次以上」）', () => {
  const text = 'Go. '.repeat(12);
  assert.equal(findDegenerateRepeat(text), null, '12 次 < 默认 20，不该触发');
  assert.ok(findDegenerateRepeat(text, { minRepeats: 10 }), '显式降到 10 就该触发');
});

test('tokenizeForRepeat 把 CJK 单字与 ASCII 词分开切', () => {
  const t = tokenizeForRepeat('Go 继续');
  assert.deepEqual(t, ['Go', ' ', '继', '续']);
});

test('空输入与非法输入不抛错（闸门自己先要稳定）', () => {
  for (const v of ['', null, undefined, 0, {}, []]) {
    assert.doesNotThrow(() => findDegenerateRepeat(v));
  }
});

// ---------------------------------------------------------------------------
// 接线：判据再对，不接进流式循环就等于没做
// ---------------------------------------------------------------------------
//
// 与 test/image-pricing.test.mjs ⑤ 同一纪律：纯函数单测全绿而**接线被删**是本仓库
// 反复出现过的失败形态（判据抽出来之后没人再调它）。

test('接线：两个流式循环都真的调用了探测，且命中即打断', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(src.includes("import { findDegenerateRepeat } from './repeat-detect.js';"),
    '接线被删：判据成孤儿，思维链循环再没人管');
  const calls = src.match(/findDegenerateRepeat\(thinkAcc\)/g) || [];
  assert.equal(calls.length, 2,
    '纯聊天轮与工具轮的 ev.think 分支各需一处探测，实得 ' + calls.length + ' 处');
  const breaks = src.match(/if \(thinkRepeat\) break;/g) || [];
  assert.equal(breaks.length, 2,
    '两处命中都必须 break（只探测不打断＝回到「耗光 idle 窗口再续跑」的旧行为），实得 '
    + breaks.length + ' 处');
});

test('接线：命中时归因提示换成循环专用文案，不再说「请重试一次」', () => {
  const src = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8');
  assert.ok(src.includes('function thinkingOnlyNotice(thinkAcc, scene, repeat = null)'),
    '归因函数必须接受重复读数，否则循环轮与普通 thinking-only 无法区分');
  assert.ok(src.includes('THINKING_REPEAT_DETECTED'),
    '循环轮必须有自己的提示前缀，便于在 reply-log 里直接检索');
  assert.ok(src.includes('repeat.repeats') && src.includes('repeat.sample'),
    '提示里必须带次数与样本原文（无读数的告警无法复核）');
});
