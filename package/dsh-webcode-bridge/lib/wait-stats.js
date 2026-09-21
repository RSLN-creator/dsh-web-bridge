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
  const durationMs = Math.max(0, Math.round(Number(m.durationMs) || 0));
  const rateLimitRetries = Math.max(0, Math.round(Number(m.rateLimitRetries) || 0));
  return { sendWaitMs, durationMs, rateLimitRetries };
}

/** 空账本。键名短，因为它会落盘并被前端直接读。 */
export function emptyWaitStats() {
  return { totalWaitMs: 0, totalDurationMs: 0, durationTurns: 0, turns: 0, rateLimitRetries: 0, waitedTurns: 0, updatedAt: null };
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
  const { sendWaitMs, durationMs, rateLimitRetries } = waitOfTurn(metrics);
  return {
    totalWaitMs: Math.max(0, Math.round(Number(base.totalWaitMs) || 0)) + sendWaitMs,
    totalDurationMs: Math.max(0, Math.round(Number(base.totalDurationMs) || 0)) + durationMs,
    // 0.17.2：**有耗时记账的轮次**。见 waitRatio 的说明——没有这个计数，占比就会把
    // 「0.17.0 之前那些只记了等待、没记耗时的轮次」算成「耗时≈0」，于是老账本读出 100%。
    // 它是**覆盖率判据**，不是第二个 turns。
    durationTurns: Math.max(0, Math.round(Number(base.durationTurns) || 0)) + (durationMs > 0 ? 1 : 0),
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
    totalDurationMs: num(raw.totalDurationMs),
    // durationTurns **不向后推断**：旧账本里 durationMs 从未被记过（0.17.0 才引入），
    // 缺失就是 0，即「这些轮次的耗时可核范围为零」。绝不能拿 totalDurationMs>0 反推成
    // 「这些轮次都有耗时」——那正是 100% 假读数的来源。
    durationTurns: num(raw.durationTurns),
    turns: num(raw.turns),
    rateLimitRetries: num(raw.rateLimitRetries),
    // waitedTurns 允许缺失（旧账本没有这个字段）——缺失时退回「有等待的轮次」
    // 未知即为 0，但不得让它在后续累加里变成 NaN。
    waitedTurns: num(raw.waitedTurns),
    updatedAt: Number.isFinite(Number(raw.updatedAt)) && Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : null,
  };
}

/**
 * 人类可读的时长。**全部中文单位、秒级不补小数**（0.16.39）：
 *   < 1 秒   → `123 ms`
 *   < 1 分钟 → `42 秒`
 *   < 1 小时 → `3 分 05 秒`
 *   其余     → `1 小时 02 分 09 秒`
 *
 * ## 0.16.39：为什么把 `4.2 s` / `2 小时 07 分` 换掉
 *
 * 用户原话：「请你列出秒，当有分钟时候，然后是面板点击展开」。旧口径有两处让人
 * 读不出来：秒级带一位小数（`4.2 s`），小时的写法**把秒吃掉了**（`2 小时 07 分`
 * 少报最多 59 秒，而这个数在面板里是要与「本会话累计」对齐核对的）。
 * 现在三档分别是「N 秒」「M 分 SS 秒」「H 小时 MM 分 SS 秒」——**每一档都带秒**，
 * 因此同一个数在药丸、点击面板、设置页统计块里读出来是同一个量。
 *
 * 末尾单位仍然补零（`3 分 05 秒` 而不是 `3 分 5 秒`）：同一列里宽度才稳定，扫读
 * 时不会跳动。前导单位不补零（它是可变长的读数）。
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
  const totalSec = Math.round(n / 1000);
  if (totalSec < 60) return totalSec + ' 秒';
  if (totalSec < 3600) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m + ' 分 ' + String(s).padStart(2, '0') + ' 秒';
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h + ' 小时 ' + String(m).padStart(2, '0') + ' 分 ' + String(s).padStart(2, '0') + ' 秒';
}

/**
 * 百分比格式化（0.17.0）。
 *
 * 参考 DSH 官方 token-format / StatsPills 的百分比规范：
 *   - 非有限正数或 <= 0 → '0%'
 *   - >= 100 → '100%'
 *   - 0 < n < 1 → 保留一位小数（例如 '0.5%'），避免非零被抹成 '0%'
 *   - 其余取整 → '15%'
 *
 * @param {number} num
 * @returns {string}
 */
export function formatPercent(num) {
  const n = Number(num);
  if (!Number.isFinite(n) || n <= 0) return '0%';
  if (n >= 100) return '100%';
  if (n < 1) return (Math.round(n * 10) / 10) + '%';
  return Math.round(n) + '%';
}

