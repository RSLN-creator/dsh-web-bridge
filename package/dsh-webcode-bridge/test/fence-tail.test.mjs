// fence-tail.test.mjs — 0.19.17 流式「调用围栏尾部」泄漏回归。
//
// ## 真机症状（用户原话：「正文有空白还有乱码」）
//
// GLM / z.ai 走 codeblock 传输（```json + 调用 JSON）。会话 `session-0b292806`
// turn2 的 assistant/message 里，正文块之间夹着一串 6 字符的小块：
//
//     [1] text "\n```\n\n"      [3] text "\n```\n\n``"     [5] text "\n```\n\n" …
//
// 也就是说**调用围栏与 JSON 开头本身**被当正文发进了会话。
//
// ## 根因（离线逐字符复现，`.tmp-probe/probe-fence-decision.mjs`）
//
// 流式循环里「正文能外发到哪」由 `findProtocolStart` 定。围栏是协议锚点，但它的
// 两条判据在**围栏刚开、JSON 还没吐出关键字段**的那一小段窗口里都还不成立：
//   · `firstCallFenceAt` 要求围栏体内已有 `"mcp_action":"call"` 或 `"arguments"`；
//   · `firstCallFenceAt` 对**未配平**的 JSON 返回 unclosed，但关键字段仍未出现。
// 于是 `findProtocolStart` 返回 -1，外发边界只剩 `PROSE_TAIL_CHARS`（8）这个定长
// 尾巴 ⇒ 围栏与 JSON 开头被一个字符一个字符地当正文发出去。而 `textSent` 单调
// 不回退、**发出去的字节收不回来**。
//
// 第二个入口：调用的 JSON 配平那一刻，它自己的闭合围栏 ` ``` ` **还没到**（闭合
// 围栏是随后的增量）。消费掉 JSON 时游标只能推到 JSON 末尾，而 ` ``` ` 单独出现
// 不是协议锚点（普通 markdown 代码块也是它）⇒ 闭合围栏同样被当正文发出。
//
// ## 修法（两条，都在外发上限上收窄，绝不放宽）
//
//  ① `unresolvedCallFenceAt`：``` 两两配对，落单的「还开着的围栏」+ 其后首格是
//     `{`（或尚未开始）⇒ 扣住；普通正文代码块（```js 后面跟代码）不扣。
//  ② `closingFenceAfter`：紧跟已消费协议区间、只隔空白的 ` ``` ` 划进协议区间。
//
// ## 本文件锁死的行为
//
//   ① 逐字符驱动：正文块里**不得出现任何反引号围栏残渣**（主回归）；
//   ② 三个连续调用全部解析出来（修法不得吞掉调用）；
//   ③ 普通 markdown 代码块（```js …）照旧即时外发——不能为了修调用围栏而
//      把正常代码块也扣住（那是流式观感的倒退）；
//   ④ 回复开头的代码块不受 `closingFenceAfter` 影响（它要求先消费过协议）；
//   ⑤ 两个纯函数的边界行为（含「围栏闭合后立即放行」的有界性）。

import test from 'node:test';
import assert from 'node:assert/strict';
import { apply } from '../lib/index.js';
import { unresolvedCallFenceAt, closingFenceAfter } from '../lib/agent-preset.js';

const user = (text) => ({ role: 'user', content: [{ type: 'text', text }] });
const TOOLS = [
  { name: 'todo_write', description: 't', parameters: { type: 'object', properties: { todos: { type: 'array' } }, required: ['todos'] } },
  { name: 'pwsh', description: 'p', parameters: { type: 'object', properties: { command: { type: 'string' }, description: { type: 'string' } }, required: ['command', 'description'] } },
];

/** 与真机同型：散文 + N 个各自带围栏的 codeblock 调用。 */
const call = (name, args) => '```json\n' + JSON.stringify({ mcp_action: 'call', name, arguments: args }) + '\n```\n\n';

