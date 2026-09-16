// zero-progress.js — 「本轮零进展」的收尾判定（0.15.5）。
//
// ## 为什么这个纯函数必须独立成模块
//
// 真机缺陷（子代理会话 `ecad7b6a` step2）：
//
//   step1  usage = { inputTokens: 26263, outputTokens: 197 }   ← 正常，调了一次 pwsh
//   step2  usage = { inputTokens: 28555, outputTokens: 0 }     ← 零输出
//          blocks = ["reasoning(201)"]                          ← 只有思考，正文一个字符都没来
//   turn/end reason = completed                                 ← agent loop 认为本轮「无事完成」
//
// 后果：子代理零产出（两篇笔记 MISSING、`reference/` 无任何新克隆），
// 而 captain 侧只看到成员「idle/unspawned」，完全不知道它其实跑过一轮。
//
// 根因**不是某条判据写错，而是两条判据的先后顺序**：
//
//   旧实现（顺序错）：
//     if (正文空 && withheld > 0) → 静默 finishChunks(turn,'','stop')   ← 先命中，吞掉
//     if (正文空 && 思考非空)     → 发 THINKING_ONLY_NO_ANSWER 提示
//
//   网页把全部内容都从思考通道送来时，`finalText` 里是被边界探测认出的协议文本
//   （`withheld > 0`），于是这一类轮次**全落进前一条分支被静默吞掉**。
//
// 顺序错了在行为上只是一个 if 的位置——任何文本断言都看不见它，源码里也看不出
// 「错」。所以把它抽成一个可 `import` 的纯函数，让「thinking-only 必须先于
// protocol-withheld」变成可执行、可反向验证的契约。
//
// 这与本项目的既有分层一致：`metrics.js`、`accounts.js`、`wait-stats.js`、`bench.js`
// 都是「判据抽成纯函数 + 独立护栏文件」的写法。

/**
 * 本轮收尾分支判定。
 *
 * 返回三种结果，互斥且穷尽：
 *   • `'thinking-only'`     —— 正文空、思考非空 ⇒ 必须给出归因提示让任务继续；
 *   • `'protocol-withheld'` —— 正文空、思考也空、但有被扣留的协议文本 ⇒ 断流轮，
 *                              本轮确实没有可交付正文，静默收束；
 *   • `'has-content'`       —— 有正文（或图片）⇒ 走正常外发路径。
 *
 * **顺序即契约**：`thinking-only` 判定必须先于 `protocol-withheld`。
 * 反过来的话，「网页把全部内容从思考通道送来」这一类轮次会被静默吞掉，
 * agent loop 判定本轮无事完成，任务零产出（真机实证，见本文件头部）。
 *
 * `imageCount` 不可省：只出图不出字是**合法**回复（识图轮的常见形态），
 * 按零进展处理会把正常的识图轮判死。
 *
 * 全空（正文/思考/图片/扣留都没有）刻意返回 `'has-content'`，让调用方继续走
 * `assertNonEmpty` 抛 `empty response`——本函数不负责吞掉「真的什么都没有」，
 * 那是一个应当可见的错误，不该被静默收束掩盖。
 *
 * @param {{out?: string, thinkAcc?: string, withheld?: number, imageCount?: number}} v 本轮现场
 * @returns {'thinking-only'|'protocol-withheld'|'has-content'} 收尾分支
 */
export function zeroProgressDecision(v) {
  const out = String(v?.out ?? '');
  const think = String(v?.thinkAcc ?? '');
  const withheld = Number(v?.withheld ?? 0);
  const images = Number(v?.imageCount ?? 0);
  if (out.trim() || images > 0) return 'has-content';
  // 顺序即契约：有思考可归因时必须先走 thinking-only，不能被 withheld 抢先静默掉。
  if (think.trim()) return 'thinking-only';
  if (withheld > 0) return 'protocol-withheld';
  return 'has-content';   // 全空 ⇒ 交给 assertNonEmpty 抛「空回复」，不在这里吞掉
}
