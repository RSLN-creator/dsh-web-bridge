#!/usr/bin/env node
// check-long-term-issues.mjs — 让「一览表」与正文条目**对得上**变成红灯，而不是靠人自觉。
//
// ## 为什么需要这个文件
//
// `doc/long-term-issues.md` 有两份「同一事实」的副本：开头的**一览表**（表格，人先读的那份）
// 与下面的**正文条目**（`## <号>. …`，唯一有权写「已修 / 未修」的地方）。两者一旦不同步，
// 读者就会拿到**错的**状态：2026-09-16 实测到过一次（正文有条目、表里没有），当时在表下
// 加了一段说明并把缺口写进 `doc/diagnosis-2026-09-16.md` §6.2 的 P1 排期——**但那条闸门
// 从来没有被建出来**。于是同一族缺陷又复发了一次（2026-09-26 实测：#26 正文已写「0.16.11
// 已修」而表里仍是「未修」；#27 有正文条目、表里根本没有这一行）。
//
// 靠自觉的约定失败两次之后，正确的反应不是「下次注意」，而是**换一种机制**：
// 让「表 ↔ 正文」的一致性由本脚本现读现比，不一致就退出 1。
//
// ## 判据（三条，全部是「两份副本互相比对」，不是抄一遍）
//
//   1. **正文 → 表**：每个 `## <号>. …` 条目，一览表里必须有同号的行。
//   2. **表 → 正文**：一览表里每个条目行，正文里必须有同号的 `##` 标题
//      （`10b` 这类**子条目**豁免——它自己的行里写明「正文见 §10」，见下）。
//   3. **状态不矛盾**：正文标题已宣告修好（含「已修 / 已修复 / 已解决 / 已实现」）时，
//      一览表那一行不得仍写「未修」。
//
// 判据 3 只抓**确定性矛盾**，不判「措辞是否够新」：正文标题写「大幅收口」这类**非终局**
// 措辞时本脚本不表态（它无法区分「收口了但没修完」与「只是换了个说法」）。宁可漏报也不
// 制造假红——**假红的闸门会被人整体绕过，比没有闸门更坏**（与 `check-ledger.mjs` 拒绝
// 用 `spawnSync`、`gen-reference-index.mjs` 只校验「本机存在的条目」是同一条立场）。
//
// ## 刻意不做的事
//
//   · **不自动改写 `long-term-issues.md`**。一览表的价值在于「有人读过并写下了它」；
//     让脚本回填状态，等于把「判读」降级成「改一个格子」，而真正该判的
//     「这条到底修没修完」照样没人判。本脚本只负责**报警**，不负责代笔。
//   · **不用 `spawnSync` 去问 git**。本机实测 Node 里 `spawnSync` 调用任何外部程序都
//     `EPERM`（见 `doc/progress.md`「已知环境约束」），那会让本闸门在本机变成空转。
//     纯 `fs` 读文件在本机与 CI 上行为一致。
//   · **不引第三方依赖**。与 `scripts/check-ledger.mjs`、`scripts/check-plugin-contract.mjs`
//     同一传统：可直接 `node` 运行的独立工具。
//
// ## 用法
//
//   node scripts/check-long-term-issues.mjs             # 人读输出
//   node scripts/check-long-term-issues.mjs --json      # 机读输出（CI 归档）
//   node scripts/check-long-term-issues.mjs --self-test # 自检判据（正反例都对才退 0）
//
// 退出码：0 = 表与正文一致；1 = 有不一致项；2 = 脚本自身出错（读不到文件等）。
//
// ## 为什么要有 --self-test
//
// 本闸门的判据是**正则 + 集合比对**，而它要判的东西（「正文标题算不算宣告修好」）
// 本身是措辞。措辞判据最典型的失效形态不是「报错」，而是**悄悄不再匹配任何东西**
// ——那时它会一路 PASS，看起来比谁都干净。
//
// `scripts/check-commit-msg.mjs` 已经为同一问题给出了本仓库的做法（`--self-test`：
// 正例必须过、反例必须红）。本脚本照抄那个形状：自检**不读真实文档**，只用内置的
// 微型 markdown 逐条打判据，因此它判的是「判据还在不在」，而不是「今天这份文档如何」。
// 两者缺一不可：只有前者，判据会漂移；只有后者，判据会静默失效。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const DOC = path.join(repoRoot, 'doc', 'long-term-issues.md');

