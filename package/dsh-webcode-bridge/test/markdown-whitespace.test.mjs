// markdown-whitespace.test.mjs — 逐字符驱动：外发字节必须与网页原文**逐字一致**（0.16.8）
//
// ## 用户症状（原话）
//
// > 「好像零点九几的时候，harness 显示的 Markdown 是没问题的，但现在渲染就会格式错乱」
// > 「#后面没有空格？代码块包裹没有换行？导致没有闭合？」
//
// ## 真机成因
//
// 桥的流式正文外发有一段 `PROSE_TAIL_CHARS = 8` 的滞后：正文永远只发到 `acc.length - 8`。
// 于是「本片放行」的区间常常**恰好是一个字符**——而那时 `proseChunk` 就可能正好是一个空格
// 或一个换行。旧判据
//
//     const tagDebris = /^[\s<>\/|\uFF5C]+$/.test(proseChunk);
//
// 把**纯空白**与 **ASCII 竖线 `|`** 都归进「标签残渣」，命中后走 else 分支静默推进游标、
// 一个字节都不发。后果：
//
//   • `## 标题` → `##标题`（标题级别丢失，整行塌成文本）
//   • 空行消失 → 段落与围栏不再分隔
//   • 围栏缺换行 → 代码块不闭合
//   • `| 列 A | 列 B |` → ` 列 A  列 B `（表格塌成一行）
//
// 回归窗口自 0.14.2（引入该判据）；0.9.x 没有这条分支，所以那时是正常的——与用户
// 「零点九几没问题」的观察完全吻合。
//
// ## 为什么既有护栏没抓住
//
// `markdown-block-integrity.test.mjs` 只断言「块内容 ≡ Σ增量」——本缺陷里**两条通道一起**
// 少同一个字节，所以那条判据全绿。而且它（以及全部既有用例）的 `deltas` 都是**粗粒度整块**
// （`deltas: [PROSE1, PROSE2]`），空白永远不会单独落在释放边界上。
//
// ## 本文件的判据（三条）
//
//   ① Σ text-delta 与网页原文**逐字相等**（这是本缺陷的直接反面）；
//   ② 块内容与 Σ text-delta 逐字相等（沿用 markdown-block-integrity 的契约）；
//   ③ 空白与表格竖线的**计数**必须一致（差分断言，专防「少一个空格」这类单字节丢失）。
//
// 逐字符驱动是本文件的要害：只有把每个字符单独喂进去，释放边界才会落在每个字符上。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const pkg = path.dirname(import.meta.dirname);

const TOOLS = [
  { name: 'read', description: '读文件', parameters: { type: 'object', properties: { file_path: {} }, required: ['file_path'] } },
];

