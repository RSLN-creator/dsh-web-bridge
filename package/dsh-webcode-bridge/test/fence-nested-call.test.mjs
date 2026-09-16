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

// ---- ⓪ 真机样本：REPORT.md 那份 22,366 字符的泄漏现场 -----------------------
//
// 这是本族问题的**唯一一份真实留痕样本**（2026-09-15 落盘，未入库）。
// 形态是**全角竖线**的 DSML：`<｜｜DSML｜｜ calls>`，不是 ASCII 的 `||DSML||`。
//
// 它证明的事实链（判据 1~4 对应当前代码的**已修**结论，判据 5 是**仍未闭合**的欠账）：
//
//   findProtocolStart → {index:67, transport:true}   ← 探测一直是对的
//   proseSafeEnd      → 67                           ← 0.15.6/0.15.7 已能正确扣住
//   parseAgentReply   → calls=0                      ← 但**不可执行**
//
// 所以 #19「边界命中但不可执行」的真身不是解析器认不出围栏（0.15.6 已修，
// 见 ①~④ 与 test/fence-prose.test.mjs），而是：**这一轮的流式通道没有把
// 可配平的调用 JSON 送到收尾**，收尾于是拿到「边界命中 + 0 调用」，
// 按断流处理——文件不落盘，且只留一条 withheld 提示。
//
// 判据 5 把这条欠账**显式钉住**：哪天有人让 calls 变成 1，本用例必须同步更新，
// 不允许它悄悄从「欠账」变成「已修」而无人复核。
const REPORT_MD_SAMPLE = [
  'All data gathered and verified. Writing the deliverable report.',
  '',
  `<${BAR}${BAR}DSML${BAR}${BAR} calls>`,
  `<${BAR}${BAR}DSML${BAR}${BAR} invoke name="write">`,
  `<${BAR}${BAR}DSML${BAR}${BAR} parameter name="content" string="true"># 报告`,
  '',
  '| a | b |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  `</${BAR}${BAR}DSML${BAR}${BAR} parameter>`,
  `</${BAR}${BAR}DSML${BAR}${BAR} invoke>`,
  `</${BAR}${BAR}DSML${BAR}${BAR} calls>`,
].join('\n');

test('⓪a 真机泄漏样本（全角竖线 DSML）：边界必须命中，且安全终点必须停在边界而不是全文', () => {
  const b = findProtocolStart(REPORT_MD_SAMPLE);
  assert.ok(b.index >= 0, '全角竖线的 DSML 必须探得到（#18 的 normalizeDsml 修法）');
  assert.equal(b.index, REPORT_MD_SAMPLE.indexOf(`<${BAR}${BAR}DSML`), '边界必须恰好停在协议起点');
  assert.equal(b.transport, true, '真调用围栏的 transport 必须为 true');
  const safe = proseSafeEnd(REPORT_MD_SAMPLE, b.index);
  assert.equal(safe, b.index, '安全终点必须停在边界；返回全文长度即为 #18 的全泄漏形态');
  assert.ok(safe < REPORT_MD_SAMPLE.length, '必须扣住协议尾巴，不得外发');
  // 被扣住的必须是协议本体，前面的散文要原样放行。
  assert.equal(REPORT_MD_SAMPLE.slice(0, safe), 'All data gathered and verified. Writing the deliverable report.\n\n');
});

