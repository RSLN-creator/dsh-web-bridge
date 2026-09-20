// unparsed-notice-head.test.mjs — 0.16.11 护栏：UNPARSED 提示必须携带被扣协议原文的开头（#25）。
//
// 真机取证（doc/diagnosis-2026-09-19.md §二问题 1）：TOOL_CALL_UNPARSED 在会话 d5fd2e11
// 单会话复发 4 次（扣留 868/2193/245/541 字符），提示只说「已扣留 N 字符」——模型看不见
// 被扣的是什么调用，只能整段重猜。两类残根里「缺 name 且候选不唯一」「参数 JSON 断流
// 截断」都按红线**不许桥侧代猜代拼**（PROMPT-ENGINEERING.md §二：截半的调用块不得被拼成
// 完整调用），唯一安全的出路是把被扣内容开头原样交回，让模型精确重发哪一条。
//
// 0.16.29 契约更新（用户指令「TOOL_CALL_UNPARSED: 直接隐藏」）：提示不再当**正文**显示，
// 而是逐字作为**补发的用户消息**发给模型。因此本文件的判据从「正文含提示」改为
// 「补发的 prompt 含提示」，交付通道与展示通道分开断言——这才是既不丢信息、又照指令
// 隐藏的那种钉法。
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
  const prompts = [];
  const dispose = apply(
    { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null },
    {
      port: 0, requireConsent: false,
      driver: {
        status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
        sendTurn: (key, prompt, opts) => { prompts.push(String(prompt)); return sendTurnImpl(key, prompt, opts); },
        sendPrompt: async (prompt, opts) => sendTurnImpl('main', prompt, opts),
      },
    },
  );
  const collect = async (options) => {
    const chunks = [];
    for await (const c of adapter.stream(options)) chunks.push(c);
    return chunks;
  };
  return { collect, dispose, prompts };
}

/** 展示通道（正文增量）拼出的全部文本。 */
const shownText = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');

test('参数 JSON 被断流截断的调用：提示（补发给模型的那份）必须带被扣协议原文开头', async () => {
  const truncatedCall = '<tool_call>{"mcp_action":"call","name":"pwsh","arguments":{"command":"gh run watch 35358390517 --exit-status';
  const { collect, dispose, prompts } = harness(async (key, prompt, opts) => {
    opts.onDelta?.('先核对 CI 结论。' + truncatedCall);
    return { text: '先核对 CI 结论。' + truncatedCall };
  });
  try {
    const chunks = await collect({
      sessionId: 'trunc-call', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('核对 CI')],
    });
    assert.equal(chunks.at(-1).type, 'finish', '截断轮按提示收尾，不抛错');
    assert.ok(prompts.length >= 2, '必须真的补发过一轮，提示才有人看见');
    const sent = prompts[1];
    assert.match(sent, /TOOL_CALL_UNPARSED/, '补发的必须是再教学提示原文');
    assert.match(sent, /gh run watch 35358390517 --exit-status/,
      '被扣协议原文开头必须原样出现在补发的提示里，模型才能精确重发这一条');
    assert.match(sent, /已扣留/, '扣留量读数保留');
    // 展示通道：0.16.29 起只留 AUTO_CONTINUED，不铺提示全文。
    assert.ok(!/TOOL_CALL_UNPARSED/.test(shownText(chunks)),
      '提示不得再铺进正文（0.16.29 用户指令「直接隐藏」）');
  } finally { await dispose(); }
});

test('正文与调用各半的截断轮：散文照常外发，被扣原文开头只走补发通道', async () => {
  const truncatedCall = '<tool_call>{"mcp_action":"call","name":"read","arguments":{"path":"doc/progre';
  const { collect, dispose, prompts } = harness(async (key, prompt, opts) => {
    opts.onDelta?.('结论有依据。' + truncatedCall);
    return { text: '结论有依据。' + truncatedCall };
  });
  try {
    const chunks = await collect({
      sessionId: 'prose-and-trunc', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('读台账')],
    });
    assert.match(shownText(chunks), /^结论有依据。/, '散文部分必须先照常外发');
    assert.ok(!/doc\/progre/.test(shownText(chunks)),
      '被扣原文开头不得进正文（0.16.29；它只随补发提示发给模型）');
    assert.match(prompts[1] || '', /doc\/progre/, '被扣原文开头必须随补发的提示送达模型');
  } finally { await dispose(); }
});
