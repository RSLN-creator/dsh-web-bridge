// idle-window.js — 适配器侧「无进展」看门狗该用哪把尺子（纯函数，可离线反向验证）。
//
// ## 为什么必须分相位：一次真机事故（2026-09-17，DeepSeek 网页）
//
// 旧实现只有一把尺子：自上一次事件起 120s 内没有任何新事件 ⇒ `WEB_NO_PROGRESS`。
// 它把两个完全不同的阶段量成了同一件事：
//
//   阶段 A（prefill / 首个 token 之前）：这一轮发进网页的是 **127,888 字符**纯文本
//     （`POST /__webcode/history` 的 user 消息读数：工具教学 38,279 + 会话 transcript
//     89,609），网页要先把整个上下文 prefill 一遍才吐第一个 token——几十秒到几分钟
//     都是**正常**的；
//   阶段 B（已经开流之后突然静默 120s）：这才是「卡住」。
//
// 事故现场（解会话 session-dff3edf7 的 session.v3.jsonl.zstd，29 帧）：
//   · turn1 step5 从 18:41:59 到 18:43:51 **跨度 112 秒零事件** → 适配器侧 120s
//     看门狗开火，报 `WEB_NO_PROGRESS`；
//   · 同一轮 step1-4 **每一步都有事件**（工具调用 2-4 条）⇒ **捕获链是活的**，
//     不是链路坏；
//   · 那一刻页面在、`busy`（网页那侧仍在生成）——用户看到的就是「web 明明有回复，
//     桥说没内容」。
//
// 所以修法不是把窗口一律调大（那会让真正的卡死也晚 120s 才报），而是**按相位选窗口**：
//
//   · 首个事件已到（mid-stream）                    → 常规窗口，**不给宽限**；
//   · 首个事件未到 + 驱动报告本轮仍在忙（prefill）   → `baseMs × multiplier`（默认 2 倍）；
//   · 首个事件未到 + 驱动不在忙（= 捕获链没跑起来）  → 常规窗口，**同样不给宽限**：
//     链路已经死了还给宽限，只会把故障从 120s 拖到 240s 才暴露，比旧行为更糟。
//
// 判据抽成这个纯函数（不读时钟、不碰驱动、无副作用）是为了能**离线反向验证**；
// 接线级护栏见 test/watchdog-first-byte.test.mjs（① 首字节宽限、② mid-stream 不得
// 宽限、③ 驱动不忙不得宽限、④ 默认 2 倍、⑤ 超时报错带出驱动现场读数）。
//
// 接线点：lib/index.js 的 `nextWithIdle()`（适配器侧看门狗）在**每次 next() 之前**
// 重算；驱动侧的两段现场读数（`lastActivityAt` / `domReplyChars`）见
// lib/browser-driver.js 的 status() 投影。

/** baseMs 缺席/非法时的回落值（= 旧实现的上限，配置写错不会改变安全线）。 */
const DEFAULT_BASE_MS = 120_000;

/** 正数化：非数字（含 NaN / ±Infinity / 字符串垃圾）与 <=0 一律回落到给定值。
 *  绝不放行 NaN／Infinity 进 setTimeout：NaN 会被当成 0 ⇒ 定时器立刻开火，等于
 *  把每一轮都判死；Infinity 则是永不超时（看门狗形同不存在）。 */
function positiveOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 无进展看门狗的窗口判据。
 *
 * 返回的 `phase` 是**给报错文本用的**：下一次事故里「超过 240s 没有任何新内容」
 * 到底是宽限后的窗口还是常规窗口必须一眼可读——旧实现只给一个超时数字，看门狗
 * 开火时分不清「网页还没开口」与「网页不说了」，这正是这次事故绕远路的原因。
 *
 * @param {number} [baseMs] 常规静默窗口；非法（<=0/NaN/非数字）→ 120_000。
 * @param {number|null} firstEventAt 本轮**首个** delta/think/image 到达的时刻。由调用方
 *   在**自己这一轮的闭包**里置位，不问驱动：驱动的 status 是跨轮共享的（该事故里
 *   看门狗读到的 `lastEndReason=finished` 其实是**上一轮**的收束原因），「网页开口了
 *   没有」必须严格属于本轮。只有**显式 null** 才算「还没开口」；undefined／其他值按
 *   「已到」处理——宁可快报，也不让一个忘传的参数把安全线悄悄放宽。
 * @param {boolean} [driverBusy] 驱动 `status().busy`。懒驱动的 status 可能是 null 或
 *   抛错 ⇒ 调用方一律按 false 传（取不到现场时按「链路没跑起来」处理）。
 * @param {number} [multiplier] 首字节相位的倍数（配置 `idleFirstByteMultiplier`）；
 *   非法（<=0/NaN/非数字）→ 1（= 不做任何放宽）。
 * @param {number} [totalBudgetMs] 驱动**整轮**预算（`requestTimeoutMs`）。给了就对
 *   相位窗口设上限（见下）。缺省/非法 ⇒ 不设上限（纯函数保持无依赖、可独立求值）。
 * @returns {{ windowMs: number, phase: 'awaiting-first-byte' | 'mid-stream', firstEventSeen: boolean, capped: boolean }}
 *
 * ## 为什么相位窗口必须留有余量（capped 字段的来由，0.16.3）
 *
 * 看门狗开火只是让适配器这一侧失败，**不会**取消网页那侧的生成——取消网页的是驱动
 * 自己的整轮超时（它会带页面现场）。所以两者绝不能同一条 deadline：
 * 谁先开火由事件循环决定，而**信息量最少的那个报错**一旦先到，页面现场就丢了。
 *
 * 真机默认下 120s×2 = 240s 恰好等于驱动整轮预算 240s，正是这种同值赛跑。这里把
 * 相位窗口压到整轮预算的 90%，于是看门狗永远先于整轮超时开火，且报错里带着
 * 「判定相位=网页还没开口」与最近驱动活动时间。capped=true 表示余量生效了，
 * 调用方与护栏据此能看出「窗口是被预算压过的」而不是配置写错。
 */
export function idleWindowDecision({ baseMs, firstEventAt, driverBusy, multiplier = 2, totalBudgetMs } = {}) {
  const base = positiveOr(baseMs, DEFAULT_BASE_MS);
  const mul = positiveOr(multiplier, 1);
  // 本轮**是否真的收到过事件**（0.19.23 新增，必须显式带出去）。
  //
  // 为什么非加不可：`phase` 的 `'mid-stream'` 同时覆盖两种情形——
  //   ① 开流之后静默（真的卡住）；
  //   ② 还没开流且驱动不忙（链路没跑起来，按常规窗口快报）。
  // 只看 phase 的读者会把 ② 读成「已开流后的静默」——那是一句**假陈述**。
  // 真机报错（session-e7056e8c turn3 step58）里它就与「最近驱动活动时间 1s 前」
  // 并排出现，读起来自相矛盾，排查方向当场被带偏。
  //
  // 这是**加法**：`phase` 的取值与窗口计算逐字不变，既有护栏
  // （test/watchdog-first-byte.test.mjs）不受影响；新增的读法给报错文案用。
  const firstEventSeen = firstEventAt !== null;
  // 已经开流 → 阶段 B：不管驱动忙不忙都按常规窗口判（多等只会让真正卡住的轮次更晚失败）。
  if (firstEventSeen) return { windowMs: base, phase: 'mid-stream', firstEventSeen, capped: false };
  // 还没开口，但链路没跑起来 → 不给宽限（见文件头第三条安全线）。
  if (driverBusy !== true) return { windowMs: base, phase: 'mid-stream', firstEventSeen, capped: false };
  // 还没开口 + 网页正在忙 = prefill。倍数只在**这一格**生效；Math.round 而非 floor：
  // 配置成 1.5 这类非整数倍时不要凭空少给半毫秒。
  const wanted = Math.round(base * mul);
  const budget = positiveOr(totalBudgetMs, 0);
  if (budget <= 0) return { windowMs: wanted, phase: 'awaiting-first-byte', firstEventSeen, capped: false };
  // 留 10% 余量（至少 1s）：余量必须**严格**大于零，同值就是上面那条赛跑。
  const reserve = Math.max(1_000, Math.round(budget * 0.1));
  const ceiling = budget - reserve;
  // 余量本身比 base 还小（极端配置，如整轮预算 1.2s）时，宁可按常规窗口快报，
  // 也不给出一个比常规窗口还长的「宽限」。
  if (ceiling <= base) return { windowMs: base, phase: 'awaiting-first-byte', firstEventSeen, capped: false };
  if (wanted > ceiling) return { windowMs: ceiling, phase: 'awaiting-first-byte', firstEventSeen, capped: true };
  return { windowMs: wanted, phase: 'awaiting-first-byte', firstEventSeen, capped: false };
}
