// dsml-real-drift-2026-09-19.test.mjs — 长跑第 2/3/4/7 轮真机漂移夹具的可执行护栏。
//
// 真实调用失误的逐字原文（取法见各用例；均为桥日志/会话存档逐字，未经手改）：
//   15 = run-2 简写参数头（session-7e16d083，0.16.11，扣留 1103 字符，只存头 200）
//   16 = run-3 头部正常型（0.16.12，扣留 1103 字符，只存头 200，畸形在 200 之后未落盘）
//   17 = run-4 缺 invoke 开标签全文（session-9a6e69f3，0.16.13，扣留 949 字符全文）
//   19/20 = run-7 熔接形（session-6541b055 / session-489b0093，0.16.15，见下）
//
// 共同后果（15–17）：UNPARSED 提示是纯文本轮，headless agent 循环把它当最终答案收场
// （13min / 8min / 10min 三次提前终止）。本文件钉住三件事：
//   ① 协议原文无论形状如何都不得漏成正文（proseSafeEnd 安全方向）；
//   ② 简写漂移（15）经宽容层可救；17 的全文在**小工具表**下可恢复 ≥2 条；
//   ③ 17 在**大工具表**下恢复 0 条——`{pattern,path}` 在 grep/glob 都声明、
//     `{file_path}` 多工具共用，按「不唯一不猜」红线（#23 护栏⑦）推断落空。
//     这就是「离线 2 条、运行时 0 条」的根源，钉在这里供验收与后续决策。
//
// 19/20 的口径（0.16.16）：熔接形解析**成功**、不入 UNPARSED 扣留，原始网页回复
// 未落盘；残片逐字取自会话存档 tool/call 的 args 值（f19 的 path 值尾、f20 的
// file_path 值尾与 `…client.cjs</ parameter name="limit" string="false">290`，
// 与 session.v3 逐字节一致），外层骨架按夹具 15 同款原生风格（标记 + string= 属性）
// 重构——重构经红基线验证：0.16.15 代码上解析出的污染值与存档逐字相同，才是本夹具。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parseAgentReply, proseSafeEnd, recoverUnparsedCalls } from '../lib/agent-preset.js';

const FIX = (f) => readFileSync(path.join(import.meta.dirname, 'fixtures', f), 'utf8');
const f15 = FIX('dsml-real-15-run2-shorthand-param-head.txt');
const f16 = FIX('dsml-real-16-run3-head-clean-unknown.txt');
const f17 = FIX('dsml-real-17-run4-no-invoke-open-full.txt');
const f18 = FIX('dsml-real-18-run6-mangled-closers-full.txt');
const f19 = FIX('dsml-real-19-run7-fused-close-grep.txt');
const f20 = FIX('dsml-real-20-run7-fused-close-read.txt');

const T_SMALL = [
  { name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'grep', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } } } },
  { name: 'glob', parameters: { type: 'object', properties: { pattern: { type: 'string' } } } },
];
// 大工具表的关键差异：glob 也声明 path（真实 DSH 会话 24 工具表的形态）
const T_BIG = [
  ...T_SMALL,
  { name: 'glob2', description: 'glob with optional path', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } } } },
  { name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
];

test('15（简写参数头）：协议原文必须被扣住，不漏正文；宽容层已能救同族形状', () => {
  const r = parseAgentReply(f15, { tools: T_SMALL });
  assert.equal(r.calls.length, 0, '200 字符头本身不构成完整调用');
  const safe = proseSafeEnd(f15, 0);
  assert.ok(safe <= f15.indexOf('file_path='), '边界必须停在协议起点，不得外发');
});

test('16（头部正常型）：头 200 字符按协议扣住，无泄漏、无伪调用', () => {
  const r = parseAgentReply(f16, { tools: T_SMALL });
  assert.equal(r.calls.length, 0, '头本身无闭合，不得伪解析');
  assert.ok(proseSafeEnd(f16, 0) < f16.length, '不得整段当正文');
});

test('17（缺 invoke 开标签全文）：小工具表下可恢复 ≥2 条，主解析同样受益', () => {
  const rec = recoverUnparsedCalls(f17, T_SMALL);
  assert.ok(rec.length >= 2, `小工具表至少恢复 2 条，实际 ${rec.length}`);
  assert.ok(rec.every((c) => ['read', 'glob', 'grep'].includes(c.name)), '只允许白名单只读工具');
  const parsed = parseAgentReply(f17, { tools: T_SMALL });
  assert.ok(parsed.calls.length >= 1, '宽容层让主解析也吃到同一文本');
});

