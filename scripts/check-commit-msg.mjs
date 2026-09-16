#!/usr/bin/env node
// check-commit-msg.mjs — 让「提交信息不规范」变成红灯，而不是靠人自觉。
//
// ## 为什么需要这个文件
//
// 本仓库的提交主题**事实上**已经是 Conventional Commits 风格：实测最近 200 条提交里
// 全部写成 `type(scope): 主题` 或其复合形式（`chore(hygiene)+feat(gate): …`、
// `test+ci: …`）。但这条约定**既没有写进 CONTRIBUTING.md，也没有任何闸门**。
//
// 这与 `scripts/check-ledger.mjs` 的处境同型：一条**事实上被遵守、但没有定义、
// 也没有检查**的约定，它的寿命取决于下一个人是否恰好知道它。健康的历史一旦
// 掺进一条 `update stuff`，要么被无声接受，要么在评审里争论一次——两种都不便宜。
//
// 把约定写下来 + 让它可机检，才是「规范」的实际含义。
//
// ## 判据（每条都有对应的真实反例，不是凭空定的）
//
//   1. **形状**：`type(scope)?(!)?: 主题`，允许 `+` 连接复合类型/作用域
//      （依据实测词汇表：`chore(hygiene)+feat(gate)`、`test+ci`、`feat(bench+roster)`）。
//   2. **类型白名单**：feat / fix / docs / test / chore / refactor / perf / ci /
//      build / revert / security。前八类来自实测；security 亦来自实测
//      （`security: 导入登录态目录白名单…`）。
//   3. **主题非空**：`feat(ui):` 后面什么都没有不算提交信息。
//   4. **不得含 BOM**（U+FEFF）：提交信息里混进 BOM 会让 `git log | grep '^fix'`
//      之类的机械化处理静默漏掉这一条——排查时表现为「这条提交好像不存在」。
//   5. **主题里不得有字面 `\n` / `\r`**：真机反例 `6b95cf2` 的主题里带着字面
//      `\n\n站点级单份登录态 → …`，整段正文被塞进了主题行（实测 1031 字符）。
//      正确做法是空一行后写正文；字面转义序列说明提交时用了不转义的字符串。
//
// ## 刻意不做的事
//
//   · **不自动改写提交信息**。与 check-ledger.mjs 同一立场：闸门负责报警，不负责代笔。
//   · **不用 `spawnSync` 去问 git**。本机实测 Node 里 `spawnSync` 调任何外部程序都
//     `EPERM`（见 `doc/progress.md`「已知环境约束」）。那会让本闸门在本机变成空转，
//     而**空转的闸门比没有闸门更坏**。因此：
//       - 本机默认读 `.git/COMMIT_EDITMSG`（纯 `fs`，最近一次提交的原文）；
//       - CI 上由 shell 把 `git log` 的输出**管道**进来（`--stdin`），git 由 shell 调用。
//   · **不引第三方依赖**。与 lint-comments / check-ledger / artifacts-check 同一传统。
//
// ## 用法
//
//   node scripts/check-commit-msg.mjs                    # 检查 .git/COMMIT_EDITMSG
//   node scripts/check-commit-msg.mjs --message-file P   # 检查指定文件（commit-msg 钩子）
//   node scripts/check-commit-msg.mjs --stdin            # 从 stdin 读（CI：git log 管道）
//   node scripts/check-commit-msg.mjs --self-test        # 自检判据（正反例都对才退 0）
//
// 退出码：0 = 全部合规；1 = 有不合规的提交信息；2 = 脚本自身出错。
//
// ## 已知边界（宁可漏报也不制造假红）
//
//   · 只判**主题行**（第一条非注释、非空行）。正文怎么写不在判据内。
//   · 放行 `Merge …` / `Revert "…"` / `fixup!` / `squash!` —— 这些由 git 或
//     交互式 rebase 生成，不是作者手写的主题，强制套格式只会逼人加 `--no-verify`。
//   · 长度只 **warn 不 error**：中文主题信息密度高，硬卡 50/72 字符会把正常的中文
//     写成半个句子。阈值取 100，超了提醒，不拦。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/** 实测词汇表：本仓库历史上真实出现过的类型。新增类型要先改这里，理由写进注释。 */
const TYPES = ['feat', 'fix', 'docs', 'test', 'chore', 'refactor', 'perf', 'ci', 'build', 'revert', 'security'];

/** 主题长度提醒阈值（只 warn）。中文信息密度高，卡 50/72 会把正常中文写成半句。 */
const SUBJECT_WARN_LEN = 100;

