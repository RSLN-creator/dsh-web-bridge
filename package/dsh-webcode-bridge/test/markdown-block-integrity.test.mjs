// markdown-block-integrity.test.mjs — 文本块的「块内容」必须与「已外发的增量」逐字一致（0.16.4）。
//
// ## 用户症状（原话）
//
// > 「有些 markdown 渲染有些不渲染」
//
// 界面上的正文有两个消费者：**流式增量**（`text-delta`，边到边渲染）与**块内容**
// （`block-end.block.text`，收尾时写进会话、也是 Markdown 真正被渲染的那一份）。两者
// 只要差一段，用户就会看到「同一段话，一处有格式、一处是光秃秃的文本」——而差异不是
// 随机噪声，是**两条通道的字节不同**。因此这条判据必须是「逐字相等」，不是「看起来差不多」。
//
// ## 真机成因（本文件用脚本驱动复现的那一类）
//
// 网页的**权威全文**（驱动 `sendTurn` 返回的 `result.text`）与**增量通道**（`onDelta`）
// 不必等量：解码器对 fragments 做静默替换时不补发增量、断流轮只补到一半、末段只在收尾
// 才拿到。旧收口逻辑在「权威全文比增量多一段」时只把**块内容**写成权威全文，**不补发**
// 那段增量 —— 于是块内容比界面上的增量多一段，两侧字节不同。
//
// ## 判据（三条，逐块）
//
//   ① 每个文本块的 `block-end.text` 与该块下标的 Σ `text-delta` **逐字相等**；
//   ② 同一个下标不得出现**两个** block-end（重复收口 = 界面重复渲染同一块）；
//   ③ 块内容还必须等于**权威散文**（权威全文剥掉协议的那部分）——只保证 ① 的话，
//      「两侧一起少一段」也会全绿，而用户看到的仍是「少了半句话」。
//
// 另外钉一条协议安全线：任何 text-delta / 块内容里**不得出现协议标记**（0 字节）。
//
// ## 为什么是接线级用例（不是纯函数）
//
// 判据落在 `lib/index.js` 的流式收尾（`textSent` / `proseSent` / `proseBlockStart` 三个
// 游标的配合），只有真的跑一遍 `adapter.stream()` 才会经过它。脚本驱动只提供「增量多少、
// 权威全文多少」这组输入，**不替被测代码做任何判断**——与 test/watchdog-first-byte.test.mjs
// 同一手法（那份钉相位窗口，这份钉字节一致）。
//
// ## 反向验证纪律（doc/comment-style.md §9.3）
//
// 把收尾的「补发剩余片段」那一步等价去掉（%TEMP% 等价拷贝），②③ 必须变红：
// 块内容仍是权威散文，而 Σ 增量少一段。记录见报告。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = path.dirname(import.meta.dirname);

/** U+FF5C：协议标记字符，用码位现造（源码里不出现该字符本身）。 */
const BAR = String.fromCharCode(0xFF5C);
const MARK = BAR + BAR + 'DSML' + BAR + BAR;

/** 本会话下发的工具表：必须让收尾解析能认出一条真调用（走工具轮的收尾分支）。 */
const TOOLS = [
  { name: 'read', description: '读文件', parameters: { type: 'object', properties: { file_path: {} }, required: ['file_path'] } },
];

