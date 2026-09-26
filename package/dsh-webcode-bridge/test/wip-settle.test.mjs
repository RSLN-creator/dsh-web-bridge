// wip-settle.test.mjs — 「网页端回复了但 harness 这边卡住」的稳态判定（0.14.0）。
//
// 真机取证（2026-09-13）：DeepSeek 网页流可能以 status:'WIP' 结束且**永不发
// FINISHED**，解码器据此给 {complete:false, partial:true}；而驱动的 done promise
// 只在 phase==='end'（已过去）或 240s 定时器时才 settle。于是一轮早写完的回复
// 把 sendTurn → relay → 适配器的 await ch.next() 全部挂住，界面就是无限「思考中」。
// 现场：recoveredTurns=1、lastRecovered.reason='stream_ended_before_finished'、
// status='WIP'、chars=463。
//
// 本文件钉住两条**同等重要**的东西：
//   ① 流停 + 页面也不再增长 → 允许收束（否则就是卡住）；
//   ② **任何一条还在动 → 绝不允许收束**（否则长回复被腰斩）。
// ② 是这次修复的安全线：思考阶段十几秒不吐正文是常态，只看流停必然误杀。
import test from 'node:test';
import assert from 'node:assert/strict';
import { shouldSettleWip } from '../lib/metrics.js';

const NOW = 1_000_000;   // performance.now() 口径即可，用固定数便于断言
const IDLE = 2500;

test('流停且页面长度也停 → 收束（这正是「卡住」的那一类）', () => {
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - IDLE, lastDomGrowthAt: NOW - IDLE, wipIdleMs: IDLE,
  }), true);
});

test('流还在动 → 绝不收束（哪怕页面很久没变）', () => {
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - 100, lastDomGrowthAt: NOW - 60_000, wipIdleMs: IDLE,
  }), false);
});

test('流停了但页面仍在变长 → 绝不收束（长回复/思考阶段的安全线）', () => {
  // 这是最容易写错的一条：网页仍在往 DOM 里写，只是 SSE 这一路静默。
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - 60_000, lastDomGrowthAt: NOW - 200, wipIdleMs: IDLE,
  }), false);
});

test('恰好到窗口边界即可收束（>= 而非 >）', () => {
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - IDLE, lastDomGrowthAt: NOW - IDLE, wipIdleMs: IDLE,
  }), true);
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - (IDLE - 1), lastDomGrowthAt: NOW - IDLE, wipIdleMs: IDLE,
  }), false);
});

test('页面不可采样 → 退回「仅流停」判定（并在调用方标注 dom-unavailable）', () => {
  // 窗口被关/导航中：DOM 采样拿不到，此时 DOM 条件无法成立，只能靠流停。
  // 这不是放宽安全线，而是没有第二路证据时的既定退路——调用方会把收束原因
  // 标成 partial-wip-settled(dom-unavailable)，用户与日志都能看出差别。
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - IDLE, lastDomGrowthAt: NOW, domAvailable: false, wipIdleMs: IDLE,
  }), true);
  // 但流还在动时，即便页面不可采样也不收束。
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - 10, lastDomGrowthAt: NOW, domAvailable: false, wipIdleMs: IDLE,
  }), false);
});

test('窗口可配置：调小后能更早收束（离线测试与真机可调）', () => {
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - 300, lastDomGrowthAt: NOW - 300, wipIdleMs: 300,
  }), true);
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - 300, lastDomGrowthAt: NOW - 300, wipIdleMs: IDLE,
  }), false);
});

// ---- 0.19.16：第三态「页面能采样，但找不到助手节点」 -----------------------
//
// 真机故障（用户报 glm-5.3-flash「思维链流到一半 → 空回复」，会话 a23e4ee4）。
// WIP 巡检与超时现场两处硬编码的是 DeepSeek 专用选择器串，对 chatglm.cn
// 实测**一个都不命中**（real-probe-30-glm-dom.mjs 候选读数全为 0）。旧实现把
// 「采样到空串」当成 domAvailable=true，于是 lastDomGrowthAt 从不刷新，
// 下面那行「页面还在长 → 绝不动」**恒不成立**——收束器只凭流静默 2.5s 就动手，
// 而那一刻解码器还没收到 GLM 的 status:'finish' 帧，内容在收尾时被丢掉。
//
// 判据：对「页面还在不在写」没有证据时，必须用**更宽的窗口**才允许收束。
// 这一组与上一组的区别正是「页面取不到」(domAvailable=false) 与「页面在、
// 但认不出哪条是回复」(domAvailable=true, domFound=false) 两件事。

test('找不到助手节点 → 2.5s 流停**不足以**收束（本故障的主修）', () => {
  // 这是旧实现会误判的那一拍：流停 2.5s、DOM 采样「成功」但读到 0 个节点。
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - IDLE, lastDomGrowthAt: NOW - 60_000,
    domAvailable: true, domFound: false, wipIdleMs: IDLE,
  }), false, '选择器瞎掉时不得凭 2.5s 流停就收束');
});

test('找不到助手节点 → 超过加宽窗口才收束（有界，不会永远挂住）', () => {
  const blind = IDLE * 6;
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - (blind - 1), lastDomGrowthAt: NOW - 60_000,
    domAvailable: true, domFound: false, wipIdleMs: IDLE,
  }), false, '未到加宽窗口仍不收束');
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - blind, lastDomGrowthAt: NOW - 60_000,
    domAvailable: true, domFound: false, wipIdleMs: IDLE,
  }), true, '到加宽窗口必须收束——否则这一轮永远不结束');
});

test('找不到助手节点：流仍在动时依然绝不收束', () => {
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - 10, lastDomGrowthAt: NOW - 60_000,
    domAvailable: true, domFound: false, wipIdleMs: IDLE,
  }), false);
});

test('找到节点且长度在长 → 走常规窗口，不受第三态影响（防误伤正常站点）', () => {
  // domFound 缺省为 true：既有调用方与既有行为必须逐字不变。
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - IDLE, lastDomGrowthAt: NOW - 200, wipIdleMs: IDLE,
  }), false, '页面还在长 → 绝不收束');
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - IDLE, lastDomGrowthAt: NOW - IDLE,
    domFound: true, wipIdleMs: IDLE,
  }), true, '找到节点且也停长了 → 正常收束');
});

test('domBlindMs 可显式配置（真机排障与离线测试的旋钮）', () => {
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - 5_000, lastDomGrowthAt: NOW - 60_000,
    domAvailable: true, domFound: false, wipIdleMs: IDLE, domBlindMs: 5_000,
  }), true);
  assert.equal(shouldSettleWip({
    now: NOW, lastProgressAt: NOW - 5_000, lastDomGrowthAt: NOW - 60_000,
    domAvailable: true, domFound: false, wipIdleMs: IDLE, domBlindMs: 30_000,
  }), false);
});