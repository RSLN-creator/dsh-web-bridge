// stall-settle.test.mjs — 「只有思维链、然后卡死」的第三条防线（0.15.2）。
//
// 用户报的原始现象（逐字）：「长时间后只有思维链卡住，harness 端，没有任何报错，
// 没有下一步」。它**不是** 0.14.0 修的那一类（那类是网页早写完了却没送 FINISHED，
// 靠 shouldSettleWip 的「流停 + DOM 停长」双条件秒级收束救回）。
//
// 本故障的结构性根因是那条双条件的盲区：思考阶段网页把「思考中 / Thought for Ns」
// 计时文案持续写进**同一个**助手节点，节点 innerText.length 因此一直变长，
// lastDomGrowthAt 被无休止刷新 → 「DOM 停长」永远不成立 → 收束器永不动作。
// 而看门狗按「最后一个增量」计时，思考增量同样刷新它，也判不出来。于是唯一兜底是
// 240s 总超时，且报错是通用 `web turn timed out`，看不出「只出了思维链」。
//
// 修法两条，缺一不可，本文件把两条都钉住：
//   ① answerDomLength：DOM 采样改量**剥掉计时文案后**的真实回答长度，
//      让「只剩计时器在动」重新等于「DOM 停长」；
//   ② shouldSettleStalledThinking：绝对墙钟判据，自最后一次**正文/图片**起超过
//      answerTimeoutMs 就收束，不看 DOM、不看思考。
//
// 安全线（反向断言，与正向同等重要）：
//   · 有正文在持续产出 → 永不命中，长回复绝不被腰斩；
//   · 只出图不出字（识图轮）合法 → 图片刷新 lastAnswerAt，不判卡死；
//   · 剥计时文案只认「整行是该形态」，正文里出现「思考中」三个字是内容，不能动。
import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { shouldSettleStalledThinking, answerDomLength } from '../lib/metrics.js';

const NOW = 1_000_000;   // performance.now() 口径即可，用固定数便于断言
const CAP = 180_000;     // 与 browser-driver.js 的 cfg.answerTimeoutMs 默认值一致

// ---- ① 绝对墙钟判据 -------------------------------------------------------

test('思考在动、正文没来、未到硬上限 → 不收束（防误杀正常长思考）', () => {
  assert.equal(shouldSettleStalledThinking({
    now: NOW, lastAnswerAt: NOW - 30_000, hardCapMs: CAP,
  }), false);
});

test('思考停、正文一个字符都没来、到硬上限 → 收束（本故障的主修）', () => {
  assert.equal(shouldSettleStalledThinking({
    now: NOW, lastAnswerAt: NOW - CAP, hardCapMs: CAP,
  }), true);
});

test('正文一直在产出 → 永不命中，长回复不被腰斩', () => {
  // 关键区别：正文增量刷新 lastAnswerAt。旧实现把它与「任何增量」混成一个时刻，
  // 于是「一直思考」与「思考完给正文」在判据上无法区分——本用例就是那条分界。
  assert.equal(shouldSettleStalledThinking({
    now: NOW, lastAnswerAt: NOW - 100, hardCapMs: CAP,
  }), false);
  // 即便思考已经跑了几十分钟，只要有正文在来就绝不收束。
  assert.equal(shouldSettleStalledThinking({
    now: NOW, lastAnswerAt: NOW - 1, hardCapMs: CAP,
  }), false);
});

test('恰好到上限即命中（>= 而非 >）', () => {
  assert.equal(shouldSettleStalledThinking({ now: NOW, lastAnswerAt: NOW - CAP, hardCapMs: CAP }), true);
  assert.equal(shouldSettleStalledThinking({ now: NOW, lastAnswerAt: NOW - (CAP - 1), hardCapMs: CAP }), false);
});

test('上限可配置：调小后更早收束（离线测试与真机可调）', () => {
  assert.equal(shouldSettleStalledThinking({ now: NOW, lastAnswerAt: NOW - 5_000, hardCapMs: 5_000 }), true);
  assert.equal(shouldSettleStalledThinking({ now: NOW, lastAnswerAt: NOW - 5_000, hardCapMs: CAP }), false);
});

test('上限为 0 或非法 → 判据整体关闭（不是「立刻收束」）', () => {
  // 0 必须被读成「关闭」而不是「0ms 上限」。读成后者的话，任何一次缺配置都会
  // 让每一轮在第一个 tick 就被判死——这是比不修更坏的回归。
  for (const cap of [0, -1, null, undefined, NaN, 'abc']) {
    assert.equal(shouldSettleStalledThinking({ now: NOW, lastAnswerAt: 0, hardCapMs: cap }), false,
      `hardCapMs=${String(cap)} 应关闭判据`);
  }
});

test('缺 lastAnswerAt 基线 → 不收束（不把「时间戳缺失」误判成「等满上限」）', () => {
  for (const base of [null, undefined, NaN]) {
    assert.equal(shouldSettleStalledThinking({ now: NOW, lastAnswerAt: base, hardCapMs: CAP }), false);
  }
});

