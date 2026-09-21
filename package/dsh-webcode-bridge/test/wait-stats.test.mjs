// wait-stats.test.mjs — 「总等待发送时间」与「累计等待」的口径契约。
//
// 钉住的是 0.14.4 的新行为：输入框底下的本会话速览与设置页的累计统计
// **必须同口径**，否则两个数字对不上，用户无法信任任何一个。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  waitOfTurn, emptyWaitStats, accumulateWait, sanitizeWaitStats,
  formatDuration, formatElapsed, formatPercent, liveWaitLabel, waitRatio,
  composerWaitLine, composerWaitPillLabel, waitStatDetailRows, waitStatRows,
} from '../lib/wait-stats.js';

const NOW = Date.UTC(2026, 8, 14, 12, 0, 0);

// ---- waitRatio（0.17.2 的核心判据）----------------------------------------
//
// 真机现场（2026-09-22 `POST /__webcode/wait-stats`）：老账本 totalWaitMs=113215468
// (31 小时) 对上 totalDurationMs=521868 (8.7 分钟)，于是「平均会话等待时长占比」
// 被印成 **100%**。根因不是公式，是**分母的覆盖范围与分子不一致**：
// durationMs 是 0.17.0 才引入的字段，8579 轮里绝大多数发生在此之前，分母贡献是 0。
// 这三条把「覆盖率」这个判据钉死——删掉 durationTurns 判定，第 2 条必红。
test('waitRatio：耗时记账零覆盖 → 说「未记录」，不许印 0% 或 100%', () => {
  // 这正是线上那份老账本的形状：有等待、有耗时、但没有覆盖率信息。
  assert.equal(waitRatio({ waitMs: 113_215_468, durationMs: 521_868, durationTurns: 0, turns: 8579 }), '未记录');
  // 缺字段（更老的账本）同样是零覆盖，不得变成 NaN 或百分比。
  assert.equal(waitRatio({ waitMs: 60_000, durationMs: 0, turns: 5 }), '未记录');
});

test('waitRatio：全覆盖 → 纯百分比；部分覆盖 → 带上覆盖轮次', () => {
  assert.equal(waitRatio({ waitMs: 60_000, durationMs: 40_000, durationTurns: 10, turns: 10 }), '60%');
  assert.equal(waitRatio({ waitMs: 60_000, durationMs: 40_000, durationTurns: 4, turns: 10 }), '60%（覆盖 4/10 轮）');
});

test('waitRatio：没等待过就不给占比（分子为 0 时没有可讨论的比重）', () => {
  assert.equal(waitRatio({ waitMs: 0, durationMs: 40_000, durationTurns: 10, turns: 10 }), null);
});

test('durationTurns：只有真的记了耗时的轮次才 +1（覆盖率的分母）', () => {
  // 一轮有耗时 → 覆盖 +1；一轮只有等待、没耗时 → turns +1 但覆盖不动。
  let s = accumulateWait(null, { sendWaitMs: 5000, durationMs: 10000 }, NOW);
  assert.equal(s.durationTurns, 1);
  s = accumulateWait(s, { sendWaitMs: 5000, durationMs: 0 }, NOW + 1);
  assert.equal(s.turns, 2);
  assert.equal(s.durationTurns, 1, '耗时缺失的轮次不得计入覆盖');
});

test('sanitizeWaitStats：旧账本无 durationTurns → 0，且**不向后推断**', () => {
  // 关键：不能因为 totalDurationMs > 0 就推断「这些轮次都有耗时」——那正是 100% 的来源。
  const out = sanitizeWaitStats({ totalWaitMs: 999, totalDurationMs: 888, turns: 7 });
  assert.equal(out.durationTurns, 0);
  assert.equal(out.totalDurationMs, 888, '耗时总量本身照常保留');
});

// ---- waitOfTurn -----------------------------------------------------------

