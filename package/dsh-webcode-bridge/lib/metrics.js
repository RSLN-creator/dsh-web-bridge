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

/**
 * 该模型在当前 UI 代际下应该发出的 `model_type`。
 *
 * 用途是**核验**而不是构造：驱动实际发出请求后回读请求体，拿这个期望值比对，
 * 不一致就是 UI 代际判断错了（网页改版），此时如实报出来，而不是把差异吞掉
 * 让用户以为「模型变笨了」。认不出该 modelId 时返回 `null`（= 不作断言），
 * 而不是猜一个值——猜错会让核验变成误报来源。
 *
 * @param {string} modelId 模型 id
 * @param {'classic'|'unified'} [ui] UI 代际；未知代际回落 classic
 * @returns {string|null} 期望的 model_type，认不出时为 null
 */
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
 * @param {number|null} [o.lastEndAt] 上一次**生成结束**的 epoch 毫秒（basis='end-to-start' 用）
 * @param {'send-to-send'|'end-to-start'} [o.basis] 间隔基准（默认 send-to-send）
 * @param {number} o.now             当前 epoch 毫秒（显式传入，便于单测钉死）
 * @param {number} o.gapMs           设置值（毫秒，0 = 关闭）
 * @returns {{waitMs:number, sincePrevSendMs:number|null, skewed:boolean, basis:string}}
 *   waitMs          本轮发送前还应等待的毫秒数
 *   sincePrevSendMs 距基准的实际间隔（首次为 null）——basis 决定它是「距上次发出」
 *                   还是「距上次回复完成」
 *   skewed          落盘时间在未来（时钟回拨/跨机拷贝）——调用方应 warn 一行
 *   basis           本次判定实际采用的基准（回显，便于读数核对）
 *
 * ## 两个基准的区别（0.16.31 新增 end-to-start）
 *
 * `send-to-send`（默认，0.14.0 起）：基准是上一轮**发出**的时刻。它防的是
 * 「向站点发得太密」——站点的滑窗限流按请求到达计，与生成耗时无关，所以上一轮
 * 跑得久时本轮**无需再等**（真机读数：一轮 20.9s 时 10000ms 间隔只剩 7609ms 可见）。
 *
 * `end-to-start`（0.16.31，用户要求）：基准是上一轮**生成结束**的时刻。它防的是
 * 另一种模式——「它刚答完我立刻回」，即对话节奏上贴得太紧。此时上一轮跑了多久
 * **不影响**本轮的等待：答完那一刻起重新数 N 秒。
 *
 * 两者不能互相替代，因此并存为可选项，默认逐字保持旧行为。
 *
 * 基准记录缺失时返回 `waitMs: 0`（无基准 = 首轮 = 无可回避），而不是拿另一个
 * 基准凑一个数——凑出来的等待无法解释，也会让「读数可核对」这条纪律失守。
 */
