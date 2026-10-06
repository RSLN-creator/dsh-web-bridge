// concurrent-workspace.js — 并发组的**专属 git worktree**（0.19.68，用户 2026-10-06）。
//
// ## 这个模块解决什么（用户原话逐字）
//
//   「做不到你就自己新建不行吗？？」
//
// 承接 `doc/long-term-issues.md` #40：「并发会话的『一组一行』在官方会话清单里做不到」。
// 本轮查清了官方机制，结论是**做得到，但前提是「一个组一个真目录」**：
//
//   1. 官方左栏默认按**工作区**分组渲染（`dsh-client-ui-workspace/lib/client.js:661`
//      `groupBy: "workspace"`），每个工作区一行、**折叠时不投影会话行**
//      （`:492/:502` `sessions: expanded ? … : []`）⇒ 天然就是「一组一行」。
//   2. 会话归哪个工作区，判据在**宿主**且是硬判据：会话 header 的 `cwd` 经 `realpath`
//      后必须**逐字等于**工作区的 canonical path
//      （`dsh-workspace/lib/index.js:122` `if (cwd !== this.record.path) throw`；
//      README:172 原文 *a session from another directory cannot be moved in*）。
//      ⇒ **不能**给会话打一个「虚拟分组」标签；想让 N 条会话同组，它们必须真跑在同一目录。
//   3. 建工作区要求目录**已经存在**（`dsh-workspace/lib/index.js:406-409`
//      `realpathNormalize` + `stat` 非目录即拒）。所以「新建一个目录」是**必需**的前置，
//      不是可选优化。
//
// ## 为什么是 git worktree（用户 2026-10-06 选 B）
//
// 目录选在哪里，决定了列里的 agent 能看见什么。三个选项里用户选了 B：
//
//   · A：项目内子目录 `.hwb/concurrent/<组id>` —— 零 git 操作，但列会话的 cwd 就是那个
//     子目录 ⇒ agent **看不到项目其余文件**（功能上比现状弱）。**否决**。
//   · B（**本模块**）：`git worktree add` 出**同项目的完整副本 + 自己的分支** ⇒
//     agent 看得见全部代码（与今天一致），且每组真正隔离。这正是用户早先提的
//     「通过 git 分支和最后旋转来进行并列多会话」。
//   · C：只做手动入口，不自动建 ⇒ 不解决「自动一组一行」。
//
// ## 诚实边界（不夸大）
//
//   · 本模块**只在服务端跑 git**（客户端没有 fs/子进程）。客户端把「建组」这一步交给
//     `POST concurrent-workspace`，拿到绝对路径后调官方 `ctx.workspaces.create({path})`。
//   · **不自动 merge、不自动删 worktree**：合并是用户/主线列的决定（用户原话「最后旋转」），
//     删目录同理。本模块只给**指令**（`recipe`）与**清理命令**，绝不代做破坏性 git 操作。
//   · worktree 默认建在**仓库之外**的兄弟目录（`<repo>-hwb-<组id>`）：放进仓库内会让
//     git status 变脏、也会被别的列误检。分支名 `hwb/concurrent/<组id>`。
//   · 该目录**不是** `.hwb/`（那个已被 .gitignore、且是列产出目录），两者不混用。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

/** 分支名前缀：与用户在 `columnBrief` 里看到的口径同族（`hwb/…`）。 */
export const CONCURRENT_BRANCH_PREFIX = 'hwb/concurrent/';

/**
 * 组 id → 路径安全片段（白名单，与 `column-context.js` 的 `safePathSegment` 同口径）。
 *
 * 为什么必须净化：`groupId` 来自客户端请求体，会被拼进**目录名**与**分支名**。
 * 一个 `../` 就能让 worktree 建到仓库之外任意位置、或让分支名变成 `git` 的参数。
 * 这是**注入**，不是「约定不严」。
 *
 * @param {unknown} raw 原始组 id
 * @returns {string} 只含 [A-Za-z0-9_-] 的片段（空串表示不可用）
 */
export function safeGroupId(raw) {
  const s = String(raw ?? '').replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '');
  return s.slice(0, 48);
}

/**
 * 并发组 worktree 的目标路径：仓库的**兄弟目录**（不进仓库内）。
 *
 * @param {string} repoRoot 主检出根（绝对路径）
 * @param {string} groupId 已净化的组 id
 * @returns {string} worktree 绝对路径
 */
export function worktreePathFor(repoRoot, groupId) {
  const base = path.basename(path.resolve(repoRoot));
  return path.join(path.dirname(path.resolve(repoRoot)), base + '-hwb-' + groupId);
}

/** 分支名（已净化）。 */
export function branchFor(groupId) {
  return CONCURRENT_BRANCH_PREFIX + groupId;
}

/**
 * 跑一次 git，拿结构化读数。**不抛**：所有失败都变成 `{ok:false, error}`。
 *
 * @param {string} cwd git 命令的工作目录
 * @param {string[]} args 参数数组（不经 shell，杜绝拼接注入）
 * @returns {{ok: boolean, stdout: string, stderr: string, code: number|null, error?: string}}
 */
function git(cwd, args) {
  try {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 120_000, windowsHide: true });
    if (r.error) return { ok: false, stdout: '', stderr: '', code: null, error: String(r.error.message || r.error) };
    return {
      ok: r.status === 0,
      stdout: String(r.stdout || ''),
      stderr: String(r.stderr || ''),
      code: r.status,
      ...(r.status === 0 ? {} : { error: (String(r.stderr || '').trim() || 'git exited ' + r.status).slice(0, 400) }),
    };
  } catch (e) {
    return { ok: false, stdout: '', stderr: '', code: null, error: String(e?.message || e) };
  }
}

