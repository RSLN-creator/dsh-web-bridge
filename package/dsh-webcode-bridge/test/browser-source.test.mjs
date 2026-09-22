// browser-source.test.mjs — 浏览器来源护栏（0.18.0）。
//
// 用户要求（2026-09-22）：「直接复制过来 chrom 核做到只用下载本插件就能实现」
// 「尽量对应本插件外的少干扰少依赖，确保人人下载安装可用本插件所有功能」。
//
// 兑现方式不是把 426.7 MB 的 Chromium 塞进 npm 包（543 KB 的 tarball 会变成 400 MB+），
// 而是优先用 playwright-core 自带的 Chromium：它随依赖装到本机，profile 完全由桥自持，
// 与用户日常浏览器零交叉 —— 这也解掉「探针说没登录、用户说登了」的长期错位。
//
// 钉住三条：
//   1. status() 透出 executablePath 与 browserSource（「用的哪个浏览器」可核对）；
//   2. 自带 Chromium 在场时必须选它，而不是系统浏览器（顺序即承诺）；
//   3. 孤儿进程清理**不得写死浏览器进程名**（真回归，见下）。
//
// ## 第 3 条防的是哪一次真缺陷（不是洁癖）
//
// `killOrphanEdgeForProfile` 原先用 WMI 过滤 `Name='msedge.exe'`。浏览器来源改成
// 「自带 Chromium 优先」之后，实际跑的是 `chrome.exe`，于是这个过滤器**一个都匹配不到**：
// 孤儿浏览器继续持有 profile 单实例锁 → 下一次 launch 报 ProcessSingleton/SingletonLock
// → 而自愈路径（`clearStaleProfileLocks` 的 EPERM 分支）恰好也依赖这个函数，
// 两条路一起失效。判据因此是「按 cfg.executablePath 取进程名」，不是写死某一家。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBrowserDriver } from '../lib/browser-driver.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** 每个用例一个独立 profile 目录，跑完删掉。 */
function tempProfile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hwb-browsersrc-'));
}

/** 本机真的下载了 playwright 自带的 Chromium 吗。 */
function hasBundledChromium() {
  const roots = [
    process.env.PLAYWRIGHT_BROWSERS_PATH || '',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ms-playwright') : '',
    process.env.HOME ? path.join(process.env.HOME, '.cache', 'ms-playwright') : '',
  ].filter(Boolean);
  for (const root of roots) {
    let entries;
    try { entries = fs.readdirSync(root); } catch { continue; }
    if (entries.some((n) => /^chromium-\d+$/.test(n))) return true;
  }
  return false;
}

