// teach-parse-closure.test.mjs — 「**教什么就必须解析什么**」的逐站闭环护栏（0.19.85）。
//
// ## 为什么需要它（用户第 ④ 项里「解析覆盖」那一格）
//
// 用户原话：「**另外你的思维工具调用不同厂家模型适配没做啊！**」
// 第 ④ 项要的三件事是「prompt-variants 变体表 / 各站原生工具调用形态 / **解析覆盖**」。
// 前两件已有护栏（`prompt-variants.test.mjs`、`tool-transport.test.mjs`），
// 第三件此前**没有一处**做这件事：**没有任何测试逐站断言「我们教给某站的形状，
// 解析器真的读得回来」**。既有测试分两侧：
//   · 教学侧（`tool-transport.test.mjs`）断言 glm 教代码块 / 默认教标签 / deepseek 教官方模板；
//   · 解析侧（`official-tool-calls` / `parse` / `glm-hybrid-call`）断言**手写夹具**能解析；
//   ⇒ **两侧都用「手写的名字/夹具」，没有一条把「教学产出的形状」与「回读」接起来**。
//
// ## 本护栏的**确切**增量（2026-10-16 用三次反向变异实测，如实记边界）
//
// | 变异 | 结果 |
// | --- | --- |
// | **M1**：glm 教学改成标签形状（教学↔路由分叉）| **本护栏红（2/4）**；⚠ **既有护栏也红**（`tool-transport` / `prompt-variants` / `auto-continue` / `deepseek-prompt-slim` 各 1 fail）|
// | **M2**：删掉判据②的 `mcp_action` 那一半 | **全部吞掉**（解析器另有宽容路径接住；连裸 JSON 都仍解析）⇒ 该变异**无效**，不算证据 |
// | **M3**：官方骨架失去 invoke 闭 token（标志物仍在）| **本护栏也吸掉**（解析器用后续 token 自动收束）⇒ **本护栏在该形态上不敏感** |
//
// ⇒ **诚实结论**：本护栏**不是**「既有护栏漏了的那条缝」的独家守卫——
//   实测显示 M1 这类教学漂移**既有护栏本来就能抓**。它的真实增量是两条：
//     ① **穷尽性**：它遍历 `providers.js` 的**全部站点**（`SITES`），
//        而既有护栏是**按名字手写**（glm / deepseek / 默认各一条）。
//        ⇒ **新增站点时不会静默跳过**这道闭环（`assert.equal(rows.length, SITES.length)` 钉住）。
//     ② **可引用的逐站四态表**（用例 ④）：把「教学形状 / 路由 / 解析结果」固化成机读表，
//        这正是用户第 ④ 项要的「**给出每站四态**」那一格。
//
// ## 判据（**从教学文本本身出发**，不另造一份形状表）
//
// 对每个站点：① 取 `transportNoteFor(site, tools)`（真正发出去的那份教学）；
// ② 由 `transportShapeForSite(site)` 定形状；③ 断言**教学文本里确实出现该形状的标志物**；
// ④ 按该形状构造具体回复喂 `parseAgentReply`；⑤ 断言解析出**恰好 1 条**且 name/args 都对。
// ⚠ ③ 是关键：只判 ②④ 的话教学文本被换个形状**仍然全绿**（构造用的是路由表，与文本无关）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { transportNoteFor, parseAgentReply, officialToolCallSkeletonFor } from '../lib/agent-preset.js';
import { transportShapeForSite, TRANSPORT_SHAPES } from '../lib/tool-transport.js';
import { SITES } from '../lib/providers.js';

/** 与其它传输测试同形的最小工具表（只给一个必填参数明确的工具，减少形状歧义）。 */
const TOOLS = [{
  name: 'read',
  description: '读取本地文件文本内容。',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}];

/** 官方模板的分隔/包裹字符（与 agent-preset 内部常量同源：全角竖线 + U+2581）。 */
const BAR = '\uFF5C';
const SEP = '\u2581';

