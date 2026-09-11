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
/** 单个工具描述的保留上限。DSH 的工具描述本身就是提示词主体（最长实测约
 *  400 字符，含「路径必须绝对」「不要产出超大输出」这类硬约束），旧实现的
 *  300 字符截断会把这些约束截掉一半。 */
const MAX_TOOL_DESC_CHARS = 1_200;
/** 单个工具参数 schema 的保留上限（防止极端 schema 撑爆网页输入框）。 */
const MAX_TOOL_SCHEMA_CHARS = 4_000;

/** 本机平台一句话。DSH 的 persona 不保证带平台信息（极简模式只有一句
 *  「You are a helpful software engineer assistant.」），而真机轨迹里约
 *  一半的工具错误来自模型用 Unix 习惯命令打 Windows（`ls -la`、`&&` 链）。 */
function platformNote() {
  const os = process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : 'Linux';
  return `运行环境：${os}（Node ${process.version}）。请按该平台的原生命令与路径书写习惯调用工具（如 Windows 用 PowerShell 语法与反斜杠路径），不要照搬其它平台的命令。`;
}

/** The agent preset: who the model is, which local tools exist, and the exact
 *  call/result protocol. Mirrors webcode's prompt_zh.md structure. */
export function buildPreset(options = {}) {
  const parts = [];
  const system = typeof options.system === 'string' && options.system.trim() ? options.system.trim() : '';
  if (system) parts.push('[系统指令]\n' + system);
  const extraPrompt = typeof options.extraPrompt === 'string' && options.extraPrompt.trim() ? options.extraPrompt.trim() : '';
  if (extraPrompt) parts.push('[全局指令]\n' + extraPrompt);
  const tools = Array.isArray(options.tools) ? options.tools : [];
  if (tools.length) {
    const lines = [];
    for (const t of tools) {
      if (!t || typeof t.name !== 'string') continue;
      const desc = typeof t.description === 'string' ? t.description.slice(0, MAX_TOOL_DESC_CHARS) : '';
      let params = '';
      try { params = JSON.stringify(t.parameters ?? {}); } catch { params = '{}'; }
      if (params.length > MAX_TOOL_SCHEMA_CHARS) params = params.slice(0, MAX_TOOL_SCHEMA_CHARS) + '…(schema 已截断)';
      lines.push(`- ${t.name}: ${desc}\n  参数 schema: ${params}`);
    }
    parts.push([
      '# 可用本地工具',
      '本次会话已为你接入 DeepSeek Harness (DSH) 本地工具网关。以下工具在你的运行环境之外真实执行：',
      platformNote(),
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
      '重要：如果上一次工具调用因参数无效而失败，收到了 status:"error" 的结果，请在下一轮把参数修正后重新调用，不要因为失败而放弃工具改用猜测。',
      '回填结果中的每一轮调用（含失败）都会编号出现；继续任务时请基于真实结果，不要虚构文件内容。',
      '# 使用准则',
      '本会话的最终目标由用户的最新消息决定。除非用户只是闲聊/要观点，否则默认应优先通过真实工具获取数据，而不是凭记忆或设想作答。',
      '判断是否需要调用工具，应看"这个回答是否依赖本机真实文件、目录或命令执行结果"——依赖就用，不依赖就不用；能用一次调用覆盖就不用多次。',
      '没有真实依据时不要编造文件内容、命令输出或执行结果；卡住就明确说明缺什么信息。',
      '不要为了显得勤快而堆砌无用调用，也不要为了省事而把本可使用真实工具解决的事强行用文字搪塞。',
    ].join('\n'));
  }
  return parts.join('\n\n');
}

