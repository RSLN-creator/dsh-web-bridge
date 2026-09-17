// upload-attachment-structure.test.mjs — 源码**结构**护栏：uploadTextAttachment 不得被塞回 uploadImages 里（0.16.3）。
//
// ## 这个文件防的是哪一次真缺陷（不是洁癖）
//
// 0.16.2 里 `lib/browser-driver.js` 的 `uploadTextAttachment` 定义被插在 `uploadImages` 的
// `if (!hit) { … throw err;` **之后、闭括号之前**——于是 `uploadImages` 的 if 块被提前关掉，
// 文件里多出两个孤立闭括号。因为函数声明提升，它当时**侥幸能跑**，所以没有任何测试变红。
//
// 后果链（为什么必须有一条护栏）：下一次相邻重构（缩进整理、加一个 else、格式化）就可能让它
// 真的变成「只在 catch 的块级作用域里」→ 调用点 `ReferenceError` → 被外层 `catch` 吞掉 →
// **静默回落 inline**。这正是用户抱怨过好几次的那类「说做了、其实没做」：界面上一切正常，
// 长文本仍然走 inline，没人知道附件投递从来没生效。
//
// ## 判据（对**源码文本**断言，因为语义在这里是对的、形状是错的）
//
//   ① `uploadImages` 的函数体里不得出现另一个 `async function` 定义；
//   ② `uploadTextAttachment` 的声明位置必须在 `uploadImages` 的函数体**结束之后**；
//   ③ `uploadTextAttachment` 的函数体必须含 `ATTACH_NOT_CONFIRMED`（「拿不到可见附件证据就报错」
//      这条纪律是它存在的全部意义，被删掉就等于静默发送一条没有附件的消息）。
//
// ## 为什么不用正则数花括号（以及为什么必须有扫描器自检）
//
// 「这段代码在谁的身体里」只能靠配平花括号判断，而花括号会出现在字符串、模板、行/块注释与
// 正则字面量里——`uploadImages` 身体里就有一个 `/[\\/:*?"<>|]/g`（自带 `"` 与 `[`）。用正则
// 数必然数错，数错的方向有两种：把 body 判空（**假绿**）或把别人的花括号算进来（假红）。
// 因此本文件自带一个小扫描器，并且另有一条**自检**用例：对合成的嵌套源码断言它确实看得见
// 嵌套、对合成字符串/注释断言配平不被带偏。没有自检的话，扫描器一旦返回空串，①就变成
// 永远的绿——那比没有护栏更糟。
//
// ## 边界（刻意不做的事）
//
// 不引 parser（acorn/espree 都不引，与 scripts/lint-comments.mjs 同一传统：本仓库的检查工具
// 都是可直接 `node` 跑的独立文件）。代价是模板字面量里的 `${…}` 不递归解析——本文件只需要
// 知道「花括号在哪一层」，而 `${}` 内出现花括号的写法在 browser-driver.js 里不存在。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const DRIVER = path.join(import.meta.dirname, '..', 'lib', 'browser-driver.js');
const SRC = fs.readFileSync(DRIVER, 'utf8');

/** 斜杠处在「表达式起始位置」时它是正则字面量，不是除号（与 scripts/lint-comments.mjs 同源）。 */
const REGEX_START_AFTER = new Set(['', '=', '(', ',', ':', '[', '!', '&', '|', '?', '{', '}', ';', 'return']);

/** 跳过一段引号字面量（'…'、"…"、`…`），返回其结束后的下标；转义连同下一字符一起吞掉。 */
function skipQuoted(src, i) {
  const quote = src[i];
  i += 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === quote) return i + 1;
    i += 1;
  }
  return i;
}

/** 跳过一段正则字面量，返回其结束后的下标；字符类 `[…]` 内的 `/` 不结束正则。 */
function skipRegex(src, i) {
  i += 1;
  let inClass = false;
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (inClass) { if (c === ']') inClass = false; }
    else if (c === '[') inClass = true;
    else if (c === '/') return i + 1;
    i += 1;
  }
  return i;
}

