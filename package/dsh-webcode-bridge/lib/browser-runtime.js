// browser-runtime.js — 「用哪个浏览器」与「没装时怎么装」（0.18.0）。
//
// ## 为什么单独成模块
//
// 用户要求（2026-09-22）：「直接复制过来 chrom 核做到只用下载本插件就能实现」
// 「尽量对应本插件外的少干扰少依赖，确保人人下载安装可用本插件所有功能」。
//
// 把 426.7 MB 的 Chromium 打进 npm 包不现实（当前 tarball 543 KB，会变成 400 MB+）。
// 可行的兑现方式是：**优先用 playwright-core 自带的 Chromium**（它随依赖装到本机），
// 缺了就让宿主把它下下来。这需要两件事分居两处仍然口径一致：
//
//   · `browser-driver.js` 启动前要**解析**可执行文件（决定用哪一份）；
//   · `web-control.js` 要能给面板报状态、并在缺的时候**触发安装**。
//
// 两边各写一份扫描逻辑迟早漂移（本仓库记过多次「两份实现各说一套」的事故），
// 因此统一到这里，只此一份。
//
// ## 为什么必须自己扫目录，不能信 `chromium.executablePath()`
//
// 真机实测（2026-09-22）：`chromium.executablePath()` 返回
// `ms-playwright/chromium-1243/chrome-win64/chrome.exe`，而 **1243 根本不存在**
// （`exists:false`）。那是 playwright-core 的 `browsers.json` 声明的**期望版本**，
// 与磁盘实际下载到的版本（本机为 1217 / 1232）可以不一致。直接采信它的返回值
// 等于把「版本漂移」伪装成「浏览器没装」——排查方向会被完全带偏。

import fs from 'node:fs';
import path from 'node:path';
import child_process from 'node:child_process';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** ms-playwright 的候选根目录（按平台）。环境变量优先。 */
function browserRoots() {
  const home = process.env.USERPROFILE || process.env.HOME || '';
  const localAppData = process.env.LOCALAPPDATA || '';
  return [
    process.env.PLAYWRIGHT_BROWSERS_PATH || '',
    localAppData ? path.join(localAppData, 'ms-playwright') : '',
    home ? path.join(home, 'Library', 'Caches', 'ms-playwright') : '',   // macOS
    home ? path.join(home, '.cache', 'ms-playwright') : '',               // Linux
  ].filter(Boolean);
}

