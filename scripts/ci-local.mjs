#!/usr/bin/env node
// ci-local.mjs — 推之前跑这一条：把 CI 里**能离线复现的那几步**按同样顺序在本机跑一遍。
//
// ## 为什么需要这个文件
//
// `.github/workflows/ci.yml` 跑在 ubuntu/windows 两平台 × Node 20/22 上，反馈要等几分钟；
// 而本仓库最贵的一类事故是「本地绿、CI 红」和反过来——`doc/review-guide.md` 已经记下过一次
// 环境差异造成的假失败（`npm test` 在本会话沙箱下 `spawn EPERM`），`doc/comment-style.md` §6.6
// 把它上升为纪律：「跑测试的方式也写进注释/文档……会话之间传递这类环境事实，比传递
// 『我试过了』有用得多」。把 CI 的离线步骤收成一条命令，就是这条纪律的可执行形式。
//
// ## 刻意不做什么
//
// **不跑真机探针**（`test-mock/real-*.mjs`、`npm run doctor`）。它们需要一台**已登录的**
// Edge，并且会真实敲站点，受站点风控限制（`doc/comment-style.md` §9.1 第 5 条：默认离线，
// `--live` 必须显式批准）。把它们塞进「推之前随手跑一下」的入口，等于让每个人每次推送都去
// 敲一次真机——这正是风控纪律要避免的事。真机验收走 `doc/verify.md` 的矩阵，由人按发版节奏跑。
//
// ## 步骤与顺序
//
//   1. `scripts/lint-comments.mjs`           注释纪律（§10 的机检部分）
//   2. `scripts/check-ledger.mjs`            台账与事实一致（版本号 / 测试文件数）
//   3. `scripts/check-repo-hygiene.mjs`      文件编码无 BOM + doc/README.md 索引无死链
//   4. `scripts/check-commit-msg.mjs`        提交信息判据自检（--self-test）
//   5. `scripts/gen-reference-index.mjs`     reference/README.md 的来源表与磁盘一致
//   6. `test-mock/artifacts-check.mjs`       生成物卫生（跑一次就会变的文件不许被 git 看见）
//   7. `test-mock/prompt-bench.mjs --offline` 基准 harness 离线回放（不联网、不碰真机）
//   8. `pnpm test`                           全量单测（`--fast` 跳过）
//
// 前六步是秒级的，第七步十余秒，第八步约 10 分钟。因此 `--fast` 只砍第八步——**砍掉的必须是
// 慢的那一步**，而不是「顺手也砍掉检查」的那一步。
//
// **第 3~5 步是纯 `fs`、不用 `spawnSync`**，因此它们在开发者本机（含沙箱）也能真正跑起来；
// 第 6 步依赖 `git check-ignore`，在 spawn 被挡的环境里会**跳过并说明**（不假装通过）。
// 这条区别很重要：本机跑一遍能发现的欠账，不该拖到 CI 才被发现。
//
// ## 用法（Windows / PowerShell）
//
//   node scripts\ci-local.mjs            # 全量：上面四步
//   node scripts\ci-local.mjs --fast     # 跳过全量单测（秒级反馈）
//
// 退出码：0 = 全部 PASS；1 = 任一步 FAIL；2 = 脚本自身出错。
//
// 注意：本脚本**不修改任何文件**，也不安装依赖。它假定你已经跑过
// `pnpm install --no-frozen-lockfile`（见 CONTRIBUTING.md「为什么不是 --frozen-lockfile」）。

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const pkgDir = path.join(repoRoot, 'package', 'dsh-webcode-bridge');

/**
 * pnpm 的可执行名与**启动方式**。这两件事必须一起决定，不能只决定名字。
 *
 * ## 为什么不能只写 `pnpm.cmd` + `shell:false`
 *
 * 本脚本最初就是这么写的，注释里还写明了「Windows 上必须按平台取名」——
 * 名字确实取对了，但**调用方式**是错的，结果是 `spawnSync pnpm.cmd EINVAL`
 * （2026-09-15 实测，Node 24）。
 *
 * 根因是 Node 修 CVE-2024-27980（Windows 上 `.bat`/`.cmd` 的参数注入）之后加的一道
 * 硬化：**在 `shell:false` 下 spawn 一个 `.cmd`/`.bat` 会直接抛 `EINVAL`**，
 * 因为 Node 拒绝在没有 shell 的情况下去执行一个本质上是批处理的东西。
 * 也就是说 `pnpm.cmd` 这个名字只在**配 `shell:true` 时**才可用。
 *
 * ## 为什么 `shell:true` 在这里是安全的
 *
 * 参数里没有用户输入：命令与参数全部是本文件里的字面量（`node`、`scripts/...`、`test`）。
 * 那条 CVE 讲的是「把不可信输入拼进命令行」，本脚本没有这个面。
 *
 * ## 代价：CI 与本地走的是**同一份** PNPM 与同一份 runStep，因此两边都覆盖到了
 *
 * 这正是「把这一步也放进 CI」的价值——它在本机暴露出来的同时，也证明了
 * ubuntu 那条腿（`shell:true` + `pnpm`）是同一段代码。
 */
