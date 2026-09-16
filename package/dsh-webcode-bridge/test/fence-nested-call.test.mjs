// fence-nested-call.test.mjs — 参数里自带 markdown 围栏的调用必须被解析出来（0.15.6）。
//
// ## 为什么需要它（0.15.5 引入的真回归）
//
// `fence-prose.test.mjs`（0.15.5）修的是「**普通** markdown 围栏被误判成协议」，
// 它的判据是「围栏体内要有 JSON + 调用关键字段」。但那条判据的**窗口取错了**：
// 窗口终点用的是「下一个 ```」，而参数值自带的围栏正好就是下一个 ```。
//
// 于是 `write` 一份含代码块的 markdown 文档（写报告/README/代码的主路径）时：
//
//   1. `parseAgentReply` 的非贪婪围栏正则 `/```([\s\S]*?)```/` 在**第一个内层
//      ```** 处截断体 → JSON.parse 失败 → `takeObj` 静默 return → **调用消失，
//      文件从未落盘，且没有任何日志**；
//   2. `firstCallFenceAt` 用同一个错误窗口 → `hasJson=false` → 真调用围栏被判成
//      普通围栏 → `findProtocolStart` 返回 **-1**；
//   3. `proseSafeEnd` 在 index=-1 时直接返回全文长度 → **整段原始协议被当正文
//      外发并持久化**。
//
// 用户可见症状：**harness 端 markdown 整块不见，只剩一坨原始 JSON**（网页端正常）。
//
// A/B 实测（.tmp/probe-audit-regress.mjs，同一段文本）：
//
//   0.15.3： boundary=53  proseSafeEnd=53  withheld=313  parsedCalls=0
//   0.15.5： boundary=-1  proseSafeEnd=366 withheld=0    parsedCalls=0   ← 全文泄漏
//   0.15.6： boundary=53  proseSafeEnd=53  withheld=313  parsedCalls=1   contentIntact=true
//
// 即：0.15.3 好歹扣住了协议（只是丢调用），0.15.5 把「扣住」变成了「全泄漏」。
//
// ## 修法（两侧统一到同一个定位器）
//
// 「什么算围栏体」只该有一份知识：`readCallAt` 逐字符处理字符串内的 `\"` / `\\`
// 转义与花括号配平，参数值里的 ``` 不再能截断它。`parseAgentReply` 与
// `firstCallFenceAt` 现在都用 `fenceCallBodyAt`（内部包 `readCallAt`）。
//
// ## 反向验证纪律（doc/comment-style.md §9.3）
//
// 本文件的正向用例（①②③④）在修复前必须**红**——反向验证见 doc/verify.md。
// 同时 ⑤⑥⑦⑩ 是**反向安全线**：修 ② 不得削弱 0.15.5 的原始修复，也不得放过
// 0.9.2 / 0.14.6 / 0.15.0 三次泄漏事故的形态。
import test from 'node:test';
import assert from 'node:assert/strict';
import { findProtocolStart, proseSafeEnd, firstCallFenceAt, parseAgentReply } from '../lib/agent-preset.js';

// 全角竖线（U+FF5C）用转义写，避免源码里出现容易被编辑器/工具链改写的字面量。
const BAR = '\uFF5C';

/** 构造一个「围栏调用」文本，参数值里可自带 markdown 围栏。 */
function callText(name, args, preamble = 'I have everything I need. Writing the audit report:') {
  const obj = { mcp_action: 'call', name, purpose: 'Write the audit report', arguments: args };
  return `${preamble}\n\n\`\`\`json\n${JSON.stringify(obj)}\n\`\`\`\n`;
}

/** 一份真实形态的 markdown 报告正文：标题 + 表格 + 嵌套 json 围栏 + js 围栏。 */
const REPORT_BODY = [
  '# 项目状态审计（2026-09-16）',
  '',
  '**审计方式**：只读实测。',
  '',
  '| 面 | 状态 | 要害 |',
  '| --- | --- | --- |',
  '| 代码 / 测试 | OK | 37/37 通过 |',
  '',
  '```json',
  '{"version": "0.15.5", "hash": "44965def7059"}',
  '```',
  '',
  '### 1.1 三条缺陷',
  '',
  '```js',
  'const a = 1;',
  '```',
  '',
  '结束。',
  '',
].join('\n');

// ---- ① 正向：参数里带一组围栏，调用必须解析出来且内容逐字完整 ---------------