test('waitOfTurn：缺失/畸形 metrics 一律按 0，不产生 NaN', () => {
  assert.deepEqual(waitOfTurn(null), { sendWaitMs: 0, durationMs: 0, rateLimitRetries: 0 });
  assert.deepEqual(waitOfTurn({}), { sendWaitMs: 0, durationMs: 0, rateLimitRetries: 0 });
  assert.deepEqual(waitOfTurn({ sendWaitMs: 'x', rateLimitRetries: null }), { sendWaitMs: 0, durationMs: 0, rateLimitRetries: 0 });
  assert.deepEqual(waitOfTurn({ sendWaitMs: -5, durationMs: -10, rateLimitRetries: -1 }), { sendWaitMs: 0, durationMs: 0, rateLimitRetries: 0 });
});

test('waitOfTurn：正常值四舍五入取整', () => {
  assert.deepEqual(waitOfTurn({ sendWaitMs: 7609.4, durationMs: 12000.2, rateLimitRetries: 2.6 }), { sendWaitMs: 7609, durationMs: 12000, rateLimitRetries: 3 });
});

// ---- accumulateWait -------------------------------------------------------

test('accumulateWait：空账本 + 一次等待 → 计数与总量都对', () => {
  const out = accumulateWait(null, { sendWaitMs: 3000, durationMs: 7000, rateLimitRetries: 0 }, NOW);
  assert.deepEqual(out, { totalWaitMs: 3000, totalDurationMs: 7000, durationTurns: 1, turns: 1, rateLimitRetries: 0, waitedTurns: 1, updatedAt: NOW });
});

test('accumulateWait：没等待的轮次计入 turns 但不计入 waitedTurns（平均值的分母）', () => {
  let s = accumulateWait(null, { sendWaitMs: 5000, durationMs: 10000 }, NOW);
  s = accumulateWait(s, { sendWaitMs: 0, durationMs: 8000 }, NOW + 1);
  s = accumulateWait(s, { sendWaitMs: 0, durationMs: 12000 }, NOW + 2);
  assert.equal(s.turns, 3);
  assert.equal(s.waitedTurns, 1);
  assert.equal(s.totalWaitMs, 5000);
  assert.equal(s.totalDurationMs, 30000);
});

test('accumulateWait：限流重试次数独立累加', () => {
  let s = accumulateWait(null, { sendWaitMs: 1000, rateLimitRetries: 1 }, NOW);
  s = accumulateWait(s, { sendWaitMs: 2000, rateLimitRetries: 2 }, NOW);
  assert.equal(s.totalWaitMs, 3000);
  assert.equal(s.rateLimitRetries, 3);
});

test('accumulateWait：不修改入参（纯函数）', () => {
  const prev = { totalWaitMs: 100, totalDurationMs: 200, turns: 1, rateLimitRetries: 0, waitedTurns: 1, updatedAt: NOW };
  const snapshot = JSON.stringify(prev);
  accumulateWait(prev, { sendWaitMs: 500, durationMs: 300 }, NOW);
  assert.equal(JSON.stringify(prev), snapshot);
});

test('accumulateWait：损坏的入参按空账本处理，不抛错', () => {
  assert.deepEqual(accumulateWait('garbage', { sendWaitMs: 100, durationMs: 200 }, NOW), { totalWaitMs: 100, totalDurationMs: 200, durationTurns: 1, turns: 1, rateLimitRetries: 0, waitedTurns: 1, updatedAt: NOW });
  assert.deepEqual(accumulateWait({ totalWaitMs: NaN, turns: 'x' }, { sendWaitMs: 100, durationMs: 200 }, NOW), { totalWaitMs: 100, totalDurationMs: 200, durationTurns: 1, turns: 1, rateLimitRetries: 0, waitedTurns: 1, updatedAt: NOW });
});

// ---- sanitizeWaitStats ----------------------------------------------------

test('sanitizeWaitStats：null/非对象 → 空账本', () => {
  assert.deepEqual(sanitizeWaitStats(null), emptyWaitStats());
  assert.deepEqual(sanitizeWaitStats('x'), emptyWaitStats());
  assert.deepEqual(sanitizeWaitStats(42), emptyWaitStats());
});

