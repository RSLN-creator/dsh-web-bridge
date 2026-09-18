// official-tool-calls.test.mjs — 0.16.18 护栏：官方 tool-call 训练模板的解析与教学。
//
// ## 为什么（用户拍板「官方做法优先，DSML 保留成备案不删除」）
//
// 官方模板逐字依据：HF deepseek-ai/DeepSeek-V3.1 tokenizer_config.json 的
// chat_template（2026-09-19 核对）——assistant 工具调用段是
// `<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>NAME<｜tool▁sep｜>{ARGS}<｜tool▁call▁end｜>…<｜tool▁calls▁end｜>`，
// 连接符 U+2581（▁）、竖线 U+FF5C。这是模型被**训练时**见过的形状；DSML（0.16.2 起
// 教学）在官方仓库零命中、无训练先验 → 长跑持续漂移（夹具 15–20、run-8 四形状、
// reply-log 21 份失败原文）。
//
// 红基线（0.16.17 代码实测，.tmp/probe-official-template.txt）：官方模板 0 calls 且
// proseSafeEnd=全长——整段漏成正文。本文件钉住：① 官方三词形（▁/空格/围栏漂移）
// 全部可解析；② 锚点先于改写命中（散文不漏）；③ 无参调用不再整条丢弃（run-8
// FAIL#3/4/5 真机逐字形状，cordis_inspect_list 是真实工具）；④ DSML 备案不回归。
// 全部标记用 charCode 现造，源码里不出现全角字符（dsml-repair.js 同款纪律）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentReply, proseSafeEnd, normalizeDsml, officialToolCallSpecimen, officialToolCallSkeleton } from '../lib/agent-preset.js';

const B = String.fromCharCode(0xFF5C);
const S = String.fromCharCode(0x2581);
const tok = (w) => '<' + B + 'tool' + w.map((x) => S + x).join('') + B + '>';
const CALLS_BEGIN = tok(['calls', 'begin']);
const CALL_BEGIN = tok(['call', 'begin']);
const SEP = tok(['sep']);
const CALL_END = tok(['call', 'end']);
const CALLS_END = tok(['calls', 'end']);

const T = [
  { name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' }, limit: { type: 'number' }, offset: { type: 'number' } } } },
  { name: 'grep', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } } } },
  { name: 'cordis_inspect_list', parameters: { type: 'object', properties: {} } },
];

test('官方模板（V3.1 ▁ 词形）单调用：散文保留、参数按原文类型收下', () => {
  const args = '{"file_path":"D:/x/a.js","limit":45,"offset":1}';
  const raw = '让我先读一下文件。\n' + CALLS_BEGIN + CALL_BEGIN + 'read' + SEP + args + CALL_END + CALLS_END;
  const r = parseAgentReply(raw, { tools: T });
  assert.equal(r.calls.length, 1, `应解出 1 条，diagnostics=${JSON.stringify(r.diagnostics)}`);
  assert.equal(r.calls[0].name, 'read');
  assert.equal(r.calls[0].arguments.file_path, 'D:/x/a.js');
  assert.equal(r.calls[0].arguments.limit, 45, 'JSON 原生数字保持 number');
  const safe = proseSafeEnd(raw, 0);
  assert.ok(raw.slice(0, safe).includes('让我先读一下文件'), '散文在前');
  assert.ok(!raw.slice(0, safe).includes('calls'), '调用段不得漏进正文');
});

test('官方模板多调用：calls 包裹内相邻两个 call 段全部解出', () => {
  const raw = CALLS_BEGIN + CALL_BEGIN + 'read' + SEP + '{"file_path":"a.js"}' + CALL_END
    + CALL_BEGIN + 'grep' + SEP + '{"pattern":"x|y","path":"lib"}' + CALL_END + CALLS_END;
  const r = parseAgentReply(raw, { tools: T });
  assert.deepEqual(r.calls.map((c) => c.name), ['read', 'grep']);
  assert.equal(r.calls[1].arguments.pattern, 'x|y', '半角竖线参数值不受全角标记影响');
});