/** 临时目录：本机沙箱下 `os.tmpdir()` 可能 ACL 受限（见 doc/progress.md「已知环境约束」），失败就落到包内 .tmp。 */
function tmpDir() {
  try { return fs.mkdtempSync(path.join(os.tmpdir(), 'webcode-blocks-')); } catch {
    const d = path.join(pkg, '.tmp', 'blocks-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}

/** 最小 DSH 宿主替身：只需要 llm.registerAdapter 与 webServer.register。 */
function mockCtx() {
  const registered = { adapter: null, adapterIds: null, routes: new Map() };
  const llm = {
    registerConfigurableProviders() {},
    registerAdapter(ids, adapter) { registered.adapter = adapter; registered.adapterIds = [...ids]; },
  };
  const ctx = {
    llm,
    get(name) {
      if (name === 'llm') return llm;
      if (name === 'webServer') return { register: ({ path: p, handler }) => { registered.routes.set(p, handler); } };
      return undefined;
    },
  };
  return { ctx, registered };
}

/**
 * 脚本驱动：`deltas` 是**增量通道**真正流出的片段，`text` 是网页那份**权威全文**。
 * 两者的差就是本文件要复现的输入（权威全文多于增量通道）。
 */
function scriptedDriver({ deltas = [], text = '' }) {
  const calls = [];
  const status = {
    running: true, busy: false, preview: true, loggedIn: true,
    lastActivityAt: null, domReplyChars: null, lastEndReason: 'finished', lastEndReasonAt: Date.now(),
    recoveredTurns: 0, lastRecovered: null, lastStalledSettle: null, thinkingOnlyTurns: 0,
    conversations: {}, sessionSlot: { webSessionId: null, at: null, source: 'none' },
  };
  return {
    calls,
    async sendTurn(key, message, { fresh = false, onDelta, onThink } = {}) {
      calls.push({ key, fresh, messageChars: String(message || '').length });
      for (const d of deltas) onDelta?.(d);
      // 刻意**不**调 `onThink('')`：空思考事件在中继侧与「本轮结束」标记同形（各字段全 falsy），
      // 会在适配器里被读成收尾，于是权威全文被丢掉——那是本护栏的输入错误，不是产品行为。
      // 要发思考就发非空文本（见 test/watchdog-first-byte.test.mjs 的 `onThink?.('（思考）')`）。
      void onThink;
      return { text, sessionId: 'web-sess-blocks', metrics: { endToEndMs: 1, firstResponseMs: 1 } };
    },
    async sendPrompt() { return { text, sessionId: 'web-sess-blocks' }; },
    async resetConversation() {},
    conversationFor() { return null; },
    status() { return status; },
    async close() {},
  };
}

/** 跑一轮真实适配器流，返回全部 chunk（失败时连错误一起带回）。 */
async function runStream({ driver, tools = TOOLS, messages = [{ role: 'user', content: '核对块完整性' }] }) {
  const { apply } = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href);
  const { ctx, registered } = mockCtx();
  const disposer = apply(ctx, {
    port: 0,
    host: '127.0.0.1',
    requireConsent: false,
    driver,
    profileDir: tmpDir(),
  });
  const chunks = [];
  try {
    const stream = registered.adapter.stream({
      purpose: null,
      model: 'deepseek',
      messages,
      tools,
      sessionId: 'blocks-session',
    });
    for await (const c of stream) chunks.push(c);
    return { ok: true, chunks };
  } catch (err) {
    return { ok: false, error: err, chunks };
  } finally {
    try { disposer?.(); } catch { /* 测试替身，忽略 */ }
  }
}

/** 按块下标把 chunk 摊开：Σ text-delta 与每个 block-end 的块内容。 */
function textBlocks(chunks) {
  const deltas = new Map();
  for (const c of chunks) {
    if (c.type !== 'text-delta') continue;
    deltas.set(c.index, (deltas.get(c.index) || '') + c.text);
  }
  const ends = chunks
    .filter((c) => c.type === 'block-end' && c.block?.type === 'text')
    .map((c) => ({ index: c.index, text: c.block.text }));
  return { deltas, ends };
}

/**
 * 三条判据一次查完（①逐字相等 ②一个下标一个 block-end ③等于权威散文）。
 *
 * ③ 的期望值由用例显式给出，**不调用实现自己的 stripProtocolText**——否则断言会退化成
 * 「函数等于它自己」，块内容少一段也照样绿。
 */
function assertBlockIntegrity(r, expectedProse, label) {
  assert.equal(r.ok, true, label + '：本轮不该失败——' + (r.ok ? '' : r.error?.message));
  const { deltas, ends } = textBlocks(r.chunks);
  assert.ok(ends.length >= 1, label + '：一个文本块都没有（正文被整段吞掉了）');

  const seen = new Set();
  for (const end of ends) {
    assert.ok(!seen.has(end.index), label + '：下标 ' + end.index + ' 出现了两个文本块收口（界面会重复渲染同一块）');
    seen.add(end.index);
    assert.equal(deltas.get(end.index) ?? '', end.text,
      label + '：下标 ' + end.index + ' 的块内容与 Σ text-delta **不逐字一致**（用户看到的'
      + '「有些 markdown 渲染有些不渲染」就是这一条红了）\n'
      + '  块内容  = ' + JSON.stringify(end.text) + '\n'
      + '  Σ 增量  = ' + JSON.stringify(deltas.get(end.index) ?? ''));
  }
  const whole = ends.map((e) => e.text).join('');
  assert.equal(whole, expectedProse,
    label + '：文本块合起来不等于权威散文——块内容与网页给的全文不一致（少一段或多一段都算）\n'
    + '  实际 = ' + JSON.stringify(whole) + '\n'
    + '  期望 = ' + JSON.stringify(expectedProse));
  // 协议安全线：任何外发的正文里不得出现标记（0 字节）。
  for (const c of r.chunks) {
    if (c.type === 'text-delta') {
      assert.ok(!c.text.includes(BAR + BAR), label + '：text-delta 里出现了协议标记：' + JSON.stringify(c.text));
    }
    if (c.type === 'block-end' && c.block?.type === 'text') {
      assert.ok(!c.block.text.includes(BAR + BAR), label + '：块内容里出现了协议标记：' + JSON.stringify(c.block.text));
    }
  }
  return r.chunks;
}

// ── 用例素材：权威全文 = PROSE1 + CALL + PROSE2 ──────────────────────────────

const PROSE1 = '## 结论\n第一段正文由增量通道送达，这一段应当两侧逐字相同。\n';
const PROSE2 = '\n第二段正文只存在于网页给的权威全文里，增量通道没有送出它。\n';
const CALL = [
  '<' + MARK + ' calls>',
  '<' + MARK + ' invoke name="read">',
  '<' + MARK + ' parameter name="file_path" string="true">doc/progress.md</' + MARK + ' parameter>',
  '</' + MARK + ' invoke>',
  '</' + MARK + ' calls>',
].join('\n');

// ── ① 对照：增量通道把全文都送了（恒等场景，不该有任何差异）──────────────────

test('① 对照：增量与权威全文相同时，块内容 = Σ 增量 = 权威散文', async () => {
  const text = PROSE1 + PROSE2;
  const r = await runStream({ driver: scriptedDriver({ deltas: [PROSE1, PROSE2], text }) });
  assertBlockIntegrity(r, text, '① 恒等场景');
});

// ── ② 权威全文多于增量通道（无调用）：末段只走收尾通道，必须补发增量 ──────────

test('② 权威全文多出一段（无调用）：块内容必须等于全文，且那段必须补发成 text-delta', async () => {
  const text = PROSE1 + PROSE2;
  const r = await runStream({ driver: scriptedDriver({ deltas: [PROSE1], text }) });
  const chunks = assertBlockIntegrity(r, text, '② 权威全文多一段');
  const { deltas, ends } = textBlocks(chunks);
  assert.ok((deltas.get(ends[0].index) || '').includes('第二段正文只存在于'),
    '② 末尾那段没有被补发成 text-delta：只写进块内容的话，界面上那一块永远不渲染');
});

// ── ③ 调用只存在于权威全文（增量通道停在调用前）：块内容与增量都要含调用后的散文 ──

test('③ 调用只在权威全文里（增量只送了调用前的散文）：块内容 = PROSE1+PROSE2，协议不外发', async () => {
  const text = PROSE1 + CALL + PROSE2;
  const r = await runStream({ driver: scriptedDriver({ deltas: [PROSE1], text }) });
  const chunks = assertBlockIntegrity(r, PROSE1 + PROSE2, '③ 调用只在权威全文里');
  const calls = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
  assert.equal(calls.length, 1, '权威全文里那一条 read 调用必须仍被交出去（补正文不能吃掉调用）');
  assert.equal(calls[0].block.name, 'read');
});

// ── ④ 反向安全线：块内容不得比增量多（这正是用户看到的那种不一致）─────────────

test('④ 反向安全线：任何下标都不许出现「块内容比 Σ 增量多一段」', async () => {
  // 与 ③ 同一组输入，但断言方向单列：这条红就是用户那句「有些 markdown 渲染有些不渲染」。
  const text = PROSE1 + CALL + PROSE2;
  const r = await runStream({ driver: scriptedDriver({ deltas: [PROSE1], text }) });
  assert.equal(r.ok, true, '本轮不该失败：' + (r.ok ? '' : r.error?.message));
  const { deltas, ends } = textBlocks(r.chunks);
  const bad = ends.filter((e) => (deltas.get(e.index) ?? '') !== e.text);
  assert.deepEqual(bad.map((e) => e.index), [],
    '下标 ' + JSON.stringify(bad.map((e) => e.index)) + ' 的块内容与增量不一致：\n'
    + bad.map((e) => '  块内容=' + JSON.stringify(e.text) + ' Σ增量=' + JSON.stringify(deltas.get(e.index) ?? '')).join('\n'));
});

// ── ⑤ 断流轮：权威全文里协议只到一半时，块内容仍必须与增量一致 ────────────────

test('⑤ 断流轮（协议只到一半、无完整调用）：块内容与增量仍逐字一致，且协议不外发', async () => {
  // 权威全文 = 散文 + 半截 invoke（没有闭合标签）⇒ 解析不出可执行调用。
  // 这一族的正确行为是「本轮没有可交付正文 / 附归因提示」，但**块内容与增量必须仍然一致**。
  const half = PROSE1 + '\n<' + MARK + ' calls>\n<' + MARK + ' invoke name="read">\n<' + MARK + ' parameter name="file_path" string="true">doc/pro';
  const r = await runStream({ driver: scriptedDriver({ deltas: [PROSE1], text: half }) });
  const chunks = assertIntegrityOnly(r, '⑤ 断流轮');
  assert.ok(chunks.some((c) => c.type === 'block-end' && c.block?.type === 'text'),
    '⑤ 断流轮连一个文本块都没有：用户看不到任何归因（这是 0.15.5 记过的那类「思考完就没了」）');
});

/**
 * 只查「块内容 === Σ 增量」这一条（②③④ 的三条判据在 ⑤ 里不适用：断流轮的权威散文
 * 无法在用例里手写，而手写它等于替实现断言「它该发哪一段」）。
 */
function assertIntegrityOnly(r, label) {
  assert.equal(r.ok, true, label + '：本轮不该失败——' + (r.ok ? '' : r.error?.message));
  const { deltas, ends } = textBlocks(r.chunks);
  assert.ok(ends.length >= 1, label + '：一个文本块都没有');
  for (const end of ends) {
    assert.equal(deltas.get(end.index) ?? '', end.text,
      label + '：下标 ' + end.index + ' 的块内容与 Σ text-delta 不逐字一致\n'
      + '  块内容 = ' + JSON.stringify(end.text) + '\n   Σ 增量 = ' + JSON.stringify(deltas.get(end.index) ?? ''));
  }
  for (const c of r.chunks) {
    if (c.type === 'text-delta') assert.ok(!c.text.includes(BAR + BAR), label + '：增量里出现协议标记');
    if (c.type === 'block-end' && c.block?.type === 'text') assert.ok(!c.block.text.includes(BAR + BAR), label + '：块内容里出现协议标记');
  }
  return r.chunks;
}
