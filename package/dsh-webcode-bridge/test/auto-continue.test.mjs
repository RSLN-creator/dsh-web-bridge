// auto-continue.test.mjs — 0.16.25 护栏：解析失败自动续跑（无人值守存活，UNPARSED 收尾前的自动补发）。
//
// 真机取证（session cd997dd3，2026-09-19 19:2x，reply-log 逐字）：官方格式漂移——
// 参数对象闭合后多挂 `,{"replace_all":false}` 第二对象——同一形状连续三轮 UNPARSED，
// 桥把再教学提示交回会话后 agent 循环把「纯文本轮」当最终答案收场，两次都是
// **用户手动**打「继续，注意工具的调用」才救活（会话 jsonl 11:21:26 / 11:22:51）。
// 0.16.25 把手动续跑自动化：UNPARSED 收尾前把提示**作为用户消息补发进同一网页
// 会话**收第二轮；第二轮解析出可执行调用就照常派发（finish=tool-calls，循环存活）。
// 红线：解析宽容度不变（第二对象照旧拒收），只续跑、不代拼。

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { parseAgentReply, transportNoteFor, serializeFirstTurn } from '../lib/agent-preset.js';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
// 官方模板 token（与 lib/agent-preset.js 的 OFFICIAL_TOKEN 同一码位拼法）。
const B = String.fromCharCode(0xFF5C);
const S = String.fromCharCode(0x2581);
const official = (name, args) => `<${B}tool${S}calls${S}begin${B}>\n<${B}tool${S}call${S}begin${B}>${name}<${B}tool${S}sep${B}>${args}<${B}tool${S}call${S}end${B}>\n<${B}tool${S}calls${S}end${B}>`;

// 真机病灶逐字形状（cd997dd3，reply-log 11:22:33 那类的最小化）：主对象合法、
// 闭合后多挂第二个对象。jsonObjectIn 首个 { 到末个 } 切段 → parse 必败。
const BAD = official('edit', '{"file_path":"D:/x.js","old_string":"a","new_string":"b"},{"replace_all":false}');
// 同一调用的合规形状（续跑轮模型重发的样子）。
const GOOD = official('edit', '{"file_path":"D:/x.js","old_string":"a","new_string":"b"}');

const TOOLS = [
  {
    name: 'edit',
    description: '改文件',
    parameters: {
      type: 'object',
      properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },
];

function harness(sendTurnImpl, extraConfig = {}) {
  let adapter;
  const dispose = apply(
    { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null },
    {
      port: 0, requireConsent: false,
      driver: {
        status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
        sendTurn: sendTurnImpl,
        sendPrompt: async (prompt, opts) => sendTurnImpl('main', prompt, opts),
      },
      ...extraConfig,
    },
  );
  const collect = async (options) => {
    const chunks = [];
    for await (const c of adapter.stream(options)) chunks.push(c);
    return chunks;
  };
  return { collect, dispose };
}

test('纯函数：第二对象形状解析为 0 调用，并留下「对象闭合后追加了多余内容」诊断', () => {
  const { calls, diagnostics } = parseAgentReply(BAD, { tools: TOOLS });
  assert.deepEqual(calls, [], '第二对象必须照旧拒收（解析宽容度不放宽）');
  assert.ok(diagnostics.some((d) => /trailing content after the first JSON object/.test(d)), JSON.stringify(diagnostics));
  assert.ok(diagnostics.some((d) => /replace_all/.test(d)), '诊断要点名残余内容本身');
});

test('纯函数：同一调用去掉尾挂对象后照常解析（只有畸形才留诊断）', () => {
  const { calls, diagnostics } = parseAgentReply(GOOD, { tools: TOOLS });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'edit');
  assert.deepEqual(diagnostics, []);
});

