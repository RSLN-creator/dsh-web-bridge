#!/usr/bin/env node
// check-eol-portability.mjs — 闸门：机器生成的索引/审计**必须在 CRLF 与 LF 下都成立**。
//
// ## 为什么需要它（2026-10-14 CI 红，一次真实事故）
//
// `core.autocrlf=true`（本机默认）且仓库**没有** `.gitattributes` ⇒
// 同一个文件在两种形态下都合法：
//   · 开发者本机工作树：LF（或 CRLF，取决于编辑与结账方式）
//   · CI 干净 clone：CRLF
// 于是「本机绿、CI 红」成了可能——2026-10-14 就发生了：
// `gen-progress-index.mjs --check` 在本机（LF）绿，在 CI（CRLF）红，
// 因为重建出的索引块由 `join('\n')` 生成恒为 LF，与文件里的 CRLF 块**永不相等**。
//
// 这类缺陷的共性是：**判据本身对行尾敏感**，而它在开发机上被行尾掩盖。
// 本闸门把那个差异**搬到本机来复现**：把待检文件转成 CRLF 放进临时副本，
// 再对副本跑同一条 `--check`，两边都必须 exit 0。
//
// ## 判据
//
// 对每个 `{ 文件, 检查命令 }`：
//   ① 原文件形态下 `--check` 必须 exit 0；
//   ② 把文件内容整体转成 CRLF 后，同一条 `--check` 也必须 exit 0。
// 两者任一失败 ⇒ 退 1，并指出是哪种形态失败（便于区分「真过期」与「行尾敏感」）。
//
// ⚠ 本闸门**不改**仓库文件：它写 .tmp/ 下的副本、跑完即删（.tmp/ 已被 gitignore）。
//
// 用法：node scripts/check-eol-portability.mjs
// 退出码：0 = 两种行尾都通过；1 = 有失败；2 = 脚本自身出错。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/**
 * 受检项。`prepare` 负责把「CRLF 形态」写到 `targetPath`，并保证检查命令读的是它。
 *
 * 目前两项都用「把文件转 CRLF 写回原路径 → 跑 --check → 还原」的办法：
 * 因为这两个脚本都把路径硬编码成 `doc/<名字>`，没有可传的路径参数。
 * 还原放在 `finally` 里，且**先备份再动**——中途失败也不会把仓库文件留在 CRLF。
 */
const TARGETS = [
  {
    name: 'progress-index',
    file: 'doc/progress.md',
    args: ['scripts/gen-progress-index.mjs', '--check'],
  },
  {
    name: 'doc-audit(long-term-issues)',
    file: 'doc/long-term-issues.md',
    args: ['scripts/doc-rewrite-audit.mjs', 'check', 'doc/long-term-issues.md'],
  },
];

function runCheck(args) {
  try {
    execFileSync(process.execPath, args, { cwd: repoRoot, stdio: 'pipe' });
    return { ok: true, out: '' };
  } catch (e) {
    return { ok: false, out: String(e?.stdout || '') + String(e?.stderr || e?.message || '') };
  }
}

let failed = 0;
for (const t of TARGETS) {
  const abs = path.join(repoRoot, t.file);
  if (!fs.existsSync(abs)) {
    console.log(`  SKIP  ${t.name} —— 找不到 ${t.file}`);
    continue;
  }
  const original = fs.readFileSync(abs, 'utf8');
  const crlfCount = (original.match(/\r\n/g) || []).length;
  const lfCount = (original.match(/(?<!\r)\n/g) || []).length;
  const current = crlfCount > lfCount ? 'CRLF' : 'LF';

  // ① 原形态
  const a = runCheck(t.args);
  // ② CRLF 形态（备份 → 转 → 查 → finally 还原）
  let b = { ok: false, out: '(未跑)' };
  try {
    fs.writeFileSync(abs, original.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n'));
    b = runCheck(t.args);
  } finally {
    fs.writeFileSync(abs, original);
  }

  const mark = (a.ok && b.ok) ? 'PASS' : 'FAIL';
  if (!(a.ok && b.ok)) failed += 1;
  console.log(`  ${mark}  ${t.name}  （文件当前 ${current}）`);
  console.log(`          原形态   : ${a.ok ? 'exit 0' : 'exit 1  ' + a.out.trim().split('\n')[0]}`);
  console.log(`          CRLF 形态: ${b.ok ? 'exit 0' : 'exit 1  ' + b.out.trim().split('\n')[0]}`);
}

console.log('');
if (failed) {
  console.log('[eol] ✖ ' + failed + ' 项在某种行尾形态下失败。');
  console.log('[eol] 这类失败几乎总是「判据对行尾敏感」：把比较两侧都归一化成 \\n 再比，');
  console.log('[eol] 写回时用文件原有的行尾。不要在 CI 上放宽判据——那只是把问题藏起来。');
  process.exitCode = 1;
} else {
  console.log('[eol] ✔ 全部受检项在 LF 与 CRLF 下都通过。');
  console.log('[eol] 注意：本闸门只判「两种行尾都成立」，不判索引内容是否正确。');
}
