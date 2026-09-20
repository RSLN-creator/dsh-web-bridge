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
 * 「正在等待」那一段的时长（0.16.24）。
 *
 * 与 {@link formatDuration} 只差一处，但那一处正是需求本身：秒级**取整**
 * （`3 s`）而不是留一位小数（`3.0 s`）。理由是这串数字会**逐秒跳动**——
 * 官方在输入框底下那枚统计药丸就是「开始就涨」，不是等结束了再一次性显示；
 * 跳动时小数位只是噪声。
 *
 * 到分钟以上与 formatDuration 合流（`3 分 05 秒`）：那时没人盯着末位看，
 * 两套写法必须给出同一个数，否则药丸与面板又会互相打架。
 *
 * @param {number} ms
 * @returns {string}
 */
export function formatElapsed(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return '0 s';
  if (n < 60_000) return Math.floor(n / 1000) + ' s';
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
 * 输入框底下那枚药丸的**短文案**（0.15.10）。
 *
 * 与 `composerWaitLine` 的区别是长度预算：官方在同一个槽位放的是 13px 单行
 * 药丸（ui-chat 的 StatsPills），一行只容得下「一个数 + 一个后缀」。旧实现把
 * 本会话、距上次发送、限流三件事全塞进一行，于是它只能另起一行、和官方那排
 * 药丸分成两栏——用户报的「两栏」正是这么来的。
 *
 * 这里只留最要紧的那个数：本会话累计等待（等过才有）。限流重试作为后缀附上；
 * 完全没数据时返回 null，调用方整枚药丸不渲染。其余细节全部进点击面板
 * （见 {@link waitStatDetailRows}）。
 *
 * 0.16.24：**在途等待优先**。还在等的时候，药丸显示的是「正在等的这一段」
 * （`live` 现算），而不是上一轮结算完的旧数——否则用户看到的是一个不动的
 * 数字，等结束才跳一下，正是他要修掉的那个观感。
 *
 * 0.16.26：**读数改成「会话累计 + 在途增量」的连续投影**（用户报的跳变）。
 *
 * 0.16.24 把 live 与账本当成两个可互换的显示源，于是同一枚药丸在两种语义之间
 * 来回切：等的时候显示「这一轮等了多久」，等一结束 live 被清、回落到
 * `s.totalWaitMs`「本会话一共等了多久」。用户看到的就是——数字从 1 s 缓慢涨到
 * 8 s（这一轮把发送间隔补满），然后**一跳**到「2 分多」（会话历史累计）。
 * 两次读数都「对」，但它们不是同一个量，拼在一枚药丸里就是假跳变。
 *
 * 正确的量只有一个：**本会话到目前为止的等待发送总量，把正在等的这一段也算进去**。
 * 它在等待期间逐秒增长（`s.totalWaitMs + liveWaitMs`），等待结束、账本结算后
 * 收敛到同一个数（`s.totalWaitMs` 已经含了刚刚那一段）——**连续、单调、不跳**。
 * 这也正是用户最初要的「和官方一样开始就计时增长」。
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
  if (projectedMs > 0) parts.push('等待发送 ' + formatElapsed(projectedMs));
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
 * @param {object} o
 * @param {object} [o.session] 本会话账本
 * @param {object} [o.total] 累计账本
 * @param {object} [o.metrics] 本轮 relay.metrics
 * @returns {{label:string,value:string}[]}
 */
export function waitStatDetailRows({ session, total, metrics } = {}) {
  const s = sanitizeWaitStats(session);
  const t = total ? sanitizeWaitStats(total) : null;
  const m = metrics || {};
  const rows = [];
  if (s.totalWaitMs > 0 || s.turns > 0) {
    // 0.16.24：本会话这一行用 formatElapsed，与药丸同写法——它是「还在变的那个
    // 数」（药丸在途时显示它、结算后回落到它）。累计/平均是历史账，继续用
    // formatDuration 的 `20.0 s`：两者不该混成一个。
    rows.push({ label: '本次会话等待发送', value: formatElapsed(s.totalWaitMs) });
    rows.push({ label: '本次会话轮次', value: s.turns + ' 轮' });
    if (s.rateLimitRetries > 0) rows.push({ label: '本次会话限流重试', value: s.rateLimitRetries + ' 次' });
  }
  if (m.gapTargetMs > 0) rows.push({ label: '发送间隔目标', value: formatDuration(m.gapTargetMs) });
  // 0.16.31：口径必须与目标值并列出现。同一条读数下两个口径给出不同结论，
  // 只写「目标 10 s」而不管它是从「上次发出」还是「上次回复完成」起算，
  // 用户看到的仍是「等待不像我设的」——而这次连该改哪儿都指不出来。
  if (m.gapBasis === 'end-to-start') rows.push({ label: '间隔基准', value: '距上次回复完成' });
  else if (m.gapBasis === 'send-to-send') rows.push({ label: '间隔基准', value: '距上次发出' });
  if (m.sincePrevSendMs != null) {
    // 标签只在**口径明确**时才切换。`gapBasis` 缺失（旧 metrics / 注入桩）时保持
    // 「距上次发送」这个历史文案——缺字段不等于口径变了，悄悄换词会让读者以为
    // 基准换了（旧读数配新词，比不显示更误导）。
    const sinceLabel = m.gapBasis === 'end-to-start' ? '距上次回复完成' : '距上次发送';
    rows.push({ label: sinceLabel, value: formatDuration(m.sincePrevSendMs) });
  }
  if (t && t.totalWaitMs > 0) {
    rows.push({ label: '累计等待发送', value: formatDuration(t.totalWaitMs) });
    rows.push({ label: '累计已统计', value: t.turns + ' 轮' });
    if (t.waitedTurns > 0) rows.push({ label: '平均每次等待', value: formatDuration(Math.round(t.totalWaitMs / t.waitedTurns)) });
  }
  return rows;
}