test('sanitizeWaitStats：负数/NaN 归零，合法值保留', () => {
  assert.deepEqual(sanitizeWaitStats({ totalWaitMs: -1, totalDurationMs: -5, turns: NaN, rateLimitRetries: '5', waitedTurns: 2 }), {
    totalWaitMs: 0, totalDurationMs: 0, durationTurns: 0, turns: 0, rateLimitRetries: 5, waitedTurns: 2, updatedAt: null,
  });
});

test('sanitizeWaitStats：旧账本缺 waitedTurns / totalDurationMs → 0（不得变成 NaN）', () => {
  const out = sanitizeWaitStats({ totalWaitMs: 900, turns: 3 });
  assert.equal(out.waitedTurns, 0);
  assert.equal(out.totalDurationMs, 0);
  assert.ok(Number.isFinite(out.waitedTurns));
  assert.ok(Number.isFinite(out.totalDurationMs));
});

// ---- formatPercent --------------------------------------------------------

test('formatPercent：安全输出百分比', () => {
  assert.equal(formatPercent(0), '0%');
  assert.equal(formatPercent(-5), '0%');
  assert.equal(formatPercent(NaN), '0%');
  assert.equal(formatPercent(100), '100%');
  assert.equal(formatPercent(120), '100%');
  assert.equal(formatPercent(15.4), '15%');
  assert.equal(formatPercent(15.6), '16%');
  assert.equal(formatPercent(0.5), '0.5%');
});

// ---- formatDuration -------------------------------------------------------

test('formatDuration：四档格式（0.16.39 起全部中文单位、每档都带秒）', () => {
  assert.equal(formatDuration(0), '0 ms');
  assert.equal(formatDuration(-5), '0 ms');
  assert.equal(formatDuration(NaN), '0 ms');
  assert.equal(formatDuration(123), '123 ms');
  assert.equal(formatDuration(999), '999 ms');
  // 秒档：整数秒、中文单位（旧口径是 `4.2 s`）。
  assert.equal(formatDuration(1000), '1 秒');
  assert.equal(formatDuration(4200), '4 秒');
  assert.equal(formatDuration(59_400), '59 秒');
  assert.equal(formatDuration(60_000), '1 分 00 秒');
  assert.equal(formatDuration(185_000), '3 分 05 秒');
  // 小时档必须带秒：旧口径 `2 小时 07 分` 把秒吃掉了，最多少报 59 秒，
  // 而面板里这个数要与「本会话累计」对齐核对。
  assert.equal(formatDuration(3_600_000), '1 小时 00 分 00 秒');
  assert.equal(formatDuration(7_620_000), '2 小时 07 分 00 秒');
  assert.equal(formatDuration(3_600_000 + 129_000), '1 小时 02 分 09 秒');
});

test('formatDuration：末位单位补零，保证同一列宽度稳定', () => {
  // 设计口径：前导单位不补零（它是可变长的读数），**末位单位补零**——
  // 同一列里 `3 分 05 秒` 与 `3 分 42 秒` 宽度才一致，扫读时不会跳动。
  assert.equal(formatDuration(65_000), '1 分 05 秒');
  assert.equal(formatDuration(3_600_000 + 60_000), '1 小时 01 分 00 秒');
});

// ---- composerWaitLine -----------------------------------------------------

test('composerWaitLine：毫无数据时返回 null（调用方据此不渲染整行）', () => {
  assert.equal(composerWaitLine({}), null);
  assert.equal(composerWaitLine({ session: emptyWaitStats(), metrics: {} }), null);
});

test('composerWaitLine：本会话等待过 → 显示累计与距上次发送', () => {
  const line = composerWaitLine({ session: { totalWaitMs: 12_000, turns: 2, waitedTurns: 1 }, metrics: { sincePrevSendMs: 9400 } });
  // 0.16.39：全中文单位，秒级不带小数（旧口径 `12.0 s` / `9.4 s`）。
  assert.match(line, /本次会话等待发送 12 秒/);
  assert.match(line, /距上次发送 9 秒/);
});

