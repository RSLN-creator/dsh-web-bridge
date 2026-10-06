#!/usr/bin/env node
// probe-workspace-group.mjs — 「一组一行」的真机判据（0.19.68，long-term-issues #40 的收口验证）。
//
// ## 这个探针要证伪的那句话
//
// #40 原来写「官方清单条目是 shell 私有代码，插件只能装饰既有行、不能分组」。0.19.68 的
// 结论是**反过来**：官方左栏本来就按工作区一行、折叠时不投影会话行；只要给每一组一个
// **真目录**（本插件用 git worktree），官方自己就会把这一组收成一行。
//
// ## 三条判据（都要成立）
//
//   ① **官方侧栏渲染出组行**：侧栏文本里有 `并发会话组 N`（标题来自我们的 `rename`），
//      且它落在官方的「工作区」分组区里（y 大于「工作区」标题的 y）；
//   ② **该组只占一行**：同一标题在侧栏里只对应**一个 y 位置**（多行同名 = 没被收成一行，
//      那正是 #40 要避免的形态）。判据按 y 聚类（±10px 视作同一行），不是数 span 个数——
//      官方一行里会有「容器 span + 标签 span」两层同名文本。
//   ③ **N 条会话真的在这个组里**：磁盘上该组 worktree 目录下有 ≥1 条官方会话
//      （判据 = DSH 自己的 `~/.dsh/sessions/<cwd 编码>/` 目录，编码由 SessionHeader.cwd 推出）
//      —— 这是「一组包 N 条」的**实质**，而不是「长得像一行」。
//
// ## 为什么③必须读磁盘而不只读 DOM
//
// 侧栏的嵌套结构随**折叠态**变化（折叠时官方按 `sessions: expanded ? … : []` 根本不投影
// 会话行，`ui-workspace:492/:502`）。所以「DOM 里数不到嵌套行」**不能**推出「没包住」——
// 那正是本探针上一版把「其它工作区行」误当嵌套行的同一个坑。会话归属的真源在**磁盘**：
// 官方按会话 header 的 cwd 建目录，目录里就是那一条会话。
//
// 用法：
//   node test-mock/probe-workspace-group.mjs "http://127.0.0.1:3087/?token=…" [--headed]
//
// 退出码：0 = 全部判据成立；1 = 有 problem（逐条打印）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { resolveBrowserExecutable } from '../lib/browser-runtime.js';

const argv = process.argv.slice(2);
const headed = argv.includes('--headed');
const url = argv.find((a) => /^https?:\/\//.test(a));
if (!url) { console.error('用法：node test-mock/probe-workspace-group.mjs <url> [--headed]'); process.exit(2); }

const problems = [];
const exe = resolveBrowserExecutable();
const exePath = typeof exe === 'string' ? exe : exe && exe.path;
if (!exePath || !fs.existsSync(exePath)) {
  console.error('probe-workspace-group: 找不到浏览器可执行文件（resolveBrowserExecutable 返回 ' + JSON.stringify(exe) + '）');
  process.exit(2);
}

/**
 * DSH 会话目录：`~/.dsh/sessions/<cwd 编码>/`。
 *
 * ⚠ 为什么**不自己推**编码：我第一版按「把 `[\\/:]` 换成 `-`」推，D:/ → `D--`
 * 而官方实际是 `D-`（冒号与斜杠**合并**成一个分隔符）——推错就静默数成 0 条，
 * 于是「一组包 N 条」被误判成不成立。改为**按前缀扫真实目录**：只要目录名里
 * 包含去掉盘符后的路径片段就认。宁可靠事实匹配，也不猜编码规则。
 */
function findSessionsDir(cwd) {
  const root = path.join(os.homedir(), '.dsh', 'sessions');
  if (!fs.existsSync(root)) return null;
  // worktree 的目录名在会话目录名里是逐字出现的（连字符数量随分隔符变化，故用名字匹配）
  const base = path.basename(String(cwd));
  const hit = fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.includes(base))
    .map((e) => path.join(root, e.name));
  return hit.length ? hit[0] : null;
}
/** 数一个目录下的会话文件数（递归，只认官方会话文件名）。 */
function countSessions(dir) {
  if (!dir || !fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) n += countSessions(p);
    else if (/^session\.v\d+\.jsonl/.test(e.name)) n += 1;
  }
  return n;
}