export function computeSendGap({ lastSendAt, lastEndAt = null, basis = 'send-to-send', now, gapMs } = {}) {
  const gap = Math.max(0, Math.round(Number(gapMs) || 0));
  const mode = basis === 'end-to-start' ? 'end-to-start' : 'send-to-send';
  const raw = Number(mode === 'end-to-start' ? lastEndAt : lastSendAt);
  const has = Number.isFinite(raw) && raw > 0;
  // 时钟回拨：基准在未来时既不能按原值等（可能白等几小时），也不能假装没发过
  // 而彻底不落盘。选择「按刚发过处理」——clamp 到 now，于是 waitMs = gap，
  // 是本轮真实需要的最小等待，且把 skewed 交给调用方记录。
  const skewed = has && raw > now;
  const base = has ? Math.min(raw, now) : null;
  const sincePrevSendMs = base == null ? null : Math.max(0, Math.round(now - base));
  if (gap <= 0 || base == null) return { waitMs: 0, sincePrevSendMs, skewed, basis: mode };
  return { waitMs: Math.max(0, Math.round(base + gap - now)), sincePrevSendMs, skewed, basis: mode };
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
 * 「只有思维链、永远不出正文」的绝对上限判定（0.15.2）——**第三条防线**。
 *
 * ## 为什么 `shouldSettleWip` 单独不够（真机故障：只出思维链然后卡死）
 *
 * 上面那条判据是双条件「流停 **且** 页面 DOM 助手消息停止增长」。它有一个
 * 结构性盲区：DeepSeek 在思考阶段会把「思考中 / Thought for Ns」这类**计时文案**
 * 持续写进同一个助手节点。采样器量的是该节点的 `innerText.length`，于是
 * `lastDomGrowthAt` 被计时器无休止地刷新——**「DOM 停长」这条永远不成立**，
 * 收束器永不动作。而看门狗（`index.js` 的 `nextWithIdle`）按「最后一个 delta」
 * 计时，思考增量同样刷新它，也判不出「还活着但永远不回答」。
 *
 * 结果是：模型思考完就停住、正文一个字符都不来、DOM 只剩计时器在动，两条防线
 * 都认为「还在进行」，唯一的兜底是 240s 的驱动总超时——且报错是通用
 * `web turn timed out`，看不出「只出了思维链」。
 *
 * ## 判据为什么是「自从有过正文以来」而不是「最后一次任何增量」
 *
 * 关键是**只认正文**：`lastAnswerAt` 在正文 delta 与图片到达时刷新，**思考增量
 * 刻意不刷新**。这样「一直思考」与「思考完给出正文」在判据上是两种不同状态——
 * 前者会一路逼近上限，后者一有正文就归零。若把思考也算进「进展」，本函数就退化成
 * 了 `shouldSettleWip` 的重复，修不了任何东西。
 *
 * ## 安全线（必须有反向单测）
 *
 * - 有正文在持续产出 → `lastAnswerAt` 不断刷新 → **永不命中**，长回复不会被截断。
 * - 思考还在动、但正文没来 → 本函数**会**在硬上限命中。这是**有意**的取舍：
 *   只出思考不出正文对用户就是「卡死」，宁可如实报「只有思考没有回答」让会话
 *   继续，也不要让界面无限转圈。语义由调用方在 `settled_by` 里如实标注。
 *
 * @param {object} o
 * @param {number} o.now           当前时刻（与 `lastAnswerAt` 同口径即可）
 * @param {number} o.lastAnswerAt  最后一次收到**正文/图片**的时刻（思考不算）
 * @param {number} o.hardCapMs     绝对上限；<=0 或非有限值 = 关闭该判据
 * @returns {boolean} true = 只出思维链且已到硬上限，应按已有内容收束本轮
 */
export function shouldSettleStalledThinking({ now, lastAnswerAt, hardCapMs } = {}) {
  const cap = Number(hardCapMs);
  if (!Number.isFinite(cap) || cap <= 0) return false;         // 未配置 → 判据关闭
  const base = Number(lastAnswerAt);
  // 没有基线（从未收到过任何正文）时必须如实返回 false。
  //
  // **必须同时挡 null**：`Number(null)` 是 0 且 `Number.isFinite(0)` 为真，只判
  // isFinite 的话缺失的基线会被读成「epoch 0」——也就是「已经等了一万年」，
  // 于是每一轮缺字段时都在第一个 tick 被判死。那是比不修更坏的回归
  // （单测「缺 lastAnswerAt 基线」就是钉这一条的）。
  if (!Number.isFinite(base) || base <= 0) return false;
  return Number(now) - base >= cap;
}

/**
 * 页面助手节点的「真实回答」长度 —— 剥掉思考计时文案后的字符数（0.15.2）。
 *
 * ## 为什么需要剥（真机故障：只出思维链然后卡死）
 *
 * `shouldSettleWip` 的双条件之一是「页面 DOM 的助手消息长度停止增长」。旧实现
 * 直接量最后一个助手节点的 `innerText.length`，而 DeepSeek 在思考阶段会把
 * 「思考中…」「Thought for 12s」这类**计时文案**持续写进同一个节点——秒数一变，
 * 长度就变，于是 `lastDomGrowthAt` 被无休止刷新，**「DOM 停长」永远不成立**，
 * 收束器永不动作。计时器在动 ≠ 模型在产出内容。
 *
 * 因此这里把计时形态整段剥掉再量长度：只留真正的回答正文。
 *
 * ## 剥的边界（宁可少剥，不可多剥）
 *
 * 只认**整行**的计时形态（`思考中`、`深度思考中`、`Thought for Ns`、
 * `已思考 N 秒`，可带省略号与首尾空白），且**逐行**判定——不是只剥尾部。
 * 理由是真实 DOM 形状：思考区在回答**上方**，计时行出现在开头而不是结尾；
 * 只剥尾部等于什么都没剥。正文中间出现「思考中」这三个字（比如模型在解释这个
 * 概念）只要不独占一行就不受影响。
 *
 * 匹配不上就原样返回，最坏情况退化成旧行为（量到计时器长度），不会把正文量少。
 *
 * @param {string} text 助手节点 innerText
 * @returns {number} 剥掉计时行后的字符数
 */
export function answerDomLength(text) {
  const raw = String(text ?? '');
  if (!raw) return 0;
  // 计时文案的形态（中英双语，秒数可变）：
  //   中文：思考中 / 深度思考中 / 已思考 12 秒 / 思考了 12 秒
  //   英文：Thought for 12s / Thinking / Thinking...
  // 统一要求「整行只由该形态构成」，避免吃掉正文里的普通句子。
  const TIMER_LINE = /^\s*(?:(?:深度思考中|思考中|已思考\s*\d+\s*秒|思考了\s*\d+\s*秒|Thought\s+for\s+\d+\s*s(?:ec(?:onds?)?)?|Thinking)[.…]{0,3})\s*$/i;
  const kept = raw
    .split(/\r?\n/)
    .filter((line) => !TIMER_LINE.test(line))
    .join('\n');
  return kept.trim().length;
}

/**
 * 发送前预算闸 —— 「整段提示词超过声明的上下文窗口」必须在**发出之前**拦下来
 *（0.14.1，B-2；0.16.22 改按真实文本构成折算）。
 *
 * 为什么需要它：桥向 DSH 声明的 `contextWindow` 是**乐观值**（glm/zai 现在是
 * 实测出来的 1M，见 providers.js 的 GLM_CONTEXT_WINDOW），而「声明得偏大」的
 * 代价在旧实现里是**静默的**——DSH 的自动压缩永不触发，transcript 只增不减，
 * 最后要么被网页端截半截（表现为「越到后面越答非所问」），要么撞 240s 超时。
 * 已有的 `PROMPT_TRUNCATED` 回读校验能发现「填进去被截断」，但它发生在**填写
 * 之后**：那时输入框已经被写入，且报错文本只有长度差，看不出「超了预算多少」。
 *
 * 本闸把这件事前移成一道**可解释的拒绝**：拿本轮真正要发的**文本**，按
 * `estimateTokens` 的 CJK 感知口径折算 token，超了就抛 `CONTEXT_WINDOW_EXCEEDED`，
 * 文本里直接给出「本轮 N 字符 ≈ M token > 声明窗口 W」以及可行的下一步
 *（新开会话 / 调大声明）。
 *
 * 为什么收 `text` 而不是 `chars`（0.16.22 修）：旧实现按 `chars × 0.7` 平铺折算，
 * 那是 CJK 档的密度。工具型会话的提示词主体是**英文/代码/JSON**（工具 schema、
 * 工具结果、官方 tool-call 模板），真实密度低于中文档——平铺一个高密度会把这类
 * prompt 高估近 3 倍，长英文轮次会被**误拒**（真机 2026-09-19：整段英文工具结果
 * 远未到窗口就吃 CONTEXT_WINDOW_EXCEEDED）。字符数不构成信息，**字符构成**才
 * 构成——折算必须走与展示同源的 `estimateTokens`（三类单价见 `TOKEN_DENSITY`，
 * 自带余量，这里不得再加第二道余量）。
 *
 * 三个刻意的边界：
 *   • **只拦「超预算」，不拦「接近预算」**——留白交给 DSH 的压缩策略，闸门不是
 *     节流器。`ratio > 1` 才拒。
 *   • **拿不到窗口就不拦**（返回 null）。声明值缺失时猜一个数去拒绝用户，比
 *     放行更糟；那种情况由 PROMPT_TRUNCATED 兜底。
 *   • **图片不参与**：它们走附件上传，不占 composer 文本长度。
 *
 * @param {object} o
 * @param {string} o.text        本轮要发出去的提示词原文（图片 base64 不在其中）
 * @param {number} o.contextWindow 站点向 DSH 声明的窗口（token）
 * @returns {{ok:boolean, tokens:number, window:number, chars:number, ratio:number, overflowTokens:number}|null}
 *          null = 无法判定（窗口缺失/非法），调用方应放行
 */
export function checkContextBudget({ text, contextWindow } = {}) {
  const win = Number(contextWindow);
  if (!Number.isFinite(win) || win <= 0) return null;      // 没有可信窗口 → 不拦
  const s = text == null ? '' : String(text);
  // 折算与展示同源：estimateTokens 是唯一的字符→token 单价表（含 +10% 余量）。
  // 这里若再乘一道余量就是双重加成，会把「刚好卡线」的轮次误拒。
  const tokens = estimateTokens(s);
  const chars = s.length;
  const ratio = tokens / win;
  return {
    ok: ratio <= 1,
    tokens,
    window: win,
    chars,
    ratio,
    overflowTokens: Math.max(0, tokens - win),
  };
}

const CJK_RE = /\p{Script=Han}|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Hangul}/u;

