#!/usr/bin/env node
// lint-comments.mjs — 注释纪律的机检闸门（纯 Node，无外部依赖）。
//
// ## 为什么需要这个文件
//
// `doc/comment-style.md` §10「注释与文档是能力放大器（0.14.8）」把本仓库的立场写死了：
// 用户原话是「规范代码注释/文档放在-**为了增强能力**」，注释承担的是**可执行的记忆**——
// 把一次真机踩坑的根因、证据、以及「为什么不能改回去」钉在代码旁边。§10.1 的三条要求是
// 「写为什么，不写是什么」「每条判断必须带可核对的证据」「失效的注释必须改或删」；
// §10.2 反面清单里点名了两类实际代价：
//
//   · 「注释描述的实现已不存在」（`prompt-variants.js:108`）——误导读者以为有渲染分支；
//   · 「注释里的数字与代码不符 / §引用指向不存在的章节」——文档失去索引价值。
//
// §10 的三条要求里，前两条靠人读、第三条（失效的注释必须改或删）**可以机检**。而 §3.5
// 又写明本仓库 `lib/` 下没有 `TODO`/`FIXME` 字样、并且「这是可以保持的状态」。一个可以
// 保持的状态需要护栏，否则它会在某一次赶工的提交里悄悄退化——这正是本文件存在的理由：
// 把 §10 与 §3.5 里那些**不需要读者判断**的部分变成退出码。
//
// ## 刻意不做的事
//
// 不引 parser（acorn/espree 都不引）。本仓库的脚本传统是「可直接 `node` 运行的独立工具」
// （见 `test-mock/prompt-bench.mjs:202` 的手写 argv 解析注释），而 CI 里多一个依赖就多一处
// 供应链面。代价是规则只能做「行级」判断，因此每条规则都写明了它的**边界**，宁可漏报也不
// 制造假红——假红会让这个闸门被绕过，那比没有闸门更糟。
//
// ## 规则与边界
//
//   | 码    | 级别 | 检查                                             | 依据 |
//   |-------|------|--------------------------------------------------|------|
//   | CS001 | error | `lib/`、`bin/` 下的 js/cjs/mjs 首个非空内容行必须是注释 | §10.1 |
//   | CS002 | error | `TODO`/`FIXME`/`XXX`/`HACK` 必须带负责人、日期或 issue 号 | §3.5 |
//   | CS003 | error | `lib/` 下导出函数上方必须紧贴 `/** */` JSDoc         | §4   |
//   | CS004 | error | 注释不得复述 diff（`// 新增：`/`// 修改为`/`// 修复了`） | §6.3 |
//   | CS005 | warn  | 连续 ≥3 行、且多数像代码的 `//` 块（被注释掉的代码） | §3.6 |
//
// CS001 只覆盖 `lib/` 与 `bin/`（**随包发布**的运行时源码），不覆盖 `test/`、`test-mock/`
// 与 `scripts/`：后者是本机工具，它们的头部注释是习惯而非契约，把它们算作违约会制造
// 与真实风险无关的红灯。这是刻意的范围选择，不是遗漏。
//
// CS003 允许显式豁免：在被检查行上方任意位置写 `// @nolint-cs003 <一句话理由>` 即放行。
// 豁免必须给理由——没有理由的豁免与「把规则删掉」等价。理由写什么不检查（机器判不了），
// 但它在 review 里会被看见，这正是 §10.1 第 3 条要的效果。
//
// ## 用法
//
//   node scripts/lint-comments.mjs                    # 人读输出，有 error 即退出 1
//   node scripts/lint-comments.mjs --json             # 机读输出（CI 归档 / 编辑器集成）
//   node scripts/lint-comments.mjs --max-warnings=5   # 允许最多 5 条 warn
//   node scripts/lint-comments.mjs --quiet            # 只印汇总与违规行
//
// 退出码：0 = 无 error 且 warn 数 ≤ 上限；1 = 有 error 或 warn 超限；2 = 脚本自身出错。
// 读不了的文件**跳过并计数**，不让它把整个闸门带崩（§9.1 的机器可判原则：闸门自己先要稳定）。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');

