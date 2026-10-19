// deepseek-prompt-slim.test.mjs — 0.19.3 护栏：deepseek 首轮提示词的精简与措辞纠错。
//
// 用户指令（本轮）：「我是让你现在在"标准模式模板（standard）"模板下结合提示词进行优化！
// 不是让你改原来已有官方！」「自己去学习提示词工程最佳实践来参考！deepseek 的提示词先只改」。
//
// ## 本护栏钉住四件事
//
// ① deepseek 段不得再与同一份首轮的「# 工具调用格式」段逐字重复。真机读数（本轮实测）：
//    两段共重复 202 字符，其中「标记必须逐字完整…」与「sep 之后是完整 JSON 对象…
//    不要加 ```json 围栏」两句逐字重复。依据 arXiv 2510.05381「长上下文本身损害性能」
//    （doc/research/prompt-engineering-evidence-2026-09-14.md §2.2）。
// ② 骨架必须留着：它是 serializeFirstTurn 注入的最后一段，且自动续跑轮
//    （teachFor → transportNoteFor）单独复用它——那时没有 preset 在场。
// ③ 「工具调用（非代码块）」的措辞纠错只改 deepseek 分支：0.19.95 把「多调用并行」教学
//    提升为公共段（见 ④，并同步更新了 test/prompt-variants.test.mjs 的基线），但**这条**
//    措辞句仍只对 deepseek 换词，其余站点保持 0.14.7 的「工具调用代码块」逐字不动。
// ④ 多调用并行教学（2026-10-19，**0.19.95 起全站生效**）：公共教学段必须有「无依赖/相互
//    独立的多个调用 ⇒ 合并在同一条回复里一起发起；有依赖才分轮」的强约束句；全站不得
//    保留会被读成「尽量少调用」的「能用一次调用覆盖就不用多次」原句（反重复原意保留）；
//    且每个站点文本里只出现一次（公共化后不得在 deepseek 分支再教一遍）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPreset, transportNoteFor, serializeFirstTurn } from '../lib/agent-preset.js';

