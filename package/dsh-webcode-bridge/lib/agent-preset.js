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
/** glm 站点的再教学提示：该网页对正文里的调用标签有原生执行器（只认
 *  search/open/click/find），标签形状会被它抢走执行并回灌 unknown tool call，
 *  只有 ```json 代码块能活到桥。与 buildPreset/serializeFirstTurn 的 glm 分支
 *  同一立场（2026-09-13 两份真机会话 cacaba8c/ab4c6dc8 实锤）。 */
const TRAIN_NOTE_GLM = '[系统提示] 请保持工具调用格式：先写一行 ```json，其内为单个 JSON 对象 {"mcp_action":"call","name":"工具名","purpose":"原因","arguments":{…}}，再以一行 ``` 结束；不要用 <tool_call> 等标签包裹（会被本网页拦截丢失）。';
/** 按站点取再教学提示——增量轮的 resultBlock 与首轮教学必须同一立场，否则
 *  模型刚被纠回代码块形状，第 5 个工具结果又把它教回标签形状。 */
export function trainNoteFor(siteId) {
  return siteId === 'glm' ? TRAIN_NOTE_GLM : TRAIN_NOTE;
}
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

/** 传输协议末尾的 present 提醒（只在本会话注册了 present 时追加）。
 *
 *  为什么要在**协议**里再说一遍：preset 的「# 交付物呈现」是解释性的，而这里
 *  紧挨着「调用后立即停止等待结果」那条行为约束——模型在收尾那一刻最容易忘掉
 *  最后一步是 present。2026-09-13 真机症状：一轮里写了 8 个文件、正文把路径
 *  列成一串，却一次 present 都没调，用户界面上全是点不动的纯文本。 */
