// composer-write.test.mjs — 「网页输入框写入」的决策护栏（0.14.5）。
//
// 背景（真机证据，非推测）：2026-09-14 的会话 `session-c710ef6e` 的 turn/end 里
// 留下了一条直接证据：
//
//   locator.fill: Timeout 30000ms exceeded
//   - locator resolved to <textarea rows="2" name="search" … placeholder="给 DeepSeek 发送消息 ">
//   - fill("# 可用本地工具…(+807789)
//
// 一次性把 80 万字符交给 fill() 时，Playwright 在网页侧整段卡住，30s 后超时；
// 卡住期间没有任何中间态可读，事后只看到一个光秃秃的超时。
//
// 修法是把「多少算太长」（composerWritePlan）与「卡住怎么判」（stallStep）
// 抽成纯函数——这两个判断是会随站点变化的阈值语义，写成可断言的数据比埋在
// 两个 async 循环里可靠（与 composerStrategy 的既有做法一致）。
//
// 为什么这些用例不是空转：它们钉住的是**边界与反例**，即「改坏了会怎样」。
import test from 'node:test';
import assert from 'node:assert/strict';
import { composerWritePlan, stallStep, composerStrategy, composerEchoVerdict, EDITOR_BLOCK_TEXT } from '../lib/browser-driver.js';

// ---------------------------------------------------------- composerWritePlan

test('写入计划：小消息走 single（fill 最快，不引入额外往返）', () => {
  const p = composerWritePlan({ length: 500, chunkChars: 20_000 });
  assert.equal(p.mode, 'single');
  assert.equal(p.chunks, 1);
  assert.equal(p.total, 500);
});

test('写入计划：恰好等于块上限仍是 single（off-by-one 不能把整条消息拆成两块）', () => {
  const p = composerWritePlan({ length: 20_000, chunkChars: 20_000 });
  assert.equal(p.mode, 'single');
  assert.equal(p.chunks, 1);
});

test('写入计划：超过上限一块即分块，块数按 ceil 计算', () => {
  assert.equal(composerWritePlan({ length: 20_001, chunkChars: 20_000 }).mode, 'chunked');
  assert.equal(composerWritePlan({ length: 20_001, chunkChars: 20_000 }).chunks, 2);
  assert.equal(composerWritePlan({ length: 60_000, chunkChars: 20_000 }).chunks, 3);
  // 真机那条：807789 字符、默认 20000 → 41 块
  assert.equal(composerWritePlan({ length: 807_789, chunkChars: 20_000 }).chunks, 41);
});

test('写入计划：0 长度是 single 且 0 块（空消息不该假装写了一块）', () => {
  const p = composerWritePlan({ length: 0 });
  assert.equal(p.mode, 'single');
  assert.equal(p.chunks, 0);
});

test('写入计划：非法 chunkChars 走默认，并 clamp 到 [1000, 200000]', () => {
  // 0 / NaN / 负数 → 默认 20000（不是「每 0 字符一块」的死循环）
  for (const bad of [0, NaN, -5, null, undefined, 'abc']) {
    assert.equal(composerWritePlan({ length: 100, chunkChars: bad }).chunkChars, 20_000, 'chunkChars=' + bad);
  }
  // 极小值被抬到 1000：配置成 1 会把「卡死」换成「每字符一次 CDP 往返」，更糟
  assert.equal(composerWritePlan({ length: 100, chunkChars: 1 }).chunkChars, 1_000);
  // 极大值被压到 200000：否则又回到「一次性写太长」
  assert.equal(composerWritePlan({ length: 100, chunkChars: 10_000_000 }).chunkChars, 200_000);
});

test('写入计划：负数长度按 0 处理（不得出现 chunks=-1）', () => {
  const p = composerWritePlan({ length: -100, chunkChars: 20_000 });
  assert.equal(p.total, 0);
  assert.equal(p.chunks, 0);
});

// ---------------------------------------------------------------- stallStep

test('停滞判定：长度在涨就重置计数（正常写入不得被判死）', () => {
  let s = stallStep(-1, 20_000, 0);
  assert.equal(s.stalled, 0);
  assert.equal(s.died, false);
  s = stallStep(s.prevLen, 40_000, s.stalled);
  assert.equal(s.stalled, 0);
  s = stallStep(s.prevLen, 60_000, s.stalled);
  assert.equal(s.died, false);
});