/**
 * 仓库根（`git rev-parse --show-toplevel`）。
 *
 * 为什么不用 `process.cwd()`：控制面进程的 cwd 不保证是用户的项目目录
 *（web profile 是独立进程）。先试 `hint`（宿主给的当前会话工作目录），
 * 再回落 `process.cwd()`；两者都取不到就是「这不是 git 仓库」——如实报，不猜。
 *
 * @param {string} [hint] 宿主的当前工作目录
 * @returns {string|null} 仓库根绝对路径；不是 git 仓库时为 null
 */
export function repoRootOf(hint) {
  for (const cwd of [hint, process.cwd()].filter(Boolean)) {
    const r = git(cwd, ['rev-parse', '--show-toplevel']);
    if (r.ok && r.stdout.trim()) return path.resolve(r.stdout.trim());
  }
  return null;
}

/**
 * 为一个并发组准备**专属工作区目录**（git worktree + 分支）。
 *
 * 幂等：目标目录已存在就复用它（不报错、不重建）；分支已存在则基于它检出，
 * 而不是失败——用户重开同一组的历史组时走的正是这条。
 *
 * @param {{repoRoot?: string, groupId?: unknown, baseRef?: string, title?: string}} input
 *   `repoRoot` 主检出根；`groupId` 组 id（会被净化）；`baseRef` 起点（默认 `HEAD`）
 * @returns {{ok: boolean, path?: string, branch?: string, repoRoot?: string, reused?: boolean, recipe?: object, error?: string}}
 */
export function prepareConcurrentWorkspace(input = {}) {
  const groupId = safeGroupId(input.groupId);
  if (!groupId) return { ok: false, error: 'concurrent-workspace: 缺少可用的组 id' };
  const repoRoot = repoRootOf(input.repoRoot);
  if (!repoRoot) {
    return {
      ok: false,
      error: 'concurrent-workspace: 当前目录不是 git 仓库（并发组的独立工作区需要 git worktree；'
        + '非 git 项目请改用普通工作区，不要新建）',
    };
  }
  const target = worktreePathFor(repoRoot, groupId);
  const branch = branchFor(groupId);
  const baseRef = String(input.baseRef || 'HEAD');

  // ① 目录已在：直接复用（历史组重开 / 重复点击都不该失败）。
  if (fs.existsSync(target)) {
    return { ok: true, path: target, branch, repoRoot, reused: true, recipe: recipeFor(repoRoot, target, branch) };
  }

  // ② 分支是否已存在（`git worktree add -b` 会因重名失败；已存在则改为检出它）。
  const branchExists = git(repoRoot, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + branch]).ok;

  // ③ 建 worktree。**先 `worktree add` 成功再回报**——失败绝不假装建好。
  const addArgs = branchExists
    ? ['worktree', 'add', target, branch]
    : ['worktree', 'add', '-b', branch, target, baseRef];
  const add = git(repoRoot, addArgs);
  if (!add.ok) {
    return { ok: false, repoRoot, error: 'git worktree add 失败：' + (add.error || '未知原因') };
  }
  if (!fs.existsSync(target)) {
    return { ok: false, repoRoot, error: 'git worktree add 报成功但目录不存在：' + target };
  }
  return { ok: true, path: target, branch, repoRoot, reused: false, recipe: recipeFor(repoRoot, target, branch) };
}

/**
 * 给用户/主线列的**收尾指令**（用户原话「最后旋转」）。
 *
 * 只给指令、不代跑：合并与删除都是破坏性动作，必须由人或有上下文的那一列决定。
 *
 * @param {string} repoRoot 主检出
 * @param {string} worktree 该组 worktree
 * @param {string} branch 该组分支
 * @returns {{merge: string, remove: string, list: string}} 三条可复制的命令
 */
export function recipeFor(repoRoot, worktree, branch) {
  return {
    merge: 'git -C "' + repoRoot + '" merge --no-ff ' + branch,
    remove: 'git -C "' + repoRoot + '" worktree remove "' + worktree + '"',
    list: 'git -C "' + repoRoot + '" worktree list',
  };
}

/**
 * 列出本插件建过的并发 worktree（诊断用；只读）。
 *
 * 判据用**目录名前缀**而不是「分支名匹配」：分支可能被用户改过，而目录前缀是
 * 本模块自己定的、可控的。`git worktree list --porcelain` 的每一段以空行分隔，
 * `worktree <path>` 是首行。
 *
 * @param {string} [hint] 宿主的当前工作目录
 * @returns {{ok: boolean, repoRoot?: string, entries?: Array<{path: string, branch: string}>, error?: string}}
 */
export function listConcurrentWorkspaces(hint) {
  const repoRoot = repoRootOf(hint);
  if (!repoRoot) return { ok: false, error: 'not-a-git-repo' };
  const r = git(repoRoot, ['worktree', 'list', '--porcelain']);
  if (!r.ok) return { ok: false, repoRoot, error: r.error || 'git worktree list failed' };
  const marker = '-' + 'hwb-';
  const entries = [];
  let cur = null;
  for (const line of r.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      if (cur) entries.push(cur);
      cur = { path: line.slice('worktree '.length).trim(), branch: '' };
    } else if (cur && line.startsWith('branch ')) {
      cur.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '');
    }
  }
  if (cur) entries.push(cur);
  return {
    ok: true,
    repoRoot,
    entries: entries.filter((e) => path.basename(e.path).includes(marker)),
  };
}