test('composerWaitLine：未等待但有限流重试 → 仍给一行', () => {
  const line = composerWaitLine({ session: { totalWaitMs: 0, rateLimitRetries: 2 } });
  assert.match(line, /限流重试 2 次/);
});

// ---- formatElapsed / liveWaitLabel（0.16.24）-------------------------------

// 需求（用户原话）：「能做到等待发送实际显示和官方一样开始就计时增长，不要等过了
// 再变一下子从 n 秒到 m 秒？」这两条钉的就是「计时增长」这四个字：读数是**从起始
// 时刻现算**出来的，不是等结束才由账本一次性给出。

test('formatElapsed：秒级向下取整且中文单位，分钟以上与 formatDuration 合流', () => {
  assert.equal(formatElapsed(0), '0 秒');
  assert.equal(formatElapsed(-5), '0 秒');
  assert.equal(formatElapsed(NaN), '0 秒');
  // 与 formatDuration 的差别只在取整方向：这里 3900ms 显示 3 秒（未满 4 秒），
  // 因为数字马上还会涨——显示小数只会让人以为卡住了。
  assert.equal(formatElapsed(3900), '3 秒');
  assert.equal(formatElapsed(999), '0 秒');
  assert.equal(formatElapsed(1000), '1 秒');
  assert.equal(formatElapsed(59_999), '59 秒');
  // 单位与秒档写法必须与累计账本**逐字相同**（0.16.39）：同一枚药丸在等待中与
  // 结算后切换显示源，读数不能看起来像换了个单位。
  assert.equal(formatDuration(3900), '4 秒');
  assert.equal(formatDuration(3000), '3 秒');
  // 分钟以上必须与累计账本同一写法，否则药丸与面板会给出两个数。
  assert.equal(formatElapsed(60_000), formatDuration(60_000));
  assert.equal(formatElapsed(185_000), '3 分 05 秒');
});

test('liveWaitLabel：从起始时刻逐秒增长（同一轮内三次读数递增）', () => {
  const live = { startedAt: 1_000_000, endsAt: 1_010_000, baseMs: 0 };
  assert.equal(liveWaitLabel(live, 1_000_000), '等待发送 0 秒');
  assert.equal(liveWaitLabel(live, 1_003_000), '等待发送 3 秒');
  assert.equal(liveWaitLabel(live, 1_006_500), '等待发送 6 秒');
});

test('liveWaitLabel：到 endsAt 冻结在满值，不越过目标继续涨', () => {
  const live = { startedAt: 1_000_000, endsAt: 1_010_000, baseMs: 0 };
  // 等待确实结束了，只是整轮生成还没跑完、账本还没结算——此时数字不该继续涨。
  assert.equal(liveWaitLabel(live, 1_010_000), '等待发送 10 秒');
  assert.equal(liveWaitLabel(live, 1_030_000), '等待发送 10 秒');
});

test('liveWaitLabel：baseMs 让限流退避接着涨，而不是从 0 重来', () => {
  // 发送间隔已等 6 秒，退避 10 秒接上：起始时应当显示 6 s 而不是 0 s。
  const live = { startedAt: 2_000_000, endsAt: 2_010_000, baseMs: 6000 };
  assert.equal(liveWaitLabel(live, 2_000_000), '等待发送 6 秒');
  assert.equal(liveWaitLabel(live, 2_002_000), '等待发送 8 秒');
});

test('liveWaitLabel：无在途 / 畸形入参一律 null（调用方据此回落账本）', () => {
  assert.equal(liveWaitLabel(null, NOW), null);
  assert.equal(liveWaitLabel(undefined, NOW), null);
  assert.equal(liveWaitLabel({}, NOW), null);
  assert.equal(liveWaitLabel({ startedAt: 'x' }, NOW), null);
  // endsAt 缺失时按「还没到期」处理：宁可多涨，也不要让药丸凭空消失。
  assert.equal(liveWaitLabel({ startedAt: 1_000_000 }, 1_004_000), '等待发送 4 秒');
});

