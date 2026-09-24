// quote-repair.test.mjs — 0.19.11 可选严格模式（`jsonQuoteRepair`）的护栏。
//
// 用户拍板（本轮问答）：「加严格模式、默认关闭」。因此本文件钉三件事：
//   ① 默认必须与 0.19.10 逐字同行为（开关关着时，能解析的照旧、坏形状照旧拒收）；
//   ② 开启后**只接受能完整 parse 的结果**（修不出合法对象 = 没修，照旧拒收）；
//   ③ **真机负结果必须留在护栏里**：那 10 条长 content 开启开关后仍恢复不出调用，
//      因为病根是「markdown 里的 json 片段 + 转义前后不一致」，字符串层面无法无歧义判定。
//      这条断言的作用不是「测试通过」，而是**不许有人以为开关一开问题就没了**。

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAgentReply, repairUnescapedQuotesInJsonStrings } from '../lib/agent-preset.js';

const TOOLS = [{ name: 'write', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } } } }];
const wrap = (body) => '<｜tool▁calls▁begin｜>\n<｜tool▁call▁begin｜>write<｜tool▁sep｜>' + body + '\n<｜tool▁call▁end｜>\n<｜tool▁calls▁end｜>';

/** 简单形态：单层对象，content 里有一枚裸引号（例如引用一个词）。 */
const SIMPLE = '{"file_path":"a.md","content":"他说 "你好" 然后就走了"}';
/** 真机形态：markdown ```json 片段 + 转义前后不一致（zero-00 的最小化）。 */
const NESTED = '{"file_path":"a.md","content":"实测：\\n```json\\n\\"total\\":   { "totalWaitMs": 113215468 }\\n\\"rows\\": [ { "label": "占比" } ]\\n```\\n"}';

test('① 默认关：坏形状照旧拒收（与 0.19.10 逐字同行为）', () => {
  for (const [label, body] of [['简单裸引号', SIMPLE], ['markdown 嵌套', NESTED]]) {
    const res = parseAgentReply(wrap(body), { tools: TOOLS });
    assert.equal(res.calls.length, 0, `${label}：默认关时不得被修复接受`);
  }
});

test('② 开启后只接受能完整 parse 的结果：简单形态被修好', () => {
  const res = parseAgentReply(wrap(SIMPLE), { tools: TOOLS, jsonQuoteRepair: true });
  assert.equal(res.calls.length, 1, '简单裸引号必须能修好');
  assert.equal(res.calls[0].name, 'write');
  // 修好之后内容里的引号是**真引号**（不是 \" 两个字面字符）
  assert.ok(String(res.calls[0].arguments.content).includes('"你好"'), '引号必须还原成真引号：' + res.calls[0].arguments.content);
});

test('③ 真机负结果：markdown 嵌套形态开启后**仍不恢复**（不许以为开关能治它）', () => {
  const res = parseAgentReply(wrap(NESTED), { tools: TOOLS, jsonQuoteRepair: true });
  assert.equal(res.calls.length, 0,
    '这条形状若开始被接受，说明启发式变了——必须重新做真机取证（见 repairUnescapedQuotesInJsonStrings 的负结果注释）');
});

test('③ 真机负结果的可复算口径：全量 100 条「0 调用」开启后恢复 0 条', () => {
  // 离线可复算的部分：本函数对「嵌套 markdown + 转义不一致」不产出合法 JSON。
  let ok = false;
  try { JSON.parse(repairUnescapedQuotesInJsonStrings(NESTED.slice(NESTED.indexOf('{'), NESTED.lastIndexOf('}') + 1))); ok = true; } catch { /* 预期失败 */ }
  assert.equal(ok, false, '若这条开始能 parse，必须重跑 .tmp/quote-repair-measure.mjs 更新真机读数');
});

test('① 开关不得改变**已能解析**的回复（只在失败后才生效）', () => {
  const good = wrap('{"file_path":"a.md","content":"普通内容"}');
  const off = parseAgentReply(good, { tools: TOOLS });
  const on = parseAgentReply(good, { tools: TOOLS, jsonQuoteRepair: true });
  assert.deepEqual(on.calls, off.calls, '开关不该改动正常轮的结果');
});