function presentTransportNote(tools) {
  if (!Array.isArray(tools) || !tools.some((t) => t && t.name === 'present')) return '';
  return '本会话可调 present：写/改完用户要拿到手的文件后，在给出最终答复之前必须调它声明这些文件'
    + '（present 让文件以可点开的面板出现在界面上，只在正文写路径则是点不动的纯文本）。';
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
  // present 是「交付物」的唯一声明入口：只有本会话真的注册了它，才值得教模型去调
  // ——不能让模型去调用一个不存在的工具（那会白费一轮并撞 TOOL_UNKNOWN）。
  const hasPresent = tools.some((t) => t && t.name === 'present');
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
      // glm 站点只教代码块形状：该网页对正文调用标签有原生执行器（只认
      // search/open/click/find），标签形状会被抢走执行并回灌 unknown tool call
      // （2026-09-13 真机会话 cacaba8c/ab4c6dc8：模型反复重试标签形状全部阵亡，
      // 唯一存活的调用是代码块裸 JSON）。其它站点维持既有双形状不动。
      ...(options.siteId === 'glm' ? [
        '需要调用工具时，只用下面这一种格式输出：',
        '格式（```json 代码块，唯一可用）：',
        '```json',
        '{"mcp_action": "call", "name": "工具名", "purpose": "执行此操作的简要原因", "arguments": {"参数名": "值"}}',
        '```',
        '警告：不要使用 <tool_call>…</tool_call> 或任何 XML/标签包裹调用——本网页会把这类标签当成它自己的内置工具抢走执行并报 unknown tool call，调用会静默丢失；只有 ```json 代码块能到达本地工具网关。',
      ] : [
        '需要调用工具时，任选下面一种格式输出（两种都能被识别，推荐格式 A）：',
        '格式 A（推荐，以标签包裹）：',
        '<tool_call>',
        '{"mcp_action": "call", "name": "工具名", "purpose": "执行此操作的简要原因", "arguments": {"参数名": "值"}}',
        '</tool_call>',
        '格式 B（```json 代码块）：',
        '```json',
        '{"mcp_action": "call", "name": "工具名", "purpose": "执行此操作的简要原因", "arguments": {"参数名": "值"}}',
        '```',
      ]),
      // 真机 2026-09-13（cacaba8c turn3）：模型把原因写进 purpose、arguments 里
      // 却不带 pwsh 必填的 description → DSH 拒绝 missing required property
      // "description"。schema 全文有教（required 在列）但模型没守，这里点名说破。
      'arguments 必须包含对应工具 schema 里 required 列出的每一个字段（例如 pwsh 必须同时给 command 和 description——description 是 5-10 词英文主动语态的命令概述）；purpose 只是执行原因备注，不能替代任何必填参数。',
      '一次回复可以包含多个工具调用代码块，会按顺序执行；有依赖的调用请分多轮等待结果。',
      '工具执行结果会作为用户消息自动回填给你，格式：{"mcp_action":"result","name":"…","status":"success","output":"…"}（失败为 "status":"error","error":"…"）。',
      '重要：如果上一次工具调用因参数无效而失败，收到了 status:"error" 的结果，请在下一轮把参数修正后重新调用，不要因为失败而放弃工具改用猜测。',
      '回填结果中的每一轮调用（含失败）都会编号出现；继续任务时请基于真实结果，不要虚构文件内容。',
      ...(hasPresent ? [
        '',
        '# 交付物呈现（present）',
        '你写文件、改文件之后，若该文件是用户要拿到手的结果，**必须**调用 present 声明它，' +
          '并且要在最终答复之前调用完——只在回复正文里写出文件路径**不算**交付：',
        '· present 让文件以**可点开的面板/窗口**形式出现在用户界面上；只在正文里写路径，用户看到的只是纯文本，点不动。',
        '· 典型该声明的：新建或修改的源码、脚本、配置、文档、报告，以及用 Bash/代码生成出来的产物。',
        '· 不需要声明的：只是读来当参考的文件、临时中间文件、用户没要的输出。',
        '· 路径要写真实存在的文件（相对工作目录或绝对路径都可以）；文件不存在就不要声明。',
        '· 总结类答复里提到"主要产物"时，只有 present 声明过的才会变成可点开的窗口——' +
          '若你已在正文列了一串路径却没调 present，那串路径对用户而言就是死文字，请补调 present。',
      ] : []),
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
    if (m.role === 'user') {
      const raw = textOfBlocks(m.content);
      const directive = normalizeHarnessDirective(raw);
      return directive || serializeDelta([m], 0, 0, names, trainNoteFor(options.siteId)).text;
    }
    return serializeDelta([m], 0, 0, names, trainNoteFor(options.siteId)).text;
  }).join('\n\n');
  const preset = buildPreset(options);
  // 传输协议按站点分立场：glm 网页会拦截正文里的调用标签（原生执行器只认
  // search/open/click/find），必须只教代码块形状并明说标签会被吃；其它站点
  // 维持既有文字逐字不动。
  const transport = !options.tools?.length ? '' : options.siteId === 'glm'
    ? '\n[本地工具传输协议]\n必须使用 ```json 代码块发起工具调用：先写一行 ```json，下一行是单个 JSON 对象 {"mcp_action":"call","name":"实际工具名","purpose":"原因","arguments":{…}}，再以一行 ``` 结束。不要使用 <tool_call> 等标签包裹——本网页会把这些标签当成它自己的内置工具抢走执行并报 unknown tool call，调用会静默丢失。工具名和参数必须严格匹配上面的 schema（arguments 必须包含 required 里的每个字段，如 pwsh 的 description）。Calling:、伪代码、描述将要读取，都不会执行工具。一旦判定需要真实数据，就立即发起调用，输出调用后立即停止，等待真实工具结果，不得虚构文件内容；拿到全部所需结果后，直接给出简洁的最终答复收束本回合，不要继续无谓思考或重复推测。' + presentTransportNote(options.tools)
    : '\n[本地工具传输协议]\n必须使用 <tool_call>{"mcp_action":"call","name":"实际工具名","arguments":{}}</tool_call> 发起工具调用。工具名和参数必须严格匹配上面的 schema。Calling:、伪代码、描述将要读取，都不会执行工具。一旦判定需要真实数据，就立即发起调用，输出调用后立即停止，等待真实工具结果，不得虚构文件内容；拿到全部所需结果后，直接给出简洁的最终答复收束本回合，不要继续无谓思考或重复推测。' + presentTransportNote(options.tools);
  return [preset, '[会话开始]', text || '（用户未提供文字）', transport].filter(Boolean).join('\n\n');
}

