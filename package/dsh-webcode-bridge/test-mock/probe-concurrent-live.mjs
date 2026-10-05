// probe-concurrent-live.mjs — 并发会话面板的**真页面**取证（0.19.63 排障轮）。
//
// ## 为什么必须开真页面的 `dsh web`
//
// 0.19.62 的空白排障只做到「字符串断言 + 离线 DOM 回放」，因为那个探针的作者认定
// 「`dsh web` 页面要进程级 token（?token=…），而 token 只存在进程内存里」⇒ 开不了
// 真页面。**这个认定只对了一半**：token 确实只在进程内存里，但 `dsh web` 启动时会把
// 带 token 的 URL **打印到 stdout**（官方 `dsh-web-app` 的 announceReady：
// `console.log(\`dsh web: ${connection.authenticatedUrl(url)}\`)`）。
// 所以只要**由我们自己启动**这个进程，就能拿到 URL、开真页面——本探针就是这么做的。
//
// 与离线回放探针（`probe-compare-layout.mjs`）的分工：
//   · 离线探针：只证明「我们的 CSS 对一段等价 DOM 成立」，不碰官方渲染器；
//   · 本探针：开真页面、点真入口、建真会话，读**官方渲染器亲自产出的 DOM**。
//   两者都要留：前者秒级、能进任何机器；后者是「真的能用吗」的唯一判据。
//
// ## 两类读数必须同时取（0.19.62 的教训）
//
// 「面板全空」有两种形状，修法完全不同，而肉眼看起来一模一样：
//   ① **抛错**：官方 `SlotErrorBoundary` 把崩溃条目渲染成 `<div data-slot-error>` 空盒
//      （报错只在 F12）——读数里应出现 `[data-slot-error]` 或 `pageerror`；
//   ② **塌高**：没抛错，但父容器不给高度 / `overflow:hidden` 裁掉，根节点 rect 高度为 0。
// 所以本探针**既收错误、也收几何**：根节点/页签/列容器的 bounding box + computed style，
// 以及从根往上的**父链 rect**（一眼能看出是哪一级把高度吃掉的）。
//
// ## 用法
//
//   node test-mock/probe-concurrent-live.mjs "http://127.0.0.1:3087/?token=…"
//   node test-mock/probe-concurrent-live.mjs <url> --headed     # 看得见浏览器（排障用）
//
// 退出码：0 = 全部判据成立；1 = 有判据不成立（打印实际读数）或起不了浏览器。
// 读数（JSON + 截图）落在 test-mock/out/concurrent-live-<ts>.{json,png}。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const outDir = path.join(here, 'out');

const url = process.argv[2];
const headed = process.argv.includes('--headed');
if (!url || !/^https?:\/\//.test(url)) {
  console.error('用法: node test-mock/probe-concurrent-live.mjs "http://127.0.0.1:<port>/?token=…" [--headed]');
  process.exitCode = 1;
  process.exit();
}

/** 官方 composer 的判定：官方 InputBar 是 textarea；富文本形态是 contenteditable。 */
const COMPOSER_SEL = 'textarea, [contenteditable="true"]';

