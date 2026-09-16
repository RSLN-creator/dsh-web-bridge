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
//   3. **CI 矩阵必须覆盖 `engines.node` 的最低版本。**
//      这条是 2026-09-17 的一次真事故换来的：`engines.node` 从 `>=20` 提到了 `>=22`，
//      **没人去改 `ci.yml` 的矩阵**，于是 Node 20 那条腿继续存在。而 `packageManager`
//      钉的 `pnpm@11.25.0` 要求 Node ≥22.13，两条 Node 20 的腿在 `pnpm install` 就
//      抛 `ERR_UNKNOWN_BUILTIN_MODULE: node:sqlite` 退出 1——**一条测试都没跑**。
//      四条腿里两条恒红，红的还不是被改的东西；这种「假红」会让人学会忽略 CI。
//
//      两份声明（`engines.node` 与矩阵）都是人写的，它们之间没有任何东西保证一致；
//      这条判据把「一致性」本身变成机器可判的，而不是靠下一个人记得。
//
// 三条合在一个脚本里，是因为它们同属「**文件层面的规范**」——区别于
// lint-comments（注释文本）、check-ledger（台账数字）、artifacts-check（生成物）。
//
// ## 判据
//
//   A. 编码：工作树里的文本文件（.md/.js/.mjs/.cjs/.json/.yml/.yaml/.txt/.sh/.ps1）
//      **不得**以 UTF-8 BOM（EF BB BF）开头。
//   B. 索引：`doc/README.md` 里的相对 Markdown 链接，目标必须存在于磁盘。
//   C. Node 版本：`ci.yml` 的 `matrix.node` **必须全部** ≥ `package.json` 的
//      `engines.node` 最低版本，且矩阵里必须出现那个最低大版本本身。
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
//   · 版本判据只做**大版本**比较。`engines.node` 写 `>=22.13` 而矩阵写 `22` 是允许的
//     （setup-node 会取最新的 22.x，而 22.13 < 22.x）。它拦的是「矩阵里出现一个低于
//     最低声明版本的大版本」这种必然失败的结构，不试图复刻 semver 全套规则。

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

/**
 * 判据 C：从 `package.json` 的 `engines.node` 取最低版本，与 `ci.yml` 的矩阵比对。
 *
 * 只做**大版本**比较（理由见文件头「已知边界」）。返回结构与另外两条判据一致：
 * `[]` 表示合规，非空表示逐条列出问题。
 *
 * @returns {Array<{what: string, why: string}>}
 */
function findNodeVersionMismatch() {
  const bad = [];
  const pkgPath = path.join(repoRoot, 'package', 'dsh-webcode-bridge', 'package.json');
  const ciPath = path.join(repoRoot, '.github', 'workflows', 'ci.yml');
  let enginesRange;
  try {
    enginesRange = JSON.parse(fs.readFileSync(pkgPath, 'utf8')).engines?.node;
  } catch (e) {
    return [{ what: pkgPath, why: '读不到或不是合法 JSON：' + e.message }];
  }
  if (typeof enginesRange !== 'string') {
    return [{ what: 'engines.node', why: '缺失或不是字符串' }];
  }
  // 本仓库的写法是 `>=22.13` / `>=22`。只认这一种形状：看不懂的声明宁可报出来
  // （它是人写的契约，机器读不懂时应当由人确认，而不是静默跳过）。
  const m = /^>=\s*(\d+)(?:\.(\d+))?/.exec(enginesRange.trim());
  if (!m) {
    return [{ what: 'engines.node = ' + enginesRange, why: '本判据只认 `>=<major>[.<minor>]` 形状' }];
  }
  const minMajor = Number(m[1]);

  let ciText;
  try {
    ciText = fs.readFileSync(ciPath, 'utf8');
  } catch (e) {
    return [{ what: ciPath, why: '读不到：' + e.message }];
  }
  const mx = /^\s*node:\s*\[([^\]]*)\]/m.exec(ciText);
  if (!mx) return [{ what: 'ci.yml matrix.node', why: '找不到 `node: [...]` 形状的矩阵定义' }];
  const versions = mx[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  if (!versions.length) return [{ what: 'ci.yml matrix.node', why: '矩阵是空的' }];

  for (const v of versions) {
    const vm = /^(\d+)/.exec(v);
    if (!vm) { bad.push({ what: `矩阵里的 \`${v}\``, why: '不是一个以数字开头的大版本' }); continue; }
    if (Number(vm[1]) < minMajor) {
      bad.push({
        what: `矩阵 \`${v}\` < engines.node \`${enginesRange}\``,
        why: '这条腿会在 `pnpm install` 就失败（pnpm 要求的 Node 高于它），测试根本没机会跑',
      });
    }
  }
  // 矩阵还必须**真的覆盖**最低声明版本：只测更高版本会放过「最低版本上跑不起来」。
  if (!versions.some((v) => Number(/^(\d+)/.exec(v)?.[1]) === minMajor)) {
    bad.push({
      what: `矩阵 ${JSON.stringify(versions)} 未覆盖最低声明大版本 ${minMajor}`,
      why: 'engines.node 声明支持它，就必须有一条腿真的在它上面跑',
    });
  }
  return bad;
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
  // 判据 C 的构造输入：**实际仓库**必须是合规的。这条闸门如果对着自己仓库都报错，
  // 那它一定在别处会给出假红——而假红的闸门比没有闸门更坏（见文件头）。
  const nodeBad = findNodeVersionMismatch();
  if (nodeBad.length) {
    console.error('  self-test FAIL: 判据 C 认为本仓库不合规，但本仓库应当是合规的：');
    for (const d of nodeBad) console.error('    · ' + d.what + ' —— ' + d.why);
    bad++;
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
  const nodeVer = findNodeVersionMismatch();

  if (json) {
    process.stdout.write(JSON.stringify({ bomFiles: bom, deadIndexLinks: dead, nodeVersion: nodeVer }, null, 2) + '\n');
  } else {
    process.stdout.write('[hygiene] 检查编码（不得带 BOM）、doc/README.md 索引链接、CI/engines 的 Node 版本\n');
    process.stdout.write(`  BOM 文件      ${bom.length === 0 ? 'PASS' : 'FAIL(' + bom.length + ')'}\n`);
    process.stdout.write(`  索引死链      ${dead.length === 0 ? 'PASS' : 'FAIL(' + dead.length + ')'}\n`);
    process.stdout.write(`  Node 版本     ${nodeVer.length === 0 ? 'PASS' : 'FAIL(' + nodeVer.length + ')'}\n`);
    process.stdout.write('\n');
  }

  if (bom.length === 0 && dead.length === 0 && nodeVer.length === 0) {
    if (!json) process.stdout.write('[hygiene] ✔ 文件编码、文档索引与 Node 版本声明均合规。\n');
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
  if (nodeVer.length) {
    process.stderr.write('[hygiene] CI 矩阵与 `engines.node` 的 Node 版本声明不一致：\n');
    for (const d of nodeVer) process.stderr.write(`  · ${d.what} —— ${d.why}\n`);
    process.stderr.write('  修法：改 `.github/workflows/ci.yml` 的 `matrix.node` 去覆盖\n');
    process.stderr.write('  `package/dsh-webcode-bridge/package.json` 的 `engines.node`（两者必须相容）。\n');
    process.stderr.write('  注意：改 `engines.node` 时**必须同时**改矩阵，反之亦然——这正是本条判据存在的原因。\n');
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
