// nameless-call.test.mjs — 缺 `name` 字段的工具调用必须被**参数形状**还原出来（0.15.9）。
//
// ## 用户可见症状（用户原话）
//
// > 「现在返回 web 的内容会在 harness 端显示异常/显示不了？有些可以有些不行？」
//
// 「有些可以」= 同一个会话里带 `name` 的调用一直正常；「有些不行」= 不带 `name`
// 的那些**整条消失**，界面上只剩散文或干脆一条空消息。
//
// ## 真机留痕（唯一证据来源，逐字落成 test/fixtures/）
//
// 会话 `session-07907f7c`（DeepSeek 网页模型，2026-09-16 15:33）→ 网页会话
// `49ab6330-0fbd-4842-a7b7-e9ce5d57031b`。取法：
//
//   POST http://127.0.0.1:8931/__webcode/history {"sessionId":"49ab6330-…"}
//
// 网页实际发出的助手正文（`test/fixtures/nameless-*.txt`，未手抄、未补字段）：
//
//   id=20  <tool_call>{"mcp_action":"call","purpose":"…","arguments":{pattern,path}}
//          <tool_call>{"mcp_action":"call","purpose":"…","arguments":{command,description}}
//          ← 两个调用**都没有 name**
//   id=24  「Let me verify the actual file state…」+ 同上两个无名调用
//   id=26  {"mcp_action":"call","name":"read",…}      ← 带 name，正常执行（对照组）
//   id=30  {"mcp_action":"call","purpose":"…","arguments":{file_path,offset,limit}}
//
// harness 侧同一时刻的读数（`node scripts/session-read.mjs 07907f7c`）：
//   turn 4 step 1  assistant = reasoning(739) + text(59)   ← 只有散文，调用没了
//   turn 4 结束 reason=completed                            ← agent loop 认为「无事完成」
//   之后 4 个 turn 模型反复说「my tool calls didn't get results」——它**以为**自己调了。
//
// ## 根因
//
// `parseAgentReply` 的 `takeObj` 对 `mcp_action:"call"` 只认「JSON 能解析 + 有 name」：
//
//   const isCall = fenceCall ? (typeof obj.name === 'string' && obj.name.trim()) : …;
//   if (!isCall) return;            ← JSON 合法、只是没写 name ⇒ **静默丢**
//
// 它不进 `diagnostics`（那条路只在 JSON.parse 失败时走），所以日志里也什么都没有。
// 随之 `proseSafeEnd` 把协议整段扣住 → 只剩散文外发；若正文全是协议，则整轮
// 走到 `zeroProgressDecision` 的 thinking-only / protocol-withheld 分支
// （前者发一条「网页只产出了思考内容」的提示——**与事实相反**：网页明明发了调用）。
//
// ## 修法（本文件锁的就是它）
//
//   1) `inferToolNameFromArgs(args, tools)`：按**工具表**反推名字。三条判据缺一不可——
//      提供的每个键都必须由该工具声明；必填必须齐（`description` 可按既有白名单代填）；
//      候选必须**唯一**，不唯一就不猜。
//   2) `parseAgentReply(text, { tools })` 用上它；猜不出时**必须留 diagnostics**
//      （「不再有静默丢弃」是 0.15.6 立下的规矩，本条过去是它的漏网）。
//   3) `lib/index.js` 把 tools 传进来，并在「探测到协议但解析不出可执行调用」时
//      发一条可行动的提示，而不是只发散文或空消息。
//
// ## 反向验证纪律（doc/comment-style.md §9.3）
//
// ①②③⑤⑦⑫ 在修复前必须**红**（本文件的真机夹具在旧代码上 `calls=0`）；
// ④⑥⑧⑨⑩ 是**反向安全线**：不得为了救无名调用而改写带名字的调用、
// 不得在证据不足时瞎猜、不得把散文里的 JSON 示例当调用。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../lib/index.js';
import { parseAgentReply, proseSafeEnd, inferToolNameFromArgs } from '../lib/agent-preset.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (n) => fs.readFileSync(path.join(here, 'fixtures', n), 'utf8');

/**
 * 本会话的工具表（形状取自真机 request 里的 tools[]，与 DSH 实际下发的一致）。
 * 判据只依赖 `name` + `parameters.properties` + `parameters.required`。
 */
const TOOLS = [
  { name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } }, required: ['file_path'] } },
  { name: 'grep', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' }, include: { type: 'string' } }, required: ['pattern'] } },
  { name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command', 'description'] } },
  { name: 'web_search', parameters: { type: 'object', properties: { queries: { type: 'array' } }, required: ['queries'] } },
  { name: 'edit', parameters: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
  { name: 'write', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } }, required: ['file_path', 'content'] } },
];

// ---- 真机样本 ---------------------------------------------------------------

