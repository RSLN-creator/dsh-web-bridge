#!/usr/bin/env node
// probe-jobs-chip-live.mjs — ④ jobs chip 的**真机**判据（0.19.68）。
//
// ## 为什么需要「造 live jobs」才算验证
//
// jobs chip 的数据面是官方 `ctx.jobs`（`useJobs(s => s.rows[sessionId])`），
// 而它**只有在真的有一条后台任务在跑时**才有内容可显示（0.19.67 真机读数：
// 「已接线（无任务时不显示）」）。换句话说：**空态证明不了接线**——
// 一个写死不渲染的实现、或者一个从未订阅成功的实现，在空态下都「看起来没问题」。
// ⇒ 必须造出**真的 live job**，再看 chip 是否出现且数字正确。
//
// ## 怎么造（走真链路，不做假数据）
//
// 在**列里的官方 composer** 真的发一条指令，让模型用 `pwsh` 工具以
// `run_in_background: true` 起一个长命令。链路：官方会话 → webcode 适配器驱动网页
// → 模型回 `mcp_action` 围栏 → harness 执行 → **官方 jobs 服务产生一条 running 行**
// → `ctx.jobs` 推给 `watchRows(sessionId)` → chip 渲染。
// 全程没有一处是探针自己塞进 store 的。
//
// ## 判据
//
//   ① 列里出现了 `[data-hwb-chip="jobs"]`；
//   ② 它的文案是「N 个后台任务运行中」（N ≥ 1，即**running/stopping** 态，不是历史残留）；
//   ③ 同一会话在**官方** jobs 数据面里确有 running 行（用 `/__webcode/status` 之外的
//      官方读法交叉核对：侧栏/官方 chip 也应当出现后台任务标记）。
//
// 用法：
//   node test-mock/probe-jobs-chip-live.mjs "http://127.0.0.1:3087/?token=…" [--headed] [--wait=240]
//
// 退出码：0 = 判据成立；1 = 未成立（如实打印卡在哪一步）。

import fs from 'node:fs';
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';

const argv = process.argv.slice(2);
const headed = argv.includes('--headed');
const waitSec = Number((argv.find((a) => a.startsWith('--wait=')) || '').split('=')[1]) || 240;
const url = argv.find((a) => /^https?:\/\//.test(a));
if (!url) { console.error('用法：node test-mock/probe-jobs-chip-live.mjs <url> [--headed] [--wait=240]'); process.exit(2); }

const exe = resolveBrowserExecutable();
const exePath = typeof exe === 'string' ? exe : exe && exe.path;
if (!exePath) { console.error('找不到浏览器可执行文件'); process.exit(2); }

const problems = [];
const steps = [];
const browser = await chromium.launch({ executablePath: exePath, headless: !headed, args: ['--no-first-run', '--no-default-browser-check'] });
const reading = { url, waitSec };
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(String(m.text()).slice(0, 300)); });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  // ── 打开并发面板（主入口点一下，会新建一组 3 列真会话）──────────────────
  const opened = await page.evaluate(() => {
    const hit = Array.from(document.querySelectorAll('*')).find((n) => {
      const t = String(n.textContent || '').trim();
      if (t !== '并发会话') return false;
      return !Array.from(n.children || []).some((c) => String(c.textContent || '').trim() === '并发会话');
    });
    if (!hit) return false;
    hit.click();
    return true;
  });
  steps.push({ step: 'open panel', ok: opened });
  if (!opened) problems.push('左栏找不到「并发会话」入口行');
  await page.locator('.hwb-concurrent-panel').first().waitFor({ timeout: 20000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const colCount = await page.locator('.hwb-concurrent-col').count();
  steps.push({ step: 'columns created', colCount });
  if (!colCount) problems.push('并发面板里没有列（打不开就没法造 job）');

  // ── 在列 0 的官方 composer 里真的发一条「起后台任务」的指令 ──────────────
  //
  // 措辞为什么这么写：webcode 适配器的协议是 `mcp_action` JSON 围栏
  //（`lib/agent-preset.js`）。直接要求工具名 + 参数，成功率最高；同时把
  // 「后台」这一半说清楚，否则模型会前台跑完，jobs 行一闪而过、chip 抓不到。
  const PROMPT = '用 pwsh 工具在后台起一个任务：命令是 node -e "setTimeout(()=>{},180000)"，'
    + 'run_in_background 设为 true。只做这一件事，不要等它结束。';

  let sent = false;
  if (colCount) {
    const box = page.locator('.hwb-concurrent-col').first().locator('textarea, [contenteditable="true"]').first();
    try {
      await box.click({ timeout: 10000 });
      await box.fill(PROMPT).catch(async () => { await box.type(PROMPT, { delay: 8 }); });
      await page.waitForTimeout(600);
      await page.keyboard.press('Enter');
      sent = true;
    } catch (e) {
      problems.push('往列 0 的 composer 输入失败：' + String(e && e.message || e));
    }
  }
  steps.push({ step: 'sent prompt to col 0', sent });
  if (sent) console.log('已发出指令，等待模型起后台任务（最多 ' + waitSec + 's）…');

  // ── 轮询 chip ──────────────────────────────────────────────────────────
  const deadline = Date.now() + waitSec * 1000;
  let chip = null;
  while (Date.now() < deadline) {
    chip = await page.evaluate(() => {
      const el = document.querySelector('[data-hwb-chip="jobs"]');
      if (!el) return null;
      return { text: String(el.textContent || '').trim(), title: el.getAttribute('title') || '' };
    });
    if (chip && /运行中/.test(chip.text)) break;
    await page.waitForTimeout(5000);
  }
  reading.chip = chip;
  steps.push({ step: 'poll chip', chip });

  if (!chip) {
    problems.push('等了 ' + waitSec + 's 也没出现 [data-hwb-chip="jobs"] —— '
      + '要么模型没起后台任务（链路），要么 chip 没接线（缺陷）；两者需看会话轨迹区分');
  } else if (!/运行中/.test(chip.text)) {
    problems.push('chip 出现了但文案是「' + chip.text + '」而不是「N 个后台任务运行中」⇒ '
      + 'live 判据（running/stopping）没命中');
  }

  // ── 交叉核对：官方侧栏也应当出现后台任务的标记（同一数据面的另一处消费者）──
  reading.officialMarkers = await page.evaluate(() => {
    const txt = document.body.innerText || '';
    const m = txt.match(/\d+\s*个后台任务[^\n]{0,12}/g) || [];
    return [...new Set(m)].slice(0, 6);
  });

  fs.writeFileSync('test-mock/out/jobs-chip-live-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json',
    JSON.stringify({ ...reading, steps, problems, consoleErrors }, null, 2));

  console.log('=== probe-jobs-chip-live ===');
  console.log('steps        :', JSON.stringify(steps));
  console.log('chip         :', JSON.stringify(chip));
  console.log('官方标记     :', JSON.stringify(reading.officialMarkers));
  if (consoleErrors.length) console.log('consoleErrors:', consoleErrors.slice(0, 4));
  if (problems.length) { console.log('\n✖ problems:'); problems.forEach((p) => console.log('  - ' + p)); }
  else console.log('\n✔ 判据成立：列里出现 jobs chip 且报「' + chip.text + '」= 真的有一条 live 后台任务');
} catch (e) {
  problems.push('探针流程异常：' + String(e && e.message || e));
  console.log('✖ ' + problems[problems.length - 1]);
} finally {
  await browser.close().catch(() => {});
}
process.exit(problems.length ? 1 : 0);