/**
 * 正文条目的号。形如 `## 25. **标题**…` 或 `## 10b. …`。
 *
 * 为什么要求标题行**必须有 `<号>.` 前缀**而不是「任意 `##`」：本文件里还有 `## 一览表`
 * 这类结构性小节，它们不是条目，不该被要求出现在表里。用「号 + 点」这个形状把它们挡在外面。
 */
const BODY_HEAD_RE = /^##\s+(\d+b?)\.\s+(.*)$/;

/** 一览表的数据行。形如 `| 25 | **标题** | 高 | 否 | `a.js` |`。 */
const TABLE_ROW_RE = /^\|\s*(\d+b?)\s*\|(.+)$/;

/**
 * 一览表里**只属于它自己**的行：表头与分隔行。
 * `\d+b?` 的形状已经把它们排除了，这里再写一层是为了让「表里有几行」这个读数
 * 不被表头污染——读数是拿给人看的，不该混进两类东西。
 */
const TABLE_SKIP_RE = /^\|\s*(#|\-{2,})/;

/**
 * 子条目豁免的判据：行内自己写明「正文见 §X」。
 *
 * `10b` 是 `#10` 的子条目，它在正文里没有独立的 `## 10b.` 标题（正文见 §10 的「10b」小节）。
 * 这种条目**本来就该**只出现在表里，把它算成「表里有、正文没有」是假红。
 * 判据写在**行自己身上**而不是硬编码 `10b`：下一个子条目不必回来改脚本。
 */
const SUBENTRY_RE = /正文见\s*§/;

/**
 * 正文标题里宣告「这条已经修好」的措辞。
 *
 * 刻意**只收终局措辞**：「收口」「归因落定」「部分解决」都不在其中——它们既可能意味着
 * 「修完了」也可能意味着「只是缩小了范围」，机器判不了，硬判就是猜。
 */
const FIXED_MARKERS = ['已修', '已修复', '已解决', '已实现'];

/** 表里宣告「还没修」的措辞。 */
const UNFIXED_MARKER = '未修';

/** 解析出正文条目的 `{ num, title, line }`。 */
function parseBody(md) {
  const out = [];
  const lines = md.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const m = BODY_HEAD_RE.exec(lines[i]);
    if (m) out.push({ num: m[1], title: m[2].trim(), line: i + 1 });
  }
  return out;
}

/**
 * 解析出一览表的数据行 `{ num, cells, raw, line }`。
 *
 * 只收**第一个表格块**里的行：本文件在表格之后还有别的表格（各条目的「口径」表），
 * 若一路扫到底，`| 项 | 值 |` 那种两列小表会被当成条目行——它们的首格不是号，
 * 被 `\d+b?` 挡住了，但「扫到第一个空行为止」让这个边界更明确。
 */
function parseTable(md) {
  const out = [];
  const lines = md.split(/\r?\n/);
  let started = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = TABLE_ROW_RE.exec(line);
    if (m && !TABLE_SKIP_RE.test(line)) {
      started = true;
      out.push({
        num: m[1],
        cells: line.split('|').slice(1, -1).map((c) => c.trim()),
        raw: line.trim(),
        line: i + 1,
      });
      continue;
    }
    if (started && line.trim() === '') break; // 第一个表格块结束
  }
  return out;
}

/** 取表格行的「标题」格（第 2 格，索引 1）。表头行与残缺行返回空串。 */
function rowTitle(row) {
  return row.cells.length >= 2 ? row.cells[1] : '';
}

/**
 * 纯函数：拿一份 markdown 文本，返回一致性的全部读数与问题清单。
 *
 * 之所以是**纯函数**而不是把逻辑留在 `main()` 里：`--self-test` 必须能用**内置的**
 * 微型 markdown 反复打同一套判据，而它绝不能去读真实文档（那会让自检的结论随文档
 * 内容变化，失去「判据还在不在」的判定力）。
 *
 * @param {string} md 文档全文
 * @returns {{body: Array, table: Array, problems: string[], missingRows: Array, orphanRows: Array, contradictions: Array}}
 */
