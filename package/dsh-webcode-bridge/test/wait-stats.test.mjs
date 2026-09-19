// wait-stats.test.mjs — 「总等待发送时间」与「累计等待」的口径契约。
//
// 钉住的是 0.14.4 的新行为：输入框底下的本会话速览与设置页的累计统计
// **必须同口径**，否则两个数字对不上，用户无法信任任何一个。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  waitOfTurn, emptyWaitStats, accumulateWait, sanitizeWaitStats,
  formatDuration, formatElapsed, liveWaitLabel,
  composerWaitLine, composerWaitPillLabel, waitStatDetailRows, waitStatRows,
} from '../lib/wait-stats.js';

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

// ---- waitOfTurn -----------------------------------------------------------

test('waitOfTurn：缺失/畸形 metrics 一律按 0，不产生 NaN', () => {
  assert.deepEqual(waitOfTurn(null), { sendWaitMs: 0, rateLimitRetries: 0 });
  assert.deepEqual(waitOfTurn({}), { sendWaitMs: 0, rateLimitRetries: 0 });
  assert.deepEqual(waitOfTurn({ sendWaitMs: 'x', rateLimitRetries: null }), { sendWaitMs: 0, rateLimitRetries: 0 });
  assert.deepEqual(waitOfTurn({ sendWaitMs: -5, rateLimitRetries: -1 }), { sendWaitMs: 0, rateLimitRetries: 0 });
});

test('waitOfTurn：正常值四舍五入取整', () => {
  assert.deepEqual(waitOfTurn({ sendWaitMs: 7609.4, rateLimitRetries: 2.6 }), { sendWaitMs: 7609, rateLimitRetries: 3 });
});

// ---- accumulateWait -------------------------------------------------------

test('accumulateWait：空账本 + 一次等待 → 计数与总量都对', () => {
  const out = accumulateWait(null, { sendWaitMs: 3000, rateLimitRetries: 0 }, NOW);
  assert.deepEqual(out, { totalWaitMs: 3000, turns: 1, rateLimitRetries: 0, waitedTurns: 1, updatedAt: NOW });
});

test('accumulateWait：没等待的轮次计入 turns 但不计入 waitedTurns（平均值的分母）', () => {
  let s = accumulateWait(null, { sendWaitMs: 5000 }, NOW);
  s = accumulateWait(s, { sendWaitMs: 0 }, NOW + 1);
  s = accumulateWait(s, { sendWaitMs: 0 }, NOW + 2);
  assert.equal(s.turns, 3);
  assert.equal(s.waitedTurns, 1);
  assert.equal(s.totalWaitMs, 5000);
});

test('accumulateWait：限流重试次数独立累加', () => {
  let s = accumulateWait(null, { sendWaitMs: 1000, rateLimitRetries: 1 }, NOW);
  s = accumulateWait(s, { sendWaitMs: 2000, rateLimitRetries: 2 }, NOW);
  assert.equal(s.totalWaitMs, 3000);
  assert.equal(s.rateLimitRetries, 3);
});

test('accumulateWait：不修改入参（纯函数）', () => {
  const prev = { totalWaitMs: 100, turns: 1, rateLimitRetries: 0, waitedTurns: 1, updatedAt: NOW };
  const snapshot = JSON.stringify(prev);
  accumulateWait(prev, { sendWaitMs: 500 }, NOW);
  assert.equal(JSON.stringify(prev), snapshot);
});

test('accumulateWait：损坏的入参按空账本处理，不抛错', () => {
  assert.deepEqual(accumulateWait('garbage', { sendWaitMs: 100 }, NOW), { totalWaitMs: 100, turns: 1, rateLimitRetries: 0, waitedTurns: 1, updatedAt: NOW });
  assert.deepEqual(accumulateWait({ totalWaitMs: NaN, turns: 'x' }, { sendWaitMs: 100 }, NOW), { totalWaitMs: 100, turns: 1, rateLimitRetries: 0, waitedTurns: 1, updatedAt: NOW });
});

// ---- sanitizeWaitStats ----------------------------------------------------

test('sanitizeWaitStats：null/非对象 → 空账本', () => {
  assert.deepEqual(sanitizeWaitStats(null), emptyWaitStats());
  assert.deepEqual(sanitizeWaitStats('x'), emptyWaitStats());
  assert.deepEqual(sanitizeWaitStats(42), emptyWaitStats());
});

test('sanitizeWaitStats：负数/NaN 归零，合法值保留', () => {
  assert.deepEqual(sanitizeWaitStats({ totalWaitMs: -1, turns: NaN, rateLimitRetries: '5', waitedTurns: 2 }), {
    totalWaitMs: 0, turns: 0, rateLimitRetries: 5, waitedTurns: 2, updatedAt: null,
  });
});