test('① write 调用、content 含一组 json 围栏 → 解析出 1 个调用，content 逐字完整', () => {
  const args = { file_path: 'doc/report.md', content: REPORT_BODY };
  const text = callText('write', args);
  const parsed = parseAgentReply(text);
  assert.equal(parsed.calls.length, 1, '参数自带围栏不得让调用消失（回归的根因）');
  assert.equal(parsed.calls[0].name, 'write');
  assert.equal(parsed.calls[0].arguments.content, REPORT_BODY, 'content 必须逐字等于输入，不得被围栏截断');
  assert.equal(parsed.calls[0].arguments.file_path, 'doc/report.md');
});

test('② 同上 → 边界探测停在围栏起点、transport=true（不得退化成 -1）', () => {
  const text = callText('write', { file_path: 'doc/a.md', content: REPORT_BODY });
  const fp = findProtocolStart(text);
  assert.equal(fp.index, text.indexOf('```'), '调用围栏必须是协议起点');
  assert.equal(fp.transport, true, '装真调用的围栏 transport 必须为真');
  assert.equal(fp.name, 'write');
});

test('③ 同上 → proseSafeEnd 停在围栏起点，协议被扣住而不是全文外发', () => {
  const text = callText('write', { file_path: 'doc/a.md', content: REPORT_BODY });
  const safe = proseSafeEnd(text, 0);
  assert.equal(safe, text.indexOf('```'), '正文外发终点必须正好是调用围栏起点');
  assert.ok(text.length - safe > 0, '被扣住的协议文本必须 > 0（0.15.5 这里是 0 = 全文泄漏）');
});

test('④ content 含三组不同类型围栏 → 仍解析出 1 个调用且内容完整', () => {
  const body = [
    '前言。', '',
    '```json', '{"a": 1}', '```', '',
    '```bash', 'git status', '```', '',
    '```', 'bare fence', '```', '',
    '结束。',
  ].join('\n');
  const text = callText('write', { file_path: 'doc/b.md', content: body });
  const parsed = parseAgentReply(text);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].arguments.content, body);
});

// ---- ② 反向安全线：0.15.5 的原始修复不得回归 ------------------------------

test('⑤ 普通 markdown 文档（无调用、含围栏）→ 仍是 -1，正文完整外发', () => {
  const text = '下面是示例：\n\n```js\nconst a = 1;\n```\n\n结束。';
  assert.equal(findProtocolStart(text).index, -1, '普通 markdown 围栏不得被判成协议起点');
  assert.equal(proseSafeEnd(text, 0), text.length, '正文必须完整外发');
  const doc = '配置示例：\n\n```json\n{"name": "demo", "value": 1}\n```\n\n完。';
  assert.equal(findProtocolStart(doc).index, -1, '普通 JSON 代码块不得被判成调用围栏');
  assert.equal(proseSafeEnd(doc, 0), doc.length);
});

test('⑥ 普通围栏 + 其后的调用围栏 → firstCallFenceAt 定位到后面那个', () => {
  const call = '{"mcp_action":"call","name":"read","arguments":{"file_path":"a.js"}}';
  const text = '```js\nconst a = 1;\n```\n\n```json\n' + call + '\n```';
  assert.equal(firstCallFenceAt(text), text.indexOf('```json'));
});

test('⑦ 裸 JSON 行在普通围栏内部 → 不得被判成调用（围栏奇偶判定不得反转）', () => {
  const text = '示例：\n\n```json\n{"mcp_action":"call","name":"read","arguments":{"file_path":"a.js"}}\n```\n\n以上是举例。';
  // 围栏内的对象**是**调用形状，firstCallFenceAt 认它（内容判据），
  // 但 firstBareJsonLineAt 走的是「裸 JSON 行」锚点，围栏内的一律跳过。
  // 这里钉住的是：嵌套围栏不会让「内部/外部」的判定反转。
  assert.equal(findProtocolStart(text).index, text.indexOf('```'), '围栏自身才是边界');
});

// ---- ③ 流式：未配平的调用围栏不得先泄漏 -----------------------------------

test('⑧ 流式半成品（JSON 未配平、参数里刚出现内层围栏）→ 仍是协议边界', () => {
  const text = '```json\n{"mcp_action":"call","name":"write","arguments":{"content":"```js\nconst a = 1;\n';
  const fp = findProtocolStart(text);
  assert.equal(fp.index, 0, '未配平的调用围栏必须立刻被认出（否则协议原文先外发）');
  assert.equal(fp.transport, true);
  assert.equal(proseSafeEnd(text, 0), 0, '半成品协议必须整段扣住');
});

