// attach-evidence-scope.test.mjs — 附件证据必须限定在 composer 作用域内（0.19.5）。
//
// ## 为什么需要这个文件
//
// 真机取证（2026-09-24，DeepSeek 网页）：`POST /__webcode/attach-probe` 报
// `ok:true, evidence:'text:webcode-probe.md'`，而同一份返回里 10 条类名候选
// **全部 count:0、visible:0**，命中的是一个**无 class 的 `<code>`**——页面会话正文
// 里的同名文本。旧 `filenameEvidence` 扫 `document.querySelectorAll('body *')`，
// 只按「文本长度 ≤ 文件名+80」与「取最深命中」过滤，挡不住「同名文本出现在正文里」。
//
// 后果是最坏的一种：文件真没上去，桥报成功，正文被替换成一句「请先读取该附件全文」
// ——上下文一个字都没进网页。
//
// ## 本文件的第一版是**装饰品**，这是它被重写成行为判据的原因
//
// 第一版护栏查的是「源码里有没有 `inTranscript` / `scope.contains(el)` 这些字符串」。
// 反向验证（把 `if (inTranscript(el)) return false;` 改成恒不成立、把作用域那条短路掉）
// **两条都仍然全绿**——字符串还在，行为已经没了。本仓库把这种形态记作「护栏逃逸」。
// 因此现在判定主体被抽成 `lib/attach-scope.js` 的 `pickAttachEvidence`（纯函数），
// 下面的用例用一个小 DOM 适配器**直接驱动它**：真附件 chip 必须通过、正文里的同名文本
// 必须被拒。变异掉任何一条过滤都会当场变红（见文件末的变异说明）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickAttachEvidence, ATTACH_PICK_SRC } from '../lib/attach-scope.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkg = path.dirname(here);
const DRIVER = fs.readFileSync(path.join(pkg, 'lib', 'browser-driver.js'), 'utf8');

// ── 极小 DOM 适配器：只实现 pickAttachEvidence 用到的那几个接口 ────────────────

/** 构造一个元素。`sel` 是用于「选择器命中」的标签集合。 */
function el(tag, { cls = '', text = '', children = [] } = {}) {
  const node = {
    tagName: tag.toUpperCase(),
    _cls: cls,
    _text: text,
    _children: children,
    parentElement: null,
    id: '',
    offsetWidth: 10,
    offsetHeight: 10,
    getAttribute: (k) => (k === 'class' ? cls : null),
    get outerHTML() {
      const inner = node._children.map((c) => c.outerHTML).join('');
      return '<' + tag + (cls ? ' class="' + cls + '"' : '') + '>' + text + inner + '</' + tag + '>';
    },
    get textContent() {
      return text + node._children.map((c) => c.textContent).join('');
    },
    contains(other) {
      for (let n = other; n; n = n.parentElement) if (n === node) return true;
      return false;
    },
    // closest 只需支持正文选择器这一类：这里按「本节点或祖先带 transcript 类」判。
    closest(sel) {
      if (!sel.includes('ds-markdown')) return null;
      for (let n = node; n; n = n.parentElement) if (/ds-markdown/.test(n._cls)) return n;
      return null;
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (n) => {
        for (const c of n._children) {
          if (matchAny(c, sel)) out.push(c);
          walk(c);
        }
      };
      walk(node);
      return out;
    },
  };
  for (const c of children) c.parentElement = node;
  return node;
}

/**
 * 选择器匹配：本文件只需覆盖三条真实用到的形态——标签名、`.class`、`[class*="x"]`，
 * 以及**逗号分隔的选择器组**（正文选择器就是一个组）。
 *
 * 这里曾经漏掉 `.class` 与逗号组，后果是 `hasTranscript` 恒为 false ⇒ 作用域被算成
 * 根节点 ⇒ 正文里的诱饵被算进候选命中。**那一版测试反而「通过」了假阳性**——
 * 适配器不完整会把判据测成装饰品，所以下面每条断言都要求适配器真的能区分。
 */
