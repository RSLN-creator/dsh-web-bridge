// fence-prose.test.mjs — markdown 代码围栏不得被当成工具调用协议（0.15.5）。
//
// ## 为什么需要它（用户直接报的症状）
//
// 用户原话：**「你的回复网页端看 markdown 渲染正常，但是 harness 这里总是莫名奇妙的
// 没有渲染？# 后面没有空格？代码块包裹没有换行？导致没有闭合？」**
//
// 归因：桥的协议边界探测（`findProtocolStart` 的 `/```/` 锚点）把**任何** ``` 都当成
// 工具调用围栏的开头，于是 `proseSafeEnd` 一到围栏就停，围栏及其之后的正文被整段
// 丢弃。用户看到的「代码块没有换行、没有闭合」正是因为围栏本身被吞掉了。
//
// 实测证据（.tmp/fence-probe.mjs，修复前）：
//
//   输入「下面是示例：\n\n```js\nconst a = 1;\n```\n\n结束。」
//     → findProtocolStart.index = 8，proseSafeEnd = 8，**只外发 8/35 字符**
//   输入「# 标题\n\n正文段落。」（无围栏）
//     → index = -1，proseSafeEnd = 11，11/11 完整
//
// 修复后：普通 markdown 围栏 index = -1，proseSafeEnd = 35，**35/35 完整**。
//
// ## 安全线（反向，与正向同等重要）
//
// **装真调用的围栏必须照旧被拦住**。这不是「把 ``` 从锚点里删掉」那么简单——
// 那会让协议原文泄漏进正文（0.9.2 / 0.14.6 / 0.15.0 三次事故的共同形态）。
// 判据是「围栏之后是否很快出现带调用协议关键字段的 JSON」：
//   • `"mcp_action"` + `"call"`，或
//   • `"arguments"`
// 缺这两个特征的普通代码块才放行。
//
// ## 反向验证纪律（doc/comment-style.md §9.3）
// 护栏写完必须先证明能红。本文件的正向用例在修复前必须失败——
// 反向验证记录见 doc/verify.md。
import test from 'node:test';
import assert from 'node:assert/strict';
import { findProtocolStart, proseSafeEnd, firstCallFenceAt } from '../lib/agent-preset.js';

// ---- ① 正向：普通 markdown 围栏必须完整保留 --------------------------------

test('普通 js 围栏 → 不是协议边界，正文完整保留', () => {
  const text = '下面是示例：\n\n```js\nconst a = 1;\n```\n\n结束。';
  const fp = findProtocolStart(text);
  assert.equal(fp.index, -1, '普通 markdown 围栏不得被判成协议起点（用户报的渲染问题根因）');
  assert.equal(proseSafeEnd(text, 0), text.length, '正文必须完整外发，不能被围栏截断');
});

test('裸 ``` 围栏 + 后续长正文 → 完整保留', () => {
  const text = '前文。\n\n```\ncode\n```\n\n后文很长很长，这一段应该完整保留下来。';
  assert.equal(findProtocolStart(text).index, -1, '裸围栏不得被判成协议起点');
  assert.equal(proseSafeEnd(text, 0), text.length, '围栏之后的正文不得被丢弃');
});

test('bash / python / json 围栏（不含 arguments）→ 全部完整保留', () => {
  for (const lang of ['bash', 'python', 'json', 'yaml', 'text']) {
    const text = `示例：\n\n\`\`\`${lang}\nsome code here\n\`\`\`\n\n后续说明。`;
    assert.equal(findProtocolStart(text).index, -1, `${lang} 围栏不得被判成协议`);
    assert.equal(proseSafeEnd(text, 0), text.length, `${lang} 围栏后的正文不得被截断`);
  }
});

test('markdown 标题与列表（# 后带空格）不受影响', () => {
  const text = '# 标题\n\n## 二级\n\n- 列表项一\n- 列表项二\n\n正文。';
  assert.equal(findProtocolStart(text).index, -1, 'markdown 标题不得被判成协议');
  assert.equal(proseSafeEnd(text, 0), text.length);
});

test('代码块内的 JSON（无 arguments 字段）→ 保留', () => {
  const text = '配置示例：\n\n```json\n{"name": "demo", "value": 1}\n```\n\n完。';
  assert.equal(findProtocolStart(text).index, -1, '普通 JSON 代码块不得被判成调用围栏');
  assert.equal(proseSafeEnd(text, 0), text.length);
});

// ---- ② 反向安全线：装真调用的围栏必须照旧被拦 ------------------------------

test('装 mcp_action 调用的围栏 → 必须拦住（不得泄漏进正文）', () => {
  const text = '好的，我来执行。\n\n```json\n{"mcp_action":"call","name":"pwsh","arguments":{"command":"ls"}}\n```\n';
  const fp = findProtocolStart(text);
  assert.ok(fp.index >= 0, '装调用的围栏必须被认成协议起点（否则协议原文泄漏）');
  assert.ok(fp.index < text.indexOf('"mcp_action"'), '边界必须停在调用 JSON 之前');
});

test('装 name+arguments 的围栏（无 mcp_action）→ 必须拦住', () => {
  const text = '执行：\n\n```json\n{"name":"read","arguments":{"file_path":"a.txt"}}\n```\n';
  const fp = findProtocolStart(text);
  assert.ok(fp.index >= 0, '围栏调用形状必须被认出（真机 f3fa97fd 的高频形态）');
  assert.equal(fp.transport, true, '该形状的 transport 必须为真，正文才能提前停住');
});

// ---- ③ 混合：正文围栏在前、调用围栏在后 ------------------------------------

test('先有普通围栏再有调用围栏 → 边界停在调用围栏，普通围栏完整保留', () => {
  const text = '示例代码：\n\n```js\nlet x = 1;\n```\n\n现在执行：\n\n```json\n{"mcp_action":"call","name":"pwsh","arguments":{"command":"pwd"}}\n```\n';
  const fp = findProtocolStart(text);
  assert.ok(fp.index >= 0, '必须找到后面的调用围栏');
  const at = text.indexOf('{"mcp_action"');
  assert.ok(fp.index <= at, '边界不得晚于调用 JSON 起点');
  // 第一个普通围栏必须在边界之前（即被保留）。
  assert.ok(fp.index > text.indexOf('```js'), '普通围栏必须在边界之内，不得被当边界');
  assert.equal(proseSafeEnd(text, 0), fp.index, '正文外发终点必须正好是调用围栏起点');
});

// ---- ④ firstCallFenceAt 的单元判据 ----------------------------------------

test('firstCallFenceAt：普通围栏返回 -1', () => {
  assert.equal(firstCallFenceAt('```js\nconst a = 1;\n```'), -1);
  assert.equal(firstCallFenceAt('```\nnothing\n```'), -1);
});

test('firstCallFenceAt：调用围栏返回其下标', () => {
  const text = '前言\n\n```json\n{"mcp_action":"call","name":"x"}\n```';
  assert.equal(firstCallFenceAt(text), text.indexOf('```json'));
});

test('firstCallFenceAt：跳过前面的普通围栏，定位到后面的调用围栏', () => {
  const text = '```js\nlet y = 2;\n```\n\n```json\n{"name":"z","arguments":{}}\n```';
  assert.equal(firstCallFenceAt(text), text.indexOf('```json'));
});

test('firstCallFenceAt：未闭合围栏不崩，返回 -1', () => {
  assert.equal(firstCallFenceAt('```js\nconst a = 1;'), -1);
});