test('sanitizeWaitStats：旧账本缺 waitedTurns → 0（不得变成 NaN）', () => {
  const out = sanitizeWaitStats({ totalWaitMs: 900, turns: 3 });
  assert.equal(out.waitedTurns, 0);
  assert.ok(Number.isFinite(out.waitedTurns));
});

// ---- formatDuration -------------------------------------------------------

test('formatDuration：四档格式与官方风格对齐', () => {
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(formatDuration(-5), '0 ms');
  assert.equal(formatDuration(NaN), '0 ms');
  assert.equal(formatDuration(123), '123 ms');
  assert.equal(formatDuration(999), '999 ms');
  assert.equal(formatDuration(1000), '1.0 s');
  assert.equal(formatDuration(4200), '4.2 s');
  assert.equal(formatDuration(59_900), '59.9 s');
  assert.equal(formatDuration(60_000), '1 分 00 秒');
  assert.equal(formatDuration(185_000), '3 分 05 秒');
  assert.equal(formatDuration(3_600_000), '1 小时 00 分');
  assert.equal(formatDuration(7_620_000), '2 小时 07 分');
});

test('formatDuration：末位单位补零，保证同一列宽度稳定', () => {
  // 设计口径：前导单位不补零（它是可变长的读数），**末位单位补零**——
  // 同一列里 `3 分 05 秒` 与 `3 分 42 秒` 宽度才一致，扫读时不会跳动。
  assert.equal(formatDuration(65_000), '1 分 05 秒');
  assert.equal(formatDuration(3_600_000 + 60_000), '1 小时 01 分');
});

// ---- composerWaitLine -----------------------------------------------------

test('composerWaitLine：毫无数据时返回 null（调用方据此不渲染整行）', () => {
  assert.equal(composerWaitLine({}), null);
  assert.equal(composerWaitLine({ session: emptyWaitStats(), metrics: {} }), null);
});

test('composerWaitLine：本会话等待过 → 显示累计与距上次发送', () => {
  const line = composerWaitLine({ session: { totalWaitMs: 12_000, turns: 2, waitedTurns: 1 }, metrics: { sincePrevSendMs: 9400 } });
  assert.match(line, /本次会话等待发送 12\.0 s/);
  assert.match(line, /距上次发送 9\.4 s/);
});

test('composerWaitLine：未等待但有限流重试 → 仍给一行', () => {
  const line = composerWaitLine({ session: { totalWaitMs: 0, rateLimitRetries: 2 } });
  assert.match(line, /限流重试 2 次/);
});

// ---- formatElapsed / liveWaitLabel（0.16.24）-------------------------------

// 需求（用户原话）：「能做到等待发送实际显示和官方一样开始就计时增长，不要等过了
// 再变一下子从 n 秒到 m 秒？」这两条钉的就是「计时增长」这四个字：读数是**从起始
// 时刻现算**出来的，不是等结束才由账本一次性给出。

test('formatElapsed：秒级取整（逐秒跳动时不留小数位），分钟以上与 formatDuration 合流', () => {
  assert.equal(formatElapsed(0), '0 s');
  assert.equal(formatElapsed(-5), '0 s');
  assert.equal(formatElapsed(NaN), '0 s');
  // 与 formatDuration 的差别只在秒级：这里 3.9 s 显示 3 s（未满 4 秒），
  // 因为数字马上还会涨——显示 4.9 s 那种小数只会让人以为卡住了。
  assert.equal(formatElapsed(3900), '3 s');
  assert.equal(formatElapsed(999), '0 s');
  assert.equal(formatElapsed(1000), '1 s');
  assert.equal(formatElapsed(59_999), '59 s');
  assert.equal(formatDuration(3900), '3.9 s');
  // 分钟以上必须与累计账本同一写法，否则药丸与面板会给出两个数。
  assert.equal(formatElapsed(60_000), formatDuration(60_000));
  assert.equal(formatElapsed(185_000), '3 分 05 秒');
});

test('liveWaitLabel：从起始时刻逐秒增长（同一轮内三次读数递增）', () => {
  const live = { startedAt: 1_000_000, endsAt: 1_010_000, baseMs: 0 };
  assert.equal(liveWaitLabel(live, 1_000_000), '等待发送 0 s');
  assert.equal(liveWaitLabel(live, 1_003_000), '等待发送 3 s');
  assert.equal(liveWaitLabel(live, 1_006_500), '等待发送 6 s');
});