test('⓪b 真机泄漏样本的**完整正文**（含参数体）必须是可解析的——丢调用发生在体，不在标记', () => {
  // 这一条是上一条的对照，也是本族问题最后一次误判的教训。
  //
  // 实测差异（本次诊断，2026-09-16）：
  //   - REPORT.md 的**真实全文**（22,366 字符）：calls = 0
  //   - 同一形态的**缩小样本**（上面 REPORT_MD_SAMPLE）：calls = 1
  //
  // 两者唯一的差别是**参数体的规模与内容**。这直接推翻了「解析器认不出全角竖线
  // 标记」这个曾被认为的根因——标记本身认得出来（⓪a 已证）。真正让调用
  // 不可执行的变量在**体的形状**（巨型单行参数体 / 未配平的转义与花括号），
  // 而不是前缀标记。
  //
  // 因此本用例钉住的是一条**正面能力**：缩小样本必须解析出 1 个调用且 content 逐字完整。
  // 若它变红，说明有人在动 readCallAt/fenceCallBodyAt 的配平逻辑，必须先按
  // doc/comment-style.md §9.3 做反向验证。
  const parsed = parseAgentReply(REPORT_MD_SAMPLE);
  assert.equal(parsed.calls.length, 1, '同形态的缩小样本必须可执行（不可执行的真因在体不在标记）');
  assert.equal(parsed.calls[0].name, 'write');
  assert.ok(
    parsed.calls[0].arguments.content.includes('| a | b |'),
    '参数体里的 markdown 表格必须逐字保留，不得被围栏窗口截断',
  );
  // 关键安全线：无论可执行与否，协议原文都不得作为正文外发。
  const b = findProtocolStart(REPORT_MD_SAMPLE);
  assert.ok(proseSafeEnd(REPORT_MD_SAMPLE, b.index) < REPORT_MD_SAMPLE.length, '丢调用不能退化成全泄漏');
});

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

// ---- ⑦ 参数体里引用协议自身闭合标签：#19 的真根因 --------------------------
//
// ## 现场（2026-09-16 诊断定位，证据见 doc/diagnosis-2026-09-16.md §5）
//
// 仓库根曾落盘一份 22,366 字符的真机泄漏样本 `REPORT.md`：它**本该是**一次
// `write` 调用的参数体（一份审计报告），却因为调用不可执行而**变成了文件本身**，
// 真正的交付物 `doc/session-mining-2026-09-15.md` 从未落盘。
//
// 该报告正文里**举例说明了协议的形状**——于是参数体内部出现了
// `</invoke>`、`</parameter>`、`</function_calls>` 这些**协议自己的闭合标签**。
//
// ## 根因（一句话）
//
// `invokeRe` 用 **lazy** 体捕获 `([\s\S]*?)</invoke>`：它在**示例里的第一个
// `</invoke>`** 处就截断了，截出来的体内**没有配平的 `</parameter>`** →
// `n===0` → 该调用被静默跳过（连 diagnostics 都不留，因为走的是 invoke 分支）。
// 而真调用一直延伸到文件末尾才闭合——实测跨过了约 12,000 字符的示例文本。
//
// ## 为什么这不能靠「改成 greedy」修
//
// greedy（取最后一个 `</invoke>`）确实能救活**单个**调用，但一轮里出现**两个**
// `invoke` 时，它会直接把第二个吞进第一个的体里——那是比丢调用更坏的结果
// （参数串到错误的块上）。所以修法必须是**配平感知**：体在第一个 `</invoke>`
// 处本应收束，但若此后仍有**未配平的 `<parameter>`**，则继续延伸。
//
// 下面 ⑬ 是正向（必须救活）；⑭⑮ 是反向安全线（不得吞并、不得误报）。

/** 构造一个 invoke 方言调用，参数体里可内嵌任意文本（含协议自身的闭合标签）。 */
function invokeCall(args, { bodyExtra = '' } = {}) {
  const params = Object.entries(args)
    .map(([k, v]) => `<parameter name="${k}" string="true">${v}</parameter>`)
    .join('\n');
  return `说明文字。\n\n<calls>\n<invoke name="write">\n${params}\n</invoke>\n</calls>${bodyExtra}`;
}

