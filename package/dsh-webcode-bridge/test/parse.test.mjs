// parse.test.mjs — parseAgentReply gate. Real DeepSeek web output shape
// (<tool_call> fences), legacy ```json fences, <function>, bare-object and the
// legacy {"tool":...} whole-reply fallback. Run: node test/parse.test.mjs
import { parseAgentReply, buildPreset, findProtocolStart, readCallAt, partialProtocolAt, normalizeOfficialToolCalls, coerceArguments } from '../lib/agent-preset.js';
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

// ---- 流式辅助函数：偏移定位 / 完整性判定 / 半成品标记 --------------------------
// 这三个函数共同决定「哪些文字算正文」。0.9.5 之前它们的错误直接表现为协议原文
// 漏进助手消息，或同一条流式里把同一个调用开成几十个块（=工具重复执行）。
const streamCases = [
  { name: 'findProtocolStart 偏移定位（半成品 <tool_cal 不算边界，完整标签才算）',
    run() {
      const a = '正文。<t';
      const b = '正文。<tool_call>{"name":"read"}';
      const r1 = findProtocolStart(a, 0);
      const r2 = findProtocolStart(b, 0);
      return r1.index === -1 && r2.index === 3 && r2.name === 'read' && r2.transport === true;
    } },
  { name: 'findProtocolStart 从偏移处继续找（不重复命中同一个边界）',
    run() {
      const s = '<tool_call>{"name":"read"}</tool_call>\n<tool_call>{"name":"pwsh"}';
      const first = findProtocolStart(s, 0);
      const second = findProtocolStart(s, first.index + 1);
      return first.index === 0 && second.index > first.index;
    } },
  { name: 'readCallAt 只在 JSON 配平时返回（流式分片不会提前开块）',
    run() {
      const partial = '<tool_call>{"mcp_action":"call","name":"read","arguments":{"path":';
      const whole = '<tool_call>{"mcp_action":"call","name":"read","arguments":{"path":"a.js"}}</tool_call>';
      return readCallAt(partial, 0) === null && readCallAt(whole, 0)?.raw.includes('"a.js"') === true;
    } },
  { name: 'partialProtocolAt 指出半成品标记起点（协议不得漏进正文）',
    run() {
      const s = '先并行读三处。\n<tool_cal';
      const at = partialProtocolAt(s);
      return at === s.indexOf('<tool_cal');
    } },
  { name: 'partialProtocolAt 对普通正文返回 -1（不误扣）',
    run() {
      return partialProtocolAt('这是一段普通回复，没有协议。') === -1
        && partialProtocolAt('compare a < b and c > d') === -1;
    } },
  { name: 'DSML 退役：normalizeOfficialToolCalls 逐字原样通过，findProtocolStart 仍认边界（0.16.23）',
    run() {
      const full = '正文\uFF5CDSML\uFF5Ctool_calls\uFF5E';
      const norm = normalizeOfficialToolCalls(full);
      return norm === full && findProtocolStart(full).index >= 0;
    } },
];
for (const c of streamCases) {
  let ok = false;
  try { ok = c.run() === true; } catch (e) { console.log('   threw', e.message); }
  if (ok) { pass++; console.log('PASS', c.name); } else { fail++; console.log('FAIL', c.name); }
}

// ---- 参数形状纠偏：真机 64 次工具报错全部属于这一类 ----------------------------
// 会话 5d08018b / 8e9c538a / 89775655 的原文报错：
//   "offset" must be a number; "limit" must be a number  (24 次)
//   "questions" must be an array                          (6 次)
//   "run_in_background" must be a boolean / "timeoutMs" must be a number
// 模型看不到 schema 里的类型约束有多硬，而 DSH 会严格拒绝。这些形状的正确值没有
// 歧义，按 schema 声明定向纠偏；没有声明类型或无法无歧义解析时一律不动。
const coerceCases = [
  { name: 'coerceArguments 数字字符串 → number/integer（真机 read 的 offset/limit）',
    run() {
      const schema = { type: 'object', properties: { offset: { type: 'integer' }, limit: { type: 'number' }, path: { type: 'string' } } };
      const r = coerceArguments({ offset: '10', limit: '25.5', path: 'a.js' }, schema);
      return r.args.offset === 10 && r.args.limit === 25.5 && r.args.path === 'a.js'
        && r.coerced.sort().join(',') === 'limit,offset';
    } },
  { name: 'coerceArguments 单对象 → 数组（真机 ask_user_question 的 questions）',
    run() {
      const schema = { type: 'object', properties: { questions: { type: 'array' } } };
      const one = { question: 'q', header: 'h' };
      const r = coerceArguments({ questions: one }, schema);
      return Array.isArray(r.args.questions) && r.args.questions.length === 1 && r.args.questions[0] === one;
    } },
  { name: 'coerceArguments 字符串布尔/数字 → boolean（真机 run_in_background / timeoutMs）',
    run() {
      const schema = { type: 'object', properties: { run_in_background: { type: 'boolean' }, timeoutMs: { type: 'number' } } };
      const r = coerceArguments({ run_in_background: 'false', timeoutMs: '30000' }, schema);
      return r.args.run_in_background === false && r.args.timeoutMs === 30000;
    } },
  { name: 'coerceArguments 不做猜测：无 schema 声明/不合法值/类型本来就对 → 原样保留',
    run() {
      const noSchema = coerceArguments({ offset: '10' }, undefined);
      const badNumber = coerceArguments({ offset: 'abc' }, { properties: { offset: { type: 'number' } } });
      const alreadyOk = coerceArguments({ offset: 10, flag: true }, { properties: { offset: { type: 'number' }, flag: { type: 'boolean' } } });
      const noType = coerceArguments({ x: '10' }, { properties: { x: {} } });
      return noSchema.args.offset === '10' && noSchema.coerced.length === 0
        && badNumber.args.offset === 'abc' && badNumber.coerced.length === 0
        && alreadyOk.coerced.length === 0
        && noType.args.x === '10' && noType.coerced.length === 0;
    } },
];
for (const c of coerceCases) {
  let ok = false;
  try { ok = c.run() === true; } catch (e) { console.log('   threw', e.message); }
  if (ok) { pass++; console.log('PASS', c.name); } else { fail++; console.log('FAIL', c.name); }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);