/** First turn text: preset + the conversation's opening user message. */
export function serializeFirstTurn(options = {}) {
  const messages = Array.isArray(options.messages) ? options.messages : [];
  const names = toolNames(messages);
  const text = messages.filter(Boolean).map(m => {
    if (m.role === 'assistant') return '[assistant] ' + textOfBlocks(m.content) + '\n' + (Array.isArray(m.content) ? m.content.filter(b => b.type === 'tool-call').map(b => JSON.stringify(b)).join('\n') : '');
    if (m.role === 'system') return '[system] ' + textOfBlocks(m.content);
    return serializeDelta([m], 0, 0, names).text;
  }).join('\n\n');
  const preset = buildPreset(options);
  const transport = options.tools?.length ? '\n[本地工具传输协议]\n必须使用 <tool_call>{"mcp_action":"call","name":"实际工具名","arguments":{}}</tool_call> 发起工具调用。工具名和参数必须严格匹配上面的 schema。Calling:、伪代码、描述将要读取，都不会执行工具。一旦判定需要真实数据，就立即发起调用，输出调用后立即停止，等待真实工具结果，不得虚构文件内容；拿到全部所需结果后，直接给出简洁的最终答复收束本回合，不要继续无谓思考或重复推测。' : '';
  return [preset, '[会话开始]', text || '（用户未提供文字）', transport].filter(Boolean).join('\n\n');
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
function toolNames(msgs) {
  const idToName = new Map();
  for (const m of msgs) {
    if (!m || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b && b.type === 'tool-call' && b.id) idToName.set(b.id, b.name ?? 'unknown');
    }
  }
  return idToName;
}

export function serializeDelta(messages, sent, toolResultsSent = 0, knownNames) {
  const msgs = Array.isArray(messages) ? messages : [];
  const segs = [];
  const idToName = knownNames || toolNames(msgs);
  let results = toolResultsSent;
  for (const m of msgs.slice(sent)) {
    if (!m) continue;
    if (m.role === 'tool') {
      results += 1;
      segs.push(resultBlock({ name: m.name || idToName.get(m.tool_call_id) || 'unknown', status: m.isError ? 'error' : 'success', output: textOfBlocks(m.content), error: textOfBlocks(m.content) }, results % TRAIN_EVERY === 0));
      continue;
    }
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

/** 从 text[start]（应为 '{'）做花括号配对（跳过字符串内的括号），配平即试解析。 */
function jsonObjectAt(text, start) {
  const src = String(text ?? '');
  if (src[start] !== '{') return null;
  let depth = 0; let inStr = false; let esc = false;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(src.slice(start, i + 1));
          return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
        } catch { return null; }
      }
    }
  }
  return null;
}

/** 从一段可能夹带标签/散文的文本里取第一个完整 JSON 对象（首个 { 到末个 }）。
 *  混合形状的 <invoke> 体里既有裸 JSON 又有游离 </parameter>，直接切首尾即可。 */