test('停滞判定：单块不涨只记 1，连续两块才判死（富文本一拍延迟不得误杀）', () => {
  // 这一条是给 doubao/kimi 的：tiptap/ProseMirror 插入大块后需要一拍才把内部
  // 文档同步到 DOM，单块回读偶尔读到旧长度。只判一块会把正常站点误杀。
  let s = stallStep(20_000, 20_000, 0);
  assert.equal(s.stalled, 1);
  assert.equal(s.died, false, '单块不涨就判死会误杀富文本站点');
  s = stallStep(s.prevLen, 20_000, s.stalled);
  assert.equal(s.stalled, 2);
  assert.equal(s.died, true, '连续两块不涨必须判死，否则退回 30s 超时');
});

test('停滞判定：长度**变短**也计入停滞（被网页清空同样是卡住）', () => {
  const s = stallStep(20_000, 5_000, 0);
  assert.equal(s.stalled, 1);
  assert.equal(s.prevLen, 5_000);
});

test('停滞判定：回读失败（null）不计数、不重置、不判死', () => {
  // 元素被替换/页面转场时 readComposer 返回 null。据 null 判死会把「读不到」
  // 误报成「写不进」——那是另一类故障，由超时与错误码负责。
  const s = stallStep(20_000, null, 1);
  assert.equal(s.stalled, 1, 'null 不得重置已有计数');
  assert.equal(s.died, false);
  assert.equal(s.prevLen, 20_000);
});

test('停滞判定：prevLen 非数字时按 -1 起算（首块必须算「在涨」）', () => {
  const s = stallStep(undefined, 1_000, 0);
  assert.equal(s.stalled, 0);
  assert.equal(s.prevLen, 1_000);
});

// ------------------------------------------------- 与 composerStrategy 的一致性

test('两条策略并存：field 与 editable 都要能被分块计划覆盖', () => {
  // 真机形态：deepseek=textarea（field）、doubao/kimi=contenteditable（editable）。
  // 分块逻辑对两者都生效，但走不同写入路径——这里锁住「形态判定不因分块而改变」。
  assert.equal(composerStrategy({ tag: 'textarea', editable: false }), 'field');
  assert.equal(composerStrategy({ tag: 'div', editable: true }), 'editable');
  for (const kind of ['field', 'editable']) {
    const p = composerWritePlan({ length: 100_000, chunkChars: 20_000, kind });
    assert.equal(p.mode, 'chunked');
    assert.equal(p.kind, kind);
    assert.equal(p.chunks, 5);
  }
});

// ------------------------------------------------ composerEchoVerdict（0.19.71）
//
// 这一组钉的是 long-term-issues #48 的真根因：旧判据比**长度**，而浏览器按 HTML
// 规范把 `textarea.value` 的 `\r\n` 规范化成 `\n`，于是回读必然比原文短（短的量
// 恰好 = CRLF 个数）。真机实测 44,202 字符两次都「丢 126」——那 126 是注入的
// `AGENTS.md` 的 126 行，**正文一字未少**，纯属误报；`-8` 容差对此毫无帮助。
//
// 判据因此改成比**内容等价**。下面每一条都对应一类真实的失败/误报形态。

test('回读判据 ①：换行规范化不得算截断（126 字符误报的根因）', () => {
  const sent = 'line-a\r\nline-b\r\n'.repeat(126) + 'TAIL';
  const echoed = sent.replace(/\r\n/g, '\n');          // 浏览器 textarea 的既定行为
  const v = composerEchoVerdict(sent, echoed);
  assert.equal(v.ok, true, 'CRLF→LF 是浏览器规范行为，不是网页截断');
  assert.equal(v.reason, 'newline-normalized');
  // 差值必须恰好等于 CRLF 个数——这是「已知误报量」的可核对读数。
  assert.equal(v.sentLength - v.echoedLength, 252, '126 行 ⇒ 252 个 CRLF');
});

test('回读判据 ②：LF 输入零差（对照组）', () => {
  const sent = 'line-a\nline-b\n'.repeat(126) + 'TAIL';
  const v = composerEchoVerdict(sent, sent);
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'exact');
  assert.equal(v.sentLength, v.echoedLength);
});

test('回读判据 ③：中间丢一个字符必须失败', () => {
  const v = composerEchoVerdict('a\r\nb\r\nc', 'a\nbXc');
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'content-mismatch');
});

test('回读判据 ④：尾部截断必须失败（判据存在的理由）', () => {
  const v = composerEchoVerdict('a\r\nb\r\nc', 'a\nb');
  assert.equal(v.ok, false);
});

test('回读判据 ⑤：★ 等长内容被替换必须失败（只比长度会漏掉这一类）', () => {
  const v = composerEchoVerdict('abcdef', 'abcdeX');
  assert.equal(v.sentLength, v.echoedLength, '长度完全相同——旧判据对此完全无感');
  assert.equal(v.ok, false, '内容不同就必须失败，否则判据是空转的');
});

