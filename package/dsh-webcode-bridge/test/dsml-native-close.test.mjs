// dsml-native-close.test.mjs — DeepSeek 网页**原生 DSML** 的无名闭合/无名开标签（0.16.2）。
//
// ## 用户可见症状（用户原话）
//
// > 「用 bridegege 怎么总是现在返回真实工具调用说正文没有返回？之前让你看了你说是
// >  没有返回，但是我看 web 是真实有的啊！你可以去看网页端真实对话回复」
//
// 「web 是真实有的」这句是**字面为真**的：网页端确实发出了完整、可执行的调用。
//
// ## 真机留痕（唯一证据来源，逐字落成 test/fixtures/dsml-real-*.txt）
//
// 取法（只读控制面，不改网页、不重发）：
//
//   POST http://127.0.0.1:8931/__webcode/history {"sessionId":"d0c345bd-…"}
//
// 网页实际发出的助手正文长这样（`<>` 是全角竖线的 DSML 标记）：
//
//   <calls>
//   <invoke name="pwsh">
//   <parameter name="command">git diff…</parameter>
//   <parameter name="description" string="true">…</parameter>
//   </invoke>
//   </calls>
//
// harness 侧同一时刻的读数：`TOOL_CALL_UNPARSED: 网页这一轮发出了工具调用，但桥
// 没能把它变成可执行的调用`，且 `calls=0` —— 与用户看到的完全一致。
//
// ## 两个叠加的根因（都在 `normalizeDsml` 的**闭合标签**处理上）
//
// 1. **闭合标签无名**。DSML 的闭合标签是 `</invoke>`，但网页也会输出
//    连标记名都省掉的 `</>`（真机夹具 13）。旧规则 `</marker\s*` → `</`
//    把它变成裸 `</>`，于是 `invokeBodyEnd` 的参数配平状态机永远等不到 `</invoke>`，
//    体一直未闭合 → 整条调用被丢。
// 2. **开标签也能缺席**。真机夹具 7 里模型直接以 `<parameter …>` 起写，
//    **根本没有 `<invoke name="…">` 这一行**，却用 `</invoke>` 收束。
//    没有外壳就没有 invoke 体，`invokeOpenRe` 一处都匹配不到 → 同样 `calls=0`。
//
// ## 修法（本文件锁的就是它）
//
// `resolveNamelessClosers(text)` 在归一化**之前**跑一个栈式解析：
//   · 无名闭合 `</marker>` → 按栈顶补回真实标记名（`parameter` / `invoke`）；
//   · 只带 DSML 标记的 `<parameter …>` 若栈里没有 invoke → 补一个 `name=""` 外壳；
//   · 名字为空的外壳交给既有的 `inferToolNameFromArgs` 按参数形状反推唯一解。
//
// **保守判据（这就是反向安全线）**：只对**带 DSML 标记**的标签动手。裸 `<parameter>`
// 常出现在讲解协议的散文/文档里，补了就会把示例当调用执行——宁可少救，不可错认。
//
// ## 反向验证纪律（doc/comment-style.md §9.3）
//
// ①②③⑤ 在修复前必须**红**（夹具 7/13 在旧代码上 `calls=0`）；
// ④⑥⑦⑧⑨ 是反向安全线：不得把散文里的示例当调用、不得改写带名字的正常调用、
// 不得让「探测到了协议」与「解析出调用」再次分叉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseAgentReply, normalizeDsml, findProtocolStart, proseSafeEnd } from '../lib/agent-preset.js';

const FIXTURE_DIR = path.join(import.meta.dirname, 'fixtures');

/** 真机夹具清单（1..13），由 .tmp/capture-dsml-fixtures.mjs 从 /history 逐字落盘。 */
const FIXTURES = Array.from({ length: 13 }, (_, i) => `dsml-real-${i + 1}.txt`);

