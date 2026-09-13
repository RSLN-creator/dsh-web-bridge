// metrics.js — 纯函数：由一次真实发送的阶段指标推导出"实测生成速率"，
// 供 status()/设置页做「估算 vs 实测」展示。与驱动时序解耦，便于单元断言。
//
// contract: 只要传入形如 lastFinished 的对象，charsPerSec 与各阶段毫秒即确定，
// 不依赖任何全局/时序状态。

/** 派生实测速率快照。input 形如 driver.runTurn 挂在 lastFinished 的 {metrics,chars}。 */
export function deriveLastRate(lastFinished, mode = null) {
  if (!lastFinished || !lastFinished.metrics) return null;
  const m = lastFinished.metrics;
  const chars = Number(lastFinished.chars) || 0;
  return {
    chars,
    responseMs: m.responseMs ?? null,
    firstResponseMs: m.firstResponseMs ?? null,
    thinkingMs: m.thinkingMs ?? null,
    endToEndMs: m.endToEndMs ?? null,
    charsPerSec: m.responseMs && m.responseMs > 0 ? Math.round(chars / (m.responseMs / 1000)) : null,
    mode: mode ?? null,
  };
}

/** 网页模型 id → 其请求上报的 model_type 期望值（真机核验契约）。
 *
 *  桥只暴露一个 DeepSeek 模型（2026-09-11 三合一），差异全在「深度思考」：
 *  classic = 旧三 pill UI（≤0.7.2）：deepseek 走专家模式 → model_type=expert；
 *  unified = 2026-09-10 新版 UI：model_type 恒为 default，差异只剩 thinking_enabled
 *  （带图发送同样是 default + ref_file_ids，由网页自行路由）。 */
export const MODEL_TYPES_BY_UI = Object.freeze({
  classic: Object.freeze({ deepseek: 'expert' }),
  unified: Object.freeze({ deepseek: 'default' }),
});
export function expectedModelType(modelId, ui = 'classic') {
  return (MODEL_TYPES_BY_UI[ui] ?? MODEL_TYPES_BY_UI.classic)[modelId] ?? null;
}

/** 一次发送后对 /api/v0/chat/completion 请求体元数据的期望（strict 核验用）。
 *  返回的键若为 null/undefined 则不校验；unified 下 flash/deepseek 的差异
 *  全在 thinking_enabled，model_type 恒为 default。 */
export function expectedRequestMetadata(modelId, { ui = 'classic', wantThink = null } = {}) {
  const model_type = expectedModelType(modelId, ui);
  // 新版统一 UI 下 model_type 恒为 default，模式差异只剩 thinking_enabled。
  if (ui === 'unified') return { model_type, thinking_enabled: wantThink === true };
  return { model_type };
}

/**
 * 发送间隔（设置页「发送间隔」）的纯判定 —— **send-to-send** 语义（0.14.0）。
 *
 * 为什么是纯函数：真机 2026-09-13 用户报「等待时间好像不是按我设置的来」。
 * 取证发现设置**存住了**（`webcode-settings.json` 里 `sendGapMs: 10000`，
 * `GET /__webcode/settings` 也回 10000），真正的原因是三件事，其中两件在
 * 这里被固化成可离线断言的行为：
 *   a) 基准是「上一轮**结束**」而非「上一轮**发出**」——一轮跑了 20.9s 时，
 *      10000ms 的间隔只剩 7609ms 可见（真机 metrics 实测值）；
 *   b) 基准只在进程内存里，重启即清空 → 重启后第一轮零等待。
 * 因此这里只认「上一次**发出**的时刻」，落盘与读回由调用方负责。
 *
 * @param {object} o
 * @param {number|null} o.lastSendAt 上一次向该站点**发出**的 epoch 毫秒（无则 null）
 * @param {number} o.now             当前 epoch 毫秒（显式传入，便于单测钉死）
 * @param {number} o.gapMs           设置值（毫秒，0 = 关闭）
 * @returns {{waitMs:number, sincePrevSendMs:number|null, skewed:boolean}}
 *   waitMs          本轮发送前还应等待的毫秒数
 *   sincePrevSendMs 距上次发出的实际间隔（首次为 null，用于右栏「距上次发送」）
 *   skewed          落盘时间在未来（时钟回拨/跨机拷贝）——调用方应 warn 一行
 */
export function computeSendGap({ lastSendAt, now, gapMs } = {}) {
  const gap = Math.max(0, Math.round(Number(gapMs) || 0));
  const raw = Number(lastSendAt);
  const has = Number.isFinite(raw) && raw > 0;
  // 时钟回拨：基准在未来时既不能按原值等（可能白等几小时），也不能假装没发过
  // 而彻底不落盘。选择「按刚发过处理」——clamp 到 now，于是 waitMs = gap，
  // 是本轮真实需要的最小等待，且把 skewed 交给调用方记录。
  const skewed = has && raw > now;
  const base = has ? Math.min(raw, now) : null;
  const sincePrevSendMs = base == null ? null : Math.max(0, Math.round(now - base));
  if (gap <= 0 || base == null) return { waitMs: 0, sincePrevSendMs, skewed };
  return { waitMs: Math.max(0, Math.round(base + gap - now)), sincePrevSendMs, skewed };
}

