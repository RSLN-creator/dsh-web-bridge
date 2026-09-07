// parse.test.mjs — parseAgentReply gate. Real DeepSeek web output shape
// (<tool_call> fences), legacy ```json fences, <function>, bare-object and the
// legacy {"tool":...} whole-reply fallback. Run: node test/parse.test.mjs
import { parseAgentReply, buildPreset } from '../lib/agent-preset.js';
// DeepSeek 网页版与 OpenAI 一样常把 arguments 输出为转义 JSON 字符串；
// 用 JSON.stringify 构造真实围栏，保证转义与真实模型输出一致。
const strArgsFence = (name, args, opt = {}) => JSON.stringify({ mcp_action: 'call', name, purpose: 'x', arguments: JSON.stringify(args), ...opt });

const cases = [
  { name: 'real web reply: <tool_call> fence (probe capture)',
    text: '<tool_call>\n{"mcp_action": "call", "name": "pwsh", "purpose": "获取当前主机名称", "arguments": {"command": "hostname"}}\n</tool_call>',
    expect: ['pwsh'] },
  { name: 'prose + three <tool_call> fences (real DSH turn)',
    text: ['先确定工作目录再看文件。',
      '<tool_call>{"mcp_action":"call","name":"pwsh","purpose":"cd","arguments":{"command":"pwd"}}</tool_call>',
      '<tool_call>{"mcp_action":"call","name":"read","purpose":"readme","arguments":{"file_path":"README.md"}}</tool_call>',
      '<tool_call>{"mcp_action":"call","name":"glob","purpose":"list","arguments":{"pattern":"**/*"}}</tool_call>'].join('\n'),
    expect: ['pwsh', 'read', 'glob'] },
  { name: 'legacy ```json code fence',
    text: '正文\n```json\n{"mcp_action":"call","name":"bash","purpose":"x","arguments":{"c":"ls"}}\n```\n尾巴',
    expect: ['bash'] },
  { name: '<function> fence, no mcp_action (name+arguments)',
    text: '稍等\n<function>{"name":"edit","arguments":{"f":"a.js","s":"x"}}</function>\n完成',
    expect: ['edit'] },
  { name: 'bare {"mcp_action":"call",...} object embedded in prose',
    text: '我来确认。\n{"mcp_action":"call","name":"read","purpose":"读","arguments":{"file_path":"a"}}',
    expect: ['read'] },
  { name: 'plain text reply, no calls',
    text: '这是一个普通回复，不需要工具。',
    expect: [] },
  { name: 'legacy whole-reply {"tool":...}',
    text: '{"tool":"read","arguments":{"file_path":"x"}}',
    expect: ['read'] },
  { name: '<tool_call> fence with STRING arguments (real web shape)',
    text: `<tool_call>\n${strArgsFence('pwsh', { command: 'hostname' })}\n</tool_call>`,
    expect: ['pwsh'], args: { command: 'hostname' } },
  { name: '```json fence with STRING arguments',
    text: `\`\`\`json\n${strArgsFence('pwsh', { command: 'pwd' })}\n\`\`\``,
    expect: ['pwsh'], args: { command: 'pwd' } },
  { name: '**Calling:** with STRING-arguments JSON body',
    text: `**Calling:** \`read\`\n{"file_path":"PLAN.md"}`,
    expect: ['read'], args: { file_path: 'PLAN.md' } },
  { name: '**Calling:** with escaped-STRING arguments body',
    text: `**Calling:** \`pwsh\`\n${JSON.stringify('{"command":"Get-ChildItem"}')}`,
    expect: ['pwsh'], args: { command: 'Get-ChildItem' } },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const { calls } = parseAgentReply(c.text);
  const got = calls.map((x) => x.name);
  const ok = JSON.stringify(got) === JSON.stringify(c.expect);
  let argsOk = true;
  if (c.args !== undefined) {
    argsOk = calls.length > 0 && JSON.stringify(calls[0].arguments) === JSON.stringify(c.args);
    if (!argsOk) console.log('   args got ', JSON.stringify(calls[0]?.arguments), 'expected', JSON.stringify(c.args));
  }
  if (ok && argsOk) { pass++; console.log('PASS', c.name, '->', got.join(', ') || '(none)'); }
  else if (!ok) { fail++; console.log('FAIL', c.name, 'expected', JSON.stringify(c.expect), 'got', JSON.stringify(got)); }
  else { fail++; console.log('FAIL', c.name, 'arguments mismatch'); }
}
// preset must teach the <tool_call> fence this parser accepts
const preset = buildPreset({ tools: [{ name: 'pwsh', description: 'PowerShell', parameters: {} }] });
if (!preset.includes('<tool_call>')) { fail++; console.log('FAIL preset teaches <tool_call>'); } else { pass++; console.log('PASS preset teaches <tool_call>'); }
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);