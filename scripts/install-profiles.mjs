#!/usr/bin/env node
// install-profiles.mjs — 把已打包的 tarball 装进 DSH 的 web / headless 两个 profile。
//
// 为什么不用 `pnpm install`（真实踩坑，两条都要记住）：
//
//   1. 本机 `pnpm install` 曾因一个**无关依赖**（走 GitHub release tarball 的包）报
//      `UNABLE_TO_VERIFY_LEAF_SIGNATURE` → `fetch failed`，整体失败。它和本插件毫无
//      关系，但足以让安装根本跑不起来。
//      **这条是通用教训，不是某个包的问题**：只要依赖树里还有任何一个包从 GitHub
//      tarball 拉，同一条路径就会再踩一次。可用的绕过是让 Node 用系统证书库
//      （`$env:NODE_OPTIONS='--use-system-ca'`，Node 24+），见 doc/verify.md。
//   2. 即使绕过第 1 条，pnpm 对**同版本号**的 tarball 会判「Already up to date」，
//      连解包都不做 —— 0.14.4 就这样装上去过一份陈旧副本（改了 mirror.js 但装的
//      是旧文件），且不报任何错。
//
// 因此这里做一件很笨但确定的事：**先删旧目录，再解包**。没有缓存、没有版本比对，
// 目录里的内容就是 tarball 里的内容。装完顺手打印版本与关键文件的存在性，
// 让「装上了什么」当场可核对。
//
// ⚠ 不 spawn 系统 `tar`：DSH 文件沙箱会拦下子进程 spawn（`EPERM: spawnSync tar`，
//   真机 2026-09-14 实测）。解档走 scripts/tar.mjs 的纯 Node 实现。
//
// 用法：
//   node scripts/install-profiles.mjs                  # 用 package/ 下最新 tarball
//   node scripts/install-profiles.mjs <tarball>
//   node scripts/install-profiles.mjs --profiles web   # 只装一个 profile
//
// 退出码：0 = 两个 profile 都装好且核对通过；1 = 任一步失败。
//
// ⚠ 装完不会自动生效：DSH 进程里已经加载的是旧代码，需要重启 DSH 才会加载新版本。
//
// ⚠⚠ **本脚本绕开 pnpm，因此它的装载不持久**（2026-09-18 真机确证，第三次踩同一族坑）。
//   它只写 `node_modules`，**不改 profile 的声明**（`package.json` / `pnpm-lock.yaml` /
//   `node_modules/.modules.yaml`）。若声明仍钉在旧 tarball 上，任何一次 pnpm 通道
//   （`dsh plugin`、dshmarket 装插件、启动期 reconcile）都会按 lockfile 重建
//   `node_modules`，把这里装好的版本**静默回退**成声明里那个版本。
//   真机现场：22:16:38 用本脚本装好 0.16.10，22:21:32 一趟 pnpm 把它换回 0.16.5，
//   22:21:40 启动的进程于是加载到 0.16.5 —— 用户看到的现象是「装好又变回去」，
//   而两边的读数（磁盘 vs 进程）各自都是真的。
//   因此：**要么用 `dsh plugin --profile <p> add <tgz>` 让 pnpm 自己更新声明**
//   （推荐：声明与内容一起动，重启后不会被回退），**要么在跑完本脚本后手工把声明
//   改成同一个 tarball**。判据永远是声明，不是 `node_modules` 里的文件。
//   详见 `doc/progress.md` §0.16.10 七。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTarGz } from './tar.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const PKG_NAME = 'dsh-webcode-bridge';

/** DSH home：与 lib/index.js 的口径一致（DSH_HOME 优先，否则 ~/.dsh）。 */
function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function newestTarball() {
  const pkgRoot = path.join(repoRoot, 'package');
  const rows = [];
  for (const dir of fs.readdirSync(pkgRoot, { withFileTypes: true })) {
    if (!dir.isDirectory()) continue;
    const sub = path.join(pkgRoot, dir.name);
    for (const f of fs.readdirSync(sub)) {
      if (!f.endsWith('.tgz')) continue;
      const p = path.join(sub, f);
      rows.push({ p, mtime: fs.statSync(p).mtimeMs });
    }
  }
  rows.sort((a, b) => b.mtime - a.mtime);
  return rows[0]?.p || null;
}

/**
 * 把一个 tarball 装进某个 profile 的 node_modules。
 *
 * tarball 里是 `package/…`，而目标目录名必须是 `dsh-webcode-bridge`。这里逐条
 * 写文件并把 `package/` 前缀换成包名——不 spawn、不依赖平台 tar 行为差异。
 * 写入前先整体删掉旧目录，这一步就是用来打掉 pnpm 同版本缓存行为的。
 */
