// tool-parser.js — 工具调用解析的**记录态薄壳**（带状态机，2026-09-21）。
//
// ⚠ 本模块当前只被单测引用，**未接线到任何调用点**（2026-09-22 审查核实）。
//   真正在用的解析入口是 lib/agent-preset.js 的 parseAgentReply（index.js 直调）。
//   去留由计划 2026-09-21-domestic-sites-protocol.md 的 Task 1.4 决定：
//   要么接线，要么删掉。审查结论见 doc/review-0.17.x.md 第 6、8 节。
//
// ## 与 plan Task 1.2 的收口关系
//
// 计划想在这里「新建独立解析器，吸收 browser-driver 散落的标签/正则」。真机勘察
// 确认：解析逻辑已经在 lib/agent-preset.js 的 parseAgentReply 里集中且成熟（吸收
// tag fence / code fence / 官方 tool-call / 裸 JSON / <invoke> XML，满测试覆盖），
// browser-driver 与 index.js 均在调用它，并非散落。因此本模块**不重写解析**——那只
// 会把唯一真相复制一份然后必然漂移（agent-preset 头注明言此纪律）。
//
// 本模块只提供计划点名的状态机接口形状：`createToolParser({ shape })` 产出
// `{ push, finish, reset }`，内部逐段吸收文本、finish() 时委托 parseAgentReply
// 求值并暴露「规范形状下是否产出调用」。它能让调用方把「流式累积文本」与
// 「按形状选路」做成同一种形体，而不触碰代理预设的解析本身。
//
// 铁律：deepseek 走 'official'，本模块不持有其协议；任何解析形状改动不许触碰
// agent-preset 的 parseAgentReply 覆盖范围，只许经由此处委托。

import { parseAgentReply } from './agent-preset.js';
import { transportShapeForSite } from './tool-transport.js';

/** 从一段正文里提取工具调用（纯委托，语义与 parseAgentReply 逐字一致）。 */
export function parseToolFence(text, siteId) {
  const shape = typeof siteId === 'string' ? transportShapeForSite(siteId) : (siteId || 'tag');
  const { calls } = parseAgentReply(String(text || ''));
  return { calls, shape };
}

/**
 * 带状态机的增量解析器（记录态）。
 *
 * @param {object} opts
 * @param {string} [opts.shape='tag'] 该站点传输形状：'tag' | 'codeblock' | 'official'。
 *   用于回读态与诊断，不改变 parseAgentReply 的解析（那已覆盖全部形状）。
 * @returns {{ push(text):void, finish():object, reset():void, get state():string }}
 *   - push：逐段吸收文本；
 *   - finish：对累积文本整体求值，返回 `{ calls, shape }`，state 转 'done'；
 *   - reset：清空累积，state 回 'accumulating';
 *   - state：'accumulating' | 'done'（未 finish 前恒为 accumulating）。
 */
export function createToolParser({ shape = 'tag' } = {}) {
  let buf = '';
  let state = 'accumulating';
  return {
    push(text) {
      if (state === 'accumulating' && text) buf += String(text);
    },
    finish() {
      if (state === 'done') { const r = parseToolFence(buf, shape); r.stale = true; return r; }
      state = 'done';
      const { calls } = parseAgentReply(buf);
      return { calls, shape };
    },
    reset() { buf = ''; state = 'accumulating'; },
    get state() { return state; },
  };
}