#!/usr/bin/env node
/**
 * 生成物卫生检查（0.14.9）——「跑一次就会变」的文件不得被 git 看见。
 *
 * ## 为什么需要这个文件
 *
 * 基准 harness 每次运行都会写 `test-mock/prompt-bench/out/` 下的三份产物
 * （`report.md` / `report.json` / `records.csv`，其中 csv 带时间戳）。它们**每次内容都不同**。
 * 若没被忽略，`git status` 会一直列着它们，而 `git add -A` 会把它们顺手提进库——这正是
 * 「临时产物混进提交」这类漂移的典型形态，也是本项目 2026-09-15 实际踩到的：
 * `.gitignore:23` 的 `package/dsh-webcode-bridge/test-mock/out/` 是**按路径**匹配的，
 * **不覆盖**嵌套的 `test-mock/prompt-bench/out/`。
 *
 * 光修一次 `.gitignore` 不够：下一个人再加一个产物目录，同样的洞会再开一次。
 * 所以这里把**两个方向**都变成可机检的事实：
 *
 *   1. 已知的生成物路径**必须**被忽略（否则它们会污染提交）；
 *   2. 同目录下的**源文件必须仍然可跟踪**（否则忽略规则写宽了，源码会被静默漏掉，
 *      这类事故比前者更隐蔽——提交时看不出少了东西）。
 *
 * 只有两个方向同时成立，规则才算既有效又不误伤。
 *
 * ## 为什么用 `git check-ignore` 而不是读 .gitignore 文本
 *
 * 读文本只能证明「文件里有这行」，不能证明「规则真的对这条路径生效」——而真机出事
 * 恰恰是「有规则、但不匹配这个路径」。`git check-ignore` 问的是 git **实际**的判定。
 *
 * 退出码：0 = 两个方向都符合；1 = 有生成物会泄漏，或有源文件被误忽略。
 * 未安装 git 或不在工作树内时**跳过并说明**（不假装通过，也不误报失败）。
 */
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
// test-mock/ → package/dsh-webcode-bridge/ → package/ → 仓库根
const repoRoot = path.resolve(here, '..', '..', '..');

/** 已知的「每次跑都会变」的生成物。新增产物目录时**必须**在这里登记。 */
const GENERATED = [
  'package/dsh-webcode-bridge/test-mock/prompt-bench/out/report.md',
  'package/dsh-webcode-bridge/test-mock/prompt-bench/out/report.json',
  'package/dsh-webcode-bridge/test-mock/prompt-bench/out/records.csv',
  // 2026-09-16 新增：`inspect-harness.mjs` 的探针产物（截图 + 页面全文 + 当前 URL）。
  // 登记它的直接原因是**这条规则当时是死的**：`.gitignore` 写的是 `package/output/`，
  // 而真实路径是 `package/dsh-webcode-bridge/output/`（`inspect-harness.mjs:42,57`
  // 的 `fs.mkdir('output/playwright')` 相对**包目录**解析）。规则「存在但作用域写错」，
  // 于是这些产物从未被挡住——这正是本文件存在的意义：把「有规则」升级成「规则真的生效」。
  'package/dsh-webcode-bridge/output/playwright/harness-home.png',
  'package/dsh-webcode-bridge/output/playwright/harness-task-url.txt',
  // 2026-09-16 新增：AgentTeams 的运行时状态（team.json / inbox/*.jsonl）。
  // 它引用会话 id 与用户原话，与 PLAN*.md、REPORT.md 同一条口径：本地私有留痕，不入库。
  // 它此前**没有任何规则**，`git status` 直接列着 `.agent-teams/`。
  '.agent-teams/webcode-bridge-0-16/team.json',
  // 2026-09-16 新增：`reference/*/` 的第三方克隆必须继续被忽略。
  //
  // 这是 `reference/` 的**全部约定**：316 MB 第三方代码不入库，只把「来源与版本」
  // 入库（`reference/README.md`）。约定此前**只写在 .gitignore 的注释里、没有任何脚本守着**
  // ——实测 `git grep -n reference -- scripts package/dsh-webcode-bridge/test-mock/artifacts-check.mjs`
  // 是 **0 命中**，而本文件自己的文件头（第 14-22 行）与 `.gitignore` 的注释都声称
  // 「新增产物目录时必须在这里登记」。这条补上，正是把该声称变成事实。
  //
  // 用不存在的路径来验**规则**而不是验某个具体克隆：`git check-ignore` 是纯模式匹配，
  // 不要求文件存在。这样既避开 CJK 文件名的跨平台差异，也不会因为某人删掉某个克隆而假红。
  'reference/example-clone/some-file.js',
  'reference/example.pdf',
];