/**
 * 框出 `function <name>(…)` 的**函数体**（含两侧花括号），扫过字符串/注释/正则不计配平。
 *
 * 返回 null 表示源码里没有这个名字的函数声明，或花括号没配平（源码被写坏了）。
 * 先把参数表走完（`paren > 0` 期间的花括号属于解构参数，不算函数体），再对第一层 `{` 起算深度。
 *
 * @param {string} src 源码全文
 * @param {string} name 函数名
 * @returns {{bodyStart: number, bodyEnd: number, body: string}|null}
 */
function functionBodyOf(src, name) {
  const declRe = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const m = declRe.exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  let paren = 1;          // 声明的 `(` 已经被吃掉了
  let start = -1;
  let depth = 0;
  let prev = '';
  while (i < src.length) {
    const c = src[i];
    const n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); i = e === -1 ? src.length : e + 1; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e === -1 ? src.length : e + 2; continue; }
    if (c === "'" || c === '"' || c === '`') { i = skipQuoted(src, i); prev = c; continue; }
    if (c === '/' && REGEX_START_AFTER.has(prev)) { i = skipRegex(src, i); prev = '/'; continue; }
    if (c === '(') paren += 1;
    else if (c === ')') paren -= 1;
    // 花括号只在**括号之外**才参与配平：`foo({ a: 1 })`、`(f) => ({ … })` 里的花括号属于参数/
    // 实参，算进来会让函数体被提前判完——2026-09-17 实测：`uploadImages` 的 body 在
    // `.map((f) => ({ … }))` 那一行就断了，于是 ① 在**结构已经坏掉**的源码上仍然通过（假绿）。
    else if (c === '{' && paren === 0) {
      if (start === -1) { start = i; depth = 1; prev = c; i += 1; continue; }
      depth += 1;
    } else if (c === '}' && paren === 0 && start !== -1) {
      depth -= 1;
      if (depth === 0) return { bodyStart: start, bodyEnd: i, body: src.slice(start, i + 1) };
    }
    if (c.trim() !== '') prev = c;
    i += 1;
  }
  return null;
}

/** 一句人人看得懂的话：任何「结构被破坏」都应带出它，方便下一个人一眼定位。 */
const BROKEN = '结构被破坏';

const IMAGES = functionBodyOf(SRC, 'uploadImages');
const TEXT_ATTACH = functionBodyOf(SRC, 'uploadTextAttachment');

// ── 自检：扫描器必须真的看得见嵌套、且不被字符串/注释里的花括号带偏 ──────────────

test('⓪ 扫描器自检：嵌套看得见、字符串/正则/注释里的花括号不参与配平', () => {
  const nested = [
    'async function outer(arg, { opt = 1 } = {}) {',
    '  const re = /[{}]/g;',
    "  const s = '}';",
    '  /* } */',
    '  async function inner() { return 1; }',
    '  return inner;',
    '}',
    'async function inner() { return 2; }',
  ].join('\n');
  const outer = functionBodyOf(nested, 'outer');
  assert.ok(outer, '扫描器自检失败：连合成的 outer 都框不出来（那 ① 就是永远假绿）');
  assert.equal(nested[outer.bodyStart], '{', '扫描器自检失败：函数体起点不是 `{`');
  assert.equal(nested[outer.bodyEnd], '}', '扫描器自检失败：函数体终点不是 `}`');
  assert.match(outer.body, /async function inner\(\) \{ return 1; \}/,
    '扫描器自检失败：outer 体内的 inner 没被看成「体内的另一个 async function」——①失去了判据');
  assert.ok(!outer.body.includes('return 2'), '扫描器自检失败：把 outer 之后的同名函数算了进来');
  const inner = functionBodyOf(nested, 'inner');
  assert.ok(inner && inner.body.includes('return 1'),
    '扫描器自检失败：嵌套在最前面的 inner 应被框到（声明查找取第一个匹配）');

  // 第二条自检：实参里的对象字面量不得被算进配平（这一条是实测出来的——见 functionBodyOf
  // 里 `paren === 0` 那段注释：少了它，uploadImages 的 body 会在 `.map((f) => ({ … }))` 处断掉，
  // 于是「结构已经坏掉」的源码也能通过 ①）。
  const callObj = [
    'async function withCall(files) {',
    '  const payloads = files.map((f) => ({',
    '    name: String(f.name).trim(),',
    '  }));',
    '  await upload(payloads);',
    '  return payloads;',
    '}',
  ].join('\n');
  const withCall = functionBodyOf(callObj, 'withCall');
  assert.ok(withCall && /return payloads;/.test(withCall.body),
    '扫描器自检失败：函数体在实参对象字面量的 `}` 处就断了（把括号里的花括号算了进来）');
});

