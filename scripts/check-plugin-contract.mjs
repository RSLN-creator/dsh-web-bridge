#!/usr/bin/env node
// check-plugin-contract.mjs — 把 DSH STORE 收录契约里「机器可判」的四条变成红灯。
//
// ## 为什么需要这个文件
//
// DSH STORE 的目录状态给本插件的是 `blocked`，与源码有关的三条理由是：manifest 的
// `repository` 与 canonical 仓库不一致、manifest 与 GitHub 的许可证元数据不一致、
// 运行依赖需要单独的供应链审查。前两条是**声明层的事实错误**，第三条的一半是
// 「声明了却没有任何运行时代码用它」的死依赖（`ws` 当时就挂在 `dependencies` 里）。
//
// 这三条有一个共同点：**它们都不是代码缺陷，任何单测都不会因为它们变红**。
// 本仓库已经吃过一次同型的亏（见 `scripts/check-ledger.mjs` 文件头：靠自觉的约定
// 失败三次之后要换机制，「记得改 repository」同理——它不是机制）。
//
// ## 判据（四条，与 `doc/permissions-and-boundaries.md` §5 的措辞一一对应）
//
//   1. **仓库指向**：manifest 的 `repository.url` == 本仓库 `origin` 的 URL，且
//      `repository.directory` == 该 manifest 相对仓库根的**实际**目录。
//   2. **许可证三处一致**：根 `LICENSE` 与包内 `LICENSE` **字节相同**；`license`
//      字段与许可文本自称的许可一致；**正文与标准 MIT 模板逐字一致**（多插一段说明会让
//      GitHub 的许可识别把 `spdx_id` 打成 `NOASSERTION`，反而与 manifest 不一致）；
//      `files` 白名单**真的把它装进分发产物**。
//   3. **运行依赖无死声明**：`dependencies` 里每个名字都必须被**随包发布的源码**
//      （`lib/`、`bin/`）导入；反过来 `devDependencies` 里的名字不得被它导入。
//   4. **边界声明存在且被索引**：`doc/permissions-and-boundaries.md` 存在、含四节
//      标题（运行依赖 / 权限 / 外部服务 / 失败边界）、且已登记进 `doc/README.md`。
//
// ## 刻意不做的事
//
//   · **不用 `spawnSync` 去问 git**：读 `.git/config` 就够了。本机实测 Node 里
//     `spawnSync` 调任何外部程序都 `EPERM`（见 `doc/progress.md`「已知环境约束」），
//     那会让闸门在本机空转——而**空转的闸门比没有闸门更坏**。
//   · **不引第三方依赖**。与 check-ledger / check-repo-hygiene / lint-comments 同一传统。
//   · **不修文件**。改 `repository` 是作者的判断，不是脚本的判断；脚本只报警。
//
// ## 用法
//
//   node scripts/check-plugin-contract.mjs            # 人读输出
//   node scripts/check-plugin-contract.mjs --json     # 机读输出（CI 归档）
//
// 退出码：0 = 四条全绿；1 = 有不一致项；2 = 脚本自身出错（读不到文件等）。
//
// ## 已知边界（宁可漏报也不制造假红）
//
// 「运行依赖无死声明」只判**静态导入**。将来若出现动态拼出的模块名，它会被误判成
// 死声明——那时应把该名字加进 `DEAD_DEP_ALLOWLIST` 并在此处写清理由，**不要放宽判据**，
// 否则这道闸门会退化成「永远是绿的」。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const pkgDir = path.join(repoRoot, 'package', 'dsh-webcode-bridge');

const PKG_JSON = path.join(pkgDir, 'package.json');
const ROOT_LICENSE = path.join(repoRoot, 'LICENSE');
const PKG_LICENSE = path.join(pkgDir, 'LICENSE');
const BOUNDARIES_DOC = path.join(repoRoot, 'doc', 'permissions-and-boundaries.md');
const DOC_INDEX = path.join(repoRoot, 'doc', 'README.md');

/** 随包发布的运行时代码目录（相对包目录）。判据 3 的扫描面就是这两个。 */
const SHIPPED_DIRS = ['lib', 'bin'];

/**
 * 「声明了但运行时不引用」的显式豁免名单。
 *
 * 空着是刻意的：本项目 0.19.24 把唯一的死声明（`ws`，唯一引用者是
 * `test/fake-extension.js` 这个测试替身）移进了 `devDependencies`。将来真要豁免，
 * 在这里写 `名字: '理由'`，让豁免本身也留下痕迹。
 */