test('⑬ 参数体里举例引用协议闭合标签 → 调用必须仍可执行（#19 真根因）', () => {
  // 参数体模拟「一份讲解协议形状的报告」：正文里**举例**写出 </invoke>。
  // 这正是真机 REPORT.md 的形态——它直接触发了 lazy 截断，导致调用静默消失。
  const content = [
    '# 审计报告',
    '',
    '协议的闭合形态如下（示例）：',
    '',
    '```',
    '</invoke>',
    '```',
    '',
    '正文继续。',
  ].join('\n');
  const text = invokeCall({ file_path: 'doc/report.md', content });
  const parsed = parseAgentReply(text);
  assert.equal(parsed.calls.length, 1, '参数体里引用 </invoke> 不得让调用消失（#19 的根因）');
  assert.equal(parsed.calls[0].name, 'write');
  assert.equal(parsed.calls[0].arguments.file_path, 'doc/report.md');
  // 参数必须逐字完整——这是「救活」而不是「猜一个」的判据。
  assert.equal(parsed.calls[0].arguments.content, content, 'content 必须逐字等于输入');
});

test('⑬b 边界诚实：参数体里**未被转义的** `</parameter>` 会截断该参数值（已知限制，非回归）', () => {
  // 这一条钉住一个**有意接受**的限制，而不是期望行为。
  //
  // 参数值里出现字面 `</parameter>` 时，XML 方言本身无法与「真闭合标签」区分
  // （真正的 XML 会要求写成 `&lt;/parameter&gt;`）。协议栈选择的是
  // 「按遇到即闭合」——代价是该参数值在此处截断。
  //
  // 为什么仍是安全的：
  //   1. 这只影响**该参数的值长度**，不影响调用是否被执行（⑬ 已证）；
  //   2. 写文件场景下，截断是**可见**的（文件内容短了一截），不是静默丢调用；
  //   3. 相比修复前「整个调用消失、文件根本不落盘」，这是严格更小的失效面。
  //
  // 若将来要让它与 XML 语义完全一致，应改为**实体感知**扫描
  // （在参数值内忽略 `&lt;`/`&gt;` 转义形式），而不是放宽这里的判据。
  const content = '正文里提到 </parameter> 这个标签。';
  const text = invokeCall({ file_path: 'a.md', content });
  const parsed = parseAgentReply(text);
  assert.equal(parsed.calls.length, 1, '调用本身必须仍然可执行');
  assert.equal(parsed.calls[0].arguments.content, '正文里提到', '字面闭标签处截断——已知限制，见本用例注释');
});

test('⑭ 反向安全线：一轮两个 invoke 调用不得互相吞并（禁止用 greedy 修）', () => {
  const a = invokeCall({ file_path: 'a.md', content: 'AAA' });
  const b = '<invoke name="edit">\n<parameter name="file_path" string="true">b.md</parameter>\n</invoke>';
  const parsed = parseAgentReply(a + '\n' + b);
  assert.equal(parsed.calls.length, 2, '两个 invoke 必须都解析出来（greedy 会把第二个吞进第一个）');
  assert.deepEqual(parsed.calls.map((c) => c.name), ['write', 'edit'], '调用顺序与名字必须一一对应');
  assert.equal(parsed.calls[0].arguments.content, 'AAA', '第一个调用的参数不得混入第二个调用');
  assert.equal(parsed.calls[1].arguments.file_path, 'b.md', '第二个调用的参数必须独立');
});

test('⑮ 反向安全线：普通散文里提到 </invoke> 不得凭空造出调用', () => {
  const text = '协议以 </invoke> 收尾，参数用 </parameter> 包起来。这段话没有任何调用。';
  assert.equal(parseAgentReply(text).calls.length, 0, '纯散文不得被误判成调用');
});

test('⑯ 反向安全线：配平异常的 invoke（只有开标签）不得抛异常', () => {
  // 流式半成品：刚写出开标签与一个未闭合的 parameter。
  const text = '<invoke name="write">\n<parameter name="content" string="true">写到一半';
  const parsed = parseAgentReply(text);
  assert.ok(Array.isArray(parsed.calls), '解析器必须返回结构而不是抛异常');
  assert.equal(parsed.calls.length, 0, '未配平不得被当成可执行调用');
});