function matchAny(node, sel) {
  return String(sel).split(',').some((one) => matchOne(node, one.trim()));
}

function matchOne(node, sel) {
  if (!sel) return false;
  // `body *` = 任意后代（真机里判定的入口就是它）。适配器的 querySelectorAll 本来就只
  // 遍历后代，所以它对任何元素都成立。**漏掉这一条会让 hits 恒为空**——那一版测试会
  // 把「真 chip 必须被接受」测成失败，而不是把假阳性测成失败。
  if (sel === 'body *' || sel === '*') return true;
  if (/^[a-z]+$/.test(sel)) return node.tagName.toLowerCase() === sel;
  const cls = /^\.([A-Za-z0-9_-]+)$/.exec(sel);
  if (cls) return node._cls.split(/\s+/).includes(cls[1]);
  const m = /^\[class\*=['"]([^'"]+)['"]\]$/.exec(sel);
  if (m) return node._cls.includes(m[1]);
  if (/^input\[type='file'\]$/.test(sel)) return node.tagName === 'INPUT';
  return false;
}

/**
 * 组装一份与真机同构的最小页面：
 *
 *   root
 *    ├── transcript 区（正文，含同名 <code>）        ← 假阳性来源
 *    ├── composer 容器（含真附件 chip）               ← 合法证据
 *    │     └── inputRow → textarea + file input + chip
 *    └── 深层包装（模拟真机第 6 层：正文与 composer 的共同祖先）
 */
function buildPage({ chipText = 'webcode-context.md', transcriptText = "evidence='text:webcode-context.md'" } = {}) {
  const fileInput = el('input');
  const ta = el('textarea');
  const chipInner = el('div', { cls: 'e70accd6', text: chipText });
  const chip = el('div', { cls: '_967f3f9', children: [chipInner] });
  const inputRow = el('div', { children: [ta, fileInput, chip] });
  const composer = el('div', { cls: '_871cbca', children: [inputRow] });
  const code = el('code', { text: transcriptText });
  const transcript = el('div', { cls: 'ds-markdown', children: [code] });
  const root = el('div', { children: [transcript, composer] });
  return { root, ta, fileInput, chip, composer, transcript, code };
}

function pick(page, name, sels = []) {
  return pickAttachEvidence({
    doc: page.root,
    input: page.fileInput,
    ta: page.ta,
    name,
    max: String(name).length + 80,
    transcriptSel: '.ds-markdown',
    sels,
  });
}

// ── ① 行为判据：真 chip 通过，正文同名文本被拒 ──────────────────────────────

test('① 真附件 chip 必须被接受（且指向 chip 节点本身）', () => {
  const page = buildPage();
  const r = pick(page, 'webcode-context.md');
  assert.ok(r.nameHit, 'composer 里的真 chip 没被认出来——真附件将永远确认不了');
  assert.equal(r.nameHit.cls, 'e70accd6', '应当取最深命中（chip 的文本节点）');
  assert.equal(r.scoped, true, '这份页面上 composer 作用域必须认得出来');
});

test('② 正文里的同名文本必须被拒（这是本轮修的真假阳性）', () => {
  const page = buildPage();
  // 抽掉真 chip，只留正文里的同名 <code>——这正是真机 attach-probe 的现场。
  const noChip = { ...page, root: page.root };
  page.composer._children[0]._children = [page.ta, page.fileInput];
  const r = pick(noChip, 'webcode-context.md');
  assert.equal(r.nameHit, null,
    '正文里的同名 <code> 又被当成附件证据了——文件真没上去却会报成功，'
    + '正文被替换成「请先读取该附件全文」，上下文一个字都没进网页');
});

// 下面两条是**唯一防线**用例，它们的形状是刻意设计的：
//
// 只写「真 chip 通过 + 正文同名被拒」时，两条过滤**互相冗余**——把其中任一条短路掉，
// 另一条仍然拦得住，于是变异测试全绿、判据是装饰品（本文件第一版就是这样翻车的：
// 变异 A/B 两条都不变红）。因此必须各造一个「只有这一条能拦」的现场。

