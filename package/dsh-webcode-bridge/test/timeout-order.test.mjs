// timeout-order.test.mjs — 三层超时的**大小顺序**本身是一条判据（0.16.3）。
//
// ## 为什么需要这个文件
//
// 从浏览器到适配器，同一条链上串了三类超时：
//
//   中继外层（relay.requestTimeoutMs）
//     > 驱动单轮（browser-driver requestTimeoutMs）
//       > 适配器看门狗窗口（IDLE_TIMEOUT_MS × 首字节倍数）
//
// 顺序写错**不会**让任何功能测试变红——每一层单独看都正常工作，只是谁先开火由
// 事件循环决定。而三层的报错信息质量差别很大：
//
//   · 驱动那层带页面现场（捕获链是否存活、页面已有多少字回复未回传）；
//   · 看门狗那层带相位与最近驱动活动；
//   · 中继那层只有一句 `request timed out after Nms`。
//
// 0.16.3 之前三层默认全是 240s。真机后果有两条，都不是推测：
//   ① 同一条 deadline 上三个定时器赛跑，用户可能拿到信息量最少的那句；
//   ② 更要命的是首字节相位：看门狗宽限后的窗口（120s × 2 = 240s）**恰好等于**
//      整轮总超时，于是「网页还在 prefill」的那一轮会被整轮超时先杀掉——
//      本轮**要修**的那次事故（2026-09-17，127,888 字符输入）会原样复现，
//      只是报错从 WEB_NO_PROGRESS 换成了 web turn timed out。
//
// 所以顺序必须被钉住。本文件读**源码事实**（默认值与接线），不依赖任何真机。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.dirname(here);
const indexSrc = fs.readFileSync(path.join(pkg, 'lib', 'index.js'), 'utf8');
const driverSrc = fs.readFileSync(path.join(pkg, 'lib', 'browser-driver.js'), 'utf8');

/** 从源码里取 `key: 数字` 的默认值；取不到就抛（宁可红，也不静默跳过一条判据）。 */
function numericDefault(src, key, where) {
  const re = new RegExp(`\\b${key}\\s*:\\s*([0-9][0-9_]*)\\b`);
  const m = src.match(re);
  assert.ok(m, `在 ${where} 里找不到 ${key} 的默认值——判据无法求值，不允许静默跳过`);
  return Number(m[1].replace(/_/g, ''));
}

// ── ① 三层预算的默认值必须是 240s / 480s / ≤216s（相位窗口被压到 90%）──────

test('① 默认预算：驱动单轮 240s，中继外层 ×2，相位窗口被压到预算的 90% 以内', async () => {
  const driverTurn = numericDefault(indexSrc, 'requestTimeoutMs', 'lib/index.js DEFAULTS');
  const firstByteMul = numericDefault(indexSrc, 'idleFirstByteMultiplier', 'lib/index.js DEFAULTS');
  assert.equal(driverTurn, 240_000, '驱动单轮预算改变了：请同步复核下面两条顺序');
  assert.equal(firstByteMul, 2);

  // 看门狗常规窗口的**默认**没有写进 DEFAULTS（0.15.x 起就不在配置表里），
  // 它的默认值在接线语句里：`Number(cfg.idleTimeoutMs) || 120_000`。断言这条
  // 接线本身，而不是去 DEFAULTS 里找一个不存在的键——否则判据会静默失效。
  const idleBase = (() => {
    const m = indexSrc.match(/Number\(cfg\.idleTimeoutMs\)\s*\|\|\s*([0-9_]+)/);
    assert.ok(m, '找不到看门狗常规窗口的默认值接线（Number(cfg.idleTimeoutMs) || N）');
    return Number(m[1].replace(/_/g, ''));
  })();
  assert.equal(idleBase, 120_000);

  // 相位窗口必须**严格小于**整轮预算：默认 120s×2 恰好等于 240s，纯函数负责
  // 把它压到预算的 90%（留 10% 余量，见 lib/idle-window.js）。
  const { idleWindowDecision } = await import('../lib/idle-window.js');
  const d = idleWindowDecision({
    baseMs: idleBase, firstEventAt: null, driverBusy: true,
    multiplier: firstByteMul, totalBudgetMs: driverTurn,
  });
  assert.equal(d.phase, 'awaiting-first-byte');
  assert.ok(d.windowMs < driverTurn,
    `相位窗口 ${d.windowMs}ms 必须严格小于整轮预算 ${driverTurn}ms，否则两者在同一条 deadline 上赛跑`);
  assert.equal(d.windowMs, Math.round(driverTurn * 0.9), '余量应当是整轮预算的 10%');
  assert.equal(d.capped, true, '被预算压缩时必须如实标出 capped');
});

