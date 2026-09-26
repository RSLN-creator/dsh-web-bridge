// probe-compare-layout.mjs — 并列多会话「照抄官方」的真布局取证（0.19.22）。
//
// ## 为什么必须真开一次浏览器
//
// 0.19.22 的布局修复依赖两条**别人家的 DOM/CSS 契约**，只做字符串断言等于只证明
// 「我写了这串字」，证明不了「这串字真的命中」。两条契约是：
//
//   ① 视图根节点声明 `data-conversation-composer-overlay` ⇒ 官方 CSS
//      `.scrollBody:has([data-conversation-composer-overlay])>[data-slot=conversation\.session]>.viewArea`
//      把 `.viewArea` 变成 `flex:1 1 0;min-height:0;overflow:hidden`
//      ⇒ 视图拿到**确定的整屏高度**（用户要的「上下都全长」）。
//   ② 官方的对话框座位 `.composerSeat[data-composer-seat]` 与视图在**同一个滚动
//      容器**里 ⇒ 本视图挂载期间必须让它让位，否则最底部再叠第四个框
//      （用户原话：「被下面原生的挤了」）。
//
// ## 为什么不是「打开真 GUI 页面」
//
// `dsh web` 的页面要**进程级 token**（`?token=…`，401 就是缺它），而那个 token
// 只存在进程内存里，`DSH_WEB_URL` 环境变量给的只是 origin。因此本探针改用
// **官方样式原样回放**：从官方包里逐字抽出两份真实 CSS（ConversationRoot 与
// InputBar，含官方那两条 `:has()` 规则），配上与官方渲染结构逐字相同的 DOM，
// 再注入本插件的新版 CSS，最后由 Chromium 算**计算样式**。
//
// 这比字符串断言强一个量级：`:has()` 是否真的级联到 `.viewArea`、官方那份
// hashed 类名是否真的被我们的属性选择器命中、我们那条让位规则是否**只在**本视图
// 挂载时生效 —— 三件事都只有真渲染才能回答。
//
// 用法：node test-mock/probe-compare-layout.mjs
// 退出码：0 = 全部成立；1 = 有断言不成立（打印实际读数）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const OFFICIAL = 'C:/Users/rsyhn/AppData/Roaming/npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai';

/** 从 JS 源码里取一个字面量字符串（`const css$4 = "…";`），逐字、不去转义歧义。 */
function extractLiteral(file, varName) {
  const src = fs.readFileSync(file, 'utf8');
  const at = src.indexOf(`const ${varName} = "`);
  if (at < 0) throw new Error(`找不到 ${varName}（${file}）`);
  const open = src.indexOf('"', at + `const ${varName} = `.length);
  let i = open + 1;
  while (i < src.length) {
    if (src[i] === '\\') { i += 2; continue; }
    if (src[i] === '"') break;
    i += 1;
  }
  const literal = src.slice(open, i + 1);
  // eslint-disable-next-line no-new-func —— 输入是官方包里的纯字符串字面量
  return Function(`"use strict"; return ${literal};`)();
}