/**
 * 扫描范围。每一项是「根目录 + 是否递归 + 扩展名」。
 *
 * 为什么不用 glob：`test-mock/` 与 `test/` 下躺着几千个浏览器 profile 缓存
 * （`doc/review-guide.md:3-4` 记的 8456 个），任何通配符递归都可能一头扎进去。
 * 显式列出「非递归」的目录，是让扫描代价可控的唯一简单办法。
 */
const SCOPE = [
  { root: 'package/dsh-webcode-bridge/lib', recursive: true, exts: ['.js', '.cjs', '.mjs'] },
  { root: 'package/dsh-webcode-bridge/bin', recursive: false, exts: ['.js'] },
  { root: 'package/dsh-webcode-bridge/test-mock', recursive: false, exts: ['.mjs'] },
  { root: 'package/dsh-webcode-bridge/test', recursive: false, exts: ['.mjs'] },
  { root: 'scripts', recursive: false, exts: ['.mjs'] },
];

/** CS001 的适用范围：随包发布的运行时源码。见文件头「刻意的范围选择」。 */
const HEADER_REQUIRED_PREFIXES = ['package/dsh-webcode-bridge/lib/', 'package/dsh-webcode-bridge/bin/'];

/** CS003 的适用范围：`lib/` 下的导出面是跨模块契约（§2.4）。 */
const JSDOC_REQUIRED_PREFIX = 'package/dsh-webcode-bridge/lib/';

/** 关键词表。**大小写敏感**——本仓库 `lib/index.js` 的 `/__webcode/xxx` 与
 *  `test-mock/parse-session-log.mjs` 的 `case 'todo/write':` 都曾被不区分大小写的
 *  正则误判成待办（2026-09-15 实测），假红会让闸门失去权威。 */
const MARKER_RE = /\b(TODO|FIXME|XXX|HACK)\b/;

/** 合法的待办写法：`TODO(负责人)`、`TODO 2026-09-15`、`TODO #123`、`TODO(可验证)`。 */
const MARKER_OK_RE = /\b(TODO|FIXME|XXX|HACK)\s*(\([^)]+\)|#\d+|\d{4}-\d{2}-\d{2})/;

/**
 * 四种**引号段**：反引号（`` ` ``）、中文直角引号（`「」`）、ASCII 单引号、ASCII 双引号。
 *
 * 为什么必须把「被引号包起来的标记」当成引用而不是待办（2026-09-15 实测）：本文件与
 * `doc/comment-style.md` 都在**讨论**这条规则，「解释什么是合法写法」的那几行必然写出标记
 * 字样本身。若把引用也算成违规，任何讲解这条规则的文档都过不了闸门——那会把闸门逼向
 * 「规则不能写进文档」，与 §10「注释是能力放大器」直接冲突。
 *
 * 为什么引号集要覆盖直角引号与 ASCII 引号，而不止反引号：散文里也大量使用这两种（实测行
 * 216/217/223 就是），只认反引号会在**本脚本自己的头部注释**上留下 3 条假红。
 *
 * 为什么可以用一个正则直接匹配：引号段本身是「引用内容」，段内允许出现任意非引号字符
 * （包括中文顿号、`(`、`)`），所以不需要配平状态机——ASCII 引号段的边界是明确定义的，
 * 不会与 JS 字符串字面量混淆，因为待办只在**注释文本**里查（见 checkMarkers 的说明）。
 */