/**
 * 字符→token 的单价表（三类 + 统一余量）。**唯一真相**：usage、OpenAI 前端、
 * 右栏统计、发送前预算闸、压缩压力全部经 `estimateTokens`，不许任何一处另写系数。
 *
 * 系数来源见 [`doc/research/2026-09-23-token-density-calibration.md`](../../../doc/research/2026-09-23-token-density-calibration.md)：
 * 用本机凭据对**官方端点**实测六类样本后拟合，并取「每类都 ≥ 实测」的可行解。
 *
 * | 类 | 旧值 | 实测 | 现值 |
 * | --- | --- | --- | --- |
 * | CJK | 0.7 | 0.74 tok/字 | **0.75** |
 * | 散文 ASCII（字母/空白） | 0.25 | 0.23 tok/字符 | **0.30** |
 * | 其余 ASCII（数字/标点/运算符） | 0.25 | 0.37–0.68 tok/字符 | **0.70** |
 *
 * 为什么必须拆出第三类（2026-09-23 实测）：旧实现把「代码/JSON/命令行」和「英文散文」
 * 混成同一个 0.25，于是**源码低估 33%、数字与符号低估 63%**——而这两类正是编码 agent
 * 的主要流量。中文那一侧旧值本来就偏高，不是问题所在（用户直觉指向中文，实测推翻）。
 *
 * `margin` 是明确标注的**余量**，不是校准结果：标定用的是 API 侧 `deepseek-chat`，
 * 而桥驱动的是**网页版**模型，其分词器未公开，因此保留 10% 超额（口径：宁可高报）。
 */
