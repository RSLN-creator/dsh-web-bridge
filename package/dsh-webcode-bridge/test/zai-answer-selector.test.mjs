// zai-answer-selector.test.mjs — z.ai 助手节点选择器的**真机夹具护栏**（0.19.x，2026-09-27）。
//
// ## 这条护栏守的是什么
//
// 事故轮次 session-83448c80（zai:glm-5.3，turn1 step1）240s 超时，报错里带着一句
// 「**页面已有 7 字回复未回传**」。真机取证（`.tmp-probe/zai/RESULT.md`）证明：
// 那 7 个字**不是回复**，是 providers.js 里 zai 的 `answerSelector` 旧值尾部那个宽特征
// `[class*="message"]` 命中了**输入框容器** `div.messageInputContainer`，而它的
// innerText 恰好是「深度思考\n最高」（4+1+2 = 7 字）。驱动的读取语义是
// `[...querySelectorAll(sel)].pop()`（文档序最后一个），输入框容器排在助手轮之后，
// 于是它**恒赢**。
//
// 这条假读数的代价不是难听，而是**指错方向**（把排查引向「解码器对不上」）并且**有行为后果**：
//   · `domFound` 恒真、`lastDomGrowthAt` 永不刷新 ⇒ 对 zai 而言「页面还在长就别收束」
//     这道保护是死的；
//   · 捕获停摆兜底（captureStallRescueMs）读到的「页面正文」就是输入框容器文本 ⇒
//     一旦 `domTextChanged` 成立，桥会把「深度思考\n最高」当成本轮回答交给上层。
//
// ## 为什么用夹具而不是字符串断言
//
// 「选择器命中哪个节点」是 DOM 问题，`assert(sel.includes('chat-assistant'))` 证明不了任何东西。
// 夹具 `test/fixtures/zai-real-dom/zai-chat-dom-inventory.json` 是**真机会话页面的完整元素清单**
// （293 个元素的 tag/class/id/父索引/innerText 长度，消息 uuid 已脱敏；页面正是事故会话留下的那一页：
// 用户消息 53,509 字已渲染、助手轮 0 字、阿里云滑块风控弹窗在页）。本文件在它上面**复算**
// `querySelectorAll` 的命中集合，于是「旧值读到 7 字」与「新值读到助手容器」两件事都能离线钉死。
//
// ## 夹具必须保持真实
//
// 它只能由 `.tmp-probe/zai/dump-zai-dom-inventory.mjs`（只读 CDP）重新导出，**不许手改**。
// 本文件会先校验 provenance 与元素总数，改坏了当场红。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import '../lib/decoder.js';
import { SITES, resolveWebModel } from '../lib/providers.js';

const FIXTURE = new URL('./fixtures/zai-real-dom/zai-chat-dom-inventory.json', import.meta.url);
const fx = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
const els = fx.els;