test('① 真机 id=20：两个无名调用按参数形状还原成 grep + pwsh', () => {
  const text = fixture('nameless-two-calls.txt');
  const { calls, diagnostics } = parseAgentReply(text, { tools: TOOLS });
  assert.equal(calls.length, 2, '两个调用都必须被还原（旧代码这里是 0）');
  assert.deepEqual(calls.map((c) => c.name), ['grep', 'pwsh']);
  assert.equal(calls[0].arguments.pattern, '\\bREF\\b|\\bREADME\\b');
  assert.ok(String(calls[0].arguments.path).endsWith('gen-reference-index.mjs'));
  assert.ok(String(calls[1].arguments.command).includes('--check'), '参数体必须逐字保留');
  assert.equal(calls[1].arguments.description, 'Run reference index check after fix');
  assert.ok(diagnostics.length >= 1, '还原必须留痕（不再有静默修复）');
});

test('② 真机 id=24：散文保留、协议被扣住，两个调用仍被还原', () => {
  const text = fixture('nameless-after-prose.txt');
  const safe = proseSafeEnd(text, 0);
  assert.equal(text.slice(0, safe).trim(), 'Let me verify the actual file state and re-run the check.');
  const { calls } = parseAgentReply(text, { tools: TOOLS });
  assert.deepEqual(calls.map((c) => c.name), ['read', 'pwsh']);
  assert.equal(calls[0].arguments.offset, 104);
  assert.equal(calls[0].arguments.limit, 100);
});

test('③ 真机 id=30：无名 read 的 offset/limit 不得丢', () => {
  const { calls } = parseAgentReply(fixture('nameless-read.txt'), { tools: TOOLS });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read');
  assert.equal(calls[0].arguments.offset, 176);
  assert.equal(calls[0].arguments.limit, 60);
});

test('④ 反向安全线：真机 id=26（带 name）不被推断改写', () => {
  const { calls } = parseAgentReply(fixture('named-control.txt'), { tools: TOOLS });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read');
  assert.equal(calls[0].arguments.offset, 104);
});

// ---- 推断器本身 -------------------------------------------------------------

test('⑤ 包装名（tool_call/function）按参数形状还原，不产生假工具名', () => {
  const text = '<tool_call>{"mcp_action":"call","name":"tool_call","purpose":"x","arguments":{"pattern":"foo","path":"a"}}</tool_call>';
  const { calls } = parseAgentReply(text, { tools: TOOLS });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'grep');
});

test('⑥ 反向安全线：证据不足时**不猜**，但必须留 diagnostics', () => {
  const text = '<tool_call>{"mcp_action":"call","purpose":"x","arguments":{}}</tool_call>';
  const { calls, diagnostics } = parseAgentReply(text, { tools: TOOLS });
  assert.equal(calls.length, 0, '空参数无法唯一判定工具，不许猜');
  assert.ok(diagnostics.length >= 1, '不许再静默丢弃（0.15.6 的规矩）');
  assert.ok(/name/.test(diagnostics.join(' ')), '诊断必须点明缺的是 name');
});

test('⑦ 单键 file_path 只可能是 read（edit/write 的必填没齐）', () => {
  const text = '<tool_call>{"mcp_action":"call","arguments":{"file_path":"a.md"}}</tool_call>';
  const { calls } = parseAgentReply(text, { tools: TOOLS });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read');
});

test('⑧ 反向安全线：参数键不在任何工具表里 ⇒ 不猜 + 留痕', () => {
  const text = '<tool_call>{"mcp_action":"call","arguments":{"totally_unknown_key":1}}</tool_call>';
  const { calls, diagnostics } = parseAgentReply(text, { tools: TOOLS });
  assert.equal(calls.length, 0);
  assert.ok(diagnostics.length >= 1);
});

test('⑨ 反向安全线：未知工具名原样保留，交给 TOOL_UNKNOWN 判定', () => {
  const text = '<tool_call>{"mcp_action":"call","name":"frobnicate","arguments":{"pattern":"x"}}</tool_call>';
  const { calls } = parseAgentReply(text, { tools: TOOLS });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'frobnicate', '推断不得覆盖模型写出的名字');
});

test('⑩ 反向安全线：散文里的普通 JSON 示例不是调用', () => {
  const text = '结论如下：\n\n```json\n{"a": 1, "b": [2, 3]}\n```\n\n完毕。';
  const { calls, diagnostics } = parseAgentReply(text, { tools: TOOLS });
  assert.equal(calls.length, 0);
  assert.equal(diagnostics.length, 0, '普通代码块不进诊断，避免噪音');
});