test('composerWaitPillLabel：读数是「会话累计 + 在途增量」的投影，不跳变（0.16.26）', () => {
  const live = { startedAt: 1_000_000, endsAt: 1_010_000, baseMs: 0 };
  const before = { totalWaitMs: 12_000, totalDurationMs: 15_000, durationTurns: 2, turns: 2, waitedTurns: 1 };
  // 等待中：账本 12 s + 已过 3 s = 15 s；总耗时 15s wait + 15s duration = 30s，占比 50%
  assert.equal(composerWaitPillLabel({ session: before, live, now: 1_003_000 }), '15 秒 · 等待占比 50%');
  // 账本被本轮结算补上（12 s + 10 s 间隔），live 消失。
  const after = { totalWaitMs: 22_000, totalDurationMs: 15_000, durationTurns: 3, turns: 3, waitedTurns: 2 };
  // 22 / (22 + 15) = 22/37 = 59.45% -> 59%
  assert.equal(composerWaitPillLabel({ session: after, live: null, now: 1_010_000 }), '22 秒 · 等待占比 59%');
});

test('composerWaitPillLabel：等待结束的瞬间读数连续（不跳变的硬契约）', () => {
  const live = { startedAt: 1_000_000, endsAt: 1_010_000, baseMs: 0 };
  const base = 12_000;
  const during = composerWaitPillLabel({ session: { totalWaitMs: base, totalDurationMs: 22_000, durationTurns: 2 }, live, now: 1_010_000 });
  const settled = composerWaitPillLabel({ session: { totalWaitMs: base + 10_000, totalDurationMs: 22_000, durationTurns: 2 }, live: null, now: 1_010_000 });
  assert.equal(during, settled, '等待结束前后必须显示同一个数');
  // 22 / (22 + 22) = 50%
  assert.equal(during, '22 秒 · 等待占比 50%');
});

test('composerWaitPillLabel：续等（baseMs）也让投影连续，不从 0 重来', () => {
  // 发送间隔等完 6 s 又撞限流退避 10 s：投影必须是 6+… 接着涨。
  const live = { startedAt: 2_000_000, endsAt: 2_010_000, baseMs: 6000 };
  // 0.17.2：本夹具没有耗时记账（durationTurns 缺省 0），因此占比按「未记录」处理、
  // 后缀整段不出现——本条测的是**投影连续**，不是占比。
  assert.equal(composerWaitPillLabel({ session: { totalWaitMs: 0 }, live, now: 2_000_000 }), '6 秒');
  assert.equal(composerWaitPillLabel({ session: { totalWaitMs: 0 }, live, now: 2_004_000 }), '10 秒');
});

// ---- composerWaitPillLabel（0.15.10，0.17.0 对齐）--------------------------

test('composerWaitPillLabel：毫无数据时返回 null（调用方据此不渲染整枚药丸）', () => {
  assert.equal(composerWaitPillLabel({}), null);
  assert.equal(composerWaitPillLabel({ session: emptyWaitStats(), metrics: {} }), null);
});

test('composerWaitPillLabel：本会话等待过 → 只给一个短读数（不超过一行）', () => {
  const label = composerWaitPillLabel({ session: { totalWaitMs: 12_000, totalDurationMs: 48_000, durationTurns: 2, turns: 2, waitedTurns: 1 } });
  // 0.17.0：格式改为「n秒 · 等待占比x%」
  assert.equal(label, '12 秒 · 等待占比 20%');
  assert.ok(!label.includes('距上次发送'));
  assert.ok(label.length < 24);
});

test('composerWaitPillLabel：限流重试作为后缀附上', () => {
  assert.equal(composerWaitPillLabel({ session: { totalWaitMs: 0, rateLimitRetries: 2 } }), '限流重试 2 次');
  assert.equal(
    composerWaitPillLabel({ session: { totalWaitMs: 3000, totalDurationMs: 7000, durationTurns: 1, turns: 1, rateLimitRetries: 1 } }),
    '3 秒 · 等待占比 30% · 限流重试 1 次');
});