test('端到端（无正文出口）：UNPARSED 后自动补发提醒，第二轮调用被派发，finish=tool-calls', async () => {
  const prompts = [];
  const { collect, dispose } = harness(async (key, prompt, opts) => {
    prompts.push(prompt);
    if (prompts.length === 1) { opts.onDelta?.(BAD); return { text: BAD }; }
    return { text: GOOD };
  });
  try {
    const chunks = await collect({
      sessionId: 'auto-cont-1', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('改文件')],
    });
    assert.equal(prompts.length, 2, '必须恰好补发一轮（上限 1，不递归）');
    assert.match(prompts[1], /TOOL_CALL_UNPARSED/, '补发的是再教学提示原文');
    assert.match(prompts[1], /自动续跑/, '补发必须带自动续跑指令');
    // 0.16.28：框架前置——真机（session-4f236a51）里模型会停下来「回应提醒」而不是
    // 「按提醒行动」，补发提示的开头必须先声明本条身份（系统提示、勿回应）。
    assert.match(prompts[1], /^\[桥·系统提示\]/, '补发提示必须以系统提示框架开头');
    assert.match(prompts[1], /不要回应、解释或复述/, '框架必须明确「勿回应」');
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    // 0.16.29（用户指令）：TOOL_CALL_UNPARSED 全文不进正文（只走补发通道）。
    assert.ok(!/TOOL_CALL_UNPARSED/.test(deltas),
      '再教学提示不得再铺进会话正文（0.16.29 用户指令「直接隐藏」）');
    assert.match(deltas, /AUTO_CONTINUED/, '必须如实说明这是自动续跑');
    const callEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
    assert.ok(callEnd, '续跑轮的调用必须派发（循环存活）');
    assert.equal(callEnd.block.name, 'edit');
    assert.ok(!callEnd.block.arguments.includes('replace_all'), '第二对象不得混进参数');
    assert.equal(chunks.at(-1).type, 'finish');
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls', 'finish 必须是 tool-calls，让 agent 循环继续');
  } finally { await dispose(); }
});

test('端到端（带正文出口）：续跑轮无调用时其散文按最终答复收场（finish=stop）', async () => {
  const prompts = [];
  const { collect, dispose } = harness(async (key, prompt, opts) => {
    prompts.push(prompt);
    if (prompts.length === 1) { opts.onDelta?.(`先改。\n${BAD}`); return { text: `先改。\n${BAD}` }; }
    return { text: '任务其实已经完成，无需更多工具。' };
  });
  try {
    const chunks = await collect({
      sessionId: 'auto-cont-2', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('改文件')],
    });
    assert.equal(prompts.length, 2);
    assert.ok(!chunks.some((c) => c.type === 'block-end' && c.block?.type === 'tool-call'), '续跑轮没有调用就不得派发');
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.ok(!/TOOL_CALL_UNPARSED/.test(deltas), '0.16.29：提示不进正文');
    assert.match(deltas, /AUTO_CONTINUED/, '0.16.29：只留进度说明');
    assert.match(deltas, /任务其实已经完成/, '续跑轮的散文必须交回会话');
    assert.equal(chunks.at(-1).type, 'finish');
    assert.equal(chunks.at(-1).reason.kind, 'stop');
  } finally { await dispose(); }
});

test('端到端：无状态轮不自动续跑（循环语义归调用方）', async () => {
  let n = 0;
  const { collect, dispose } = harness(async (key, prompt, opts) => {
    n += 1;
    opts.onDelta?.(BAD);
    return { text: BAD };
  });
  try {
    const chunks = await collect({
      model: 'deepseek:deepseek', tools: TOOLS, messages: [user('改文件')],
    });
    assert.equal(n, 1, '无 sessionId（无状态轮）不得补发第二轮');
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.match(deltas, /TOOL_CALL_UNPARSED/);
  } finally { await dispose(); }
});

test('端到端：autoContinueRounds=0 时关闭续跑，行为与 0.16.24 逐字一致', async () => {
  let n = 0;
  const { collect, dispose } = harness(async (key, prompt, opts) => {
    n += 1;
    opts.onDelta?.(BAD);
    return { text: BAD };
  }, { autoContinueRounds: 0 });
  try {
    const chunks = await collect({
      sessionId: 'auto-cont-off', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('改文件')],
    });
    assert.equal(n, 1);
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.match(deltas, /TOOL_CALL_UNPARSED/);
  } finally { await dispose(); }
});