const DEAD_DEP_ALLOWLIST = {};

/** 判据 4 要求的四节标题。顺序与 `doc/permissions-and-boundaries.md` 一致。 */
const REQUIRED_DOC_SECTIONS = [
  /^##\s*1\.\s*运行依赖\s*$/m,
  /^##\s*2\.\s*权限\s*$/m,
  /^##\s*3\.\s*外部服务\s*$/m,
  /^##\s*4\.\s*失败边界\s*$/m,
];

/**
 * 标准 MIT 正文（不含标题行与版权行——那两行本来就该逐项目不同）。
 *
 * ## 为什么要把正文**逐字**钉住，而不是只看向量里的 `license` 字段
 *
 * 2026-09-26 真事故：根 `LICENSE` 曾经在标准 MIT 全文中间插了一段第三方来源说明，
 * `package.json` 写着 `"license": "MIT"`、文件也在，看起来三处都「有」许可——但 GitHub 的
 * 许可识别（Licensee）是拿 MIT 模板做**相似度**匹配，多出的段落把它压到阈值之下，于是它
 * 对外报的是 `license.key='other'`、`spdx_id='NOASSERTION'`（本机实读 GitHub API）。
 * 那正是 DSH STORE 收录阻断「manifest 与 GitHub 的许可证元数据不一致」——只补文件不够，
 * **正文的形状**才是被判的东西。
 *
 * 这条判据离线可判、且直接对应上面那个后果：正文里多出一段、少一段、改一个词都会红。
 * 额外说明（第三方来源、商标、免责补充）应当放进 `README.md` 或独立的 NOTICE 文件，
 * **不要塞进许可正文**——塞进去就会把 `spdx_id` 从 `MIT` 变成 `NOASSERTION`。
 */
const MIT_BODY = [
  'Permission is hereby granted, free of charge, to any person obtaining a copy',
  'of this software and associated documentation files (the "Software"), to deal',
  'in the Software without restriction, including without limitation the rights',
  'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell',
  'copies of the Software, and to permit persons to whom the Software is',
  'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all',
  'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR',
  'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,',
  'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE',
  'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER',
  'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,',
  'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE',
  'SOFTWARE.',
].join('\n');

/**
 * 把一份许可文本归一成「只比较正文」的形状：去掉标题行与版权行、统一空白。
 *
 * 去掉的两行是**本来就该逐项目不同**的部分（`MIT License` 标题、`Copyright (c) …`），
 * 其余逐字保留——正是这样才判得出「多插了一段」。
 */
function normalizeLicenseBody(text) {
  return String(text)
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => !/^\s*MIT License\s*$/i.test(line) && !/^\s*Copyright\b/i.test(line))
    .join('\n')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 把 git URL 归一成可以逐字比较的形状：去 `git+`、去末尾 `.git`、去末尾 `/`。 */
function normalizeGitUrl(url) {
  return String(url || '')
    .trim()
    .replace(/^git\+/, '')
    .replace(/\.git$/, '')
    .replace(/\/+$/, '');
}

/**
 * 从 `.git/config` 读出 `origin` 的 URL（纯 `fs`，不 spawn git——理由见文件头）。
 *
 * 覆盖两种仓库形态：`.git` 是目录（常规克隆）与 `.git` 是文件（worktree / 子模块，
 * 内容是 `gitdir: <path>`）。读不到时返回 null 并由调用方**如实报出来**，
 * 而不是假装通过。
 */
