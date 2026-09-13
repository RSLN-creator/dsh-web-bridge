// wait-stats.js — 「本次会话总等待发送时间」与「累计等待时长」的纯计算层。
//
// 需求（0.14.4，用户原话）：「增加harness输入界面框底下速度-增加本次会话的总等待
// 发送消息时间，保持和官方格式类似，然后是设置界面新增统计所有累计的等待时长」。
//
// 两件事被刻意分成同一个纯模块，因为它们必须用**同一个口径**：
//   • 输入框底下那条速览 = 本会话（本次会话累计）的等待；
//   • 设置页那条累计     = 历史所有会话的等待。
// 若各算一套，两个数字迟早对不上，用户就无法信任任何一个。
//
// 口径定义（与 relay.metrics.sendWaitMs 同源）：
//   sendWaitMs 只统计**发送前那段主动等待**——发送间隔（sendGapMs）补满 +
//   限流退避重试。它发生在网页生成之前，因此**不计入** durationMs。
//   这正是用户说的「等待发送消息时间」：不是模型思考，不是生成耗时，而是
//   「因为节流而没能立刻发出去」的那段。
//
// 纯函数契约：不碰磁盘、不读全局、不依赖时间流动；所有时刻由调用方显式传入。

/** 单次调用的等待增量（从 relay.metrics 抽字段，缺失一律按 0）。 */
export function waitOfTurn(metrics) {
  const m = metrics || {};
  const sendWaitMs = Math.max(0, Math.round(Number(m.sendWaitMs) || 0));
  const rateLimitRetries = Math.max(0, Math.round(Number(m.rateLimitRetries) || 0));
  return { sendWaitMs, rateLimitRetries };
}

/** 空账本。键名短，因为它会落盘并被前端直接读。 */
export function emptyWaitStats() {
  return { totalWaitMs: 0, turns: 0, rateLimitRetries: 0, waitedTurns: 0, updatedAt: null };
}

/**
 * 把一次调用累加进账本。
 *
 * `waitedTurns` 单独计数（而不是用 turns>0 推断）：用户要判断「平均每次等多久」时，
 * 分母应当是**真的等待过的那些轮次**——一轮跑了 20 秒、间隔 10 秒早已满足的轮次
 * 等待为 0，把它算进分母只会让平均值失真。
 *
 * @param {object} prev 上一次的账本（null/损坏按空账本处理）
 * @param {object} metrics 本轮 relay.metrics
 * @param {number} [now] 记账时刻（显式传入便于单测钉死）
 * @returns {object} 新账本（新对象，不修改入参）
 */
export function accumulateWait(prev, metrics, now = Date.now()) {
  const base = prev && typeof prev === 'object' ? prev : emptyWaitStats();
  const { sendWaitMs, rateLimitRetries } = waitOfTurn(metrics);
  return {
    totalWaitMs: Math.max(0, Math.round(Number(base.totalWaitMs) || 0)) + sendWaitMs,
    turns: Math.max(0, Math.round(Number(base.turns) || 0)) + 1,
    rateLimitRetries: Math.max(0, Math.round(Number(base.rateLimitRetries) || 0)) + rateLimitRetries,
    waitedTurns: Math.max(0, Math.round(Number(base.waitedTurns) || 0)) + (sendWaitMs > 0 ? 1 : 0),
    updatedAt: now,
  };
}

/** 落盘前的形状校验：文件可能被手改、被旧版本写过、或半截写入。 */
export function sanitizeWaitStats(raw) {
  if (!raw || typeof raw !== 'object') return emptyWaitStats();
  const num = (v) => { const n = Number(v); return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0; };
  return {
    totalWaitMs: num(raw.totalWaitMs),
    turns: num(raw.turns),
    rateLimitRetries: num(raw.rateLimitRetries),
    // waitedTurns 允许缺失（旧账本没有这个字段）——缺失时退回「有等待的轮次」
    // 未知即为 0，但不得让它在后续累加里变成 NaN。
    waitedTurns: num(raw.waitedTurns),
    updatedAt: Number.isFinite(Number(raw.updatedAt)) && Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : null,
  };
}

/**
 * 人类可读的时长。**与官方格式对齐**（用户要求「保持和官方格式类似」）：
 *   < 1 秒   → `123 ms`
 *   < 1 分钟 → `4.2 s`
 *   < 1 小时 → `3 分 05 秒`
 *   其余     → `2 小时 07 分`
 *
 * 刻意不用 `toLocaleString`：它随宿主 locale 变（同一份 UI 在不同机器上显示不同），
 * 而面板文案必须稳定可核对。
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatDuration(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0 ms';
  if (n < 1000) return Math.round(n) + ' ms';
  if (n < 60_000) return (n / 1000).toFixed(1) + ' s';
  const totalSec = Math.round(n / 1000);
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m + ' 分 ' + String(s).padStart(2, '0') + ' 秒';
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return h + ' 小时 ' + String(m).padStart(2, '0') + ' 分';
}

/**
 * 输入框底下那条速览要显示的文字（单行，官方风格）。
 *
 * 数据不足时返回 null —— 调用方据此**不渲染**整行，而不是显示一堆 `--`。
 * 这是「必要时才出现」的克制：新用户第一条消息前不该看到空统计。
 *
 * @param {object} o
 * @param {object} o.session 本会话账本
 * @param {object} [o.metrics] 本轮 relay.metrics（用于「距上次发送」）
 * @returns {string|null}
 */
export function composerWaitLine({ session, metrics } = {}) {
  const s = sanitizeWaitStats(session);
  const m = metrics || {};
  const parts = [];
  // 本会话累计：只要等过就显示（用户最关心的那个数）。
  if (s.totalWaitMs > 0) parts.push('本次会话等待发送 ' + formatDuration(s.totalWaitMs));
  // 距上次发送：解释「为什么这一轮等了 / 没等」——与右栏统计同一口径。
  if (m.sincePrevSendMs != null) parts.push('距上次发送 ' + formatDuration(m.sincePrevSendMs));
  if (s.rateLimitRetries > 0) parts.push('限流重试 ' + s.rateLimitRetries + ' 次');
  if (!parts.length) return null;
  return parts.join(' · ');
}

/**
 * 设置页那条累计统计的展示行（多段，交给 UI 排版）。
 *
 * @param {object} stats 累计账本
 * @returns {{label:string,value:string}[]}
 */
export function waitStatRows(stats) {
  const s = sanitizeWaitStats(stats);
  const rows = [
    { label: '累计等待发送', value: formatDuration(s.totalWaitMs) },
    { label: '已统计轮次', value: s.turns + ' 轮' },
    { label: '其中等待过', value: s.waitedTurns + ' 轮' },
  ];
  if (s.waitedTurns > 0) {
    rows.push({ label: '平均每次等待', value: formatDuration(Math.round(s.totalWaitMs / s.waitedTurns)) });
  }
  if (s.rateLimitRetries > 0) rows.push({ label: '限流重试', value: s.rateLimitRetries + ' 次' });
  if (s.updatedAt) rows.push({ label: '最近更新', value: new Date(s.updatedAt).toLocaleString() });
  return rows;
}
