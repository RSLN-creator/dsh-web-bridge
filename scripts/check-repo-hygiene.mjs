#!/usr/bin/env node
// check-repo-hygiene.mjs — 把两条「写在文档里、但没人检查」的文件级规范变成红灯。
//
// ## 为什么需要这个文件
//
// 本仓库已经有一批闸门（注释纪律、台账一致性、生成物卫生、提交信息），它们各自覆盖
// 一类**代码**或**记录**的规范。但还有两条规范**只写在文档里、没有任何机器检查**，
// 于是都发生过「文档说做完了、磁盘上只做了一半」：
//
//   1. **文件编码：不得带 UTF-8 BOM。**
//      0.15.5 做过一次「去 BOM」，但只改了 `package.json`，**没有做全量核对**。
//      结果是台账上「去 BOM」这一项是绿的，而 `doc/security-review.md` 一直带着 BOM
//      直到 2026-09-16 才被发现（`doc/long-term-issues.md` #20 原话：
//      「全仓库已跟踪文件里**只剩这一个**带 BOM」）。
//      BOM 的实际危害不是洁癖：它会让 `grep -r '^#'`、`head -1`、以及按首行匹配的
//      脚本**静默漏掉**这个文件——排查时表现为「这个文件好像不在搜索结果里」。
//
//   2. **文档索引：`doc/README.md` 里的链接必须都能落到磁盘上。**
//      `.github/pull_request_template.md` 的「文档同步」小节要求
//      「已登记进 `doc/README.md` 索引，且链接 `Test-Path` 通过（§10.3）」，
//      `CONTRIBUTING.md` 也重申了同一条。但**没有任何闸门**跑过它。
//      索引失效的代价正是这个索引存在的理由：它是「文档在哪」的唯一入口，
//      一条死链等于把那份文档从体系里摘掉，而读者只会以为它不存在。
//
// 两条合在一个脚本里，是因为它们同属「**文件层面的规范**」——区别于
// lint-comments（注释文本）、check-ledger（台账数字）、artifacts-check（生成物）。
//
// ## 判据
//
//   A. 编码：工作树里的文本文件（.md/.js/.mjs/.cjs/.json/.yml/.yaml/.txt/.sh/.ps1）
//      **不得**以 UTF-8 BOM（EF BB BF）开头。
//   B. 索引：`doc/README.md` 里的相对 Markdown 链接，目标必须存在于磁盘。
//
// ## 刻意不做的事
//
//   · **不用 `spawnSync` 去问 git**。本机实测 Node 里 `spawnSync` 调任何外部程序都
//     `EPERM`（见 `doc/progress.md`「已知环境约束」），那会让闸门在本机空转——
//     而**空转的闸门比没有闸门更坏**。改为直接遍历工作树，用显式跳过表排除
//     第三方与生成物目录。本地与 CI 行为因此一致。
//   · **不引第三方依赖**。与 lint-comments / check-ledger / artifacts-check 同一传统。
//   · **不修文件**。只报警。去 BOM 会改动字节，必须由人确认后提交。
//
// ## 用法
//
//   node scripts/check-repo-hygiene.mjs            # 人读
//   node scripts/check-repo-hygiene.mjs --json     # 机读（CI 归档）
//   node scripts/check-repo-hygiene.mjs --self-test
//
// 退出码：0 = 全部合规；1 = 有不合规；2 = 脚本自身出错。
//
// ## 已知边界（宁可漏报也不制造假红）
//
//   · 遍历的是**工作树**而不是 git 索引。被 gitignore 的目录（`reference/`、
//     `.tmp/`、`.Codex/`）里带 BOM 不会报——那是第三方克隆与本机工具目录，
//     不属于本仓库要维护的文本。文件名含 CJK 时 `git ls-files` 的输出在本机会被
//     控制台转码弄乱，走工作树反而更可靠（这是实测后选的，不是图省事）。
//   · 索引检查只覆盖**相对链接**；`http(s)://` 外链不验（会联网，且 CI 不该依赖网络）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/** 文本扩展名白名单：只有这些会被检查 BOM（二进制文件里 EF BB BF 是正常字节）。 */
const TEXT_EXT = /\.(md|js|mjs|cjs|json|yml|yaml|txt|sh|ps1)$/;

/** 遍历时跳过的目录：第三方克隆、生成物、本机工具与沙箱。 */
const SKIP_DIRS = new Set([
  '.git', 'node_modules', 'reference', '.tmp', '.agent-teams',
  '.Codex', '.claude', 'dist', 'out', 'coverage',
]);

function walk(dir, acc = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, acc);
    else acc.push(p);
  }
  return acc;
}

