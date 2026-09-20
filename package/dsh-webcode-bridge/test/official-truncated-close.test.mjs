// official-truncated-close.test.mjs — 0.16.32 护栏：闭 token 缺位或漂移成 DSML。
//
// 真机取证（~/.dsh/logs/webcode-bridge-replies.log）：
//   会话 session-01df83cf-7878-4963-b6b6-1985d1dd861a，13 轮：
//     agree=13 disagree=0  日志读数与解析器行为完全一致
//   断点：08:27:37.345Z calls=1（最后一轮部分成功）
//         08:27:49.586Z calls=0（首次全灭）
//
// 病灶不在开 token（双竖线已被 0.16.30 收编），而在端锚：
// RE_OFFICIAL_CALL 的端锚只认 tool-call(s)-end 一族 token。
// 真机模型把闭 token 写成了 DSML 形状，官方端锚永远配不上。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentReply, normalizeOfficialToolCalls } from '../lib/agent-preset.js';

const B = String.fromCharCode(0xFF5C);
const BB = B + B;
const S = String.fromCharCode(0x2581);
/** 官方 token，包裹竖线取 n 枚（真机取 2）。 */
const tok = (w, n = 2) => '<' + B.repeat(n) + 'tool' + w.map((x) => S + x).join('') + B.repeat(n) + '>';
/** DSML 形状的闭标记（真机漂移产物）。 */
const dsml = (s, n = 2) => '<' + B.repeat(n) + 'DSML' + B.repeat(n) + ' ' + s + '>';
const dsmlClose = (s, n = 2) => '</' + B.repeat(n) + 'DSML' + B.repeat(n) + ' ' + s + '>';

const T = [
  { name: 'grep', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } },
  { name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
];

/** 真机 08:27:49 那一轮的逐字形状：单调用，闭 token 漂移成 DSML。 */
function realOneCall() {
  return tok(['calls', 'begin']) + 'grep' + tok(['sep']) + '{"pattern":"0\\\\.16\\\\.31"}'
    + '\n' + dsml('parameter')
    + '\n' + dsml('parameter name="tool_name" string="true"') + 'grep' + dsmlClose('parameter')
    + '\n' + dsml('parameter name="parameters"') + '{"pattern":"0\\\\.16\\\\.31"}' + dsmlClose('parameter')
    + '\n' + dsmlClose('invoke')
    + '\n' + dsmlClose('calls');
}

test('真机形状：闭 token 漂移成 DSML —— 修复前 calls=0（本次故障现场）', () => {
  const { calls } = parseAgentReply(realOneCall(), { tools: T });
  assert.equal(calls.length, 1, 'the single intended call must survive');
  assert.equal(calls[0].name, 'grep');
  assert.equal(calls[0].arguments.pattern, '0\\.16\\.31');
});

test('真机形状：读写混合多调用，只有首条有官方闭 token —— 修复前后续全丢', () => {
  const raw = tok(['calls', 'begin']) + '\n'
    + tok(['call', 'begin']) + 'pwsh' + tok(['sep']) + '{"command":"Get-Location"}' + tok(['call', 'end']) + '\n'
    + tok(['calls', 'begin']) + 'grep' + tok(['sep']) + '{"pattern":"a\\\\.b"}' + '\n'
    + dsml('parameter name="tool_name" string="true"') + 'grep' + dsmlClose('parameter') + '\n'
    + dsmlClose('invoke') + '\n'
    + tok(['calls', 'end']);
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.deepEqual(calls.map((c) => c.name), ['pwsh', 'grep'], 'both intended calls must survive');
});

test('闭 token 完全缺位（模型忘写）：单调用仍须解析', () => {
  const raw = tok(['calls', 'begin']) + 'grep' + tok(['sep']) + '{"pattern":"x"}';
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'grep');
  assert.equal(calls[0].arguments.pattern, 'x');
});

test('闭 token 完全缺位：多调用按 sep token 切分，不得只出第一条', () => {
  const raw = tok(['calls', 'begin'])
    + tok(['call', 'begin']) + 'grep' + tok(['sep']) + '{"pattern":"one"}' + tok(['call', 'end'])
    + tok(['call', 'begin']) + 'read' + tok(['sep']) + '{"file_path":"a.md"}' + tok(['call', 'end']);
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.deepEqual(calls.map((c) => c.name), ['grep', 'read']);
});

test('该轮不再落入 UNPARSED 扣留路径（循环存活的关键）', () => {
  // 0.16.32 的修复点：闭 token 漂移/缺位由**主解析**收编，因此这一轮不再进入
  // recoverUnparsedCalls 的扣留场景，也不会触发 TOOL_CALL_UNPARSED 自动再教学。
  // 恢复层的合同是另一族（主解析认不出的 DSML <invoke><parameter> 形态，
  // 见 recovered-dispatch.test.mjs），本案不要求它兜底——主解析自己拿下了。
  const { calls } = parseAgentReply(realOneCall(), { tools: T });
  assert.ok(calls.length > 0, 'the round must not fall through to the UNPARSED path');
  assert.deepEqual(calls.map((c) => c.name), ['grep']);
});

test('不回归：官方正确闭 token 仍逐字可解析', () => {
  const raw = tok(['calls', 'begin']) + tok(['call', 'begin']) + 'pwsh' + tok(['sep'])
    + '{"command":"node --version"}' + tok(['call', 'end']) + tok(['calls', 'end']);
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].arguments.command, 'node --version');
});

test('不回归：普通散文不被吞成调用', () => {
  const { calls } = parseAgentReply('这是一个普通回答，没有任何调用。\n结束。', { tools: T });
  assert.equal(calls.length, 0);
});

test('不回归：单竖线官方形状（0.16.30 的既有行为）', () => {
  const raw = tok(['calls', 'begin'], 1) + tok(['call', 'begin'], 1) + 'grep' + tok(['sep'], 1)
    + '{"pattern":"p"}' + tok(['call', 'end'], 1) + tok(['calls', 'end'], 1);
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'grep');
});

test('不回归：DSML 词形本身仍不执行（退役语义不放宽）', () => {
  const raw = dsml('invoke name="grep"') + '\n' + dsml('parameter name="pattern"') + 'a' + dsmlClose('parameter')
    + '\n' + dsmlClose('invoke');
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.equal(calls.length, 0, 'retired DSML form must stay non-executable');
});

test('归一化：漂移闭 token 不得把 DSML 残骸漏成正文', () => {
  const norm = normalizeOfficialToolCalls(realOneCall());
  assert.ok(norm.includes('<invoke name="grep">'), 'must rewrite to canonical invoke: ' + norm);
});