/** 本会话工具表：形状判据要用真实 schema，不能只给名字。 */
const TOOLS = [
  { name: 'grep', parameters: { type: 'object', properties: { pattern: {}, path: {}, include: {} }, required: ['pattern'] } },
  { name: 'glob', parameters: { type: 'object', properties: { pattern: {}, path: {} }, required: ['pattern'] } },
  { name: 'pwsh', parameters: { type: 'object', properties: { command: {}, description: {} }, required: ['command', 'description'] } },
  { name: 'read', parameters: { type: 'object', properties: { file_path: {}, offset: {}, limit: {} }, required: ['file_path'] } },
];

const read = (name) => fs.readFileSync(path.join(FIXTURE_DIR, name), 'utf8');

/** 真机夹具只有这三家的调用，名字必须落在工具表里。 */
const KNOWN = new Set(TOOLS.map((t) => t.name));

// ── 正向：每一份真机字节都必须解析出可执行调用 ────────────────────────────────

for (const name of FIXTURES) {
  test(`真机夹具 ${name}：必须解析出至少一条可执行调用`, () => {
    const raw = read(name);
    const { calls } = parseAgentReply(raw, { tools: TOOLS });
    // 红基线：修复前 dsml-real-7 / dsml-real-13 都是 calls=0。
    assert.ok(calls.length >= 1, `${name} 解析出 0 条调用——网页真实发出的调用又丢了`);
    for (const c of calls) assert.ok(KNOWN.has(c.name), `${name} 解析出不存在的工具名: ${c.name}`);
  });
}

// ── ① 无名闭合 `</>` 必须补回真实标记名 ─────────────────────────────

test('① 无名闭合 </>：栈式补名后可解析（真机夹具 13）', () => {
  const raw = read('dsml-real-13.txt');
  const norm = normalizeDsml(raw);
  // 补名发生在归一化之前：归一化结果里必须已经出现完整的 </parameter> 与 </invoke>。
  assert.ok(/<\/parameter>/.test(norm), '无名闭合没有补回 </parameter>');
  assert.ok(/<\/invoke>/.test(norm), '无名闭合没有补回 </invoke>');
  const { calls } = parseAgentReply(raw, { tools: TOOLS });
  assert.deepEqual(calls.map((c) => c.name), ['pwsh', 'read']);
});

// ── ② 缺席的 invoke 外壳必须补出来，且**不静默** ─────────────────────────────

test('② 漏写 <invoke> 开标签（真机夹具 7）：补壳 + 按参数形状反推 + 留痕', () => {
  const raw = read('dsml-real-7.txt');
  const { calls, diagnostics } = parseAgentReply(raw, { tools: TOOLS });
  assert.equal(calls.length, 2, '两条 pwsh 调用应当都被救回');
  assert.deepEqual(calls.map((c) => c.name), ['pwsh', 'pwsh']);
  // 名字是**推**出来的，必须标记出来，调用方据此留痕。
  assert.ok(calls.every((c) => c.nameInferred === true), '反推出的名字必须带 nameInferred');
  assert.ok(calls[0].arguments.command.startsWith('Get-Content package/dsh-webcode-bridge/lib/index.js'));
  // 「不留痕的早退分支就是静默丢弃的唯一来源」（0.15.6 立的规矩）——本条也不例外。
  assert.ok(diagnostics.some((d) => /nameless call resolved by arguments shape/.test(d)),
    '反推名字必须留 diagnostics');
});

// ── ③ 探测与解析不得分叉 ─────────────────────────────────────────────────────

test('③ findProtocolStart 命中且 transport 时，解析结果不得为空', () => {
  for (const name of FIXTURES) {
    const raw = read(name);
    const probe = findProtocolStart(raw);
    assert.ok(probe.index >= 0, `${name} 边界探测竟然没命中`);
    assert.equal(probe.transport, true, `${name} 应被判为待执行调用形态`);
    const { calls } = parseAgentReply(raw, { tools: TOOLS });
    // 这正是用户报的「说有工具调用、又说没有正文」：探测到了、却一条都没解析出来。
    assert.ok(calls.length >= 1, `${name} 探测命中但解析为 0——「探测/解析」再次分叉`);
  }
});