function tmpDir() {
  try { return fs.mkdtempSync(path.join(os.tmpdir(), 'webcode-ws-')); } catch {
    const d = path.join(pkg, '.tmp', 'ws-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
    fs.mkdirSync(d, { recursive: true });
    return d;
  }
}

function mockCtx() {
  const registered = { adapter: null, routes: new Map() };
  const llm = {
    registerConfigurableProviders() {},
    registerAdapter(ids, adapter) { registered.adapter = adapter; },
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

/** 脚本驱动：deltas 是增量通道真正流出的片段，text 是网页给的权威全文。 */
function scriptedDriver({ deltas = [], text = '' }) {
  const status = {
    running: true, busy: false, preview: true, loggedIn: true,
    lastActivityAt: null, domReplyChars: null, lastEndReason: 'finished', lastEndReasonAt: Date.now(),
    recoveredTurns: 0, lastRecovered: null, lastStalledSettle: null, thinkingOnlyTurns: 0,
    conversations: {}, sessionSlot: { webSessionId: null, at: null, source: 'none' },
  };
  return {
    async sendTurn(key, message, { fresh = false, onDelta, onThink } = {}) {
      for (const d of deltas) onDelta?.(d);
      void onThink;
      return { text, sessionId: 'web-sess-ws', metrics: { endToEndMs: 1, firstResponseMs: 1 } };
    },
    async sendPrompt() { return { text, sessionId: 'web-sess-ws' }; },
    async resetConversation() {},
    conversationFor() { return null; },
    status() { return status; },
    async close() {},
  };
}

async function runStream({ deltas, text }) {
  const { apply } = await import(pathToFileURL(path.join(pkg, 'lib', 'index.js')).href);
  const { ctx, registered } = mockCtx();
  const disposer = apply(ctx, {
    port: 0, host: '127.0.0.1', requireConsent: false,
    driver: scriptedDriver({ deltas, text }), profileDir: tmpDir(),
  });
  const chunks = [];
  try {
    const stream = registered.adapter.stream({
      purpose: null, model: 'deepseek',
      messages: [{ role: 'user', content: '核对空白' }],
      tools: TOOLS, sessionId: 'ws-session',
    });
    for await (const c of stream) chunks.push(c);
    return { ok: true, chunks };
  } catch (err) {
    return { ok: false, error: err, chunks };
  } finally { try { disposer?.(); } catch { /* 测试替身 */ } }
}

/** 按块下标摊开：Σ text-delta 与文本块内容。 */
function split(chunks) {
  const deltas = new Map();
  for (const c of chunks) {
    if (c.type !== 'text-delta') continue;
    deltas.set(c.index, (deltas.get(c.index) || '') + c.text);
  }
  const ends = chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'text');
  return { sumDelta: [...deltas.values()].join(''), blockText: ends.map((e) => e.block.text).join('') };
}

const countOf = (s, re) => (s.match(re) || []).length;

/** 逐字符切片（步长 1 = 最严苛：释放边界落在每个字符上）。 */
function charwise(s, step = 1) {
  const out = [];
  for (let i = 0; i < s.length; i += step) out.push(s.slice(i, i + step));
  return out;
}

/** 三条判据一次查完。 */
async function assertByteExact(label, source, { step = 1, byLine = false } = {}) {
  const deltas = byLine ? source.split(/(?<=\n)/) : charwise(source, step);
  const r = await runStream({ deltas, text: source });
  assert.equal(r.ok, true, label + '：本轮不该失败——' + (r.ok ? '' : r.error?.message));
  const { sumDelta, blockText } = split(r.chunks);

  // ① 外发字节与原文逐字相等
  assert.equal(sumDelta, source,
    label + '：Σ text-delta 与网页原文**不逐字相等**——外发途中被吃掉了字符\n'
    + '  原文 = ' + JSON.stringify(source) + '\n'
    + '  外发 = ' + JSON.stringify(sumDelta));

  // ② 块内容与增量一致（沿用既有契约）
  assert.equal(blockText, sumDelta,
    label + '：块内容与 Σ text-delta 不一致\n'
    + '  块内容 = ' + JSON.stringify(blockText) + '\n'
    + '  Σ 增量 = ' + JSON.stringify(sumDelta));

  // ③ 空白与竖线计数（专防单字节丢失）
  for (const [name, re] of [['换行', /\n/g], ['空格', / /g], ['竖线', /\|/g], ['反引号', /`/g]]) {
    assert.equal(countOf(sumDelta, re), countOf(source, re),
      label + '：' + name + '计数不一致（原文 ' + countOf(source, re) + ' / 外发 ' + countOf(sumDelta, re) + '）');
  }
  return r.chunks;
}

// ── 素材：覆盖用户报的每一种走形 ────────────────────────────────────────────

const DOC = [
  '## 结论',
  '',
  '第一段正文，带一个行内 `code`。',
  '',
  '```js',
  'const a = 1;',
  'if (a) { console.log(a); }',
  '```',
  '',
  '### 细节',
  '',
  '| 列 A | 列 B |',
  '| --- | --- |',
  '| 1 | 2 |',
  '',
  '- 项目一',
  '- 项目二',
  '',
  '结尾段落。',
  '',
].join('\n');

const BAR = String.fromCharCode(0xFF5C);
const MARK = BAR + BAR + 'DSML' + BAR + BAR;
const CALL = [
  '<' + MARK + ' calls>',
  '<' + MARK + ' invoke name="read">',
  '<' + MARK + ' parameter name="file_path" string="true">doc/progress.md</' + MARK + ' parameter>',
  '</' + MARK + ' invoke>',
  '</' + MARK + ' calls>',
].join('\n');

// ── ① 标题级别：`## ` 的空格不能被吃 ──────────────────────────────────────
test('① 逐字符：标题的 `# ` 空格与空行必须逐字保留', async () => {
  await assertByteExact('① 标题', '## 标题\n\n正文。\n', { step: 1 });
});

// ── ② 整篇文档（标题 + 围栏 + 表格 + 列表），逐字符 ──────────────────────
test('② 逐字符：整篇 markdown 文档逐字保真（含围栏与表格）', async () => {
  await assertByteExact('② 整篇', DOC, { step: 1 });
});

// ── ③ 整篇文档，2 字符一块 ───────────────────────────────────────────────
test('③ step=2：整篇 markdown 文档逐字保真', async () => {
  await assertByteExact('③ step=2', DOC, { step: 2 });
});

// ── ④ 按行分块（真实 SSE 最常见的形态）──────────────────────────────────
test('④ 按行分块：整篇 markdown 文档逐字保真', async () => {
  await assertByteExact('④ 按行', DOC, { byLine: true });
});

// ── ⑤ 表格竖线专项：`|` 是 markdown 分隔符，不是标签字符 ─────────────────
test('⑤ 表格竖线不被当标签残渣吃掉', async () => {
  const table = '| 列 A | 列 B |\n| --- | --- |\n| 1 | 2 |\n';
  await assertByteExact('⑤ 表格', table, { step: 1 });
});

// ── ⑥ 纯空白分片：释放边界恰好切到空白时也必须外发 ──────────────────────
test('⑥ 空白单独成片时不得被静默丢弃', async () => {
  // 判据只在「空白夹在真实文本之间」时成立——那正是 PROSE_TAIL_CHARS 滞后下最常见的形态：
  // 累积量跨过阈值时，被放行的**恰好是一个空格或换行**。
  //
  // 整轮只有空白（如 deltas=['\n']）不属于本用例：桥的 assertNonEmpty 会把「正文、思考、
  // 图片全空」正确判成 empty response，那是应有的行为，不是缺陷。
  for (const [label, deltas] of [
    ['标题后的空行', ['## 标题', '\n', '\n', '正文。', '\n']],
    ['段落间的空格', ['段落一。', ' ', '段落二。']],
    ['表格各行', ['| A | B |', '\n', '| - | - |', '\n']],
    ['围栏前后换行', ['```js', '\n', 'x', '\n', '```', '\n']],
  ]) {
    const source = deltas.join('');
    const r = await runStream({ deltas, text: source });
    assert.equal(r.ok, true, label + '：本轮不该失败——' + (r.ok ? '' : r.error?.message));
    const { sumDelta } = split(r.chunks);
    assert.equal(sumDelta, source,
      label + '：空白分片被丢弃\n  原文 = ' + JSON.stringify(source) + '\n  外发 = ' + JSON.stringify(sumDelta));
  }
});

// ── ⑦ 带工具调用：调用前后的散文同样逐字保真 ────────────────────────────
test('⑦ 含调用：调用前后的散文逐字保真，协议不外发', async () => {
  const source = DOC.replace('### 细节', CALL + '\n\n### 细节');
  const deltas = charwise(source, 1);
  const r = await runStream({ deltas, text: source });
  assert.equal(r.ok, true, '⑦：本轮不该失败——' + (r.ok ? '' : r.error?.message));
  const { sumDelta } = split(r.chunks);

  // 协议本身不该外发，但**散文部分**必须逐字保留：把协议区间挖掉后比对。
  const prose = source.split(CALL).join('');
  for (const [name, re] of [['换行', /\n/g], ['空格', / /g], ['竖线', /\|/g]]) {
    assert.equal(countOf(sumDelta, re), countOf(prose, re),
      '⑦：' + name + '计数不一致（散文 ' + countOf(prose, re) + ' / 外发 ' + countOf(sumDelta, re) + '）');
  }
  assert.ok(!sumDelta.includes(BAR + BAR), '⑦：外发正文里出现了协议标记');
  const calls = r.chunks.filter((c) => c.type === 'block-end' && c.block?.type === 'tool-call');
  assert.equal(calls.length, 1, '⑦：那一条 read 调用必须仍被交出去');
});

// ── ⑧ 反向安全线：标签残渣仍必须被吃掉（本修复不得把 0.14.2 的修复倒回去）──
test('⑧ 标签残渣仍被静默丢弃（0.14.2 的修复不许回退）', async () => {
  // 真机形态：两个调用之间流出 `</` 碎片，用户看到「回复夹杂错误调用」。
  //
  // 覆盖范围（重要）：本用例只钉**流式循环内 tagDebris 分支**的行为——正文块已经
  // 开过、残渣夹在散文之间的那种形态。判据必须先把桥的 unparsedCallNotice 提示
  // 模板剔除：那个模板本来就含 `</tool_call>` 字样（见 lib/index.js 的
  // unparsedCallNotice），不剔除会命中模板自身。
  //
  // 不覆盖：整轮**只有**残渣、流式期间从未开过文本块的形态。那种轮次走收尾的
  // `!textOpen` 分支（proseSafeEnd + unparsedCallNotice），与「空白被当残渣吃掉」
  // 不是同一条路径，混在一起断言会把两件事说错。
  const stripNotice = (s) => String(s).replace(/<tool_call>[\s\S]*?<\/tool_call>/g, '');
  const deltas = ['前面有散文。', '\n', '</', '\n', '后面还有散文。'];
  const source = deltas.join('');
  const r = await runStream({ deltas, text: source });
  assert.equal(r.ok, true, '⑧：本轮不该失败——' + (r.ok ? '' : r.error?.message));
  const { sumDelta } = split(r.chunks);
  const body = stripNotice(sumDelta);
  assert.ok(!body.includes('</'),
    '⑧：标签残渣被外发进正文了（0.14.2 的修复回退）\n  正文（已剔除提示模板）= ' + JSON.stringify(body));
  // 反向：本修复不得把「吃掉残渣」扩大成「吃掉散文」——两侧散文必须都在。
  assert.ok(body.includes('前面有散文。'), '⑧：残渣之前的散文被误吃\n  ' + JSON.stringify(body));
  assert.ok(body.includes('后面还有散文。'), '⑧：残渣之后的散文被误吃\n  ' + JSON.stringify(body));
});