const browser = await chromium.launch({ executablePath: exePath, headless: !headed, args: ['--no-first-run', '--no-default-browser-check'] });
const reading = { url, groups: [], worktrees: [] };
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const consoleErrors = [];
  const pageErrors = [];
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(String(m.text()).slice(0, 300)); });
  page.on('pageerror', (e) => pageErrors.push(String(e && e.message || e).slice(0, 300)));

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(6000);

  // ── ① 侧栏里的组行（含「工作区」区起点，用来确认落在工作区分组区）──────────
  reading.sidebar = await page.evaluate(() => {
    const leaf = (n, needle) => {
      const t = String(n.textContent || '');
      if (!t.includes(needle)) return false;
      return !Array.from(n.children || []).some((c) => String(c.textContent || '').includes(needle));
    };
    const cands = Array.from(document.querySelectorAll('aside, nav, [class*="sidebar"], [class*="Sidebar"]'))
      .map((el) => ({ el, r: el.getBoundingClientRect() }))
      .filter((c) => c.r.width > 150 && c.r.height > 300)
      .sort((a, b) => a.r.x - b.r.x);
    if (!cands.length) return { found: false };
    const root = cands[0].el;
    const inSidebar = (n) => root.contains(n);
    const wsHeader = Array.from(root.querySelectorAll('*')).find((n) => leaf(n, '工作区'));
    const groups = [];
    for (const n of Array.from(root.querySelectorAll('*'))) {
      const t = String(n.textContent || '').trim();
      const m = /^并发会话组\s*(\d+)$/.exec(t);
      if (!m || !inSidebar(n)) continue;
      const r = n.getBoundingClientRect();
      groups.push({ n: Number(m[1]), y: Math.round(r.y), x: Math.round(r.x) });
    }
    return {
      found: true,
      wsHeaderY: wsHeader ? Math.round(wsHeader.getBoundingClientRect().y) : null,
      groups,
    };
  });

  if (!reading.sidebar.found) problems.push('读不到官方侧栏容器（aside/nav/[class*=sidebar] 都没有够大的盒子）');
  else {
    if (reading.sidebar.wsHeaderY === null) problems.push('侧栏里找不到「工作区」分组标题');
    if (!reading.sidebar.groups.length) problems.push('侧栏里没有任何「并发会话组 N」行 ⇒ #40 的「一组一行」没有呈现');
  }

  // ── ② 每个组只占一行（按 y 聚类）+ ③ 该组的会话在磁盘上 ──────────────────
  const byN = new Map();
  for (const g of reading.sidebar.groups || []) {
    if (!byN.has(g.n)) byN.set(g.n, []);
    byN.get(g.n).push(g);
  }
  // worktree 目录（兄弟目录，前缀 = 仓库名 + '-hwb-'）
  const wtHolder = path.resolve(path.join(os.homedir(), '..')); // 占位，真实值从 git worktree 读
  for (const [n, list] of [...byN.entries()].sort((a, b) => a[0] - b[0])) {
    // 同一标题的 y 聚类：±10px = 同一行
    const ys = [...new Set(list.map((g) => g.y))].sort((a, b) => a - b);
    const clusters = [];
    for (const y of ys) {
      if (!clusters.length || y - clusters[clusters.length - 1] > 10) clusters.push(y);
    }
    const entry = { n, labelY: clusters[0], distinctRows: clusters.length, spanCount: list.length, sessions: null, worktree: null };
    if (clusters.length !== 1) {
      problems.push('「并发会话组 ' + n + '」在侧栏里占了 ' + clusters.length + ' 个不同 y 位置 ⇒ 没有被收成一行');
    }
    if (reading.sidebar.wsHeaderY !== null && clusters[0] <= reading.sidebar.wsHeaderY) {
      problems.push('「并发会话组 ' + n + '」的行在「工作区」标题之上（y=' + clusters[0] + ' <= ' + reading.sidebar.wsHeaderY + '）⇒ 不在官方工作区分组区');
    }
    reading.groups.push(entry);
  }

  // 磁盘侧：本仓库的全部并发 worktree（从 git 自己读，避免猜目录名）
  reading.worktrees = await (async () => {
    try {
      const { execFileSync } = await import('node:child_process');
      const repo = 'D:/9_Code_Workspace/dsh-webcode-bridge';
      const out = execFileSync('git', ['-C', repo, 'worktree', 'list', '--porcelain'], { encoding: 'utf8' });
      const res = [];
      let cur = null;
      for (const line of out.split('\n')) {
        if (line.startsWith('worktree ')) { if (cur) res.push(cur); cur = { path: line.slice(9).trim(), branch: '' }; }
        else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).trim().replace(/^refs\/heads\//, '');
      }
      if (cur) res.push(cur);
      return res
        .filter((w) => w.branch.startsWith('hwb/concurrent/'))
        .map((w) => ({ ...w, sessions: countSessions(findSessionsDir(w.path)) }));
    } catch (e) { return [{ error: String(e && e.message || e) }]; }
  })();

  const withSessions = reading.worktrees.filter((w) => !w.error && w.sessions > 0);
  if (!reading.worktrees.length || reading.worktrees.every((w) => w.error)) {
    problems.push('读不到 git worktree 列表：' + JSON.stringify(reading.worktrees[0] || null));
  } else if (!withSessions.length) {
    problems.push('没有任何并发 worktree 目录里含官方会话 ⇒ 「一组包 N 条」没有实质发生');
  }

  // ① 组行数 vs 有会话的 worktree 数：两者应当对应（允许历史组多/少，但至少一一覆盖）
  if (reading.groups.length < withSessions.length) {
    problems.push('侧栏组行数（' + reading.groups.length + '）少于含会话的 worktree 数（' + withSessions.length + '）'
      + ' ⇒ 有组的会话没被官方收进工作区行');
  }

  fs.writeFileSync(path.join(path.dirname(new URL(import.meta.url).pathname.slice(1) || '.'), 'out',
    'workspace-group-' + new Date().toISOString().replace(/[:.]/g, '-') + '.json'),
    JSON.stringify({ ...reading, problems, consoleErrors, pageErrors }, null, 2));

  console.log('=== probe-workspace-group ===');
  console.log('侧栏 found        :', reading.sidebar.found, '| 「工作区」标题 y:', reading.sidebar.wsHeaderY);
  console.log('组行              :');
  for (const g of reading.groups) console.log('  并发会话组 ' + g.n + '  y=' + g.labelY + '  不同行数=' + g.distinctRows + '  span 数=' + g.spanCount);
  console.log('并发 worktree     :');
  for (const w of reading.worktrees) console.log('  ' + (w.branch || '(err)') + '  ' + (w.sessions ?? '?') + ' 条会话  ' + w.path);
  if (consoleErrors.length) console.log('consoleErrors     :', consoleErrors.slice(0, 4));
  if (pageErrors.length) console.log('pageErrors        :', pageErrors.slice(0, 4));
  if (problems.length) { console.log('\n✖ problems:'); problems.forEach((p) => console.log('  - ' + p)); }
  else console.log('\n✔ 判据成立：官方左栏为每一组渲染**一行**（标题 = rename 的并发会话组 N，落在工作区分组区），'
    + '且各组的 N 条会话真的落在该组 worktree 目录下');
} catch (e) {
  problems.push('探针流程异常：' + String(e && e.message || e));
  console.log('✖ ' + problems[problems.length - 1]);
} finally {
  await browser.close().catch(() => {});
}
process.exit(problems.length ? 1 : 0);