const PNPM = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
/** Windows 上必须带 shell（见上方注释）；POSIX 上不需要，也就不引入它。 */
const USE_SHELL = process.platform === 'win32';

/**
 * 步骤表。`cwd` 是**必须**显式给的：`scripts/lint-comments.mjs` 依赖自己相对仓库根的位置，
 * 而 `pnpm test` 必须在包目录里跑（package.json 在那儿）。指望「继承当前目录」会让同一份脚本
 * 在不同调用方式下行为不同。
 */
const STEPS = [
  {
    id: 'lint-comments',
    title: '注释纪律机检',
    cmd: process.execPath,
    args: [path.join('scripts', 'lint-comments.mjs')],
    cwd: repoRoot,
    hint: '逐行输出会指出 file:line + CS00x。若确属误报，改 scripts/lint-comments.mjs 的判据，不要绕过。',
  },
  {
    id: 'check-ledger',
    title: '台账与事实一致（版本号 / 测试文件数）',
    cmd: process.execPath,
    args: [path.join('scripts', 'check-ledger.mjs')],
    cwd: repoRoot,
    hint: '改 doc/progress.md 的「当前状态」表让它与事实一致；不要改脚本去迁就台账。',
  },
  {
    id: 'repo-hygiene',
    title: '文件编码无 BOM + doc/README.md 索引无死链',
    cmd: process.execPath,
    args: [path.join('scripts', 'check-repo-hygiene.mjs')],
    cwd: repoRoot,
    hint: '去 BOM 用「去掉前 3 字节 EF BB BF」；索引死链要么补文件、要么删掉索引那一行。',
  },
  {
    id: 'commit-msg',
    title: '提交信息判据自检（正反例都必须对）',
    cmd: process.execPath,
    args: [path.join('scripts', 'check-commit-msg.mjs'), '--self-test'],
    cwd: repoRoot,
    hint: '改了 scripts/check-commit-msg.mjs 的判据就必须同步改自检的正反例。规范见 CONTRIBUTING.md §9。',
  },
  {
    id: 'ref-index',
    title: 'reference/README.md 的来源表与磁盘一致',
    cmd: process.execPath,
    args: [path.join('scripts', 'gen-reference-index.mjs'), '--check'],
    cwd: repoRoot,
    hint: '跑 `node scripts\\gen-reference-index.mjs` 重新生成，把表格段覆盖回 reference/README.md。',
  },
  {
    id: 'artifacts-check',
    title: '生成物卫生（跑一次就会变的文件不得被 git 看见）',
    cmd: process.execPath,
    args: [path.join('test-mock', 'artifacts-check.mjs')],
    cwd: pkgDir,
    hint: '修复方向是给「生成物所在目录」单独加按路径的 .gitignore 规则（父目录规则不覆盖嵌套子目录）。',
  },
  {
    id: 'bench-offline',
    title: '基准 harness 离线回放',
    cmd: process.execPath,
    args: [path.join('test-mock', 'prompt-bench.mjs'), '--offline'],
    cwd: pkgDir,
    hint: '退出码 1=有失败用例、2=参数/判据自检失败、3=--live 未批准。看用例表定位。',
  },
  {
    id: 'test',
    title: '全量单测（pnpm test）',
    cmd: PNPM,
    args: ['test'],
    cwd: pkgDir,
    // Windows 上 .cmd 必须配 shell:true（CVE-2024-27980 硬化后 shell:false 会 EINVAL）。
    // 只有这一步需要：其余步骤的 cmd 是 process.execPath（node 可执行文件），不受影响。
    shell: USE_SHELL,
    slow: true,
    hint: '与 CI 的 `pnpm test` 同一入口：node --test + parse + M1 契约 + bench-ci + artifacts-check。',
  },
];

