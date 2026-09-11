// offline-tool-loop.mjs — 离线验证「新会话里工具闭环能不能建立」。
//
// 用户反馈的原话是「有些工具用现在模型 dsh 里的 DeepSeek 没法执行，必须每个新开
// 对话验证」。这里把「新开对话」这条路径上**桥这一侧**的全部判据固定成回归：
// 用注入驱动模拟网页真实产出的五种工具调用形状，每一种都必须产出**可执行的**
// tool-call 块（名字 + 参数都对），另外覆盖参数形状纠偏与未知工具的处理。
//
// 它不能替代真机验证（网页 DOM/SSE 仍在桥之外），但它能证明「同一段网页回复，
// 桥不会再把它吃掉或变形」——这正是「工具调用失败」里属于桥的那一半。
import { apply } from '../lib/index.js';

const SHAPES = {
  '标准 <tool_call>': (name) => `<tool_call>{"mcp_action":"call","name":"${name}","arguments":{"command":"Get-Date"}}</tool_call>`,
  '全角 DSML': (name) => `\uff5cDSML\uff5c${name}\uff5e{"mcp_action":"call","name":"${name}","arguments":{"command":"Get-Date"}}`,
  '裸 invoke XML': (name) => `<invoke name="${name}"><parameter name="command">Get-Date</parameter></invoke>`,
  '```json 围栏': (name) => '```json\n{"mcp_action":"call","name":"' + name + '","arguments":{"command":"Get-Date"}}\n```',
  '**Calling:** 渲染': (name) => `**Calling:** \`${name}\`\n{"command":"Get-Date"}`,
};

const TOOL = { name: 'pwsh', description: 'run', parameters: { type: 'object', properties: { command: { type: 'string' } } } };
let pass = 0, fail = 0;
function check(label, ok, detail) {
  if (ok) { pass++; console.log('PASS', label); }
  else { fail++; console.log('FAIL', label, detail ?? ''); }
}

/** 建一个只回一段固定文本的桥实例，收集这一轮的全部 chunk。 */
async function runTurn({ reply, tools, sessionId, message = '看时间' }) {
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

for (const [label, make] of Object.entries(SHAPES)) {
  const reply = make('pwsh');
  const chunks = await runTurn({ reply, tools: [TOOL], sessionId: 's-' + label });
  const calls = chunks.filter(c => c.type === 'block-end' && c.block?.type === 'tool-call');
  check('新会话工具闭环 · ' + label,
    calls.length === 1 && calls[0].block.name === 'pwsh' && JSON.parse(calls[0].block.arguments).command === 'Get-Date'
      && chunks.at(-1).reason?.kind === 'tool-calls',
    JSON.stringify(calls.map(c => c.block)));
}

// 参数形状漂移：schema 要求 number，网页给字符串 —— 必须纠偏后才能交给 Harness
{
  const tool = { name: 'read', description: 'r', parameters: { type: 'object', properties: { offset: { type: 'number' }, limit: { type: 'number' } } } };
  const reply = '<tool_call>{"mcp_action":"call","name":"read","arguments":{"offset":"5","limit":"10"}}</tool_call>';
  const chunks = await runTurn({ reply, tools: [tool], sessionId: 's-coerce', message: '读' });
  const call = chunks.find(c => c.type === 'block-end' && c.block?.type === 'tool-call');
  const args = call ? JSON.parse(call.block.arguments) : {};
  check('参数纠偏 · 字符串 offset/limit 变成数字', args.offset === 5 && args.limit === 10, JSON.stringify(args));
}

// 未知工具：不得交给 Harness 执行，也不得让整轮失败
{
  const reply = '<tool_call>{"mcp_action":"call","name":"subagent","arguments":{}}</tool_call>';
  const chunks = await runTurn({ reply, tools: [TOOL], sessionId: 's-unknown', message: 'x' });
  const text = chunks.find(c => c.type === 'block-end' && c.block?.type === 'text')?.block?.text || '';
  const executed = chunks.some(c => c.type === 'block-end' && c.block?.type === 'tool-call');
  check('未知工具 · 不执行、回报可用清单、正常收束',
    !executed && /TOOL_UNKNOWN/.test(text) && /pwsh/.test(text) && chunks.at(-1).reason?.kind === 'stop',
    text.slice(0, 120));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
