// stream-tail.test.mjs — 0.9.6 流式收尾回归（真机症状：回复缺失/正文变数字/
// 协议漏进正文/同一对话续不上）。
//
// 根因：0.9.6 把「已外发正文」从字符串改成数字下标，但收尾的
// startsWith/slice/stripProtocolText 仍按字符串用：
//   • 纯文本回复（带工具的会话）必抛 STREAM_REWRITE → 整轮作废；
//   • 解析出调用而流式探测没开块时，正文块 text = String(下标)（如 "123"）；
//   • finalText.slice(textSent.length) → slice(undefined) → 整段正文重发一遍。
// 本文件逐条锁死这四个症状。

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const TOOLS = [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } }];

function harness(streamScript) {
  // streamScript(turn) 在返回前依次吐增量
  let adapter;
  const dispose = apply(
    { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null },
    {
      port: 0, requireConsent: false,
      driver: {
        status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
        sendTurn: async (key, prompt, opts) => { streamScript(opts); return { text: null }; },
        sendPrompt: async (prompt, opts) => { streamScript(opts); return { text: null }; },
      },
    },
  );
  const collect = async (options) => {
    const chunks = [];
    for await (const c of adapter.stream(options)) chunks.push(c);
    return chunks;
  };
  return { collect, dispose };
}

async function withHarness(fn) {
  const h = harness(() => {});
  await h.dispose();
}

test('带工具会话的纯文本回复不再误判 STREAM_REWRITE（回复缺失根因）', async () => {
  const { collect, dispose } = harness((opts) => {
    opts.onDelta?.('审查结论：代码质量整体良好，');
    opts.onDelta?.('建议统一错误处理路径。');
    return { text: '审查结论：代码质量整体良好，建议统一错误处理路径。' };
  });
  try {
    const chunks = await collect({
      sessionId: 'pure-text', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('审查一下')],
    });
    assert.equal(chunks.at(-1).type, 'finish', '必须正常收尾而不是抛 STREAM_REWRITE');
    assert.equal(chunks.at(-1).reason.kind, 'stop');
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.equal(deltas, '审查结论：代码质量整体良好，建议统一错误处理路径。', '增量拼出的正文必须完整');
    const textEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'text');
    assert.equal(textEnd.block.text, '审查结论：代码质量整体良好，建议统一错误处理路径。', '块内容必须是完整正文而不是数字');
  } finally { await dispose(); }
});

test('流式探测开块的调用：正文块 = 已发散文原文（不是数字下标）', async () => {
  const { collect, dispose } = harness((opts) => {
    for (const part of ['先读文件。', '<tool_call>', '{"mcp_action":"call",', '"name":"read","arguments":{"path":"a.md"}}', '</tool_call>']) opts.onDelta?.(part);
    return { text: '先读文件。<tool_call>{"mcp_action":"call","name":"read","arguments":{"path":"a.md"}}</tool_call>' };
  });
  try {
    const chunks = await collect({
      sessionId: 'streamed-call', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('读')],
    });
    assert.equal(chunks.at(-1).type, 'finish');
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
    const textEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'text');
    assert.ok(textEnd, '应有正文块');
    assert.equal(textEnd.block.text, '先读文件。', '正文块必须是散文原文，不得是数字或协议文本');
    const callEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
    assert.equal(callEnd.block.name, 'read');
    assert.deepEqual(JSON.parse(callEnd.block.arguments), { path: 'a.md' });
    const callBlocks = chunks.filter((c) => c.type === 'block-start' && c.blockType === 'tool-call');
    assert.equal(callBlocks.length, 1, '同一个调用只能开一个块');
  } finally { await dispose(); }
});

test('围栏 {"name","arguments"} 形状（无 mcp_action）：协议原文不得漏进正文块', async () => {
  const { collect, dispose } = harness((opts) => {
    opts.onDelta?.('查看目录：\n');
    opts.onDelta?.('```json\n{"name":"read","arguments":{"path":"README.md"}}\n```');
    return { text: '查看目录：\n```json\n{"name":"read","arguments":{"path":"README.md"}}\n```' };
  });
  try {
    const chunks = await collect({
      sessionId: 'fence-name', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('看')],
    });
    assert.equal(chunks.at(-1).type, 'finish');
    const textEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'text');
    assert.ok(textEnd, '应有正文块');
    assert.ok(!textEnd.block.text.includes('```'), '协议原文（围栏）不得留在正文块');
    assert.ok(textEnd.block.text.includes('查看目录'), '散文必须保留');
    const callEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
    assert.equal(callEnd?.block.name, 'read', '围栏 name 形状应产出可执行调用');
  } finally { await dispose(); }
});

test('正文以疑似半成品标记收尾（如「5 < 10」）不得被截断', async () => {
  const { collect, dispose } = harness((opts) => {
    opts.onDelta?.('比较结果：5 < 10 成立，结论可靠。');
    return { text: '比较结果：5 < 10 成立，结论可靠。' };
  });
  try {
    const chunks = await collect({
      sessionId: 'lt-tail', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('比')],
    });
    const textEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'text');
    assert.equal(textEnd.block.text, '比较结果：5 < 10 成立，结论可靠。', '结尾正文必须完整');
  } finally { await dispose(); }
});

