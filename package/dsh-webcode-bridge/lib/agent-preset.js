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
export function trainNoteFor(siteId, extra = '') {
  const base = siteId === 'glm' ? TRAIN_NOTE_GLM : TRAIN_NOTE;
  // extra 只在实验变体里非空；默认路径（'' ）返回值与 0.14.7 逐字相同。
  return extra ? base + extra : base;
}

/**
 * 「重述关键约束」后缀（**实验变体 V1 专用**；默认路径不追加）。
 *
 * 为什么值得试：ACL Findings《Improving Long Context Instruction Following》
 * 实测「周期性重述指令」（Reinstruct）显著优于「只靠一次系统提示」。而现有
 * TRAIN_NOTE 只重述**格式**，没有重述**约束**——工具错误里占比最高的是
 * 「必填字段没给」与「用 Unix 命令打 Windows」这两类，恰好都是格式之外的事。
 *
 * 为什么不直接改默认：NeurIPS 2024《On the Worst Prompt Performance of LLMs》
 * 表明提示词效果**不稳定且无法提前识别最差形态**（Llama-2-70B 最好最差差
 * 45.48%），既有技巧对最差表现的提升「impact is limited」。因此默认路径保持
 * 0.14.7 逐字不变，改进必须先有实测数据再谈转正。
 * 依据与出处：doc/research/prompt-engineering-evidence-2026-09-14.md。
 */
const REINSTRUCT_SUFFIX = Object.freeze({
  base: '\n[关键约束重述] ① 本机是 Windows：命令与路径按 PowerShell 写（用 $env:NAME，不要用 bash 的 && 链）。'
    + '② arguments 必须含 schema 里 required 的每个字段（pwsh 必须同时给 command 与 description）。'
    + '③ 不得虚构工具结果：没有真实数据就先发起调用，拿到结果再继续。',
  present: '④ 写/改完用户要拿到手的文件后，在最终答复之前必须调 present 声明它们。',
});