/** 本插件新版里并列多会话那一段 CSS（从 client.cjs 的字符串数组里取）。 */
function compareCss() {
  const src = fs.readFileSync(path.join(pkgRoot, 'lib', 'client.cjs'), 'utf8');
  const start = src.indexOf('"[data-conversation-scroll]:has(');
  const end = src.indexOf('".hwb-chat-head');
  if (start < 0 || end < 0 || end <= start) throw new Error('找不到并列多会话的 CSS 段（起点/终点锚点已变，需同步本探针）');
  const raw = src.slice(start, end);
  const out = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('"'))
    // `[data-cols=\"2\"]` 这类转义引号在 CSS 里不需要反斜杠，去掉它。
    .map((l) => l.replace(/^"/, '').replace(/",?$/, '').replace(/\\"/g, '"'))
    .join('\n');
  // 抽歪了必须**当场炸**：空 CSS 会让下面所有样式判据变成「都失败」，
  // 那种红指向的是探针自己，不指向产品 —— 本仓库把这种红叫「空转」。
  if (!/\.hwb-col-composer-card\{/.test(out) || !/\.hwb-compare-view\{/.test(out)) {
    throw new Error('CSS 抽取结果里找不到关键规则，抽取逻辑已失效');
  }
  return out;
}

const convCss = extractLiteral(`${OFFICIAL}/dsh-client-ui-conversation/lib/client.js`, 'css$4');
const inputCss = extractLiteral(`${OFFICIAL}/dsh-client-ui-conversation/lib/client.js`, 'css$1');
const mine = compareCss();

/** 与官方渲染结构逐字相同的 DOM（含本插件的三列与各自对话框）。
 *
 *  `[data-slot="conversation.session"]` 上的 `display:contents` **不是**这里编的：
 *  它是官方 slot 渲染器自己的锚点样式（`dsh-client-ui-renderer/lib/client.js:1094`
 *  `const ANCHOR_STYLE = { display: "contents" }`，注释原文「keeps the wrapper out of
 *  layout (grid/flex parents see the slot's own children)」）。少了它，`.viewArea`
 *  就不是滚动容器的 flex 子项，整条链的高度都算不对 —— 探针会红在**自己**身上。 */
const COL = (n, site) => `
  <div class="hwb-compare-col">
    <div class="hwb-compare-col-head"><span>${site}</span></div>
    <div class="hwb-compare-col-body">第 ${n} 列正文</div>
    <form class="hwb-col-composer">
      <div class="hwb-col-composer-card">
        <textarea class="hwb-col-composer-input" placeholder="向 ${site} 继续提问…"></textarea>
        <div class="hwb-col-composer-row">
          <span class="hwb-col-composer-hint">Enter 发送</span>
          <button type="submit" class="hwb-col-composer-send">↑</button>
        </div>
      </div>
    </form>
  </div>`;

const html = `<!doctype html><html><head><meta charset="utf-8">
<style id="official-conv">${convCss}</style>
<style id="official-inputbar">${inputCss}</style>
<style id="plugin-compare">${mine}</style>
<style>html,body{margin:0;height:100%}</style>
</head><body>
<div class="wSkVaW_root" data-phase="active" style="height:100vh">
  <div class="wSkVaW_body" data-conversation-content="1">
    <div class="wSkVaW_scrollBody" data-conversation-scroll="1">
      <div data-slot="conversation.session" style="display:contents">
        <div class="wSkVaW_viewArea">
          <div class="hwb-compare-view" data-conversation-composer-overlay="1">
            <div class="hwb-compare-columns" data-cols="3">${COL(1, 'DeepSeek')}${COL(2, 'GLM')}${COL(3, 'Kimi')}</div>
          </div>
        </div>
      </div>
      <div class="wSkVaW_composerSeat" data-composer-seat="1">
        <div class="wSkVaW_composerStack"><div class="uV2eYG_root"><div class="uV2eYG_card">官方对话框</div></div></div>
      </div>
    </div>
  </div>
</div>
</body></html>`;

const exe = resolveBrowserExecutable();
if (!exe?.path) { console.error('找不到可用浏览器'); process.exit(1); }
const tmp = path.join(os.tmpdir(), `hwb-compare-layout-${process.pid}.html`);
fs.writeFileSync(tmp, html, 'utf8');

let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail === undefined ? '' : '  →  ' + detail}`);
  if (!ok) failed += 1;
};

const browser = await chromium.launch({ executablePath: exe.path, headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto('file://' + tmp.replace(/\\/g, '/'));
  const r = await page.evaluate(() => {
    const q = (s) => document.querySelector(s);
    const scroll = q('[data-conversation-scroll]');
    const viewArea = q('.wSkVaW_viewArea');
    const root = q('.hwb-compare-view');
    const seat = q('[data-composer-seat]');
    const cols = [...document.querySelectorAll('.hwb-compare-col')];
    const cards = [...document.querySelectorAll('.hwb-col-composer-card')];
    const send = q('.hwb-col-composer-send');
    const cs = (el) => getComputedStyle(el);
    const out = {
      viewArea: { flexGrow: cs(viewArea).flexGrow, flexBasis: cs(viewArea).flexBasis, minHeight: cs(viewArea).minHeight, overflow: cs(viewArea).overflow },
      rootBox: { h: Math.round(root.getBoundingClientRect().height), w: Math.round(root.getBoundingClientRect().width) },
      scrollBox: { h: Math.round(scroll.getBoundingClientRect().height) },
      seatDisplay: cs(seat).display,
      colCount: cols.length,
      cardCount: cards.length,
      cardRadius: cs(cards[0]).borderRadius,
      cardWidths: cards.map((c) => Math.round(c.getBoundingClientRect().width)),
      colWidths: cols.map((c) => Math.round(c.getBoundingClientRect().width)),
      sendBox: { w: Math.round(send.getBoundingClientRect().width), h: Math.round(send.getBoundingClientRect().height), radius: cs(send).borderRadius },
      // 让位规则必须是局部的：把视图根节点挪走，官方座位必须自己回来。
      seatAfterUnmount: (() => { root.remove(); const d = cs(seat).display; scroll.prepend(root); return d; })(),
      // 再把官方协议属性摘掉：.viewArea 必须**失去** overlay 那条规则给的
      // `overflow:hidden`（基础 `.viewArea` 只写 flex/min-height，不写 overflow，
      // 所以 overflow 才是这条属性在承重的**判别位**；flex-basis 两侧都是 0%，
      // 用它判会得到一条永远绿的假判据）。
      viewAreaWithoutMarker: (() => {
        root.removeAttribute('data-conversation-composer-overlay');
        const o = cs(viewArea).overflow; root.setAttribute('data-conversation-composer-overlay', '1'); return o;
      })(),
      hasSupport: CSS.supports('selector(:has(*))'),
    };
    return out;
  });

  check('浏览器支持 :has()（官方 CSS 与本插件都依赖它）', r.hasSupport === true);
  check('官方协议属性生效：.viewArea 拿到 flex:1 1 0 + min-height:0 + overflow:hidden',
    r.viewArea.flexGrow === '1' && r.viewArea.flexBasis === '0px' && r.viewArea.minHeight === '0px' && r.viewArea.overflow === 'hidden',
    JSON.stringify(r.viewArea));
  check('★ 摘掉协议属性后 .viewArea 立刻失去 overlay 给的 overflow:hidden（这条属性在承重）',
    r.viewAreaWithoutMarker !== 'hidden', 'overflow=' + r.viewAreaWithoutMarker);
  check('视图占满整个滚动容器（上下都到边 = 用户要的「全长」）',
    Math.abs(r.rootBox.h - r.scrollBox.h) <= 1, `root=${r.rootBox.h} scroll=${r.scrollBox.h}`);
  check('★ 本视图挂载期间官方对话框座位让位（display:none）', r.seatDisplay === 'none', r.seatDisplay);
  check('★ 视图卸载后官方对话框立刻回来（不是全局隐藏）', r.seatAfterUnmount !== 'none', r.seatAfterUnmount);
  check('三列各有一个自己的对话框（3 者独立不变）', r.colCount === 3 && r.cardCount === 3,
    `cols=${r.colCount} cards=${r.cardCount}`);
  check('每列对话框卡片占满本列宽度（用户要的「左右也全长」）',
    r.cardWidths.every((w, i) => w >= r.colWidths[i] - 14),
    `card=${JSON.stringify(r.cardWidths)} col=${JSON.stringify(r.colWidths)}`);
  check('卡片是官方刻度（radius 22px）', r.cardRadius === '22px', r.cardRadius);
  check('发送按钮是官方那枚 34px 圆形主按钮',
    r.sendBox.w === 34 && r.sendBox.h === 34 && r.sendBox.radius === '999px', JSON.stringify(r.sendBox));
  console.log('读数：', JSON.stringify(r, null, 1));
} finally {
  await browser.close();
  fs.rmSync(tmp, { force: true });
}
console.log(failed === 0 ? '✓ 布局取证通过' : `✗ 布局取证失败：${failed} 条`);
process.exit(failed === 0 ? 0 : 1);