/**
 * 等待占比的**唯一计算入口**（0.17.2）。
 *
 * ## 为什么不能直接 `waitMs / (waitMs + durationMs)`
 *
 * 0.17.0 就是这么算的，而 `totalDurationMs` 是 0.17.0 才引入的字段。账本**落盘**且
 * 跨版本延续，于是升级那一刻磁盘上的老账本长这样（真机实测 `POST /__webcode/wait-stats`）：
 *
 * ```
 * totalWaitMs: 113215468   totalDurationMs: 521868   turns: 8579
 * ```
 *
 * 31 小时的等待对上 8.7 分钟的耗时——但那 8.7 分钟只是**最近几轮**的，8579 轮里绝大多数
 * 发生在 `durationMs` 存在之前，它们的分母贡献是 0。算出来的占比是 **100%**（同一份读数
 * 在设置页「历史累计」栏里被印成「平均会话等待时长占比 100%」）。用户看到的是一句荒谬的
 * 结论：这台机器上的时间几乎全花在节流等待上。
 *
 * 占比本身没错，错的是**分母的覆盖范围与分子不一致**：分子覆盖全部 8579 轮，分母只覆盖
 * 其中一小撮。判据因此必须是「耗时记账覆盖了几轮」，而不是「耗时 > 0」。
 *
 * 三种读数（都不是猜的）：
 *   · 全覆盖  → `61%`
 *   · 零覆盖  → `未记录`（一个百分比都不给，避免把无数据印成 0% 或 100%）
 *   · 部分覆盖 → `61%（覆盖 40/57 轮）`——数字带上它的适用边界
 *
 * @param {object} o
 * @param {number} o.waitMs 分子：等待发送
 * @param {number} o.durationMs 分母中的模型耗时
 * @param {number} o.durationTurns 有耗时记账的轮次
 * @param {number} o.turns 总轮次
 * @returns {string|null} 无可核对的分母时返回 null
 */
export function waitRatio({ waitMs, durationMs, durationTurns, turns } = {}) {
  const w = Math.max(0, Number(waitMs) || 0);
  const d = Math.max(0, Number(durationMs) || 0);
  const covered = Math.max(0, Math.round(Number(durationTurns) || 0));
  const total = Math.max(0, Math.round(Number(turns) || 0));
  if (w <= 0) return null;
  // 零覆盖：分母完全不可用。**不返回百分比**——0% 与 100% 都是错的，而任何一个数字都会
  // 被当成结论读走。如实说「没记」是这里唯一不撒谎的答案。
  if (covered === 0) return '未记录';
  const pct = formatPercent((w / (w + d)) * 100);
  if (total > 0 && covered < total) return pct + '（覆盖 ' + covered + '/' + total + ' 轮）';
  return pct;
}

/**
 * 「正在等待」那一段的时长（0.16.24）。
 *
 * 与 {@link formatDuration} 只差一处，但那一处正是需求本身：秒级**向下取整**
 * 且**不带任何小数位**（`3 秒` 而不是 `3.9 秒`）。理由是这串数字会**逐秒跳动**
 *——官方在输入框底下那枚统计药丸就是「开始就涨」，不是等结束了再一次性显示；
 * 跳动时小数位只是噪声。
 *
 * 0.16.39：单位改成中文「秒」，与 formatDuration 的秒档**逐字相同**；此前这里是
 * `3 s` 而对方是 `3.9 s`，同一枚药丸在等待中与结算后读出来像是两个单位。
 * 分钟以上继续与 formatDuration 合流（`3 分 05 秒`）：两套写法必须给出同一个数，
 * 否则药丸与面板又会互相打架。
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0 秒';
  if (n < 60_000) return Math.floor(n / 1000) + ' 秒';
  return formatDuration(n);
}

/**
 * 「这一轮正在等待发送」的实时读数（0.16.24）。
 *
 * 为什么需要它：`sendWaitMs` 是**事后结算**的——它在整轮生成结束、relay 把
 * metrics 交回来时才落进账本。于是旧实现里，等待期间药丸什么都不显示（首次
 * 等待时整枚不渲染），等一切结束数字才一次性跳出来。用户原话：「能做到等待
 * 发送实际显示和官方一样开始就计时增长，不要等过了再变一下子从 n 秒到 m 秒？」
 *
 * 官方那枚药丸自带起始时刻，本地定时器把「已过时长」画出来——它计的是**正在
 * 发生**的时长。这里用同一条思路，但把「现在几点」交给调用方（纯函数），服务端
 * 每次轮询现算：这样文案仍然只有一个来源（本模块），客户端不需要第二份时长
 * 格式化——那正是本文件开头说的「两个数字迟早对不上」。
 *
 * `baseMs` 是本轮**此前已经等过**的时长（发送间隔补满之后又撞上限流退避时，
 * 数字必须接着涨而不是从 0 重来），`endsAt` 之后时长冻结在满值——因为那时
 * 等待确实结束了，只是整轮生成还没跑完、账本还没结算。
 *
 * @param {{startedAt:number, endsAt?:number, baseMs?:number}} live
 * @param {number} [now] 现算时刻（显式传入便于单测钉死）
 * @returns {string|null} 无在途等待时返回 null
 */
