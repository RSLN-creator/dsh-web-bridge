// notices.js — 交回会话的**展示文案**（0.19.3）。
//
// ## 为什么单独一个文件
//
// 这些文案不是日志、不是错误码，而是**作为助手文本块外发给用户看**的内容。
// 它们与 `index.js` 里的 executor 闭包天然耦合（都在续跑出口处），但有三条
// 性质只在「外发」这一层成立，因此值得有独立落点与独立护栏：
//
//   ① **协议安全**：正文会被 `findProtocolStart` / `parseAgentReply` 扫一遍。
//      文案里一旦出现行首裸 `{`、`<tool_call` 或 ``` 围栏，桥会把自己的进度
//      说明当成工具调用去执行——这是「把散文当调用执行」那条红线在展示层的
//      同一形状（见 doc/PROMPT-ENGINEERING.md §二的不对称代价）。
//   ② **不许静默降级**：必须含字面量 `AUTO_CONTINUED`（既有测试靠它判定
//      「如实说明这是自动续跑」），且不得含 `TOOL_CALL_UNPARSED`（0.16.29
//      用户指令「直接隐藏」，提示全文只走补发通道）。
//   ③ **与事实一致**：没补发就不许说「已补发」。
//
// 放在 `index.js` 里做不到独立护栏——`apply()` 是一个巨大的闭包，里面的
// helper 无法被测试单独 import（`export` 在函数作用域内是语法错误）。抽出来
// 之后 `test/auto-continue-notice.test.mjs` 可以零成本地对四个出口逐一断言。

/**
 * 「桥已自动续跑」的展示文案。
 *
 * ## 为什么要有它
 *
 * 0.16.29 之后这条说明是**界面上唯一的归因来源**——再教学提示全文只走补发通道
 * （作为用户消息发给网页模型）、只落 reply-log，正文里一个字都不铺。而它此前
 * 散在**八处**各写一遍，且是裸文本：与模型正文在视觉上无从区分，用户会把桥的
 * 进度说明读成模型的回答。用户原话：「能够给他一行好看的 markdown 格式嘛？
 * 顺便区分和回复正文区别」。
 *
 * ## 形态选择
 *
 * `> **AUTO_CONTINUED** · 桥自动续跑` 引用块：Markdown 渲染成缩进侧条，与正文
 * 段落天然分层；`**` 加粗让它在长回复里一眼可见。这比加分隔线或 HTML 更稳——
 * 引用块是纯 Markdown，任何渲染器都认，且不会与正文的代码围栏互相干扰。
 *
 * @param {{calls?: number, final?: boolean, disabled?: boolean, cumulative?: number, complete?: boolean, after?: number}} [v]
 *   `calls` 续跑轮解析出的可执行调用条数；`final` 无调用且按其回复收场；
 *   `disabled` 补发通道根本不存在（autoContinueRounds=0 或无会话键）——
 *   这一支**不能**说「已自动补发提醒」，那是与事实相反的陈述；
 *   `cumulative` 本会话累计补发次数、`complete` 本轮是否已改用完整提醒、
 *   `after` 升级点 N（累计计数与形态切换的唯一判据在 lib/continue-budget.js）。
 * @returns {string} 作为助手文本块交回会话的 Markdown 引用块
 */
export function autoContinuedNotice({ calls = 0, final = false, disabled = false, cumulative = 0, complete = false, after = 0 } = {}) {
  // 条数收敛到非负整数：负数/NaN/字符串都会渲染成「-1 条调用」这种假读数。
  const n = Math.max(0, Math.round(Number(calls) || 0));
  const head = disabled
    ? '未补发提醒（本会话的自动续跑已关闭，或这一轮没有会话键）。'
    : (n > 0
      ? `已自动补发提醒，网页已重新发起 **${n}** 条调用。`
      : `已自动补发提醒，网页仍未发起可执行调用${final ? '——以下按其回复收场' : ''}。`);
  const lines = ['> **AUTO_CONTINUED** · 桥自动续跑', `> ${head}`];
  // 升级形态必须在界面上说清两件事，且都不许含糊：
  //   ① 这是第几次（用户要的就是「整会话累计」这个读数）；
  //   ② **续跑没有停**——用户明确要求「不能停，我需要真实长上下文」，
  //      界面若只说「已改用完整提醒」会让读者以为桥收手了，那与事实相反。
  // 文案刻意不含行首裸 `{`、`<tool_call`、``` 围栏：本函数的输出会被
  // findProtocolStart 扫一遍，任何协议痕迹都会让桥把自己的说明当调用去执行。
  if (!disabled && complete) {
    const seen = Math.max(0, Math.round(Number(cumulative) || 0));
    const cap = Math.max(0, Math.round(Number(after) || 0));
    lines.push(`> 本会话累计补发 **${seen}** 次${cap > 0 ? `（已超过升级点 ${cap} 次）` : ''}：`
      + '本轮起改用**完整提醒**——重发该站点的完整教学（工具清单、调用格式、使用准则），'
      + '自动续跑照常继续，不停手。');
  }
  return lines.join('\n');
}