/** 按变体拼出 trainNote 的附加后缀。`present` 只在会话真的注册了 present 时附加。 */
export function trainExtraFor(variant, { hasPresent = false } = {}) {
  if (variant !== 'reinstruct') return '';
  return REINSTRUCT_SUFFIX.base + (hasPresent ? REINSTRUCT_SUFFIX.present : '');
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
  // 实验变体 slim（**默认关闭**）：首轮更短。依据 arXiv 2510.05381「长上下文
  // 本身有害，即使检索完美」。取值刻意用「显式传入」而不是全局开关——
  // 默认路径必须与 0.14.7 逐字相同，任何收敛都要先有配对数据。
  const descLimit = Number.isFinite(options.toolDescLimit) && options.toolDescLimit > 0
    ? options.toolDescLimit : MAX_TOOL_DESC_CHARS;
  const slim = options.slim === true;
  // present 是「交付物」的唯一声明入口：只有本会话真的注册了它，才值得教模型去调
  // ——不能让模型去调用一个不存在的工具（那会白费一轮并撞 TOOL_UNKNOWN）。
  const hasPresent = tools.some((t) => t && t.name === 'present');
  if (tools.length) {
    const lines = [];
    for (const t of tools) {
      if (!t || typeof t.name !== 'string') continue;
      const desc = typeof t.description === 'string' ? t.description.slice(0, descLimit) : '';
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
      // slim 变体只保留上面两条（判据「要不要用工具」与「用几次」），
      // 把「不要编造」「不要堆砌」两条合并进第 2 条——它们本就是同一约束的
      // 正反两面。默认路径（slim !== true）四条逐字不动。
      ...(slim ? [] : [
        '没有真实依据时不要编造文件内容、命令输出或执行结果；卡住就明确说明缺什么信息。',
        '不要为了显得勤快而堆砌无用调用，也不要为了省事而把本可使用真实工具解决的事强行用文字搪塞。',
      ]),
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
 * tool_call_id → 工具名 的索引，用于把 `role: 'tool'` 的结果消息对回它是谁的结果。
 *
 * 为什么需要它：DSH 的 tool 消息只带 `tool_call_id`（见下面 `serializeDelta` 里
 * `idToName.get(m.tool_call_id)`），而回传给网页的 result 信封必须写**工具名**，
 * 否则网页模型看到的是一个裸 id，无法判断那是哪个工具的结果。
 *
 * 只看 assistant 消息里的 tool-call 块：那是唯一携带 `{ id, name }` 配对的地方。
 * 取不到名字的 id 记成 `'unknown'`——宁可显式写 unknown，也不要让信封里出现
 * 一个空名字（空名字会让网页把结果当成格式错误而丢弃）。
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

/**
 * 增量轮的首轮之后文本：只发 `sent` 之后**新增**的部分（`sent` 是已消费的消息条数）。
 *
 * 新用户文本原样透传；工具结果变成 `mcp_action: result` 围栏；网页侧自己产出的
 * assistant 消息跳过但仍计数——不计数的话游标永远推不动，同一段会被反复发出去。
 *
 * 返回值里的 `consumed` 恒为 `messages.length`（而不是「成功发到第几条」）：
 * 只有调用方知道这一轮到底算不算数，由它决定何时推进游标。桥不替它做这个判断。
 *
 * @param {Array} messages DSH 传来的完整消息数组
 * @param {number} sent 已消费的消息条数（游标）
 * @param {number} [toolResultsSent] 已发过的工具结果条数（决定何时附训练提示）
 * @param {Map<string,string>} [knownNames] 预先算好的 id→名字索引；不传就现算
 * @param {string} [note] 附加的 system_note（训练提示 / 协议提醒）
 * @returns {{text: string, consumed: number}}
 */
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

/**
 * 按 schema 补齐缺失的**纯描述性**必填参数，避免 DSH 因缺一个 description 就整次拒绝。
 *
 * 只有 `description` 在白名单里（`FILLABLE_REQUIRED`）——它是展示在 UI 上的
 * 用途概述，补错也只是措辞不贴切；`command` / `objective` / `file_path` 这类
 * 语义字段一旦猜错就是**执行错的事**，绝不代填。
 *
 * 值来源两级：envelope 的 `purpose`（模型自述的调用原因）→ 已给参数中第一个
 * 非空字符串。两级都取不到就保持缺失，交给 DSH 报它自己的错——桥不吞不猜。
 *
 * @param {object} args 网页解析出的参数（已经过 coerceArguments）
 * @param {object} schema 该工具的 parameters（JSON Schema）
 * @param {string} [purpose] 调用 envelope 里的 purpose 字段（若有）
 * @returns {{args: object, filled: string[]}} filled 是被补齐的参数名
 */
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
 * DeepSeek 网页版的 DSML 变形归一：竖线全角化成对出现（< calls>，
 * U+FF5C）、或丢开头 <。reference/deepseek-free-api 的 strip_dsml_markup 用
 * chr(0xff5c) 处理同一问题。把 DSML 前缀整体剥掉还原成裸 XML 标签。
 *
 * ⚠ 必须与 parseAgentReply 内联的那段替换保持一致——两处都认同一批形态，
 *   一旦漂移就会出现「解析认得出、边界探测认不出」的泄漏（0.9.4 修的正是
 *   这个：全角 DSML 被 parseAgentReply 收下，却被流式探测放过，协议原文
 *   已作为 text-delta 发给显示层）。test/protocol-leak.test.mjs 用真机夹具
 *   锁住两者的一致性。
 *
 * 0.15.0 修掉一个**真实形态漏网**：标记与标签名之间会夹一个空格。
 * 真机逐码点取证（会话 e5cb719c step6 / session-a6835ca1 step22 的 text 块）：
 *
 *   U+003C U+FF5C U+FF5C D S M L U+FF5C U+FF5C **U+0020** c a l l s U+003E
 *
 * 旧实现只把 `<` 换成 `<`，**不吃那个空格**，于是归一化结果是
 * `< calls>` 而不是 `<calls>`。后果分两处：
 *   • `findProtocolStart` 的锚点写作 `<\s*\/?\s*(?:…)`，容忍 `<\s`，所以**边界仍然
 *     探得到**——这也是为什么没人发现（泄漏的 21,905 字符正文里，边界其实是对的）；
 *   • `partialProtocolAt` 的前缀表是**精确字符串**（`'<tool_call'`…），`< calls`
 *     不是任何一项的前缀，于是「标记刚写一半」的尾部扣留失效。
 * 修法：只在**后面确实跟着已知标记名**时才连空格一起吃（带 lookahead 的那条），
 * 其余情况退回「只剥标记、不动空格」的旧行为——避免把 `<` 之后的普通
 * 换行也吃掉，凭空把散文接成 `<hello` 这种假标签。
 */
export function normalizeDsml(text) {
  return String(text ?? '')
    // 带开头 `<`，且后面确实是已知标记名：连标记后的空格一起吃掉。
    // 先写这条、再写不吃空格的兜底——正则按书写顺序执行，前者命中后后者不再有机会。
    .replace(/<\s*[\uFF5C|]+\s*DSML\s*[\uFF5C|]+\s*(?=(?:tool_calls?|toolcall|toolcalls|tool_call|calls|invoke|parameter|call)\b)/gi, '<')
    // 兜底：仍是标记，但后面不是已知标记名——只剥标记，保留其后的空白
    .replace(/<\s*[\uFF5C|]+\s*DSML\s*[\uFF5C|]+/gi, '<')
    .replace(/<\/\s*[\uFF5C|]+\s*DSML\s*[\uFF5C|]+\s*/gi, '</')
    // 丢开头 < 的裸标记（<invoke …）：只在后跟已知标记名时补 <，避免误伤正文
    .replace(/(^|[^\w<])[\uFF5C|]+\s*DSML\s*[\uFF5C|]+\s*(?=(?:tool_calls?|calls|invoke|parameter)\b)/gi, '$1<');
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
  // `toolcall` / `toolcalls`（**无下划线**）也必须在列（0.15.0）：这是 0.14.6 那次修复
  // **没盖住**的一族，且发生在最新两个会话里，不是历史遗留。真机证据（会话日志逐块扫描，
  // 只认 text 块；reasoning 块不外发，不计）：
  //   session-94966bd8 seq=2798  text 块仅 34 字符，内容就是闭标签 + 开标签 + 调用 JSON 头
  //   session-94966bd8 seq=2983  text 块 1,061 字符，散文之后紧跟完整调用 JSON
  //   session-f9010b75 seq=812   text 块 29,650 字符，含整段被当文本发出的调用 JSON，
  //                              其后是数百次重复的闭合标签噪声
  // 为什么旧集合救不了它：`<` `/` 之后必须从候选词起匹配，位置落在 `t` 上，而集合里只有
  // `tool_call`（需要一个下划线），**没有无下划线的那一族**；0.14.6 追加的 `call` 也救不了
  // ——`call` 要从 `c` 开始，无下划线族的首字母是 `t`。于是 findProtocolStart 返回 -1，
  // 残片被当正文外发并持久化。与 `call` / `call_call` / `tool_result` 同纪律：**只进锚点，
  // 不进 transport**——它是不是「待执行的调用」由 parseAgentReply 按内容判定，不靠标签名猜。
  //
  // 这是 `doc/long-term-issues.md` 第 15 条方法论的第 2 次生效：
  // **检测器不能只覆盖已知形态**。扩锚点时 `test-mock/parse-session-log.mjs` 的
  // `detectProtocolLeak` 与 `test/protocol-leak.test.mjs` 的夹具必须同步，否则下次
  // 「日志没有泄漏告警」仍然是假阴性。
  //
  // 安全性：`\b` 让 `<calling>` 不命中（`call` 后跟 `i` 都是词字符，词边界不成立）。
  /<\s*\/?\s*(?:tool_call|tool_calls|toolcall|toolcalls|tool_result|tool_results|call_call|calls|call|function|stories|invoke)\b/i, // 半角标签
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
  // 0.15.5 真机缺陷修复：两条 **markdown 敏感**锚点必须后验，不能无条件当协议起点。
  //
  // 背景（用户直接报的症状）：「网页端 markdown 渲染正常，harness 这里总是莫名其妙
  // 没有渲染？# 后面没有空格？代码块包裹没有换行？导致没有闭合？」
  //
  // 根因：markdown 代码块是助手正文的常见形态（```js / ```bash / 裸 ```），而 ```
  // 同时也是本桥 webcode 协议的调用围栏开头。旧实现把**任何** ``` 都当协议边界，
  // 于是 proseSafeEnd 一到围栏就停，围栏及其之后的正文被整段丢弃。实测
  //（.tmp/fence-probe.mjs，修复前）：
  //   "下面是示例：\n\n```js\nconst a = 1;\n```\n\n结束。"  → 只外发 8/35 字符
  //   "# 标题\n\n正文段落。"（无围栏）            → 11/11 完整
  //
  // 同理「裸 JSON 对象行」锚点在围栏**内部**也会误命中：markdown 里的示例 JSON
  // 不是待执行调用。
  //
  // 两条的处理方式不同，但都遵守「宁可放过、不可错杀普通代码块；装真调用的照旧拦」：
  //   • ``` 锚点 → firstCallFenceAt：只在**围栏自身内容**（含未闭合的流式尾）里
  //     出现 "mcp_action":"call" 或 "arguments" 时才算调用围栏；
  //   • 裸 JSON 行锚点 → firstBareJsonLineAt：跳过位于围栏内部的那些行。
  // 围栏之外的既有行为**逐字不变**（那是 0.9.2 / 0.14.6 / 0.15.0 三次泄漏事故
  // 换来的安全线，不能顺手放宽）。
  let index = -1;
  // 排除两条 **markdown 敏感**锚点（下标 3 = ``` 围栏、5 = 裸 JSON 对象行）：
  // 它们必须后验，否则普通代码块会被当成协议边界。见下方 firstCallFenceAt /
  // firstBareJsonLineAt 两处的说明。其余锚点（标签族 / DSML / Calling）逐字不变。
  for (const re of PROTOCOL_ANCHORS.filter((_, i) => i !== 3 && i !== 5)) {
    if (re.source === '```') continue;                                  // 见上，单独后验
    if (re.source === '(?:^|\\n)[ \\t]*\\{') continue;                  // 见上，单独后验
    const m = re.exec(scoped);
    if (m && (index < 0 || m.index < index)) index = m.index;
  }
  const fenceAt = firstCallFenceAt(scoped, 0);
  if (fenceAt >= 0 && (index < 0 || fenceAt < index)) index = fenceAt;
  const braceAt = firstBareJsonLineAt(scoped, 0);
  if (braceAt >= 0 && (index < 0 || braceAt < index)) index = braceAt;
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
  // transport（「这段可能是待执行的调用」）**刻意保持与 0.14.6 逐字相同**，不跟着锚点扩集。
  // 理由（0.15.0 的取舍，写下来免得下次有人「顺手补齐」）：transport 的唯一消费点是
  // lib/index.js 流式循环里「正文外发到哪里为止」的判据。`rest.transport === false` 时仍有
  // `tagAhead`（首字符是 `<`）兜底，一样停在锚点；`transport === true` 只是让停得更早一点点。
  // 也就是说，把无下划线族加进 transport 对**已覆盖**的路径没有任何行为增益，却会让
  // 「什么算调用」的知识在两处重复——而 0.9.4 / 0.14.6 两次事故的共同教训正是
  // 「两处形态知识一漂移就泄漏」。真正判定「这是不是调用」的始终是 parseAgentReply 按
  // 内容解析（JSON 配平 + name + 工具表校验），不是标签名。判断对不对由
  // test/protocol-leak.test.mjs 的「六种形态 probe 与 parser 必须一致」断言钉住。
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
/**
 * 扫出「裸 JSON 对象行」里真正的调用行，跳过 markdown 围栏内部的示例 JSON。
 *
 * ## 为什么需要它（0.15.5 真机缺陷）
 *
 * `PROTOCOL_ANCHORS` 里的 `(?:^|\n)[ \t]*\{` 本来用来抓「网页把调用写成一个裸
 * JSON 对象行」的形态。但它对 markdown 过于宽泛：**代码块里的示例 JSON** 也被命中，
 * 于是 `proseSafeEnd` 在示例 JSON 处停下，后面的正文被丢弃。实测
 *（test/fence-prose.test.mjs「代码块内的 JSON（无 arguments 字段）→ 保留」一例）：
 *
 *   输入「配置示例：\n\n```json\n{"name": "demo", "value": 1}\n```\n\n完。」
 *     → 旧实现在下标 14（`{` 前那个换行）就判成协议边界，正文被截断
 *
 * ## 判据
 *
 * 逐个候选 `{` 检查它是否落在 markdown 代码围栏内部：在内部的一律不是调用，
 * 跳过继续找。围栏外部的行为与旧锚点**逐字相同**（返回包含前导换行的匹配起点），
 * 不改变既有调用形态的识别。
 *
 * @param {string} text 待搜文本
 * @param {number} [from] 起始下标
 * @returns {number} 裸 JSON 调用行的匹配起点；没有则 -1
 */
export function firstBareJsonLineAt(text, from = 0) {
  const src = String(text ?? '');
  const base = Math.max(0, Number(from) || 0);
  const re = /(?:^|\n)[ \t]*\{/g;
  re.lastIndex = base;
  let m;
  while ((m = re.exec(src)) !== null) {
    const braceAt = m.index + m[0].length - 1;   // `{` 自身的下标
    if (!insideCodeFence(src, braceAt)) return m.index;
    re.lastIndex = braceAt + 1;
  }
  return -1;
}

/**
 * 下标 `pos` 是否落在 markdown 代码围栏内部。
 *
 * 用「它前面出现过奇数个 ``` 」判定。未闭合的围栏（流式途中或用户没写闭合）
 * 算作「内部」——那种情况下围栏后面的内容在语义上仍属于代码块。
 *
 * 只认 ``` 围栏。行内代码（单反引号）不参与：它不是协议边界，也不影响这里。
 *
 * @param {string} src 全文
 * @param {number} pos 待判下标
 * @returns {boolean}
 */
function insideCodeFence(src, pos) {
  return fenceSpans(src).some((f) => pos >= f.open && pos < f.close);
}

/**
 * 扫出文本里所有**成对**的 ``` 围栏区间。
 *
 * ## 为什么不能用「前面有几个 ```」的奇偶判定（0.15.6 修）
 *
 * 旧 `insideCodeFence` 只数 pos 之前 ``` 的个数，奇数即在围栏内。这个判据隐含
 * 「围栏不嵌套」的前提，而**调用参数里的 markdown 正文自带围栏**是常态
 * （实测 97 个会话里 108 个 tool-call 的参数含 ```，见 .tmp/scan-fence-calls.mjs）。
 * 嵌套时奇偶会提前翻转：外层围栏里的内层围栏让计数多走一轮，于是
 * `firstBareJsonLineAt` 会把**围栏外**的裸 JSON 调用行误判成「围栏内示例」跳过
 * （放过真调用），或反过来把内层示例当调用（错杀普通代码块）。
 *
 * 配对扫描给出的是「区间」，不含任何奇偶前提，上面两种误判同时消失。
 * 未闭合的收尾围栏（流式途中）算作延伸到文本结尾——语义与旧注释一致：
 * 那种情况下围栏后面的内容在语义上仍属于代码块。
 *
 * @param {string} src 全文
 * @returns {Array<{open: number, close: number}>} 按 open 升序的围栏区间（close 为排他终点）
 */
function fenceSpans(src) {
  const spans = [];
  let at = src.indexOf('```');
  while (at >= 0) {
    const close = src.indexOf('```', at + 3);
    if (close < 0) { spans.push({ open: at, close: src.length }); break; }
    spans.push({ open: at, close: close + 3 });
    at = src.indexOf('```', close + 3);
  }
  return spans;
}

/**
 * 找一个「真的装着工具调用」的 ``` 围栏位置。
 *
 * ## 为什么需要这个函数（0.15.5 真机缺陷）
 *
 * markdown 代码块是助手正文的常见形态，而 ``` 同时也是本桥 webcode 协议的调用围栏
 * 开头。旧实现把**任何** ``` 都当协议起点，`proseSafeEnd` 一到围栏就停，围栏及其后
 * 的正文被整段丢弃。实测 `.tmp/fence-probe.mjs`：
 *
 *   输入「下面是示例：\n\n```js\nconst a = 1;\n```\n\n结束。」
 *     → findProtocolStart.index = 8，proseSafeEnd = 8，只外发 8/35 字符
 *   输入「# 标题\n\n正文段落。」（无围栏）
 *     → index = -1，proseSafeEnd = 11，11/11 完整
 *
 * 用户可见症状：harness 里代码块「没有换行、没有闭合」——围栏被吞，剩下的代码行
 * 与后续正文一起丢失。
 *
 * ## 判据（宁可放过、不可错杀）
 *
 * 围栏之后必须在有限窗口内出现一个 JSON 对象，且它带调用协议的关键字段：
 *   • `"mcp_action"` + `"call"`（本桥协议），或
 *   • `"arguments"`（围栏调用形状；真机 f3fa97fd 的高频形态）
 * 缺任一特征的普通 markdown 代码块**不是**调用围栏，跳过继续找。
 *
 * 窗口由**围栏体内的配平 JSON** 界定（0.15.6 起），不再是固定 400 字符：
 * 旧宽度假设「调用 JSON 就在围栏开头附近」，而参数里自带 markdown 时 JSON 可以
 * 长达数万字符，固定窗口会在报告中间被截断。判据本身（要有 JSON + 调用关键字段）
 * 未变，`fenceCallAhead` 的 400 字符窗口也保留——那是**流式 transport** 的判据，
 * 两者职责不同：这里问「哪个围栏是调用围栏」，那里问「这段要不要先扣住」。
 *
 * @param {string} text 待搜文本
 * @param {number} [from] 起始下标
 * @returns {number} 调用围栏的 ``` 起点下标；没有则 -1
 */
export function firstCallFenceAt(text, from = 0) {
  const src = String(text ?? '');
  const base = Math.max(0, Number(from) || 0);
  const re = /```/g;
  re.lastIndex = base;
  let m;
  while ((m = re.exec(src)) !== null) {
    // 0.15.6 真机缺陷修复：窗口必须由**围栏体内的配平 JSON**界定，不能再由
    // 「下一个 ```」界定。
    //
    // 旧写法 `closeAt = src.indexOf('```', m.index + 3)` 找的是**第一个内层**围栏：
    // 调用参数里的 markdown 正文自带围栏时（write 一份含代码块的报告——这是写
    // 文档/写代码的主路径，实测 108 例），窗口在报告的表格处就被截断，里面既
    // 没有配平 JSON 也没有 "arguments"，于是**真调用围栏被判成普通围栏**返回 -1。
    // 后果不是「少拦一个调用」，而是 findProtocolStart 返回 -1 ⇒ proseSafeEnd
    // 返回全文长度 ⇒ 整段原始协议被当正文外发并持久化（用户看到 harness 端
    // markdown 整块不见、只剩一坨原始 JSON）。A/B 实测（.tmp/probe-audit-regress.mjs）：
    //   0.15.3 withheld=313（好歹扣住）→ 0.15.5 withheld=0（全文泄漏）。
    //
    // 现在用 fenceCallBodyAt 以 readCallAt 的花括号/字符串转义感知定位 JSON，
    // 参数值里的 ``` 不再能截断窗口。判据本身（要有配平 JSON + 调用关键字段）
    // 逐字保留——放宽的只是「窗口怎么取」。
    const body = fenceCallBodyAt(src, m.index);
    // body === null：这个 ``` 是**闭合**围栏（到下一个 { 之间还有围栏），不是开头。
    // 直接前进一格继续扫——它不是候选，但后面的围栏还要看。
    if (!body) { re.lastIndex = m.index + 3; continue; }
    // 未闭合（流式途中，闭合围栏还没到）时不能要求 JSON 已配平：`` ```json `` 之后
    // 紧跟 `{"mcp_action":"call"` 的瞬间还没有闭合花括号，若在这里要求配平，
    // 这段协议原文会先作为正文外发——正是本项目三次泄漏事故（0.9.2 / 0.14.6 /
    // 0.15.0）同一形态。闭合的围栏则仍要求配平，普通代码块才不会被误判。
    const hasMcpCall = /"mcp_action"\s*:\s*"call"/.test(body.after);
    const hasArguments = /"arguments"\s*:/.test(body.after);
    if ((body.balanced || body.unclosed) && (hasMcpCall || hasArguments)) return m.index;
    // 非调用围栏：跳过这一整个围栏（含闭合），避免在内层代码里重复命中。
    // 跳过量取自配平 JSON 的结束位置（拿不到就退回找下一个 ```），并保证严格
    // 前进——否则同一位置会被反复命中，探测游标永远推不动（与 :591 记的旧坑同型）。
    const skipTo = body.balanced ? body.closeEnd : src.indexOf('```', m.index + 3);
    if (skipTo < 0) return -1;
    re.lastIndex = Math.max(skipTo, m.index + 4);
  }
  return -1;
}

/**
 * 从围栏起点取「围栏体内那个配平 JSON 调用对象」的原文。
 *
 * ## 为什么必须用 readCallAt 而不是 ``` 配对（0.15.6 修）
 *
 * `readCallAt` 逐字符扫，正确处理字符串内的 `\"` / `\\` 转义与花括号配平，
 * 所以参数值里出现 ``` 时它**不会**把那个反引号当成围栏结束。这与
 * `parseAgentReply` 判定「这是不是一个调用」用的是同一个定位器——本项目的
 * 一贯纪律：**「什么算围栏体」只该有一份知识**（0.9.4 / 0.14.6 / 0.15.0 三次
 * 泄漏事故的共同教训就是两处形态知识一漂移就漏拦）。
 *
 * @param {string} src 全文
 * @param {number} fenceStart ``` 的起点下标
 * @returns {{after: string, jsonRaw: string, jsonEnd: number, balanced: boolean, unclosed: boolean}}
 *   after     —— 用于「有没有调用关键字段」判定的窗口（配平时含整个 JSON，未配平时到结尾）
 *   jsonEnd   —— 配平 JSON 的排他终点；未配平时为 -1
 *   balanced  —— JSON 已配平且其后能找到闭合围栏
 *   unclosed  —— JSON 没配平（流式途中）或闭合围栏还没到
 */
function fenceCallBodyAt(src, fenceStart) {
  const tail = src.slice(fenceStart + 3);      // 跳过 ``` 本身
  const open = tail.indexOf('{');
  // 这个 ``` 与它后面第一个 `{` 之间还有另一个 ``` ⇒ 它是**闭合**围栏，不是开头。
  // 少了这道门，扫描会把「闭合围栏 + 后面某个裸对象」拼成一个假围栏体。
  if (open < 0 || tail.slice(0, open).includes('```')) return null;
  const hit = readCallAt(tail, open);
  if (!hit) {
    // JSON 还没配平（流式途中）：窗口取到文本结尾，靠调用关键字段本身判定。
    // 这一段是 0.9.2 / 0.14.6 / 0.15.0 三次泄漏事故换来的放行条件，不能收紧。
    return { after: tail, jsonRaw: '', jsonEnd: -1, balanced: false, unclosed: true };
  }
  const jsonEnd = fenceStart + 3 + hit.end;
  const closeAt = src.indexOf('```', jsonEnd);
  if (closeAt < 0) {
    // JSON 配平了但闭合围栏还没到（流式途中）：窗口就是这个 JSON，
    // 调用关键字段在它里面，不需要再往后看。
    return { after: hit.raw, jsonRaw: hit.raw, jsonEnd, closeEnd: -1, balanced: false, unclosed: true };
  }
  return { after: hit.raw, jsonRaw: hit.raw, jsonEnd, closeEnd: closeAt + 3, balanced: true, unclosed: false };
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
  // 无下划线的 `toolcall` / `toolcalls`（0.15.0）与上面锚点扩集**必须同时到**：
  // 少了这里，`<toolcal` 这种流式半成品会被当散文发出去，紧接着 `l>` + 调用 JSON 也漏出
  // ——正是 0.9.2 记下的那个形态，只是换了一个标签名。前缀表的宽度由
  // findProtocolStart 里归一化后的实际候选集决定，两者漂移就是泄漏。
  const prefixes = ['<tool_call', '<tool_calls', '<toolcall', '<toolcalls', '<call_call', '<call', '<invoke', '<parameter', '<function', '<stories', '**Calling:'];
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
  // DSML 标记写到一半（0.15.0 真机实锤）：流被掐断时尾部可能是 `...<｜` 或
  // `...<｜｜DSM`。**归一化救不了这一段**——normalizeDsml 的两条规则都要求
  // `DSML` 四个字母齐全，`DSM` 不匹配任何一条，于是 s 里它原样还在，
  // 上面按 `<` 开头的 prefix 比较也一个都不命中，半成品就这样被当散文发出去。
  // 真机证据：会话 session-a6835ca1 seq=812 那条 29,650 字符的消息，正文里同时
  // 有完整调用 JSON 和成串的闭合标签噪声——断流轮次的尾部形态本来就不可控。
  // 判据：尾部以 `<` 开头、且其后只由全角/半角竖线、DSML 的字母前缀组成。
  // 用 lookahead 逐字判，`<｜x` 这种（x 既不是竖线也不是 D/S/M/L）不算半成品，
  // 普通散文不会被误扣。
  const dsmlHead = /<[｜|\uFF5C]*(?:D(?:S(?:M(?:L)?)?)?)?$/.exec(s.slice(-scope));
  if (dsmlHead) {
    // 至少要有「一个竖线」或「D/S/M/L 里至少一个字母」，否则 `<` 单个字符
    // 交给下面那条通用规则处理，避免把普通的 `<` 结尾也判成 DSML 半成品。
    if (/[｜|\uFF5C]|[DSML]/.test(dsmlHead[0])) {
      const at = raw.lastIndexOf(dsmlHead[0]);
      if (at >= 0) return at;
    }
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

/**
 * 正文的**安全终点**：从 `from` 起，`text` 中最后一个可以安全当正文外发的下标。
 *
 * ## 为什么必须有这个函数（0.15.0，真机实锤，不是推测）
 *
 * `stripProtocolText` 只能在**收尾已经认出调用**时当兜底；但真机存在一条
 * 「协议边界已探到、调用却永远认不出」的路径，两处收尾都漏了：
 *
 * 会话 `e5cb719c`（子代理，step 6）与 `session-a6835ca1`（主会话，step 22）的
 * assistant/message **text 块**里，把整段协议原文持久化了。逐码点核对（不是肉眼）：
 *
 *   U+003C U+FF5C U+FF5C U+0044 U+0053 U+004D U+004C U+FF5C U+FF5C U+0020
 *   U+0063 U+0061 U+006C U+006C U+0073 U+003E
 *
 * 即 **`<` + 全角竖线×2 + `DSML` + 全角竖线×2 + 空格 + `calls` + `>`**，随后是
 * `invoke name="pwsh"` 与 `parameter name="command"`。三点关键事实：
 *
 * 1. `findProtocolStart` 对这两段返回的是 `index=99/65, transport=true` —— **边界探测
 *    没坏**，它正确地在协议起点停住了；
 * 2. 但那一轮的网页流是断的（`no_response_frames` / `stream_ended_before_finished`），
 *    invoke 的 JSON 只到一半，`parseAgentReply` 于是返回 **0 个调用**；
 * 3. 收尾分支「没有调用」时走的是把 `finalText` 整段当正文的那条路 —— 它**没有**
 *    再过一次边界，于是 `finalText.slice(textSent.length)` 把 255 字符（另一例 21,905
 *    字符）的协议原文当 text-delta 发了出去，并作为 text 块写进会话。
 *
 * 所以漏洞不在探测，而在**收尾没有复用探测的结论**。这个函数就是那条复用：
 * 「正文最远能发到哪」只该有一个判据，探测和收尾必须用同一个。
 *
 * 与 `stripProtocolText` 的分工：那个从 0 扫、用于「已确认无调用」的整段清理；
 * 这个从 `from` 扫、用于**流式已经发过一部分**之后「还能再发多少」。
 * 两者都只认 `findProtocolStart` 这一套形态知识，不另起一份。
 *
 * @param {string} text 累积的完整文本（收尾时的权威全文）
 * @param {number} [from] 已经外发到的下标（结果不会小于它，保证单调、不重复发）
 * @returns {number} 可以外发的排他终点
 */
export function proseSafeEnd(text, from = 0) {
  const raw = String(text ?? '');
  const base = Math.max(0, Math.min(Number(from) || 0, raw.length));
  const rest = findProtocolStart(raw, base);
  if (rest.index >= 0) return Math.max(base, rest.index);
  // 0.15.6 兜底（真机回归的止血带）：边界探测返回 -1 **不等于**「全文都是正文」。
  //
  // 上面那条 return raw.length 是这条链路上唯一没有第二判据的地方：探测一旦漏
  // 一个形态（0.15.5 的围栏窗口取错就是），泄漏量立刻从「扣住几百字符」放大成
  // 「整段协议进 UI 并持久化」。这里加一道与探测**同源但独立**的确认：
  // 文本里若存在「围栏体内配平、且带 mcp_action:call 或 arguments 的 JSON」，
  // 那它一定是调用围栏，无论 findProtocolStart 认不认得。
  //
  // 只做「更保守」的收窄，不做任何放宽：它只会让外发**变少**，永远不会把
  // 原本扣住的正文放出去。因此即使探测正常，这一条也不会改变既有行为。
  const fenceAt = firstCallFenceAt(raw, base);
  if (fenceAt >= base) return fenceAt;
  // 没有完整锚点，但尾部可能正卡在一个写了一半的标记上（流被掐断的典型形态：
  // 真机 seq=812 那条 29,650 字符的消息里就是「完整调用 JSON 之后跟着一串
  // 重复的闭合标签噪声」）。半成品一样不是正文，按同一个判据扣住。
  const markerAt = partialProtocolAt(raw);
  if (markerAt >= base) return markerAt;
  return raw.length;
}

/**
 * 把网页回复解析成工具调用列表（同时原样返回归一化后的全文）。
 *
 * 宽容地接受调用围栏周围的散文——这正是围栏协议的意义——但每个围栏必须是一个
 * 合法的、点名了工具的单个 JSON 对象。识别四种围栏形状，让适配器不依赖网页模型
 * 偏爱哪一种：
 *   1) ```json … ``` 代码围栏（本桥的 webcode 协议）；
 *   2) `<tool_call> … </tool_call>`（也含 `<function>` / `<stories>`）标签围栏
 *      （opplean / web-agent 风格，DeepSeek 网页版倾向产出这个）；
 *   3) 裸 `<invoke name="…">` XML（含 `<parameter>` 与畸形属性两种形态）；
 *   4) `**Calling:** \`name\`` 的网页原生渲染。
 * 最后回落兼容形态：整条回复就是一个 `{"tool": ...}` 对象。
 *
 * **只看内容，不看标签名**：`<toolcall>`（无下划线）这类外壳与 `<tool_call>`
 * 同等对待——外壳叫什么不重要，里面是不是一个配平的、名字在工具表里的 JSON 才算数。
 *
 * @param {string} text 网页累积回复全文
 * @returns {{calls: Array<{name: string, arguments: object, purpose?: string}>, text: string}}
 */
export function parseAgentReply(text) {
  if (!text) return { calls: [], text: '', diagnostics: [] };
  let s = String(text);
  // 网页端流式噪声：DeepSeek 网页版偶发把协议标记输出成 <…> 的变形——
  // 竖线全角化成对出现（<tool_calls>，U+FF5C）、丢开头 <。归一化与流式
  // 边界探测（findProtocolStart）共用 normalizeDsml，两处不再各写一份正则。
  s = normalizeDsml(s);
  const calls = [];
  // 0.15.6：**丢弃不再是静默的**。旧实现里 takeObj 的 `catch { return; }` 把
  // 「看起来是调用、但解析不出来」和「这段本来就不是调用」压成同一个结果，
  // 于是一次丢调用在会话、在 UI、在日志里都不留痕——真机回归（参数含围栏的
  // write 调用被丢、报告从未落盘）就是这样躲过所有既有断言的。
  // 这里只记「形态像调用但解析失败」的那些（含 mcp_action / arguments / name 特征），
  // 普通散文代码块不进，避免把诊断刷成噪音。调用方按需透出（见 lib/index.js）。
  const diagnostics = [];
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
  /** 只对「形态像调用」的体留痕：普通散文代码块不记，诊断才不会刷成噪音。 */
  const looksLikeCall = (t) => /"mcp_action"\s*:/.test(t) || /"arguments"\s*:/.test(t);
  const takeObj = (body, tagged = false) => {
    const t = String(body ?? '').trim();
    if (!t.startsWith('{') || seen.has(t)) return;
    seen.add(t);
    let obj;
    try { obj = JSON.parse(t); } catch (e) {
      if (looksLikeCall(t)) {
        diagnostics.push(`unparsable call body (${String(e?.message || e).slice(0, 80)}): ${t.slice(0, 120)}`);
      }
      return;
    }
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
  // 0.15.6 真机缺陷修复：围栏体必须用**花括号/字符串转义感知**的定位器取，
  // 不能用非贪婪的 ``` 配对。
  //
  // 旧写法 `/```(?:json)?\s*\n?([\s\S]*?)```/gi` 在参数值自带围栏时（`write` 一份
  // 含代码块的 markdown 文档/报告——写文档的主路径，实测 108 例）会在**第一个
  // 内层 ```** 处截断体：JSON.parse 失败 → takeObj 静默 return → **调用消失，
  // 文件从未落盘，且没有任何日志**。A/B 实测（.tmp/probe-audit-regress.mjs）：
  // 0.15.3 与 0.15.5 对同一段都解析出 0 个调用，控制组（参数无围栏）两版都是 1 个。
  //
  // 现在沿用 readCallAt（与流式开块、readCallAt 去重同一个定位器）：它逐字符
  // 处理字符串内的 `\"` / `\\` 转义与花括号配平，参数值里的 ``` 不再是终止符。
  // 「什么算围栏体」至此**只有一份知识**——0.9.4 / 0.14.6 / 0.15.0 三次泄漏事故的
  // 共同教训就是两处形态知识一漂移就漏拦或漏解析。
  //
  // 与已删除的 regex 在**普通**围栏上的行为逐字相同：带 ```json 或无语言标记、
  // 体内是一个配平 JSON 对象 → 取它；体内不是 JSON（示例代码）→ 照旧跳过。
  let m;
  for (const at of fenceSpans(s).map((f) => f.open)) {
    const body = fenceCallBodyAt(s, at);
    if (!body || !body.jsonRaw) continue;
    takeObj(body.jsonRaw);
  }
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
    } catch (e) {
      // 同上：解释性文字与残缺 JSON 都不是可执行调用，但**形态像调用**的要留痕
      // ——`**Calling:**` 是网页原生渲染的调用形态，这里解析失败往往意味着真丢了。
      if (looksLikeCall(body)) {
        diagnostics.push(`unparsable Calling body (${String(e?.message || e).slice(0, 80)}): ${body.slice(0, 120)}`);
      }
    }
  }
  if (calls.length) return { calls, text: s, diagnostics };
  // legacy strict fallback: whole reply is one {"tool":...} object
  const trimmed = s.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    try {
      const obj = JSON.parse(trimmed);
      if (obj && typeof obj.tool === 'string') return { calls: [{ name: obj.tool, arguments: normArgs(obj.arguments ?? obj.args ?? {}) }], text: s, diagnostics };
    } catch { /* fallthrough */ }
  }
  return { calls: [], text: s, diagnostics };
}