export const TOKEN_DENSITY = Object.freeze({ cjk: 0.75, word: 0.3, other: 0.7, margin: 0.1 });

/** ASCII 字母与空白（`\t\n\v\f\r` + 空格）——走 word 单价；其余一律 other。 */
function isAsciiWordChar(code) {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || code === 32 || (code >= 9 && code <= 13);
}

/**
 * 估算字符串的 token 数（纯函数，供 usage / "估算 vs 实测" 展示 / 预算闸共用）。
 *
 * 口径纪律：**宁可高报，不可低估**（用户指令「关于真实计费，做不到就保险往高报」）。
 * 因此系数取的是实测可行解的上界，再叠 `TOKEN_DENSITY.margin`。副作用要一起认：
 * 同一段文本的读数比 0.19.3 之前普遍偏高（代码与 JSON 最明显），上下文压力与
 * DSH 压缩触发点随之变早。
 *
 * @param {unknown} s 待估文本（空值按 0）。
 * @returns {number} 非负整数 token 估算。
 */
export function estimateTokens(s) {
  const str = s ? String(s) : '';
  if (str.length === 0) return 0;
  let cjk = 0;
  let word = 0;
  let other = 0;
  for (const ch of str) {
    if (CJK_RE.test(ch)) { cjk += 1; continue; }
    // 逐码点取一次 codePointAt：ascii 判定走整数比较，比再跑一条正则快得多，
    // 而 estimateTokens 会被喂进十万级字符的整段提示词。
    if (isAsciiWordChar(ch.codePointAt(0))) word += 1; else other += 1;
  }
  const base = cjk * TOKEN_DENSITY.cjk + word * TOKEN_DENSITY.word + other * TOKEN_DENSITY.other;
  return Math.max(1, Math.ceil(base + base * TOKEN_DENSITY.margin));
}