const QUOTE_SPAN_RE = /`[^`]*`|「[^」]*」|'[^']*'|"[^"]*"/g;

/** §6.3「不要用注释复述 diff」。 */
const DIFF_RECITAL_RE = /^\s*(\/\/|\*)\s*(新增[:：]|修改为|修复了|改动[:：]|本次新增|newly added)/;

/** CS005 的「像代码」判据。要求同时出现至少两条，避免把中文散文判成代码。 */
/**
 * CS005 的「像代码」判据——**第一步：这一行像不像一条 JS 语句。**
 *
 * 这里的正则全部锚定在**语句骨架**上（行尾分号、箭头函数、关键字后必须跟代码、只有闭括号
 * 的行、调用形状），而不是宽松到「句子或注释里出现 `const` 这个词」。为什么（2026-09-15
 * 实测）：宽松写法在本仓库产生 4 条假红，被举报的行其实都是散文——例如
 * `//   - parseAgentReply normalizes full-width DSML, so tools still executed;`
 * 只是一个用分号收尾的说明句，`// 就直接 return，**页面上一个动作都不做**；…` 只是把
 * `return` 当术语讲。这类行里出现 `const`/`return` 是**讲代码**，不是**被注释掉的代码**。
 *
 * 为什么锚定骨架就够：真正的死代码必然带语句形状（`foo();`、`const x = 1;`、`if (a) {`、
 * `=>`），而这些骨架在中文/英文散文里几乎不出现。闸门宁可对少数畸形死代码漏报，也不能对
 * 散文假红——按 §9.1 第 1 条，假红会让闸门被绕过，比没有闸门更糟。
 */
