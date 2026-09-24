// skill-catalog-trim.test.mjs — 0.19.4 两条护栏：
//   ① 技能目录的桥侧收敛（只作用于 deepseek 首轮，其余站点逐字不动）
//   ② 长文本调用体的两类真机漂移（裸控制字符 / 双写与错拼闭 token）
//
// 两条都来自同一批真实读数（证据与脚本见 lib/agent-preset.js 里对应函数的注释）：
//   · `.tmp/skill-usage-scan2.mjs`  303 份会话 → 92 个名字里 85 个从未被加载
//   · `.tmp/catalog-cost.mjs`       55 份落盘首轮 → 目录 = 4,335 token，占典型首轮 22.6%
//   · `.tmp/token-shapes.mjs`       22,375 枚协议 token → 36 种漂移形状普查
//   · `.tmp/fixture-probe.mjs`      7 条「长回复 0 调用」原文逐条复解析

import test from 'node:test';
import assert from 'node:assert/strict';
import { serializeFirstTurn, compactSkillCatalog, skillCatalogPlan, parseAgentReply } from '../lib/agent-preset.js';
import { estimateTokens } from '../lib/metrics.js';

const TOOLS = [{ name: 'read', parameters: { type: 'object', properties: { file_path: { type: 'string' } } } }];

/** 与 DSH 官方模板同形的一份目录（条目取自本机真机目录，逐字）。 */
const CATALOG = [
  '<system-reminder>',
  'A skill is a reusable set of task-specific instructions. The following skills are available in this session:',
  '',
  '<available_skills>',
  '- `diagnose`: Disciplined diagnosis loop for hard bugs and performance regressions. Reproduce → minimise → hypothesise → instrument → fix → regression-test. Use when user says "diagnose this".',
  '- `gsd-code-review`: Review source files changed during a phase for bugs, security issues, and code quality problems',
  '- `gsd-debug`: Systematic debugging with persistent state across context resets',
  '- `gsd-execute-phase`: Execute all plans in a phase with wave-based parallelization',
  '- `miyo-parse`: Convert a document (PDF or EPUB) into Markdown/plain text with the local `miyo parse` CLI, so you can read, quote, or feed its contents onward.',
  '</available_skills>',
  '',
  'If the user names a skill, or the task clearly matches a skill\'s description, call the `skill` tool with the exact skill name before taking task actions.',
  '</system-reminder>',
].join('\n');
const MSG = { role: 'user', content: [{ type: 'text', text: CATALOG }] };
const blockOf = (t) => t.slice(t.indexOf('<available_skills>'), t.indexOf('</available_skills>') + 20);

test('① 零漂移：不带 siteId 或非 deepseek 站点，目录逐字不动', () => {
  const none = serializeFirstTurn({ messages: [MSG], tools: TOOLS });
  const glm = serializeFirstTurn({ messages: [MSG], tools: TOOLS, siteId: 'glm' });
  assert.ok(none.includes(CATALOG), '无站点时必须原样包含目录');
  assert.ok(glm.includes(CATALOG), 'glm 站点必须原样包含目录');
  assert.equal(skillCatalogPlan({ siteId: 'glm' }).mode, 'full');
  assert.equal(skillCatalogPlan({}).mode, 'full');
});

test('① auto + deepseek ⇒ slim：丢 gsd 集群、留唯一有命中记录的 gsd 项、描述截断', () => {
  assert.equal(skillCatalogPlan({ siteId: 'deepseek' }).mode, 'slim');
  const out = serializeFirstTurn({ messages: [MSG], tools: TOOLS, siteId: 'deepseek' });
  const block = blockOf(out);
  assert.ok(!block.includes('gsd-debug'), 'gsd-debug 在 303 份会话里 0 命中，必须被省略');
  assert.ok(!block.includes('gsd-execute-phase'), 'gsd-execute-phase 同上');
  assert.ok(block.includes('gsd-code-review'), 'gsd-code-review 有 1 次真实加载，必须保留');
  assert.ok(block.includes('diagnose'), 'diagnose 有 11 次真实加载，必须保留');
  assert.ok(block.includes('miyo-parse'), 'miyo-parse 有 2 次真实加载，必须保留');
  // 长描述按上限截断（miyo-parse 原文 190 字符 > 120）
  assert.ok(/^- `miyo-parse`: .{1,121}…$/m.test(block), '超上限的描述必须截断并留省略号');
  // 省略事实必须写在目录里（不静默丢内容的仓库纪律）
  assert.ok(block.includes('省略了 2 个'), '省略数量必须明写：' + block);
});