// ---- ② DOM 采样剥计时文案 -------------------------------------------------

test('只剩「思考中」计时器 → 剥完长度为 0（这条让 DOM 停长重新成立）', () => {
  // 旧实现量的是 innerText.length，下面是 11 与 18 两个不同的长度——
  // 秒数每变一次就刷新一次 lastDomGrowthAt，收束器永远等不到稳态。
  assert.equal(answerDomLength('思考中'), 0);
  assert.equal(answerDomLength('思考中...'), 0);
  assert.equal(answerDomLength('深度思考中'), 0);
  assert.equal(answerDomLength('Thought for 12s'), 0);
  assert.equal(answerDomLength('Thought for 3 seconds'), 0);
  assert.equal(answerDomLength('已思考 45 秒'), 0);
  assert.equal(answerDomLength('Thinking'), 0);
});

test('计时文案后面跟着真实回答 → 只算回答的长度', () => {
  assert.equal(answerDomLength('思考中\n这是回答'), 4);
  assert.equal(answerDomLength('Thought for 12s\nHello there'), 11);
  // 计时行可以被多行连续剥掉（思考中途换过一次文案形态）。
  assert.equal(answerDomLength('思考中\nThought for 5s\n回答'), 2);
});

test('正文里出现「思考中」三个字是内容，不能被剥掉', () => {
  // 这条是剥除的边界：只认**整行**是该形态。模型在解释「思考中是什么意思」时，
  // 那行是正文；误剥会让 answerDomLength 变短，进而可能把正常轮次判成卡死。
  assert.equal(answerDomLength('我在思考中遇到了一个问题'), 12);
  assert.equal(answerDomLength('这段讲的是思考中'), 8);
  // 计时形态出现在中间、后面还有正文时也不能整段吃掉。
  assert.equal(answerDomLength('思考中\n然后继续写'), 5);
});

test('空输入与纯空白 → 0（不产生 NaN 污染比较）', () => {
  for (const v of ['', '   ', '\n\n', null, undefined]) {
    assert.equal(answerDomLength(v), 0);
  }
});

test('真实回答不受影响（含换行的多段正文按原文长度算）', () => {
  assert.equal(answerDomLength('第一段\n第二段'), 7);
  assert.equal(answerDomLength('code:\nconst a = 1;'), 18);
});

// ---- ③ 接线：配置必须真的到达判据 -----------------------------------------
//
// 这一组是**接线护栏**，与上面两组的「判据本身对不对」是两回事。
//
// 为什么必须单独钉：0.15.2 最初只加了 driver 那一侧的默认值，index.js 既没在
// DEFAULTS 声明 `answerTimeoutMs`、也没在 createBrowserDriver 时传进去。结果
// 行为是对的（driver 内部默认恰好也是 180s），但**配置层完全够不着它**——
// 任何人想调这个值都会发现自己改的东西没有任何效果。这类「静默不生效」缺陷
// 不会让任何断言变红，只会让下一次真机排障时少一个旋钮。
//
// 判据故意选「传进去能不能读到」而不是「默认值等于多少」：前者能抓住
// 「加了配置项但忘了接」这一整类问题，后者只能抓住某一次写错常量。

const NO_LAUNCH = {
  siteId: 'deepseek',
  site: 'https://chat.deepseek.com/',
  profileDir: path.join(os.tmpdir(), 'webcode-stall-test-no-launch'),
  headless: true,
};

test('driver 把构造时的 answerTimeoutMs 透出到 status（接线存在）', async () => {
  const { createBrowserDriver } = await import('../lib/browser-driver.js');
  // 构造不会启动浏览器（launch 是惰性的，在 ensure() 里），所以这一步是纯离线。
  const d = createBrowserDriver({ ...NO_LAUNCH, answerTimeoutMs: 12_345 });
  assert.equal(d.status().answerTimeoutMs, 12_345);
});

test('未给 answerTimeoutMs 时 driver 退回 180s 默认（不是 undefined）', async () => {
  const { createBrowserDriver } = await import('../lib/browser-driver.js');
  const d = createBrowserDriver({ ...NO_LAUNCH });
  // undefined 会让 shouldSettleStalledThinking 直接 return false（判据整体关闭），
  // 也就是这一整条防线静默消失——比配错数值更危险。
  assert.equal(d.status().answerTimeoutMs, 180_000);
});

test('answerTimeoutMs 接受 0 表示显式关闭该判据', async () => {
  const { createBrowserDriver } = await import('../lib/browser-driver.js');
  const d = createBrowserDriver({ ...NO_LAUNCH, answerTimeoutMs: 0 });
  // 0 必须**保留为 0**（而不是被 `|| 默认值` 吃掉变成 180_000）：
  // shouldSettleStalledThinking 把 cap<=0 读成「关闭」，这是唯一的关闸手段。
  assert.equal(d.status().answerTimeoutMs, 0);
});