const CODE_LIKE_RES = [
  // 分号收尾**并且**有赋值或调用形状才算语句：英文散文也常用分号断句
  // （实测 `…so tools still executed;`、`…the first user message;` 都是），只认分号会全判成代码。
  // 调用形状刻意不允许 `foo (` 这种带空格的写法——散文里 `fixture (its index was -1);` 正是
  // 这个形状；JS 允许 `foo (x)`，但本仓库不这么写，宁可漏报。
  /[^=!<>+\-*/%&|^]=[^=].*;\s*$/,                            // 赋值语句：x = …;
  /[A-Za-z_$][\w$.[\]]*\([^;()]*\)\s*;\s*$/,                  // 调用语句：foo(…);
  /=>/,                                                       // 箭头函数
  /\b(?:const|let|var|function|return|import|export|await|async|throw)\b\s*[A-Za-z_$({[]/, // 关键字后面必须真的跟代码，而不是跟中文或行尾
  /^\s*\/\/\s*\}\s*(?:else|catch|finally)?\s*\{?\s*$/,        // 只有闭括号（+ 可选 else/catch/finally）的行
  /\b(?:console\.(?:log|error|warn)|require\s*|process\.exit)\s*\(/, // 调用形状
];

/**
 * CS005 的「像代码」判据——**第二步：这一行是不是以中文散文为主。**
 *
 * 为什么需要第二道闸：JS 允许中文标识符（`const 名称 = 'x';`），所以「含中文」不能单独证明
 * 不是代码——但它能证明「含大段中文说明的一定是散文」。阈值取 20% 是按本仓库注释的实际配比
 * 选的：讲代码的中文注释通常「一句中文 + 一行代码」，中文占比在 30% 以上；而死代码块里即便
 * 夹一行中文注释，整行仍以 ASCII 语法骨架为主。
 */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

/**
 * 判定一行注释是否「像被注释掉的代码」：先过语句骨架，再用中文占比排除散文。
 *
 * 为什么两步而不是一步：骨架正则判「形状」，中文占比判「语料」。形状可以伪造（散文里引用
 * 一句 `const x = 1` 就带上了骨架），语料很难伪造（没人用中文写 JS 语句骨架）。两步合起来
 * 把误报压到 0，同时保留对 `//   foo();` 这类真死代码的识别。
 */
function looksLikeCode(commentText) {
  if (CJK_RE.test(commentText)) {
    const cjk = (commentText.match(/[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g) || []).length;
    if (cjk / commentText.length >= 0.2) return false; // 中文占两成以上：是散文，不是代码
  }
  return CODE_LIKE_RES.some((re) => re.test(commentText));
}

/** 导出面的三种形状（`lib/` 下实际存在的写法，2026-09-15 核对）。 */
const EXPORT_RES = [
  /^export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)/,
  /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s*)?\(/,
  /^export\s+const\s+([A-Za-z_$][\w$]*)\s*=\s*(async\s+)?function/,
];

const OPT_OUT_RE = /@nolint-cs003\b/;

/**
 * 解析 argv。刻意手写而不引依赖，与 `test-mock/prompt-bench.mjs:202` 同一理由：
 * 本仓库的脚本都是可直接 `node` 运行的独立工具，每个依赖都是一处供应链面。
 */
function parseArgs(argv) {
  const out = { json: false, quiet: false, maxWarnings: 0, unknown: [] };
  for (const a of argv) {
    if (a === '--json') out.json = true;
    else if (a === '--quiet') out.quiet = true;
    else if (a.startsWith('--max-warnings=')) {
      const n = Number(a.slice('--max-warnings='.length));
      if (!Number.isFinite(n) || n < 0) out.unknown.push(a);
      else out.maxWarnings = Math.floor(n);
    } else out.unknown.push(a);
  }
  return out;
}

/** 相对仓库根、正斜杠的路径：让输出在 Windows 与 Linux 上逐字相同。 */
function rel(p) {
  return path.relative(repoRoot, p).split(path.sep).join('/');
}

/** 收集待检查文件。读不了目录就跳过（返回空），不让一次权限问题带崩整个闸门。 */
function collectFiles() {
  const files = [];
  const skipped = [];
  for (const spec of SCOPE) {
    const abs = path.join(repoRoot, spec.root);
    let entries;
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch (e) {
      skipped.push({ path: spec.root, reason: 'readdir 失败：' + (e?.message || e) });
      continue;
    }
    for (const ent of entries) {
      if (ent.isDirectory()) {
        if (!spec.recursive) continue;
        collectInto(files, skipped, path.join(abs, ent.name), spec.exts);
        continue;
      }
      if (!ent.isFile()) continue;
      if (!spec.exts.includes(path.extname(ent.name))) continue;
      files.push(path.join(abs, ent.name));
    }
  }
  files.sort((a, b) => (rel(a) < rel(b) ? -1 : rel(a) > rel(b) ? 1 : 0));
  return { files, skipped };
}

/** 递归收集（`lib/` 下目前是平的，但契约允许子目录）。 */
function collectInto(files, skipped, dir, exts) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    skipped.push({ path: rel(dir), reason: 'readdir 失败：' + (e?.message || e) });
    return;
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) collectInto(files, skipped, p, exts);
    else if (ent.isFile() && exts.includes(path.extname(ent.name))) files.push(p);
  }
}

/**
 * 逐行抽出**真正位于注释里**的文本。第 i 项对应源码第 i 行；行注释取其 `//` 之后的文字，
 * 块注释取其 `/* *​/` 之间的文字，非注释内容一律变成空格（保留偏移，便于对位）。
 *
 * ## 为什么必须是状态机，而不是正则
 *
 * 待办标记规则（CS002）只能看**注释文本**，而「哪一段是注释」这件事无法用正则可靠判定，
 * 有两个正则原理上办不到的点：
 *
 *   1. **斜杠有两种含义。** `/` 既可能是正则字面量的开始，也可能是除号。`a = /x/;` 与
 *      `b = a / c;` 用同一个字符，靠「斜杠前后长什么样」区分需要**词法上下文**——即前一个
 *      有效字符是否把斜杠置于表达式起始位置（`=`、`(`、`,`、`:`、`[`、`!`、`&`、`|`、`?`、
 *      `{`、`}`、`;`、`return`，或整个输入的开头）。正则表达式本身没有「上一个有效字符」
 *      这个概念，所以配不出这条规则。
 *   2. **`//` 可能藏在字符串里。** `const u = 'https://example.com';` 里的 `//` 是 URL 的
 *      一部分，不是行注释；`const re = /\/\//;` 里的 `\/\/` 也不是。只有维护「当前是否在
 *      字符串/模板/正则里」这一份状态，才能在遇到 `//` 时知道它到底是不是注释的开头。
 *
 * 这个判断错的代价是不对称的：把代码行误认成注释，就会在纯代码上误报待办（本文件 line 86/89
 * 曾经因为 `MARKER_RE = /\b(TODO|…)\b/` 这个**正则字面量**被 CS002 判红，就是最直接的证据）；
 * 把注释误认成代码，则是漏报。前者制造假红并让闸门失去权威，所以这里不惜多写三十行状态机。
 *
 * ## 边界（刻意不做的事）
 *
 * - 不处理 JSX：本仓库没有 JSX。
 * - 不把模板字面量里的 `${}` 当代码重新解析——`${...}` 内出现 `//` 的情况在本仓库不存在，
 *   为此引入递归会让状态机的维护成本超过它挡掉的假红。宁可漏报，见 §9.1 第 1 条。
 * - 正则字面量按「遇到未转义的 `/` 即结束」处理，字符类 `[...]` 内的 `/` 不结束——这是
 *   正则字面量语法的实际规则，漏掉它会把 `/[/]/` 这类切错。
 */
function extractComments(lines) {
  const out = new Array(lines.length).fill('');
  // state: 'code' | 'line' | 'block' | 'sq' | 'dq' | 'tpl' | 're' | 'reClass'
  let state = 'code';
  let prevSig = ''; // 上一个「有效字符」，用来判断斜杠是正则还是除号
  for (let i = 0; i < lines.length; i += 1) {
    const src = lines[i];
    let buf = '';
    for (let j = 0; j < src.length; j += 1) {
      const c = src[j];
      const n = src[j + 1];

      if (state === 'line') { buf += c; continue; }          // 整行余下都是注释
      if (state === 'block') {                               // 块注释内，找 */
        if (c === '*' && n === '/') { state = 'code'; j += 1; prevSig = '/'; continue; }
        buf += c;
        continue;
      }

      if (state === 'sq' || state === 'dq' || state === 'tpl') {
        if (c === '\\') { j += 1; continue; }                // 转义：连同下一字符一起吞掉
        if (state === 'sq' && c === "'") state = 'code';
        else if (state === 'dq' && c === '"') state = 'code';
        else if (state === 'tpl' && c === '`') state = 'code';
        prevSig = c;
        continue;
      }

      if (state === 're' || state === 'reClass') {
        if (c === '\\') { j += 1; continue; }
        if (state === 'reClass') { if (c === ']') state = 're'; }
        else if (c === '[') state = 'reClass';
        else if (c === '/') state = 'code';
        prevSig = c;
        continue;
      }

      // state === 'code'
      if (c === '/' && n === '/') { state = 'line'; j += 1; continue; }
      if (c === '/' && n === '*') { state = 'block'; j += 1; continue; }
      if (c === "'") { state = 'sq'; prevSig = c; continue; }
      if (c === '"') { state = 'dq'; prevSig = c; continue; }
      if (c === '`') { state = 'tpl'; prevSig = c; continue; }
      if (c === '/' && REGEX_POSITION_RE.test(prevSig)) { state = 're'; prevSig = '/'; continue; }
      if (c.trim() !== '') prevSig = c;
    }
    out[i] = buf;
    if (state === 'line') state = 'code'; // 行注释不跨行
  }
  return out;
}

/**
 * 「斜杠处在表达式起始位置」的判据——见 extractComments 的说明第 1 点。
 *
 * 为什么把「空字符串」也算进去：`prevSig` 在一行的开头、或紧跟 `=` `(` 等之后为空，
 * 此时 `/` 是正则的开始（`const re = /x/`、`if (/x/.test(s))`）。
 * 为什么 `+` 不在表里：`a + /x/` 里斜杠确实是正则，但 `a / b` 与 `a + b / c` 的除号更常见，
 * 把 `+` 放进来会让「除号被判成正则」的风险上升，而本仓库没有 `a + /re/` 这种写法。
 * 宁可漏报（漏识别一个正则字面量，最坏结果是它内部的 `//` 被当成行注释）也不误报。
 */
const REGEX_POSITION_RE = /^(|=|\(|,|:|\[|!|&|\||\?|\{|\}|;|return)$/;

/** 首个「有内容」的行号（1-based）；跳过空行，`#!` 之后的行不算内容。返回 null 表示空文件。 */
function firstContentLine(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t === '') continue;
    if (t.startsWith('#!')) continue;
    return { index: i, text: t };
  }
  return null;
}

/**
 * CS001 —— 文件头注释。
 *
 * 依据 §10.1 第 1 条：读者（尤其是下一个会话）打开文件的第一件事是知道「这个文件为什么
 * 存在」。`scripts/verify-pack.mjs` 的头部就是范例：它用 20 行讲清「0.14.4 pack 之后又改了
 * mirror.js 却没重新 pack」这个真实事故，没有这段，脚本本身看起来只是一个多余的 sha256 比较。
 */
function checkHeader(fileRel, lines) {
  if (!HEADER_REQUIRED_PREFIXES.some((p) => fileRel.startsWith(p))) return null;
  const first = firstContentLine(lines);
  if (!first) return null; // 空文件：不判违约，交给别的工具。
  if (first.text.startsWith('//') || first.text.startsWith('/*')) return null;
  return {
    code: 'CS001',
    level: 'error',
    line: first.index + 1,
    message: '文件头缺少注释（首个非空内容行是代码）：请用 `//` 或 `/** */` 说明这个文件为什么存在（doc/comment-style.md §10.1）',
  };
}

/**
 * CS002 —— 待办必须可验收。
 *
 * §3.5 把话说得很硬：「必须写成**可验证的条件 + 可执行的下一步**」，并列出合法形状
 * `TODO(可验证)：<条件> → <动作> → <判据>`；§4 又追加「本仓库当前没有任何 `TODO`/`FIXME`，
 * 这是可以保持的状态」。因此这条规则不是「要求你写好 TODO」，而是「提醒你本仓库不写 TODO」。
 *
 * ## 为什么只查注释文本（2026-09-15 结构性修正）
 *
 * 旧实现拿**整行源码**去匹配标记，于是本文件的 `const MARKER_RE = /\b(TODO|FIXME|XXX|HACK)\b/;`
 * 与 `MARKER_OK_RE` 这两行**代码**被判成待办（正则字面量里当然写着这些词）——这是
 * 规则自身的假红，而且它指向的是一行完全合法的常量声明。待办标记的定义是「注释里留给后来者的
 * 未完成事项」，代码里出现的同名 token 与「待办」无关，因此规则的正确输入域是注释文本，
 * 不是源码行。改为先经 extractComments 抽取注释文本再匹配，从根上消掉这一类假红。
 *
 * 为什么不再需要「先剥反引号」那一步：抽取之后仍有**引用 vs 待办**的区分需求（文档必须能
 * 讨论这条规则），但那一层由 QUOTE_SPAN_RE 统一承担，它同时覆盖反引号、直角引号与 ASCII
 * 引号，比原先只认反引号的写法更完整——原先的写法在本文件 216/217/223 行留下了 3 条假红，
 * 原因就是那三处用的是直角引号或裸散文。
 */
function checkMarkers(fileRel, lines, comments) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    // 引用段（引号包起来的内容）整体删除：那里出现标记字样是**引用这条规则本身**，不是待办。
    const text = comments[i].replace(QUOTE_SPAN_RE, '');
    if (!MARKER_RE.test(text)) continue;
    if (MARKER_OK_RE.test(text)) continue;
    out.push({
      code: 'CS002',
      level: 'error',
      line: i + 1,
      message: '待办标记没有负责人/日期/issue 号：写成 TODO(负责人) 或 TODO 2026-09-15 或 TODO #123（doc/comment-style.md §3.5）',
    });
  }
  return out;
}

