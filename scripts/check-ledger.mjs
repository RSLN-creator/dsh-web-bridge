#!/usr/bin/env node
// check-ledger.mjs — 让「台账过期」变成红灯，而不是靠人自觉。
//
// ## 为什么需要这个文件
//
// `doc/progress.md` 开头自己定的约定是「**每完成一项即更新这里**」。这条约定已经失败三次：
// `doc/long-term-issues.md` §2.3 抓到过一次，2026-09-16 的状态复核又抓到一次
// （当时 `progress.md` 的「当前状态」表**四行全过期**，且 0.15.4/0.15.5 两轮工作
// **整段没有台账**）。三次都是「代码做完了，账没记」。
//
// 靠自觉的约定失败三次之后，正确的反应不是「下次注意」，而是**换一种机制**：
// 台账里那些**机器可判**的字段（版本号、测试文件数）不再靠人抄，而是由本脚本
// 从**事实来源**现读、与台账逐字比对，不一致就退出 1。
//
// ## 判据（每一项都是「事实来源 vs 台账」的比对，不是抄一遍）
//
//   1. `package/dsh-webcode-bridge/package.json` 的 `version`
//      vs `progress.md`「当前状态」表里 `工作树版本` 一格里的版本号。
//   2. `package/dsh-webcode-bridge/test/` 下 `*.test.mjs` 的**实际个数**
//      vs `单测基线` 一格里的 `N/N`（两个数都必须等于实际个数——写成 `35/35` 而实际是
//      38 个文件时，那一格的含义已经没了）。
//
// ## 刻意不做的事
//
//   · **不自动改写 `progress.md`**。台账的价值在于「有人读过并写下了它」；让脚本回填
//     版本号，等于把「记账」降级成「改一个数字」，而真正的欠账（整轮工作没有段落）
//     照样不会被发现。本脚本只负责**报警**，不负责代笔。
//   · **不用 `spawnSync` 去问 git**。本机实测 Node 里 `spawnSync` 调用任何外部程序都
//     `EPERM`（见 `doc/progress.md`「已知环境约束」），那会让本闸门在本机变成空转——
//     而**空转的闸门比没有闸门更坏**，它给的是「检查过了」的错觉。纯 `fs` 读文件
//     在本机与 CI 上行为一致。
//   · **不引第三方依赖**。与 `scripts/lint-comments.mjs`、`test-mock/artifacts-check.mjs`
//     同一传统：可直接 `node` 运行的独立工具。
//
// ## 用法
//
//   node scripts/check-ledger.mjs            # 人读输出
//   node scripts/check-ledger.mjs --json     # 机读输出（CI 归档）
//
// 退出码：0 = 台账与事实一致；1 = 有不一致项；2 = 脚本自身出错（读不到文件等）。
//
// ## 已知边界（宁可漏报也不制造假红）
//
// 只比「机器能判的两格」。台账里其他内容——「上游」「注释闸门」「下一阶段」以及
// **每一轮工作的段落是否写了**——本脚本**判不了**，那部分仍需人写。因此本闸门全绿
// **不等于**台账完整，它只保证「不会出现抄错的版本号与测试数」这一族不再复发。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const pkgDir = path.join(repoRoot, 'package', 'dsh-webcode-bridge');

const PKG_JSON = path.join(pkgDir, 'package.json');
const TEST_DIR = path.join(pkgDir, 'test');
const PROGRESS = path.join(repoRoot, 'doc', 'progress.md');

