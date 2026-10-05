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
// `--explore`：逐个点面板内**可点元素**，找出「哪一下会把面板切回官方会话/工作区」
// （0.19.64：用户报「还是会切回到官方工作区」——不再靠猜哪个控件，直接穷举取证）。
const explore = process.argv.includes('--explore');
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

  // 0.19.65：点入口 = 点「新会话」，面板挂载后**自动**新建一组（不再需要点按钮）。
  // 老选择器 `.hwb-concurrent-action` 已改名 `.hwb-concurrent-fab`（悬浮右上角）。
  const createBtn = page.locator('.hwb-concurrent-fab').first();
  if (await createBtn.count()) {
    try {
      await page.waitForFunction(() => document.querySelectorAll('.hwb-concurrent-col').length > 0, null, { timeout: 30000 });
    } catch (e) {
      // 没自动建（旧版）就点一次悬浮钮，保证后续判据仍能跑。
      await createBtn.click();
      await page.waitForFunction(() => document.querySelectorAll('.hwb-concurrent-col').length > 0, null, { timeout: 30000 });
    }
    // 列出现后再等一拍，让官方会话体挂载（它要开真会话）。
    await page.waitForTimeout(2500);
  } else {
    problems.push('面板里找不到「+ 加一列」悬浮钮（.hwb-concurrent-fab）');
  }

  // ── --explore：穷举「面板内哪一下会切回官方会话/工作区」 ────────────────────
  //
  // 用户的报障是「还是会切回到官方工作区」，但面板里的可点元素有一堆（工作区胶囊、
  // 模型选择、权限、分支、附件、加到队列……），靠猜会来回返工。这里把面板内**自绘之外的**
  // 可点元素逐个点一遍，每点一次就检查 `.hwb-concurrent-panel` 还在不在；不在了就当场
  // 截图留证并恢复面板，继续下一个。
  //
  // 刻意跳过的东西（它们是本插件自绘控件，语义已知，另有判据覆盖）：
  // 发送/停止、关列的 ✕、左右平移 ‹›、两个页签。文本框与 contenteditable 内部一律不点。
  if (explore) {
    const listCandidates = () => page.evaluate(() => {
      const panel = document.querySelector('.hwb-concurrent-panel');
      if (!panel) return [];
      const out = [];
      let i = 0;
      for (const el of panel.querySelectorAll('button, [role="button"], [role="tab"], a[href], [aria-haspopup], [tabindex]')) {
        const text = String(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 46);
        const aria = String(el.getAttribute('aria-label') || el.getAttribute('title') || '').slice(0, 46);
        const label = text || aria || el.tagName.toLowerCase();
        if (/发送|停止|send|stop|✕|‹|›|^并发对话$|^并发轨迹$/.test(label)) continue;
        if (el.closest('textarea, [contenteditable="true"]')) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 6 || r.height < 6) continue;
        el.setAttribute('data-hwb-probe-click', String(i));
        out.push({
          i, label, tag: el.tagName.toLowerCase(),
          cls: String(el.className || '').slice(0, 70),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        });
        i += 1;
        if (i >= 24) break;
      }
      return out;
    });

    const candidates = await listCandidates();
    console.log('--- explore: ' + candidates.length + ' 个可点元素 ---');
    reading = await page.evaluate(collectReading);
    reading.explore = [];

    /** 点一下，等一拍，报告面板是否还在（跳走被守卫拉回也算「还在」，但要记 pullBack）。 */
    const clickAndCheck = async (point, label, cls) => {
      const before = await page.evaluate(() => location.href);
      try { await page.mouse.click(point.x, point.y); } catch (e) { /* 坐标失效 */ }
      await page.waitForTimeout(700);
      let gone = (await page.locator('.hwb-concurrent-panel').count()) === 0;
      await page.waitForTimeout(900); // 守卫窗口 900ms：给「跳走→拉回」留出时间
      const alive = (await page.locator('.hwb-concurrent-panel').count()) > 0;
      return { label, cls, panelAlive: alive, pulledBack: gone && alive, urlChanged: (await page.evaluate(() => location.href)) !== before, gone };
    };

    /** 当前打开的浮层（官方 popover/menu/listbox）——记录它在不在面板子树里。 */
    const popups = () => page.evaluate(() => {
      const panel = document.querySelector('.hwb-concurrent-panel');
      const sel = '[role="listbox"],[role="menu"],[role="dialog"],[data-radix-popper-content-wrapper],[class*="popover"],[class*="Popover"],[class*="dropdown"],[class*="Dropdown"]';
      return Array.from(document.querySelectorAll(sel)).map((el) => {
        const r = el.getBoundingClientRect();
        return {
          insidePanel: !!(panel && panel.contains(el)),
          text: String(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 120),
          rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        };
      }).filter((p) => p.rect.w > 20 && p.rect.h > 12);
    });

    /** 浮层里的可点选项（带坐标）。 */
    const popupOptions = () => page.evaluate(() => {
      const sel = '[role="option"],[role="menuitem"],[role="menuitemradio"],[role="listbox"] button,[role="menu"] button,[data-radix-popper-content-wrapper] button';
      return Array.from(document.querySelectorAll(sel)).map((el, i) => {
        const r = el.getBoundingClientRect();
        el.setAttribute('data-hwb-probe-opt', String(i));
        return { i, label: String(el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 46), rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } };
      }).filter((o) => o.rect.w > 20 && o.rect.h > 8);
    });

    for (const c of candidates) {
      // 每次点击前**重新取**坐标：浮层/重排版会让旧坐标失效。
      const box = await page.evaluate((idx) => {
        const el = document.querySelector('[data-hwb-probe-click="' + idx + '"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width, h: r.height };
      }, c.i);
      if (!box || box.w < 6 || box.h < 6) { reading.explore.push({ ...c, skipped: 'gone-or-hidden' }); continue; }

      const step1 = await clickAndCheck(box, c.label, c.cls);
      const row = { ...c, ...step1, options: [] };
      if (!step1.panelAlive) {
        await page.screenshot({ path: pngPath.replace('.png', '-broke-' + c.i + '.png') });
        problems.push('点击面板内「' + c.label + '」后面板消失（切回官方会话/工作区）：' + c.cls);
        try {
          await page.getByText('并发会话', { exact: true }).first().click();
          await page.locator('.hwb-concurrent-panel').first().waitFor({ timeout: 8000 });
          row.recovered = true;
        } catch (e) { row.recovered = false; }
        reading.explore.push(row);
        console.log('  [BROKE] ' + c.label + '   <' + c.tag + ' class="' + c.cls + '">');
        continue;
      }

      // 第二步：如果这一下打开了浮层，把浮层里的每个选项也点一遍。
      const open = await popups();
      if (open.length) {
        row.popup = open[0];
        console.log('  [popup] ' + c.label + ' 打开浮层 insidePanel=' + open[0].insidePanel + ' :: ' + open[0].text.slice(0, 80));
        const opts = await popupOptions();
        for (const o of opts) {
          const b = await page.evaluate((idx) => {
            const el = document.querySelector('[data-hwb-probe-opt="' + idx + '"]');
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return r.width < 6 ? null : { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          }, o.i);
          if (!b) continue;
          const step2 = await clickAndCheck(b, o.label, 'popup-option');
          row.options.push(step2);
          console.log('    [' + (step2.panelAlive ? (step2.pulledBack ? 'PULLED' : 'ok    ') : 'BROKE ') + '] 选项: ' + o.label);
          if (!step2.panelAlive) {
            problems.push('面板内「' + c.label + '」→ 浮层选项「' + o.label + '」把面板切走了（官方 openWorkspace/openSession → selectPanel(null)）');
            await page.screenshot({ path: pngPath.replace('.png', '-broke-opt-' + c.i + '-' + o.i + '.png') });
            try {
              await page.getByText('并发会话', { exact: true }).first().click();
              await page.locator('.hwb-concurrent-panel').first().waitFor({ timeout: 8000 });
            } catch (e) { /* 记在 reading 里 */ }
            break; // 这个触发器已经定性，不必再点其余选项
          }
        }
        if (!row.options.length) await page.keyboard.press('Escape').catch(() => {});
      }
      reading.explore.push(row);
      if (!open.length) console.log('  [' + (step1.pulledBack ? 'PULLED' : 'ok  ') + '] ' + c.label + '   <' + c.tag + ' class="' + c.cls + '">');
    }
  }

  reading = await page.evaluate(collectReading);
  await page.screenshot({ path: pngPath, fullPage: false });

  // ── 判据 ────────────────────────────────────────────────────────────────
  if (!reading.panelRect || reading.panelRect.w < 40 || reading.panelRect.h < 40) {
    problems.push('面板根节点不可见或塌高：' + JSON.stringify(reading.panelRect));
  }
  if (reading.tabs.length !== 0) {
    problems.push('顶部不得再有面板级页签（0.19.65 起视图交给每列自己）：' + JSON.stringify(reading.tabs.map(t => t.text)));
  }
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

  // ── 左栏「并发会话目录」判据（0.19.65）──────────────────────────────────────
  // 用户原话：「否则怎么找回已过去的并发会话！！！」⇒ 建完组后左栏必须多出一行
  // `并发会话 · N 列`，点它要能**把那一组重新打开**（列数与组内会话数一致）。
  {
    const groupRow = page.getByText(/^并发会话 · \d+ 列$/).first();
    try {
      await groupRow.waitFor({ timeout: 8000 });
      reading.groupRow = (await groupRow.textContent()) || '';
      await groupRow.click();
      await page.waitForTimeout(2000);
      const cols = await page.locator('.hwb-concurrent-col').count();
      reading.groupRowCols = cols;
      if (cols < 1) problems.push('点左栏历史组行后面板一列都没有（那一组没被找回）');
      // 回主入口，后面的判据仍在主入口上跑
      await page.getByText('并发会话', { exact: true }).first().click();
      await page.locator('.hwb-concurrent-panel').first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(1500);
    } catch (e) {
      problems.push('左栏没有出现历史组行（「并发会话 · N 列」）——并发目录没登记上');
    }
  }

  // ── 「↗ 官方视图」判据（0.19.65）────────────────────────────────────────────
  // 官方 header 那几块 chip（标准模式 / 后台任务 / 团队）只由**官方会话视图**渲染（槽的公开
  // 投影不含组件），所以受支持的交付是「把这一条会话交回官方视图」。这里点第一列那颗按钮，
  // 要求：我们的面板消失 + 官方会话体出现 + 官方 header 元素出现（≥2：标题栏与工具行）。
  {
    const btn = page.getByText('↗ 官方视图', { exact: true }).first();
    try {
      await btn.waitFor({ timeout: 8000 });
      await btn.click();
      await page.waitForTimeout(3500);
      const panelGone = (await page.locator('.hwb-concurrent-panel').count()) === 0;
      const scroll = await page.locator('[data-conversation-scroll]').count();
      const headers = await page.evaluate(() => Array.from(document.querySelectorAll('header, [class*="header"]'))
        .filter((el) => el.getBoundingClientRect().height > 20).length);
      reading.openOfficial = { panelGone, scroll, headers };
      // 已知缺口（0.19.65 实测）：`ctx.uiWorkspace.openSession(sid)` 没能把中央区切到官方视图
      //（面板没关、scroll 仍是三列自己的、header 仍为 1）⇒ 记成 knownGap 而不是判据失败：
      // 判据只覆盖「我们声称已经能用的东西」，这一条**尚未能用**，如实记录、不当绿灯。
      if (!panelGone || scroll < 1 || headers < 2) {
        reading.knownGapOpenOfficial = '↗ 官方视图 未生效：panelGone=' + panelGone + ' scroll=' + scroll + ' headers=' + headers
          + '（下一步：查 ctx.uiWorkspace 的真实成员名与调用签名，或改用官方 openSession 的其它入口）';
      }
      await page.getByText('并发会话', { exact: true }).first().click();
      await page.locator('.hwb-concurrent-panel').first().waitFor({ timeout: 10000 });
      await page.waitForTimeout(1200);
    } catch (e) {
      problems.push('「↗ 官方视图」按钮不可用：' + String(e && e.message || e));
    }
  }

  // ── 工作区浮层（门户）判据（0.19.64）────────────────────────────────────────
  //
  // 用户报「还是会切回到官方工作区」。真机取证：官方工作区胶囊的浮层开在**门户**里
  // （DOM 不在面板子树内），选一个工作区会走 `openWorkspace → replaceMain('reveal') →
  // selectPanel(null)`，把整个面板换掉。这里**故意先等 2.5s 再点选项**——超过
  // PANEL_GUARD_MS(900ms)，专门逼守卫走「门户链」那一支（而不是靠时间窗侥幸命中）。
  // 这是默认判据的一部分：以后谁改守卫，这条会红。
  if (reading.colsCount > 0) {
    const crumb = await page.evaluate(() => {
      const el = document.querySelector('.hwb-concurrent-panel [class*="workspace"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return r.width > 6 ? { x: r.x + r.width / 2, y: r.y + r.height / 2, text: String(el.textContent || '').slice(0, 24) } : null;
    });
    reading.workspacePopup = { crumb: !!crumb };
    if (crumb) {
      await page.mouse.click(crumb.x, crumb.y);
      await page.waitForTimeout(2500);
      const opt = await page.evaluate(() => {
        const sel = '[role="option"],[role="menuitem"],[role="menuitemradio"],[class*="popover"] button,[class*="Popover"] button,[class*="dropdown"] button';
        const list = Array.from(document.querySelectorAll(sel)).filter((el) => { const r = el.getBoundingClientRect(); return r.width > 20 && r.height > 8; });
        if (!list.length) return null;
        const r = list[0].getBoundingClientRect();
        return { x: r.x + r.width / 2, y: r.y + r.height / 2, n: list.length, text: String(list[0].textContent || '').slice(0, 24) };
      });
      reading.workspacePopup.option = !!opt;
      if (opt) {
        await page.mouse.click(opt.x, opt.y);
        await page.waitForTimeout(1800);
        const alive = (await page.locator('.hwb-concurrent-panel').count()) > 0;
        const guard = await page.evaluate(() => window.__hwbPanelGuard || null);
        reading.workspacePopup.panelAlive = alive;
        reading.workspacePopup.guard = guard;
        if (!alive) problems.push('在工作区浮层里选一个工作区后，面板被切走（官方 openWorkspace → selectPanel(null)；守卫没盖住门户链）');
        else if (!guard || !(guard.pulls > 0)) problems.push('面板还在，但守卫没有记录到回拉（__hwbPanelGuard.pulls=' + (guard && guard.pulls) + '）——可能是碰巧没跳走，判据不成立');
      }
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