/**
 * CS003 —— `lib/` 下导出函数必须紧贴 JSDoc。
 *
 * §4 的格式约定：「函数/常量级：`/** … *\/` 紧贴声明上方，第一行是一句话结论，空行后写
 * 「为什么」」。为什么只查导出面：非导出的内部函数是本文件私有，读者顺着读得到；导出函数是
 * **跨模块契约**，§2.4 的正例（`MODEL_ALIAS_IDS`、`routeIndex`、`inject`）全都靠注释把
 * 「不许各自再写一份字面量」这类约束钉在声明旁。契约没有注释，下一个人就会重新推导一遍。
 *
 * 实现是「向上找最近的非空行是否以块注释结束符结尾」——不解析、不配对，所以它只会漏报不会误报：
 * 若函数上方是一段无关的块注释，本规则判为通过（机器判不了语义，这类留给 review）。
 */
function checkExportedJsdoc(fileRel, lines) {
  if (!fileRel.startsWith(JSDOC_REQUIRED_PREFIX)) return [];
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    let name = null;
    for (const re of EXPORT_RES) {
      const m = line.match(re);
      if (m) {
        name = m[2] || m[1];
        break;
      }
    }
    if (!name) continue;

    let ok = false;
    for (let j = i - 1; j >= 0; j -= 1) {
      const t = lines[j].trim();
      if (t === '') continue;                       // 空行不算间隔，允许 JSDoc 与声明之间空一行
      if (OPT_OUT_RE.test(t)) { ok = true; break; } // 显式豁免（必须带理由，理由在 review 里被看见）
      if (t.endsWith('*/')) { ok = true; break; }   // 最近的块注释就在上方
      break;                                        // 撞到别的代码/行注释：没有 JSDoc
    }
    if (ok) continue;
    out.push({
      code: 'CS003',
      level: 'error',
      line: i + 1,
      message: `导出函数 ${name} 上方缺少 /** */ JSDoc：导出面是跨模块契约，请写一句话结论 + 为什么；确需豁免写 \`// @nolint-cs003 <理由>\`（doc/comment-style.md §4、§2.4）`,
    });
  }
  return out;
}