// ---- 0.16.10：增量边界恰好切在 `<` 之后的字符丢失 ----------------------------
//
// 上面那条「5 < 10」测试**盖不住**这一类：它的 `<` 不在增量边界上，所以
// partialProtocolAt 一次都没命中过。真出问题的是「增量恰好切在 `<` 之后」——
// 半成品标记判据把外发边界停在那一个 `<` 上，下一次增量里 proseChunk 就是单个
// `<`，它只由标签字符组成，于是被 tagDebris 当残渣**静默推进游标吃掉**：
// textSent 前进了，proseSent 一个字节都没收到，收尾的
// `proseSent.slice(proseBlockStart) + tail` 也从 textSent 之后起算，补不回来。
// 用户症状就是「正文里少字符」。
//
// 下面四条逐字驱动真实 apply()/adapter.stream() 路径（不是纯函数断言），
// 覆盖 0.16.10 修掉的两个形态：孤立 `<` 被吞、以及尾部滞后窗口永不释放。
test('0.16.10 孤立 `<`：增量切在 `<` 之后不得丢字符', async () => {
  const FULL = '函数 <foo> 定义。';
  const { collect, dispose } = harness((opts) => {
    for (const p of ['函数 <f', 'oo> 定义。']) opts.onDelta?.(p);
    return { text: FULL };
  });
  try {
    const chunks = await collect({
      sessionId: 'lone-lt', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('说')],
    });
    const textEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'text');
    assert.equal(textEnd.block.text, FULL, '`<` 不得被当标签残渣吞掉');
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.equal(deltas, FULL, '外发增量之和必须等于权威正文（单调、不重复、不缺失）');
  } finally { await dispose(); }
});

test('0.16.10 尾部滞后：HTML 标签/泛型切在增量边界上不得丢尾串', async () => {
  const CASES = [
    { parts: ['见 <b', '>粗体', '</b> 结束。'], full: '见 <b>粗体</b> 结束。' },
    { parts: ['用 <st', 'rike>x</strike> 表示。'], full: '用 <strike>x</strike> 表示。' },
    { parts: ['类型 ', 'Array<', 'T> 是泛型。'], full: '类型 Array<T> 是泛型。' },
  ];
  for (const c of CASES) {
    const { collect, dispose } = harness((opts) => {
      for (const p of c.parts) opts.onDelta?.(p);
      return { text: c.full };
    });
    try {
      const chunks = await collect({
        sessionId: 'lag-tail', model: 'deepseek:deepseek', tools: TOOLS,
        messages: [user('写')],
      });
      const textEnd = chunks.find((x) => x.type === 'block-end' && x.block?.type === 'text');
      assert.equal(textEnd.block.text, c.full, `尾部滞后不得吞掉正文字符：${JSON.stringify(c.parts)}`);
    } finally { await dispose(); }
  }
});

test('0.16.10 真协议仍必须被扣住（护栏方向不得被上面两条放宽）', async () => {
  // 正面：尾部确实是半截真协议标记 —— 必须仍然扣住、仍然发提示。
  //
  // 断言必须避开提示模板本身：`unparsedCallNotice` 为了教模型怎么重发，**正文里
  // 就带着一段字面的 `<tool_call>{"mcp_action":"call",…}</tool_call>`**。所以
  // 「块内容含 mcp_action」不能当泄漏判据（那样测的是模板，不是泄漏）。真正的判据是
  // **模型这一轮发出的那段协议头不得出现**——用它的独有前缀（真实工具名 read 与其
  // 参数名）来认，提示模板里不含这些。
  const RAWHEAD = '{"mcp_action":"call","name":"read","argu';
  const { collect, dispose } = harness((opts) => {
    opts.onDelta?.('先看文件。<tool_call>{"mcp_action":"call","name":"read","argu');
    return { text: '先看文件。<tool_call>{"mcp_action":"call","name":"read","argu' };
  });
  try {
    const chunks = await collect({
      sessionId: 'real-half-marker', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('看')],
    });
    const textEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'text');
    assert.ok(textEnd, '应有正文块');
    assert.ok(!textEnd.block.text.includes(RAWHEAD),
      '半截真协议原文绝不得进正文块');
    assert.ok(!textEnd.block.text.includes('"name":"read"'),
      '协议头不得进正文块（提示模板里是占位「工具名」，不含真实工具名 read）');
    assert.ok(textEnd.block.text.includes('TOOL_CALL_UNPARSED'),
      '真协议被扣住时仍必须给出归因提示');
    assert.ok(textEnd.block.text.includes('先看文件。'), '已外发的散文必须保留');
  } finally { await dispose(); }
});

test('网页断流（end.text 为空但增量已流出）按增量收尾，不丢回复', async () => {
  const { collect, dispose } = harness((opts) => {
    opts.onDelta?.('部分恢复的正文仍然要送达。');
    return { text: '' };
  });
  try {
    const chunks = await collect({
      sessionId: 'partial', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('续')],
    });
    assert.equal(chunks.at(-1).type, 'finish', '不得因 end.text 为空抛错');
    const textEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'text');
    assert.equal(textEnd.block.text, '部分恢复的正文仍然要送达。');
  } finally { await dispose(); }
});

test('流式增量与收尾全文不得重复：text-delta 总和 == 块内容', async () => {
  const { collect, dispose } = harness((opts) => {
    for (const part of ['第一段。', '第二段。', '第三段。']) opts.onDelta?.(part);
    return { text: '第一段。第二段。第三段。' };
  });
  try {
    const chunks = await collect({
      sessionId: 'no-dup', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('讲')],
    });
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    const textEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'text');
    assert.equal(deltas, textEnd.block.text, '增量与块内容必须一致（不重发、不缺失）');
  } finally { await dispose(); }
});
