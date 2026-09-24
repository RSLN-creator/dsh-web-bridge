// unparsed-shape-diagnostic.test.mjs — 0.19.11 护栏：「协议在场、0 调用、却没有诊断」这一格。
//
// 真机病因（2026-09-24，逐条复解析 1,363 条 `raw reply`，脚本 `.tmp/check25.mjs`）：
// 「有协议锚、0 调用」的 25 条里 **23 条 diagnostics 是空的**。后果不是少一行日志——
// `TOOL_CALL_UNPARSED` 提示里那句「解析诊断 …」（lib/index.js:2182）是唯一把病灶点给
// 模型看的地方，它空着，模型只能看到泛泛的「name 别省 / JSON 要配平」，于是照原样
// 再发一遍坏形状（doc/progress.md 已记过同型病：「教学没打到病灶，模型连抄三轮」）。
//
// 本文件里的形状**逐字取自真机日志**（session-de96549d / session-0f9fe6cf /
// session-28d6164b / session-cb4f1502），不是我编的合成串。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentReply, describeUnparsedProtocolShape } from '../lib/agent-preset.js';

const B = String.fromCharCode(0xFF5C);
const S = String.fromCharCode(0x2581);
const TOOLS = [
  { name: 'job_output', parameters: { type: 'object', properties: {} } },
  { name: 'read', parameters: { type: 'object', properties: {} } },
  { name: 'grep', parameters: { type: 'object', properties: {} } },
  { name: 'edit', parameters: { type: 'object', properties: {} } },
  { name: 'pwsh', parameters: { type: 'object', properties: {} } },
];

/** 真机 ①：工具名被并进 call▁begin（结束竖线丢失），后面直接跟 sep token。 */
const MERGED_NAME = '<' + B + 'tool' + S + 'call' + S + 'job_output<' + B + 'tool' + S + 'sep' + B
  + '>{"job_id":"pwsh-1","wait":true,"timeout_ms":420000}\n<' + B + 'tool' + S + 'call' + S + 'end' + B + '>\n<'
  + B + 'tool' + S + 'call' + S + 'calls' + S + 'end' + B + '>';

/** 真机 ②：sep 标记残缺——`<｜tool▁` 之后直接进 JSON，参数体开头被吞。 */
const BROKEN_SEP = '<calls>\n<' + B + 'tool' + S + 'call' + S + 'begin' + B + '>read<' + B + 'tool'
  + S + 'limit":28,"offset":320,"file_path":"package/dsh-webcode-bridge/lib/wait-stats.js"}<'
  + B + 'tool' + S + 'call' + S + 'end' + B + '>\n</calls>';

/** 真机 ③：退役的 DSML 词形残留（0.16.23 起桥只扣留、不改写、不执行）。 */
const DSML_RESIDUE = '<' + B + 'tool' + S + 'calls' + S + 'begin' + B + '>\n<' + B + B + 'DSML' + B + B + ' calls>\n<'
  + B + B + 'DSML' + B + B + ' invoke name="pwsh">\n<' + B + B + 'DSML' + B + B + ' parameter name="command" string="true">Write-Output hello<'
  + B + B + 'DSML' + B + B + ' parameter>\n<' + B + B + 'DSML' + B + B + ' invoke>\n<' + B + B + 'DSML' + B + B + ' calls>';

test('① 真机残骸形状必须被命名（修前这 25 条 diagnostics 全空）', () => {
  for (const [label, text] of [['工具名并进 begin', MERGED_NAME], ['sep 残缺', BROKEN_SEP], ['DSML 残留', DSML_RESIDUE]]) {
    const res = parseAgentReply(text, { tools: TOOLS });
    assert.equal(res.calls.length, 0, `${label}：这次不要求解析成功（宽容度不动）`);
    assert.ok(res.diagnostics.length > 0, `${label}：必须有诊断，否则模型看不到病灶`);
    assert.match(res.diagnostics[0], /protocol anchors present but no parseable call/, label);
  }
});

test('① 判语必须点名具体形状（不是一句泛泛的「解析失败」）', () => {
  assert.match(parseAgentReply(MERGED_NAME, { tools: TOOLS }).diagnostics[0], /工具名被并进/, '必须点出「工具名并进标记」');
  assert.match(parseAgentReply(BROKEN_SEP, { tools: TOOLS }).diagnostics[0], /sep 分隔标记残缺/, '必须点出 sep 残缺');
  assert.match(parseAgentReply(DSML_RESIDUE, { tools: TOOLS }).diagnostics[0], /DSML/, '必须点出退役协议');
});

test('① 诊断不得改变宽容度：能解析的照旧解析，且不产生诊断', () => {
  const good = '<' + B + 'tool' + S + 'calls' + S + 'begin' + B + '>\n<' + B + 'tool' + S + 'call' + S + 'begin' + B
    + '>read<' + B + 'tool' + S + 'sep' + B + '>{"file_path":"a.md"}\n<' + B + 'tool' + S + 'call' + S + 'end' + B
    + '>\n<' + B + 'tool' + S + 'calls' + S + 'end' + B + '>';
  const res = parseAgentReply(good, { tools: TOOLS });
  assert.equal(res.calls.length, 1);
  assert.equal(res.calls[0].name, 'read');
  assert.deepEqual(res.diagnostics, [], '正常轮不该被诊断污染');
});

test('① 普通散文不得被误诊（没有协议标记就不该有判语）', () => {
  assert.equal(describeUnparsedProtocolShape('我已经检查完了，结论是依赖没有变化。'), null);
  assert.equal(describeUnparsedProtocolShape(''), null);
  // 真机里那条合法收束答复（session 里问「要哪个？还是 A+B 一起走？」）同型
  assert.equal(parseAgentReply('要哪个？还是 A+B 一起走？', { tools: TOOLS }).diagnostics.length, 0);
});

test('① 0.16.25 红线同时成立：第二对象仍拒收，但现在必须带诊断', () => {
  const bad = '<' + B + 'tool' + S + 'calls' + S + 'begin' + B + '>\n<' + B + 'tool' + S + 'call' + S + 'begin' + B
    + '>edit<' + B + 'tool' + S + 'sep' + B + '>{"file_path":"a.md","old_string":"a"},{"replace_all":false}\n<'
    + B + 'tool' + S + 'call' + S + 'end' + B + '>\n<' + B + 'tool' + S + 'calls' + S + 'end' + B + '>';
  const res = parseAgentReply(bad, { tools: TOOLS });
  assert.equal(res.calls.length, 0, '多挂第二对象必须继续拒收（只续跑、不代拼）');
  assert.ok(res.diagnostics.length > 0, '拒收必须留痕');
  assert.match(res.diagnostics.join(' '), /trailing content|not a single balanced/, '诊断必须点名真实病灶');
});

test('① 竖线写成两枚以上时必须点出来（0.16.30 那条病灶的孪生形态）', () => {
  const dbl = '<' + B + B + 'tool' + S + 'call' + S + 'begin' + B + B + '>read<' + B + B + 'tool' + S + 'sep' + B + B
    + '>{"file_path":"a.md"}\n<' + B + B + 'tool' + S + 'call' + S + 'end' + B + B + '>';
  const res = parseAgentReply(dbl, { tools: TOOLS });
  // 双竖线是**能解析**的（0.16.30 已放宽），所以这条只钉「解析成功」这件事不被诊断影响
  assert.ok(res.calls.length >= 1 || /竖线/.test(res.diagnostics.join(' ')), '双竖线要么解析成功，要么被点名');
});
