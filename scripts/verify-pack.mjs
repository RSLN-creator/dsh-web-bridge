#!/usr/bin/env node
// verify-pack.mjs — 核对「打进 tarball 的文件」与「工作树里的文件」是否逐字节相同。
//
// 为什么需要它（真实踩坑，不是预防性工程）：
//
//   0.14.4 的发布过程中，pack 之后又改了 `lib/mirror.js`（加 cookie 短缓存），
//   但**没有重新 pack**，于是装进两个 profile 的是「旧 mirror.js + 新版本号」的
//   组合。表面上看版本号是 0.14.4、文件也在，实际跑的是半旧代码——这类问题不
//   报错，只是行为悄悄不对。
//
//   随后重装时又踩到第二个坑：pnpm 对**同版本号**的 tarball 直接判
//   「Already up to date」，连解包都不做，于是工作树改了、tarball 也重打了、
//   装上去的还是旧的。两次都靠人工核对文件内容才发现。
//
// 所以这个脚本只做一件事：读出 tarball 里每个文件的内容，逐个比 sha256，并打印
// 「N/M 逐字相同」。它不猜、不近似——哈希不同就是不同。
//
// ⚠ 不 spawn 系统 `tar`：DSH 文件沙箱会拦下子进程 spawn（`EPERM: spawnSync tar`，
//   真机 2026-09-14 实测）。发布脚本恰恰必须在这个环境里能跑，因此解档走
//   scripts/tar.mjs 的纯 Node 实现。
//
// 用法：
//   node scripts/verify-pack.mjs                       # 自动找 package/ 下最新 tarball
//   node scripts/verify-pack.mjs <tarball>             # 指定 tarball
//
// 退出码：0 = 全部相同；1 = 有差异或读取失败（差异明细打到 stderr）。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { readTarGz } from './tar.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const pkgDir = path.join(repoRoot, 'package', 'dsh-webcode-bridge');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * 必须在 tarball 里真的接上的跨模块引用。
 *
 * 每一条都对应一次真机踩坑，或者一个「漏了也不会报错、只在真机调用时才炸」的引用。
 * 加新条目时请连同「为什么漏了不报错」写进注释——否则下一个人会以为这是形式主义。
 */
const WIRING = [
  // 2026-09-15 真机：index.js 里 `rosterOf: (sessionId) => projectRoster(ctx, sessionId)`
  // 在，import 漏了。箭头函数体创建时不求值 → 模块加载成功、33/33 单测全绿，
  // 只有 /__webcode/status 真的调用才抛 ReferenceError，被 try/catch 降级成
  // subAgentsError:"roster-threw: projectRoster is not defined"，面板永久空白。
  { need: 'projectRoster', from: './roster.js', file: 'lib/index.js' },
];

/** 自动挑 package/ 下 mtime 最新的 tarball。 */
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

function main(argv) {
  const explicit = argv.find((a) => !a.startsWith('--'));
  const tarball = explicit ? path.resolve(explicit) : newestTarball();
  if (!tarball || !fs.existsSync(tarball)) {
    console.error('verify-pack: 找不到 tarball（先 npm pack 生成，或显式传路径）');
    process.exitCode = 1;
    return;
  }
  console.log('[verify-pack] tarball: ' + tarball);

  let entries;
  try {
    entries = readTarGz(tarball);
  } catch (e) {
    console.error('verify-pack: 读取 tarball 失败：' + (e?.message || e));
    process.exitCode = 1;
    return;
  }

  let same = 0;
  const missing = [];
  const differ = [];
  const excused = [];

  for (const entry of entries) {
    // tar 里的路径形如 `package/lib/index.js`；包根就是 pkgDir。
    const rel = entry.path.replace(/^package\//, '');
    const inTree = path.join(pkgDir, rel);

    // ── pack 必然改写的字段，只白名单这一处 ─────────────────────────────
    // 2026-09-15 实测：`pnpm pack` 会剥掉 `packageManager`（工作树里是
    // "pnpm@11.25.0+sha512.…"），于是 package.json 的哈希**永远**对不上。
    //
    // 这条豁免不是为了让红变绿好看：一个永远为红的闸门等于没有闸门——人会
    // 习惯性地忽略它，而真正的差异（改了 lib/index.js 却忘了重新 pack）
    // 就藏在同一片红色里活下来。所以这里只放行「pack 工具本身的固有改写」，
    // 逐字段比对，其余任何差异照旧算失败。
    if (rel === 'package.json') {
      const norm = (buf) => {
        const o = JSON.parse(buf.toString('utf8'));
        delete o.packageManager; // 唯一的固有差异字段
        return JSON.stringify(o, Object.keys(o).sort());
      };
      if (norm(entry.data) === norm(fs.readFileSync(inTree))) {
        same += 1;
        excused.push(rel + '（仅 packageManager 被 pack 剥离）');
        continue;
      }
    }

    if (!fs.existsSync(inTree)) { missing.push(rel); continue; }
    const a = sha256(entry.data);
    const b = sha256(fs.readFileSync(inTree));
    if (a === b) same += 1;
    else differ.push(rel + '  tar=' + a.slice(0, 12) + ' tree=' + b.slice(0, 12));
  }

  const total = entries.length;
  console.log('');
  console.log(`[verify-pack] 逐字相同 ${same}/${total}`);
  for (const e of excused) console.log(`[verify-pack] （豁免）${e}`);

  // ── 接线闸门 ────────────────────────────────────────────────────────────
  // 逐字节相同**不足以保证能跑**：0.15.2 的 `lib/index.js` 与工作树逐字节相同，
  // 但里面少了一行 `import { projectRoster } from './roster.js'`——模块照样加载、
  // 单测全绿，只有真机 /status 调用时才 ReferenceError。所以发布前必须把
  // 「跨模块引用是否真的 import 了」也钉住。
  const wiringBad = [];
  for (const w of WIRING) {
    const hit = entries.find((e) => e.path.replace(/^package\//, '') === w.file);
    if (!hit) { wiringBad.push(`${w.file} 不在 tarball 里`); continue; }
    const src = hit.data.toString('utf8');
    const re = new RegExp(
      `import\\s*\\{[^}]*\\b${w.need}\\b[^}]*\\}\\s*from\\s*['"]${w.from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
    );
    if (!re.test(src)) wiringBad.push(`${w.need} 未从 ${w.from} 导入（${w.file}）`);
  }
  if (wiringBad.length) {
    console.error('');
    console.error('[verify-pack] ✖ 接线断裂（模块能加载，真机调用时才炸）:');
    for (const w of wiringBad) console.error('  - ' + w);
  } else {
    console.log(`[verify-pack] ✔ 接线完好（${WIRING.length} 项跨模块引用已钉住）`);
  }

  if (missing.length) {
    console.error('[verify-pack] tarball 里有、工作树没有（' + missing.length + '）:');
    for (const m of missing) console.error('  - ' + m);
  }
  if (differ.length) {
    console.error('[verify-pack] 内容不同（' + differ.length + '）:');
    for (const d of differ) console.error('  - ' + d);
  }
  if (missing.length || differ.length || wiringBad.length) {
    console.error('');
    console.error('[verify-pack] ✖ 不一致：改了代码就必须重新 pack，否则装上去的是旧文件。');
    process.exitCode = 1;
  } else {
    console.log('[verify-pack] ✔ tarball 与工作树一致');
  }
}

main(process.argv.slice(2));
