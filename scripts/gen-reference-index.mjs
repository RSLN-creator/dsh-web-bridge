#!/usr/bin/env node
// gen-reference-index.mjs — 为 `reference/` 生成「来源与版本」清单（可复现，不是手抄）。
//
// ## 为什么需要这个文件
//
// `reference/` 的约定是「每个条目是一个纯 `git clone`，**故意不入库**」
// （`.gitignore:9` `reference/*/`）。这条约定本身是对的——不该把 316 MB 第三方代码
// 塞进本仓库。但它有一个**没有被补上的对偶**：
//
//   既然内容不入库，那么「**怎么把内容拿回来**」就必须入库。
//
// 实测（2026-09-16）：35 个 clone 里，只有 **1 个** remote URL 在本仓库任何地方被记录过
// （`doc/research/reference-projects.md` 提到过 agentdock 一次），**HEAD SHA 一个都没记**。
// 也就是说 `reference/` 一旦丢失或换机器，就**不可复现**——而这些参考实现正是
// `lib/decoder.js` / `lib/providers.js` 等模块的逆向证据来源。
//
// 本脚本把这个缺口补上：直接从每个 clone 自己的 `.git/` 里读出 remote 与 HEAD，
// 生成一张可复制的清单。
//
// ## 为什么用纯 `fs` 读 `.git/`，而不是 spawn `git`
//
// 本机实测 Node 里 `spawnSync` 调用任何外部程序都 `EPERM`（见 `doc/progress.md`
// 「已知环境约束」）。用 `git -C <dir> remote -v` 会让本脚本在**开发者本机**直接失效，
// 而一个只在 CI 上能跑的生成器，等于没人会跑它。
// `.git/config` 与 `.git/HEAD` 是纯文本，`fs` 读它们在任何环境下行为一致。
//
// ## 用法
//
//   node scripts/gen-reference-index.mjs            # 打印 markdown 表格
//   node scripts/gen-reference-index.mjs --json     # 机读
//   node scripts/gen-reference-index.mjs --missing  # 只列「没有 .git」的条目（约定违例）
//   node scripts/gen-reference-index.mjs --check    # 与 reference/README.md 比对，不一致退 1
//
// 退出码：0 = 正常；1 = `--check` 发现 README 过期；2 = 脚本自身出错。
//
// ## 已知边界
//
//   · 只读 `origin` 这一个 remote（本仓库的参考克隆都只有一个）。
//   · HEAD 解析覆盖「已解引用」（`.git/HEAD` 直接是 SHA）与「指向 refs」两种形态；
//     指向 `refs/heads/*` 时先找 loose ref，再回落到 `packed-refs`。
//   · 不联网校验 remote 是否仍然可达——那会让本脚本需要网络，而它应当是纯本的。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/**
 * `reference/` 的位置。允许 `--root` 覆盖**仅为测试**：
 * 「干净克隆里只有 local-refs」这条路径必须在 CI 之外也能被验证——
 * 否则它只能在真正的干净克隆上第一次被发现错，而那正是最贵的发现时机。
 */
function refDirOf(argv) {
  const i = argv.indexOf('--root');
  return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : path.join(repoRoot, 'reference');
}

/** 从 `.git/config` 里取 `[remote "origin"]` 的 url。纯文本解析，不依赖 git。 */
function remoteOf(gitDir) {
  try {
    const cfg = fs.readFileSync(path.join(gitDir, 'config'), 'utf8');
    const m = /\[remote "origin"\][\s\S]*?\n\s*url\s*=\s*(.+)/.exec(cfg);
    return m ? m[1].trim() : null;
  } catch { return null; }
}

/** 解析 `.git/HEAD` → 具体 SHA。支持 loose ref 与 packed-refs 两种存储。 */
function headOf(gitDir) {
  let head;
  try { head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim(); } catch { return null; }
  const m = /^ref:\s*(.+)$/.exec(head);
  if (!m) return head.slice(0, 40); // 已解引用（detached HEAD）
  const ref = m[1].trim();
  try { return fs.readFileSync(path.join(gitDir, ref), 'utf8').trim().slice(0, 40); } catch { /* 落到 packed */ }
  try {
    const packed = fs.readFileSync(path.join(gitDir, 'packed-refs'), 'utf8');
    for (const line of packed.split('\n')) {
      if (!line || line.startsWith('#') || line.startsWith('^')) continue;
      const [sha, name] = line.trim().split(/\s+/);
      if (name === ref) return sha.slice(0, 40);
    }
  } catch { /* 无 packed-refs */ }
  return null;
}

/** 目录大小（字节）。用纯 fs 递归，避免 spawn。 */
function sizeOf(dir) {
  let total = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else { try { total += fs.statSync(p).size; } catch { /* 跳过不可读 */ } }
    }
  }
  return total;
}

/**
 * 扫描 `reference/` 下的每个目录，收集来源信息。
 *
 * `refDir` 是**参数而不是模块级常量**：它允许 `--root` 把本脚本指向一个构造目录，
 * 「干净克隆里只有 local-refs」这条路径才能在 CI 之外被验证（见 `refDirOf` 的注释）。
 *
 * @param {string} refDir `reference/` 的绝对路径
 * @returns {Array<{name: string, isClone: boolean, remote: string|null, head: string|null, mb: number}>}
 */