test('⑪ 推断器单独契约：唯一候选才返回名字', () => {
  assert.equal(inferToolNameFromArgs({ pattern: 'x', path: 'y' }, TOOLS), 'grep');
  assert.equal(inferToolNameFromArgs({ command: 'x' }, TOOLS), 'pwsh', 'description 可按白名单代填');
  assert.equal(inferToolNameFromArgs({ file_path: 'x', content: 'y' }, TOOLS), 'write');
  assert.equal(inferToolNameFromArgs({ file_path: 'x' }, TOOLS), 'read');
  assert.equal(inferToolNameFromArgs({ nope: 1 }, TOOLS), null);
  assert.equal(inferToolNameFromArgs({}, TOOLS), null);
  assert.equal(inferToolNameFromArgs(null, TOOLS), null);
  assert.equal(inferToolNameFromArgs({ pattern: 'x' }, []), null, '没有工具表就不猜');
});

test('⑪a 剩下两条早退分支也必须留痕（不许再有静默丢弃）', () => {
  // 围栏体：有 arguments、既没有 mcp_action 也没有 name ⇒ 不认，但必须留痕
  const noMarker = parseAgentReply('```json\n{"arguments":{"pattern":"x"}}\n```', { tools: TOOLS });
  assert.equal(noMarker.calls.length, 0);
  assert.ok(noMarker.diagnostics.length >= 1, '早退必须留痕——这正是 #23 的教训');
  // 非围栏体：name 在，arguments 是一坨解析不了的字符串 ⇒ 仍按旧语义派发空参数
  //（由 DSH 报必填错、模型据此改正），但参数「没了」这件事必须留痕
  const badArgs = parseAgentReply('<tool_call>{"name":"read","arguments":"not-json"}</tool_call>', { tools: TOOLS });
  assert.equal(badArgs.calls.length, 1, '旧语义不变：调用照发，错误由 DSH 报');
  assert.deepEqual(badArgs.calls[0].arguments, {});
  assert.ok(badArgs.diagnostics.length >= 1, '参数归一化失败必须留痕');
});

// ---- 接线（0.15.6 的教训：判据对了但没接上，等于没修）-------------------------

test('⑫ 接线：index.js 的两处 parseAgentReply 都必须带上 tools', () => {
  const src = fs.readFileSync(path.join(here, '..', 'lib', 'index.js'), 'utf8');
  assert.match(src, /parseAgentReply\(\s*finalText\s*,\s*\{\s*tools\s*\}\s*\)/, '正文解析必须传工具表');
  assert.match(src, /parseAgentReply\(\s*thinkAcc\s*,\s*\{\s*tools\s*\}\s*\)/, '思考兜底解析同样要传');
});

// ---- 端到端：网页发无名调用时，harness 必须收到工具调用块 ---------------------

/** 起一个最小适配器，驱动按给定文本作答。 */
async function runTurn({ text, thinking = '' }) {
  let adapter;
  const driver = {
    status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
    sendTurn: async (key, prompt, opts) => {
      if (thinking) opts.onThink?.(thinking);
      opts.onDelta?.(text);
      return { text, ...(thinking ? { thinking } : {}) };
    },
    sendPrompt: async () => ({ text }),
  };
  const dispose = apply({ llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null }, { port: 0, requireConsent: false, driver });
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      sessionId: 'nameless-' + Math.random().toString(36).slice(2),
      model: 'deepseek:deepseek',
      tools: TOOLS,
      messages: [{ role: 'user', content: [{ type: 'text', text: '继续' }] }],
    })) chunks.push(c);
    return chunks;
  } finally { await dispose(); }
}

test('⑬ 端到端：真机无名调用必须变成 harness 可见的两个工具调用块', async () => {
  const chunks = await runTurn({ text: fixture('nameless-after-prose.txt'), thinking: 'planning' });
  const calls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').map((c) => c.block.name);
  assert.deepEqual(calls, ['read', 'pwsh'], '旧代码这里一个块都不开：界面上只剩散文，任务停摆');
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.ok(text.includes('Let me verify the actual file state'), '散文照常显示');
  assert.ok(!text.includes('mcp_action'), '协议原文不得进正文');
});

test('⑭ 端到端：解析不出调用时给出可行动提示，且不得声称「只有思考」', async () => {
  const nameless = '<tool_call>\n{"mcp_action":"call","purpose":"x","arguments":{"totally_unknown_key":1}}\n</tool_call>';
  const chunks = await runTurn({ text: nameless, thinking: 'I will call a tool' });
  const text = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
  assert.match(text, /TOOL_CALL_UNPARSED/, '必须告诉会话「调用没被解析出来」，否则模型只会反复重试');
  assert.ok(!/只产出了思考内容/.test(text), '事实是「发了调用但解析不了」，不能反过来说网页只思考');
  assert.ok(/grep|read|pwsh/.test(text), '提示里要给出本会话可用工具，模型才能改正');
});
