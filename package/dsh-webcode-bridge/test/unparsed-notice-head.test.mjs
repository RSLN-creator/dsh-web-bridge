// unparsed-notice-head.test.mjs — 0.16.11 护栏：UNPARSED 提示必须携带被扣协议原文的开头（#25）。
//
// 真机取证（doc/diagnosis-2026-09-19.md §二问题 1）：TOOL_CALL_UNPARSED 在会话 d5fd2e11
// 单会话复发 4 次（扣留 868/2193/245/541 字符），提示只说「已扣留 N 字符」——模型看不见
// 被扣的是什么调用，只能整段重猜。两类残根里「缺 name 且候选不唯一」「参数 JSON 断流
// 截断」都按红线**不许桥侧代猜代拼**（PROMPT-ENGINEERING.md §二：截半的调用块不得被拼成
// 完整调用），唯一安全的出路是把被扣内容开头原样交回，让模型精确重发哪一条。
//
// 锚点用真实工具名与真实参数串（0.16.10 的教训：锚在提示模板的占位文字上=永远绿的假护栏）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const TOOLS = [
  { name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
  { name: 'pwsh', description: '跑命令', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } } },
];

function harness(sendTurnImpl) {
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
    },
  );
  const collect = async (options) => {
    const chunks = [];
    for await (const c of adapter.stream(options)) chunks.push(c);
    return chunks;
  };
  return { collect, dispose };
}

test('参数 JSON 被断流截断的调用：提示必须带被扣协议原文开头（真实参数串可辨）', async () => {
  const truncatedCall = '<tool_call>{"mcp_action":"call","name":"pwsh","arguments":{"command":"gh run watch 35358390517 --exit-status';
  const { collect, dispose } = harness(async (key, prompt, opts) => {
    opts.onDelta?.('先核对 CI 结论。' + truncatedCall);
    return { text: '先核对 CI 结论。' + truncatedCall };
  });
  try {
    const chunks = await collect({
      sessionId: 'trunc-call', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('核对 CI')],
    });
    assert.equal(chunks.at(-1).type, 'finish', '截断轮按提示收尾，不抛错');
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.match(deltas, /TOOL_CALL_UNPARSED/);
    assert.match(deltas, /gh run watch 35358390517 --exit-status/,
      '被扣协议原文开头必须原样出现在提示里，模型才能精确重发这一条');
    assert.match(deltas, /已扣留/, '扣留量读数保留');
  } finally { await dispose(); }
});

test('正文与调用各半的截断轮：散文照常外发，提示接在正文之后', async () => {
  const truncatedCall = '<tool_call>{"mcp_action":"call","name":"read","arguments":{"path":"doc/progre';
  const { collect, dispose } = harness(async (key, prompt, opts) => {
    opts.onDelta?.('结论有依据。' + truncatedCall);
    return { text: '结论有依据。' + truncatedCall };
  });
  try {
    const chunks = await collect({
      sessionId: 'prose-and-trunc', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('读台账')],
    });
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.match(deltas, /^结论有依据。/, '散文部分必须先照常外发');
    assert.match(deltas, /doc\/progre/, '被扣原文开头跟在散文之后');
  } finally { await dispose(); }
});