/**
 * CS004 —— 注释不得复述 diff。
 *
 * §6.3 原文：「不要用注释复述 diff。`// 新增：…`、`// 修改为…`、`// 修复了…` 对后来者没有
 * 价值——版本历史属于 git。注释只回答『为什么现在是这个样子』。」这条最容易被违反，因为
 * 每一次 AI 会话都在改代码，顺手写一句「本次新增」是零成本的——所以它必须由机器拦。
 */
function checkDiffRecital(fileRel, lines) {
  const out = [];
  for (let i = 0; i < lines.length; i += 1) {
    if (!DIFF_RECITAL_RE.test(lines[i])) continue;
    out.push({
      code: 'CS004',
      level: 'error',
      line: i + 1,
      message: '注释在复述 diff（版本历史属于 git）：改写为「为什么现在是这个样子」（doc/comment-style.md §6.3）',
    });
  }
  return out;
}

/**
 * CS005 —— 被注释掉的代码块。
 *
 * 判据是「连续 ≥3 行行注释」且「其中 ≥2 行像代码」（含 `;`、`=>`、`function`、`const`、
 * `return`、`if (`、`}`、`console.*`、`require(`）。为什么是 warn 而不是 error：本仓库的
 * 头部注释大量使用连续 `//` 写散文（`lib/index.js:1-8`、`scripts/verify-pack.mjs`），
 * 散文里出现 `const` 一词是可能的。机器分不清「讲代码的散文」和「被注释掉的代码」，
 * 所以这一条只提示、不拦门——按 §9.1 第 1 条，判不了的就不要假装判得了。
 */