function readOriginUrl() {
  const dotGit = path.join(repoRoot, '.git');
  let configPath = path.join(dotGit, 'config');
  if (fs.existsSync(dotGit) && fs.statSync(dotGit).isFile()) {
    const m = fs.readFileSync(dotGit, 'utf8').match(/^gitdir:\s*(.+)$/m);
    if (!m) return null;
    configPath = path.join(path.resolve(repoRoot, m[1].trim()), 'config');
  }
  if (!fs.existsSync(configPath)) return null;
  const cfg = fs.readFileSync(configPath, 'utf8');
  // 取 `[remote "origin"]` 段里的 `url`，到下一个段头为止。
  const section = cfg.match(/\[remote\s+"origin"\]([\s\S]*?)(?=\n\[|$)/);
  if (!section) return null;
  const url = section[1].match(/^\s*url\s*=\s*(.+)$/m);
  return url ? url[1].trim() : null;
}

/** 递归收集目录下的 `.js` / `.mjs` / `.cjs`（判据 3 的扫描面）。 */
function collectSources(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectSources(p, out);
    else if (/\.(js|mjs|cjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 抽出一个源码文件里的**模块说明符**（`from 'x'` / `require('x')` / `import('x')` /
 * 裸 `import 'x'`）。刻意只认这四种官方形态：本项目不写动态导入。
 */
function moduleSpecifiers(text) {
  const specs = [];
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /\bimport\s*['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(text)) !== null) specs.push(m[1]);
  }
  return specs;
}

/** 说明符是否来自某个包（含子路径导入，如 `pkg/sub`）。 */
function specifierUsesPackage(spec, name) {
  return spec === name || spec.startsWith(name + '/');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function main() {
  const json = process.argv.includes('--json');
  const problems = [];
  const results = [];

  const pkg = JSON.parse(fs.readFileSync(PKG_JSON, 'utf8'));

  // ---- 判据 1：仓库指向 ----
  const originUrl = readOriginUrl();
  const manifestUrl = pkg.repository && pkg.repository.url;
  const expectedDir = path.relative(repoRoot, pkgDir).split(path.sep).join('/');
  const actualDir = pkg.repository && pkg.repository.directory;
  const repoChecks = [
    { what: 'manifest 有 repository.url', ok: typeof manifestUrl === 'string' && manifestUrl.length > 0 },
    { what: 'repository.url 指向本仓库 origin（' + normalizeGitUrl(originUrl) + '）',
      ok: originUrl !== null && normalizeGitUrl(manifestUrl) === normalizeGitUrl(originUrl) },
    { what: 'repository.directory == ' + expectedDir, ok: actualDir === expectedDir },
    { what: 'homepage 指向同一仓库',
      ok: normalizeGitUrl(pkg.homepage).startsWith(normalizeGitUrl(originUrl) || '\u0000') },
    { what: 'bugs.url 指向同一仓库',
      ok: !!(pkg.bugs && pkg.bugs.url)
        && normalizeGitUrl(pkg.bugs.url).startsWith(normalizeGitUrl(originUrl) || '\u0000') },
  ];
  if (originUrl === null) {
    problems.push('读不到 `.git/config` 里 `origin` 的 URL——判据 1 无法与事实对照（不是通过）。');
  }
  for (const c of repoChecks) if (!c.ok) problems.push('仓库指向：' + c.what + ' —— 不成立。');
  results.push({ item: 'repository', ok: repoChecks.every((c) => c.ok) && originUrl !== null });

  // ---- 判据 2：许可证三处一致 ----
  const licChecks = [];
  const rootHas = fs.existsSync(ROOT_LICENSE);
  const pkgHas = fs.existsSync(PKG_LICENSE);
  licChecks.push({ what: '根 LICENSE 存在', ok: rootHas });
  licChecks.push({ what: '包内 LICENSE 存在', ok: pkgHas });
  let identical = false;
  if (rootHas && pkgHas) {
    identical = sha256(ROOT_LICENSE) === sha256(PKG_LICENSE);
    licChecks.push({ what: '两份 LICENSE 字节相同（分发产物与 GitHub 一致）', ok: identical });
    const licText = fs.readFileSync(ROOT_LICENSE, 'utf8');
    const firstLine = licText.split(/\r?\n/)[0];
    licChecks.push({
      what: '许可文本自称 ' + pkg.license + '（首行：' + firstLine.trim() + '）',
      ok: new RegExp('^' + String(pkg.license) + '\\b', 'i').test(firstLine.trim())
        || /MIT License/i.test(firstLine) && pkg.license === 'MIT',
    });
    // 正文必须与标准 MIT 模板逐字一致：多插一段就会让 GitHub 把 spdx_id 判成
    // NOASSERTION（见 MIT_BODY 的注释）。这一段是该判据里**唯一能提前发现**那类事故的检查。
    licChecks.push({
      what: '许可正文与标准 MIT 模板逐字一致（多插段落会让 GitHub 判成 NOASSERTION）',
      ok: normalizeLicenseBody(licText) === normalizeLicenseBody(MIT_BODY),
    });
    if (!fs.readFileSync(ROOT_LICENSE, 'utf8').includes('MIT License')) {
      problems.push('许可证：正文里没有 `MIT License` 标题行——GitHub 的识别依赖它。');
    }
  }
  licChecks.push({
    what: 'package.json 的 files 白名单含 LICENSE',
    ok: Array.isArray(pkg.files) && pkg.files.includes('LICENSE'),
  });
  for (const c of licChecks) if (!c.ok) problems.push('许可证：' + c.what + ' —— 不成立。');
  results.push({ item: 'license', ok: licChecks.every((c) => c.ok) });

  // ---- 判据 3：运行依赖无死声明 ----
  const sources = SHIPPED_DIRS.flatMap((d) => collectSources(path.join(pkgDir, d)));
  const used = new Set();
  for (const f of sources) {
    for (const s of moduleSpecifiers(fs.readFileSync(f, 'utf8'))) used.add(s);
  }
  const deps = Object.keys(pkg.dependencies || {});
  const devDeps = Object.keys(pkg.devDependencies || {});
  const depChecks = [];
  for (const name of deps) {
    if (DEAD_DEP_ALLOWLIST[name]) continue;
    depChecks.push({
      what: '运行依赖 `' + name + '` 被 lib/ 或 bin/ 导入',
      ok: [...used].some((s) => specifierUsesPackage(s, name)),
    });
  }
  for (const name of devDeps) {
    const leaked = [...used].some((s) => specifierUsesPackage(s, name));
    depChecks.push({
      what: '开发依赖 `' + name + '` 未被运行时代码导入' + (leaked ? '（实际被导入，装机后会缺）' : ''),
      ok: !leaked,
    });
  }
  for (const c of depChecks) if (!c.ok) problems.push('依赖：' + c.what + ' —— 不成立。');
  results.push({
    item: 'dependencies',
    ok: depChecks.every((c) => c.ok),
    detail: deps.length + ' 运行 / ' + devDeps.length + ' 开发，扫了 ' + sources.length + ' 个随包源码文件',
  });

  // ---- 判据 4：边界声明存在且被索引 ----
  const docChecks = [];
  const docHas = fs.existsSync(BOUNDARIES_DOC);
  docChecks.push({ what: 'doc/permissions-and-boundaries.md 存在', ok: docHas });
  if (docHas) {
    const md = fs.readFileSync(BOUNDARIES_DOC, 'utf8');
    for (const re of REQUIRED_DOC_SECTIONS) {
      docChecks.push({ what: '含小节标题 `' + re.source + '`', ok: re.test(md) });
    }
  }
  const indexHas = fs.existsSync(DOC_INDEX)
    && fs.readFileSync(DOC_INDEX, 'utf8').includes('(permissions-and-boundaries.md)');
  docChecks.push({ what: 'doc/README.md 索引里有它', ok: indexHas });
  for (const c of docChecks) if (!c.ok) problems.push('边界声明：' + c.what + ' —— 不成立。');
  results.push({ item: 'boundaries-doc', ok: docChecks.every((c) => c.ok) });

  if (json) {
    process.stdout.write(JSON.stringify({
      ok: problems.length === 0,
      repoRoot,
      origin: originUrl,
      literalChecks: [...repoChecks, ...licChecks, ...depChecks, ...docChecks],
      results,
      problems,
    }, null, 2) + '\n');
  } else {
    process.stdout.write('[contract] 仓库：' + repoRoot + '\n');
    process.stdout.write('[contract] origin = ' + (originUrl || '(读不到)') + '\n');
    for (const r of results) {
      process.stdout.write('  ' + (r.ok ? 'PASS' : 'FAIL') + '  ' + r.item.padEnd(15)
        + (r.detail ? '  ' + r.detail : '') + '\n');
    }
    process.stdout.write('\n');
  }

  if (problems.length) {
    process.stderr.write('[contract] DSH 插件契约不一致（' + problems.length + ' 项）：\n');
    for (const p of problems) process.stderr.write('  · ' + p + '\n');
    process.stderr.write('\n[contract] 修复方向：改 manifest / LICENSE / 依赖声明让它与事实一致；\n');
    process.stderr.write('[contract] 不要改本脚本去迁就声明——这道闸门的全部价值就在于它不迁就。\n');
    return 1;
  }

  if (!json) {
    process.stdout.write('[contract] ✔ 四条契约与事实一致（仓库指向 / 许可证 / 运行依赖 / 边界声明）。\n');
    process.stdout.write('[contract] 注意：本闸门只判声明层与事实是否一致，'
      + '**不改变 DSH STORE 的审查结论**（见 doc/permissions-and-boundaries.md §6）。\n');
  }
  return 0;
}

let code = 2;
try {
  code = main();
} catch (e) {
  // 脚本自身出错必须是 2，不能伪装成「契约不一致」（1）：两者的处理方式完全不同。
  process.stderr.write('[contract] 脚本自身失败：' + (e && e.stack ? e.stack : e) + '\n');
  code = 2;
}
process.exit(code);
