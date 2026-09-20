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
  // 0.16.29：再教学提示只走补发通道，补发的 prompt 也要收集（见文件尾部的判据）。
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

// 恢复层的在役形状（0.16.23）：**半角规范 invoke 形**的畸形——参数体未闭合。
// 历史夹具（run-2 会话 7e16d083 的 DSML 简写形状）随 DSML 退役换成在役形状：
// 恢复层继续服务在役协议的畸形（半角 <invoke>/<parameter> 残片、mcp_action 围栏），
// DSML 形状的扣留块一律走 UNPARSED 再教学——恢复派发不得给漂移形状发「奖励」。
const DRIFT_READ = '先看这个文件。\n<invoke name="read">\n<parameter name="file_path" string="true">lib/openai.js</param\n';

test('纯函数：从畸变块恢复出白名单只读工具的调用', () => {
  const rec = recoverUnparsedCalls(DRIFT_READ, TOOLS);
  assert.equal(rec.length, 1);
  assert.equal(rec[0].name, 'read');
  assert.equal(rec[0].arguments.file_path, 'lib/openai.js');
});

test('纯函数：白名单外（pwsh）的同形畸变不恢复', () => {
  const drift = '<invoke name="pwsh">\n<parameter name="command" string="true">ls</param';
  assert.deepEqual(recoverUnparsedCalls(drift, TOOLS), [], '有副作用的工具绝不代为派发');
});

test('纯函数：一个可读参数都没有时不恢复（留给 UNPARSED 提示）', () => {
  const drift = '<invoke name="read">\nfile_path="lib/openai.js</param';
  assert.deepEqual(recoverUnparsedCalls(drift, TOOLS), []);
});

test('纯函数：DSML 形状退役——扣留块里的 DSML 调用不得再被恢复派发（0.16.23）', () => {
  // 历史 DRIFT_READ 的 DSML 原形状（run-2 逐字 + 最小闭合补全）。退役语义：
  // DSML 残骸只走 UNPARSED 再教学；若这里恢复出调用，等于奖励漂移形状。
  const B = String.fromCharCode(0xFF5C);
  const dsmlRead = '先看这个文件。\n' + B + B + 'DSML' + B + B + 'calls>\n' + B + B + 'DSML' + B + B + 'invoke name="read">\n'
    + B + B + 'DSML' + B + B + 'parameter name="file_path" string="true">lib/openai.js</' + B + 'DSML' + B + ' param\n';
  assert.deepEqual(recoverUnparsedCalls(dsmlRead, TOOLS), [],
    'DSML 形状被恢复派发了——退役必须让漂移形状无收益');
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
  const { collect, dispose, prompts } = harness(async (key, prompt, opts) => {
    opts.onDelta?.(drift);
    return { text: drift };
  });
  try {
    const chunks = await collect({
      sessionId: 'no-recover', model: 'deepseek:deepseek', tools: TOOLS,
      messages: [user('继续')],
    });
    assert.ok(!chunks.some((c) => c.type === 'block-end' && c.block?.type === 'tool-call'), 'pwsh 畸变不得被派发');
    // 0.16.29：安全线判据落在补发通道上（正文只留 AUTO_CONTINUED）。
    assert.ok(prompts.length >= 2, '不可恢复时必须真的补发再教学提示');
    assert.match(prompts[1], /TOOL_CALL_UNPARSED/);
    const deltas = chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
    assert.ok(!/TOOL_CALL_UNPARSED/.test(deltas), '正文不得再铺提示全文（0.16.29）');
  } finally { await dispose(); }
});