test('17：大工具表下必须恢复（0.16.14 契约：严格推断或白名单内宽容，二者其一）', () => {
  // 0.16.13 运行时的实测：{pattern,path} 在 grep/glob 都声明 → 严格推断不唯一 →
  // 按当时的红线整簇放弃（长跑第 4 轮终止的直接原因）。0.16.14 起两条路都通：
  // 严格推断命中（实测 T_BIG 下 inferToolNameFromArgs 仍唯一解出 grep）→ 照常；
  // 未命中但候选全部在只读白名单内 → 取第一个可行者并标 ambiguous，
  // 由 RECOVERED_CALL 提示如实告知模型；候选涉及写类工具仍整簇放弃。
  const rec = recoverUnparsedCalls(f17, T_BIG);
  assert.ok(rec.length >= 1, `大工具表必须恢复，实际 ${rec.length}`);
  assert.ok(rec.every((c) => ['read', 'glob', 'grep'].includes(c.name)), '恢复的每个名字都在白名单内');
});

// 18 = run-6 闭标记残缺全文（session-d35267c1，0.16.14，扣留 981 字符全文）：
// 参数闭标记丢标签名（`</｜｜DSML｜｜>`）+ invoke 闭标记丢斜杠（`<｜｜DSML｜｜ invoke>`）。
// 恢复层预修（结构上唯一解）：无 name 属性的开形 invoke 只能是漏 `/` 的闭标签；
// 缺名的闭标记只能是 parameter 闭。0.16.15 起生效。
test('18（闭标记残缺全文）：恢复层预修后 4 条全部恢复（3 grep + 1 read）', () => {
  const tools = [
    { name: 'grep', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } } } },
    { name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } },
  ];
  const rec = recoverUnparsedCalls(f18, tools);
  assert.equal(rec.length, 4, `应恢复 4 条，实际 ${rec.length}`);
  assert.equal(rec.filter((c) => c.name === 'grep').length, 3);
  assert.equal(rec.filter((c) => c.name === 'read').length, 1);
  assert.ok(rec[0].arguments.pattern.startsWith('child_process|execSync|spawnSync'), '首条 pattern 必须来自真机原文');
});

// 19/20 = run-7 熔接形（0.16.16 修，见文件头口径说明）。真机后果：0.16.15 下
// 这两类调用都**派发了**（isError 回流）：grep ×4 报 missing required property
// "pattern"，read ×1 报 cannot read … not found——模型在 session-6541b055 连续
// 4 次写出同形都失败。这里钉住：参数值必须干净、丢失的参数必须回来。
test('19（熔接 grep）：path/pattern 双双干净解出，残片不得粘进任何值', () => {
  const r = parseAgentReply(f19, { tools: T_SMALL });
  assert.equal(r.calls.length, 1, `应解出 1 条 grep，实际 ${r.calls.length} 条，diagnostics=${JSON.stringify(r.diagnostics)}`);
  assert.equal(r.calls[0].name, 'grep');
  assert.equal(r.calls[0].arguments.path, 'D:\\9_Code_Workspace\\dsh-webcode-bridge\\package\\dsh-webcode-bridge',
    'path 值必须与真机 tool/call 存档里的预期路径逐字一致（残片剥净）');
  assert.equal(r.calls[0].arguments.pattern, 'fake-extension|run-m1',
    'pattern 参数必须回来（0.16.15 下整体丢失 → missing required property）');
  assert.ok(!JSON.stringify(r.calls[0].arguments).includes('parameter name='), '任何参数值不得残留熔接残片');
});

test('20（熔接 read）：file_path 干净、limit/offset 双双解出', () => {
  const r = parseAgentReply(f20, { tools: T_SMALL });
  assert.equal(r.calls.length, 1, `应解出 1 条 read，实际 ${r.calls.length} 条，diagnostics=${JSON.stringify(r.diagnostics)}`);
  assert.equal(r.calls[0].name, 'read');
  assert.equal(r.calls[0].arguments.file_path, 'D:\\9_Code_Workspace\\dsh-webcode-bridge\\package\\dsh-webcode-bridge\\lib\\client.cjs');
  assert.equal(String(r.calls[0].arguments.limit), '290',
    'limit 必须回来（0.16.15 下被熔进 file_path → cannot read … not found）');
  assert.equal(String(r.calls[0].arguments.offset), '2120', 'offset 本就正常，钉住不回归');
});