/** 从 markdown 表格里取某一行的「值」单元格。表格形状是 `| 项 | 值 |`。 */
function tableCell(md, rowLabel) {
  // 行首允许有空白；标签与分隔符之间允许有空格；值单元格取到该行最后一个 `|` 之前。
  const re = new RegExp('^\\|\\s*' + rowLabel + '\\s*\\|(.+?)\\|\\s*$', 'm');
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

/** 取字符串里第一个 `x.y.z` 形状的版本号。 */
function firstVersion(s) {
  const m = String(s).match(/\d+\.\d+\.\d+/);
  return m ? m[0] : null;
}

function readJsonVersion() {
  const raw = fs.readFileSync(PKG_JSON, 'utf8');
  const v = JSON.parse(raw).version;
  return typeof v === 'string' ? v : null;
}

function countTestFiles() {
  return fs.readdirSync(TEST_DIR).filter((f) => f.endsWith('.test.mjs')).length;
}

function main() {
  const json = process.argv.includes('--json');
  const problems = [];
  const results = [];

  if (!fs.existsSync(PROGRESS)) {
    process.stderr.write('[ledger] 读不到 ' + PROGRESS + '\n');
    return 2;
  }

  const md = fs.readFileSync(PROGRESS, 'utf8');
  const actualVersion = readJsonVersion();
  const actualTests = countTestFiles();

  // ---- 判据 1：版本号 ----
  const versionCell = tableCell(md, '工作树版本');
  const ledgerVersion = versionCell === null ? null : firstVersion(versionCell);
  let versionOk = false;
  if (versionCell === null) {
    problems.push('`progress.md` 的「当前状态」表里找不到 `工作树版本` 一行。');
  } else if (ledgerVersion === null) {
    problems.push('`工作树版本` 一格（' + versionCell + '）里没有 `x.y.z` 形状的版本号。');
  } else if (ledgerVersion !== actualVersion) {
    problems.push(
      '版本号不一致：package.json = ' + actualVersion + '，台账 = ' + ledgerVersion
      + '。台账那一行是 `' + versionCell + '`。',
    );
  } else {
    versionOk = true;
  }
  // 显示用：台账那一格保留原文（含加粗等 markdown），但判定只看抽出的版本号。
  results.push({ item: 'version', actual: actualVersion, ledger: ledgerVersion, ok: versionOk });

  // ---- 判据 2：测试文件数 ----
  const testsCell = tableCell(md, '单测基线');
  let ledgerTests = null;
  let testsOk = false;
  if (testsCell === null) {
    problems.push('`progress.md` 的「当前状态」表里找不到 `单测基线` 一行。');
  } else {
    const m = testsCell.match(/(\d+)\s*\/\s*(\d+)/);
    if (!m) {
      problems.push('`单测基线` 一格（' + testsCell + '）里没有 `N/N` 形状的计数。');
    } else {
      ledgerTests = m[0];
      const a = Number(m[1]);
      const b = Number(m[2]);
      if (a !== b) {
        // `N/N` 的两个数不相等时，这一格的含义已经没了——它到底想说几个？
        problems.push('`单测基线` 写成 ' + m[0] + '，两个数不相等——这一格记不下「几个通过」。');
      } else if (a !== actualTests) {
        problems.push(
          '测试文件数不一致：test/ 下实际 ' + actualTests + ' 个 `*.test.mjs`，台账写 ' + m[0] + '。',
        );
      } else {
        testsOk = true;
      }
    }
  }
  results.push({ item: 'testFiles', actual: actualTests, ledger: ledgerTests, ok: testsOk });

  if (json) {
    process.stdout.write(JSON.stringify({
      ok: problems.length === 0,
      repoRoot,
      results,
      problems,
    }, null, 2) + '\n');
  } else {
    process.stdout.write('[ledger] 仓库：' + repoRoot + '\n');
    for (const r of results) {
      // 判定用**抽出来的值**，显示用同一个抽出来的值，二者不再可能不一致。
      process.stdout.write(
        '  ' + (r.ok ? 'PASS' : 'FAIL')
        + '  ' + r.item.padEnd(10) + ' 事实=' + String(r.actual).padEnd(10)
        + ' 台账=' + String(r.ledger) + '\n',
      );
    }
    process.stdout.write('\n');
  }

  if (problems.length) {
    process.stderr.write('[ledger] 台账与事实不一致（' + problems.length + ' 项）：\n');
    for (const p of problems) process.stderr.write('  · ' + p + '\n');
    process.stderr.write('\n');
    process.stderr.write('[ledger] 修复方向：改 `doc/progress.md` 的「当前状态」表，让它与事实一致；\n');
    process.stderr.write('[ledger] 不要改本脚本去迁就台账——这个闸门的全部价值就在于它不迁就。\n');
    return 1;
  }

  if (!json) {
    process.stdout.write('[ledger] ✔ 台账与事实一致（版本 ' + actualVersion + '，'
      + actualTests + ' 个测试文件）。\n');
    process.stdout.write('[ledger] 注意：本闸门只覆盖「机器可判的两格」，'
      + '每轮工作的段落是否写了仍需人写。\n');
  }
  return 0;
}

let code = 2;
try {
  code = main();
} catch (e) {
  // 脚本自身出错必须是 2，不能伪装成「台账不一致」（1）：两者的处理方式完全不同。
  process.stderr.write('[ledger] 脚本自身失败：' + (e && e.stack ? e.stack : e) + '\n');
  code = 2;
}
process.exit(code);