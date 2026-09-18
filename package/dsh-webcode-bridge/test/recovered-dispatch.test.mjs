// recovered-dispatch.test.mjs — 0.16.12 护栏：UNPARSED 轮的「恢复派发」（无人值守长跑存活关键）。
//
// 真机取证（长跑第 2/3 轮，2026-09-19 01:51 / 02:18，doc/progress.md §0.16.12）：
// 网页模型每 ~50 次调用就会出现一次 DSML 标记漂移，桥扣住后交回 UNPARSED 提示——
// 但 headless 的 agent 循环把「纯文本回复」当最终答案收场，长跑两轮分别死在
// 13 分钟 / 8 分钟。提示能让模型改正的前提是**循环还在跑**；无人值守下纯文本轮
// = 提前终止。
//
// 修法（红线之内）：扣留块里能读出**白名单只读工具**（read/glob/grep）的合法
// invoke（工具名真实存在于本会话 + 至少一个参数完整配对）时，代为派发该调用——
// 这不是伪造模型意图（invoke name="read" + 参数都是模型亲笔），而是把没送达的
// 调用送达；参数不齐时 DSH 会报自己的错回流，循环继续。白名单外（pwsh/write 等
// 有副作用的工具）与参数不可读时维持原 UNPARSED 提示，绝不派发。

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { recoverUnparsedCalls } from '../lib/agent-preset.js';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const B = String.fromCharCode(0xFF5C) + String.fromCharCode(0xFF5C);
const MARK = '<' + B + 'DSML' + B + ' ';
const TOOLS = [
  { name: 'read', description: '读文件', parameters: { type: 'object', properties: { file_path: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'pwsh', description: '跑命令', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
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

// 真机漂移形状（run-2 会话 7e16d083 的扣留头逐字 + 最小闭合补全；畸变点=参数开标记简写，
// 本用例在「宽容层已修」之前的老文本上构造另一种畸变：参数体未闭合）。
const DRIFT_READ = '先看这个文件。\n' + MARK + 'calls>\n' + MARK + 'invoke name="read">\n'
  + MARK + 'parameter name="file_path" string="true">lib/openai.js</' + B + 'DSML' + B + ' param\n';

test('纯函数：从畸变块恢复出白名单只读工具的调用', () => {
  const rec = recoverUnparsedCalls(DRIFT_READ, TOOLS);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].name, 'read');
  assert.equal(rec[0].arguments.file_path, 'lib/openai.js');
});

test('纯函数：白名单外（pwsh）的同形畸变不恢复', () => {
  const drift = MARK + 'invoke name="pwsh">\n' + MARK + 'parameter name="command" string="true">ls</' + B + 'DSML' + B + ' param';
  assert.deepEqual(recoverUnparsedCalls(drift, TOOLS), [], '有副作用的工具绝不代为派发');
});

test('纯函数：一个可读参数都没有时不恢复（留给 UNPARSED 提示）', () => {
  const drift = MARK + 'invoke name="read">\n' + MARK + 'file_path="lib/openai.js</' + B + 'DSML' + B + ' param';
  assert.deepEqual(recoverUnparsedCalls(drift, TOOLS), []);
});

test('端到端：UNPARSED 轮带可恢复调用时必须派发 tool-call 块（循环存活），并如实说明', async () => {
  const { collect, dispose } = harness(async (key, prompt, opts) => {
    opts.onDelta?.(DRIFT_READ);
    return { text: DRIFT_READ };
  });
  try {
    const chunks = await collect({
      sessionId: 'recover', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('继续')],
    });
    const callEnd = chunks.find((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
    assert.ok(callEnd, '必须派发恢复的调用块（否则无人值守循环会终止）');
    assert.equal(callEnd.block.name, 'read');
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.match(deltas, /恢复派发/, '必须如实说明这是恢复派发');
    assert.equal(chunks.at(-1).type, 'finish');
    assert.equal(chunks.at(-1).reason.kind, 'tool-calls', 'finish 必须是 tool-calls，让 agent 循环继续');
  } finally { await dispose(); }
});

test('端到端：不可恢复的畸变仍走 UNPARSED 提示（安全线不放宽）', async () => {
  const drift = '正文。\n' + MARK + 'invoke name="pwsh">\n' + MARK + 'parameter name="command" string="true">rm -rf</' + B + 'DSML' + B + ' param';
  const { collect, dispose } = harness(async (key, prompt, opts) => {
    opts.onDelta?.(drift);
    return { text: drift };
  });
  try {
    const chunks = await collect({
      sessionId: 'no-recover', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('继续')],
    });
    assert.ok(!chunks.some((c) => c.type === 'block-end' && c.block?.type === 'tool-call'), 'pwsh 畸变不得被派发');
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.match(deltas, /TOOL_CALL_UNPARSED/);
  } finally { await dispose(); }
});