/**
 * 驱动 adapter.stream：`reply` 是权威全文，按 `sliceChars` 切增量喂给 onDelta。
 * 必须用 deepseek 模型——只有 deepseek 槽会用注入的桩驱动，其它站点会真开浏览器。
 */
async function run(reply, sliceChars = 1, tools = TOOLS) {
  let adapter;
  const dispose = apply(
    { llm: { registerAdapter: (_, a) => { adapter = a; } }, get: () => null },
    {
      port: 0, requireConsent: false,
      driver: {
        status: () => ({ running: true }), close: async () => {}, resetConversation: async () => {},
        sendTurn: async (key, prompt, opts) => { for (let i = 0; i < reply.length; i += sliceChars) opts.onDelta?.(reply.slice(i, i + sliceChars)); return { text: null }; },
        sendPrompt: async (prompt, opts) => { for (let i = 0; i < reply.length; i += sliceChars) opts.onDelta?.(reply.slice(i, i + sliceChars)); return { text: null }; },
      },
    },
  );
  try {
    const chunks = [];
    for await (const c of adapter.stream({
      sessionId: 'fence-tail', model: 'deepseek:deepseek', tools, messages: [user('做事')],
    })) chunks.push(c);
    return chunks;
  } finally { await dispose(); }
}

const proseOf = (chunks) => chunks.filter((c) => c.type === 'text-delta').map((c) => c.text).join('');
const textBlocks = (chunks) => chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'text').map((c) => c.block.text);
const callNames = (chunks) => chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call').map((c) => c.block.name);

// ───────────────────────── ① 主回归：围栏不得进正文 ─────────────────────────

test('① 逐字符驱动：连续 3 个 codeblock 调用，正文里不得出现任何围栏残渣', async () => {
  const REPLY = '收到。这是一个组合任务，我先建立任务清单。\n\n'
    + call('todo_write', { todos: [{ content: 'a', status: 'in_progress' }] })
    + call('pwsh', { command: 'git status --short', description: 'Show git status' })
    + call('pwsh', { command: 'git log --oneline -5', description: 'Show log' });
  const chunks = await run(REPLY, 1);
  const prose = proseOf(chunks);
  assert.ok(!prose.includes('```'), '正文里不得出现围栏残渣，实际=' + JSON.stringify(prose));
  assert.ok(!prose.includes('"mcp_action"'), '正文里不得出现协议 JSON 头，实际=' + JSON.stringify(prose));
  assert.equal(prose, '收到。这是一个组合任务，我先建立任务清单。\n\n', '正文必须恰好是散文那一段');
  // 每个正文块同样不得含围栏。
  for (const b of textBlocks(chunks)) {
    assert.ok(!b.includes('```'), '正文块不得含围栏残渣，实际=' + JSON.stringify(b));
  }
});

// ───────────────────────── ② 修法不得吞掉调用 ─────────────────────────

test('② 三个连续调用全部派发，且顺序正确', async () => {
  const REPLY = '先建清单。\n\n'
    + call('todo_write', { todos: [{ content: 'a', status: 'in_progress' }] })
    + call('pwsh', { command: 'git status --short', description: 'Show git status' })
    + call('pwsh', { command: 'git log --oneline -5', description: 'Show log' });
  const chunks = await run(REPLY, 1);
  assert.deepEqual(callNames(chunks), ['todo_write', 'pwsh', 'pwsh'], '三个调用必须都解析出来且顺序不变');
  assert.equal(chunks.at(-1).type, 'finish');
  assert.equal(chunks.at(-1).reason.kind, 'tool-calls');
  // 同一个调用不得开两次块。
  const starts = chunks.filter((c) => c.type === 'block-start' && c.blockType === 'tool-call');
  assert.equal(starts.length, 3, '每个调用只开一个块');
});

// ───────────────── ③ 普通 markdown 代码块必须照旧即时外发 ─────────────────