// ---------------------------------------------------------------------------
// 迷你选择器引擎：只实现 z.ai 的 answerSelector 用到的那几种形态
// （tag / .class / #id / [class*="x"] / 后代组合子 / 逗号分组）。
//
// ⚠ 不要用「正则交替」写这个解析器：`/^([a-z0-9]*)|(\.[^.#\[]+)|…/g` 里那个 `^` 锚
// 会让 `.markdown-body` 解析出**空 token**，于是 matchesSimple 恒真、293 个元素全命中，
// 而测试照样「通过」。第一版就是这么写的，被夹具复算当场抓住（.markdown-body 报 293）。
// ---------------------------------------------------------------------------
function parseSimple(sel) {
  const tokens = []; let i = 0;
  while (i < sel.length) {
    const c = sel[i];
    if (c === '.') { let j = i + 1; while (j < sel.length && !'.#['.includes(sel[j])) j++; tokens.push(['cls', sel.slice(i + 1, j)]); i = j; }
    else if (c === '#') { let j = i + 1; while (j < sel.length && !'.#['.includes(sel[j])) j++; tokens.push(['id', sel.slice(i + 1, j)]); i = j; }
    else if (c === '[') { const j = sel.indexOf(']', i); tokens.push(['attr', sel.slice(i, j + 1)]); i = j + 1; }
    else { let j = i; while (j < sel.length && !'.#['.includes(sel[j])) j++; tokens.push(['tag', sel.slice(i, j).toLowerCase()]); i = j; }
  }
  return tokens;
}
function matchesSimple(el, sel) {
  for (const [kind, val] of parseSimple(sel)) {
    if (kind === 'cls') { if (!String(el.cls || '').split(/\s+/).includes(val)) return false; }
    else if (kind === 'id') { if (String(el.id || '') !== val) return false; }
    else if (kind === 'tag') { if (el.tag !== val) return false; }
    else {
      const m = val.match(/^\[class\*=["']?(.+?)["']?\]$/i);
      if (!m) return false;
      if (!String(el.cls || '').includes(m[1])) return false;
    }
  }
  return true;
}
/** 与 `[...document.querySelectorAll(sel)]` 同序（夹具按文档序编号），再模拟驱动取的 `.pop()`。 */
function queryAll(sel) {
  const hit = (el) => String(sel).split(',').map((s) => s.trim()).filter(Boolean).some((alt) => {
    const chain = alt.split(/\s+/).filter(Boolean);
    if (!matchesSimple(el, chain[chain.length - 1])) return false;
    let cur = el;
    for (let k = chain.length - 2; k >= 0; k--) {
      let anc = cur.p == null ? null : els[cur.p];
      while (anc && !matchesSimple(anc, chain[k])) anc = anc.p == null ? null : els[anc.p];
      if (!anc) return false;
      cur = anc;
    }
    return true;
  });
  return els.filter(hit);
}
const lastOf = (sel) => { const a = queryAll(sel); return a.length ? a[a.length - 1] : null; };
const brief = (e) => e ? `#${e.i} <${e.tag}> class="${e.cls}" id="${e.id}" innerText=${e.chars} 字` : '(无命中)';
const hasClass = (e, c) => String(e?.cls || '').split(/\s+/).includes(c);

test('夹具 provenance 与规模：必须是真机导出的完整元素清单，不许手改', () => {
  assert.ok(fx._provenance, '夹具必须带 provenance（来源/方法/时间/探针路径）');
  assert.equal(fx._provenance.probe, '.tmp-probe/zai/dump-zai-dom-inventory.mjs');
  assert.match(fx.url, /^https:\/\/chat\.z\.ai\/c\/<uuid>$/, '会话地址已脱敏为 <uuid>');
  assert.equal(fx.total, els.length, 'total 必须与 els 长度一致');
  assert.equal(els.length, 293, '真机页面元素数为 293；变了就说明夹具被改过或站点改版，需重新导出');
  assert.deepEqual(els.map((e, k) => e.i).filter((i) => i !== undefined).slice(0, 3), [0, 1, 2]);
  assert.equal(els[0].tag, 'html');
  assert.equal(els[0].p, null, '文档序第一条必须是根，且无父');
});

test('夹具记录的现场：用户消息已渲染、助手轮为空、风控弹窗在页', () => {
  const user = els.find((e) => hasClass(e, 'chat-user'));
  const assistant = els.find((e) => hasClass(e, 'chat-assistant'));
  const composer = els.find((e) => String(e.cls).includes('messageInputContainer'));
  const popup = els.find((e) => e.id === 'aliyunCaptcha-window-popup');
  assert.ok(user && assistant && composer && popup, '四类节点都必须在这份真机清单里');
  assert.equal(user.chars, 53509, '用户消息 innerText 长度');
  assert.equal(assistant.chars, 0, '助手轮容器为空 —— 网页一个字都没说');
  assert.equal(composer.chars, 7, '输入框容器 innerText 恰好 7 字（「深度思考\\n最高」）');
  assert.ok(hasClass(popup, 'window-show'), '阿里云滑块弹窗处于显示态');
});

test('★ 旧值复现事故读数：`.pop()` 命中的是输入框容器，7 字 —— 那不是回复', () => {
  const OLD = 'div.markdown-body, .markdown-body, [class*="prose"], [class*="message"], main';
  const hits = queryAll(OLD);
  const last = hits[hits.length - 1];
  assert.equal(hits.length, 6, '旧值在真机会话页上命中 6 个节点');
  assert.ok(last, '旧值必须命中（否则本护栏就没有复现出事故形态）');
  assert.ok(hasClass(last, 'messageInputContainer'),
    '旧值的最后一次命中必须是输入框容器，实际 ' + brief(last));
  assert.equal(last.chars, 7, '它的 innerText 渲染长度必须是 7 —— 事故报错里的「7 字回复」就是它');
  // 反证：真正承载助手正文的节点一个都不在 `.pop()` 的位置上
  const assistant = els.find((e) => hasClass(e, 'chat-assistant'));
  assert.notEqual(last.i, assistant.i);
  // 旧值的三个分支在 z.ai 上是死的（这也是它们被删掉的理由）
  assert.equal(queryAll('div.markdown-body').length, 0, 'z.ai 没有 div.markdown-body');
  assert.equal(queryAll('.markdown-body').length, 0, 'z.ai 没有 .markdown-body');
  assert.equal(queryAll('main').length, 0, 'z.ai 页面上没有 <main>');
});

test('★ zai 声明的 answerSelector 必须落在助手节点上，且永远不碰输入框容器', () => {
  const declared = SITES.find((s) => s.id === 'zai')?.answerSelector;
  assert.ok(declared, 'zai 必须声明 answerSelector');
  const hits = queryAll(declared);
  const last = hits[hits.length - 1];
  assert.ok(last, '新值必须命中（命中 0 个 = 驱动退回「选择器对本站点是瞎的」宽窗，等于放弃读数）: ' + declared);
  assert.ok(hasClass(last, 'chat-assistant') || last.id === 'response-content-container',
    '`.pop()` 必须落在助手轮容器或响应正文区，实际 ' + brief(last));
  assert.equal(last.chars, 0, '风控拦下这一轮时，如实读到 0 字（旧值在这里报 7 字）');
  for (const e of hits) {
    assert.ok(!String(e.cls).includes('messageInputContainer'),
      'answerSelector 不得命中输入框容器，实际命中 ' + brief(e));
    assert.ok(!hasClass(e, 'chat-user'), 'answerSelector 不得命中用户消息（它会把 5 万字提示词当回答）' + brief(e));
  }
  // 新值必须同时覆盖「外壳」与「正文区」两层：外壳在、正文区还没挂上时也不该读到 0 个节点
  assert.ok(hits.some((e) => hasClass(e, 'chat-assistant')), '外壳层 div.chat-assistant 必须被覆盖');
  assert.ok(hits.some((e) => e.id === 'response-content-container'), '正文层 #response-content-container 必须被覆盖');
});

test('★ zai 声明的 captchaSelector 必须命中真机风控节点，且不拿正常内容误报', () => {
  const declared = SITES.find((s) => s.id === 'zai')?.captchaSelector;
  assert.ok(typeof declared === 'string' && declared.trim(), 'zai 必须声明 captchaSelector（风控可见证据）');
  // 真机读数（同夹具）：#269 #chat-captcha-element 与 #272 #aliyunCaptcha-window-popup.window-show
  // 都是发送被风控拦下后出现的节点；发送前的落地页上 `[id*=captcha]` 命中 0 个。
  const hits = queryAll(declared);
  assert.ok(hits.some((e) => e.id === 'chat-captcha-element'),
    'captchaSelector 必须命中 #chat-captcha-element（有头轮次里只有它可见，光认弹窗会漏）: ' + declared);
  const popup = hits.find((e) => e.id === 'aliyunCaptcha-window-popup');
  assert.ok(popup, 'captchaSelector 必须命中滑块弹窗 #aliyunCaptcha-window-popup');
  assert.ok(hasClass(popup, 'window-show'), '命中的弹窗必须处于 window-show 态');
  // 必须带 `.window-show` 限定：弹窗节点在未显示时也在 DOM 里，不加限定会把「加载过风控 SDK」
  // 误判成「这一轮被风控拦了」。
  assert.match(String(declared), /#aliyunCaptcha-window-popup[^,]*\.window-show/,
    '弹窗那一条必须写成 #aliyunCaptcha-window-popup.window-show（限定显示态）');
  // 不得拿正常内容当风控证据
  for (const e of hits) {
    assert.ok(!hasClass(e, 'chat-assistant') && !hasClass(e, 'chat-user')
      && !String(e.cls).includes('messageInputContainer'),
      'captchaSelector 不得命中正常会话节点: ' + brief(e));
  }
});

test('zai 的 decoder 声明与**真机帧**一致：#30 已取得帧，decoder 换成为它写的 zai kind', () => {
  // ## 这条断言在 2026-10-14 变过一次方向（留档，不要以为它一直长这样）
  //
  // **旧断言**（2026-09-27 起）：`decoder === 'openai-sse'`，理由是「现有 kind 没有一个能解
  // 它真实帧，没有真机帧夹具之前不许猜着换 kind」——那是「宁可不动」的机器化表达。
  //
  // **为什么现在换成 `zai`**：2026-10-14 取得了**真机帧**（用户人工跑
  // `test-mock/zai-capture-frames.mjs`，帧逐字存于
  // `test/fixtures/zai-real-frames/zai-chat-2026-10-14.txt`）。有了 wire 证据，
  // 「不许猜着换」这条约束就不再适用——`lib/decoder.js` 新增了按真帧写的 `ZaiDecoder`，
  // 护栏 `test/zai-decoder.test.mjs` 钉住「解得出 + 不重复播」。
  //
  // 旧断言最后一句自己就预告了这次改动：「拿到真机帧后应新建 zai-real-frames/ 并在这里登记」。
  assert.equal(resolveWebModel('zai:auto').decoder, 'zai');
  const kinds = Object.keys(globalThis.WebCodeStreamDecoders);
  assert.ok(kinds.includes('zai'), '注册表必须有 zai kind');
  assert.ok(kinds.includes('openai-sse') && kinds.includes('glm'), '其余 kind 不受影响');

  // 真机帧夹具**已存在**（这正是本次换 kind 的前提），且与 DOM 清单分开放
  const domDir = new URL('./fixtures/zai-real-dom/', import.meta.url);
  assert.deepEqual(fs.readdirSync(domDir), ['zai-chat-dom-inventory.json'],
    'zai-real-dom 只放 DOM 清单');
  const framesDir = new URL('./fixtures/zai-real-frames/', import.meta.url);
  const frames = fs.readdirSync(framesDir);
  assert.ok(frames.includes('zai-chat-2026-10-14.txt'),
    '真机帧夹具必须在；没有它就不该把 decoder 换成 zai（那就成了「猜着换」）');
});

test('zai 的 completionPaths 覆盖真机的 /api/v2（2026-10-14 真机更正）', () => {
  // 真机读数（那一轮 summary.network 逐字）：
  //   `RES 200 text/event-stream; charset=utf-8
  //    https://chat.z.ai/api/v2/chat/completions?timestamp=…&requestId=…`
  // 旧声明只有 v1 与无版本两条 ⇒ 捕获层按声明匹配时**一个块都接不到**，
  // 而页面照常渲染（静默、极难发现）。这条断言把 v2 钉住。
  const zai = SITES.find((s) => s.id === 'zai');
  assert.ok(zai.completionPaths.includes('/api/v2/chat/completions'),
    'completionPaths 必须含 /api/v2/chat/completions，实际为 ' + JSON.stringify(zai.completionPaths));
});