/** Preserve DSH slash-command intent across the web model boundary. */
export function normalizeHarnessDirective(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return '';
  const goal = raw.match(/^\/goal\s*(.*)$/is);
  if (goal) return '[DSH 目标命令] ' + (goal[1].trim() || '请完成当前目标')
    + '\n请把它当作需要完成的工程目标：先使用可用本地工具获取真实依据，再持续执行直到得到可验证结果；不要只解释如何做。';
  const compact = raw.match(/^\/compact\s*(.*)$/is);
  if (compact) return '[DSH 压缩命令] ' + (compact[1].trim() || '压缩当前上下文')
    + '\n请保留当前目标、关键决定、已完成工作、待办事项和必要文件路径，删除重复过程，并以简洁状态继续工作。';
  return '';
}

function resultBlock({ name, status, output, error }, withTrain, note = TRAIN_NOTE) {
  const payload = { mcp_action: 'result', name, status };
  if (status === 'error') payload.error = clip(error ?? 'unknown error');
  else payload.output = clip(output ?? '');
  if (withTrain) payload.system_note = note;
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

export function serializeDelta(messages, sent, toolResultsSent = 0, knownNames, note) {
  const msgs = Array.isArray(messages) ? messages : [];
  const segs = [];
  const idToName = knownNames || toolNames(msgs);
  let results = toolResultsSent;
  for (const m of msgs.slice(sent)) {
    if (!m) continue;
    if (m.role === 'tool') {
      results += 1;
      segs.push(resultBlock({ name: m.name || idToName.get(m.tool_call_id) || 'unknown', status: m.isError ? 'error' : 'success', output: textOfBlocks(m.content), error: textOfBlocks(m.content) }, results % TRAIN_EVERY === 0, note));
      continue;
    }
    if (m.role === 'user') {
      if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (!b) continue;
          if (b.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
            const directive = normalizeHarnessDirective(b.text);
            segs.push(directive || b.text.trim());
          }
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
            segs.push(resultBlock({ name, status, output, error }, results % TRAIN_EVERY === 0, note));
          }
        }
      } else if (typeof m.content === 'string' && m.content.trim()) {
        const directive = normalizeHarnessDirective(m.content);
        segs.push(directive || m.content.trim());
      }
    }
    // assistant messages (text / tool-call blocks) are already on the web side
  }
  const text = segs.join('\n\n');
  return { text: text || '[系统] 上一次回复未成功接收，请重新回复。', consumed: msgs.length, toolResultsSent: results };
}

/**
 * 参数形状纠偏：把网页模型「明显打错类型」的参数按 schema 修回来。
 *
 * 真机证据（13 份会话转录，64 次工具报错**全部**是这一类）：
 *   - `invalid arguments: "offset" must be a number; "limit" must be a number`（24 次）
 *     → 网页把数字写成字符串 `"10"`
 *   - `invalid arguments: "questions" must be an array`（6 次）
 *     → 数组被写成单个对象
 *   - `"run_in_background" must be a boolean`、`"timeoutMs" must be a number`
 *
 * 模型看不到 schema 里 `{"type":"number"}` 这种约束有多硬，而 DSH 会严格拒绝。
 * 这些形状的**正确值没有歧义**（`"10"` 就是 10，`true`/`"true"` 就是布尔真），
 * 所以按 schema 声明做定向纠偏是安全的；不做任何猜测：
 *   · 只在 schema **显式声明了该参数的类型**、且当前值类型不符时才动；
 *   · 只做无歧义的方向（字符串→数字/布尔/数组、字符串→对象、标量→数组）；
 *   · 数字/布尔解析失败就原样保留，交给 DSH 报它自己的错，桥不吞不猜。
 *
 * @param {object} args 网页解析出的参数
 * @param {object} schema 该工具的 parameters（JSON Schema）
 * @returns {{args: object, coerced: string[]}} coerced 是被改动过的参数名
 */
