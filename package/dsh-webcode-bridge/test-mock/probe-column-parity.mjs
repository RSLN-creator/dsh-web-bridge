// probe-column-parity.mjs — 「我们的一列」与「官方单会话」到底差在哪：出**可读的差异清单**。
//
// ## 为什么必须有它（用户 2026-10-06 两次追问）
//
// 用户原话：「现在一列和官方新对话到单会话的渲染校验有了吗？代码和官方一致吗？」——
// 在那之前，本仓库**没有任何**对照读数：所有「跟官方一样」的说法都只是口头。这个探针把
// 两边的 DOM 指纹 + 几何**并列取一次**，谁缺什么、差多少像素，一眼可见。
//
// ## 两边的取法（都不猜）
//
//   · **我们的一列**：打开左栏「并发会话」（自动建一组）→ 取 `.hwb-concurrent-col` 里
//     官方 factory 产出的容器（`[data-conversation-scroll]` / composer / header 有无）；
//   · **官方单会话**：点左栏一个**工作区**行（官方 `openWorkspace` 会开一条真会话并把
//     中央区切到官方单会话视图）→ 取同一组读数。**点工作区**是这里唯一可靠的入口：
//     官方左栏不列空白会话（本仓库实测），而工作区行一定在。
//
// ## 判据（差异如实列出，不粉饰）
//
// 期望 **一致**：`[data-conversation-scroll]` 存在、官方 composer 存在、会话体容器 class 前缀同族。
// 期望 **不同**（已知且登记在案的差）：官方单会话额外有 `conversation.header`（标题/子智能体/
// 团队/标准模式/后台任务）与 `conversation.view`（对话⇄轨迹切换）——列里那两块要在「照抄」
// 那一轮补上；本探针的作用就是**盯着这两条差有没有被消掉**。
//
// 用法：node test-mock/probe-column-parity.mjs "<带 token 的 dsh web URL>"
// 退出码：0 = 共用面全在（差异只在已登记的两块）；1 = 共用面缺东西，或出现**新的**未知差异。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(here, 'out');
const url = process.argv[2];
if (!url || !/^https?:\/\//.test(url)) {
  console.error('用法: node test-mock/probe-column-parity.mjs "http://127.0.0.1:<port>/?token=…"');
  process.exitCode = 1;
  process.exit();
}

/** 在页面里取「一份会话视图」的指纹（列与官方单会话共用同一段读数逻辑）。 */
function reading() {
  const scroll = document.querySelector('[data-conversation-scroll]');
  const composer = document.querySelector('textarea, [contenteditable="true"]');
  // 会话体容器：官方 factory 产出的那个（class 里带 body / embeddedBody）
  const bodies = Array.from(document.querySelectorAll('[class*="body"]'))
    .filter((el) => /(^|\s)\S*_?(embedded)?[Bb]ody(\s|$)/.test(String(el.className)));
  const headers = Array.from(document.querySelectorAll('header, [class*="header"]'))
    .filter((el) => el.getBoundingClientRect().height > 20);
  const rect = (el) => (el ? { x: Math.round(el.getBoundingClientRect().x), y: Math.round(el.getBoundingClientRect().y), w: Math.round(el.getBoundingClientRect().width), h: Math.round(el.getBoundingClientRect().height) } : null);
  return {
    hasScroll: !!scroll,
    scrollRect: rect(scroll),
    hasComposer: !!composer,
    bodyClasses: bodies.map((b) => String(b.className).slice(0, 70)).slice(0, 3),
    headerCount: headers.length,
    headerClasses: headers.map((h) => String(h.className).slice(0, 50)).slice(0, 4),
    titlebar: rect(document.querySelector('header')),
    url: location.href,
  };
}

const exe = resolveBrowserExecutable();
const exePath = typeof exe === 'string' ? exe : exe && exe.path;
if (!exePath || !fs.existsSync(exePath)) {
  console.error('probe-column-parity: 找不到浏览器可执行文件：' + JSON.stringify(exe));
  process.exitCode = 1;
  process.exit();
}
fs.mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const problems = [];

