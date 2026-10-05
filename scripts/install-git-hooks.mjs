#!/usr/bin/env node
// install-git-hooks.mjs — 把仓库里**入库**的 git 钩子装到 .git/hooks/（.git 不入库，所以需要这一步）。
//
// 为什么钩子要入库：`scripts/hooks/pre-commit` 是「提交前告知官方漂移」的执行体（用户
// 2026-10-06 明令），`scripts/hooks/post-commit` 是「提交后自动查云端 CI」的执行体
//（用户同日第二条明令：「ci每次fail都要我提醒？你自己加上每次提交检云端ci!」）。
// `--no-verify` 能绕过钩子，但**绕过不了** CI：`scripts/ci-local.mjs` 里同样跑漂移那一段。
//
// 用法：node scripts/install-git-hooks.mjs
// 退出码：0 = 都装好；2 = 仓库结构不对。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const gitDir = path.join(repoRoot, '.git');
/** 入库的钩子 → .git/hooks 下的名字（两个都要装：提交前查漂移、提交后查云端 CI）。 */
const HOOKS = ['pre-commit', 'post-commit'];

if (!fs.existsSync(gitDir)) {
  console.error('[hooks] 找不到 .git：' + gitDir);
  process.exitCode = 2;
} else {
  for (const name of HOOKS) {
    const src = path.join(here, 'hooks', name);
    if (!fs.existsSync(src)) { console.error('[hooks] 找不到入库的钩子：' + src); process.exitCode = 2; continue; }
    const dst = path.join(gitDir, 'hooks', name);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    fs.chmodSync(dst, 0o755);
    console.log('[hooks] 已安装：' + dst);
  }
  if (process.exitCode !== 2) {
    console.log('[hooks] 提交前跑 scripts/check-official-drift.mjs —— 官方一侧变了会**拦下提交**并点名段落；');
    console.log('[hooks] 提交后跑 scripts/check-cloud-ci.mjs —— 云端 CI 红了当场打印 run 链接（查不到只提示，不拦）。');
  }
}