test('③ 普通正文代码块（```js 跟代码）不被扣住', async () => {
  const REPLY = '下面是示例：\n\n```js\nconst a = 1;\n```\n\n结束。';
  const chunks = await run(REPLY, 1);
  const prose = proseOf(chunks);
  assert.ok(prose.includes('```js'), '普通代码块必须照旧外发，实际=' + JSON.stringify(prose));
  assert.ok(prose.includes('const a = 1;'), '普通代码块内容必须外发');
  assert.ok(prose.includes('结束。'), '代码块之后的正文必须外发');
  assert.equal(callNames(chunks).length, 0, '普通代码块不得被当成调用');
});

test('③b 普通代码块与调用混排：代码块外发，调用解析', async () => {
  const REPLY = '示例：\n\n```js\nconst a = 1;\n```\n\n先记一笔。\n\n'
    + call('todo_write', { todos: [{ content: 'x', status: 'pending' }] });
  const chunks = await run(REPLY, 1);
  const prose = proseOf(chunks);
  assert.ok(prose.includes('```js') && prose.includes('const a = 1;'), '示例代码块必须外发');
  assert.ok(prose.includes('先记一笔。'), '中间散文必须外发');
  assert.ok(!prose.includes('"mcp_action"'), '调用 JSON 不得进正文');
  assert.deepEqual(callNames(chunks), ['todo_write']);
});

// ───────────────── ④ closingFenceAfter 不误伤回复开头的代码块 ─────────────────

test('④ 回复以代码块开头（尚未消费过协议）不受影响', async () => {
  const REPLY = '```js\nconst a = 1;\n```\n\n就这样。';
  const chunks = await run(REPLY, 1);
  const prose = proseOf(chunks);
  assert.equal(prose, '```js\nconst a = 1;\n```\n\n就这样。', '开头代码块必须完整外发');
});

// ───────────────── ⑤ 两个纯函数的边界行为 ─────────────────

test('⑤ unresolvedCallFenceAt：未闭合调用围栏扣住，闭合后立即放行（有界）', () => {
  // 围栏开着、JSON 还没吐出关键字段 ⇒ 扣在围栏起点。
  const open = '散文。\n\n```json\n{"mcp_actio';
  assert.equal(unresolvedCallFenceAt(open), open.indexOf('```'));
  // 只有信息串、正文还没开始 ⇒ 先扣住。
  assert.equal(unresolvedCallFenceAt('散文。\n\n```json'), '散文。\n\n'.length);
  // 普通代码块（后面跟代码而不是 `{`）⇒ 不扣。
  assert.equal(unresolvedCallFenceAt('```js\nconst a = 1;'), -1);
  // 围栏闭合 ⇒ 配对抵消，立即放行。
  assert.equal(unresolvedCallFenceAt('```json\n{"mcp_action":"call"}\n```'), -1);
  // 已经外发过的区域不再扣（from 之后的才报告）。
  const done = '```json\n{"mcp_action":"call"}\n```\n\n```json\n{';
  assert.equal(unresolvedCallFenceAt(done, 0), done.lastIndexOf('```'));
  assert.equal(unresolvedCallFenceAt(done, done.lastIndexOf('```') + 3), -1);
});

test('⑤b closingFenceAfter：只认紧跟已消费区间的闭合围栏', () => {
  const json = '{"mcp_action":"call","name":"read"}';
  // 紧贴（只隔空白）⇒ 命中。
  assert.equal(closingFenceAfter(json + '\n```', json.length), json.length + 1);
  assert.equal(closingFenceAfter(json + '```', json.length), json.length);
  // 前面有散文 ⇒ 不是「已消费区间的闭合围栏」，不认（普通代码块）。
  assert.equal(closingFenceAfter(json + '\n\n正文\n\n```', json.length), -1);
  // 还没消费过任何协议（from<=0）⇒ 一律不认，回复开头的代码块不受影响。
  assert.equal(closingFenceAfter('```js\n', 0), -1);
});