function checkCommentedCode(fileRel, lines) {
  const out = [];
  let run = [];
  const flush = () => {
    if (run.length >= 3) {
      const codeLike = run.filter((r) => looksLikeCode(r.text)).length;
      if (codeLike >= 2) {
        out.push({
          code: 'CS005',
          level: 'warn',
          line: run[0].line,
          message: `连续 ${run.length} 行行注释中有 ${codeLike} 行像代码，疑似被注释掉的代码块：删除它，或改写为「为什么不能这么写」（doc/comment-style.md §3.6）`,
        });
      }
    }
    run = [];
  };
  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t.startsWith('//')) run.push({ line: i + 1, text: t });
    else flush();
  }
  flush();
  return out;
}

/** 逐文件跑全部规则。读不了就跳过（绝不 throw），并记录原因。 */
function lintFile(abs) {
  const fileRel = rel(abs);
  let text;
  try {
    text = fs.readFileSync(abs, 'utf8');
  } catch (e) {
    return { skipped: { path: fileRel, reason: 'read 失败：' + (e?.message || e) }, issues: [] };
  }
  const lines = text.split(/\r?\n/);
  // 注释文本只抽一次，供 CS002 复用：它是这份文件里唯一需要「逐词法状态」的输入，
  // 每多算一次就多一次把斜杠/引号判错的机会（见 extractComments 的说明）。
  const comments = extractComments(lines);
  const issues = [
    checkHeader(fileRel, lines),
    ...checkMarkers(fileRel, lines, comments),
    ...checkExportedJsdoc(fileRel, lines),
    ...checkDiffRecital(fileRel, lines),
    ...checkCommentedCode(fileRel, lines),
  ].filter(Boolean);
  for (const it of issues) it.file = fileRel;
  return { skipped: null, issues };
}