test('liveWaitLabel：到 endsAt 冻结在满值，不越过目标继续涨', () => {
  const live = { startedAt: 1_000_000, endsAt: 1_010_000, baseMs: 0 };
  // 等待确实结束了，只是整轮生成还没跑完、账本还没结算——此时数字不该继续涨。
  assert.equal(liveWaitLabel(live, 1_010_000), '等待发送 10 s');
  assert.equal(liveWaitLabel(live, 1_030_000), '等待发送 10 s');
});

test('liveWaitLabel：baseMs 让限流退避接着涨，而不是从 0 重来', () => {
  // 发送间隔已等 6 秒，退避 10 秒接上：起始时应当显示 6 s 而不是 0 s。
  const live = { startedAt: 2_000_000, endsAt: 2_010_000, baseMs: 6000 };
  assert.equal(liveWaitLabel(live, 2_000_000), '等待发送 6 s');
  assert.equal(liveWaitLabel(live, 2_002_000), '等待发送 8 s');
});

test('liveWaitLabel：无在途 / 畸形入参一律 null（调用方据此回落账本）', () => {
  assert.equal(liveWaitLabel(null, NOW), null);
  assert.equal(liveWaitLabel(undefined, NOW), null);
  assert.equal(liveWaitLabel({}, NOW), null);
  assert.equal(liveWaitLabel({ startedAt: 'x' }, NOW), null);
  // endsAt 缺失时按「还没到期」处理：宁可多涨，也不要让药丸凭空消失。
  assert.equal(liveWaitLabel({ startedAt: 1_000_000 }, 1_004_000), '等待发送 4 s');
});

test('composerWaitPillLabel：读数是「会话累计 + 在途增量」的投影，不跳变（0.16.26）', () => {
  // 用户报的跳变：1→8 s 缓慢涨，然后跳到「2 分多」。
  //
  // 根因（0.16.24 的语义切换）：等的时候显示「这一轮等了多久」，等一结束 live 被清、
  // 回落到 s.totalWaitMs「本会话一共等了多久」——两个不同的量拼在一枚药丸里。
  // 现在只有一个量：本会话等待发送总量（含正在等的那段）。
  const live = { startedAt: 1_000_000, endsAt: 1_010_000, baseMs: 0 };
  const before = { totalWaitMs: 12_000, turns: 2, waitedTurns: 1 };
  // 等待中：账本 12 s + 已过 3 s = 15 s（而不是旧行为的 3 s）。
  assert.equal(composerWaitPillLabel({ session: before, live, now: 1_003_000 }), '等待发送 15 s');
  // 账本被本轮结算补上（12 s + 10 s 间隔），live 消失。
  const after = { totalWaitMs: 22_000, turns: 3, waitedTurns: 2 };
  assert.equal(composerWaitPillLabel({ session: after, live: null, now: 1_010_000 }), '等待发送 22 s');
});

test('composerWaitPillLabel：等待结束的瞬间读数连续（不跳变的硬契约）', () => {
  // 这是用户报的那个 bug 的**直接**回归断言：等待期间最后一个投影读数，
  // 必须等于结算后账本给出的读数。两者相等 ⇒ 切换显示源时数字不变。
  const live = { startedAt: 1_000_000, endsAt: 1_010_000, baseMs: 0 };
  const base = 12_000;
  const during = composerWaitPillLabel({ session: { totalWaitMs: base }, live, now: 1_010_000 });
  const settled = composerWaitPillLabel({ session: { totalWaitMs: base + 10_000 }, live: null, now: 1_010_000 });
  assert.equal(during, settled, '等待结束前后必须显示同一个数');
  assert.equal(during, '等待发送 22 s');
});

test('composerWaitPillLabel：续等（baseMs）也让投影连续，不从 0 重来', () => {
  // 发送间隔等完 6 s 又撞限流退避 10 s：投影必须是 6+… 接着涨。
  const live = { startedAt: 2_000_000, endsAt: 2_010_000, baseMs: 6000 };
  assert.equal(composerWaitPillLabel({ session: { totalWaitMs: 0 }, live, now: 2_000_000 }), '等待发送 6 s');
  assert.equal(composerWaitPillLabel({ session: { totalWaitMs: 0 }, live, now: 2_004_000 }), '等待发送 10 s');
});

// ---- composerWaitPillLabel（0.15.10）---------------------------------------

test('composerWaitPillLabel：毫无数据时返回 null（调用方据此不渲染整枚药丸）', () => {
  assert.equal(composerWaitPillLabel({}), null);
  assert.equal(composerWaitPillLabel({ session: emptyWaitStats(), metrics: {} }), null);
});

