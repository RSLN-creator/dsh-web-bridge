// official-drift.test.mjs — 0.16.20 护栏：官方模板**漂移形状**的解析（run-10 双修）。
//
// ## 为什么
//
// run-10（session-33f37b03，2026-09-19 12:52–12:56，reply-log 20 轮逐字）：模型从
// 第 1 轮起就在官方模板上漂移——① 闭 token 写成 XML 斜杠形 `</｜tool▁call▁end｜>`
// （官方模板无斜杠）；② 多调用时漏写中间的 call▁begin、重复 calls▁begin。
// 0.16.18 改写器的端锚对两者都不设防：斜杠闭 token 不被认出 → 端锚（旧写法
// `calls?[\s\S]*?end` 允许从 begin 类 token 起配）跨到下一条调用的 begin token，
// **把下一条调用整块当端锚吃掉**；幸存首条的包裹开头又被 match 吞掉，无参安全线
// （insideCalls）失守 → cordis_inspect_list{} 三连灭（turn2/3 连续 3 轮 calls=0、
// turn4 每轮 2 条只执行 1 条、全程零诊断零通知）。
//
// 本文件钉住：run-10 的四种真机形状全部可解析、参数逐字不丢；围栏内漂移示例
// 仍不执行（run-9 围栏守卫）；规范官方形状不回归。全部标记用 charCode 现造
// （official-tool-calls.test.mjs 同款纪律）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentReply } from '../lib/agent-preset.js';

const B = String.fromCharCode(0xFF5C);
const S = String.fromCharCode(0x2581);
const tok = (w) => '<' + B + 'tool' + w.map((x) => S + x).join('') + B + '>';
const CALLS_BEGIN = tok(['calls', 'begin']);
const CALL_BEGIN = tok(['call', 'begin']);
const SEP = tok(['sep']);
const CALL_END = tok(['call', 'end']);
const CALLS_END = tok(['calls', 'end']);
/** run-10 漂移闭 token：XML 斜杠 + 官方 token。 */
const CALL_END_SLASHED = '</' + B + 'tool' + S + 'call' + S + 'end' + B + '>';

const T = [
  { name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' }, offset: { type: 'number' }, limit: { type: 'number' } } } },
  { name: 'grep', parameters: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } } } },
  { name: 'pwsh', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } } } },
  { name: 'cordis_inspect_list', parameters: { type: 'object', properties: {} } },
];

test('run-10 形状①：双调用（无参 cordis_inspect_list + read），闭 token 全带斜杠、漏 call▁begin —— reply-log 04:55:33 三连灭逐字形状', () => {
  const raw = CALLS_BEGIN + 'cordis_inspect_list' + SEP + '{}' + CALL_END_SLASHED + '\n'
    + CALLS_BEGIN + 'read' + SEP + '{"file_path":"lib/client.cjs","offset":2280,"limit":140}' + CALL_END_SLASHED + '\n'
    + CALLS_END;
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.deepEqual(calls, [
    { name: 'cordis_inspect_list', arguments: {} },
    { name: 'read', arguments: { file_path: 'lib/client.cjs', offset: 2280, limit: 140 } },
  ]);
});

test('run-10 形状②：pwsh×2 —— reply-log 04:56:02 逐字形状（旧代码吞掉第 2 条 Select-String）', () => {
  const raw = CALLS_BEGIN + 'pwsh' + SEP + '{"command":"node --test test/x.test.mjs","description":"Run tests","timeoutMs":180000}' + CALL_END_SLASHED + '\n'
    + CALLS_BEGIN + "pwsh" + SEP + '{"command":"Select-String -Path lib\\\\client.cjs -Pattern \'hwb-main\'"}' + CALL_END_SLASHED + '\n'
    + CALLS_END;
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].name, 'pwsh');
  assert.equal(calls[0].arguments.command, 'node --test test/x.test.mjs');
  assert.equal(calls[1].name, 'pwsh');
  assert.equal(calls[1].arguments.command, "Select-String -Path lib\\client.cjs -Pattern 'hwb-main'");
});

test('run-10 形状③：三调用杂交（首条漏 call▁begin、后两条规范 call▁begin）—— reply-log 04:53:40 逐字形状（旧代码吞中间条）', () => {
  const raw = CALLS_BEGIN + 'read' + SEP + '{"file_path":"package.json"}' + CALL_END_SLASHED + '\n'
    + CALL_BEGIN + 'read' + SEP + '{"file_path":"cordis.patch.yml"}' + CALL_END_SLASHED + '\n'
    + CALL_BEGIN + 'pwsh' + SEP + '{"command":"Get-ChildItem lib,bin -File"}' + CALL_END_SLASHED + '\n'
    + CALLS_END;
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.deepEqual(calls.map((c) => c.name), ['read', 'read', 'pwsh']);
  assert.deepEqual(calls[1].arguments, { file_path: 'cordis.patch.yml' });
  assert.deepEqual(calls[2].arguments, { command: 'Get-ChildItem lib,bin -File' });
});

test('run-10 形状④：单调用 + 斜杠闭 token、无收尾 CALLS_END —— 无参调用仍须执行（未配对开头补发后 insideCalls 成立）', () => {
  const raw = CALLS_BEGIN + 'cordis_inspect_list' + SEP + '{}' + CALL_END_SLASHED;
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.deepEqual(calls, [{ name: 'cordis_inspect_list', arguments: {} }]);
});

test('规范官方形状（无斜杠、带 call▁begin）不回归', () => {
  const raw = CALLS_BEGIN + CALL_BEGIN + 'grep' + SEP + '{"pattern":"等待发送","path":"lib"}' + CALL_END + CALLS_END;
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.deepEqual(calls, [{ name: 'grep', arguments: { pattern: '等待发送', path: 'lib' } }]);
});

test('围栏内的漂移形状是示例（run-9 围栏守卫优先于 0.16.20 改写），不执行', () => {
  const raw = '格式如下：\n```json\n' + CALLS_BEGIN + 'read' + SEP + '{"file_path":"a"}' + CALL_END_SLASHED + '\n' + CALLS_END + '\n```';
  const { calls } = parseAgentReply(raw, { tools: T });
  assert.equal(calls.length, 0);
});
