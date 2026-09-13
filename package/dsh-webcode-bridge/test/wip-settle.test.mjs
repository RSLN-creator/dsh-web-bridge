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