test('回读判据 ⑥：只允许行尾空白差异，正文中间的空白差异必须失败', () => {
  assert.equal(composerEchoVerdict('a  \nb\t\n', 'a\nb\n').ok, true, '行尾空白由编辑器吞掉');
  assert.equal(composerEchoVerdict('a b', 'a  b').ok, false,
    '中间空白是正文内容——放过它就会掩盖真正的损坏');
});

test('回读判据 ⑦：读不到回读时不断言截断（既有行为，不因本判据回归）', () => {
  const v = composerEchoVerdict('abc', null);
  assert.equal(v.ok, true);
  assert.equal(v.reason, 'echo-unavailable');
  assert.equal(v.echoedLength, -1, '读不到用 -1 表达，不伪装成 0');
});

// ------------------------------------------------- EDITOR_BLOCK_TEXT（0.19.78）
//
// 真机背景（doubao/tiptap，2026-10-14，只写不发送）：写入 17 字
// `[本地工具传输协议]\n请回复：收到`，`innerText` 回读 **18**（`\n`→`\n\n`）、
// `textContent` 回读 **16**（换行被吞）⇒ 两者都判 content-mismatch
// ⇒ **每一轮含换行的提示词都被 PROMPT_TRUNCATED 拦住**（doubao 全线不可用）。
//
// 下面用最小 DOM 桩钉住「块感知读取」的判据。桩只实现本函数真正用到的 API
// （childNodes / tagName / nodeType / nodeValue），不引 jsdom——与同目录其它测试一致。

/** 造一个元素节点。`kids` 给子节点（文本用字符串简写）。 */
function el(tag, kids = []) {
  const node = { nodeType: 1, tagName: tag, childNodes: [] };
  node.childNodes = kids.map((k) => (typeof k === 'string' ? { nodeType: 3, nodeValue: k } : k));
  return node;
}

test('块感知 ①：tiptap 每个换行一个 <p> ⇒ 必须还原成单个 \\n（真机 17 字原案）', () => {
  const dom = el('DIV', [el('P', ['[本地工具传输协议]']), el('P', ['请回复：收到'])]);
  assert.equal(EDITOR_BLOCK_TEXT(dom), '[本地工具传输协议]\n请回复：收到',
    'innerText 会给出 \\n\\n（18 字）、textContent 给出无换行（16 字），两者都不对');
});

test('块感知 ②：★ 空行 = 空 <p>（占位 <br>）⇒ 必须还原成一个空行', () => {
  // 真机 DOM：`甲\n\n乙` ⇒ <p>甲</p><p class="is-empty"><br></p><p>乙</p>
  const br = el('BR');
  const dom = el('DIV', [el('P', ['甲']), el('P', [br]), el('P', ['乙'])]);
  assert.equal(EDITOR_BLOCK_TEXT(dom), '甲\n\n乙',
    '把占位 <br> 当换行会多出一个 \\n（v3 的 5/7 就栽在这里）');
});

test('块感知 ③：行内 <br> 是用户的硬换行 ⇒ 必须保留', () => {
  const dom = el('DIV', [el('P', ['a', el('BR'), 'b'])]);
  assert.equal(EDITOR_BLOCK_TEXT(dom), 'a\nb');
});

test('块感知 ④：无块级子节点时按行内读（普通 contenteditable 不回归）', () => {
  const dom = el('DIV', ['纯文本', el('SPAN', ['拼接'])]);
  assert.equal(EDITOR_BLOCK_TEXT(dom), '纯文本拼接');
});

test('块感知 ⑤：首尾空段必须去掉、中间空段必须保留（编辑器边界空 <p>）', () => {
  const dom = el('DIV', [el('P', []), el('P', ['正文']), el('P', [])]);
  assert.equal(EDITOR_BLOCK_TEXT(dom), '正文');
  const mid = el('DIV', [el('P', ['上']), el('P', []), el('P', ['下'])]);
  assert.equal(EDITOR_BLOCK_TEXT(mid), '上\n\n下', '中间空段是用户真写的空行');
});

test('块感知 ⑥：与写入文本比对时**逐字相等** ⇒ 判据才能通过（端到端意义）', () => {
  const sent = '第一行\n\n第四行';
  const dom = el('DIV', [el('P', ['第一行']), el('P', [el('BR')]), el('P', ['第四行'])]);
  const echoed = EDITOR_BLOCK_TEXT(dom);
  assert.equal(echoed, sent);
  assert.equal(composerEchoVerdict(sent, echoed).ok, true, '块感知读取 + 既有白名单 = 通过');
  // 反向：真截断在块感知读取下**依然**被拦住（判据没被放宽）
  const truncated = EDITOR_BLOCK_TEXT(el('DIV', [el('P', ['第一行'])]));
  assert.equal(composerEchoVerdict(sent, truncated).ok, false, '真截断必须失败');
});