function jsonObjectIn(text) {
  const body = String(text ?? '');
  const a = body.indexOf('{');
  const b = body.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const parsed = JSON.parse(body.slice(a, b + 1));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch { return null; }
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
/**
 * DeepSeek 网页版的 DSML 变形归一：竖线全角化成对出现（<tool_calls>，
 * U+FF5C）、或丢开头 <。reference/deepseek-free-api 的 strip_dsml_markup 用
 * chr(0xff5c) 处理同一问题。把 DSML 前缀整体剥掉还原成裸 XML 标签。
 *
 * ⚠ 必须与 parseAgentReply 内联的那段替换保持一致——两处都认同一批形态，
 *   一旦漂移就会出现「解析认得出、边界探测认不出」的泄漏（0.9.4 修的正是
 *   这个：全角 DSML 被 parseAgentReply 收下，却被流式探测放过，协议原文
 *   已作为 text-delta 发给显示层）。test/protocol-leak.test.mjs 用真机夹具
 *   锁住两者的一致性。
 */
export function normalizeDsml(text) {
  return String(text ?? '')
    .replace(/<[\uFF5C|]+\s*DSML\s*[\uFF5C|]+/gi, '<')
    .replace(/<\/[\uFF5C|]+\s*DSML\s*[\uFF5C|]+/gi, '</')
    // 丢开头 < 的裸标记（<invoke …）：只在后跟已知标记名时补 <，避免误伤正文
    .replace(/(^|[^\w<])[\uFF5C|]+\s*DSML\s*[\uFF5C|]+(?=(?:tool_calls|calls|invoke|parameter)\b)/gi, '$1<');
}

/** 协议文本起点的锚点。命中最早的一个即为边界。 */
const PROTOCOL_ANCHORS = [
  /<\s*\/?\s*(?:tool_call|tool_calls|calls|function|stories|invoke)\b/i, // 半角标签
  /<[\uFF5C|]*\s*DSML\s*[\uFF5C|]*/i,                              // <（真机主形态）
  /[\uFF5C|]+\s*DSML\s*[\uFF5C|]+/i,                               // 丢开头 < 的 ｜DSML｜
  /```/,                                                           // ```json 围栏
  /\*\*Calling:/i,                                                 // 网页 Calling 渲染
  /(?:^|\n)[ \t]*\{/,                                              // 裸 JSON 对象行
];

/**
 * 流式协议边界探测：协议文本从哪个下标开始，以及能认出的工具名。
 *
 * 与 parseAgentReply 共用同一套形态知识，但只做定位、不做完整解析——它要在
 * 流式途中被每个 delta 反复调用，必须廉价且无副作用。调用方拿到 index 后应
 * 立即停止把该下标之后的文本当作正文外发；name 只在确实是真工具时才有意义
 * （由调用方对工具表校验）。
 *
 * @param {string} text 累积的网页回复文本
 * @returns {{index: number, name: string, transport: boolean}}
 *          index=-1 表示尚未出现协议边界。
 */
export function findProtocolStart(text) {
  const raw = String(text ?? '');
  let index = -1;
  for (const re of PROTOCOL_ANCHORS) {
    const m = re.exec(raw);
    if (m && (index < 0 || m.index < index)) index = m.index;
  }
  if (index < 0) return { index: -1, name: '', transport: false };

  // 名字与传输形态都在归一化后的文本上判定，才能同时覆盖全角 DSML 与半角标签。
  const suffix = normalizeDsml(raw.slice(index));
  const name = suffix.match(/\*\*Calling:\*\*\s*`([\w.-]+)`/)?.[1]
    || suffix.match(/<\s*(?:tool_call|tool_calls|calls|function|stories|invoke)\b[^>]*?\bname\s*=\s*"([\w.-]+)"/i)?.[1]
    || suffix.match(/"name"\s*:\s*"([\w.-]+)"/)?.[1]
    || '';
  const transport = /^<\s*(?:tool_call|tool_calls|calls|function|stories|invoke)\b|^\*\*Calling:|\*\*Calling:|"mcp_action"\s*:\s*"call"|^\s*\{\s*"tool"/i.test(suffix);
  return { index, name, transport };
}

/**
 * 切掉一段文本里的协议部分，只留散文。
 *
 * 只用于「本轮已确认存在工具调用」时的兜底：正常路径下流式边界探测已经把
 * 协议文本挡在 text-delta 之外，这里是探测漏掉未知形态时的第二道防线，
 * 保证 DSH 会话里存下来的助手文本是干净的散文。
 */
export function stripProtocolText(text) {
  const raw = String(text ?? '');
  const { index } = findProtocolStart(raw);
  return index < 0 ? raw : raw.slice(0, index).trimEnd();
}

export function parseAgentReply(text) {
  if (!text) return { calls: [], text: '' };
  let s = String(text);
  // 网页端流式噪声：DeepSeek 网页版偶发把协议标记输出成 <…> 的变形——
  // 竖线全角化成对出现（<tool_calls>，U+FF5C）、丢开头 <。归一化与流式
  // 边界探测（findProtocolStart）共用 normalizeDsml，两处不再各写一份正则。
  s = normalizeDsml(s);
  const calls = [];
  const seen = new Set();
  // 同一个调用可能被多条规则各匹配一次（fence / 标签 / 裸对象 / invoke 兜底）。
  // 原文去重（seen）挡不住「同一对象、不同书写」的重复，故再按内容签名去重。
  const seenSig = new Set();
  // DeepSeek 网页版与 OpenAI 一样，常把 arguments 设置为"转义 JSON 字符串"
  // （"{\"command\":\"...\"}"）而非对象。这里统一做一次"字符串→对象"归一化，
  // 否则这些参数会被当成空对象丢弃，工具拿到空参数执行失败。任何解析失败的
  // 字符串都安全回落为 {}（宁可空参数，也不轻率执行）。
  const normArgs = (value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const first = value.trim()[0];
      if (first === '{' || first === '[') {
        try {
          const parsed = JSON.parse(value);
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
        } catch { /* keep fallback */ }
      }
    }
    return {};
  };
  const takeObj = (body, tagged = false) => {
    const t = String(body ?? '').trim();
    if (!t.startsWith('{') || seen.has(t)) return;
    seen.add(t);
    let obj;
    try { obj = JSON.parse(t); } catch { return; }
    // 三种合法调用形状（tag fence 历来全收；code fence 优先 mcp_action 协议，
    // 但纯 {"name","arguments"} 形状在真实第二轮里高频出现——2026-09-08 会话
    // f3fa97fd 复盘：模型把错误结果回读后省略 mcp_action 字段直接输出该形状，
    // 导致调用被静默丢弃、任务在第二轮裸奔。宁可多认，由下方 isCall 严格把关）。
    const fenceCall = tagged || obj.mcp_action === 'call';
    if (!fenceCall && !(!obj.mcp_action && typeof obj.name === 'string' && obj.name.trim())) return;
    const args = normArgs(obj.arguments ?? obj.input ?? obj.parameters);
    const isCall =
      fenceCall
        ? (typeof obj.name === 'string' && obj.name.trim())
        : (typeof obj.arguments === 'object' || typeof obj.input === 'object' || (typeof obj.arguments === 'string' && obj.arguments.trim().startsWith('{')));
    if (!isCall) return;
    if (Array.isArray(args)) return;
    const sig = obj.name.trim() + '\u0000' + JSON.stringify(args);
    if (seenSig.has(sig)) return;
    seenSig.add(sig);
    calls.push({ name: obj.name.trim(), arguments: args });
  };
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(s)) !== null) takeObj(m[1]);
  const tagRe = /<\s*(?:tool_call|function|stories)\s*>([\s\S]*?)<\s*\/\s*(?:tool_call|function|stories)\s*>/gi;
  while ((m = tagRe.exec(s)) !== null) takeObj(m[1], true);
  // 裸 <invoke> XML 形状（probe-17 首跑 2026-09-09 发现：无 fence、无 mcp_action，
  // 模型把 DSH 原生 XML 调用语法直接搬进网页回复）。<parameter name="k">v</parameter>
  // 逐个收集为 arguments；至少一个 parameter 才算调用，散文举例不触发。
  // probe-17 终跑（2026-09-10）再发现的混合形状：外壳是 DSH 原生 <invoke>，
  // 参数却是本协议的裸 JSON 对象，还带一串游离的 </parameter>：
  //   <invoke name="read" purpose="…">{"path":"…"}</parameter></invoke>
  // 只在没有 <parameter> 元素时才按裸 JSON 兜底（有 parameter 的老形状不变）。
  const invokeRe = /<\s*invoke\s+name\s*=\s*"([^"]+)"\s*[^>]*>([\s\S]*?)<\s*\/\s*invoke\s*>/gi;
  while ((m = invokeRe.exec(s)) !== null) {
    const args = {};
    let n = 0;
    // 新版 UI（2026-09-10）的 DSML 序列化会给参数带类型属性：
    //   <parameter name="command" string="true">…</parameter>
    // 旧的「name 之后必须直接是 >」写法会整段漏掉这类调用，故允许任意其它属性。
    const paramRe = /<\s*parameter\s+name\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\s*\/\s*parameter\s*>/gi;
    let pm;
    while ((pm = paramRe.exec(m[2])) !== null) { args[pm[1]] = pm[2].trim(); n++; }
    if (n === 0) {
      const raw = jsonObjectIn(m[2]);
      // 壳里装的是「完整调用对象」时（真机 2026-09-10 第 3 跑：<invoke name="tool_call">
      // 里塞了整段 {"mcp_action":"call","name":"read",…}），外壳名是噪声——
      // 按内层对象本身入账，别把 read/grep 变成名为 tool_call 的工具的参数。
      if (raw && (raw.mcp_action === 'call' || (typeof raw.name === 'string' && raw.name.trim() && ('arguments' in raw || 'input' in raw)))) {
        takeObj(JSON.stringify(raw));
        continue;
      }
      if (raw) { for (const [k, v] of Object.entries(raw)) { args[k] = v; n++; } }
    }
    // 参数形态的包装壳（真机 2026-09-10 第 3 跑）：
    //   <invoke name="tool_call"><parameter name="name">shell</parameter>
    //   <parameter name="arguments" string="false">{"command":"…"}</parameter></invoke>
    // 外壳名不是工具名——按内层 name/arguments 还原成真调用。
    // mcp_action 也在此列：畸形属性形态会把 "mcp_action":"call" 截成外壳名。
    const wrapperName = /^(?:tool_calls?|function|invoke|mcp_action)$/i.test(String(m[1]).trim());
    if (wrapperName && typeof args.name === 'string' && args.name.trim() && (args.arguments !== undefined || args.input !== undefined || args.parameters !== undefined)) {
      takeObj(JSON.stringify({ mcp_action: 'call', name: args.name.trim(), arguments: normArgs(args.arguments ?? args.input ?? args.parameters) }));
      continue;
    }
    // 抢救形状（真机 2026-09-10 第 5 跑）：模型把调用对象直接拼进了标签名里——
    //   <parameter name="name": "read", "arguments": {"path": "README.md"}}
    // 标签已经畸形，但「\"name\": \"x\", \"arguments\": {…}」片段还在，逐个配对还原。
    // 扫整个 invoke 匹配（含属性区）：真机还有把调用 JSON 直接塞进 name 属性的形态——
    //   <invoke name="mcp_action":"call","name":"read","arguments":{"path":"…"}}
    // 这种畸形下 JSON 片段落在属性区，只扫 m[2] 会漏。
    const salvageRe = /(?:"name"\s*:\s*|name\s*=\s*)"([^"]+)"\s*,\s*"arguments"\s*:\s*/g;
    let sm;
    let salvaged = 0;
    while ((sm = salvageRe.exec(m[0])) !== null) {
      const obj = jsonObjectAt(m[0], salvageRe.lastIndex);
      if (obj) { salvaged++; takeObj(JSON.stringify({ mcp_action: 'call', name: sm[1], arguments: obj })); }
    }
    // 已抢救出真调用、外壳名只是 tool_call/function 包装名时，别再挂一个假调用。
    if (n > 0 && !(salvaged > 0 && wrapperName)) takeObj(JSON.stringify({ mcp_action: 'call', name: m[1], arguments: args }));
  }
  const bareObjRe = /(\{\s*"mcp_action"\s*:\s*"call"[\s\S]*?\})\s*(?=<|$)/gi;
  while ((m = bareObjRe.exec(s)) !== null) takeObj(m[1]);
  // DeepSeek web also renders a native-looking call as bold Calling + a
  // backticked tool name. Require the complete argument region to be JSON.
  const rendered = [...s.matchAll(/^\*\*Calling:\*\*\s*`([\w.-]+)`\s*/gm)];
  for (let i = 0; i < rendered.length; i++) {
    const start = rendered[i].index + rendered[i][0].length;
    let body = s.slice(start, rendered[i + 1]?.index ?? s.length).trim();
    if (/^```(?:json)?\s/.test(body) && body.endsWith('```')) body = body.replace(/^```(?:json)?\s*/, '').slice(0, -3).trim();
    try {
      const parsed = JSON.parse(body);
      // arguments 可能是对象，也可能是一次转义后的 JSON 字符串
      const arguments_ = normArgs(typeof parsed === 'object' && parsed && 'arguments' in parsed ? parsed.arguments : parsed);
      takeObj(JSON.stringify({ mcp_action: 'call', name: rendered[i][1], arguments: arguments_ }));
    } catch { /* Explanations and incomplete JSON are not executable. */ }
  }
  if (calls.length) return { calls, text: s };
  // legacy strict fallback: whole reply is one {"tool":...} object
  const trimmed = s.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.tool === 'string') return { calls: [{ name: obj.tool, arguments: normArgs(obj.arguments ?? obj.args ?? {}) }], text: s };
    } catch { /* fallthrough */ }
  }
  return { calls: [], text: s };
}
