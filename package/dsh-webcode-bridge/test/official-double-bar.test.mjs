// official-double-bar.test.mjs — 0.16.30 护栏：官方 token 的**双竖线**漂移形状。
//
// ## 为什么有本文件
//
// 用户报「版本更新后自动化流程被打断，每轮都错，明明之前还好」。真机取证
// （~/.dsh/logs/webcode-bridge-replies.log，2026-09-20 08:05 读数）锁定病灶：
// 模型把官方标记的包裹竖线写成**两枚** U+FF5C：
//
//   <｜｜tool▁calls▁begin｜>
//   <｜｜tool▁call▁begin｜>pwsh<｜｜tool▁sep｜>{"command":"pwd"}<｜｜tool▁call▁end｜>
//   <｜｜tool▁calls▁end｜>
//
//   逐字样本会话：session-d8e01269-b8e8-4a4a-936b-d26c505bdb15
//   （同会话里唯一成功的一轮 `chars=245 calls=1` 用的正是**单**竖线；
//     其余各轮全为双竖线、`calls=0` → 每轮 TOOL_CALL_UNPARSED。）
//
// 0.16.18–0.16.29 的所有正则都写死 `'<' + 单枚 OFFICIAL_BAR`，紧跟 `\s*`。
// `\s*` **吃不下第二枚竖线**，于是整族一条正则都不命中 —— 症状不是「少解析
// 一点」，是**每条调用都归零**：
//   · findProtocolStart → -1（边界探测认不出）
//   · normalizeOfficialToolCalls → 原文逐字不变（改不动）
//   · parseAgentReply → calls=0 ⇒ 每轮 UNPARSED、自动化整轮空转
//
// 全日志双竖线共 9,803 处：DSML 时代 9,764 处（`<｜｜DSML｜｜ invoke …>`），
// 官方 token 族 25 处（本次故障现场）。DSML 那族当年**有** `{1,3}` 宽容
// （见 agent-preset.js 的 DSML_BAR_CLS），官方族从 0.16.18 引入起就**没有**——
// 这就是「明明之前还好、新版本一直错」的形状学解释：协议换成了官方族，
// 而官方族缺了 DSML 族一直有的那条宽容。
//
// ## 钉住什么
//
// ① 双竖线**完整调用**可解析（单条 / 多条 / 无参）；② 参数逐字不丢；
// ③ 单竖线既有行为**不回归**（放宽不能弄坏正确形状）；
// ④ 三枚竖线也认（OFFICIAL_BAR_CLS 上界）；⑤ 四枚竖线**不**认（上界有效，
//    防无界量词把噪声串吞进协议判定）；
// ⑥ partialProtocolAt 对双竖线半成品扣留（流式泄漏窗口，与主解析同一盲区）；
// ⑦ findProtocolStart 对双竖线返回边界（流式不把协议原文当正文外发）。
//
// 全部标记用 charCode 现造（official-drift.test.mjs 同款纪律：源文件里不出现
// 真实全角竖线，避免编辑器/编码环节悄悄改写夹具）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentReply, findProtocolStart, normalizeOfficialToolCalls, partialProtocolAt, trainNoteFor } from '../lib/agent-preset.js';

const B = String.fromCharCode(0xFF5C);
const BB = B + B;
const S = String.fromCharCode(0x2581);
/** 双竖线 token 构造器：与官方 token 同形，仅包裹竖线重复。 */
const tok2 = (w) => '<' + BB + 'tool' + w.map((x) => S + x).join('') + BB + '>';
const CALLS_BEGIN2 = tok2(['calls', 'begin']);
const CALL_BEGIN2 = tok2(['call', 'begin']);
const SEP2 = tok2(['sep']);
const CALL_END2 = tok2(['call', 'end']);
const CALLS_END2 = tok2(['calls', 'end']);

const T = [
  { name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } } },
  { name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' } } } },
  { name: 'cordis_inspect_list', parameters: { type: 'object', properties: {} } },
];

test('真机形状：双竖线单调用（reply-log 08:05 逐字形状）—— 修复前 calls=0', () => {
  const raw = CALLS_BEGIN2 + '\n'
    + CALL_BEGIN2 + 'pwsh' + SEP2 + '{"command":"pwd; Get-ChildItem -Force | Select-Object Mode,Length,Name","description":"Print working directory and list files"}' + CALL_END2 + '\n'
    + CALLS_END2;
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'pwsh');
  assert.equal(calls[0].arguments.command, 'pwd; Get-ChildItem -Force | Select-Object Mode,Length,Name');
  assert.equal(calls[0].arguments.description, 'Print working directory and list files');
});