/** 解析 argv。手写不引依赖，与 scripts/lint-comments.mjs 同一理由。 */
function parseArgs(argv) {
  const out = { fast: false, unknown: [] };
  for (const a of argv) {
    if (a === '--fast') out.fast = true;
    else out.unknown.push(a);
  }
  return out;
}

/** 跑一步并返回退出码。用 spawnSync + stdio:'inherit'：让子步骤的原始输出直通终端。 */
function runStep(step) {
  const started = Date.now();
  const r = spawnSync(step.cmd, step.args, {
    cwd: step.cwd,
    stdio: 'inherit',
    shell: step.shell === true,
  });
  const ms = Date.now() - started;
  if (r.error) return { code: -1, ms, error: r.error.message };
  // status === null 表示被信号杀死（Windows 上强杀会伪装成 1，见 harness 说明）。
  return { code: r.status === null ? -1 : r.status, ms, error: null };
}

function fmtMs(ms) {
  return ms >= 1000 ? (ms / 1000).toFixed(1) + 's' : ms + 'ms';
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.unknown.length) {
    process.stderr.write('未知参数：' + opts.unknown.join(' ') + '\n');
    process.stderr.write('用法：node scripts/ci-local.mjs [--fast]\n');
    return 2;
  }

  const steps = opts.fast ? STEPS.filter((s) => !s.slow) : STEPS;

  process.stdout.write('[ci-local] 仓库：' + repoRoot + '\n');
  process.stdout.write('[ci-local] 模式：' + (opts.fast ? '--fast（跳过全量单测）' : '全量') + '\n');
  process.stdout.write('[ci-local] 不跑真机探针（real-*.mjs / doctor）：需要已登录 Edge 且受站点风控限制，见 CONTRIBUTING.md\n\n');

  const results = [];
  // 刻意**不** fail-fast：一次推送前想知道的是「一共坏了几处」，而不是「第一处坏在哪」。
  // 四个步骤互相独立（lint 读源码、artifacts 读 git 判定、bench 跑回放、test 跑断言），
  // 让它们全跑完再汇总，开发者一轮就能看清全部欠账。
  for (const step of steps) {
    process.stdout.write('─'.repeat(72) + '\n');
    process.stdout.write(`[ci-local] ▶ ${step.id} — ${step.title}\n`);
    process.stdout.write('─'.repeat(72) + '\n');
    const r = runStep(step);
    results.push({ step, ...r });
    if (r.error) {
      process.stdout.write(`\n[ci-local] ✖ ${step.id} 无法启动：${r.error}\n`);
    }
    process.stdout.write('\n');
  }

  process.stdout.write('═'.repeat(72) + '\n');
  process.stdout.write('[ci-local] 汇总（每步退出码）\n');
  process.stdout.write('═'.repeat(72) + '\n');
  for (const r of results) {
    const verdict = r.code === 0 ? 'PASS' : 'FAIL';
    process.stdout.write(
      `  ${verdict}  ${r.step.id.padEnd(16)} exit=${String(r.code).padStart(3)}  ${fmtMs(r.ms).padStart(8)}  ${r.step.title}\n`,
    );
  }

  const skipped = STEPS.filter((s) => !steps.includes(s));
  for (const s of skipped) {
    process.stdout.write(`  SKIP  ${s.id.padEnd(16)} exit=  -         -  ${s.title}（--fast 跳过）\n`);
  }

  const failed = results.filter((r) => r.code !== 0);
  process.stdout.write('\n');
  if (failed.length) {
    process.stdout.write(`[ci-local] ✖ FAIL — ${failed.length}/${results.length} 步未通过。\n`);
    for (const r of failed) {
      process.stdout.write(`  · ${r.step.id}（exit=${r.code}）：${r.step.hint}\n`);
    }
    process.stdout.write('[ci-local] 修完这些再推；CI 会跑同样的步骤（外加 windows/ubuntu × Node 20/22 矩阵）。\n');
    return 1;
  }

  process.stdout.write(`[ci-local] ✔ PASS — ${results.length}/${results.length} 步通过`
    + (skipped.length ? `（${skipped.length} 步被 --fast 跳过，推之前请至少跑一次全量）` : '') + '。\n');
  return 0;
}

let code = 2;
try {
  code = main(process.argv.slice(2));
} catch (e) {
  // 脚本自身出错必须是 2，不能伪装成「有步骤失败」（1）：两者的处理方式完全不同。
  process.stderr.write('[ci-local] 脚本自身失败：' + (e?.stack || e?.message || e) + '\n');
  code = 2;
}
process.exit(code);