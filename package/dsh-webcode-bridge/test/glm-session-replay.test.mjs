// glm-session-replay.test.mjs — 用 2026-09-13 两份真机会话（cacaba8c/ab4c6dc8）
// 的真实形状做回放回归。那两份会话里 GLM-5.3 的失败分两层：
//   ① 正文标签形状被 chatglm.cn 原生工具层截胡（unknown tool call）→ 0.12.7 起
//      glm 站点只教 ```json 代码块（网页不碰代码块，桥能解析）；
//   ② 唯一存活到桥的调用（正文代码块裸 JSON）被 DSH 以
//      `invalid arguments: missing required property "description"` 拒绝
//      → 0.12.7 派发前按 schema 补齐 description（purpose 优先、命令前缀兜底）。
// pwsh 的 parameters 取自该会话 request/header 的真实 schema（command 的
// description 字段省略，不影响类型/required 判定）。
import { apply } from '../lib/index.js';
import { parseAgentReply, buildPreset, serializeFirstTurn, serializeDelta, trainNoteFor, fillMissingRequired } from '../lib/agent-preset.js';

// 官方 tool-call 模板的词间连接符（U+2581，0.16.18 教学/断言共用；源码不出现全角字符）。
const S = String.fromCharCode(0x2581);

// 会话 cacaba8c turn3 step1 的真实命令与真实 pwsh schema（截自 request/header）。
const REAL_COMMAND = 'Get-Location; Get-ChildItem -Force | Select-Object Mode,Length,Name | Format-Table -AutoSize';
const PWSH_SCHEMA = {
  type: 'object',
  properties: {
    command: { type: 'string' },
    description: { type: 'string', description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "Get-Process" → "List running processes".' },
  },
  required: ['command', 'description'],
};
const REAL_TOOLS = [{ name: 'pwsh', description: 'Execute a PowerShell command (`pwsh -Command`) and return its stdout/stderr.', parameters: PWSH_SCHEMA }];

// 会话里模型真实发出的正文形状：``` 裸围栏（无 json 标记）+ mcp_action JSON
// + 围栏后继续散文（模型在调用后面还在自言自语重试格式）。
const SESSION_REPLY_NO_PURPOSE = '```\n{"mcp_action":"call","name":"pwsh","arguments":{"command":"'
  + REAL_COMMAND + '"}}\n```\n\n系统要求使用格式 A（标签包裹）。让我重新尝试正确格式。';
const SESSION_REPLY_WITH_PURPOSE = '```\n{"mcp_action":"call","name":"pwsh","purpose":"查看当前工作目录与项目结构","arguments":{"command":"'
  + REAL_COMMAND + '"}}\n```\n\n系统要求使用格式 A（标签包裹）。让我重新尝试正确格式。';

let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('PASS', label); }
  else { fail++; console.log('FAIL', label, detail ?? ''); }
}

async function runTurn({ reply, tools, sessionId, message = '请你审查本地项目安全' } = {}) {
  let adapter;
  const driver = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => { opts.onDelta?.(reply); return { text: reply }; },
    sendPrompt: async () => ({ text: '' }),
  };
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      sessionId, model: 'deepseek:deepseek',
      messages: [{ role: 'user', content: [{ type: 'text', text: message }] }],
      tools,
    })) chunks.push(c);
    return chunks;
  } finally { await dispose(); }
}

// ---- ① 会话回放：唯一从网页存活到桥的形状必须解析成真调用 ----
{
  const { calls } = parseAgentReply(SESSION_REPLY_NO_PURPOSE);
  check('会话回放 · 正文代码块裸 JSON 解析成 pwsh 调用',
    calls.length === 1 && calls[0].name === 'pwsh' && calls[0].arguments.command === REAL_COMMAND,
    JSON.stringify(calls));
}
{
  const { calls } = parseAgentReply(SESSION_REPLY_WITH_PURPOSE);
  check('会话回放 · envelope 的 purpose 保留到调用对象',
    calls.length === 1 && calls[0].purpose === '查看当前工作目录与项目结构',
    JSON.stringify(calls));
}

// ---- ② 会话回放（端到端）：派发前的参数必须带上补齐的 description ----
{
  const chunks = await runTurn({ reply: SESSION_REPLY_NO_PURPOSE, tools: REAL_TOOLS, sessionId: 's-replay-fill' });
  const call = chunks.find(c => c.type === 'block-end' && c.block?.type === 'tool-call');
  const args = call ? JSON.parse(call.block.arguments) : {};
  check('会话回放 · 端到端补齐 description（命令前缀兜底）',
    call?.block.name === 'pwsh' && args.command === REAL_COMMAND
      && typeof args.description === 'string' && args.description.includes('Get-Location')
      && chunks.at(-1).reason?.kind === 'tool-calls',
    JSON.stringify(args));
}
{
  const chunks = await runTurn({ reply: SESSION_REPLY_WITH_PURPOSE, tools: REAL_TOOLS, sessionId: 's-refill-purpose' });
  const call = chunks.find(c => c.type === 'block-end' && c.block?.type === 'tool-call');
  const args = call ? JSON.parse(call.block.arguments) : {};
  check('会话回放 · 端到端补齐 description（purpose 优先）',
    args.description === '查看当前工作目录与项目结构',
    JSON.stringify(args));
}

