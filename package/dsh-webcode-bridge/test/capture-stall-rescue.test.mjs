// capture-stall-rescue.test.mjs — 「页面在写、流却不来」的 DOM 兜底回传（0.19.12）。
//
// ## 真机事故（本文件针对的那一次）
//
// 2026-09-24 22:11-22:13，会话 `session-12d9c3c6`：本轮首事件已到（报错原文
// 「判定相位=已开流后的静默」），此后 120s 适配器零事件，看门狗开火报
// `WEB_NO_PROGRESS`。现场读数自相证词：「最近驱动活动时间 2s 前」（WIP 巡检还在
// 采到页面）+「页面已有 1072 字回复未回传」。重试轮的原始回复 1081 字与未回传的
// 1072 字几乎同长——网页侧把回复**完整生成完了**，是「页面 SSE → 页内捕获 →
// 解码器」管道在前几个事件后中断了。
//
// ## 既有防线为什么救不了（本文件钉住的新判据的由来）
//
//   · shouldSettleWip：要求 bodyReady（正文得先从流里来过）——管道中断后正文
//     恰恰不会从流里来，判定永不成立；
//   · shouldSettleStalledThinking：救出来的仍是**流里**的内容，DOM 里那份够不着；
//   · 适配器看门狗 120s：只负责报错中止，网页侧内容整轮丢弃。
//
// 所以新增第四条：流静默 ≥ captureStallRescueMs 且页面本轮 DOM 内容变过、有真
// 实内容、（仍在写 或 流从未送来过正文）→ 把 DOM 文本当 partial 结果交回。
// 判据见 lib/metrics.js 的 shouldRescueStalledCapture；接线在 browser-driver 的
// startWipWatch tick。
//
// ## 反向安全线（宁可漏救，不可误救——每条都有用例钉住）
//
//   ① 流还在动（增量在到）→ 永不命中：兜底绝不允许和活流赛跑；
//   ② DOM 相对基线没变过 → 永不命中：prefill 阶段「最后一名助手节点 = 上一轮
//      回复」是常态，没有基线对比必然把旧回复张冠李戴成本轮的；
//   ③ domLen = 0（只有计时文案在动）→ 永不命中：那是思考占位，不是内容；
//   ④ stallMs = 0 → 永不命中：0 = 显式关闭，非法值回落到关而不是默认开。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { shouldRescueStalledCapture, answerDomLength, cleanAnswerDomText } from '../lib/metrics.js';

const here = dirname(fileURLToPath(import.meta.url));

const NOW = 1_000_000;
const STALL = 45_000;
const IDLE = 2500;

/** 一份「判据应命中」的基准现场：流静默 60s、页面 1s 前还在长、有内容、变过、流里没正文。 */
function liveScene(over = {}) {
  return {
    now: NOW,
    lastProgressAt: NOW - 60_000,
    lastDomGrowthAt: NOW - 1_000,
    domLen: 1072,
    domTextChanged: true,
    hasStreamBody: false,
    domAvailable: true,
    stallMs: STALL,
    wipIdleMs: IDLE,
    ...over,
  };
}

// ---- 正向：真机事故的形状必须命中 ---------------------------------------

test('真机事故形状：流静默超阈 + 页面仍在写 + 流里没正文 → 兜底', () => {
  assert.equal(shouldRescueStalledCapture(liveScene()), true);
});

test('流送来过正文（管道中途死）+ 页面仍在写 → 也兜底', () => {
  assert.equal(shouldRescueStalledCapture(liveScene({ hasStreamBody: true })), true);
});

test('页面刚写完停住（2×wipIdle 内停）但流里从未有正文 → 仍兜底', () => {
  // !hasStreamBody 分支：DOM 停长不能成为「让 0.12.1 那类『页面早有全文、捕获
  // 从未建立』的轮次继续挂到 240s」的理由。
  assert.equal(shouldRescueStalledCapture(liveScene({ lastDomGrowthAt: NOW - 2 * IDLE - 1 })), true);
});

test('流静默恰好等于阈值 → 命中（边界取等）', () => {
  assert.equal(shouldRescueStalledCapture(liveScene({ lastProgressAt: NOW - STALL })), true);
});

// ---- 反向安全线 -----------------------------------------------------------

test('① 流还在动（增量刚到过）→ 永不命中，兜底绝不与活流赛跑', () => {
  assert.equal(shouldRescueStalledCapture(liveScene({ lastProgressAt: NOW - 1_000 })), false);
});

test('② DOM 相对基线没变过（页面还没写本轮）→ 永不命中，不张冠李戴', () => {
  // prefill 期「最后一名助手节点 = 上一轮回复」是常态：domLen>0 但那是旧回复。
  assert.equal(shouldRescueStalledCapture(liveScene({ domTextChanged: false })), false);
});

test('③ domLen=0（只有计时文案在动）→ 永不命中', () => {
  assert.equal(shouldRescueStalledCapture(liveScene({ domLen: 0 })), false);
  assert.equal(shouldRescueStalledCapture(liveScene({ domLen: null })), false);
});

test('④ stallMs=0 = 显式关闭 → 永不命中', () => {
  assert.equal(shouldRescueStalledCapture(liveScene({ stallMs: 0 })), false);
});

test('页面读不到（关窗/导航中）→ 永不命中（无从兜底）', () => {
  assert.equal(shouldRescueStalledCapture(liveScene({ domAvailable: false })), false);
});

