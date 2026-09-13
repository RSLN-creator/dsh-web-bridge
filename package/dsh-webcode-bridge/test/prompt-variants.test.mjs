// prompt-variants.test.mjs — 首轮提示词变体清单的护栏（0.14.0）。
//
// 用户诉求：「设置界面提示词应该默认就显示……有多的适配就可选择框选择列出」。
// 这条需求最容易做坏的地方是**协议漂移**：设置页为了显示而自己拼一份模板，
// 于是「设置里看到的」和「真正发出去的」变成两份会各自演化的文本。
// 本文件钉住三件事：
//   ① 变体的 text 必须来自 serializeFirstTurn 本身（改 extraPrompt 必须反映）；
//   ② glm 变体不得出现 <tool_call>，默认变体必须出现（否则教学立场就反了）；
//   ③ 两个变体必须真的不同，且站点 → 变体的映射与 agent-preset 的分支一致。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPromptVariants, variantIdForSite, VARIANT_SPECS } from '../lib/prompt-variants.js';
import { serializeFirstTurn, trainNoteFor } from '../lib/agent-preset.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (p) => fs.readFileSync(path.resolve(here, '..', p), 'utf8');

const TOOLS = [{ name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }];

test('两个适配分支都存在，且文本来自 serializeFirstTurn（不是另抄一份）', () => {
  const { variants } = buildPromptVariants({ tools: TOOLS });
  assert.deepEqual(variants.map((v) => v.id).sort(), ['default', 'glm']);
  const dflt = variants.find((v) => v.id === 'default');
  const glm = variants.find((v) => v.id === 'glm');
  // 与真函数逐字一致：这是「设置里看到的 = 真正发出去的」的唯一保证。
  assert.equal(dflt.text, serializeFirstTurn({ messages: [], tools: TOOLS, siteId: undefined }));
  assert.equal(glm.text, serializeFirstTurn({ messages: [], tools: TOOLS, siteId: 'glm' }));
  assert.notEqual(dflt.text, glm.text, '两个分支的模板必须不同（否则下拉没有意义）');
});

test('协议立场：glm 变体只教代码块并警告标签，默认变体教标签', () => {
  const { variants } = buildPromptVariants({ tools: TOOLS });
  const dflt = variants.find((v) => v.id === 'default');
  const glm = variants.find((v) => v.id === 'glm');
  assert.ok(dflt.text.includes('<tool_call>'), '默认分支必须教标签形状');
  assert.match(dflt.text, /必须使用 <tool_call>\{"mcp_action":"call"/);
  // glm：只教代码块，并把「标签会被网页抢走执行」说破。注意它**必须**提到
  // <tool_call> 这个词——那正是警告的内容；因此判据是「不得教标签形状」，
  // 而不是「不得出现该字符串」（present-preset.test.mjs 有同一口径）。
  assert.match(glm.text, /必须使用 ```json 代码块/);
  assert.match(glm.text, /unknown tool call/);
  assert.doesNotMatch(glm.text, /必须使用 <tool_call>\{"mcp_action"/);
  assert.ok(!/^\s*<tool_call>/m.test(glm.text), 'glm 变体不得把标签形状作为示例块给出');
  // 再教学提示（增量轮每 5 个工具结果重贴）也必须同立场，否则模型被来回拉。
  assert.equal(dflt.trainNote, trainNoteFor('default'));
  assert.equal(glm.trainNote, trainNoteFor('glm'));
  assert.doesNotMatch(glm.trainNote, /^\[系统提示\] 请保持工具调用格式：以 <tool_call>/);
});

test('全局指令体现在每个变体里，且保存后重新拉取即变', () => {
  const before = buildPromptVariants({ tools: TOOLS, extraPrompt: '' });
  const after = buildPromptVariants({ tools: TOOLS, extraPrompt: '始终用中文回答' });
  for (const v of after.variants) {
    assert.ok(v.text.includes('始终用中文回答'), v.id + ' 的模板必须包含全局指令');
  }
  for (const v of before.variants) {
    assert.ok(!v.text.includes('始终用中文回答'), v.id + ' 未设置时不得凭空出现');
  }
});

test('没有真实工具清单时用占位集并如实标注（不假装这是本会话的模板）', () => {
  const placeholder = buildPromptVariants({});
  assert.equal(placeholder.toolsSource, 'placeholder');
  assert.ok(placeholder.variants[0].text.includes('read'), '占位集也应当能渲染出工具段');
  const real = buildPromptVariants({ tools: TOOLS });
  assert.equal(real.toolsSource, 'session');
});

test('未注册 present 时不提 present；注册了才教（与预设同一护栏）', () => {
  const without = buildPromptVariants({ tools: TOOLS });
  for (const v of without.variants) assert.ok(!v.text.includes('present 让文件'), v.id + ' 未注册 present 却教了它');
  const withPresent = buildPromptVariants({ tools: [...TOOLS, { name: 'present', description: '声明交付物', parameters: { type: 'object' } }] });
  assert.ok(withPresent.variants.every((v) => v.text.includes('present')), '注册了 present 就必须教');
});

test('站点 → 变体的映射与 agent-preset 的分支一致（目前只有 glm 走代码块）', () => {
  assert.equal(variantIdForSite('glm'), 'glm');
  for (const sid of ['deepseek', 'zai', 'kimi', 'qwen', 'doubao', 'chatgpt', 'claude', 'gemini', 'grok']) {
    assert.equal(variantIdForSite(sid), 'default', sid + ' 必须走默认（标签）分支');
  }
  // 变体表自身的立场声明不能自相矛盾
  for (const spec of VARIANT_SPECS) {
    assert.ok(spec.id && spec.label && spec.note, spec.id + ' 缺少展示字段');
    if (spec.only) assert.ok(!spec.excludes, spec.id + ' 不能同时用 only 与 excludes');
  }
});

test('prompt-variants.js 不得自己再写一份协议文本（工具协议只有一处定义）', () => {
  // doc/review-guide.md 的不可越界约束 #3：工具协议只有 lib/agent-preset.js 一处。
  // 本模块的职责只是「挑参数、调真函数」，因此它不得包含任何**教学文本**——
  // 一旦有人在这里另抄一份「必须使用 …」的格式说明，两份就会各自演化。
  //
  // 注意口径：模块里的 `note` 字段**允许**提到 <tool_call>（那是给用户看的
  // 行为说明，例如「该站点会抢走标签执行」），它是解释而不是第二份定义。
  // 判据因此是「不得出现教学句式」，而不是「不得出现这个词」。
  const src = read('lib/prompt-variants.js');
  assert.doesNotMatch(src, /必须使用 <tool_call>\{/, '出现了标签形状的教学文本（应在 agent-preset）');
  assert.doesNotMatch(src, /必须使用 ```json 代码块/, '出现了代码块形状的教学文本（应在 agent-preset）');
  assert.doesNotMatch(src, /\[本地工具传输协议\]/, '出现了协议段落标题（应在 agent-preset）');
  // 唯一真相必须被真正调用（而不是把 serializeFirstTurn 抄进来）。
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  assert.match(code, /serializeFirstTurn\(/, '必须调用 agent-preset 的 serializeFirstTurn');
});