test('端到端：补发的提醒必须带**该站点**的协议段（与首轮教学同一份文本）', async () => {
  // 用户要求（原话）：「0.16.25 解析失败自动续跑——请你把这个的文本变为：
  // [本地工具传输协议] 必须使用 <tool_call>{…}</tool_call> 发起工具调用…」
  //
  // 落地方式是**按站点复用**（用户随后确认：「到时候每个站点按照自己的协议写好适配，
  // 这个是只给 deepseek 的，按站点复用没问题」）。因此这条钉两件事：
  //   ① 补发的第二轮里确实带了完整协议段（不是只有一句「请重发」）；
  //   ② 带的是**该站点**那一份——deepseek 拿官方模板、glm 拿代码块、其余拿标签形状。
  // 若续跑处写死某一份（或干脆不加协议段），就会与首轮教学分叉。
  //
  // 这里只跑 deepseek：非 deepseek 站点走的是 index.js 为每个站点**另建的**
  // browser driver（本 harness 只注入 deepseek 那个桩），真去跑 glm 会启动一个
  // 真实无头浏览器。其余站点的立场由下面那条纯函数护栏覆盖。
  const prompts = [];
  const { collect, dispose } = harness(async (key, prompt, opts) => {
    prompts.push(prompt);
    if (prompts.length === 1) { opts.onDelta?.(BAD); return { text: BAD }; }
    return { text: GOOD };
  });
  try {
    await collect({ sessionId: 'auto-site-deepseek', model: 'deepseek:deepseek', tools: TOOLS, messages: [user('改文件')] });
    assert.equal(prompts.length, 2, 'deepseek：必须补发一轮');
    assert.match(prompts[1], /\[本地工具传输协议\]/, '补发的提醒必须带协议段');
    assert.match(prompts[1], /官方工具调用格式/, 'deepseek 的协议段必须是官方模板立场');
    assert.ok(!/必须使用 <tool_call>\{"mcp_action":"call"/.test(prompts[1]),
      '补发里混进了标签形状教学（与 deepseek 首轮立场冲突）');
  } finally { await dispose(); }
});

test('纯函数：transportNoteFor 按站点给出三套互斥立场，且与首轮教学同源', () => {
  // 续跑段调用的就是这个函数（index.js 的 autoContinueRound）。把它单独钉住，
  // 是因为非 deepseek 站点无法用上面那条端到端用例覆盖（它们各有真实 driver）。
  const T = [{ name: 'edit', description: '改文件', parameters: { type: 'object' } }];
  const ds = transportNoteFor('deepseek', T);
  const glm = transportNoteFor('glm', T);
  const other = transportNoteFor('kimi', T);
  assert.match(ds, /官方工具调用格式/);
  assert.match(glm, /```json 代码块/);
  assert.match(other, /<tool_call>\{"mcp_action":"call"/);
  // 三套必须互不相同：否则「按站点复用」就是一句空话。
  assert.notEqual(ds, glm); assert.notEqual(ds, other); assert.notEqual(glm, other);
  // 与首轮**逐字同源**：这正是抽取它的理由（两处文案不可能再分叉）。
  assert.equal(ds, transportNoteFor('deepseek', T));
  assert.ok(serializeFirstTurn({ messages: [], tools: T, siteId: 'deepseek' }).includes(ds));
  assert.ok(serializeFirstTurn({ messages: [], tools: T, siteId: 'glm' }).includes(glm));
  assert.ok(serializeFirstTurn({ messages: [], tools: T }).includes(other));
  // 无工具时不教协议（不能让模型去调不存在的工具）。
  assert.equal(transportNoteFor('deepseek', []), '');
  assert.equal(transportNoteFor('glm', null), '');
  // 未知站点按默认立场，不得抛错。
  assert.equal(transportNoteFor('no-such-site', T), other);
});

test('端到端：UNPARSED 提示必须点名「单个 JSON 对象」教学点（0.16.25 文案）', async () => {
  const { collect, dispose } = harness(async (key, prompt, opts) => {
    opts.onDelta?.(BAD);
    return { text: BAD };
  }, { autoContinueRounds: 0 });
  try {
    const chunks = await collect({
      sessionId: 'auto-cont-copy', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('改文件')],
    });
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.match(deltas, /单个完整 JSON 对象/);
    assert.match(deltas, /解析诊断/, '解析诊断必须随提示透出');
  } finally { await dispose(); }
});

// ---- 0.16.26/0.16.27：另外两处「文本告知即断链」出口 -------------------------
//
// 与 UNPARSED 同一种病：桥交回一条纯文本提示，旧实现 finish='stop' ⇒ agent 循环
// 当最终答案收场，模型没有下一次机会改。真机 session-181c23b1（2026-09-19
// 15:17:46，reply-log chars=0 | calls=0）就是 thinking-only 那一支。
// 下面两条按**行为**钉住（不是源码文本断言）：续跑必须真的发生、调用必须真的派发。

// 调了本会话不存在的工具名（TOOL_UNKNOWN 的触发形状）。
const UNKNOWN = official('write_file', '{"file_path":"D:/x.js"}');

test('端到端：TOOL_UNKNOWN 后自动续跑，第二轮按真实工具名重发（finish=tool-calls）', async () => {
  const prompts = [];
  const { collect, dispose } = harness(async (key, prompt, opts) => {
    prompts.push(prompt);
    if (prompts.length === 1) { opts.onDelta?.(UNKNOWN); return { text: UNKNOWN }; }
    return { text: GOOD };
  });
  try {
    const chunks = await collect({
      sessionId: 'auto-unknown-1', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('改文件')],
    });
    assert.equal(prompts.length, 2, '必须补发一轮');
    assert.match(prompts[1], /TOOL_UNKNOWN/, '补发的是 TOOL_UNKNOWN 再教学提示');
    assert.match(prompts[1], /自动续跑/, '补发必须带自动续跑指令');
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    // 0.16.29（用户指令）：再教学提示全文只走补发通道，不进正文。
    assert.ok(!/TOOL_UNKNOWN:/.test(deltas), '0.16.29：TOOL_UNKNOWN 提示不再铺进正文');
    assert.match(deltas, /AUTO_CONTINUED/, '必须如实说明这是自动续跑');
    const callEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
    assert.ok(callEnd, '续跑轮的调用必须派发（循环存活）');
    assert.equal(callEnd.block.name, 'edit');
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls', 'finish 必须是 tool-calls，让 agent 循环继续');
  } finally { await dispose(); }
});

test('端到端：thinking-only 后自动续跑，不再断链（finish=tool-calls）', async () => {
  const prompts = [];
  const { collect, dispose } = harness(async (key, prompt, opts) => {
    prompts.push(prompt);
    // 第一轮：只出思考、正文一个字符都没有（partial-wip-settled 截断的形状）。
    if (prompts.length === 1) { opts.onThink?.('我在想这个文件该怎么改……'); return { text: '' }; }
    return { text: GOOD };
  });
  try {
    const chunks = await collect({
      sessionId: 'auto-think-1', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('改文件')],
    });
    assert.equal(prompts.length, 2, '必须补发一轮');
    assert.match(prompts[1], /THINKING_ONLY_NO_ANSWER/, '补发的是 thinking-only 归因提示');
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.match(deltas, /AUTO_CONTINUED/);
    const callEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
    assert.ok(callEnd, '续跑轮的调用必须派发（循环存活）');
    assert.equal(callEnd.block.name, 'edit');
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls', 'finish 必须是 tool-calls，让 agent 循环继续');
  } finally { await dispose(); }
});
