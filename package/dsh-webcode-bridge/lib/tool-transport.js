// tool-transport.js — 「站点 → 工具调用传输形状」的只读路由立面（2026-09-21）。
//
// ⚠ 本模块当前只被单测引用，**未接线到任何调用点**（2026-09-22 审查核实）。
//   教学与解析的真实入口仍是 lib/agent-preset.js 的 transportNoteFor 与
//   parseAgentReply——index.js 直接调它们。因此不要以为改了本模块就改了行为：
//   它现在是一张「形状速查表」，不是一个生效的中间层。
//   去留由计划 2026-09-21-domestic-sites-protocol.md 的 Task 1.4 决定：要么接线
//   （把 index.js 的教/解析改成经由此处），要么删掉；留着不管才是唯一的错。
//   审查结论见 doc/review-0.17.x.md 第 6、8 节。
//
// ## 为什么它只做路由、不实现协议（plan Task 1.1 的收口结论）
//
// 计划《2026-09-21-domestic-sites-protocol.md》Task 1 本想在新建的
// lib/tool-parser.js / lib/tool-transport.js 里「建立统一工具调用转换层」。
// 但真机勘察（见 doc/research/2026-09-21-login-probe-matrix.md §Task1 结论）确认：
// **该层在 lib/agent-preset.js 里已经存在且成熟**，被 836 项既有测试钉住：
//
//   · 教学文本（首轮 + 增量轮）→ serializeFirstTurn / trainNoteFor / transportNoteFor，
//     已按 siteId 分三支（glm=```json 代码块 / deepseek=官方模板 / 其余=<tool_call>）；
//   · 解析端 → parseAgentReply（吸收 tag fence / code fence / 官方 tool-call /
//     裸 JSON / <invoke> XML 等全部合法调用形状）；
//   · 回注信封 → resultBlock：`{"mcp_action":"result","name","status","output|error"}`。
//
// 因此本模块**不再另写一份协议文本**（两处各写一份必然漂移，agent-preset 头注与
// prompt-variants 头注都明言此纪律）。它只承担一个**唯一事实片**：站点 → 传输
// 形状的映射，作为教学与解析按形状选路时的单一来源，并**委托** agent-preset 拿
// 真正的协议文本与解析结果，保证调用方新增站点时只需在这张表里加一行即可见形状。
//
// 铁律：**deepseek 一律返回 'official' 且不迁移**（DSH 官方模板，见 agent-preset
// OFFICIAL_BAR / normalizeOfficialToolCalls）；任何形状改动不许触碰它。

import { variantIdForSite } from './prompt-variants.js';
import { transportNoteFor } from './agent-preset.js';

/** 识别的传输形状。'official' 仅是标记（deepseek），本模块不持有其协议实现。 */
export const TRANSPORT_SHAPES = Object.freeze({
  codeblock: 'codeblock',   // ```json 代码块（GLM / z.ai）：chatglm.cn 原生工具层会截胡标签
  tag: 'tag',               // <tool_call>{…}</tool_call> 标签（默认站点）
  official: 'official',     // DeepSeek 官方训练模板（agent-preset 独家，本模块只路由不实现）
});

/**
 * 站点 → 传输形状（唯一路由来源）。
 *
 * 与 prompt-variants.variantIdForSite / agent-preset.transportNoteFor 的口径必须
 * 逐字一致：VARIANT_SPECS 的 only=['glm'] 分支就是 codeblock，only=['deepseek']
 * 分支就是 official，其余（default）是 tag。本表以 `variantIdForSite` 为底层，
 * 三层映射同源，不并存第二张表。
 *
 * @param {string} [siteId]
 * @returns {'codeblock'|'tag'|'official'}
 */
export function transportShapeForSite(siteId) {
  const v = variantIdForSite(siteId);
  if (v === 'glm') return TRANSPORT_SHAPES.codeblock;
  if (v === 'official') return TRANSPORT_SHAPES.official;
  return TRANSPORT_SHAPES.tag;
}

/**
 * 形状的「再教学」取数端：委托 agent-preset 拿该站点**传输部分**的协议文本。
 *
 * 为什么不在本模块拼协议：教学文本必须与 serializeFirstTurn / trainNoteFor 发出去
 * 的那一份**逐字同源**，而那一份的唯一真相在 agent-preset（transportNoteFor）。
 * 这里只把「形状名」与「该形状协议文本的唯一入口」对齐——调用方按形状选路时，
 * 只要从这里取文本就不会与 agent-preset 漂移。
 *
 * @param {string} siteId
 * @param {Array}  tools 当前工具清单（glm 分支会追加 present 说明）
 * @returns {string} 该站点的传输协议教学文本
 */
export function teachFor(siteId, tools = []) {
  return transportNoteFor(siteId, tools);
}

/**
 * 解析取数端：委托 agent-preset 的成熟解析器。
 *
 * 同样遵守「不在本模块重写解析」：parseAgentReply 已吸收 tag/code/official/裸 JSON
 * 等全部合法调用形状并满覆盖测试。这里透传以统一「形状 → 解析」的取数入口。
 */
export { parseAgentReply as parseReply } from './agent-preset.js';