test('旧代空格词形 + function 前缀 + ```json 围栏漂移均可解析', () => {
  const legacy = '<' + B + 'tool calls begin' + B + '><' + B + 'tool call begin' + B + '>function<'
    + B + 'tool sep' + B + '>```json\n{"file_path":"b.js"}\n```<' + B + 'tool call end' + B + '><' + B + 'tool calls end' + B + '>';
  const r = parseAgentReply(legacy, { tools: T });
  assert.equal(r.calls.length, 1, '旧模板词形必须兼容（两代训练先验都收）');
  assert.equal(r.calls[0].name, 'read');
  assert.equal(r.calls[0].arguments.file_path, 'b.js', '围栏必须剥掉');
});

test('无参工具：官方模板下 arguments={} 与 DSML 空 body invoke 都收下（run-8 FAIL#3/4/5 根因）', () => {
  const official = CALLS_BEGIN + CALL_BEGIN + 'cordis_inspect_list' + SEP + '{}' + CALL_END + CALLS_END;
  const r = parseAgentReply(official, { tools: T });
  assert.equal(r.calls.length, 1, '官方模板 {} 参数必须收下');
  assert.deepEqual(r.calls[0].arguments, {});
  const M = '<' + B + B + 'DSML' + B + B + ' ';
  const C = '</' + B + B + 'DSML' + B + B + ' ';
  const dsmlEmpty = M + 'calls>\n' + M + 'invoke name="cordis_inspect_list">\n' + C + 'invoke>\n' + C + 'calls>\n';
  const r2 = parseAgentReply(dsmlEmpty, { tools: T });
  assert.equal(r2.calls.length, 1, 'DSML 空 invoke 必须收下（真机逐字形状）');
  assert.deepEqual(r2.calls[0].arguments, {});
});

test('反向安全线：无名字的壳 invoke 维持丢弃（repairNamelessClosers 家族不受影响）', () => {
  const M = '<' + B + B + 'DSML' + B + B + ' ';
  const C = '</' + B + B + 'DSML' + B + B + ' ';
  const shell = M + 'parameter name="file_path">a.js' + C + 'parameter>';
  const r = parseAgentReply(shell, { tools: T });
  const nameless = r.calls.filter((c) => !c.name);
  assert.equal(nameless.length, 0, '空名字壳不得变成调用');
});

test('教学骨架：officialToolCallSpecimen/Skeleton 是官方逐字 token；normalizeDsml 能吃回自己教的形状', () => {
  const specimen = officialToolCallSpecimen();
  assert.ok(specimen.startsWith('<' + B + 'tool' + S + 'calls'), 'specimen 必须以官方 calls begin token 开头');
  assert.ok(specimen.endsWith('<' + B + 'tool' + S + 'calls' + S + 'end' + B + '>'), 'specimen 必须以官方 calls end token 结尾');
  const r = parseAgentReply(officialToolCallSkeleton(), { tools: T });
  assert.equal(r.calls.length, 2, '骨架占位名不是真实工具，但结构必须可解析为 2 条（随后被工具表过滤）');
});

test('备案不回归：DSML 标记家族在官方改写加入后行为不变', () => {
  const M = '<' + B + B + 'DSML' + B + B + ' ';
  const C = '</' + B + B + 'DSML' + B + B + ' ';
  const dsml = M + 'calls>\n' + M + 'invoke name="grep">\n' + M + 'parameter name="pattern">x|y' + C + 'parameter>\n' + C + 'invoke>\n' + C + 'calls>\n';
  const r = parseAgentReply(dsml, { tools: T });
  assert.equal(r.calls.length, 1, 'DSML 主路径不得被官方规则破坏');
  assert.equal(r.calls[0].arguments.pattern, 'x|y');
  // 官方 token 与 DSML 标记混写（模型漂移）也不互相污染
  const mixed = CALLS_BEGIN + CALL_BEGIN + 'read' + SEP + '{"file_path":"c.js"}' + CALL_END + CALLS_END
    + '\n' + M + 'invoke name="grep">\n' + M + 'parameter name="pattern">p' + C + 'parameter>\n' + C + 'invoke>';
  const r2 = parseAgentReply(mixed, { tools: T });
  assert.deepEqual(r2.calls.map((c) => c.name).sort(), ['grep', 'read'], '两种格式同轮混写全部收下');
});