// ── ② 中继外层必须**严格大于**两个内层 ─────────────────────────────────────

test('② 中继外层超时必须严格大于驱动单轮预算（否则它在同一条 deadline 上赛跑）', () => {
  // 接线事实：relay 的 requestTimeoutMs 由 index.js 现算，不再是 cfg 原值。
  assert.match(
    indexSrc,
    /requestTimeoutMs:\s*\(Number\(cfg\.requestTimeoutMs\)\s*\|\|\s*240_000\)\s*\*\s*2/,
    'relay 的 requestTimeoutMs 必须显式放大（见 createRelay 处的注释），'
    + '否则它和驱动单轮预算同值、由事件循环决定谁先开火',
  );
  const driverTurn = numericDefault(indexSrc, 'requestTimeoutMs', 'lib/index.js DEFAULTS');
  assert.ok(driverTurn * 2 > driverTurn);
});

// ── ③ 驱动单轮预算必须**不小于**首字节相位窗口 ─────────────────────────────

test('③ 驱动单轮预算 ≥ 首字节相位窗口（否则宽限还没用完就被整轮超时杀掉）', async () => {
  const driverTurn = numericDefault(indexSrc, 'requestTimeoutMs', 'lib/index.js DEFAULTS');
  const firstByteMul = numericDefault(indexSrc, 'idleFirstByteMultiplier', 'lib/index.js DEFAULTS');
  const { idleWindowDecision } = await import('../lib/idle-window.js');
  for (const base of [120_000, 180_000, 60_000]) {
    const d = idleWindowDecision({
      baseMs: base, firstEventAt: null, driverBusy: true,
      multiplier: firstByteMul, totalBudgetMs: driverTurn,
    });
    assert.ok(
      d.windowMs < driverTurn,
      `baseMs=${base} 时相位窗口 ${d.windowMs}ms ≥ 整轮预算 ${driverTurn}ms：`
      + '「网页还在 prefill」的那一轮会被整轮超时先杀掉，本轮要修的事故会原样复现',
    );
  }
  // 反向安全线：常规窗口本身**不受**整轮预算压缩（只有宽限那一格会被压），
  // 已开流的轮次仍然按 IDLE_TIMEOUT_MS 照旧快报。
  const mid = idleWindowDecision({
    baseMs: driverTurn, firstEventAt: Date.now(), driverBusy: true,
    multiplier: firstByteMul, totalBudgetMs: driverTurn,
  });
  assert.equal(mid.phase, 'mid-stream');
  assert.equal(mid.windowMs, driverTurn);
  assert.equal(mid.capped, false);
});

// ── ④ 接线护栏：两个 driver 构造点都必须真的把预算传下去 ────────────────────

test('④ requestTimeoutMs 必须同时到达默认槽与非默认槽（两处，缺一即静默不一致）', () => {
  const hits = indexSrc.match(/requestTimeoutMs:\s*cfg\.requestTimeoutMs/g) || [];
  assert.equal(hits.length, 2,
    '驱动构造点从两处变成 ' + hits.length + ' 处：'
    + '一个槽拿到预算、另一个槽拿驱动内建默认值（240s）时，两槽行为静默不一致');
});

// ── ⑤ 反向安全线：驱动内建默认值不得被改成别的数 ───────────────────────────

test('⑤ 驱动内建默认 240s 保持（它只在宿主没传时生效，改了等于换了一条安全线）', () => {
  assert.match(driverSrc, /requestTimeoutMs:\s*options\.requestTimeoutMs\s*\?\?\s*240_000/,
    'browser-driver 的内建默认值变了：这是「宿主没传」时的兜底，改动必须是有意识的');
});
