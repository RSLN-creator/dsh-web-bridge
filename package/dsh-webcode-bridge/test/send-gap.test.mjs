// send-gap.test.mjs — 「发送间隔」必须按设置值生效，且**可核对**（0.14.0）。
//
// 用户原话：「发送前等待时间好像不是按照我设置里面来的？」。取证结论是设置
// 一直存得住（webcode-settings.json 里 sendGapMs: 10000，GET /__webcode/settings
// 也回 10000），真正的问题在**语义**与**可见性**：
//   a) 基准曾是「上一轮**结束**」而非「上一轮**发出**」——一轮跑了 20918ms 时，
//      10000ms 的间隔只剩 7609ms 可见（真机 metrics 实测）；
//   b) 基准只在进程内存，DSH 重启即清空 → 重启后第一轮零等待；
//   c) sendWaitMs=0 时右栏那条统计整条不渲染 → 「设了 10s 界面上什么都没有」。
//
// 本文件钉住 (a) 的判定与 (c) 所需字段的存在性；(b) 由 index.js 的落盘承担，
// 由 test/regression.test.mjs 的静态断言兜底（源码里必须有 webcode-send-state.json）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { computeSendGap } from '../lib/metrics.js';

const T = 1_700_000_000_000;   // 固定基准时刻，避免依赖真实时钟

test('距上次发送不足间隔 → 补满差额（send-to-send，不是 turn-end）', () => {
  // 上一次**发出**在 3 秒前，目标间隔 10 秒 → 还应等 7 秒
  const r = computeSendGap({ lastSendAt: T - 3000, now: T, gapMs: 10000 });
  assert.equal(r.waitMs, 7000);
  assert.equal(r.sincePrevSendMs, 3000);
  assert.equal(r.skewed, false);
});

test('距上次发送已超过间隔 → 不等待，但间隔数字仍要带出来（可见性）', () => {
  // 这是真机最常见的一轮：上一轮本身跑了 20.9 秒，10 秒间隔早就满足。
  // 旧实现在这种情况下右栏什么都不显示，用户只能怀疑设置没生效。
  const r = computeSendGap({ lastSendAt: T - 20918, now: T, gapMs: 10000 });
  assert.equal(r.waitMs, 0);
  assert.equal(r.sincePrevSendMs, 20918);
});

test('没有基准（首次 / 刚重启）→ 不等待，且不谎报一个间隔数字', () => {
  const r = computeSendGap({ lastSendAt: null, now: T, gapMs: 10000 });
  assert.equal(r.waitMs, 0);
  assert.equal(r.sincePrevSendMs, null);
});

test('间隔设为 0（关闭）→ 永不等待，也不受基准影响', () => {
  assert.equal(computeSendGap({ lastSendAt: T - 10, now: T, gapMs: 0 }).waitMs, 0);
  assert.equal(computeSendGap({ lastSendAt: T - 10, now: T, gapMs: -5 }).waitMs, 0);
});

test('恰好等于间隔的边界：差 1ms 不等待，差 1ms 内等待', () => {
  assert.equal(computeSendGap({ lastSendAt: T - 10000, now: T, gapMs: 10000 }).waitMs, 0);
  assert.equal(computeSendGap({ lastSendAt: T - 9999, now: T, gapMs: 10000 }).waitMs, 1);
});

test('时钟回拨（基准在未来）→ 不产生荒谬的长等待，但标出 skewed', () => {
  // 落盘时间来自未来（跨机拷贝/改系统时间）。若照公式算，等待可能是几小时，
  // 表现为「桥莫名其妙不动了」。这里按「刚发过」处理：等满一个间隔即可。
  const r = computeSendGap({ lastSendAt: T + 3_600_000, now: T, gapMs: 10000 });
  assert.equal(r.waitMs, 10000);
  assert.equal(r.skewed, true);
  assert.equal(r.sincePrevSendMs, 0);
});

test('非数值/垃圾基准一律当作「没有基准」，不得抛错', () => {
  for (const bad of ['abc', NaN, undefined, -1, {}]) {
    const r = computeSendGap({ lastSendAt: bad, now: T, gapMs: 5000 });
    assert.equal(r.waitMs, 0, `基准 ${String(bad)} 应视为无基准`);
    assert.equal(r.sincePrevSendMs, null);
  }
});

test('返回值都是整数毫秒（右栏与 /status 直接展示，不能出现浮点尾巴）', () => {
  const r = computeSendGap({ lastSendAt: T - 3333.7, now: T, gapMs: 9999.4 });
  assert.ok(Number.isInteger(r.waitMs));
  assert.ok(Number.isInteger(r.sincePrevSendMs));
});