#!/usr/bin/env node
// install-git-hooks.mjs — 把仓库里**入库**的 git 钩子装到 .git/hooks/（.git 不入库，所以需要这一步）。
//
// 为什么钩子要入库：`scripts/hooks/pre-commit` 是「提交前告知官方漂移」的执行体（用户
// 2026-10-06 明令）。`--no-verify` 能绕过钩子，但**绕过不了** CI：`scripts/ci-local.mjs`
// 里同样跑这一段（两条路都留）。本脚本只做一件事：把入库的那份复制成可执行的 .git/hooks/pre-commit。
//
// 用法：node scripts/install-git-hooks.mjs
// 退出码：0 = 装好；2 = 仓库结构不对。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const src = path.join(here, 'hooks', 'pre-commit');
const gitDir = path.join(repoRoot, '.git');

if (!fs.existsSync(gitDir)) {
  console.error('[hooks] 找不到 .git：' + gitDir);
  process.exitCode = 2;
} else if (!fs.existsSync(src)) {
  console.error('[hooks] 找不到入库的钩子：' + src);
  process.exitCode = 2;
} else {
  const dst = path.join(gitDir, 'hooks', 'pre-commit');
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  fs.chmodSync(dst, 0o755);
  console.log('[hooks] 已安装：' + dst);
  console.log('[hooks] 提交前会跑 scripts/check-official-drift.mjs —— 官方一侧变了会**拦下提交**并点名段落。');
}