// ── ① 反向安全线：uploadImages 体内不得再有第二个函数定义 ─────────────────────

test('① uploadImages 的函数体里不得出现另一个 async function（'+BROKEN+'就指这一条）', () => {
  assert.ok(IMAGES, '结构被破坏：从 lib/browser-driver.js 里框不出 uploadImages 的函数体'
    + '（声明被删了，或花括号没配平）');
  assert.ok(IMAGES.body.length > 200,
    '结构被破坏：uploadImages 的「函数体」只框到 ' + IMAGES.body.length
    + ' 个字符，明显不是真身体——扫描器或源码结构出问题了');
  assert.match(IMAGES.body, /setInputFiles\(payloads\)/,
    '结构被破坏：uploadImages 的体内找不到 setInputFiles(payloads)，框出来的不是它真正的函数体');
  assert.ok(!/async\s+function/.test(IMAGES.body),
    BROKEN + '：uploadImages 的函数体里出现了另一个 async function 定义'
    + '——uploadTextAttachment 又被插回 uploadImages 内部了。'
    + '旧形状（0.16.2）会让 uploadImages 的 if 块被提前关掉、只剩两个孤立闭括号，'
    + '函数声明提升让它侥幸能跑；下一次相邻重构就可能让它只在 catch 作用域里 →'
    + '调用点 ReferenceError → 被 catch 吞掉 → 静默回落 inline。'
    + '修法：把 uploadTextAttachment 整体移到 uploadImages **完整结束之后**。');
  assert.ok(!IMAGES.body.includes('uploadTextAttachment'),
    BROKEN + '：uploadImages 的函数体里出现了 uploadTextAttachment 的名字'
    + '（嵌套定义或嵌套注释都算）：它必须与 uploadImages 平级。');
});

// ── ② 结构：两个函数必须平级，且 text 版在 images 之后 ────────────────────────

test('② uploadTextAttachment 必须是平级声明，且位置在 uploadImages 函数体结束之后', () => {
  assert.ok(TEXT_ATTACH, BROKEN + '：源码里找不到 uploadTextAttachment 的函数声明（被删或被嵌进去了）');
  const declAt = SRC.search(/async\s+function\s+uploadTextAttachment\s*\(/);
  assert.ok(declAt > IMAGES.bodyEnd,
    BROKEN + '：uploadTextAttachment 的声明（下标 ' + declAt + '）不在 uploadImages 的函数体之后'
    + '（函数体结束于 ' + IMAGES.bodyEnd + '）——它又被嵌进 uploadImages 里了');
  const between = SRC.slice(IMAGES.bodyEnd + 1, declAt);
  assert.ok(between.trim().startsWith('/**'),
    BROKEN + '：uploadImages 结束与 uploadTextAttachment 声明之间不是一段 JSDoc，'
    + '而是 ' + JSON.stringify(between.trim().slice(0, 60)) + '——中间残留了代码残片或孤立闭括号');
});

// ── ③ 语义纪律：text 版必须保留「拿不到可见证据就报错」──────────────────────────

test('③ uploadTextAttachment 的函数体必须含 ATTACH_NOT_CONFIRMED（绝不静默发一条没附件的消息）', () => {
  assert.ok(TEXT_ATTACH, BROKEN + '：框不出 uploadTextAttachment 的函数体，③无法判定');
  assert.match(TEXT_ATTACH.body, /ATTACH_NOT_CONFIRMED/,
    BROKEN + '：uploadTextAttachment 的体内没有 ATTACH_NOT_CONFIRMED——'
    + '「看不到可见附件证据就报错、由调用方回落 inline」是它存在的全部意义，'
    + '删掉它就等于静默发送一条没有附件的消息（模型会说「我没看到附件」）。');
  assert.match(TEXT_ATTACH.body, /waitForAttachment\(/,
    BROKEN + '：uploadTextAttachment 的体内没有等可见附件证据（waitForAttachment），'
    + 'setInputFiles 之后就直接返回了——上传是异步的，旧写法（固定等 500ms）就是这样漏的。');
});