/** 同区域的源文件：它们**必须**仍可被 git 跟踪（防止忽略规则写宽了）。 */
const SOURCES = [
  'package/dsh-webcode-bridge/test-mock/prompt-bench.mjs',
  'package/dsh-webcode-bridge/test-mock/bench-ci.mjs',
  'package/dsh-webcode-bridge/test-mock/prompt-bench/cases.json',
  'package/dsh-webcode-bridge/test-mock/prompt-bench/negative-control/cases.json',
  // 与上面那条探针产物同目录的**源码**：它是产物目录里唯一必须留在库里的东西，
  // 因此正好用来守住「忽略规则没写宽到把 output/ 整个吞掉」这一侧。
  'package/dsh-webcode-bridge/test-mock/inspect-harness.mjs',
  // 2026-09-16 新增：`reference/` 里**必须仍然可跟踪**的两类东西。
  // 它们是上一条「克隆必须被忽略」的反向安全线——`.gitignore:9` 的 `reference/*/`
  // 一旦被写宽（例如改成 `reference/`），这两个文件会被静默漏掉，
  // 而 `reference/README.md` 恰恰是让「故意不入库」这件事**可被克隆者理解**的唯一入口。
  'reference/README.md',
  'reference/local-refs/agent-teams-reference-notes.md',
];

/** git check-ignore 的判定；返回 true=被忽略。用 -q 只取退出码。 */
function isIgnored(rel) {
  const r = spawnSync('git', ['check-ignore', '-q', '--', rel], { cwd: repoRoot, stdio: 'ignore' });
  if (r.error) return { error: r.error.message };
  // --no-index 不开，所以未被跟踪但也不被忽略的文件返回 1（=不忽略），符合预期。
  return { ignored: r.status === 0 };
}

// 先确认我们确实在一个 git 工作树里；否则跳过而不是误报。
const probe = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoRoot, encoding: 'utf8' });
if (probe.status !== 0) {
  console.log('[artifacts] SKIP  不在 git 工作树内（或未安装 git），本次不检查。');
  console.log('[artifacts] 注意：这是**跳过**而非通过——CI 环境应保证 git 可用。');
  process.exit(0);
}

let bad = 0;

for (const rel of GENERATED) {
  const r = isIgnored(rel);
  if (r.error) { console.error(`[artifacts] FAIL  ${rel} 无法判定：${r.error}`); bad++; continue; }
  if (r.ignored) {
    console.log(`[artifacts] PASS  ${rel} 已被忽略（不会污染提交）`);
  } else {
    console.error(`[artifacts] FAIL  ${rel} **未被忽略**——它每次运行内容都变，会被 git add -A 顺手提进库`);
    bad++;
  }
}

for (const rel of SOURCES) {
  const r = isIgnored(rel);
  if (r.error) { console.error(`[artifacts] FAIL  ${rel} 无法判定：${r.error}`); bad++; continue; }
  if (!r.ignored) {
    console.log(`[artifacts] PASS  ${rel} 仍可被跟踪（忽略规则没有写宽）`);
  } else {
    console.error(`[artifacts] FAIL  ${rel} **被误忽略**——源文件会静默漏掉，比生成物泄漏更隐蔽`);
    bad++;
  }
}

console.log('');
if (bad) {
  console.error(`[artifacts] ${bad} 项不符合预期。`);
  console.error('[artifacts] 修复方向：在 .gitignore 里为「生成物所在目录」单独加按路径的规则');
  console.error('[artifacts] （注意 .gitignore 是按路径匹配的，父目录规则不覆盖嵌套子目录）；');
  console.error('[artifacts] 若新增了产物目录，请同时更新本文件的 GENERATED / SOURCES 清单。');
  process.exit(1);
}
console.log(`[artifacts] 全部符合预期：${GENERATED.length} 个生成物被忽略，${SOURCES.length} 个源文件仍可跟踪。`);
