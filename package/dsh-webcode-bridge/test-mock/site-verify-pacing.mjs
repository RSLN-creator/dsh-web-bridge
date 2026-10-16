// site-verify-pacing.mjs — 真机验收的**发送间隔闸门**（纯函数 + 一个等待器）。
//
// ## 为什么需要这个文件（0.19.82 修出的第二个「验收工具自己违规」）
//
// `.tmp/real-lane/PHASE2-RUNBOOK.md` §3 写着「同站点两次发送之间 ≥20s（本脚本内部
// 三轮间隔由 `sendGapMs` 控制）」。**那句话是假的**：修前 `site-verify.mjs` 连一次
// `setTimeout`/`sleep` 都没有（可 grep 证伪），三轮发送是**背靠背连发**。
//
// 这不是文档小错，是**风控事故面**：
//   · `sendGapMs` 是产品里**唯一**一档发送节流（`lib/index.js:3783` 的
//     `computeSendGap`），用户设的是 `30000` / 基准 `end-to-start`；
//   · 验收脚本绕开它 = 用比产品严苛得多的节奏去打站点 ⇒ 制造风控，
//     而风控一旦触发，四态会记成 `BLOCKED`——**外部原因掩盖了工具自己的违规**。
//
// 因此本文件把「间隔」做成**可离线断言**的一层，并**复用产品的两个真源**：
//   · `lib/accounts.js` 的 `sendGapForSlot`（槽 → 站点 → 全局 的回落链，**不另写一份**）；
//   · `lib/metrics.js` 的 `computeSendGap`（send-to-send / end-to-start 的判定，
//     **不另写一份**）。
// 与 `lib/prompt-variants.js` 同一条纪律：只挑参数、调真函数，不复制协议。
//
// ## 地板值（≥20s）是**独立于设置**的下限
//
// 设置值为 0（关掉节流）时，产品会零等待——那是用户在**自己可控的日常节奏**下的选择。
// 但验收脚本是**人为制造负载**（同一站点连发多轮），所以它必须额外守一条地板：
// 无论设置写什么，两次真实发送之间都不低于 `MIN_SEND_GAP_MS`。这条地板来自
// 真机纪律（`CONTRIBUTING.md` §1.3：每变体 ≤3 次、间隔 ≥20s），不是设置值的派生量。
import { computeSendGap } from '../lib/metrics.js';
import { sendGapForSlot } from '../lib/accounts.js';

/**
 * 验收脚本的发送间隔**地板**（毫秒）。
 *
 * 刻意是常量而不是读设置：设置可以被用户改成 0，而验收的连发形态本身需要保护。
 */
export const MIN_SEND_GAP_MS = 20_000;

/** 基准只认逐字 `'end-to-start'`，与产品同一归一化（`lib/index.js:3609`）。 */
export function normalizeGapBasis(basis) {
  return basis === 'end-to-start' ? 'end-to-start' : 'send-to-send';
}

/**
 * 本轮实际该等多久才发（毫秒）——**设置值与地板取较大者**。
 *
 * @param {object} o
 * @param {object|null} o.settings   产品的 settings 对象（`webcode-settings.json`）
 * @param {string} o.accountKey      槽键（默认槽 = siteId）
 * @param {string} o.siteId          站点 id
 * @param {number} o.now             epoch 毫秒（显式传入，便于单测钉死）
 * @param {number|null} o.lastSendAt 上一次**发出**的时刻
 * @param {number|null} o.lastEndAt  上一次**生成结束**的时刻
 * @param {number} [o.floorMs]       地板（默认 MIN_SEND_GAP_MS）
 * @returns {{waitMs:number, gapMs:number, basis:string, configuredMs:number, floorMs:number,
 *            sincePrevMs:number|null, skewed:boolean}}
 *          `gapMs` = 实际采用值（= max(configured, floor)），`configuredMs` 是设置里那一个
 *          ——两者分开回显，好让读数能区分「按设置等」与「被地板托住」。
 */
export function planSendGap({
  settings = null, accountKey, siteId, now, lastSendAt = null, lastEndAt = null,
  floorMs = MIN_SEND_GAP_MS,
} = {}) {
  const raw = sendGapForSlot(settings, accountKey, siteId);
  const parsed = Number(raw);
  const configuredMs = Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
  const floor = Math.max(0, Math.round(Number(floorMs) || 0));
  const gapMs = Math.max(configuredMs, floor);
  const basis = normalizeGapBasis(settings && typeof settings === 'object' ? settings.sendGapBasis : undefined);
  const plan = computeSendGap({ lastSendAt, lastEndAt, basis, now, gapMs });
  return {
    waitMs: plan.waitMs,
    gapMs,
    basis: plan.basis,
    configuredMs,
    floorMs: floor,
    sincePrevMs: plan.sincePrevSendMs,
    skewed: plan.skewed,
  };
}

/**
 * 按计划的毫秒数等待（可被 abort 打断）。
 *
 * 单独存在（而不是让调用方内联 `setTimeout`）是为了让「验收脚本到底等了没有」
 * **只有一个实现**——旧缺陷正是「没有任何一处等待」。
 */
export function sleepMs(ms, { signal } = {}) {
  const n = Math.max(0, Math.round(Number(ms) || 0));
  if (!n) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, n);
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted while waiting send gap')); };
    if (signal) {
      if (signal.aborted) { clearTimeout(t); reject(new Error('aborted while waiting send gap')); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