function analyze(md) {
  const problems = [];
  const body = parseBody(md);
  const table = parseTable(md);

  const bodyNums = new Set(body.map((b) => b.num));
  const tableNums = new Set(table.map((t) => t.num));

  // ---- 判据 1：正文有条目 → 表里必须有行 ----
  const missingRows = body.filter((b) => !tableNums.has(b.num));
  for (const b of missingRows) {
    problems.push(
      '正文第 ' + b.line + ' 行有条目 `#' + b.num + '`（' + b.title + '），'
      + '但一览表里没有这一行——表是读者先看到的那份，缺行等于这条欠账不可见。',
    );
  }

  // ---- 判据 2：表里有行 → 正文必须有条目（子条目豁免）----
  const orphanRows = table.filter((t) => !bodyNums.has(t.num) && !SUBENTRY_RE.test(rowTitle(t)));
  for (const t of orphanRows) {
    problems.push(
      '一览表第 ' + t.line + ' 行有 `#' + t.num + '`，但正文里没有 `## ' + t.num + '.` 标题，'
      + '且该行没有写明「正文见 §…」——表指向了一个不存在的条目。',
    );
  }

  // ---- 判据 3：状态不矛盾 ----
  const contradictions = [];
  for (const t of table) {
    const title = rowTitle(t);
    if (!title.includes(UNFIXED_MARKER)) continue;
    const b = body.find((x) => x.num === t.num);
    if (!b) continue; // 缺行已由判据 1/2 报过，不重复报
    const hit = FIXED_MARKERS.find((k) => b.title.includes(k));
    if (!hit) continue;
    contradictions.push({ num: t.num, tableLine: t.line, bodyLine: b.line, marker: hit, bodyTitle: b.title });
    problems.push(
      '状态矛盾：一览表第 ' + t.line + ' 行 `#' + t.num + '` 写「' + UNFIXED_MARKER + '」，'
      + '而正文第 ' + b.line + ' 行的标题已宣告「' + hit + '」——两份副本说的是相反的事。',
    );
  }

  return { body, table, problems, missingRows, orphanRows, contradictions };
}

/**
 * 自检：用内置微型 markdown 逐条打判据。正例必须过、每个反例必须各自变红。
 *
 * 三条反例**分别只违反一条判据**（缺行 / 孤儿行 / 状态矛盾），因此哪一条判据被
 * 改坏都会在这里被抓出来——一个「只要有任何问题就返回非空」的断言区分不了它们。
 *
 * 反例里刻意包含一个**必须不报**的形态：`## 一览表` 这类结构性小节，以及
 * 带「正文见 §」的子条目。它们若被判成问题，闸门就会在**正确的文档**上恒红。
 */
function selfTest() {
  const CASES = [
    {
      name: '正例：表与正文一致',
      md: [
        '## 一览表',
        '',
        '| # | 条目 | 严重度 |',
        '| --- | --- | --- |',
        '| 1 | 甲 | 高 |',
        '| 2 | **乙**（**已修**） | 高 |',
        '| 10 | 丙 | 低 |',
        '| 10b | 子条目，正文见 §10 的小节 | 低 |',
        '',
        '## 1. 甲：未归因',
        '',
        '## 2. 乙：**已修**',
        '',
        '## 10. 丙',
      ].join('\n'),
      expect: [],
    },
    {
      name: '反例：正文有条目、表里缺行',
      md: [
        '## 一览表',
        '',
        '| # | 条目 |',
        '| --- | --- |',
        '| 1 | 甲 |',
        '',
        '## 1. 甲',
        '',
        '## 2. 乙',
      ].join('\n'),
      expect: ['missing:2'],
    },
    {
      name: '反例：表里有行、正文无条目（且非子条目）',
      md: [
        '## 一览表',
        '',
        '| # | 条目 |',
        '| --- | --- |',
        '| 1 | 甲 |',
        '| 9 | 幽灵条目 |',
        '',
        '## 1. 甲',
      ].join('\n'),
      expect: ['orphan:9'],
    },
    {
      name: '反例：状态矛盾（表「未修」／正文「已修」）',
      md: [
        '## 一览表',
        '',
        '| # | 条目 |',
        '| --- | --- |',
        '| 1 | 甲（**未修**） |',
        '',
        '## 1. 甲：**已修**',
      ].join('\n'),
      expect: ['contradiction:1'],
    },
    {
      name: '反例：表里写「未修」但正文用非终局措辞（大幅收口）——不得误报',
      md: [
        '## 一览表',
        '',
        '| # | 条目 |',
        '| --- | --- |',
        '| 1 | 甲（**未修**） |',
        '',
        '## 1. 甲：0.16.11 起**大幅收口**，残余形态未修',
      ].join('\n'),
      expect: [],
    },
  ];

  const failures = [];
  for (const c of CASES) {
    const r = analyze(c.md);
    const got = [];
    for (const b of r.missingRows) got.push('missing:' + b.num);
    for (const t of r.orphanRows) got.push('orphan:' + t.num);
    for (const x of r.contradictions) got.push('contradiction:' + x.num);
    const want = c.expect.slice().sort();
    const have = got.slice().sort();
    if (JSON.stringify(want) !== JSON.stringify(have)) {
      failures.push(c.name + '\n      期望: [' + want.join(', ') + ']\n      实得: [' + have.join(', ') + ']');
    }
  }

  if (failures.length) {
    process.stderr.write('[lti] 自检失败（' + failures.length + '/' + CASES.length + ' 个用例）：\n');
    for (const f of failures) process.stderr.write('  · ' + f + '\n');
    process.stderr.write('[lti] 判据已经漂移。修 scripts/check-long-term-issues.mjs，不要改用例去迁就实现。\n');
    return 1;
  }
  process.stdout.write('[lti] ✔ 自检通过（' + CASES.length + ' 个用例：正例 1、反例 4）。\n');
  return 0;
}

