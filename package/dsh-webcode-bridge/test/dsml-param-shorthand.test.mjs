// dsml-param-shorthand.test.mjs — 0.16.12 护栏：参数开标记的「简写漂移」宽容（#25 同族）。
//
// 真机取证（长跑会话 session-7e16d083 turn1 step15，2026-09-19 01:51，扣留 1103 字符、
// 见 .tmp/longrun2-stderr.log 的 UNPARSED 提示与 doc/diagnosis-2026-09-19.md 后续补记）：
// 模型把参数开标记写成 `<｜｜DSML｜｜ file_path="…">` —— 丢了 `parameter name=`，
// 直接拿属性名当开头。normalizeDsml 剥掉标记后剩 `< file_path="…</parameter>`，
// 参数状态机认不出 → 整条 invoke 丢弃 → UNPARSED → 无人值守循环把纯文本提示轮
// 当最终答复收场（长跑第 2 轮 13 分钟提前终止的直接根因）。
//
// 修法（宽容层纪律，PROMPT-ENGINEERING.md §二）：`<\s+attr="…</parameter>` →
// `<parameter name="attr">…</parameter>`。attr 名即参数名，**不是猜**——这是标记
// 语法本身的结构；与 normalizeDsml 认 `DSH/DS` 词形同一先例。散文里
// 「无标签名属性 + 紧跟 </parameter>」的组合实际不可出现，反向安全线仍然保留。
//
// 夹具口径：头三行是**真机逐字**（来自 UNPARSED 提示的扣留头，200 字符窗口）；
// 第 4 行起为**最小补全**（真机原文只存了头 200 字符，扣留全文按设计不落盘），
// 补全部分让结构闭合以便断言「修复后能解出完整调用」。

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDsml, parseAgentReply } from '../lib/agent-preset.js';

const B = String.fromCharCode(0xFF5C) + String.fromCharCode(0xFF5C);
const MARK = '<' + B + 'DSML' + B + ' ';
// 真机逐字（扣留头，逐字符照抄 .tmp/longrun2-stderr.log 的提示）
const DRIFT_HEAD = MARK + 'calls>\n' + MARK + 'invoke name="read">\n'
  + MARK + 'file_path="package/dsh-webcode-bridge/lib/web-control.js</' + B + 'DSML' + B + ' parameter>\n'
  + MARK + 'parameter name="limit" string="false">130</' + B + 'DSML' + B + ' par';
// 最小补全（非真机逐字，注明见头注释）
const DRIFT_COMPLETED = DRIFT_HEAD + 'ameter>\n</' + B + 'DSML' + B + ' invoke>\n</' + B + 'DSML' + B + ' calls>';

const TOOLS = [{
  name: 'read',
  description: '读文件',
  parameters: { type: 'object', properties: { file_path: { type: 'string' }, limit: { type: 'number' } } },
}];

test('修复后：normalizeDsml 把简写参数标记还原成 parameter name=…', () => {
  const out = normalizeDsml(DRIFT_COMPLETED);
  assert.ok(out.includes('<parameter name="file_path">package/dsh-webcode-bridge/lib/web-control.js</parameter>'),
    '简写漂移必须还原成规范 parameter 标签');
});

test('修复后：真机漂移块（+最小补全）解出 1 条 read 调用，参数齐全', () => {
  const r = parseAgentReply(DRIFT_COMPLETED, { tools: TOOLS });
  assert.equal(r.calls.length, 1, `应解出 1 条调用，实际 ${r.calls.length} 条，diagnostics=${JSON.stringify(r.diagnostics)}`);
  assert.equal(r.calls[0].name, 'read');
  assert.equal(r.calls[0].arguments.file_path, 'package/dsh-webcode-bridge/lib/web-control.js');
  // string="false" → number 的类型纠偏发生在派发层 coerceArguments（既有分层），
  // 解析层按原文保留字符串：这里只断言值本身完整。
  assert.equal(String(r.calls[0].arguments.limit), '130');
  assert.deepEqual(r.diagnostics, []);
});

test('反向安全线：规范的 parameter 标签不受改写影响', () => {
  const proper = MARK + 'parameter name="command" string="true">ls -la</' + B + 'DSML' + B + ' parameter>';
  const out = normalizeDsml(proper);
  // 既有行为（与本规则无关，逐字钉住）：repairNamelessClosers 给游离参数标签补
  // `<invoke name="">` 外壳（夹具 7 家族）；剥标记后闭标签保留空格 `</ parameter>`
  //（解析层的 `<\s*\/\s*parameter\s*>` 容得下）。这里断言**新规则没有碰它**。
  assert.equal(out,
    '<invoke name=""><parameter name="command" string="true">ls -la</ parameter>',
    '规范形态只做剥标记与补壳，属性与值逐字保留');
});

test('反向安全线：散文里「无标签名的属性写法」在没有 </parameter> 收口时不改写', () => {
  const prose = '这行 HTML 少了标签名：< div ="x" 以及 < span ="y"。';
  assert.equal(normalizeDsml(prose), prose, '散文必须逐字不动');
});

test('反向安全线：散文里讲解协议的规范标签一字不动', () => {
  const doc = '文档示例：<parameter name="path">value</parameter> 是规范写法。';
  assert.equal(normalizeDsml(doc), doc, '无 DSML 标记的文本必须逐字不动');
});
