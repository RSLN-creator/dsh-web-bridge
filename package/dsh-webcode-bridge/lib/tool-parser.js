// tool-parser.js — 工具调用解析的**记录态薄壳**（带状态机，2026-09-21）。
//
// ⚠️ **未接线（0.17.3 第三轮自审更正）**：本模块**只被单测引用**，没有任何调用点。
// 它是对 `lib/agent-preset.js` 的 `parseAgentReply` 的**纯委托**：`lib/index.js`
// 已经直接调用那个解析器并自持流式状态机，再接一层只会多一跳、行为逐字不变。
//
// 这里曾写「已在 lib/index.js 正式接线」——那是**假话**（index.js 里那行 import
// 从未被调用过）。本项目对这类「说做了、其实没做」有明确的纪律要求，故改回事实。
// 去留（删或真接）是计划 Task 1.4 的产品决定，不由本次自审单方面处置。
//
// 铁律：deepseek 走 'official'，本模块不持有其协议；任何解析形状改动不许触碰
// agent-preset 的 parseAgentReply 覆盖范围，只许经由此处委托。

import { parseAgentReply } from './agent-preset.js';
import { transportShapeForSite } from './tool-transport.js';

/** 从一段正文里提取工具调用（纯委托，语义与 parseAgentReply 逐字一致）。 */
export function parseToolFence(text, siteId, opts = {}) {
  const shape = typeof siteId === 'string' ? transportShapeForSite(siteId) : (siteId || 'tag');
  const { calls, diagnostics } = parseAgentReply(String(text || ''), opts);
  return { calls, diagnostics, shape };
}

/**
 * 带状态机的增量解析器（记录态）。
 *
 * @param {object} opts
 * @param {string} [opts.shape='tag'] 该站点传输形状：'tag' | 'codeblock' | 'official'。
 *   用于回读态与诊断，不改变 parseAgentReply 的解析（那已覆盖全部形状）。
 * @param {Array}  [opts.tools] 工具定义清单
 * @returns {{ push(text):void, finish():object, reset():void, get state():string }}
 *   - push：逐段吸收文本；
 *   - finish：对累积文本整体求值，返回 `{ calls, diagnostics, shape }`，state 转 'done'；
 *   - reset：清空累积，state 回 'accumulating';
 *   - state：'accumulating' | 'done'（未 finish 前恒为 accumulating）。
 */
export function createToolParser({ shape = 'tag', tools = [] } = {}) {
  let buf = '';
  let state = 'accumulating';
  return {
    push(text) {
      if (state === 'accumulating' && text) buf += String(text);
    },
    finish() {
      if (state === 'done') { const r = parseToolFence(buf, shape, { tools }); r.stale = true; return r; }
      state = 'done';
      const { calls, diagnostics } = parseAgentReply(buf, { tools });
      return { calls, diagnostics, shape };
    },
    reset() { buf = ''; state = 'accumulating'; },
    get state() { return state; },
  };
}