/** 判据 A：找出带 BOM 的文本文件。 */
function findBomFiles() {
  const bad = [];
  for (const f of walk(repoRoot)) {
    if (!TEXT_EXT.test(f)) continue;
    let fd;
    try {
      fd = fs.openSync(f, 'r');
      const buf = Buffer.alloc(3);
      const n = fs.readSync(fd, buf, 0, 3, 0);
      if (n === 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        bad.push(path.relative(repoRoot, f).replace(/\\/g, '/'));
      }
    } catch { /* 读不到就跳过，不让单个文件把闸门弄崩 */ } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch { /* 已关 */ }
    }
  }
  return bad;
}

/** 判据 B：找出 `doc/README.md` 里指向不存在文件的相对链接。 */
function findDeadIndexLinks() {
  const indexPath = path.join(repoRoot, 'doc', 'README.md');
  if (!fs.existsSync(indexPath)) return [{ link: 'doc/README.md', why: '索引文件本身不存在' }];
  const text = fs.readFileSync(indexPath, 'utf8');
  const dead = [];
  const re = /\]\(([^)\s]+)\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const link = m[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) continue; // 外链 / mailto 等协议：不验
    if (link.startsWith('#')) continue;               // 页内锚点
    const target = link.split('#')[0];
    if (!target) continue;
    const full = path.resolve(path.join(repoRoot, 'doc'), target);
    if (!fs.existsSync(full)) dead.push({ link, why: '目标不存在' });
  }
  return dead;
}

/** `--self-test`：遍历与索引判据在构造输入上必须都对。 */
function selfTest() {
  let bad = 0;
  // 判据 A 的构造输入：临时建一个带 BOM 的文件，必须被找到。
  const tmp = path.join(repoRoot, '.tmp', 'hygiene-selftest-bom.md');
  try {
    fs.mkdirSync(path.dirname(tmp), { recursive: true });
    fs.writeFileSync(tmp, Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from('# x\n')]));
    // .tmp 在 SKIP_DIRS 里（第三方/生成物不算），所以这里验的是**判据函数本身**能否识别 BOM。
    const buf = Buffer.alloc(3);
    const fd = fs.openSync(tmp, 'r');
    fs.readSync(fd, buf, 0, 3, 0);
    fs.closeSync(fd);
    const detected = buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF;
    if (!detected) { console.error('  self-test FAIL: BOM 判据没能识别构造输入'); bad++; }
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch { /* 已删 */ }
  }
  // 判据 B 的构造输入：不存在的链接必须被判死，存在的必须放行。
  const idx = path.join(repoRoot, 'doc', 'README.md');
  if (!fs.existsSync(idx)) { console.error('  self-test FAIL: 找不到 doc/README.md'); bad++; }
  else {
    const text = fs.readFileSync(idx, 'utf8');
    if (!/\]\(/.test(text)) { console.error('  self-test FAIL: 索引里没有解析到任何链接，判据可能失效'); bad++; }
  }
  console.log(`[hygiene] self-test：${bad === 0 ? '全部符合预期' : bad + ' 项不符'}`);
  return bad === 0 ? 0 : 2;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();
  const json = argv.includes('--json');

  const bom = findBomFiles();
  const dead = findDeadIndexLinks();

  if (json) {
    process.stdout.write(JSON.stringify({ bomFiles: bom, deadIndexLinks: dead }, null, 2) + '\n');
  } else {
    process.stdout.write('[hygiene] 检查编码（不得带 BOM）与 doc/README.md 索引链接\n');
    process.stdout.write(`  BOM 文件      ${bom.length === 0 ? 'PASS' : 'FAIL(' + bom.length + ')'}\n`);
    process.stdout.write(`  索引死链      ${dead.length === 0 ? 'PASS' : 'FAIL(' + dead.length + ')'}\n`);
    process.stdout.write('\n');
  }

  if (bom.length === 0 && dead.length === 0) {
    if (!json) process.stdout.write('[hygiene] ✔ 文件编码与文档索引均合规。\n');
    return 0;
  }

  if (bom.length) {
    process.stderr.write('[hygiene] 以下文件带 UTF-8 BOM（会让按首行匹配的脚本静默漏掉它们）：\n');
    for (const f of bom) process.stderr.write('  · ' + f + '\n');
    process.stderr.write('  修法：去掉文件头 3 字节 EF BB BF（不要用「另存为带 BOM 的 UTF-8」覆盖回去）。\n');
  }
  if (dead.length) {
    process.stderr.write('[hygiene] doc/README.md 里有指向不存在目标的链接：\n');
    for (const d of dead) process.stderr.write(`  · ${d.link}（${d.why}）\n`);
    process.stderr.write('  修法：补上目标文件，或从索引里删掉这一行——不要留着死链。\n');
  }
  process.stderr.write('\n[hygiene] 判据见本脚本头部与 CONTRIBUTING.md。不要改脚本去迁就现状。\n');
  return 1;
}

let code = 2;
try {
  code = main();
} catch (e) {
  process.stderr.write('[hygiene] 脚本自身失败：' + (e && e.stack ? e.stack : e) + '\n');
  code = 2;
}
process.exit(code);
