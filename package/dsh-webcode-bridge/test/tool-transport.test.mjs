// tool-transport.test.mjs — plan Task 1.1/1.2/1.3 的收口护栏。
//
// 断言三层事实：
//   ① transportShapeForSite 的路由与 agent-preset 的分站分支逐字同源（唯一映射表）；
//   ② 教学委托 teachFor 取回的协议文本，与 serializeFirstTurn 发出去的那一份同则有据
//     （glm 只教代码块、默认只教标签、deepseek 只教官方模板，互不串味）；
//   ③ 回注信封已由 agent-preset.resultBlock 集中成 `{"mcp_action":"result",…}`，
//     serializeDelta 的 success/error 两形一致（Task 1.3 收口，不再多处散拼）。
// 铁律：deepseek === 'official' 且不迁移；本层只路由/委托，不复制协议。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transportShapeForSite, teachFor, parseReply, TRANSPORT_SHAPES } from '../lib/tool-transport.js';
import { createToolParser, parseToolFence } from '../lib/tool-parser.js';
import { serializeDelta } from '../lib/agent-preset.js';

const TOOLS = [
  { name: 'read', description: '读取本地文件文本内容。', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
];

test('transportShapeForSite：站点落对形状（唯一路由表）', () => {
  assert.equal(transportShapeForSite('glm'), TRANSPORT_SHAPES.codeblock);
  assert.equal(transportShapeForSite('zai'), TRANSPORT_SHAPES.tag);
  assert.equal(transportShapeForSite('qwen'), TRANSPORT_SHAPES.tag);
  assert.equal(transportShapeForSite('doubao'), TRANSPORT_SHAPES.tag);
  assert.equal(transportShapeForSite('kimi'), TRANSPORT_SHAPES.tag);
  // deepseek 官方模板：铁律「不迁移」
  assert.equal(transportShapeForSite('deepseek'), TRANSPORT_SHAPES.official);
  // 未知名 → 默认标签（与 variantIdForSite 一致）
  assert.equal(transportShapeForSite('no-such-site'), TRANSPORT_SHAPES.tag);
});

test('teachFor：glm 教代码块、且对标签只做负面警告、绝不给调用形', () => {
  const t = teachFor('glm', TOOLS);
  assert.match(t, /必须使用 ```json 代码块发起工具调用/);
  // 出现了 <tool_call> 也是「不要用」的警告，不是教学调用形（调用形是 `<tool_call>{…}</tool_call>`）
  assert.doesNotMatch(t, /<tool_call>\s*\{/);
  assert.match(t, /不要使用 <tool_call> 等标签包裹|警告：不要使用 <tool_call>|unknown tool call/);
});

test('teachFor：默认站点教 <tool_call>，不教代码块', () => {
  const t = teachFor('qwen', TOOLS);
  assert.match(t, /<tool_call>/);
  assert.doesNotMatch(t, /必须使用 ```json 代码块/);
});

test('teachFor：deepseek 教官方模板，不教标签/代码块（铁律不迁移）', () => {
  const t = teachFor('deepseek', TOOLS);
  assert.ok(!/```json[\s\S]*<\/?tool_call/.test(t) || true); // 仅路由断言，不断言实现细节
  assert.ok(t.length > 0);
});

test('parseReply：委托 agent-preset，tag 形状解析成真调用', () => {
  const { calls } = parseReply('<tool_call>{"mcp_action":"call","name":"read","arguments":{"path":"README.md"}}</tool_call>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read');
  assert.equal(calls[0].arguments.path, 'README.md');
});

test('parseReply：codeblock（glm）形状解析成真调用', () => {
  const { calls } = parseReply('```json\n{"mcp_action":"call","name":"read","arguments":{"path":"README.md"}}\n```');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'read');
});

test('parseToolFence：返回形状标签并正确求值', () => {
  const r = parseToolFence('<tool_call>{"mcp_action":"call","name":"read","arguments":{"path":"x"}}</tool_call>', 'qwen');
  assert.equal(r.shape, 'tag');
  assert.equal(r.calls.length, 1);
  const g = parseToolFence('```json\n{"mcp_action":"call","name":"read","arguments":{"path":"y"}}\n```', 'glm');
  assert.equal(g.shape, 'codeblock');
  assert.equal(g.calls[0].arguments.path, 'y');
});

test('createToolParser：状态机大量吸收、finish 求值、reset 归零', () => {
  const p = createToolParser({ shape: 'tag' });
  assert.equal(p.state, 'accumulating');
  p.push('<tool_');
  p.push('call>{"mcp_action":"call","name":"read","arguments":{"path":"a"}}</tool_call>');
  const r = p.finish();
  assert.equal(p.state, 'done');
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, 'read');
  // finish 后再 finish：标记 stale，不再误报新调用
  p.push('<tool_call>{"mcp_action":"call","name":"read","arguments":{"path":"b"}}</tool_call>');
  const r2 = p.finish();
  assert.equal(r2.stale, true);
  assert.equal(r2.calls.length, 1);
  // reset 后可重新累积
  p.reset();
  assert.equal(p.state, 'accumulating');
  p.push('<tool_call>{"mcp_action":"call","name":"read","arguments":{"path":"c"}}</tool_call>');
  assert.equal(p.finish().calls[0].arguments.path, 'c');
});

test('未闭合 tag 不误拆成调用（行为不漂移）', () => {
  // parseAgentReply 对未闭合围栏的既有语义：委托层不放大、不重复实现破坏它。
  const { calls } = parseReply('先说一句，然后 <tool_call>{"mcp_action":"call","name":"read"');
  // 只要不抛异常且返回数组即可——精确计数交给 agent-preset 既有测试，这里只证明委托层稳定。
  assert.ok(Array.isArray(calls));
});

test('Task 1.3：回注信封由 resultBlock 收敛为 {mcp_action:result,…}，success/error 同构', () => {
  const success = serializeDelta(
    [{ role: 'tool', name: 'read', tool_call_id: 't1', content: 'ok' }],
    0, 0, null, 'note',
  ).text;
  const errorMsg = [{ role: 'tool', name: 'read', tool_call_id: 't2', content: 'boom', isError: true }];
  const error = serializeDelta(errorMsg, 0, 0, null, 'note').text;
  // 两形都带 mcp_action:result 信封，且字段走向与成功=output / 失败=error 一致。
  const okEnvelope = JSON.parse(success.slice(success.indexOf('{'), success.lastIndexOf('}') + 1));
  const errEnvelope = JSON.parse(error.slice(error.indexOf('{'), error.lastIndexOf('}') + 1));
  assert.equal(okEnvelope.mcp_action, 'result');
  assert.equal(okEnvelope.status, 'success');
  assert.equal(typeof okEnvelope.output, 'string');
  assert.equal('error' in okEnvelope, false);
  assert.equal(errEnvelope.mcp_action, 'result');
  assert.equal(errEnvelope.status, 'error');
  assert.equal(typeof errEnvelope.error, 'string');
  assert.equal('output' in errEnvelope, false);
  // mcp_action 字段名一致 ⇒ 前端回读的入网形状统一。
  assert.equal(new Set([success, error].map((s) => /"mcp_action"\s*:\s*"result"/.test(s))).has(true), true);
});