function installInto(tarball, profileDir) {
  const nm = path.join(profileDir, 'node_modules');
  const target = path.join(nm, PKG_NAME);
  if (!fs.existsSync(nm)) throw new Error('profile 不存在（没有 node_modules）：' + profileDir);

  const entries = readTarGz(tarball);
  if (!entries.length) throw new Error('tarball 内没有任何文件：' + tarball);

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  let written = 0;
  for (const e of entries) {
    const rel = e.path.replace(/^package\//, '');
    // 只接受包内相对路径：任何 `..` 或绝对路径都拒绝（tarball 可能被替换过）。
    if (!rel || rel.startsWith('/') || rel.split(/[\\/]/).includes('..')) continue;
    const out = path.join(target, rel);
    if (!out.startsWith(target + path.sep)) continue;
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, e.data, { mode: e.mode || 0o644 });
    written += 1;
  }
  if (!written) throw new Error('tarball 里没有可写入的普通文件：' + tarball);
}

/**
 * 装完当场核对：版本号 + 几个「代表本轮改动」的文件是否真的在 + **跨模块接线是否真的接上**。
 *
 * 为什么核对里必须有一条「接线」：2026-09-15 真机踩坑——`lib/index.js` 里
 * `rosterOf: (sessionId) => projectRoster(ctx, sessionId)` 这行在，但顶部的
 * `import { projectRoster } from './roster.js'` 漏了。后果是：模块照样加载（箭头函数体
 * 创建时不求值）、**全量单测全绿**，只有真机 `/__webcode/status` 真的调用时才抛
 * ReferenceError，被 web-control 的 try/catch 降级成
 * `subAgentsError: "roster-threw: projectRoster is not defined"` —— 面板永久空白，
 * 而所有「文件都在」的探针都是绿的。所以这里必须在安装时就当场发现。
 */
const WIRING = [
  { need: 'projectRoster', from: './roster.js', file: 'lib/index.js' },
];

function verify(target) {
  const pkgJson = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8'));
  const probes = [
    'lib/wait-stats.js',
    'lib/cookies.js',
    'lib/client.cjs',
    'lib/browser-driver.js',
    'lib/roster.js',
  ];
  const missing = probes.filter((p) => !fs.existsSync(path.join(target, p)));
  const wiring = [];
  for (const w of WIRING) {
    const src = fs.readFileSync(path.join(target, w.file), 'utf8');
    // 只认静态 import 声明：`import { a, projectRoster } from './roster.js'`
    const re = new RegExp(
      `import\\s*\\{[^}]*\\b${w.need}\\b[^}]*\\}\\s*from\\s*['"]${w.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
    );
    if (!re.test(src)) wiring.push(`${w.need} (应从 ${w.from} 导入，在 ${w.file})`);
  }
  return { version: pkgJson.version, missing, wiring, target };
}

function main(argv) {
  const explicit = argv.find((a) => !a.startsWith('--'));
  const onlyIdx = argv.indexOf('--profiles');
  const only = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || '').split(',').filter(Boolean) : null;

  const tarball = explicit ? path.resolve(explicit) : newestTarball();
  if (!tarball || !fs.existsSync(tarball)) {
    console.error('install-profiles: 找不到 tarball（先打包，或显式传路径）');
    process.exitCode = 1;
    return;
  }
  console.log('[install-profiles] tarball: ' + tarball);

  const profilesRoot = path.join(dshHome(), 'profiles');
  let names = ['web', 'headless'];
  if (only) names = names.filter((n) => only.includes(n));

  let failed = 0;
  const results = [];
  for (const name of names) {
    const profileDir = path.join(profilesRoot, name);
    try {
      installInto(tarball, profileDir);
      const r = verify(path.join(profileDir, 'node_modules', PKG_NAME));
      results.push({ name, ...r });
      const bad = r.missing.length || r.wiring.length;
      console.log(
        (bad ? '  ⚠ ' : '  ✔ ') + `${name}: v${r.version}` +
          (r.missing.length ? `  缺少文件: ${r.missing.join(', ')}` : '') +
          (r.wiring.length ? `  ✖ 接线断裂: ${r.wiring.join('; ')}` : ''),
      );
      if (r.wiring.length) failed += 1;
    } catch (e) {
      failed += 1;
      console.error(`  ✖ ${name}: ${e?.message || e}`);
    }
  }

  console.log('');
  for (const r of results) console.log(`[install-profiles] ${r.name} -> ${r.target} (v${r.version})`);
  if (failed) {
    console.error('[install-profiles] ✖ 有 profile 安装失败');
    process.exitCode = 1;
    return;
  }
  console.log('[install-profiles] ✔ 已装入。**重启 DSH 后才会加载新版本**（当前进程里是旧代码）。');
}

main(process.argv.slice(2));
