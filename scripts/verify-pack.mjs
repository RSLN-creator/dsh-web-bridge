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

  for (const entry of entries) {
    // tar 里的路径形如 `package/lib/index.js`；包根就是 pkgDir。
    const rel = entry.path.replace(/^package\//, '');
    const inTree = path.join(pkgDir, rel);
    if (!fs.existsSync(inTree)) { missing.push(rel); continue; }
    const a = sha256(entry.data);
    const b = sha256(fs.readFileSync(inTree));
    if (a === b) same += 1;
    else differ.push(rel + '  tar=' + a.slice(0, 12) + ' tree=' + b.slice(0, 12));
  }

  const total = entries.length;
  console.log('');
  console.log(`[verify-pack] 逐字相同 ${same}/${total}`);
  if (missing.length) {
    console.error('[verify-pack] tarball 里有、工作树没有（' + missing.length + '）:');
    for (const m of missing) console.error('  - ' + m);
  }
  if (differ.length) {
    console.error('[verify-pack] 内容不同（' + differ.length + '）:');
    for (const d of differ) console.error('  - ' + d);
  }
  if (missing.length || differ.length) {
    console.error('');
    console.error('[verify-pack] ✖ 不一致：改了代码就必须重新 pack，否则装上去的是旧文件。');
    process.exitCode = 1;
  } else {
    console.log('[verify-pack] ✔ tarball 与工作树一致');
  }
}

main(process.argv.slice(2));