/** 页面里取几何与文本读数（在浏览器上下文里跑，因此不能引用 Node 侧变量）。 */
function collectReading() {
  const rectOf = (el) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
      display: cs.display, overflow: cs.overflow, position: cs.position,
      flex: cs.flex, minHeight: cs.minHeight, height: cs.height,
    };
  };
  const chain = (el, max) => {
    const out = [];
    let node = el;
    for (let i = 0; node && i < max; i += 1) {
      out.push({
        tag: node.tagName.toLowerCase(),
        cls: String(node.className || '').slice(0, 90),
        slot: node.getAttribute && (node.getAttribute('data-slot') || node.getAttribute('data-dsh-slot') || ''),
        rect: rectOf(node),
      });
      node = node.parentElement;
    }
    return out;
  };
  const panel = document.querySelector('.hwb-concurrent-panel');
  const tabs = Array.from(document.querySelectorAll('.hwb-concurrent-tab'));
  const colsWrap = document.querySelector('.hwb-concurrent-columns');
  const cols = Array.from(document.querySelectorAll('.hwb-concurrent-col'));
  const boundary = Array.from(document.querySelectorAll('[data-hwb-boundary]'));
  const slotError = Array.from(document.querySelectorAll('[data-slot-error]'));
  const colsDetail = cols.map((c, i) => ({
    index: i,
    title: (c.querySelector('.hwb-concurrent-col-title') || {}).textContent || '',
    rect: rectOf(c),
    bodyRect: rectOf(c.querySelector('.hwb-concurrent-col-body')),
    composers: c.querySelectorAll('textarea, [contenteditable="true"]').length,
    bodyText: String((c.querySelector('.hwb-concurrent-col-body') || {}).textContent || '').slice(0, 160),
    hasWorkspaceCard: /选择工作区|选择范围|Choose a workspace/i.test(String(c.textContent || '')),
  }));
  return {
    panelRect: rectOf(panel),
    panelChain: chain(panel, 8),
    tabs: tabs.map(t => ({ text: t.textContent, selected: t.getAttribute('aria-selected'), rect: rectOf(t) })),
    colsWrapRect: rectOf(colsWrap),
    colsCount: cols.length,
    colsDeclared: colsWrap ? colsWrap.getAttribute('data-cols') : null,
    cols: colsDetail,
    boundaryCount: boundary.length,
    boundaryText: boundary.map(b => String(b.textContent || '').slice(0, 300)),
    slotErrorCount: slotError.length,
    slotErrorText: slotError.map(b => String(b.textContent || '').slice(0, 300)),
    panelText: String((panel || {}).textContent || '').slice(0, 400),
    url: location.href,
  };
}

const exe = resolveBrowserExecutable();
const exePath = typeof exe === 'string' ? exe : exe && exe.path;
if (!exePath || !fs.existsSync(exePath)) {
  console.error('probe-concurrent-live: 找不到浏览器可执行文件（resolveBrowserExecutable 返回 ' + JSON.stringify(exe) + '）');
  process.exitCode = 1;
  process.exit();
}

fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const jsonPath = path.join(outDir, 'concurrent-live-' + stamp + '.json');
const pngPath = path.join(outDir, 'concurrent-live-' + stamp + '.png');

const consoleErrors = [];
const pageErrors = [];
const failedRequests = [];
const problems = [];

const browser = await chromium.launch({ executablePath: exePath, headless: !headed, args: ['--no-first-run', '--no-default-browser-check'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 }, locale: 'zh-CN' });
const page = await context.newPage();
page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text().slice(0, 400)); });
page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 400)));
page.on('requestfailed', (r) => failedRequests.push(r.url() + ' :: ' + String(r.failure() && r.failure().errorText)));