/** 每个形状的**具体**回复（真工具名 + 真参数）。 */
const REPLY_BY_SHAPE = {
  [TRANSPORT_SHAPES.codeblock]: () => '```json\n'
    + JSON.stringify({ mcp_action: 'call', name: 'read', arguments: { path: 'README.md' } })
    + '\n```',
  [TRANSPORT_SHAPES.tag]: () => '<tool_call>'
    + JSON.stringify({ mcp_action: 'call', name: 'read', arguments: { path: 'README.md' } })
    + '</tool_call>',
  [TRANSPORT_SHAPES.official]: () => {
    // 用**产品自己**的骨架函数（不手写 token 形状）：改了骨架这条也会跟着改，
    // 因此「教学 ↔ 解析」的闭环是双向钉住的。
    //
    // ⚠ 骨架里有**两行**（教学示范「多个调用怎么写」），两行参数都是占位 `…`。
    //   必须**全部**替换成同一个真值（`split/join`），否则会留下第二行占位符，
    //   解析出 **2 条**（一条真值 + 一条 `…`）——首版用 `.replace()` 只换第一处，
    //   于是拿到 2 条并误以为「解析器坏了」。**读数是对的，是我的构造错了。**
    //   （`test/official-tool-calls.test.mjs:101` 已钉住「两条相同占位示例按内容签名
    //   去重合成 1 条」是**按设计**的行为——两条不同的还行当然各算一条。）
    const skel = officialToolCallSkeletonFor(TOOLS);
    return skel.split('{"path":"…"}').join('{"path":"README.md"}');
  },
};

/** 各形状在教学文本里的**标志物**（第 ③ 条判据；逐条对应真机读过的措辞）。 */
const MARKER_BY_SHAPE = {
  [TRANSPORT_SHAPES.codeblock]: /```json[\s\S]*"mcp_action"\s*:\s*"call"/,
  [TRANSPORT_SHAPES.tag]: /<tool_call>\s*\{[\s\S]*"mcp_action"\s*:\s*"call"/,
  [TRANSPORT_SHAPES.official]: new RegExp(BAR + '\\s*tool' + SEP + 'calls' + SEP + 'begin' + BAR),
};

test('① 逐站闭环：**教学文本里的形状**必须能被解析回真调用（10 站全覆盖）', () => {
  const rows = [];
  for (const st of SITES) {
    const siteId = st.id;
    const note = transportNoteFor(siteId, TOOLS);
    const shape = transportShapeForSite(siteId);

    // 无工具时 transportNoteFor 返回空串：那时不教，也就没有「教/解」闭环可验。
    if (!note) { rows.push({ siteId, shape, skipped: 'no-tools' }); continue; }

    // ③ 教学文本必须真含该形状的标志物（判据钉在**文本**上）
    assert.ok(MARKER_BY_SHAPE[shape].test(note),
      `${siteId}：路由说形状=${shape}，但教学文本里找不到该形状的标志物 —— `
      + '「教什么」与「路由说教什么」已经分叉（两者必须逐字同源）');

    // ④⑤ 按该形状回帖，必须解析出恰好 1 条
    const reply = REPLY_BY_SHAPE[shape]();
    const parsed = parseAgentReply(reply, { tools: TOOLS });
    const calls = parsed?.calls || [];
    assert.equal(calls.length, 1,
      `${siteId}：按**自己的教学形状**（${shape}）回帖却解析出 ${calls.length} 条 —— 模型照教写的东西解析不了`);
    assert.equal(calls[0].name, 'read', `${siteId}：工具名解析错`);
    assert.equal(calls[0].arguments.path, 'README.md', `${siteId}：参数解析错`);
    rows.push({ siteId, shape, calls: calls.length });
  }
  // 正向计数：10 站都必须跑到（防「循环根本没进」这类静默失效）
  assert.equal(rows.length, SITES.length, `必须逐站跑满 ${SITES.length} 站，实际 ${rows.length}`);
  const checked = rows.filter((r) => !r.skipped);
  assert.equal(checked.length, SITES.length, '所有站点都应拿到教学文本（tools 非空）');
  console.log('    逐站闭环：' + rows.map((r) => `${r.siteId}=${r.shape}`).join(' '));
});

test('② 三种形状都真的被站点用到（防「只测了一种」的假覆盖）', () => {
  const used = new Set(SITES.map((s) => transportShapeForSite(s.id)));
  assert.ok(used.has(TRANSPORT_SHAPES.codeblock), 'glm 的 codeblock 形状必须被覆盖到');
  assert.ok(used.has(TRANSPORT_SHAPES.tag), '默认标签形状必须被覆盖到（8 站）');
  assert.ok(used.has(TRANSPORT_SHAPES.official), 'deepseek 的官方模板必须被覆盖到');
  assert.equal(used.size, 3, `三种形状都应出现，实际 ${[...used].join(',')}`);
});

test('③ 反向：**形状标志物与解析器错配**时必须变红（这条判据不是装饰品）', () => {
  // 模拟「教学文本被改成 A，而解析器只会 B」：拿标签形状的回复去查 codeblock 的标志物
  // ⇒ 标志物判据必须不命中（这正是第 ① 条里 ③ 的作用）。
  const tagReply = REPLY_BY_SHAPE[TRANSPORT_SHAPES.tag]();
  assert.ok(!MARKER_BY_SHAPE[TRANSPORT_SHAPES.codeblock].test('教学文本：' + tagReply),
    'codeblock 的标志物不该在标签形状的文本里命中（否则标志物判据是恒真的装饰品）');
  // 反向之二：**不可解析的形状**必须解析不出（防「解析器太宽，什么都算调用」）
  const bogus = '<tool_call>这里根本不是 JSON</tool_call>';
  assert.equal((parseAgentReply(bogus, { tools: TOOLS }).calls || []).length, 0,
    '非 JSON 的标签内容不得被解析成调用（宽容必须有边界）');
  // 反向之三：把 codeblock 的围栏去掉（正文裸 JSON）⇒ **不该**被当成 glm 的调用形状放行
  const noFence = JSON.stringify({ mcp_action: 'call', name: 'read', arguments: { path: 'README.md' } });
  assert.ok(!MARKER_BY_SHAPE[TRANSPORT_SHAPES.codeblock].test(noFence),
    '没有 ```json 围栏的裸 JSON 不该命中 codeblock 标志物（glm 教的就是围栏）');
});