// ---- ③ fillMissingRequired 单元边界 ----
{
  const a = fillMissingRequired({ command: REAL_COMMAND, description: 'List project files' }, PWSH_SCHEMA, '');
  check('补齐 · 已有 description 原样保留', a.filled.length === 0 && a.args.description === 'List project files', JSON.stringify(a));
  const b = fillMissingRequired({ command: 'hostname', description: '' }, PWSH_SCHEMA, '');
  check('补齐 · 空 description 视同缺失', b.filled.length === 1 && b.filled[0] === 'description' && b.args.description === 'hostname', JSON.stringify(b));
  const c = fillMissingRequired({ command: REAL_COMMAND }, PWSH_SCHEMA, 'purpose 原因');
  check('补齐 · purpose 优先于命令前缀', c.args.description === 'purpose 原因', JSON.stringify(c));
  const long = 'x'.repeat(300);
  const d = fillMissingRequired({ command: long }, PWSH_SCHEMA, '');
  check('补齐 · 派生值截到 120 字符', d.args.description.length === 120, String(d.args.description.length));
  const e = fillMissingRequired({}, { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] }, '');
  check('补齐 · 语义必填（file_path）绝不猜', e.filled.length === 0 && !('file_path' in e.args), JSON.stringify(e));
  const f = fillMissingRequired({ command: 'pwd' }, PWSH_SCHEMA, undefined);
  check('补齐 · 无 purpose 时从第一个字符串参数派生', f.args.description === 'pwd', JSON.stringify(f));
}

// ---- ④ glm 站点教学立场（与 deepseek 逐字对照）----
{
  const glm = buildPreset({ tools: REAL_TOOLS, siteId: 'glm' });
  check('glm preset · 只教代码块形状并警告标签会被拦截',
    glm.includes('```json 代码块，唯一可用') && glm.includes('警告：不要使用 <tool_call>') && glm.includes('unknown tool call'),
    glm.slice(0, 200));
  check('glm preset · 不再推荐标签格式 A', !glm.includes('格式 A（推荐，以标签包裹）'));
  check('glm preset · 点名 required 约束', glm.includes('required 列出的每一个字段') && glm.includes('不能替代任何必填参数'));
  // deepseek 默认（siteId 缺省）0.16.18 起教**官方训练模板**（`<｜tool▁calls▁begin｜>`
  // 家族：模型被训练时见过的形状；逐字依据见 lib/agent-preset.js OFFICIAL_BAR 注释）。
  // 0.16.2–0.16.17 教的 DSML 保留为解析备案（normalizeDsml 继续认）、不再教。
  // 必须显式传 siteId：不传等于「未知站点」，走的是通用双形状分支。
  // 真机路径上 index.js 会带上当前站点，因此这里要测的是带 siteId 的那一支。
  const S = String.fromCharCode(0x2581);
  const ds = buildPreset({ tools: REAL_TOOLS, siteId: 'deepseek' });
  check('deepseek preset · 教官方 tool-call 模板',
    ds.includes('官方工具调用格式') && ds.includes('tool' + S + 'calls' + S + 'begin')
      && ds.includes('无参数的工具 arguments 写 {}'),
    ds.slice(0, 200));
  check('deepseek preset · 不再教被证伪的标签形状',
    !ds.includes('格式 A（推荐，以标签包裹）'));
  check('deepseek preset · 同样点名 required 约束', ds.includes('required 列出的每一个字段'));
}
{
  const glmTurn = serializeFirstTurn({ tools: REAL_TOOLS, siteId: 'glm', messages: [{ role: 'user', content: [{ type: 'text', text: '看时间' }] }] });
  check('glm transport · 只教代码块并明说标签会被吃',
    glmTurn.includes('必须使用 ```json 代码块发起工具调用') && glmTurn.includes('不要使用 <tool_call> 等标签包裹'),
    glmTurn.slice(-400));
  const dsTurn = serializeFirstTurn({ tools: REAL_TOOLS, siteId: 'deepseek', messages: [{ role: 'user', content: [{ type: 'text', text: '看时间' }] }] });
  check('deepseek transport · 教官方 tool-call 模板',
    dsTurn.includes('用官方工具调用格式（DeepSeek 原生模板）发起工具调用')
      && dsTurn.includes('tool' + S + 'calls' + S + 'begin'));
}
{
  check('trainNote · 按站点取立场',
    trainNoteFor('glm').includes('```json') && trainNoteFor('glm').includes('不要用 <tool_call> 等标签包裹')
      && trainNoteFor('deepseek').includes('请保持工具调用的官方格式')
      && trainNoteFor('deepseek').includes('tool' + S + 'call' + S + 'begin'),
    JSON.stringify([trainNoteFor('glm'), trainNoteFor('deepseek')]));
  const delta = serializeDelta([{ role: 'tool', name: 'pwsh', tool_call_id: 't1', content: 'ok' }], 0, 4, null, trainNoteFor('glm'));
  check('trainNote · 增量轮 system_note 用 glm 立场', delta.text.includes('先写一行 ```json') && !delta.text.includes('以 <tool_call> 开始'), delta.text);
}

console.log(`\n${fail === 0 ? 'ALL PASS' : 'FAILED'}: ${pass} passed, ${fail} failed`);
process.exitCode = fail === 0 ? 0 : 1;