const TOOLS = [
  { name: 'read', description: '读文件', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
  { name: 'pwsh', description: 'Run pwsh.', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command', 'description'] } },
];
const S = String.fromCharCode(0x2581);
const dsTransport = () => transportNoteFor('deepseek', TOOLS);
const dsPreset = () => buildPreset({ tools: TOOLS, siteId: 'deepseek' });

// ---------------------------------------------------------------------------
// ① 去重
// ---------------------------------------------------------------------------

test('① deepseek 协议段不再重复「标记必须逐字完整」与「不要加 ```json 围栏」', () => {
  const t = dsTransport();
  assert.ok(!t.includes('标记必须逐字完整'),
    '这句在「# 工具调用格式」段已逐字存在，协议段重复它只增加上下文长度');
  assert.ok(!t.includes('不要加 ```json 围栏'),
    '同上；同一份首轮里出现两次同一约束不增加信息量');
});

test('①b 协议段精简后仍显著短于精简前（实测 501 → 376 字符）', () => {
  const t = dsTransport();
  // 上界留有余地：将来要加内容必须显式面对这条断言，而不是悄悄把删掉的重复句加回来。
  assert.ok(t.length <= 420, `deepseek 协议段应保持精简（当前 ${t.length} 字符，上界 420）`);
});

// ---------------------------------------------------------------------------
// ② 骨架与独有内容必须留着
// ---------------------------------------------------------------------------

test('② 协议段仍带完整骨架（骨架是续跑轮唯一的形状来源）', () => {
  const t = dsTransport();
  assert.ok(t.includes('tool' + S + 'calls' + S + 'begin'), 'calls-begin 标记必须在');
  assert.ok(t.includes('tool' + S + 'call' + S + 'end'), 'call-end 标记必须在');
  assert.ok(t.includes('read') && t.includes('pwsh'), '骨架必须用真实工具名');
});

test('②b 协议段的独有约束不得被精简连带删除', () => {
  const t = dsTransport();
  assert.ok(t.includes('Calling:'), '「Calling: 不执行工具」是协议段独有内容，不得删');
  assert.ok(t.includes('立即发起调用'), '「判定需要真实数据就立即发起」是独有内容，不得删');
  assert.ok(t.includes('不要继续无谓思考'), '「不要继续无谓思考」是独有内容，不得删');
});

// ---------------------------------------------------------------------------
// ③ 措辞纠错 + 默认路径不受影响
// ---------------------------------------------------------------------------

test('③ deepseek 分支不再把官方 token 形状叫「代码块」（与自己上文的禁令矛盾）', () => {
  const ds = dsPreset();
  assert.ok(ds.includes('一次回复可以包含多个工具调用，会按顺序执行'),
    'deepseek 分支该说「工具调用」，不说「代码块」——它刚教过「不要加 ```json 围栏」');
  assert.ok(!ds.includes('多个工具调用代码块'), 'deepseek 分支不得再出现「工具调用代码块」');
});

test('③b 默认路径逐字不动：非 deepseek 站点仍说「工具调用代码块」', () => {
  for (const siteId of [undefined, 'glm', 'chatgpt', 'kimi', 'qwen']) {
    const text = buildPreset({ tools: TOOLS, ...(siteId ? { siteId } : {}) });
    assert.ok(text.includes('多个工具调用代码块'),
      `${siteId || 'default'} 的措辞必须逐字不动（零位移）`);
  }
});

test('③c glm 与 default 的传输协议段逐字不受本次精简影响', () => {
  const glm = transportNoteFor('glm', TOOLS);
  const dflt = transportNoteFor('chatgpt', TOOLS);
  assert.ok(glm.includes('```json 代码块'), 'glm 立场不动');
  assert.ok(!glm.includes('工具调用代码块'), 'glm 不该被 deepseek 的措辞改动波及');
  assert.ok(dflt.includes('<tool_call>'), '默认标签立场不动');
});

test('③d 端到端：serializeFirstTurn 的 deepseek 首轮里，「代码块」措辞已消失', () => {
  const turn = serializeFirstTurn({ messages: [{ role: 'user', content: [{ type: 'text', text: '看时间' }] }], tools: TOOLS, siteId: 'deepseek' });
  assert.ok(turn.includes('用官方工具调用格式（DeepSeek 原生模板）发起工具调用'), '官方模板教学仍在');
  assert.ok(!turn.includes('多个工具调用代码块'), '首轮全文里不该再有自相矛盾的「代码块」措辞');
});

// ---------------------------------------------------------------------------
// ④ 多调用并行教学（2026-10-19；0.19.95 起全站生效）
// ---------------------------------------------------------------------------

test('④ 公共教学段带「多调用并行」强约束：同一条回复 + 一起发起 + 依赖才分轮（deepseek 读数）', () => {
  const ds = dsPreset();
  // 「同一条回复」与「一起发起」两个语义必须出现：只教「可以包含多个」不够——
  // 真机症状是每条回复只发一个调用，彼此独立的调用被拆成多轮、每轮白等一次往返。
  assert.ok(ds.includes('同一条回复'), '公共教学段必须教「同一条回复」');
  assert.ok(ds.includes('一起发起'), '公共教学段必须教「一起发起」（并行语义）');
  assert.match(ds, /无依赖、相互独立的多个工具调用[，,]?\s*必须合并在同一条回复里一起发起/,
    '强约束句式必须把「无依赖/相互独立 ⇒ 合并到同一条回复」说成「必须」');
  assert.match(ds, /只有[^。]*依赖[^。]*才分多轮等待结果/, '必须给出「有依赖才分轮」的判据');
  // 去重：0.19.95 公共化后，deepseek 分支不得再重复一遍同一句。
  assert.equal(ds.split('多调用并行（强约束）').length - 1, 1,
    '并行教学在 deepseek 文本里只应出现一次（不得因公共段 + 分支各一份而教两遍）');
  // 反向：会抑制并行的那句原话不得再出现（反重复原意换成了不冲突的措辞）。
  assert.ok(!ds.includes('能用一次调用覆盖就不用多次'),
    'deepseek 文本不得保留可能被读成「尽量少调用」的原句');
  assert.ok(ds.includes('同一信息不要用多个调用重复获取'),
    '反重复的原意必须保留（不许为了并行而鼓励重复取同一信息）');
});

test('④b 并行教学全站生效：default/glm 等全部站点收到新句、不含旧抑制句；「代码块」措辞仍只在非 deepseek', () => {
  for (const siteId of [undefined, 'glm', 'chatgpt', 'kimi', 'qwen', 'doubao', 'zai']) {
    const text = buildPreset({ tools: TOOLS, ...(siteId ? { siteId } : {}) });
    const tag = siteId || 'default';
    assert.ok(text.includes('多调用并行（强约束）'), `${tag} 必须收到公共并行教学（0.19.95 全站生效）`);
    assert.ok(text.includes('同一条回复') && text.includes('一起发起'), `${tag} 必须带「同一条回复/一起发起」并行语义`);
    assert.ok(!text.includes('能用一次调用覆盖就不用多次'), `${tag} 不得保留旧抑制句`);
    assert.ok(text.includes('同一信息不要用多个调用重复获取'), `${tag} 反重复原意必须保留`);
    assert.equal(text.split('多调用并行（强约束）').length - 1, 1, `${tag} 的并行教学只应出现一次`);
  }
  // 0.19.95 只动两条公共教学文本：「工具调用代码块」这句的 deepseek 措辞纠错边界不变。
  for (const siteId of [undefined, 'glm', 'chatgpt']) {
    const text = buildPreset({ tools: TOOLS, ...(siteId ? { siteId } : {}) });
    assert.ok(text.includes('多个工具调用代码块'), `${siteId || 'default'} 的「代码块」措辞仍逐字不动`);
  }
});

