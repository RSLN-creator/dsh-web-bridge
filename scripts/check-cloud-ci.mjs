#!/usr/bin/env node
// check-cloud-ci.mjs — 提交/推送后**自动查云端 CI**，红了当场说人话（用户 2026-10-06 明令）。
//
// 用户原话：「ci每次fail都要我提醒？你自己加上每次提交检云端ci!」
//
// ## 它做什么
//
//   1. 读当前仓库/分支/HEAD；
//   2. `gh run list --branch <b> --limit 20 --json …` 拿最近的 run；
//   3. **先报「上一次提交」的结论**（CI 还没跑完时这是唯一有信息的读数）；
//   4. 找 HEAD 自己的 run：有就报；没有（还没触发/还没推）就说明；
//   5. `--wait`：轮询到 HEAD 的 run **落定**（completed）为止，再给最终结论；
//   6. 任何**失败**（failure/cancelled/timed_out/action_required）⇒ 退 1，并打印 run 链接。
//
// ## 失败口径（照本仓库纪律：闸门不许空转、也不许假红）
//
//   · `gh` 不在 / 未登录 ⇒ 退 **2** 并说明「这次没查成」，**不算失败**（不能因为本机没装
//     gh 就把提交拦死——那正是 0.19.66 钩子踩过的坑）；
//   · 查到了红 ⇒ 退 **1**，把 run 名、结论、链接一次给全；
//   · 全绿 ⇒ 退 0，只打印一行结论。
//
// 用法：
//   node scripts/check-cloud-ci.mjs            # 查一次（人读）
//   node scripts/check-cloud-ci.mjs --wait     # 等 HEAD 的 run 落定（默认最多 600s）
//   node scripts/check-cloud-ci.mjs --json     # 机读
//   node scripts/check-cloud-ci.mjs --wait --timeout 300

import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const wait = argv.includes('--wait');
const tIdx = argv.indexOf('--timeout');
const timeoutSec = tIdx >= 0 ? Number(argv[tIdx + 1]) || 600 : 600;

/** 跑一条 git 命令（只读）。 */
function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8' }).trim();
}

/** 跑 gh 并把 JSON 解析回来；失败时抛出带 stderr 的错误。 */
function ghJson(args) {
  const out = execFileSync('gh', args, { cwd: repoRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out);
}

const RED = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);

function summarize(run) {
  return {
    name: run.name || run.workflowName || '(workflow)',
    status: run.status,
    conclusion: run.conclusion,
    sha: String(run.headSha || '').slice(0, 7),
    url: run.url || '',
    createdAt: run.createdAt || '',
  };
}

function main() {
  let branch;
  let head;
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    head = git(['rev-parse', 'HEAD']);
  } catch (e) {
    console.error('[ci] 不在 git 仓库里或读不到 HEAD：' + (e?.message || e));
    process.exitCode = 2;
    return;
  }

  const listRuns = () => ghJson([
    'run', 'list', '--branch', branch, '--limit', '20',
    '--json', 'databaseId,headSha,name,status,conclusion,url,createdAt,workflowName',
  ]);

  let runs;
  try {
    runs = listRuns();
  } catch (e) {
    const msg = String(e?.stderr || e?.message || e).split('\n')[0];
    console.error('[ci] 查不到云端 CI（gh 缺失 / 未登录 / 无网络）：' + msg);
    console.error('[ci] 这次**没查成**——不计为失败。修法：安装并 `gh auth login`，或设 GH_TOKEN。');
    process.exitCode = 2;
    return;
  }

  const report = (extra) => {
    const headShort = head.slice(0, 7);
    const mine = runs.filter((r) => String(r.headSha) === head);
    const latestAny = runs.slice().sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))[0];
    const reds = runs.filter((r) => RED.has(String(r.conclusion))).map(summarize);
    const out = {
      branch, head: headShort, checkedAt: new Date().toISOString(),
      headRuns: mine.map(summarize),
      latestRun: latestAny ? summarize(latestAny) : null,
      reds,
      ...extra,
    };
    if (asJson) console.log(JSON.stringify(out, null, 2));
    else {
      console.log('[ci] 分支 ' + branch + ' @ ' + headShort + '（云端 GitHub Actions，经 gh）');
      if (latestAny) {
        console.log('    最近一次 run ：' + summarize(latestAny).name + ' → ' + (latestAny.conclusion || latestAny.status)
          + '（' + String(latestAny.headSha).slice(0, 7) + '）' + (latestAny.url ? '  ' + latestAny.url : ''));
      }
      if (mine.length) for (const r of mine.map(summarize)) console.log('    本次 HEAD 的 run：' + r.name + ' → ' + (r.conclusion || r.status) + (r.url ? '  ' + r.url : ''));
      else console.log('    本次 HEAD 还没有 run（可能尚未推送，或工作流未覆盖该分支）');
      if (reds.length) {
        console.log('[ci] ✖ 有 ' + reds.length + ' 个失败 run —— 自己先看，不要等人提醒：');
        for (const r of reds) console.log('    · ' + r.name + ' @' + r.sha + ' → ' + r.conclusion + '  ' + r.url);
      } else console.log('[ci] ✔ 最近 20 个 run 里没有失败');
    }
    return out;
  };

  // 先给一次即时读数（即使不 --wait 也有信息量）。
  let out = report();
  const headRun = out.headRuns.find((r) => RED.has(String(r.conclusion)))
    || out.headRuns.find((r) => String(r.status) === 'completed');

  if (!wait || (headRun && String(headRun.status) === 'completed')) {
    // 已有结论（或不需要等）：红了就退 1。
    const headRed = out.headRuns.some((r) => RED.has(String(r.conclusion)));
    if (headRed) process.exitCode = 1;
    else if (out.reds.length && !out.headRuns.length) {
      // HEAD 没 run，但分支上有红：提示但不判死（历史红不该拦新提交）。
      if (!asJson) console.log('[ci] 注意：分支上有历史失败 run（见上），与本次 HEAD 无关。');
      process.exitCode = 0;
    } else process.exitCode = 0;
    return;
  }

  // --wait：轮询到 HEAD 的 run 落定，或超时。
  const deadline = Date.now() + timeoutSec * 1000;
  if (!asJson) console.log('[ci] 等本次 HEAD 的 run 落定（最多 ' + timeoutSec + 's）…');
  while (Date.now() < deadline) {
    try {
      runs = listRuns();
    } catch (e) { /* 轮询期间的网络抖动：继续等 */ }
    out = report({ waiting: true });
    const mine = out.headRuns;
    const done = mine.filter((r) => String(r.status) === 'completed');
    if (done.length && mine.every((r) => String(r.status) === 'completed')) {
      const red = done.some((r) => RED.has(String(r.conclusion)));
      if (!asJson) console.log('[ci] ' + (red ? '✖ 本次 HEAD 的 CI 失败' : '✔ 本次 HEAD 的 CI 通过'));
      process.exitCode = red ? 1 : 0;
      return;
    }
    execFileSync(process.execPath, ['-e', 'setTimeout(()=>{}, ' + (15 * 1000) + ')']);
  }
  if (!asJson) console.log('[ci] 超时：本次 HEAD 的 run 还没落定（不是失败，只是没等到）');
  process.exitCode = 2;
}

main();