test('composerWaitPillLabel：本会话等待过 → 只给一个短读数（不超过一行）', () => {
  const label = composerWaitPillLabel({ session: { totalWaitMs: 12_000, turns: 2, waitedTurns: 1 } });
  // 0.16.24：药丸文案改用 formatElapsed（秒级取整），与在途读数同一写法——
  // 同一个数在「正在涨」与「已结算」两种状态下必须是同一串字。
  assert.equal(label, '等待发送 12 s');
  // 旧的长文案（「本次会话等待发送 … · 距上次发送 …」）是「两栏」的根因：
  // 它长到放不进官方那一行。药丸文案必须短——这里把它钉住。
  assert.ok(!label.includes('距上次发送'));
  assert.ok(label.length < 24);
});

test('composerWaitPillLabel：限流重试作为后缀附上', () => {
  assert.equal(composerWaitPillLabel({ session: { totalWaitMs: 0, rateLimitRetries: 2 } }), '限流重试 2 次');
  assert.equal(
    // 0.16.24：药丸的等待读数统一走 formatElapsed（秒级取整）。
    composerWaitPillLabel({ session: { totalWaitMs: 3000, rateLimitRetries: 1 } }),
    '等待发送 3 s · 限流重试 1 次');
});

test('composerWaitPillLabel：还没等待过但已知距上次发送 → 给一个可核对的数', () => {
  assert.equal(composerWaitPillLabel({ session: emptyWaitStats(), metrics: { sincePrevSendMs: 9400 } }), '距上次发送 9.4 s');
});

// ---- waitStatDetailRows（0.15.10）-----------------------------------------

test('waitStatDetailRows：空账本不给行（面板不留 0 ms 噪音）', () => {
  assert.deepEqual(waitStatDetailRows({}), []);
  assert.deepEqual(waitStatDetailRows({ session: emptyWaitStats() }), []);
});

test('waitStatDetailRows：本会话与累计同屏，且能区分两者', () => {
  const rows = waitStatDetailRows({
    session: { totalWaitMs: 3000, turns: 2, waitedTurns: 1, rateLimitRetries: 1 },
    total: { totalWaitMs: 20_000, turns: 9, waitedTurns: 4 },
    metrics: { gapTargetMs: 5000, sincePrevSendMs: 9400 },
  });
  const labels = rows.map(r => r.label);
  assert.ok(labels.includes('本次会话等待发送'));
  assert.ok(labels.includes('累计等待发送'));
  assert.equal(rows.find(r => r.label === '本次会话等待发送').value, '3 s');
  assert.equal(rows.find(r => r.label === '累计等待发送').value, '20.0 s');
  assert.equal(rows.find(r => r.label === '距上次发送').value, '9.4 s');
  assert.equal(rows.find(r => r.label === '发送间隔目标').value, '5.0 s');
  // 平均值只在累计里、且只在等待过时给（分母为 0 不许除）。
  assert.equal(rows.find(r => r.label === '平均每次等待').value, '5.0 s');
});

test('waitStatDetailRows：累计为 0 时不出现任何累计行', () => {
  const rows = waitStatDetailRows({ session: { totalWaitMs: 1000, turns: 1, waitedTurns: 1 }, total: emptyWaitStats() });
  assert.ok(!rows.some(r => r.label.includes('累计')));
});

// ---- waitStatRows ---------------------------------------------------------

test('waitStatRows：基础三行恒在，平均值只在等待过时出现', () => {
  const rows = waitStatRows({ totalWaitMs: 10_000, turns: 4, waitedTurns: 2 });
  const labels = rows.map(r => r.label);
  assert.ok(labels.includes('累计等待发送'));
  assert.ok(labels.includes('已统计轮次'));
  assert.ok(labels.includes('其中等待过'));
  assert.ok(labels.includes('平均每次等待'));
  assert.equal(rows.find(r => r.label === '平均每次等待').value, '5.0 s');
});

test('waitStatRows：没有等待过就不给平均值（分母为 0 不许除）', () => {
  const rows = waitStatRows({ totalWaitMs: 0, turns: 3, waitedTurns: 0 });
  assert.ok(!rows.some(r => r.label === '平均每次等待'));
});

test('waitStatRows：限流与更新时间按需出现', () => {
  const rows = waitStatRows({ totalWaitMs: 1000, turns: 1, waitedTurns: 1, rateLimitRetries: 3, updatedAt: NOW });
  assert.equal(rows.find(r => r.label === '限流重试').value, '3 次');
  assert.ok(rows.some(r => r.label === '最近更新'));
  const bare = waitStatRows(emptyWaitStats());
  assert.ok(!bare.some(r => r.label === '限流重试'));
  assert.ok(!bare.some(r => r.label === '最近更新'));
});