/**
 * ★ 0.19.23：`closingFenceAfter` **不得把开启围栏当闭合围栏**。
 *
 * 真机缺陷（`session-53201b58` turn4 step1，用户报「正文里出现 json」）：
 * 增量分支对每个增量都调本函数，而下一个增量的开头常常正是**下一个调用的开启围栏**
 * `\n\n```json\n{…}`。旧判据只看「游标之后隔空白就是 ```」，于是把它当闭合围栏消费
 * （调用方 `protocolFrom = cf + 3`）——**只吃掉三个反引号**，后面那四个字符 `json`
 * 落在协议区间之外，被当正文发出去。会话里的形状逐字吻合：
 *   text:62, call, text:4("json"), call, text:4("json"), …
 *
 * 这条判据是**窄**的：只排除「信息串非空 + 体内是 JSON」的开启调用围栏；
 * 裸 ` ``` `（信息串为空）永远照常消费。
 */
test('★ 0.19.23 closingFenceAfter：开启的调用围栏不得被当闭合围栏消费', () => {
  const call1 = '{"mcp_action": "call", "name": "read", "arguments": {"path": "a"}}';
  const call2 = '{"mcp_action": "call", "name": "grep", "arguments": {"pattern": "b"}}';
  const acc = call1 + '\n```\n\n```json\n' + call2 + '\n```';
  const afterClose1 = call1.length + '\n```'.length;

  // ① 负判据（本次修的）：call2 的**开启**围栏不得被返回。
  assert.equal(closingFenceAfter(acc, afterClose1), -1,
    '把开启围栏 ```` ```json ```` 当闭合围栏返回了 —— 消费它只会吃掉三个反引号，'
    + '剩下 `json` 泄漏成正文');
  // 直接钉住「泄漏的就是那 4 个字符」这个因果，防止判据漂移。
  const cf = closingFenceAfter(acc, afterClose1);
  assert.notEqual(cf, acc.indexOf('```json'), '返回了开启围栏位置');

  // ② 正判据：真正的闭合围栏（裸 ```）必须照常返回。
  assert.equal(closingFenceAfter(acc, call1.length), call1.length + 1,
    '真正的闭合围栏被误伤 —— 那会让围栏反过来泄漏进正文');

  // ③ 刚开、还没写完的开启围栏（有信息串、无换行）同样不得消费。
  assert.equal(closingFenceAfter(call1 + '\n```\n\n```json', afterClose1), -1,
    '信息串还没写完的开启围栏被消费了（会把 `json` 漏出去）');

  // ④ 对照：围栏之后什么都没有（正常收尾形状）仍照常消费。
  assert.equal(closingFenceAfter(call1 + '\n```', call1.length), call1.length + 1);
});

// ───────────────── ⑥ 大切片（不是逐字符）同样不得泄漏 ─────────────────

test('⑥ 整段一次到达（非逐字符）同样不得泄漏围栏', async () => {
  const REPLY = '先记一笔。\n\n' + call('todo_write', { todos: [{ content: 'a', status: 'in_progress' }] });
  const chunks = await run(REPLY, 100000);
  const prose = proseOf(chunks);
  assert.ok(!prose.includes('```'), '整段到达时正文也不得含围栏，实际=' + JSON.stringify(prose));
  assert.deepEqual(callNames(chunks), ['todo_write']);
});

// ───── ⑦ 最高风险边界：普通 JSON 示例块（首格是 `{` 但不是调用）─────
//
// `unresolvedCallFenceAt` 的兼容性判据是「信息串之后首格是 `{`」。markdown 里
// 一个**普通的 JSON 示例块**（```json 后面跟对象字面量）恰好满足它——于是它会被
// **短暂扣住**，直到闭合围栏到达、配对抵消才放行。这是刻意接受的代价（扣住有界），
// 但必须钉死：**内容一个字节都不能丢**，只是晚一点到。