function collect(refDir) {
  const rows = [];
  if (!fs.existsSync(refDir)) return rows;
  for (const e of fs.readdirSync(refDir, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const dir = path.join(refDir, e.name);
    const gitDir = path.join(dir, '.git');
    const isClone = fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory();
    rows.push({
      name: e.name,
      isClone,
      remote: isClone ? remoteOf(gitDir) : null,
      head: isClone ? headOf(gitDir) : null,
      mb: +(sizeOf(dir) / (1024 * 1024)).toFixed(1),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));
  return rows;
}

/** 生成 markdown 表格。`ghfast.top` 是加速镜像前缀，单独标出来（它不是作者的真实仓库地址）。 */
function toMarkdown(rows) {
  const out = [];
  out.push('| 目录 | remote | HEAD | 大小 |');
  out.push('| --- | --- | --- | --- |');
  for (const r of rows) {
    if (!r.isClone) {
      out.push(`| \`${r.name}\` | **不是 clone**（见 §6「约定违例」） | — | ${r.mb} MB |`);
      continue;
    }
    const mirror = r.remote && r.remote.includes('ghfast.top') ? ' ⚠️镜像' : '';
    out.push(`| \`${r.name}\` | ${r.remote ? r.remote + mirror : '(无 origin)'} | \`${r.head ?? '?'}\` | ${r.mb} MB |`);
  }
  return out.join('\n');
}

function main() {
  const argv = process.argv.slice(2);
  // `REF` 与 `README` 在 0.15.8 之前是**从未定义过的模块级标识符**——`collect()` 一被调用
  // 就抛 `ReferenceError: REF is not defined`，整条 `--check` 以退出码 2 结束。
  // 它同时被 `ci.yml` 与 `ci-local.mjs` 当作**阻断闸门**调用，所以那不是「少跑一道检查」，
  // 而是每次 CI 都红一次、且红在一个与改动无关的地方。根因是 `refDirOf()` 写了却没人调用。
  const refDir = refDirOf(argv);
  const readme = path.join(refDir, 'README.md');
  const rows = collect(refDir);

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(rows, null, 2) + '\n');
    return 0;
  }

  if (argv.includes('--missing')) {
    const bad = rows.filter((r) => !r.isClone);
    if (bad.length) {
      process.stdout.write('以下条目不是 git clone（与 .gitignore:8 的约定不符）：\n');
      for (const r of bad) process.stdout.write(`  · ${r.name}（${r.mb} MB）\n`);
      return 0;
    }
    process.stdout.write('✔ 所有条目都是 git clone。\n');
    return 0;
  }

  const table = toMarkdown(rows);

  if (argv.includes('--check')) {
    if (!fs.existsSync(README)) {
      process.stderr.write('[ref-index] reference/README.md 不存在——先跑一次本脚本并写入。\n');
      return 1;
    }
    const current = fs.readFileSync(README, 'utf8');
    // **只校验「磁盘上确实存在」的条目。**
    //
    // 这一步的设计陷阱（必须写下来，否则下一个人会「顺手修好」成整表比对）：
    // `reference/*/` 的克隆**不入库**，所以**全新克隆里这些目录根本不存在**——
    // 整表比对会让 CI 在每一个干净的检出上恒红，而那不是发现了一个错，
    // 只是把一个「故意的约定」当成了错误。**假红的闸门会被人加 --no-verify 绕过，
    // 比没有闸门更坏**（与 check-ledger.mjs 拒绝用 spawnSync 是同一条立场）。
    //
    // 正确语义：**凡是在本机存在的条目，README 必须与之逐字一致**；
    // 不存在的条目无从校验，报成 SKIP 并说明。这样：
    //   · 有克隆的机器（维护者）→ 真的在验；
    //   · 干净克隆（CI / 新协作者）→ 明确跳过，而不是假装通过或错误失败。
    const present = rows.filter((r) => fs.existsSync(path.join(REF, r.name)));
    const absent = rows.length - present.length;
    const tableLines = toMarkdown(rows).split('\n');
    const missing = [];
    for (const r of present) {
      const line = tableLines.find((l) => l.startsWith(`| \`${r.name}\` |`));
      if (line && !current.includes(line)) missing.push(line);
    }
    if (missing.length) {
      process.stderr.write(`[ref-index] reference/README.md 过期：`
        + `${missing.length}/${present.length} 个**本机存在的**条目与磁盘不一致。\n`);
      for (const l of missing.slice(0, 8)) process.stderr.write('  ' + l + '\n');
      process.stderr.write('[ref-index] 重新生成并写入 README（本脚本的表格段）。\n');
      return 1;
    }
    process.stdout.write(`[ref-index] ✔ reference/README.md 与本机一致`
      + `（校验 ${present.length} 个存在的条目；${absent} 个不在本机，按约定跳过）。\n`);
    if (present.length === 0) {
      process.stdout.write('[ref-index] 注意：本机一个参考克隆都没有，本次**没有真正校验**任何来源表。\n');
    }
    return 0;
  }

  process.stdout.write(table + '\n');
  return 0;
}

let code = 2;
try {
  code = main();
} catch (e) {
  process.stderr.write('[ref-index] 脚本自身失败：' + (e && e.stack ? e.stack : e) + '\n');
  code = 2;
}
process.exit(code);