test('真机形状：双竖线多调用（reply-log 三条 pwsh/glob 逐字形状）—— 修复前 calls=0', () => {
  const raw = CALLS_BEGIN2 + '\n'
    + CALL_BEGIN2 + 'pwsh' + SEP2 + '{"command":"Get-Location","description":"Show working directory"}' + CALL_END2 + '\n'
    + CALL_BEGIN2 + 'read' + SEP2 + '{"file_path":"doc/progress.md","offset":1}' + CALL_END2 + '\n'
    + CALLS_END2;
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls.map((c) => c.name), ['pwsh', 'read']);
  assert.equal(calls[1].arguments.file_path, 'doc/progress.md');
  assert.equal(calls[1].arguments.offset, 1);
});

test('双竖线无参调用：arguments 逐字为 {}（不因宽容丢空参判定）', () => {
  const raw = CALLS_BEGIN2 + CALL_BEGIN2 + 'cordis_inspect_list' + SEP2 + '{}' + CALL_END2 + CALLS_END2;
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'cordis_inspect_list');
  assert.deepEqual(calls[0].arguments, {});
});

test('单竖线既有行为不回归：官方正确形状仍逐字可解析', () => {
  const tok = (w) => '<' + B + 'tool' + w.map((x) => S + x).join('') + B + '>';
  const raw = tok(['calls', 'begin']) + tok(['call', 'begin']) + 'pwsh' + tok(['sep'])
    + '{"command":"node --version","description":"Check node"}' + tok(['call', 'end']) + tok(['calls', 'end']);
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'pwsh');
  assert.equal(calls[0].arguments.command, 'node --version');
});

test('双竖线：normalizeOfficialToolCalls 真的改写成规范 invoke 形', () => {
  const raw = CALLS_BEGIN2 + CALL_BEGIN2 + 'pwsh' + SEP2 + '{"command":"pwd"}' + CALL_END2 + CALLS_END2;
  const norm = normalizeOfficialToolCalls(raw);
  assert.ok(norm.includes('<invoke name="pwsh">'), 'must rewrite to canonical invoke: ' + norm);
  assert.ok(norm.includes('<calls>'), 'must map wrapper open token: ' + norm);
  assert.ok(norm.includes('</calls>'), 'must map wrapper close token: ' + norm);
  assert.ok(!norm.includes(BB), 'no double bar may survive normalization: ' + norm);
});

test('双竖线：findProtocolStart 认出边界（流式不把协议原文当正文外发）', () => {
  const raw = '前言\n' + CALLS_BEGIN2 + CALL_BEGIN2 + 'pwsh' + SEP2 + '{"command":"pwd"}' + CALL_END2 + CALLS_END2;
  const { index, transport } = findProtocolStart(raw);
  assert.equal(index, 3, 'boundary must land on the marker, not -1');
  assert.equal(transport, true);
});

test('三枚竖线也认（OFFICIAL_BAR_CLS 上界内）', () => {
  const B3 = B + B + B;
  const t3 = (w) => '<' + B3 + 'tool' + w.map((x) => S + x).join('') + B3 + '>';
  const raw = t3(['calls', 'begin']) + t3(['call', 'begin']) + 'pwsh' + t3(['sep'])
    + '{"command":"pwd"}' + t3(['call', 'end']) + t3(['calls', 'end']);
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'pwsh');
});

test('四枚竖线**不**认（上界有效：无界量词会给噪声串发奖励）', () => {
  const B4 = B + B + B + B;
  const t4 = (w) => '<' + B4 + 'tool' + w.map((x) => S + x).join('') + B4 + '>';
  const raw = t4(['calls', 'begin']) + t4(['call', 'begin']) + 'pwsh' + t4(['sep'])
    + '{"command":"pwd"}' + t4(['call', 'end']) + t4(['calls', 'end']);
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.equal(calls.length, 0, 'four bars is out of the tolerated range on purpose');
});

test('partialProtocolAt：双竖线半成品必须扣留（修复前返回 -1 → 半截 token 漏成正文）', () => {
  assert.ok(partialProtocolAt('hi<' + BB + 'to') >= 0, 'double-bar partial prefix must be withheld');
  assert.ok(partialProtocolAt('hi<' + BB + 'tool' + S + 'calls') >= 0, 'cut inside double-bar token must be withheld');
  assert.ok(partialProtocolAt('hi<' + BB + 'tool' + S + 'calls' + S + 'begin') >= 0, 'cut at tail of double-bar token must be withheld');
});

test('partialProtocolAt：普通散文仍不扣（放宽不能把正文扣住）', () => {
  assert.equal(partialProtocolAt('hello world'), -1);
  assert.equal(partialProtocolAt('a < b and c > d'), -1);
});

test('再教学提示点名真实病灶：声明竖线只需一枚', () => {
  const note = trainNoteFor('deepseek', '', T);
  assert.ok(note.includes('一枚'), 'teaching must state the one-bar rule: ' + note);
  assert.ok(note.includes(B), 'teaching must show the actual bar character');
});