export function liveWaitLabel(live, now = Date.now()) {
  if (!live || typeof live !== 'object') return null;
  const startedAt = Number(live.startedAt);
  if (!Number.isFinite(startedAt)) return null;
  const baseMs = Math.max(0, Math.round(Number(live.baseMs) || 0));
  const endsAt = Number(live.endsAt);
  // endsAt 缺失（理论上不会）时按「还没到期」处理：宁可多涨一会儿，也不要
  // 让一个缺字段把正在等待的读数变成 null（那会让药丸凭空消失）。
  const ceiling = Number.isFinite(endsAt) ? endsAt : Math.max(now, startedAt);
  const elapsed = Math.max(0, Math.min(now, ceiling) - startedAt);
  return '等待发送 ' + formatElapsed(baseMs + elapsed);
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
 * @param {'total'|'session'} [scope] 标签前缀（0.16.39）。设置页现在**两本账并排
 *   展示**（本会话 + 历史累计），两套行必须能一眼分清是哪一个，因此标签按 scope
 *   生成，而不是调用方各自拼字符串——拼字符串迟早会有一处写成「累计」而值是本会话。
 * @returns {{label:string,value:string}[]}
 */
export function waitStatRows(stats, scope = 'total') {
  const s = sanitizeWaitStats(stats);
  const isSession = scope === 'session';
  const rows = [];
  if (isSession) {
    rows.push({ label: '本会话等待发送', value: formatDuration(s.totalWaitMs) });
    const sessionRatio = waitRatio({ waitMs: s.totalWaitMs, durationMs: s.totalDurationMs, durationTurns: s.durationTurns, turns: s.turns });
    if (sessionRatio) rows.push({ label: '本次会话占比', value: sessionRatio });
    rows.push({ label: '本会话轮次', value: s.turns + ' 轮' });
    rows.push({ label: '其中等待过', value: s.waitedTurns + ' 轮' });
  } else {
    rows.push({ label: '累计等待发送', value: formatDuration(s.totalWaitMs) });
    const totalRatio = waitRatio({ waitMs: s.totalWaitMs, durationMs: s.totalDurationMs, durationTurns: s.durationTurns, turns: s.turns });
    if (totalRatio) rows.push({ label: '平均会话等待时长占比', value: totalRatio });
    rows.push({ label: '已统计轮次', value: s.turns + ' 轮' });
    rows.push({ label: '其中等待过', value: s.waitedTurns + ' 轮' });
  }
  if (s.waitedTurns > 0) {
    rows.push({ label: '平均每次等待', value: formatDuration(Math.round(s.totalWaitMs / s.waitedTurns)) });
  }
  if (s.rateLimitRetries > 0) rows.push({ label: '限流重试', value: s.rateLimitRetries + ' 次' });
  if (s.updatedAt) rows.push({ label: '最近更新', value: new Date(s.updatedAt).toLocaleString() });
  return rows;
}

/**
 * 设置页「速度与等待」里那块统计区的**数据形状**（0.16.39）。
 *
 * 返回 `[{title, rows:[{label,value}]}]`：两栏并排（本会话 / 历史累计），每栏的行
 * 由本模块现算——**客户端不拼标签、不算时长**（client.cjs 是单文件 bundle，
 * import 不到这里；让它自己拼，两处口径迟早分叉，这正是本文件开头那条纪律）。
 *
 * 行序是**从「此刻最想知道」到「历史」**：本会话累计 → 轮次 → 本轮读数
 *（发送间隔目标 / 距上次发送）→ 限流重试；累计栏同理。空账本时那栏 rows 为空，
 * 客户端会画「暂无记录」，而不是显示一排 0。
 *
 * @param {object} o
 * @param {object} [o.session] 本会话账本
 * @param {object} [o.total] 累计账本
 * @param {object} [o.metrics] 本轮 relay.metrics（提供间隔目标与距上次发送）
 * @returns {{title:string, rows:{label:string,value:string}[]}[]}
 */
export function waitStatBlocks({ session, total, metrics } = {}) {
  const s = sanitizeWaitStats(session);
  const t = total ? sanitizeWaitStats(total) : null;
  const m = metrics || {};
  const sessionRows = [];
  if (s.totalWaitMs > 0 || s.turns > 0) {
    sessionRows.push({ label: '本会话等待发送', value: formatDuration(s.totalWaitMs) });
    const sessionRatio = waitRatio({ waitMs: s.totalWaitMs, durationMs: s.totalDurationMs, durationTurns: s.durationTurns, turns: s.turns });
    if (sessionRatio) sessionRows.push({ label: '本次会话占比', value: sessionRatio });
    sessionRows.push({ label: '本会话轮次', value: s.turns + ' 轮' });
    if (s.waitedTurns > 0) sessionRows.push({ label: '其中等待过', value: s.waitedTurns + ' 轮' });
    if (s.rateLimitRetries > 0) sessionRows.push({ label: '限流重试', value: s.rateLimitRetries + ' 次' });
  }
  // 本轮读数与账本无关（可能还没结算），因此只要 metrics 有就显示。
  if (m.gapTargetMs > 0) sessionRows.push({ label: '发送间隔目标', value: formatDuration(m.gapTargetMs) });
  if (m.sincePrevSendMs != null) {
    sessionRows.push({
      label: m.gapBasis === 'end-to-start' ? '距上次回复完成' : '距上次发送',
      value: formatDuration(m.sincePrevSendMs),
    });
  }
  const totalRows = t && t.totalWaitMs > 0 ? waitStatRows(t, 'total') : [];
  return [
    { title: '本会话', rows: sessionRows },
    { title: '历史累计', rows: totalRows },
  ];
}

/**
 * 在途等待**已过**的毫秒数（0.16.26）。
 *
 * 与 {@link liveWaitLabel} 同一套边界（`startedAt` / `endsAt` / `baseMs`），
 * 只是把结果作为**数字**交给调用方。存在的理由是把药丸读数从「分段拼接」改成
 * 「投影求和」：见 {@link composerWaitPillLabel} 的 0.16.26 说明。
 *
 * @param {{startedAt:number, endsAt?:number, baseMs?:number}} live
 * @param {number} [now] 现算时刻
 * @returns {number} 无在途等待时为 0
 */
export function liveWaitMs(live, now = Date.now()) {
  if (!live || typeof live !== 'object') return 0;
  const startedAt = Number(live.startedAt);
  if (!Number.isFinite(startedAt)) return 0;
  const baseMs = Math.max(0, Math.round(Number(live.baseMs) || 0));
  const endsAt = Number(live.endsAt);
  const ceiling = Number.isFinite(endsAt) ? endsAt : Math.max(now, startedAt);
  return baseMs + Math.max(0, Math.min(now, ceiling) - startedAt);
}

/**
 * 输入框底下那枚药丸的**短文案**（0.15.10，0.17.0 对齐「n秒 · 等待占比x%」）。
 *
 * 与 `composerWaitLine` 的区别是长度预算：官方在同一个槽位放的是 13px 单行
 * 药丸（ui-chat 的 StatsPills），一行只容得下「一个数 + 一个后缀」。
 *
 * 0.17.0：文案格式调整为「n秒 · 等待占比x%」，中间以官方药丸的间隔点（` · `）分隔。
 * 占比以「本会话等待总量（含在途） / 本会话总活跃耗时（等待总量 + 模型耗时）」现算；
 * 限流重试作为后缀附上；完全没数据时返回 null，调用方整枚药丸不渲染。
 * 其余细节全部进点击面板（见 {@link waitStatDetailRows}）。
 *
 * 0.16.24：**在途等待优先**。还在等的时候，药丸显示的是「正在等的这一段」
 * （`live` 现算），而不是上一轮结算完的旧数。
 *
 * 0.16.26：**读数改成「会话累计 + 在途增量」的连续投影**（用户报的跳变）。
 *
 * @param {object} o
 * @param {object} [o.session] 本会话账本
 * @param {object} [o.metrics] 本轮 relay.metrics
 * @param {object} [o.live] 在途等待（见 {@link liveWaitLabel}）
 * @param {number} [o.now] 现算时刻
 * @returns {string|null}
 */
export function composerWaitPillLabel({ session, metrics, live, now } = {}) {
  const s = sanitizeWaitStats(session);
  const m = metrics || {};
  const parts = [];
  // 0.16.26：一个数、一个来源。账本是**本轮之前**的累计，live 是本轮进行中的
  // 增量，两者相加才是「本会话等待发送」的当前真值。live 消失后账本已被本轮
  // 结算补上，相加项自然归零，读数不变——这正是它不再跳变的原因。
  const projectedMs = s.totalWaitMs + liveWaitMs(live, now);
  if (projectedMs > 0) {
    // 药丸是 13px 单行，容不下「（覆盖 40/57 轮）」这种尾巴——因此这里只在**全覆盖**
    // 时给出百分比；未覆盖就只报时长，让点开的面板去说明边界（waitStatDetailRows）。
    const ratio = waitRatio({ waitMs: projectedMs, durationMs: s.totalDurationMs, durationTurns: s.durationTurns, turns: s.turns });
    // 只接受**纯百分比**：`未记录` 与 `61%（覆盖 40/57 轮）` 都带不了——药丸是 13px 单行，
    // 容不下覆盖率尾巴；而「未记录」写上去比不写更长且更费解。边界一律交给点开的面板。
    const suffix = ratio && /^\d+(\.\d+)?%$/.test(ratio) ? ' · 等待占比 ' + ratio : '';
    parts.push(formatElapsed(projectedMs) + suffix);
  }
  if (s.rateLimitRetries > 0) parts.push('限流重试 ' + s.rateLimitRetries + ' 次');
  // 还没等待过、但已知距上次发送：至少给一个可核对的数，而不是空药丸。
  if (!parts.length && m.sincePrevSendMs != null) parts.push('距上次发送 ' + formatDuration(m.sincePrevSendMs));
  if (!parts.length) return null;
  return parts.join(' · ');
}

/**
 * 点击药丸后那面板里的详情行（0.15.10，对齐官方 stat-dialog 的 dl 网格）。
 *
 * 官方统计药丸的交互契约是「默认只给一个数，点开才有明细」（StatsPills 的
 * TimePill/UsagePill 各带一个 stat-dialog）。这里照同一套来：本会话在前、
 * 累计在后，每行一个可核对的标签值对。空账本不出行——面板不留 `0 ms` 噪音。
 *
 * 0.17.0：详细展开面板中新增显示「本次会话占比」与「平均会话等待时长占比」。
 *
 * @param {object} o
 * @param {object} [o.session] 本会话账本
 * @param {object} [o.total] 累计账本
 * @param {object} [o.metrics] 本轮 relay.metrics
 * @param {object} [o.live] 在途等待
 * @param {number} [o.now] 现算时刻
 * @returns {{label:string,value:string}[]}
 */
export function waitStatDetailRows({ session, total, metrics, live, now } = {}) {
  const s = sanitizeWaitStats(session);
  const t = total ? sanitizeWaitStats(total) : null;
  const m = metrics || {};
  const rows = [];
  const projectedMs = s.totalWaitMs + liveWaitMs(live, now);
  if (projectedMs > 0 || s.turns > 0) {
    rows.push({ label: '本次会话等待发送', value: formatElapsed(projectedMs) });
    const sessionRatio = waitRatio({ waitMs: projectedMs, durationMs: s.totalDurationMs, durationTurns: s.durationTurns, turns: s.turns });
    if (sessionRatio) rows.push({ label: '本次会话占比', value: sessionRatio });
    rows.push({ label: '本次会话轮次', value: s.turns + ' 轮' });
    if (s.rateLimitRetries > 0) rows.push({ label: '本次会话限流重试', value: s.rateLimitRetries + ' 次' });
  }
  if (m.gapTargetMs > 0) rows.push({ label: '发送间隔目标', value: formatDuration(m.gapTargetMs) });
  if (m.gapBasis === 'end-to-start') rows.push({ label: '间隔基准', value: '距上次回复完成' });
  else if (m.gapBasis === 'send-to-send') rows.push({ label: '间隔基准', value: '距上次发出' });
  if (m.sincePrevSendMs != null) {
    const sinceLabel = m.gapBasis === 'end-to-start' ? '距上次回复完成' : '距上次发送';
    rows.push({ label: sinceLabel, value: formatDuration(m.sincePrevSendMs) });
  }
  if (t && t.totalWaitMs > 0) {
    rows.push({ label: '累计等待发送', value: formatDuration(t.totalWaitMs) });
    const totalRatio = waitRatio({ waitMs: t.totalWaitMs, durationMs: t.totalDurationMs, durationTurns: t.durationTurns, turns: t.turns });
    if (totalRatio) rows.push({ label: '平均会话等待时长占比', value: totalRatio });
    rows.push({ label: '累计已统计', value: t.turns + ' 轮' });
    if (t.waitedTurns > 0) rows.push({ label: '平均每次等待', value: formatDuration(Math.round(t.totalWaitMs / t.waitedTurns)) });
  }
  return rows;
}