test('★ 0.18.0 浏览器来源：自带 Chromium 优先，且来源可核对', () => {
  const dir = tempProfile();
  try {
    const d = createBrowserDriver({ siteId: 'glm', profileDir: dir });
    const s = d.status();

    assert.ok('executablePath' in s, 'status 必须透出 executablePath —— 否则「用的哪个浏览器」无从核对');
    assert.ok('browserSource' in s, 'status 必须透出 browserSource');
    assert.ok(
      s.browserSource === 'bundled' || s.browserSource === 'system' || s.browserSource === null,
      'browserSource 只许这三个取值，实际=' + JSON.stringify(s.browserSource),
    );

    if (s.browserSource === 'bundled') {
      assert.match(String(s.executablePath), /[\\/]ms-playwright[\\/]/,
        'bundled 的来源路径必须落在 ms-playwright 下');
    }

    // 本机若确实有自带 Chromium，就必须选它 —— 这是「零外部依赖」的核心断言。
    if (hasBundledChromium()) {
      assert.equal(s.browserSource, 'bundled',
        '自带 Chromium 在场时必须优先用它，而不是系统 Edge/Chrome（顺序即承诺）');
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// 源码结构断言：语义在这里是对的、形状是错的（与 upload-attachment-structure 同一条纪律）。
test('★ 0.18.0 孤儿清理按实际浏览器取进程名，不得写死 msedge', () => {
  const src = fs.readFileSync(path.join(here, '..', 'lib', 'browser-driver.js'), 'utf8');

  assert.ok(src.includes('function killOrphanEdgeForProfile'), '孤儿清理函数必须还在（改名则本护栏失效，需同步）');

  // 写死的具体形态：WMI 过滤器里直接出现某个浏览器可执行名。
  assert.doesNotMatch(src, /Get-CimInstance\s+Win32_Process\s+-Filter\s+"Name='msedge\.exe'"/,
    'WMI 过滤器不得写死 msedge.exe —— 自带 Chromium 的进程名是 chrome.exe，写死会一个都匹配不到');

  // 必须从 cfg.executablePath 派生进程名（正判据：不只看「没写死」，还看「有没有取对」）。
  assert.match(src, /path\.basename\(\s*String\(\s*cfg\.executablePath/,
    '必须按 cfg.executablePath 取进程名，而不是假定某一家浏览器');
});

// 「人人下载安装可用」的兑现：缺浏览器时要能查状态、能触发安装。
//
// 用户要求原文：「尽量对应本插件外的少干扰少依赖，确保人人下载安装可用本插件所有功能」。
// 426.7 MB 的 Chromium 打不进 npm 包，所以走「自带优先 + 缺时下载」；
// 这条钉住那两个入口真的存在且形状正确（行为由控制面路由测试覆盖）。
test('★ 0.18.0 浏览器能力可查询、可安装（「下载插件即可用」的入口）', async () => {
  // 查询入口：必须是纯函数式的、不启动浏览器的读数。
  const { resolveBrowserExecutable } = await import('../lib/browser-runtime.js');
  const r = resolveBrowserExecutable();
  assert.ok('path' in r && 'source' in r, 'resolveBrowserExecutable 必须返回 {path, source}');
  assert.ok(
    r.source === 'bundled' || r.source === 'system' || r.source === null,
    'source 只许这三个取值，实际=' + JSON.stringify(r.source),
  );
  if (r.path) assert.ok(fs.existsSync(r.path), '返回的路径必须真的存在（不许报一个已消失的文件）');
  if (r.source === 'bundled') assert.equal(typeof r.revision, 'number', 'bundled 必须带 revision');

  // 控制面两个入口必须在。
  const src = fs.readFileSync(path.join(here, '..', 'lib', 'web-control.js'), 'utf8');
  assert.match(src, /'GET browser-runtime'/, '必须有 GET browser-runtime —— 用户要能核对用哪个浏览器');
  assert.match(src, /'POST browser-install'/, '必须有 POST browser-install —— 缺浏览器时要能一键下载');
  // 安装必须先查「是不是已经有了」，有就不重复下载。
  assert.match(src, /const existing = resolveBrowserExecutable\(\);[\s\S]{0,220}?if \(existing\.path\)/,
    '安装前必须先查已有浏览器，有就直接返回（不重复下载 150 MB）');
});

// 「下载插件即可用」的**真正**兑现点（0.18.0 第三轮补）。
//
// 前一条只钉住「面板上有两个入口」。但设置页的按钮是**可选加速入口**，不是唯一入口：
// 新用户第一次点「连接 / 登录」走的是 launch —— 那一刻若只抛一句「请手动执行 CLI 命令」，
// 他看到的仍然是「插件不能用」，与「下载即可用」直接矛盾。
//
// 真机事实（2026-09-22）：本机 `ms-playwright` 里同时存在 chromium-1217 与 1232，
// 自带那份**在场**，所以这条路径平时不被触发 —— 也就更容易在回归里被悄悄删掉。
// 因此用源码结构断言钉住：launch 必须先 `await ensureExecutable()`，
// 且那个函数在缺浏览器时**真的调用了** installBundledChromium。
test('★ 0.18.0 launch 必须自带补齐：缺浏览器时自动下载，而不是抛「请手动执行命令」', () => {
  const src = fs.readFileSync(path.join(here, '..', 'lib', 'browser-driver.js'), 'utf8');

  // ① 自动安装函数存在，且真的调 installBundledChromium。
  assert.ok(src.includes('async function ensureExecutable()'),
    '必须有 ensureExecutable() —— 「下载即可用」的落点');
  assert.match(src, /installBundledChromium\(\{[\s\S]{0,80}?timeoutMs/,
    'ensureExecutable 必须真的调用 installBundledChromium（而不只是报错）');

  // ② launch 必须先补齐再启动。
  const launchIdx = src.indexOf('async function launch({ headless } = {}) {');
  assert.ok(launchIdx > 0, 'launch 定义必须还在（改名则本护栏失效，需同步）');
  const afterLaunch = src.slice(launchIdx, launchIdx + 400);
  assert.match(afterLaunch, /await ensureExecutable\(\);/,
    'launch 第一件事必须是 await ensureExecutable() —— 否则新用户缺浏览器时拿到的仍是「插件不能用」');

  // ③ 旧的「请手动执行 CLI 命令」不得再作为 launch 的**唯一**出路。
  //    允许它作为下载失败后的补充指引，但不许出现在 ensureExecutable 之前的抛错里。
  const beforeEnsure = src.slice(0, src.indexOf('async function ensureExecutable()'));
  assert.doesNotMatch(beforeEnsure, /throw new Error\('未找到可用的 Chromium：自带的那份没有下载/,
    '不得保留「让用户自己去敲 CLI」的旧抛错 —— 那正是本条要修掉的体验');

  // ④ 并发保护：同一次下载在进程内复用。
  assert.match(src, /let autoInstallPromise = null;/,
    '自动下载必须有进程内复用，避免两个面板同时触发下两份、写坏同一个目录');
});