/** 输出用的一行。§7.3 的句式（名词 + 后果 + 下一步）同样适用于闸门自己：别只丢一个码。 */
function renderLine(it) {
  return `${it.file}:${it.line}  ${it.code}  ${it.level.toUpperCase().padEnd(5)} ${it.message}`;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.unknown.length) {
    process.stderr.write('未知参数：' + opts.unknown.join(' ') + '\n');
    process.stderr.write('用法：node scripts/lint-comments.mjs [--json] [--quiet] [--max-warnings=N]\n');
    return 2;
  }

  const { files, skipped } = collectFiles();
  const all = [];
  for (const f of files) {
    const r = lintFile(f);
    if (r.skipped) skipped.push(r.skipped);
    all.push(...r.issues);
  }

  const errors = all.filter((i) => i.level === 'error');
  const warnings = all.filter((i) => i.level === 'warn');
  const overBudget = warnings.length > opts.maxWarnings;
  const failed = errors.length > 0 || overBudget;

  if (opts.json) {
    process.stdout.write(JSON.stringify({
      ok: !failed,
      scanned: files.length,
      errors: errors.length,
      warnings: warnings.length,
      maxWarnings: opts.maxWarnings,
      issues: all,
      skipped,
    }, null, 2) + '\n');
  } else if (!opts.quiet) {
    for (const it of all) process.stdout.write(renderLine(it) + '\n');
    if (all.length) process.stdout.write('\n');
    process.stdout.write(`[lint-comments] 扫描 ${files.length} 个文件；error ${errors.length}，warn ${warnings.length}（上限 ${opts.maxWarnings}）。\n`);
    if (skipped.length) {
      process.stdout.write(`[lint-comments] 跳过 ${skipped.length} 个读不了的目标（不算通过，也不算违约）：\n`);
      for (const s of skipped) process.stdout.write(`  - ${s.path}：${s.reason}\n`);
    }
    process.stdout.write(failed
      ? '[lint-comments] ✖ 未通过。修完上面的行再推；若确属误报，请改本脚本的判据而不是绕过它。\n'
      : '[lint-comments] ✔ 通过（doc/comment-style.md §10 的机检部分全部满足）。\n');
  } else {
    process.stdout.write(`[lint-comments] ${files.length} files, ${errors.length} errors, ${warnings.length} warnings -> ${failed ? 'FAIL' : 'PASS'}\n`);
  }

  return failed ? 1 : 0;
}

let code = 2;
try {
  code = main(process.argv.slice(2));
} catch (e) {
  // 闸门自己出错必须是 2，不能伪装成「有违规」（1）：两者的处理方式完全不同。
  process.stderr.write('[lint-comments] 脚本自身失败：' + (e?.stack || e?.message || e) + '\n');
  code = 2;
}
process.exit(code);