// ---- ④ 其他参数形状 --------------------------------------------------------

test('⑨ arguments 是「转义 JSON 字符串」且内含围栏 → 仍解析出调用', () => {
  const inner = JSON.stringify({ file_path: 'doc/c.md', content: REPORT_BODY });
  const obj = { mcp_action: 'call', name: 'write', arguments: inner };
  const text = '写报告：\n\n```json\n' + JSON.stringify(obj) + '\n```\n';
  const parsed = parseAgentReply(text);
  assert.equal(parsed.calls.length, 1, '字符串形 arguments 必须被 normArgs 还原');
  assert.equal(parsed.calls[0].arguments.content, REPORT_BODY);
});

test('⑩ edit 调用、new_string 含围栏 → 解析出调用且内容完整', () => {
  const newString = '替换为：\n\n```js\nconst b = 2;\n```\n';
  const text = callText('edit', { file_path: 'lib/x.js', old_string: 'const a = 1;', new_string: newString });
  const parsed = parseAgentReply(text);
  assert.equal(parsed.calls.length, 1);
  assert.equal(parsed.calls[0].name, 'edit');
  assert.equal(parsed.calls[0].arguments.new_string, newString);
});

// ---- ⑤ 反向安全线：三次泄漏事故的形态必须仍被拦住 -------------------------

test('⑪ 三次事故的泄漏形态仍被拦住（不得因本次修法而放宽）', () => {
  const dsml = '<' + BAR + BAR + 'DSML' + BAR + BAR + 'tool_calls><' + BAR + BAR + 'DSML'
    + BAR + BAR + 'invoke name="read"><' + BAR + BAR + 'DSML' + BAR + BAR
    + 'parameter name="path">README.md';
  const shapes = [
    '正文之后 </tool_call>{"mcp_action":"call","name":"read","arguments":{"file_path":"a.js"}}',
    dsml,
    '**Calling:** `read`\n{"file_path":"README.md"}',
    '{"mcp_action":"call","name":"read","arguments":{"file_path":"a.js"}}',
  ];
  for (const s of shapes) {
    assert.ok(findProtocolStart(s).index >= 0, '泄漏形态必须仍是协议边界: ' + s.slice(0, 40));
  }
  // 孤立残片是**锚点**但不是**可执行调用**——「拦得住」与「执行它」是两件事。
  // 实测（本次会话）这五个残片的 transport 全是 false，且与 0.15.3 逐字相同：
  // 本次修法只动「围栏窗口怎么取」，没有碰标签族的 transport 判据。
  for (const frag of ['</tool_call>', '</call_call>', '</call>', '<call_call>', '<call>']) {
    const found = findProtocolStart(frag);
    assert.equal(found.transport, false, '孤立残片不是可执行调用: ' + frag);
    assert.equal(found.name, '', '孤立残片不携带工具名: ' + frag);
  }
});

// ---- ⑥ 诊断：丢调用不再静默 ------------------------------------------------

test('⑫ 形态像调用但 JSON 解析失败 → diagnostics 留痕（不再静默吞掉）', () => {
  // 形态取自 protocol-leak.test.mjs 的残片族：闭标签后面跟一个调用 JSON，
  // 再跟一个空对象——`takeObj` 拿到的是两段拼起来的东西，JSON.parse 必失败。
  // 实测 old/new 都是 0 调用（行为不变），但**旧实现连一句留痕都没有**。
  const text = '</tool_call>{"mcp_action":"call","name":"read"}\n{}';
  const parsed = parseAgentReply(text);
  assert.equal(parsed.calls.length, 0, '非法 JSON 不得被当成可执行调用');
  assert.ok(parsed.diagnostics.length > 0, '形态像调用的解析失败必须留痕（否则真机丢调用无法归因）');

  // `**Calling:**` 是网页原生渲染的调用形态，解析失败同样要留痕。
  const badCalling = '**Calling:** `write`\n{"mcp_action":"call","arguments":{"content":"x"';
  assert.ok(parseAgentReply(badCalling).diagnostics.length > 0, 'Calling 形态失败也要留痕');

  // 诊断字段恒存在（调用方无需判空），普通散文不产生噪音。
  assert.ok(Array.isArray(parseAgentReply('普通散文，没有协议。').diagnostics), '诊断字段恒存在');
  assert.equal(parseAgentReply('普通散文，没有协议。').diagnostics.length, 0, '普通散文不得刷诊断');
});