export function coerceArguments(args, schema) {
  const out = (args && typeof args === 'object' && !Array.isArray(args)) ? { ...args } : {};
  const coerced = [];
  const props = schema && typeof schema === 'object' && schema.properties && typeof schema.properties === 'object'
    ? schema.properties : null;
  if (!props) return { args: out, coerced };
  for (const [key, spec] of Object.entries(props)) {
    if (!(key in out)) continue;
    const want = spec && typeof spec === 'object' ? spec.type : null;
    const value = out[key];
    if (value === null || value === undefined) continue;
    const typeOf = Array.isArray(value) ? 'array' : typeof value;
    if (want === typeOf) continue;
    switch (want) {
      case 'number': case 'integer': {
        if (typeof value !== 'string') break;
        const n = Number(value.trim());
        if (Number.isFinite(n)) { out[key] = want === 'integer' ? Math.trunc(n) : n; coerced.push(key); }
        break;
      }
      case 'boolean': {
        if (typeof value === 'string') {
          const s = value.trim().toLowerCase();
          if (s === 'true' || s === 'false') { out[key] = s === 'true'; coerced.push(key); }
        } else if (typeof value === 'number' && (value === 0 || value === 1)) { out[key] = value === 1; coerced.push(key); }
        break;
      }
      case 'array': {
        if (typeof value === 'string') {
          const t = value.trim();
          if (t.startsWith('[')) {
            try { const parsed = JSON.parse(t); if (Array.isArray(parsed)) { out[key] = parsed; coerced.push(key); } } catch { /* keep */ }
          }
        } else if (typeof value === 'object') { out[key] = [value]; coerced.push(key); }
        break;
      }
      case 'object': {
        if (typeof value === 'string' && value.trim().startsWith('{')) {
          try { const parsed = JSON.parse(value); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) { out[key] = parsed; coerced.push(key); } } catch { /* keep */ }
        }
        break;
      }
      case 'string': {
        if (typeof value === 'number' || typeof value === 'boolean') { out[key] = String(value); coerced.push(key); }
        break;
      }
      default: break;
    }
  }
  return { args: out, coerced };
}

/**
 * 缺失必填参数补齐：DSH 按 schema 严格拒绝缺 required 的调用（真机 2026-09-13
 * 会话 cacaba8c turn3 实锤：GLM 调 pwsh 只给 command，DSH 回
 * `invalid arguments: missing required property "description"`，模型被这句错误
 * 引入重试死循环）。与 coerceArguments 同一哲学——只在**无歧义**时动手：
 *   · 只补 schema.required 声明、且类型为 string、名字是纯描述性的字段
 *     （白名单 description：pwsh / subagent / subagent_fork 三处，都是「展示在
 *     UI 上的用途概述」）；objective/file_path/pattern 等语义字段绝不猜；
 *   · 值来源两级：envelope 的 purpose（模型自述的调用原因）→ 已给参数中第一个
 *     非空字符串（pwsh→command、subagent→prompt 的前缀）；
 *   · 两级都取不到就保持缺失，交给 DSH 报它自己的错。
 *
 * @param {object} args 网页解析出的参数（已经过 coerceArguments）
 * @param {object} schema 该工具的 parameters（JSON Schema）
 * @param {string} [purpose] 调用 envelope 里的 purpose 字段（若有）
 * @returns {{args: object, filled: string[]}} filled 是被补齐的参数名
 */
const FILLABLE_REQUIRED = /^description$/;

