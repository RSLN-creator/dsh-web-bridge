// agent-preset.js — the webcode-style agent protocol for the web AI brain.
//
// One web conversation per DSH session acts as the model backend:
//   • the FIRST turn carries the agent preset (system + tool list + the
//     mcp_action JSON-fence call protocol, modeled on three-water666/webcode's
//     prompts/prompt_zh.md) plus the first user message;
//   • every later turn sends ONLY the increment — new user text and tool
//     results wrapped as {"mcp_action":"result",...} JSON fences — never the
//     flattened history;
//   • the model's reply is scanned for mcp_action call fences, which the
//     adapter replays as native DSH tool-call chunks so the harness executes
//     them locally and loops results back — exactly like a real API.

import { textOfBlocks } from './flatten.js';

/** Cap one tool output inside a result block (web-side input sanity). */
const MAX_OUTPUT_CHARS = 16_000;
/** Every Nth tool result re-teaches the call format (webcode's train note). */
const TRAIN_EVERY = 5;
const TRAIN_NOTE = '[系统提示] 请保持工具调用格式：以 <tool_call> 开始、</tool_call> 结束，其内为单个 JSON 对象 {"mcp_action":"call","name":"工具名","purpose":"原因","arguments":{…}}。';

/** The agent preset: who the model is, which local tools exist, and the exact
 *  call/result protocol. Mirrors webcode's prompt_zh.md structure. */
export function buildPreset(options = {}) {
  const parts = [];
  const system = typeof options.system === 'string' && options.system.trim() ? options.system.trim() : '';
  if (system) parts.push('[系统指令]\n' + system);
  const tools = Array.isArray(options.tools) ? options.tools : [];
  if (tools.length) {
    const lines = [];
    for (const t of tools) {
      if (!t || typeof t.name !== 'string') continue;
      const desc = typeof t.description === 'string' ? t.description.slice(0, 300) : '';
      let params = '';
      try { params = JSON.stringify(t.parameters ?? {}); } catch { params = '{}'; }
      lines.push(`- ${t.name}: ${desc} | 参数schema: ${params}`);
    }
    parts.push([
      '# 可用本地工具',
      '本次会话已为你接入 DeepSeek Harness (DSH) 本地工具网关。以下工具在你的运行环境之外真实执行：',
      ...lines,
      '',
      '# 工具调用格式',
      '需要调用工具时，任选下面一种格式输出（两种都能被识别，推荐格式 A）：',
      '格式 A（推荐，以标签包裹）：',
      '<tool_call>',
      '{"mcp_action": "call", "name": "工具名", "purpose": "执行此操作的简要原因", "arguments": {"参数名": "值"}}',
      '</tool_call>',
      '格式 B（```json 代码块）：',
      '```json',
      '{"mcp_action": "call", "name": "工具名", "purpose": "执行此操作的简要原因", "arguments": {"参数名": "值"}}',
      '```',
      '一次回复可以包含多个工具调用代码块，会按顺序执行；有依赖的调用请分多轮等待结果。',
      '工具执行结果会作为用户消息自动回填给你，格式：{"mcp_action":"result","name":"…","status":"success","output":"…"}（失败为 "status":"error","error":"…"）。',
      '不需要工具时直接正常文字回复，不要提及本协议。',
    ].join('\n'));
  }
  return parts.join('\n\n');
}

/** First turn text: preset + the conversation's opening user message. */
export function serializeFirstTurn(options = {}) {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const firstUser = messages.find((m) => m?.role === 'user');
  const text = textOfBlocks(firstUser?.content).trim();
  const preset = buildPreset(options);
  return [preset, '[会话开始]', text || '（用户未提供文字）'].filter(Boolean).join('\n\n');
}

function resultBlock({ name, status, output, error }, withTrain) {
  const payload = { mcp_action: 'result', name, status };
  if (status === 'error') payload.error = clip(error ?? 'unknown error');
  else payload.output = clip(output ?? '');
  if (withTrain) payload.system_note = TRAIN_NOTE;
  return '```json\n' + JSON.stringify(payload, null, 2) + '\n```';
}
function clip(s) {
  s = String(s ?? '');
  return s.length > MAX_OUTPUT_CHARS ? s.slice(0, MAX_OUTPUT_CHARS) + `\n…(已截断，原长 ${s.length} 字符)` : s;
}