test('流送来过正文且 DOM 已停长超过 2×wipIdle → 不兜底，交回既有稳态收束', () => {
  // 这一类 shouldSettleWip 本来就会秒级收束（双条件都停了 + bodyReady 成立），
  // 兜底若也命中就会和它抢收束权——必须让位。
  assert.equal(shouldRescueStalledCapture(liveScene({
    hasStreamBody: true,
    lastDomGrowthAt: NOW - 2 * IDLE - 1,
  })), false);
});

test('非法读数（NaN/undefined 时刻）→ 永不命中', () => {
  assert.equal(shouldRescueStalledCapture(liveScene({ lastProgressAt: undefined })), false);
  assert.equal(shouldRescueStalledCapture(liveScene({ lastDomGrowthAt: NaN })), false);
  assert.equal(shouldRescueStalledCapture(liveScene({ now: undefined })), false);
});

// ---- cleanAnswerDomText：兜底交付的文本与 domReplyChars 必须同一把尺 ------

test('兜底文本清洗：剥计时行、留正文；与 answerDomLength 同源', () => {
  const raw = '思考中…\n深度思考中\n已思考 12 秒\n以下是答案：\n第一行\nThought for 3s\n正文里的思考中三个字不剥\n';
  const cleaned = cleanAnswerDomText(raw);
  assert.equal(cleaned, '以下是答案：\n第一行\n正文里的思考中三个字不剥\n');
  assert.equal(answerDomLength(raw), cleaned.trim().length);
});

test('answerDomLength 行为不回归（剥计时文案后量长度，旧行为逐字保留）', () => {
  assert.equal(answerDomLength(''), 0);
  assert.equal(answerDomLength(null), 0);
  assert.equal(answerDomLength('思考中…'), 0);
  assert.equal(answerDomLength('你好'), 2);
});

// ---- 接线级护栏：判据必须真的被 startWipWatch 调用，而不是只活在纯函数里 ---
//
// 项目已有教训（test/stall-settle.test.mjs §③、lib/index.js 的 answerTimeoutMs
// 注释）：只加判据不接线，行为「恰好」对但配置与读数永远够不着，是本仓库反复
// 出现的假绿。browser-driver 依赖 playwright 无法离线实例化，接线按本仓库惯例
// 用源码结构断言钉住（同 upload-attachment-structure.test.mjs 的写法）。

const driverSrc = readFileSync(join(here, '..', 'lib', 'browser-driver.js'), 'utf8');

test('接线：startWipWatch 的 tick 里调用 shouldRescueStalledCapture', () => {
  const start = driverSrc.indexOf('function startWipWatch()');
  assert.ok(start > 0, 'startWipWatch 必须存在');
  const end = driverSrc.indexOf('\n  }', driverSrc.indexOf('if (active) active.wipTimer = setTimeout(tick, WIP_IDLE_MS);', start));
  const body = driverSrc.slice(start, end);
  assert.ok(body.includes('shouldRescueStalledCapture('), 'tick 内必须调用兜底判据');
});

test('接线：兜底必须在 bodyReady 早退**之前**判定', () => {
  const start = driverSrc.indexOf('function startWipWatch()');
  const rescueAt = driverSrc.indexOf('shouldRescueStalledCapture(', start);
  const bodyReadyAt = driverSrc.indexOf('const bodyReady =', start);
  assert.ok(rescueAt > 0 && bodyReadyAt > rescueAt, '兜底判定必须先于 bodyReady 早退（要救的正是正文没从流来的轮次）');
});

test('接线：兜底走 partial 收束同形路径（settled_by/noteEndReason/finishActive+resolve）', () => {
  const start = driverSrc.indexOf('function startWipWatch()');
  const rescueAt = driverSrc.indexOf('shouldRescueStalledCapture(', start);
  const end = driverSrc.indexOf('\n  }', driverSrc.indexOf('if (active) active.wipTimer = setTimeout(tick, WIP_IDLE_MS);', start));
  const body = driverSrc.slice(rescueAt, end);
  assert.ok(body.includes("reason: 'dom-rescue-capture-stall'"), '兜底结果必须带可读 reason');
  assert.ok(body.includes("noteEndReason('dom-rescue-capture-stall')"), '收束原因必须落账（/status 可核对）');
  assert.ok(body.includes('finishActive()'), '必须走 finishActive 清理本轮定时器');
  assert.ok(body.includes('resolve(result)'), '必须 resolve partial 结果（runTurn 落账路径复用）');
  assert.ok(body.includes('a.domRescueDone = true'), '一轮最多兜底一次');
});

test('接线：active 上必须有兜底基线字段（无基线必然张冠李戴）', () => {
  assert.ok(driverSrc.includes('domTextAtStart: null'), 'active 必须初始化 domTextAtStart');
  assert.ok(driverSrc.includes('a.domTextChanged = String(domText) !== a.domTextAtStart'), '每拍必须对当前文本重算 domTextChanged');
});

test('接线：captureStallRescueMs 配置必须从 cfg 读入 driver（默认 45s，0=关）', () => {
  assert.ok(driverSrc.includes('cfg.captureStallRescueMs'), 'driver 必须读 cfg.captureStallRescueMs');
  const indexSrc = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8');
  assert.ok(indexSrc.includes('captureStallRescueMs: 45_000'), 'DEFAULTS 必须声明默认值（可配置只对一半 = 假绿）');
  // 两处 createBrowserDriver 都要显式传入（默认槽 + 非默认槽行为必须一致）。
  const passes = indexSrc.match(/captureStallRescueMs: cfg\.captureStallRescueMs/g) || [];
  assert.ok(passes.length >= 2, `两处驱动创建都要传入（实测 ${passes.length} 处）`);
});