export function fillMissingRequired(args, schema, purpose) {
  const out = (args && typeof args === 'object' && !Array.isArray(args)) ? { ...args } : {};
  const filled = [];
  if (!schema || typeof schema !== 'object' || !Array.isArray(schema.required)) return { args: out, filled };
  const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : {};
  for (const key of schema.required) {
    const current = out[key];
    if (current !== undefined && current !== null && current !== '') continue;
    const spec = props[key];
    if (!spec || spec.type !== 'string' || !FILLABLE_REQUIRED.test(key)) continue;
    let value = typeof purpose === 'string' ? purpose.trim() : '';
    if (!value) {
      for (const v of Object.values(out)) {
        if (typeof v === 'string' && v.trim()) { value = v; break; }
      }
    }
    if (!value) continue;
    out[key] = value.replace(/\s+/g, ' ').trim().slice(0, 120);
    filled.push(key);
  }
  return { args: out, filled };
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
  // 半角标签。`tool_result` 必须在列（0.14.5）：真机日志 session-c710ef6e 的
  // assistant/message seq=587 里，网页模型把工具结果连同 `<tool_result>` 外壳
  // 一起吐了回来，而锚点只认 tool_call —— 于是边界落在外壳**之后**的 JSON 上，
  // `<tool_result>\n`（13 字符）与 `</tool_result>\n`（14 字符）被当作正文发出。
  // 注意它只加进「边界锚点」，**不**加进下面的 transport 判定：工具结果不是
  // 工具调用，不该被当成需要执行的调用。
  //
  // `call_call` / `call` 也必须在列（0.14.6）：真机日志 session-698700ea 的
  // assistant/message **text** 块里出现了 13 处残片——`</call>`（seq=119 一步内 3 次、
  // seq=179 `</call> <call_call> {"mcp_action…`、seq=289）、`</call_call>`
  // （seq=91/326/569/779）；session-c710ef6e 的 seq=548 也有一处。
  // 旧候选集只有复数 `calls`：`<call>` 后面跟 `>`，`calls` 匹配不上；
  // `<call_call>` / `</call_call>` 更是完全不在集合里。于是 findProtocolStart
  // 返回 -1，残片被当正文 text-delta 外发并持久化（用户看到「界面出现 <>call」）。
  // 同样只进锚点、不进 transport——残片不是待执行的调用。
  // 安全性：`\b` 让 `<calling>` 不命中（`call` 后跟 `i` 都是词字符，词边界不成立）。
  /<\s*\/?\s*(?:tool_call|tool_calls|tool_result|tool_results|call_call|calls|call|function|stories|invoke)\b/i, // 半角标签
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
 * @param {number} [from] 只从该下标之后开始找（流式已消化的协议区间不再重复命中；
 *        不传等价于从头找，保持既有调用方语义不变）
 * @returns {{index: number, name: string, transport: boolean}}
 *          index=-1 表示尚未出现协议边界。
 */
export function findProtocolStart(text, from = 0) {
  const raw = String(text ?? '');
  const base = Math.max(0, Number(from) || 0);
  if (base >= raw.length) return { index: -1, name: '', transport: false };
  // 偏移用 slice 实现：PROTOCOL_ANCHORS 里的正则没有 g 标志，设 lastIndex 对
  // exec 完全无效（实测「从 84 开始找」仍返回 8，游标永远推不动 → 死循环）。
  const scoped = base > 0 ? raw.slice(base) : raw;
  let index = -1;
  for (const re of PROTOCOL_ANCHORS) {
    const m = re.exec(scoped);
    if (m && (index < 0 || m.index < index)) index = m.index;
  }
  if (index < 0) return { index: -1, name: '', transport: false };
  index += base;

  // 名字与传输形态都在归一化后的文本上判定，才能同时覆盖全角 DSML 与半角标签。
  const suffix = normalizeDsml(raw.slice(index));
  const name = suffix.match(/\*\*Calling:\*\*\s*`([\w.-]+)`/)?.[1]
    || suffix.match(/<\s*(?:tool_call|tool_calls|calls|function|stories|invoke)\b[^>]*?\bname\s*=\s*"([\w.-]+)"/i)?.[1]
    || suffix.match(/"name"\s*:\s*"([\w.-]+)"/)?.[1]
    || '';
  // 围栏 + {"name","arguments"}（无 mcp_action）：2026-09-08 真机 f3fa97fd 起
  // 的第二轮高频形状，parseAgentReply 的 fenceRe 会把它当真调用执行，边界探测
  // 必须同样认得，否则协议原文先以 text-delta 泄进 UI（0.9.6 的 transport 门
  // 只认 mcp_action，漏了这一形状）。
  const fenceCallAhead = /^```/.test(suffix) && /"arguments"\s*:/.test(suffix.slice(0, 400));
  const transport = /^<\s*(?:tool_call|tool_calls|calls|function|stories|invoke)\b|^\*\*Calling:|\*\*Calling:|"mcp_action"\s*:\s*"call"|^\s*\{\s*"tool"/i.test(suffix) || fenceCallAhead;
  return { index, name, transport };
}

/**
 * 从协议起点取「一个完整调用对象的原文」——流式期间用它判断某个调用是否已经
 * 写完整，以及给它做去重签名。
 *
 * 网页把同一个调用分多次增量吐出时，边界探测每个 delta 都会在同一位置命中；
 * 只有「参数 JSON 已经配平」才算这个调用真正出现（一次），否则每来一个 delta
 * 就会重复开一个块。返回 null 表示还没写完（继续等）。
 *
 * @param {string} text 累积文本
 * @param {number} start 协议起点下标
 * @returns {{raw: string, end: number}|null}
 */
export function readCallAt(text, start) {
  const src = String(text ?? '');
  const from = Math.max(0, Number(start) || 0);
  const open = src.indexOf('{', from);
  if (open < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = open; i < src.length; i++) {
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
        const raw = src.slice(open, i + 1);
        try {
          const obj = JSON.parse(raw);
          if (obj && typeof obj === 'object' && !Array.isArray(obj)) return { raw, end: i + 1 };
        } catch { /* 还没配平/还没写完 */ }
        return null; // 配平但 JSON 非法：判定为未完成，等更多增量
      }
    }
  }
  return null;
}

/**
 * 正文尾部出现「协议标记写到一半」的位置。
 *
 * 流式期间标记是一个字符一个字符到的：`<` → `<t` → `<to` → `<tool_call>`。
 * 边界探测（findProtocolStart）只认完整标记，所以这段半成品必须**扣住不发**，
 * 否则它会作为正文发给界面并写进会话（真机 0.9.2 的协议泄漏正是这个形态：
 * `<tool_cal` 被当散文发出，紧接着 `</tool_call>{"mcp_action":…` 也漏了出去）。
 *
 * 只扫尾部有限长度（标记最长约 16 字符）。返回需要扣住的起点下标，-1 表示没有。
 *
 * @param {string} text 累积文本
 * @param {number} [scope] 只看尾部多少字符（默认 24）
 * @returns {number}
 */
export function partialProtocolAt(text, scope = 24) {
  const raw = String(text ?? '');
  const s = normalizeDsml(raw);
  const n0 = Math.min(s.length, Math.max(2, scope));
  const prefixes = ['<tool_call', '<tool_calls', '<call_call', '<call', '<invoke', '<parameter', '<function', '<stories', '**Calling:'];
  // 半成品标记的起点下标（归一化串上算出来的，再映射回原串）。
  const locate = (n) => {
    const tail = s.slice(s.length - n);
    const at = raw.lastIndexOf(tail);
    return at >= 0 ? at : Math.max(0, raw.length - n);
  };
  for (let n = 2; n <= n0; n++) {
    const tail = s.slice(s.length - n);
    if (/[<*]$/.test(tail)) continue;   // 纯前缀（`<` / `**`），继续看更长的
    if (prefixes.some(p => p.startsWith(tail))) return locate(n);
  }
  // 结尾是「刚起头的标签」（`<` / `</` / `<div` 这类还可能是协议标签的前缀）
  if (/(^|[^<])(<\/?|<\/?[A-Za-z_][\w-]*)$/.test(s.slice(-scope))) {
    const m = /<\/?[A-Za-z_][\w-]*$|<\/?$/.exec(s.slice(-scope));
    if (m) {
      const at = raw.lastIndexOf(m[0]);
      if (at >= 0) return at;
    }
  }
  return -1;
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
    // purpose 是模型对「为什么调」的自述：派发侧用它补缺失的 description 类
    // 必填参数（fillMissingRequired），比从命令前缀派生更贴切。没有就不带键。
    const purpose = typeof obj.purpose === 'string' ? obj.purpose.trim() : '';
    calls.push({ name: obj.name.trim(), arguments: args, ...(purpose ? { purpose } : {}) });
  };
  const fenceRe = /```(?:json)?\s*\n?([\s\S]*?)```/gi;
  let m;
  while ((m = fenceRe.exec(s)) !== null) takeObj(m[1]);
  const tagRe = /<\s*(?:tool_call|function|stories)\s*>([\s\S]*?)<\s*\/\s*(?:tool_call|function|stories)\s*>/gi;
  while ((m = tagRe.exec(s)) !== null) takeObj(m[1], true);
  // GLM-5.3 原生形状（2026-09-13 真机）：工具名裸放在标签后、参数 JSON 直接
  // 跟随，没有 name 字段——<tool_call>pwsh{"command":"Get-ChildItem …"}</tool_call>。
  // tagRe 对它取到的 body 以工具名开头（不以 { 开头）而跳过，这里单独还原：
  // 裸名 + 配平 JSON + 紧跟闭标签三件齐才认，散文里的举例不会误报。
  const bareNameRe = /<\s*(?:tool_call|function)\s*>\s*([\w.$-]+)\s*/gi;
  while ((m = bareNameRe.exec(s)) !== null) {
    const hit = readCallAt(s, m.index + m[0].length);
    if (!hit) continue;
    if (!/^\s*<\s*\/\s*(?:tool_call|function)\s*>/i.test(s.slice(hit.end))) continue;
    try {
      const args = JSON.parse(hit.raw);
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        takeObj(JSON.stringify({ mcp_action: 'call', name: m[1], arguments: args }), true);
      }
    } catch { /* 配平但非对象：不算调用 */ }
  }
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