test('③ 作用域是唯一防线：composer 之外、正文之外的同名节点必须被拒', () => {
  const page = buildPage();
  // 把真 chip 拿掉，改在 composer 之外、且**不在 transcript 里**放一个同名节点
  // （真机上对应侧栏历史标题、别的会话里的同名文本）。
  page.composer._children[0]._children = [page.ta, page.fileInput];
  const outside = el('div', { cls: 'e70accd6', text: 'webcode-context.md' });
  outside.parentElement = page.root;
  page.root._children.push(outside);
  const r = pick(page, 'webcode-context.md');
  assert.equal(r.nameHit, null,
    'composer 之外的同名节点被当成了附件证据——这一条只有 composer 作用域拦得住，'
    + '作用域一旦失效（短路掉 scope.contains）它就会漏过去');
});

test('③b 正文排除是唯一防线：认不出作用域时正文里的同名文本仍必须被拒', () => {
  const page = buildPage();
  // 先抽掉真 chip：否则命中的是那个**合法**的 composer chip，本用例就测不到正文排除。
  page.composer._children[0]._children = [page.ta, page.fileInput];
  // 再让作用域认不出来：传入的输入框/文件入口为 null（真机上对应页面结构改版）。
  // 此时只有「排除正文」这一条还在拦——它必须自己站得住。
  const r = pickAttachEvidence({
    doc: page.root, input: null, ta: null,
    name: 'webcode-context.md', max: 'webcode-context.md'.length + 80,
    transcriptSel: '.ds-markdown', sels: [],
  });
  assert.equal(r.scoped, false, '前提：这份现场必须认不出作用域（否则本用例测的不是它）');
  assert.equal(r.nameHit, null,
    '认不出作用域时，正文里的同名文本被当成了附件证据——'
    + '这一条只有正文排除拦得住，它一旦失效就是真机那个「报成功、其实没传上去」');
});

test('④ 类名候选只在 composer 作用域内计数（全页计数会造假阳性）', () => {
  const page = buildPage();
  // 正文里挂一个「看起来像附件」的节点（带 attachment 类）。
  const decoy = el('div', { cls: 'fake-attachment-card', text: 'history.md' });
  decoy.parentElement = page.transcript;
  page.transcript._children.push(decoy);
  const r = pick(page, 'no-such-name.md', ['[class*="attachment"]']);
  const cand = r.candidates[0];
  assert.equal(cand.count, 0,
    '正文里的 attachment 节点被算进了候选命中：这一列会变成假阳性，'
    + '真机上表现为「类名命中了，其实是历史附件卡」');
});

// ── ② 接线判据：驱动侧必须真的用这份唯一实现 ────────────────────────────────