test('composerWaitPillLabel：还没等待过但已知距上次发送 → 给一个可核对的数', () => {
  assert.equal(composerWaitPillLabel({ session: emptyWaitStats(), metrics: { sincePrevSendMs: 9400 } }), '距上次发送 9 秒');
});

// ---- waitStatDetailRows（0.15.10，0.17.0 新增占比）------------------------

test('waitStatDetailRows：空账本不给行（面板不留 0 ms 噪音）', () => {
  assert.deepEqual(waitStatDetailRows({}), []);
  assert.deepEqual(waitStatDetailRows({ session: emptyWaitStats() }), []);
});

test('waitStatDetailRows：本会话与累计同屏，且包含会话占比与平均等待时长占比', () => {
  const rows = waitStatDetailRows({
    session: { totalWaitMs: 3000, totalDurationMs: 7000, durationTurns: 2, turns: 2, waitedTurns: 1, rateLimitRetries: 1 },
    total: { totalWaitMs: 20_000, totalDurationMs: 60_000, durationTurns: 9, turns: 9, waitedTurns: 4 },
    metrics: { gapTargetMs: 5000, sincePrevSendMs: 9400 },
  });
  const labels = rows.map(r => r.label);
  assert.ok(labels.includes('本次会话等待发送'));
  assert.ok(labels.includes('本次会话占比'));
  assert.ok(labels.includes('累计等待发送'));
  assert.ok(labels.includes('平均会话等待时长占比'));
  assert.equal(rows.find(r => r.label === '本次会话等待发送').value, '3 秒');
  assert.equal(rows.find(r => r.label === '本次会话占比').value, '30%');
  assert.equal(rows.find(r => r.label === '累计等待发送').value, '20 秒');
  assert.equal(rows.find(r => r.label === '平均会话等待时长占比').value, '25%');
  assert.equal(rows.find(r => r.label === '距上次发送').value, '9 秒');
  assert.equal(rows.find(r => r.label === '发送间隔目标').value, '5 秒');
  // 平均值只在累计里、且只在等待过时给（分母为 0 不许除）。
  assert.equal(rows.find(r => r.label === '平均每次等待').value, '5 秒');
});

test('waitStatDetailRows：累计为 0 时不出现任何累计行', () => {
  const rows = waitStatDetailRows({ session: { totalWaitMs: 1000, turns: 1, waitedTurns: 1 }, total: emptyWaitStats() });
  assert.ok(!rows.some(r => r.label.includes('累计')));
  assert.ok(!rows.some(r => r.label.includes('平均会话等待时长占比')));
});

// ---- waitStatRows ---------------------------------------------------------

test('waitStatRows：基础行与占比行恒在，平均值只在等待过时出现', () => {
  const rows = waitStatRows({ totalWaitMs: 10_000, totalDurationMs: 40_000, durationTurns: 4, turns: 4, waitedTurns: 2 });
  const labels = rows.map(r => r.label);
  assert.ok(labels.includes('累计等待发送'));
  assert.ok(labels.includes('平均会话等待时长占比'));
  assert.ok(labels.includes('已统计轮次'));
  assert.ok(labels.includes('其中等待过'));
  assert.ok(labels.includes('平均每次等待'));
  assert.equal(rows.find(r => r.label === '平均每次等待').value, '5 秒');
  assert.equal(rows.find(r => r.label === '平均会话等待时长占比').value, '20%');

  const sessionRows = waitStatRows({ totalWaitMs: 10_000, totalDurationMs: 30_000, durationTurns: 4, turns: 4, waitedTurns: 2 }, 'session');
  assert.ok(sessionRows.map(r => r.label).includes('本次会话占比'));
  assert.equal(sessionRows.find(r => r.label === '本次会话占比').value, '25%');
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