test('① slim 省下的 token 必须是可测量的（目录块自身 > 40%）', () => {
  const before = estimateTokens(CATALOG);
  const out = serializeFirstTurn({ messages: [MSG], tools: TOOLS, siteId: 'deepseek' });
  const after = estimateTokens(blockOf(out));
  assert.ok(after < before * 0.6, `deepseek 的目录块应显著变短：${before} → ${after}`);
});

test("① off：目录整体撤掉，但 system-reminder 的交代仍在（不是静默删除）", () => {
  const out = compactSkillCatalog(CATALOG, { mode: 'off' });
  assert.ok(!out.includes('<available_skills>'), 'off 不得再出现目录');
  assert.ok(out.includes('<system-reminder>') && out.includes('/名字'), 'off 仍要说明技能怎么调');
});

test('① 对非目录文本是恒等变换', () => {
  const plain = '用户消息：请看一下 lib/index.js';
  assert.equal(compactSkillCatalog(plain, skillCatalogPlan({ siteId: 'deepseek' })), plain);
  assert.equal(serializeFirstTurn({ messages: [{ role: 'user', content: [{ type: 'text', text: plain }] }], tools: TOOLS, siteId: 'deepseek' }).length > 0, true);
});

// ---------------------------------------------------------------- 长文本调用体

const writeTools = [{ name: 'write', parameters: { type: 'object', properties: { file_path: { type: 'string' }, content: { type: 'string' } } } }];
const wrap = (body) => '<｜tool▁calls▁begin｜>\n<｜tool▁call▁begin｜>write<｜tool▁sep｜>' + body + '\n<｜tool▁call▁end｜>\n<｜tool▁calls▁end｜>';

test('② 长 content 里的裸换行/裸制表符不再让整条调用归零', () => {
  // 真机 zero-00/02/05 的形态：内容字段是一整篇 markdown，换行是 U+000A 真换行
  const body = '{"file_path":"doc/report.md","content":"# 报告\\n第一段\\n\\n第二段\\t缩进"}'.replace(/\\\\n/g, '\n').replace(/\\\\t/g, '\t');
  const res = parseAgentReply(wrap(body), { tools: writeTools });
  assert.equal(res.calls.length, 1, '裸控制字符的长体必须仍能解析：' + JSON.stringify(res.diagnostics));
  assert.equal(res.calls[0].name, 'write');
  assert.ok(String(res.calls[0].arguments.content).includes('第一段'), '内容不得被截掉');
});

test('② 闭 token 的叠写与错拼（真机 221 处）不再吞掉整条调用', () => {
  for (const closer of ['<｜tool▁call▁calls▁end｜>', '<｜tool▁calls▁calls▁end｜>', '<｜tool▁cend｜>', '<｜tool▁call▁cend｜>', '<｜tool▁calls▁calls▁cend｜>', '</｜tool▁call▁end｜>']) {
    const text = '<｜tool▁calls▁begin｜>\n<｜tool▁call▁begin｜>write<｜tool▁sep｜>{"file_path":"a.md"}\n' + closer;
    const res = parseAgentReply(text, { tools: writeTools });
    assert.equal(res.calls.length, 1, `闭 token ${closer} 必须被认成端锚`);
  }
});

test('② begin 类 token 仍不得当端锚（0.16.20 那条护栏逐字成立）', () => {
  const text = '<｜tool▁calls▁begin｜>\n<｜tool▁call▁begin｜>write<｜tool▁sep｜>{"file_path":"a.md"}\n<｜tool▁call▁begin｜>read<｜tool▁sep｜>{"file_path":"b.md"}\n<｜tool▁calls▁end｜>';
  const res = parseAgentReply(text, { tools: writeTools });
  assert.equal(res.calls.length, 2, 'begin 当端锚会吞掉下一条调用，这里必须两条都在');
  assert.deepEqual(res.calls.map((c) => c.name), ['write', 'read']);
});

test('② 体内出现第二个对象时**仍然拒收**（0.16.25 红线：只续跑、不代拼）', () => {
  // 2026-09-24 实测教训：把 jsonObjectIn 改成「取第一个配平对象」会让这条形状被
  // 静默接受——参数只剩一半却照常执行。正确出口是拒收 + 诊断 + UNPARSED 续跑，
  // 由 test/auto-continue.test.mjs 的两条端到端用例钉住。
  const text = wrap('{"file_path":"a.md","old_string":"a"},{"replace_all":false}');
  const res = parseAgentReply(text, { tools: writeTools });
  assert.equal(res.calls.length, 0, '多挂第二对象的形状必须拒收');
});