test('⑤ 驱动侧必须注入同一份判定源码（不得内联再写一份）', () => {
  assert.ok(/ATTACH_PICK_SRC/.test(DRIVER),
    'browser-driver 没有使用 ATTACH_PICK_SRC：判定实现会被复制成两份');
  assert.ok(/new Function\('return \(' \+ PICK_SRC/.test(DRIVER),
    '驱动侧必须把 ATTACH_PICK_SRC 求值成函数后再调用');
  assert.ok(/function pickAttachEvidence\(o\)/.test(ATTACH_PICK_SRC),
    'ATTACH_PICK_SRC 必须是 pickAttachEvidence 的源码（注入后才能在页面里跑同一份）');
  // 反向安全线：驱动里剩下的每一处全页扫描都必须带正文排除。
  //
  // 为什么不是「一律不许扫 body」：`cleanupAttachment` 要找的是**删除控件**，
  // 控件本身不带文件名，只能从文件名节点出发找容器，因此那一处必须自己扫。
  // 但它**必须**排除正文——否则「正文里写着这个文件名」时它会去点正文节点旁边的
  // 控件（可能是复制/引用按钮）。判据因此写成「扫可以，排除正文必须有」。
  const scans = DRIVER.split(/\r?\n/).filter((l) => /querySelectorAll\('body \*'\)/.test(l));
  assert.ok(scans.length > 0, '找不到任何全页扫描：判据本身失去了作用对象，必须复核');
  const cleanupAt = DRIVER.indexOf('async function cleanupAttachment');
  const cleanupSeg = DRIVER.slice(cleanupAt, cleanupAt + 2000);
  assert.ok(/closest\(T_SEL\)/.test(cleanupSeg),
    'cleanupAttachment 的全页扫描没有排除正文节点：它会去点正文里同名文本旁边的控件');
  // 正文排除必须真的生效——把 closest 那行短路掉就必须变红（见文件末变异说明）。
  assert.ok(/if \(el\.closest\(T_SEL\) !== null\) return false;/.test(cleanupSeg),
    'cleanupAttachment 的正文排除被写成恒不成立（例如加了 false && 前缀）');
});

test('⑥ 三个消费点必须共用同一个取样函数', () => {
  for (const fn of ['filenameEvidence', 'attachEvidenceDiag']) {
    const at = DRIVER.indexOf('function ' + fn);
    assert.ok(at > 0, '找不到 ' + fn);
    const seg = DRIVER.slice(at, at + 600);
    assert.ok(/pageAttachEvidence\(/.test(seg),
      fn + ' 没有走 pageAttachEvidence——同一个判断写两份，'
      + '会出现「探针说有附件、投递说没有」');
  }
});

// ── ③ 图片轮：名字证据 + 失败可回落 ────────────────────────────────────────

test('⑦ 图片上传必须带名字证据（类名清单在 DeepSeek 上真机零命中）', () => {
  const at = DRIVER.indexOf('async function uploadImages');
  assert.ok(at > 0);
  const seg = DRIVER.slice(at, at + 2600);
  assert.ok(/pageAttachEvidence\(p\.name\)/.test(seg),
    'uploadImages 没有给名字证据：DeepSeek 用构建期哈希类名，类名清单真机零命中，'
    + '等于图片在 DeepSeek 上永远确认不了');
});

test('⑧ 图片上传失败不得终止整轮（必须回落纯文本并落读数）', () => {
  const at = DRIVER.indexOf('attachEvidence = await uploadImages(images);');
  assert.ok(at > 0, '找不到 uploadImages 的调用点');
  const before = DRIVER.slice(Math.max(0, at - 400), at);
  assert.ok(/try\s*\{/.test(before),
    'uploadImages 的调用点没有包在 try 里：确认失败会把整轮判死');
  const after = DRIVER.slice(at, at + 800);
  assert.ok(/catch\s*\(\s*err\s*\)/.test(after), '调用点后面没有 catch');
  assert.ok(/fallback:\s*true/.test(after), '图片失败读数必须显式标 fallback:true');
  assert.ok(/imageTransport/.test(DRIVER), '找不到 imageTransport 读数');
});

// ── ④ 长文本：写入必须优先走原生 setter ────────────────────────────────────

test('⑨ composer 写入必须优先走原生 setter（逐块 insertText 是 O(n²)）', () => {
  const at = DRIVER.indexOf('async function fillComposer');
  assert.ok(at > 0);
  const seg = DRIVER.slice(at, at + 3000);
  assert.ok(/writeFieldNative\(/.test(seg),
    'fillComposer 没有调用 writeFieldNative：长文本又回到逐块 insertText，'
    + '真机实测 400k 需 72 秒（原生 setter 28 毫秒）');
  assert.ok(/writeFieldChunked\(/.test(seg), '原生路径失败必须回落分块路径');
  const nat = DRIVER.indexOf('async function writeFieldNative');
  assert.ok(nat > 0, '找不到 writeFieldNative');
  const natSeg = DRIVER.slice(nat, nat + 1200);
  assert.ok(/getOwnPropertyDescriptor/.test(natSeg),
    '必须用原型上的原生 value setter（直接 el.value= 不触发 React onChange）');
  assert.ok(/dispatchEvent\(new Event\('input'/.test(natSeg),
    '原生 setter 之后必须补一个冒泡的 input 事件');
});