/**
 * Incremental turn text: everything NEW since `sent` (a count of consumed
 * messages). New user text goes through as-is; tool results become
 * mcp_action result fences; assistant messages the web side already produced
 * are skipped but still counted. Returns { text, consumed } — consumed is
 * always messages.length so the cursor advances on success only (the caller
 * decides when to commit).
 */
export function serializeDelta(messages, sent, toolResultsSent = 0) {
  const msgs = Array.isArray(messages) ? messages : [];
  const segs = [];
  const idToName = new Map();
  for (const m of msgs) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'tool-call' && b.id) idToName.set(b.id, b.name ?? 'unknown');
    }
  }
  let results = toolResultsSent;
  for (const m of msgs.slice(sent)) {
    if (!m) continue;
    if (m.role === 'user') {
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b) continue;
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) segs.push(b.text.trim());
          else if (b.type === 'tool-result') {
            const name = idToName.get(b.toolCallId ?? '') ?? (b.toolName ?? 'unknown');
            let status = 'success';
            let output = textOfBlocks(b.content);
            let error;
            if (b.isError === true || (b.result && b.result.isError)) {
              status = 'error';
              error = output || 'tool execution failed';
            }
            results += 1;
            segs.push(resultBlock({ name, status, output, error }, results % TRAIN_EVERY === 0));
          }
        }
      } else if (typeof m.content === 'string' && m.content.trim()) segs.push(m.content.trim());
    }
    // assistant messages (text / tool-call blocks) are already on the web side
  }
  const text = segs.join('\n\n');
  return { text: text || '[系统] 上一次回复未成功接收，请重新回复。', consumed: msgs.length, toolResultsSent: results };
}

/**
 * Parse the web reply for tool-call fences. Tolerant of prose around the
 * fences — that's the point of a fence protocol — but every fence must be a
 * valid single JSON object naming a tool. Two fence shapes are recognised so
 * the adapter keeps working regardless of which style the web model prefers:
 *   1) ```json … ``` code fences (webcode protocol),
 *   2) <tool_call> … </tool_call> (also <function>/<stories>) tag fences
 *      (opplean / web-agent style — what DeepSeek's web UI tends to emit).
 * Falls back to the strict whole-reply {"tool":...} shape for compat.
 */
export function parseAgentReply(text) {
  if (!text) return { calls: [], text: '' };
  const s = String(text);
  const calls = [];
  const seen = new Set();
  const takeObj = (body) => {
    const t = String(body ?? '').trim();
    if (!t.startsWith('{') || seen.has(t)) return;
    seen.add(t);
    let obj;
    try { obj = JSON.parse(t); } catch { return; }
    const isCall =
      (obj && obj.mcp_action === 'call' && typeof obj.name === 'string' && obj.name.trim()) ||
      (obj && !obj.mcp_action && typeof obj.name === 'string' && obj.name.trim() && obj && typeof obj.arguments === 'object') ||
      (obj && !obj.mcp_action && typeof obj.name === 'string' && obj.name.trim() && obj && typeof obj.input === 'object');
    if (!isCall) return;
    const args = (obj.arguments && typeof obj.arguments === 'object') ? obj.arguments
      : (obj.input && typeof obj.input === 'object') ? obj.input
      : (obj.parameters && typeof obj.parameters === 'object') ? obj.parameters : {};
    calls.push({ name: obj.name.trim(), arguments: args });
  };
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(s)) !== null) takeObj(m[1]);
  const tagRe = /<\s*(?:tool_call|function|stories)\s*>([\s\S]*?)<\s*\/\s*(?:tool_call|function|stories)\s*>/gi;
  while ((m = tagRe.exec(s)) !== null) takeObj(m[1]);
  const bareObjRe = /(\{\s*"mcp_action"\s*:\s*"call"[\s\S]*?\})\s*(?=<|$)/gi;
  while ((m = bareObjRe.exec(s)) !== null) takeObj(m[1]);
  if (calls.length) return { calls, text: s };
  // legacy strict fallback: whole reply is one {"tool":...} object
  const trimmed = s.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.tool === 'string') return { calls: [{ name: obj.tool, arguments: obj.arguments ?? obj.args ?? {} }], text: s };
    } catch { /* fallthrough */ }
  }
  return { calls: [], text: s };
}