/** 每个平台下可执行文件的相对位置（与 playwright 的目录布局逐字一致）。 */
const EXE_RELS = [
  ['chrome-win64', 'chrome.exe'],
  ['chrome-win', 'chrome.exe'],
  ['chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ['chrome-mac-arm64', 'Chromium.app', 'Contents', 'MacOS', 'Chromium'],
  ['chrome-linux', 'chrome'],
];

/**
 * 已下载的 playwright 自带 Chromium（按 revision **降序**取第一个真存在的）。
 *
 * 为什么降序：与 playwright 自身的查找语义一致（用最新的那份）。
 * 为什么排除 `chromium_headless_shell-*`：那是无头 shell，跑不了需要完整渲染与
 * 登录交互的站点页面——而登录正是本插件的核心动作。
 *
 * @returns {{path: string, revision: number}|null}
 */
export function findBundledChromium() {
  for (const root of browserRoots()) {
    let entries;
    try { entries = fs.readdirSync(root); } catch { continue; }
    const builds = entries
      .map((name) => {
        const m = /^chromium-(\d+)$/.exec(name);
        return m ? { name, rev: Number(m[1]) } : null;
      })
      .filter(Boolean)
      .sort((a, b) => b.rev - a.rev);

    for (const b of builds) {
      for (const rel of EXE_RELS) {
        const exe = path.join(root, b.name, ...rel);
        try { if (fs.existsSync(exe)) return { path: exe, revision: b.rev }; } catch { /* 权限/竞态：换下一个 */ }
      }
    }
  }
  return null;
}

/**
 * 系统已安装的 Chromium 系浏览器（兜底）。
 *
 * 保留这条兜底的理由：用户机器上可能已经有 Edge/Chrome，没必要强制再下一份；
 * 而自带那份缺失时它能让插件**当场可用**，而不是先报错。
 *
 * @returns {string|null}
 */
export function findSystemChromium() {
  const localAppData = process.env.LOCALAPPDATA || '';
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const candidates = [
    path.join(programFiles, 'Microsoft\\Edge\\Application\\msedge.exe'),
    path.join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe'),
    localAppData ? path.join(localAppData, 'Microsoft\\Edge\\Application\\msedge.exe') : '',
    path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
    path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
    localAppData ? path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe') : '',
    path.join(programFiles, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
    localAppData ? path.join(localAppData, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe') : '',
    path.join(programFiles, 'Chromium\\Application\\chrome.exe'),
    localAppData ? path.join(localAppData, 'Vivaldi\\Application\\vivaldi.exe') : '',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/brave-browser',
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.existsSync(c)) return c; } catch { /* 权限：换下一个 */ }
  }
  return null;
}

/**
 * 默认浏览器：**自带优先，系统兜底**。
 *
 * 顺序即承诺：自带那份是插件能保证存在与版本可控的一份，系统浏览器是
 * 「用户碰巧装了」的运气。让可控的来源优先，才兑现「下载插件即可用」。
 *
 * @returns {{path: string|null, source: 'bundled'|'system'|null, revision: number|null}}
 */
export function resolveBrowserExecutable() {
  const bundled = findBundledChromium();
  if (bundled) return { path: bundled.path, source: 'bundled', revision: bundled.revision };
  const system = findSystemChromium();
  if (system) return { path: system, source: 'system', revision: null };
  return { path: null, source: null, revision: null };
}

/**
 * 这个可执行文件是不是 playwright 自带的那份。
 *
 * 判据只看路径里有没有 `ms-playwright` 这一段，不做 IO：`/__webcode/status`
 * 每次都调它，必须廉价且不抛错。
 *
 * @param {string|null} exe
 * @returns {boolean}
 */
export function isBundledChromiumPath(exe) {
  return /[\\/]ms-playwright[\\/]/.test(String(exe || ''));
}

/**
 * playwright-core 的 CLI 路径。
 *
 * 用 `require.resolve` 而不是拼 `node_modules` 路径：包管理器可能把
 * playwright-core 提升（hoist）到上层，写死相对路径在真实安装里会找不到。
 *
 * @returns {string|null}
 */
export function playwrightCliPath() {
  try {
    return require.resolve('playwright-core/cli.js');
  } catch {
    try {
      // 兜底：从包根解析（某些打包形态不暴露 exports 子路径）。
      const pkg = require.resolve('playwright-core/package.json');
      return path.join(path.dirname(pkg), 'cli.js');
    } catch { return null; }
  }
}

/**
 * 下载 playwright 自带的 Chromium。
 *
 * **这是「下载本插件即可用」的兑现动作**：新用户装完插件、`ms-playwright` 还是空的
 * 时候，由它把浏览器拉下来。已经有任何一份可用浏览器时**不需要**调用它。
 *
 * 只装 chromium，不装 ffmpeg / headless-shell / winldd：后者对本插件的用途
 * （登录 + 页面交互 + SSE 捕获）都不是必需的，少装就少下载。
 *
 * @param {{timeoutMs?: number}} [opts]
 * @returns {Promise<{ok: boolean, code: string|null, output: string, cli: string|null}>}
 */
export async function installBundledChromium(opts = {}) {
  const cli = playwrightCliPath();
  if (!cli) return { ok: false, code: 'no-playwright-cli', output: '找不到 playwright-core 的 cli.js', cli: null };

  const timeout = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 10 * 60_000;
  return await new Promise((resolve) => {
    let out = '';
    let done = false;
    const finish = (r) => { if (!done) { done = true; resolve(r); } };
    let child;
    try {
      child = child_process.spawn(process.execPath, [cli, 'install', 'chromium'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      return finish({ ok: false, code: 'spawn-failed', output: String(e?.message || e).slice(0, 300), cli });
    }
    const cap = (b) => { out += String(b); if (out.length > 40_000) out = out.slice(-40_000); };
    child.stdout?.on('data', cap);
    child.stderr?.on('data', cap);
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish({ ok: false, code: 'timeout', output: out.slice(-2000), cli });
    }, timeout);
    child.on('error', (e) => { clearTimeout(timer); finish({ ok: false, code: 'spawn-error', output: String(e?.message || e).slice(0, 300), cli }); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // 退出码为 0 还不够：必须**复查磁盘**上真的出现了可执行文件。
      // 「命令说成功但文件不在」是本仓库记过的那类假成功，不能只信退出码。
      const found = findBundledChromium();
      if (code === 0 && found) return finish({ ok: true, code: null, output: out.slice(-2000), cli });
      finish({ ok: false, code: code === 0 ? 'installed-but-not-found' : `exit-${code}`, output: out.slice(-2000), cli });
    });
  });
}