test('④ 逐站四态表：教学形状 / 路由 / 解析结果（机读，供 doc 引用）', () => {
  // 本用例把 ① 的读数固化成**可引用的表**，避免「结论只活在测试输出里」。
  const table = SITES.map((s) => {
    const shape = transportShapeForSite(s.id);
    const note = transportNoteFor(s.id, TOOLS);
    const parsed = parseAgentReply(REPLY_BY_SHAPE[shape](), { tools: TOOLS });
    const calls = parsed?.calls || [];
    const markerOk = note ? MARKER_BY_SHAPE[shape].test(note) : false;
    return {
      siteId: s.id,
      shape,
      // 三态：PASS = 教学含标志物且回帖解析出 1 条；FAIL = 任一不成立
      status: (markerOk && calls.length === 1) ? 'PASS' : 'FAIL',
      markerOk,
      parsedCalls: calls.length,
    };
  });
  const bad = table.filter((r) => r.status !== 'PASS');
  assert.deepEqual(bad, [], '有任何一站的教学形状解析不回来时，这里必须红：'
    + JSON.stringify(bad));
  console.log('\n    [逐站四态 — 离线解析覆盖]\n'
    + table.map((r) => `    ${r.siteId.padEnd(9)} shape=${r.shape.padEnd(10)} marker=${r.markerOk ? '✔' : '✘'} calls=${r.parsedCalls} ${r.status}`).join('\n')
    + '\n    ⚠ 本表是**离线**判据（教学↔解析闭环），与真机四态是两回事：'
    + '真机还要求图/网页收得下、模型真的按教形状回帖（见 .tmp/real-lane/PHASE2-RESULTS.md）。');
});