/**
 * WIP 稳态判定 —— 「网页端回复了但 Harness 这边卡住」的主修（0.14.0）。
 *
 * 机制（真机 2026-09-13 取证）：网页流可能以 `status:'WIP'` 结束且**永不发
 * FINISHED**，解码器据此返回 `{complete:false, partial:true}`；而驱动的
 * `done` promise 只在收到 `phase==='end'` 或 240s 定时器时才 settle。于是一轮
 * 早已写完的回复会把 `sendTurn` → relay → 适配器的 `await ch.next()` 全部挂住，
 * Harness 侧表现就是**无限「思考中」**，直到 240s 才报超时。
 * 现场证据：`recoveredTurns:1`、`lastRecovered:{reason:'stream_ended_before_finished',
 * status:'WIP', chars:463}`。
 *
 * **安全线（必须有反向单测）**：收束条件是双重的——「流停」**且**「页面 DOM 的
 * 助手消息长度停止增长」。只看流停会截断仍在生成的长回复：思考阶段本就可能
 * 十秒级不吐正文，只看流停等于把正常长回复判死。因此任一条不满足就**不收束**。
 *
 * @param {object} o
 * @param {number} o.now              当前时刻（performance.now() 口径即可）
 * @param {number} o.lastProgressAt   最后一次收到 delta/think/image 的时刻
 * @param {number} o.lastDomGrowthAt  最后一次观察到页面助手消息**变长**的时刻
 * @param {boolean} [o.domAvailable]  页面是否可采样；false 时退回「仅流停」判定
 *                                    （收束原因由调用方标注 dom-unavailable）
 * @param {number} [o.wipIdleMs]      稳态窗口，默认 2500ms
 * @returns {boolean} true = 可以按已有正文收束本轮
 */
export function shouldSettleWip({ now, lastProgressAt, lastDomGrowthAt, domAvailable = true, wipIdleMs = 2500 } = {}) {
  const idle = Math.max(0, Math.round(Number(wipIdleMs) || 0));
  if (!(now - Number(lastProgressAt) >= idle)) return false;   // 流还在动 → 绝不动
  if (!domAvailable) return true;                              // 页面不可用：退回仅流停判定
  return now - Number(lastDomGrowthAt) >= idle;                // 页面还在长 → 绝不动
}

/**
 * 发送前预算闸 —— 「整段提示词超过声明的上下文窗口」必须在**发出之前**拦下来
 *（0.14.1，B-2）。
 *
 * 为什么需要它：桥向 DSH 声明的 `contextWindow` 是**乐观值**（glm/zai 现在是
 * 实测出来的 1M，见 providers.js 的 GLM_CONTEXT_WINDOW），而「声明得偏大」的
 * 代价在旧实现里是**静默的**——DSH 的自动压缩永不触发，transcript 只增不减，
 * 最后要么被网页端截半截（表现为「越到后面越答非所问」），要么撞 240s 超时。
 * 已有的 `PROMPT_TRUNCATED` 回读校验能发现「填进去被截断」，但它发生在**填写
 * 之后**：那时输入框已经被写入，且报错文本只有长度差，看不出「超了预算多少」。
 *
 * 本闸把这件事前移成一道**可解释的拒绝**：拿本轮真正要发的字符数，按站点声明的
 * 窗口折算 token，超了就抛 `CONTEXT_WINDOW_EXCEEDED`，文本里直接给出
 * 「本轮 N 字符 ≈ M token > 声明窗口 W」以及可行的下一步（新开会话 / 调大声明）。
 *
 * 三个刻意的边界：
 *   • **只拦「超预算」，不拦「接近预算」**——留白交给 DSH 的压缩策略，闸门不是
 *     节流器。`ratio > 1` 才拒。
 *   • **拿不到窗口就不拦**（返回 null）。声明值缺失时猜一个数去拒绝用户，比
 *     放行更糟；那种情况由 PROMPT_TRUNCATED 兜底。
 *   • **图片不参与**：它们走附件上传，不占 composer 文本长度。
 *
 * @param {object} o
 * @param {number} o.chars       本轮要发出去的提示词字符数
 * @param {number} o.contextWindow 站点向 DSH 声明的窗口（token）
 * @param {number} [o.charsPerToken] 折算口径，默认 0.7（与 estimateTokens 的 CJK 档一致）
 * @returns {{ok:boolean, tokens:number, window:number, chars:number, ratio:number, overflowTokens:number}|null}
 *          null = 无法判定（窗口缺失/非法），调用方应放行
 */
export function checkContextBudget({ chars, contextWindow, charsPerToken = 0.7 } = {}) {
  const win = Number(contextWindow);
  const n = Number(chars);
  if (!Number.isFinite(win) || win <= 0) return null;      // 没有可信窗口 → 不拦
  if (!Number.isFinite(n) || n < 0) return null;
  const per = Number(charsPerToken) > 0 ? Number(charsPerToken) : 0.7;
  // 与 estimateTokens 同口径：字符 → token 后 +10% 余量，避免「刚好卡线」
  // 的轮次在网页端的真实计费口径下反而越界。
  const raw = n * per;
  const tokens = Math.ceil(raw + raw * 0.1);
  const ratio = tokens / win;
  return {
    ok: ratio <= 1,
    tokens,
    window: win,
    chars: n,
    ratio,
    overflowTokens: Math.max(0, tokens - win),
  };
}

const CJK_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;
/**
 * 估算字符串的 token 数（纯函数，供 usage/"估算 vs 实测"展示）。
 * 旧实现按 字符数/4 估算，对中文严重低估（汉字≈0.7–1 token，英文≈0.25 token/字符），
 * 导致中文对话的进度/用量显示与网页真实消费差距很大。改为 CJK 约 0.7 tok、ASCII 约 0.25 tok，
 * 末尾 +10% 安全余量。
 */
export function estimateTokens(s) {
  const str = s ? String(s) : '';
  if (str.length === 0) return 0;
  let cjk = 0;
  for (const ch of str) if (CJK_RE.test(ch)) cjk++;
  const ascii = str.length - cjk;
  const base = cjk * 0.7 + ascii * 0.25;
  return Math.max(1, Math.ceil(base + base * 0.1));
}