// 一个「类型部件」：type，可选 (scope)，可选 !（破坏性变更）。
const PART = `(?:${TYPES.join('|')})(?:\\([a-z0-9._/+\\-]+\\))?!?`;
// 完整形状：一个或多个部件用 + 连接，冒号，空格，非空主题。
const SHAPE = new RegExp(`^${PART}(?:\\+${PART})*: \\S`);

/** git 会自动生成的、不该套手写格式的主题。 */
const GENERATED = /^(Merge |Revert "|fixup!|squash!|amend!)/;

/**
 * 取提交信息里真正的**主题行**：跳过注释行（`#`）与空行。
 *
 * @param {string} raw 提交信息原文
 * @returns {string} 主题行（可能为空串）
 */
function subjectOf(raw) {
  for (const line of String(raw ?? '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (line.startsWith('#')) continue;
    return line;
  }
  return '';
}

/**
 * 校验一条提交信息，返回问题列表（空数组 = 合规）。
 *
 * 纯函数、无 IO——`--self-test` 直接拿它跑正反例，也是本文件可被信任的原因。
 *
 * @param {string} raw 提交信息原文
 * @returns {Array<{level: 'error'|'warn', code: string, detail: string}>} 问题列表
 */
function inspect(raw) {
  const problems = [];
  const subject = subjectOf(raw);
  if (!subject) return problems; // 空信息（例如 rebase 的 noop）：不是本次要管的事

  if (GENERATED.test(subject)) return problems;

  if (subject.charCodeAt(0) === 0xFEFF) {
    problems.push({ level: 'error', code: 'BOM', detail: '主题以 UTF-8 BOM 开头（会让 `git log | grep ^fix` 静默漏掉这条）' });
  }
  // 字面转义序列：真机反例 6b95cf2 把整段正文塞进了主题行。
  if (/\\n|\\r/.test(subject)) {
    problems.push({ level: 'error', code: 'LITERAL-ESCAPE', detail: '主题里含字面 `\\n` / `\\r`：正文应空一行后另起，而不是转义进主题' });
  }
  if (!SHAPE.test(subject)) {
    const head = subject.split(':')[0];
    const type = head.split('(')[0].split('+')[0];
    if (!TYPES.includes(type)) {
      problems.push({ level: 'error', code: 'TYPE', detail: `类型 \`${type}\` 不在白名单内（${TYPES.join(' / ')}）` });
    } else {
      problems.push({ level: 'error', code: 'SHAPE', detail: '形状应为 `type(scope)?: 主题`（复合用 `+` 连接，冒号后必须有空格与内容）' });
    }
  }
  if (subject.length > SUBJECT_WARN_LEN) {
    problems.push({ level: 'warn', code: 'LENGTH', detail: `主题 ${subject.length} 字符，超过 ${SUBJECT_WARN_LEN}；建议把细节移到正文` });
  }
  return problems;
}

/** `--self-test`：判据的正反例必须都对。这是本脚本唯一的“测试”，不需要测试框架。 */
function selfTest() {
  const shouldPass = [
    'fix(decoder): SET 重发吞掉流式增量 —— 网页有输出、harness 收不到（0.15.7）',
    'chore(hygiene)+feat(gate): 清历史 tgz / 废弃备份 + 两条死规则',
    'test+ci: 注释闸门转阻断，CI/CD 与审查补强（0.15.2）',
    'feat(bench+roster): 提示词基准层与真实花名册',
    'security: 导入登录态目录白名单 + 两个状态文件统一 0o600',
    'docs: 记账收口',
    'Revert "feat(ui): 右栏重排"',
    'Merge branch \'main\' into feature',
    'fixup! feat(ui): 右栏重排',
    'refactor!: 改配置形状',
  ];
  // 反例全部来自实测或判据的直接推论，不是凑数：
  //   · `update stuff`            —— 无类型前缀；
  //   · `fix ui right column`     —— 有类型词但不是 `type(scope):` 形状；
  //   · `feat(ui):`               —— 冒号后为空；
  //   · BOM 开头                  —— 会让 `git log | grep ^fix` 静默漏掉；
  //   · 字面 `\n`                 —— 真机反例 6b95cf2；
  //   · `whatever(scope): …`      —— 类型不在白名单。
  const failing = [
    'update stuff',
    'fix ui right column',
    'feat(ui):',
    '\uFEFFfix(ui): 右栏重排',
    'feat(accounts): 同站多账户槽\\n\\n站点级单份登录态 → 站点 × 账户槽',
    'whatever(scope): 类型不在白名单',
  ];
  let bad = 0;
  for (const s of shouldPass) {
    const p = inspect(s).filter((x) => x.level === 'error');
    if (p.length) { console.error(`  self-test FAIL（应通过却报错）: ${JSON.stringify(s)}\n    ${p.map((x) => x.code).join(',')}`); bad++; }
  }
  for (const s of failing) {
    const p = inspect(s).filter((x) => x.level === 'error');
    if (!p.length) { console.error(`  self-test FAIL（应报错却通过）: ${JSON.stringify(s)}`); bad++; }
  }
  console.log(`[commit-msg] self-test：${shouldPass.length} 正例 + ${failing.length} 反例，${bad === 0 ? '全部符合预期' : bad + ' 项不符'}`);
  return bad === 0 ? 0 : 2;
}

function readStdin() {
  try { return fs.readFileSync(0, 'utf8'); } catch { return ''; }
}

/**
 * 多主题模式（CI 用）：stdin 的**每一行**都是一条提交主题。
 *
 * 为什么必须与单条模式分开：CI 上 shell 把 `git log --format=%s` 的输出管道进来，
 * 那是「一行一条」。若按「整段是一份提交信息」处理，`subjectOf` 只会取第一行，
 * 后面上百条**一条都不会被检查**——而输出仍是「✔ 合规」，闸门看着绿，实际只验了一条。
 * 这个错法极其隐蔽，所以单独有这个函数与这条注释。
 *
 * @param {string} text 多行文本，每行一条主题
 * @returns {number} 0 = 全部合规；1 = 有不合规
 */
function checkMany(text) {
  const subjects = String(text ?? '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  let bad = 0;
  for (const s of subjects) {
    const errors = inspect(s).filter((x) => x.level === 'error');
    if (errors.length) {
      bad++;
      process.stderr.write(`[commit-msg] ✖ ${JSON.stringify(s.slice(0, 70))}\n`);
      for (const e of errors) process.stderr.write(`  · ${e.code}: ${e.detail}\n`);
    }
  }
  if (bad) {
    process.stderr.write(`\n[commit-msg] ${subjects.length} 条主题中 ${bad} 条不合规。`
      + '规范见 CONTRIBUTING.md「提交信息」一节。\n');
    return 1;
  }
  console.log(`[commit-msg] ✔ ${subjects.length} 条提交主题全部合规`);
  return 0;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--self-test')) return selfTest();

  // CI 模式：一行一条主题。必须**先于**单条模式判断——否则只会验第一条。
  if (argv.includes('--stdin')) return checkMany(readStdin());

  let raw = '';
  let origin = '';
  const mf = argv.indexOf('--message-file');
  if (mf >= 0) {
    const p = argv[mf + 1];
    if (!p) { process.stderr.write('[commit-msg] --message-file 需要一个路径\n'); return 2; }
    raw = fs.readFileSync(p, 'utf8');
    origin = p;
  } else {
    const p = path.join(repoRoot, '.git', 'COMMIT_EDITMSG');
    if (!fs.existsSync(p)) {
      console.log('[commit-msg] 跳过：.git/COMMIT_EDITMSG 不存在（可能不是 git 工作树，或还没有提交）');
      return 0;
    }
    raw = fs.readFileSync(p, 'utf8');
    origin = '.git/COMMIT_EDITMSG';
  }

  const problems = inspect(raw);
  const errors = problems.filter((x) => x.level === 'error');
  const warns = problems.filter((x) => x.level === 'warn');

  for (const w of warns) process.stderr.write(`[commit-msg] warn  ${w.code}: ${w.detail}\n`);
  if (!errors.length) {
    console.log(`[commit-msg] ✔ 提交信息合规（${origin}）`);
    return 0;
  }
  process.stderr.write(`[commit-msg] ✖ ${origin} 有 ${errors.length} 处不合规：\n`);
  for (const e of errors) process.stderr.write(`  · ${e.code}: ${e.detail}\n`);
  process.stderr.write('\n[commit-msg] 规范见 CONTRIBUTING.md「提交信息」一节。\n');
  process.stderr.write('[commit-msg] 不要用 --no-verify 绕过；判据错就改本脚本的判据，并补 --self-test 的正反例。\n');
  return 1;
}

let code = 2;
try {
  code = main();
} catch (e) {
  process.stderr.write('[commit-msg] 脚本自身失败：' + (e && e.stack ? e.stack : e) + '\n');
  code = 2;
}
process.exit(code);