// ── ④ 反向安全线：协议不得漏进正文 ───────────────────────────────────────────

test('④ 真机夹具：proseSafeEnd 必须停在协议起点，正文不含 DSML', () => {
  for (const name of FIXTURES) {
    const raw = read(name);
    const probe = findProtocolStart(raw);
    const safe = proseSafeEnd(raw, 0);
    assert.ok(safe <= probe.index, `${name} 正文外发越过了协议起点（${safe} > ${probe.index}）`);
    assert.ok(!/DSML/.test(raw.slice(0, safe)), `${name} 外发正文里出现 DSML 标记`);
    assert.ok(!/<invoke|<parameter/i.test(raw.slice(0, safe)), `${name} 外发正文里出现协议标签`);
  }
});

// ── ⑤ 反向安全线：只对带标记的标签动手 ───────────────────────────────────────

test('⑤ 散文里的裸 <parameter> 不得被当成调用（保守判据）', () => {
  // 讲解协议形状的文档/报告里必然出现这种片段；补壳就等于把示例当调用执行。
  const prose = '协议里的参数写成 <parameter name="command">…</parameter>，整条包在 invoke 里。';
  const { calls } = parseAgentReply(prose, { tools: TOOLS });
  assert.equal(calls.length, 0, '散文里的裸 <parameter> 被误判成调用了');
  assert.equal(findProtocolStart(prose).index, -1, '散文不该被判成协议起点');
});

// ── ⑥ 反向安全线：带名字的既有形态逐字不变 ───────────────────────────────────

test('⑥ 带名字的 </parameter> 与正常 <invoke> 行为不变', () => {
  const named = [
    '<invoke name="read">',
    '<parameter name="file_path">README.md</parameter>',
    '</invoke>',
  ].join('\n');
  const { calls } = parseAgentReply(named, { tools: TOOLS });
  assert.deepEqual(calls.map((c) => c.name), ['read']);
  // 名字是**写出来的**，不该被标成反推。
  assert.ok(!calls[0].nameInferred, '带名字的调用不该被标记为反推');

  const plain = '<invoke name="grep"><parameter name="pattern">x</parameter></invoke>';
  const r2 = parseAgentReply(plain, { tools: TOOLS });
  assert.deepEqual(r2.calls.map((c) => c.name), ['grep']);
});

// ── ⑦ 反向安全线：纯散文不得产生任何调用 ─────────────────────────────────────

test('⑦ 纯散文：0 调用、无协议边界', () => {
  const prose = '我看了一下 index.js 的第 1500 行附近，等待统计写在那儿。\n\n结论：没问题。';
  const { calls } = parseAgentReply(prose, { tools: TOOLS });
  assert.equal(calls.length, 0);
  assert.equal(findProtocolStart(prose).index, -1);
  assert.equal(proseSafeEnd(prose, 0), prose.length, '无协议的正文必须整段可外发');
});

// ── ⑧ 反向安全线：无名闭合不得凭空造出栈 ─────────────────────────────────────

test('⑧ 孤立的无名闭合在栈空时原样保留（不凭空补标签）', () => {
  // 栈空 ⇒ 没有可闭合的东西，必须原样返回，不能造出一个 </invoke>。
  const orphan = '前面没有开标签 </> 后面也没有。';
  const norm = normalizeDsml(orphan);
  assert.ok(!/<\/invoke>|<\/parameter>/.test(norm), '栈空时不得凭空补出闭合标签');
  const { calls } = parseAgentReply(orphan, { tools: TOOLS });
  assert.equal(calls.length, 0);
});

// ── ⑨ 反向安全线：数组参数不得被当成调用执行 ─────────────────────────────────

test('⑨ 参数是数组时仍按原语义拒绝', () => {
  const bad = '<invoke name="read">["a","b"]</invoke>';
  const { calls } = parseAgentReply(bad, { tools: TOOLS });
  assert.equal(calls.length, 0);
});