test('⑦ 普通 ```json 示例块内容不丢（只是推迟到闭合后放行）', async () => {
  const EXAMPLE = '```json\n{\n  "name": "demo",\n  "version": "1.0.0"\n}\n```';
  const REPLY = '配置示例：\n\n' + EXAMPLE + '\n\n以上。';
  const chunks = await run(REPLY, 1);
  const prose = proseOf(chunks);
  // 关键断言：内容必须完整——扣住是暂时的，不是丢弃。
  assert.ok(prose.includes('"name": "demo"'), 'JSON 示例块内容不得丢失，实际=' + JSON.stringify(prose));
  assert.ok(prose.includes('"version": "1.0.0"'), 'JSON 示例块内容不得丢失');
  assert.ok(prose.includes('配置示例：'), '示例之前的散文必须保留');
  assert.ok(prose.includes('以上。'), '示例之后的散文必须保留');
  // 它不是调用：不得派发任何工具。
  assert.equal(callNames(chunks).length, 0, 'JSON 示例块不得被当成调用');
});

test('⑦b 普通 ```json 示例块若流在此处断掉，收尾仍须交出全部正文', async () => {
  // 流断在示例块**闭合之前**：扣住的部分由收尾的 proseSafeEnd 决定去留。
  // 断言「不永久丢失」——这是扣住策略的兜底安全线。
  const REPLY = '配置示例：\n\n```json\n{\n  "name": "demo"\n}';
  const chunks = await run(REPLY, 1);
  const prose = proseOf(chunks);
  assert.ok(prose.includes('配置示例：'), '散文必须保留');
  assert.ok(prose.includes('"name": "demo"'), '断流时 JSON 示例内容也不得永久丢失，实际=' + JSON.stringify(prose));
});

// ───────── ⑧ 切分粒度穷举：泄漏是**边界敏感**的（0.19.23）─────────
//
// 这是本文件里最要紧的一条：0.19.23 的 `json` 泄漏在**逐字符**切分下**不复现**，
// 只在其它粒度下出现。真机同形复现读数（`.tmp/probe-fence-slices.mjs`）：
//   去掉修复 ⇒ 24 种粒度里 **15 种**泄漏（5,7,9,10,13,14,15,16,17,18,19,20,21,22,23）
//   带上修复 ⇒ **24/24 全部无泄漏**
// 而既有护栏只跑 sliceChars=1 —— 那个粒度恰好干净，于是它对这类缺陷**天然失明**。
//
// 结论不是「护栏写错了」，而是**输入分布太窄**：一条只有单一切分粒度的流式护栏，
// 对「边界敏感」的缺陷等于没有。所以这里显式穷举粒度，且**必须**留下已知会红的粒度。
//
// 真机症状（session-53201b58 turn4 step1）与本判据抓到的完全同形：
//   正文 = 散文 + "json"（每个 codeblock 调用漏出一个语言标签）。

test('★ 0.19.23 切分粒度穷举：任何增量边界下正文都不得漏出代码围栏的语言标签', async () => {
  const REPLY = '收到。这是一个组合任务，我先建立任务清单。\n\n'
    + call('todo_write', { todos: [{ content: 'a', status: 'in_progress' }] })
    + call('pwsh', { command: 'git status --short', description: 'Show git status' })
    + call('pwsh', { command: 'git log --oneline -5', description: 'Show log' });
  const EXPECT = '收到。这是一个组合任务，我先建立任务清单。\n\n';
  // sliceChars=1 已由 ① 覆盖（且它在本缺陷上恰好是干净的对照）。
  // 5 / 16 = 实测在旧代码下**必然泄漏**的粒度 —— 少了它们，这条判据抓不住回归。
  for (const n of [5, 16]) {
    const prose = proseOf(await run(REPLY, n));
    assert.ok(!prose.includes('json'),
      'slice=' + n + ' 时正文漏出了围栏语言标签 `json`，实际=' + JSON.stringify(prose));
    assert.ok(!prose.includes('```'),
      'slice=' + n + ' 时正文漏出了围栏反引号，实际=' + JSON.stringify(prose));
    assert.equal(prose, EXPECT, 'slice=' + n + ' 时正文必须恰好是散文那一段');
  }
});