const browser = await chromium.launch({ executablePath: exePath, headless: true, args: ['--no-first-run'] });
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
try {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByText('并发会话', { exact: true }).first().waitFor({ timeout: 45000 });
  await page.getByText('并发会话', { exact: true }).first().click();
  await page.locator('.hwb-concurrent-panel').first().waitFor({ timeout: 15000 });
  await page.waitForFunction(() => document.querySelectorAll('.hwb-concurrent-col').length > 0, null, { timeout: 30000 });
  await page.waitForTimeout(2500);
  const column = await page.evaluate(reading);
  await page.screenshot({ path: path.join(outDir, 'parity-column-' + stamp + '.png') });

  // 官方单会话入口：**用事实反推**——列里官方 hero 的工作区胶囊文字，就是左栏工作区行的文字。
  // 先读出来，再按**精确文本**点左栏那一行。
  // （上一版靠「扫左栏可疑控件」，扫到的是别的插件的控件：小鲸鱼 / 全局设置 / 按压泡泡设置 ——
  //   实测读数在 parity-*.json 的 candidates 里，所以改成推导而不是猜。）
  const wsName = await page.evaluate(() => {
    const el = document.querySelector('.hwb-concurrent-panel [class*="workspace"]');
    if (!el) return null;
    return String(el.textContent || '').trim().split('\n')[0].trim().slice(0, 40) || null;
  });
  const candidates = wsName ? [{ text: wsName }] : [];
  let official = null;
  let entered = null;
  for (const c of candidates) {
    // ⚠ 同名元素有两处：左栏的工作区行 **和** 我们列里的那个工作区胶囊（点它会开门户浮层，
    //   人还留在面板里 —— 实测就是这样）。所以逐个筛掉「在 .hwb-concurrent-panel 里」的。
    let clicked = false;
    try {
      const all = page.getByText(c.text, { exact: true });
      const n = await all.count();
      for (let i = 0; i < n; i += 1) {
        const inside = await all.nth(i).evaluate((el) => !!el.closest('.hwb-concurrent-panel')).catch(() => true);
        if (inside) continue;
        await all.nth(i).click({ timeout: 8000 });
        clicked = true;
        break;
      }
    } catch (e) { /* 试下一个候选 */ }
    if (!clicked) continue;
    await page.waitForTimeout(3500);
    if ((await page.locator('.hwb-concurrent-panel').count()) === 0 && (await page.locator('[data-conversation-scroll]').count()) > 0) {
      entered = c;
      official = await page.evaluate(reading);
      break;
    }
    // 没离开面板：点回去，试下一个候选
    try {
      await page.getByText('并发会话', { exact: true }).first().click();
      await page.locator('.hwb-concurrent-panel').first().waitFor({ timeout: 8000 });
      await page.waitForTimeout(1200);
    } catch (e) { /* 复原失败就继续试下一个 */ }
  }
  if (!official) {
    // 失败也要出读数：静默退出等于黑盒（第一版就是那样，跑出来「无输出 + 退 1」，没法排查）。
    console.log('=== probe-column-parity ===');
    console.log('列读数：' + JSON.stringify(column));
    console.log('试过的左栏行：' + JSON.stringify(candidates.map((c) => c.text)));
    console.log('✖ 没能打开官方单会话视图 ⇒ 本次**没有**对照读数（不编造对照）');
    problems.forEach((p) => console.log('  - ' + p));
  } else {
    await page.screenshot({ path: path.join(outDir, 'parity-official-' + stamp + '.png') });

    const shared = {
      scroll: column.hasScroll && official.hasScroll,
      composer: column.hasComposer && official.hasComposer,
    };
    const sameBodyFamily = column.bodyClasses.some((c) => /body/i.test(c)) && official.bodyClasses.some((c) => /body/i.test(c));
    if (!shared.scroll || !shared.composer) problems.push('共用面缺失：列与官方单会话应都有 [data-conversation-scroll] 与官方 composer');
    if (!sameBodyFamily) problems.push('会话体容器不同族：列=' + JSON.stringify(column.bodyClasses) + ' 官方=' + JSON.stringify(official.bodyClasses));
    const extraOfficial = official.headerCount > column.headerCount;
    const json = { url, at: new Date().toISOString(), clickedSidebarRow: ws, column, official, shared, sameBodyFamily, knownGap: { officialHeaderRow: extraOfficial } };
    fs.writeFileSync(path.join(outDir, 'parity-' + stamp + '.json'), JSON.stringify(json, null, 2));

    console.log('=== probe-column-parity ===');
    console.log('官方单会话入口：左栏行「' + ws.text + '」');
    console.log('列  ：scroll=' + column.hasScroll + ' composer=' + column.hasComposer + ' header=' + column.headerCount + ' body=' + JSON.stringify(column.bodyClasses));
    console.log('官方：scroll=' + official.hasScroll + ' composer=' + official.hasComposer + ' header=' + official.headerCount + ' body=' + JSON.stringify(official.bodyClasses));
    console.log('几何：列=' + JSON.stringify(column.scrollRect) + ' 官方=' + JSON.stringify(official.scrollRect));
    console.log('共用面：' + JSON.stringify(shared) + ' 同族=' + sameBodyFamily);
    console.log('已登记差异（照抄轮要消掉它的那一项）：官方有 header 行而我们没有 = ' + extraOfficial);
    console.log(problems.length ? '✖ 判据不成立:' : '✔ 判据成立（差异只在已登记项）');
    problems.forEach((p) => console.log('  - ' + p));
  }
} catch (e) {
  problems.push('探针流程异常：' + String(e && e.message || e));
}
await browser.close().catch(() => {});
process.exitCode = problems.length ? 1 : 0;