function main() {
  const json = process.argv.includes('--json');

  if (process.argv.includes('--self-test')) return selfTest();

  if (!fs.existsSync(DOC)) {
    process.stderr.write('[lti] 读不到 ' + DOC + '\n');
    return 2;
  }
  const { body, table, problems, missingRows, orphanRows, contradictions } = analyze(fs.readFileSync(DOC, 'utf8'));

  const summary = {
    ok: problems.length === 0,
    bodyEntries: body.length,
    tableRows: table.length,
    missingRows: missingRows.map((b) => b.num),
    orphanRows: orphanRows.map((t) => t.num),
    contradictions: contradictions.map((c) => c.num),
  };

  if (json) {
    process.stdout.write(JSON.stringify({ ...summary, problems }, null, 2) + '\n');
  } else {
    process.stdout.write('[lti] 文档：' + DOC + '\n');
    process.stdout.write('  正文条目 ' + body.length + ' 个；一览表 ' + table.length + ' 行\n');
    process.stdout.write('  ' + (missingRows.length ? 'FAIL' : 'PASS') + '  正文→表（缺行 '
      + missingRows.length + ' 个）\n');
    process.stdout.write('  ' + (orphanRows.length ? 'FAIL' : 'PASS') + '  表→正文（孤儿行 '
      + orphanRows.length + ' 个）\n');
    process.stdout.write('  ' + (contradictions.length ? 'FAIL' : 'PASS') + '  状态不矛盾（矛盾 '
      + contradictions.length + ' 处）\n\n');
  }

  if (problems.length) {
    process.stderr.write('[lti] 一览表与正文不一致（' + problems.length + ' 项）：\n');
    for (const p of problems) process.stderr.write('  · ' + p + '\n');
    process.stderr.write('\n');
    process.stderr.write('[lti] 修复方向：改 `doc/long-term-issues.md`，让一览表与正文两份副本一致；\n');
    process.stderr.write('[lti] 不要改本脚本去迁就它——这个闸门的全部价值就在于它不迁就。\n');
    return 1;
  }

  if (!json) {
    process.stdout.write('[lti] ✔ 一览表与正文一致（' + body.length + ' 个条目）。\n');
    process.stdout.write('[lti] 注意：本闸门只判「两份副本是否自洽」，不判「每条的结论是否正确」。\n');
  }
  return 0;
}

let code = 2;
try {
  code = main();
} catch (e) {
  // 脚本自身出错必须是 2，不能伪装成「文档不一致」（1）：两者的处理方式完全不同。
  process.stderr.write('[lti] 脚本自身失败：' + (e && e.stack ? e.stack : e) + '\n');
  code = 2;
}
process.exit(code);