let reading = null;
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  // 等到左栏出现本插件的入口（官方 shell 自己画的按钮）。
  await page.getByText('并发会话', { exact: true }).first().waitFor({ timeout: 45000 });
  await page.getByText('并发会话', { exact: true }).first().click();
  await page.locator('.hwb-concurrent-panel').first().waitFor({ state: 'visible', timeout: 15000 });

  // 建 3 列真会话（走官方 sessions.create；这是用户真实路径的第一步）。
  const createBtn = page.locator('.hwb-concurrent-action').first();
  if (await createBtn.count()) {
    await createBtn.click();
    try {
      await page.waitForFunction(() => document.querySelectorAll('.hwb-concurrent-col').length > 0, null, { timeout: 30000 });
    } catch (e) {
      problems.push('建列后 30s 内没有出现任何 .hwb-concurrent-col');
    }
    // 列出现后再等一拍，让官方会话体挂载（它要开真会话）。
    await page.waitForTimeout(2500);
  } else {
    problems.push('面板里找不到「新建并发会话」按钮（.hwb-concurrent-action）');
  }

  reading = await page.evaluate(collectReading);
  await page.screenshot({ path: pngPath, fullPage: false });

  // ── 判据 ────────────────────────────────────────────────────────────────
  if (!reading.panelRect || reading.panelRect.w < 40 || reading.panelRect.h < 40) {
    problems.push('面板根节点不可见或塌高：' + JSON.stringify(reading.panelRect));
  }
  if (reading.tabs.length !== 2) problems.push('页签数 != 2：' + JSON.stringify(reading.tabs.map(t => t.text)));
  if (reading.boundaryCount > 0) problems.push('插件错误边界被触发：' + JSON.stringify(reading.boundaryText));
  if (reading.slotErrorCount > 0) problems.push('官方 SlotErrorBoundary 被触发（空盒）：' + JSON.stringify(reading.slotErrorText));
  if (pageErrors.length > 0) problems.push('页面抛错 pageerror：' + JSON.stringify(pageErrors.slice(0, 3)));
  if (reading.colsCount < 1) problems.push('一列都没有（colsCount=' + reading.colsCount + '）');
  const noComposer = reading.cols.filter(c => c.composers === 0).map(c => c.index);
  if (reading.colsCount > 0 && noComposer.length) {
    problems.push('这些列里没有官方 composer：' + JSON.stringify(noComposer.map(i => reading.cols[i])));
  }

  // 列内点击不许跳走：点第一列正文中心，再确认面板还在。
  if (reading.colsCount > 0) {
    const box = await page.locator('.hwb-concurrent-col-body').first().boundingBox();
    if (box) {
      await page.mouse.click(box.x + box.width / 2, box.y + Math.min(box.height / 2, 120));
      await page.waitForTimeout(1500);
      const stillThere = await page.locator('.hwb-concurrent-panel').count();
      if (!stillThere) problems.push('列内点击后面板消失（跳回单个会话）');
      const after = await page.evaluate(collectReading);
      reading.afterClick = { panelRect: after.panelRect, tabs: after.tabs.length, colsCount: after.colsCount };
    }
  }
} catch (e) {
  problems.push('探针流程异常：' + String(e && e.message || e));
}

const report = {
  url, at: new Date().toISOString(), headed,
  problems, consoleErrors, pageErrors, failedRequests,
  reading,
};
fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));

console.log('=== probe-concurrent-live ===');
console.log('url      : ' + url);
console.log('json     : ' + jsonPath);
console.log('png      : ' + pngPath);
if (reading) {
  console.log('panel    : ' + JSON.stringify(reading.panelRect));
  console.log('tabs     : ' + JSON.stringify(reading.tabs.map(t => t.text)));
  console.log('cols     : ' + reading.colsCount + ' (data-cols=' + reading.colsDeclared + ')');
  reading.cols.forEach(c => console.log('  col#' + c.index + ' composers=' + c.composers +
    ' wsCard=' + c.hasWorkspaceCard + ' h=' + (c.rect && c.rect.h) + ' | ' + c.title));
  if (reading.boundaryText.length) console.log('boundary : ' + JSON.stringify(reading.boundaryText));
  if (reading.slotErrorText.length) console.log('slotError: ' + JSON.stringify(reading.slotErrorText));
  console.log('panelText: ' + JSON.stringify(reading.panelText.slice(0, 200)));
}
if (pageErrors.length) console.log('pageerr  : ' + JSON.stringify(pageErrors.slice(0, 5)));
if (consoleErrors.length) console.log('console  : ' + JSON.stringify(consoleErrors.slice(0, 5)));
console.log(problems.length ? '✖ 判据不成立:' : '✔ 全部判据成立');
problems.forEach(p => console.log('  - ' + p));

await context.close().catch(() => {});
await browser.close().catch(() => {});
process.exitCode = problems.length ? 1 : 0;
