// prompt-bench.mjs — 提示词基准实验的**配对比较 harness**（0.14.8）。
//
// 这个文件为什么存在：doc/research/prompt-engineering-evidence-2026-09-14.md（阶段 R 已入库，
// commit 180ee94）点名了它（L100 配对比较的设计、L101 「每题带机器可判的判据」），但 0.14.7
// 之前它并不存在——`lib/bench.js` 的判据层完整可用，却**只有它自己的测试一个消费者**。
// 本文件是它的第一个真实消费者：把「同一批真实失败题 × 多个提示词变体」跑成一个矩阵。
//
// 它刻意不做的三件事（都是文献结论，不是风格偏好）：
//   · 不做模型自评 —— arXiv 2502.06065：LLM 判断不了哪个提示词变体更好。判据必须来自
//     lib/bench.js 的结构事实。
//   · 不算显著性、不输出百分比提升 —— 每变体 ≤3 次时百分比是把噪声包装成结论。
//     报告里出现 lift/improvement/deltapercent/提升百分比 一律视为缺陷（有护栏，见 FORBIDDEN_REPORT_KEYS）。
//   · 不承诺某个提示词一定更好 —— NeurIPS 2024《On the Worst Prompt Performance of LLMs》：
//     效果不稳定且**无法提前识别最差形态**（Llama-2-70B 最好最差差 45.48%）。所以报告只给
//     「哪个变体在哪条判据上失败了几次」这种分布。
//
// 风控纪律（不可协商，doc/bridge-failure-ledger.md §3）：本 harness **默认离线**。
// 反复深链同一会话地址会触发站点风控（0.14.3 事故已实证），因此 --live 必须显式给出
// 批准串，且即使给了也只是**印出闸门参数、不发起任何网络请求**。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRun, judgeRun, summarizeRuns } from '../lib/bench.js';
import { buildPromptVariants, EXPERIMENT_SPECS } from '../lib/prompt-variants.js';

const here = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- 录制的 chunk 流
//
// 为什么是「构造」而不是「真机录制」：本轮不许新增真机探针（风控纪律，见
// bridge-failure-ledger.md §3「本轮零真机探针」）。因此这些 chunk 流的来源是**产线代码的
// chunk 契约**（lib/index.js 的 yield 点：block-end/text、block-end/tool-call、text-delta、
// finish）与**本仓已入库的真实失败取证**（每条 responses 的 note 里都写了出处）。
//
// 关键纪律：responses 里的每一条都必须是**该题判据能判出成败的最小完整轮**——不允许
// 「先写一条必然通过的流，再让判据去判另一件事」。判据与 chunk 流由同一个 caseId 绑定。

/** pwsh 的 required 与 agent-preset.js:147 说破的那一条一致：command + description。 */
const PWSH_REQUIRED = ['command', 'description'];

/**
 * 各题的「模型产出的最终回复」。**默认取「已经按判据写对的那一份」**。
 *
 * 这一点是刻意的，也是本 harness 唯一的反直觉之处，必须写在最前面：
 * 离线模式下没有什么「被测模型」，跑的是**判据层对一份已声明正确的产物给出的结论**。
 * 若默认流按真实历史失败原样录（模型漏了 command、用了 ls -la），那么全部变体都会
 * 稳定失败——报告变成一片红，而它传达的信息只是「录的是失败样本」，不是「哪个变体
 * 在哪条判据上有差别」。基准实验要有分辨力，默认基线就得是「按判据写对」的产物。
 *
 * 「判据层真的判得出来」由**反向对照**证明，不能靠默认基线自证：见
 * test/prompt-bench-harness.test.mjs（验收 F）用 below 的 DELIBERATELY_FAILING_RESPONSES
 * 覆盖同一批 caseId，断言 harness 报失败且退出码非 0。没有那条反向断言，
 * 「harness 永远通过」这种假绿无法被排除。
 *
 * 字段含义：
 *   calls    该轮发起的调用（name/args）
 *   text     该轮正文
 *   deltasOnly  异常路径：只有 text-delta、没有 text 块（bench.js:36-39 的兜底路径）
 */
const RESPONSES = {
  // 族 TOOL_ARGS_MISSING_REQUIRED：真机 session-ec60921d 逐字
  // `invalid arguments: missing required property "command"`（long-term-issues.md:704）。
  // 写对的样子 = arguments 里 command 与 description 都在（agent-preset.js:147 的 required 口径）。
  'required-args-command-missing': {
    calls: [{ name: 'pwsh', args: { command: 'Get-ChildItem -Force -Recurse -Filter *.md | Select-Object -First 20 FullName', description: 'list markdown files' } }],
    text: '我先看一下目录里的 Markdown 文件。',
  },
  // 同族第二键：真机 2026-09-13 cacaba8c turn3 是反过来的——command 有、description 缺
  // （agent-preset.js:144-147 的注释记着这次取证）。两条调用都在，判据是「每一个都齐」。
  'required-args-description-missing': {
    calls: [
      { name: 'pwsh', args: { command: 'Get-ChildItem -Force', description: 'list current directory entries' } },
      { name: 'pwsh', args: { command: 'Get-Date', description: 'print current date and time' } },
    ],
    text: '连续两条命令。',
  },
  // 族 PLATFORM_MISUSE：写对的样子 = 纯 PowerShell（无 ls -la、无 && 链）。
  // agent-preset.js:69-72 把这一族记成「真机轨迹里约一半的工具错误来自模型用 Unix 习惯命令打 Windows」。
  'windows-bash-idioms': {
    calls: [{ name: 'pwsh', args: { command: 'Get-ChildItem -Force -Recurse -Filter *.md | Select-Object -First 20 FullName', description: 'list markdown files with PowerShell syntax' } }],
    text: '用 PowerShell 的 Get-ChildItem 列一下 Markdown 文件。',
  },
  // 族 PROTOCOL_RESIDUE：0.14.6 修掉的那一族（逐字残片见 bridge-failure-ledger.md §2
  // 的 seq=91/119/179 取证）。写对的样子 = 正文干净、不夹带任何残片。
  'protocol-residue-call-family': {
    calls: [{ name: 'read', args: { path: 'README.md' } }],
    text: '我去读 README。',
  },
  'half-written-anchor-partial': {
    calls: [{ name: 'pwsh', args: { command: 'Get-Content package.json', description: 'print package manifest' } }],
    text: '先读一眼包清单。',
  },
  // 族 TEXT_DELTA_WITHOUT_BLOCK：网页侧只推了 delta、没有落块（异常路径）。
  // 正文取不到的话 maxTextChars 会永远通过 —— 这一题就是来钉死那条假绿的。
  'delta-only-no-block': {
    deltasOnly: true,
    text: '无工具调用完成本轮。',
  },
  // 反向对照：一次干净的纯文本收尾（expectCalls: [] 严格判 0 条）。
  'clean-stop-no-calls': {
    calls: [],
    text: '这是一个不需要调用工具的问题，直接回答即可。',
  },
  // 验收 F 的负向对照用例（配合 test-mock/prompt-bench/negative-control/cases.json 使用，
  // 见 test/prompt-bench-harness.test.mjs）：它的判据故意与这份产物方向相反，
  // 因此 --cases 指过去时**必然**报失败、退出码非 0 —— 这就是「harness 不是永远通过」的证明。
  'validate-check': {
    calls: [],
    text: '一段干净的收尾正文，既不调用 pwsh/read，也不含被判据要求出现的文字。',
  },
  // ---- 0.14.9：为**每一条判据**各配一个负向对照产物 ---------------------------
  // 为什么必须逐条配：原先负向对照只有 validate-check 一条，同时压 expectCalls /
  // expectFinish / expectTextIncludes 三条。于是若只把 requireArgs 一条判据写坏成恒真，
  // 负向对照**仍然会红**（被另外两条拉住），假绿检测有缺口——这个缺口是实测发现的：
  // 把 expectCalls 的检查改成 `if (false && ...)` 之后 bench-ci 依然全绿。
  // 现在每条判据都有独立产物：坏哪条，对应的负向用例就会变绿，bench-ci 立刻报红。
  //
  // 四个产物都刻意做成「调用存在且参数非空」的干净形状，这样除了目标判据以外
  // 其余判据都不会先失败——单一判据失效才能被单独观测到。
  'nc-require-args': {
    calls: [{ name: 'pwsh', args: { command: 'Get-Date', description: 'print current date' } }],
    text: '一条参数齐全的调用。',
  },
  'nc-expect-args-at': {
    calls: [{ name: 'pwsh', args: { command: 'Get-Date', description: 'print current date' } }],
    text: '一条参数齐全的调用。',
  },
  'nc-max-text-chars': {
    calls: [],
    text: '这段收尾正文是正常长度的一句话，用来让「正文过长」这条判据有可比的对象。',
  },
  'nc-expect-no-leak': {
    calls: [],
    // 这一题**故意带残片**：expectNoLeak 判据要求正文里的 leaks 必须为空，
    // 而这里塞了两处真机取证过的残片形态（bridge-failure-ledger.md §2 的 seq=91/179）。
    text: '正文里混进了残片：</call> 以及半截的 </call_call>。',
  },
};

/**
 * 故意写错的产物（**只给测试用**，正常运行时不会被选中）。
 *
 * 为什么要把它放进产线文件而不是测试文件里：验收 F 要断言的是「harness 真的会报失败」，
 * 而最容易写成假绿的方式就是让测试自己造一份数据、绕开 harness 的加载与判据路径。
 * 放在这里意味着 F 走的是**与默认跑完全相同的** runOffline/judgeRun/main 路径，只换产物。
 * 另外它也让「每一题都至少能被判失败一次」成为可机检的事实（见下方 selfCheckCoverage）。
 */
const DELIBERATELY_FAILING_RESPONSES = {
  'required-args-command-missing': { calls: [{ name: 'pwsh', args: { description: 'missing command on purpose' } }], text: '漏了 command。' },
  'required-args-description-missing': { calls: [{ name: 'pwsh', args: { command: 'Get-Date', description: '' } }], text: 'description 为空。' },
  'windows-bash-idioms': { calls: [{ name: 'pwsh', args: { command: 'ls -la && git status', description: 'bash idioms on purpose' } }], text: '用了 bash 语法。' },
  'protocol-residue-call-family': { calls: [{ name: 'read', args: { path: 'README.md' } }], text: '读完了。</call>\n</call_call>' },
  'half-written-anchor-partial': { calls: [{ name: 'pwsh', args: { command: 'Get-Date', description: 'print date' } }], text: '半截锚点：<call' },
  'delta-only-no-block': { deltasOnly: true, text: '这段正文特别长'.repeat(40) },
  'clean-stop-no-calls': { calls: [{ name: 'read', args: { path: 'x' } }], text: '不该有调用。' },
  // 验收 F 用的临时用例（test-mock/prompt-bench/negative-control/）在此登记，
  // 保证 --cases 指向它时自检同样跑得通：这是「判据可被反证」这条纪律的自我应用。
  'validate-check': { calls: [], text: '一段干净的收尾正文，既不调用 pwsh/read，也不含被判据要求出现的文字。' },
  // 0.14.9 逐判据负向对照的产物侧登记（理由见 RESPONSES 里同名条目的注释）。
  // 四题都要能被判失败，否则 selfCheckCoverage 会直接拦下这份文件。
  // 注意 nc-expect-no-leak：判据是 expectNoLeak:true，所以「故意写错的产物」必须
  // **仍然带残片**才判得出来失败。第一版我错写成干净正文，被 selfCheckCoverage
  // 当场拦下（"用故意写错的产物仍然判为通过 → 该题的判据立不住"）——这条自检
  // 正是为了防止我这种错误。
  'nc-require-args': { calls: [{ name: 'pwsh', args: { command: 'Get-Date' } }], text: '漏了 description。' },
  'nc-expect-args-at': { calls: [{ name: 'pwsh', args: { command: 'Get-Date', description: '' } }], text: 'command 的值不对。' },
  'nc-max-text-chars': { calls: [], text: '这段正文特别长'.repeat(20) },
  'nc-expect-no-leak': { calls: [], text: '故意留着残片：</call> 与半截的 </call_call>。' },
};

/** 把一条 response 展开成产线形状的 chunk 流（lib/index.js 的 yield 契约）。 */
function chunksFor(caseId, responses = RESPONSES) {
  const r = responses[caseId];
  if (!r) throw new Error(`responses 缺这个 caseId 的录制流：${caseId}`);
  const chunks = [];
  if (r.deltasOnly) {
    // 只出 delta、不出块：正文必须仍被 collectRun 取到（否则 maxTextChars 判据失效）。
    chunks.push({ type: 'text-delta', index: 0, text: String(r.text).slice(0, 5) });
    chunks.push({ type: 'text-delta', index: 0, text: String(r.text).slice(5) });
  } else if (r.text) {
    // 产线契约：text-delta 与 text 块是同一段正文的两种呈现，逐字一致（index.js 配平契约）。
    chunks.push({ type: 'text-delta', index: 0, text: r.text });
    chunks.push({ type: 'block-end', index: 0, block: { type: 'text', text: r.text } });
  }
  for (const [i, c] of (r.calls || []).entries()) {
    // arguments 走 JSON 字符串形状（产线 lib/index.js:926 就是这么发的）。
    chunks.push({ type: 'block-end', index: i + 1, block: { type: 'tool-call', id: `c${i + 1}`, name: c.name, arguments: JSON.stringify(c.args) } });
  }
  const kind = (r.calls && r.calls.length) ? 'tool-calls' : 'stop';
  chunks.push({ type: 'finish', reason: { kind } });
  return chunks;
}

// ---------------------------------------------------------------- --live 闸门
//
// 风控纪律的三项参数（bridge-failure-ledger.md §3：探针间隔 ≥20s、最多 3 次）。
// 这里**只做闸与提示，不做真机自动化**：本 harness 没有任何联网代码路径。
const LIVE_APPROVAL_TOKEN = 'APPROVE-WEBCODE-LIVE-BENCH';
const LIVE_LIMITS = Object.freeze({ maxRunsPerVariant: 3, minGapMs: 20_000, serial: true });

/** 解析 argv。刻意手写而不引依赖：这个目录里的脚本都是可直接 node 运行的独立工具。 */
function parseArgs(argv) {
  const out = { live: false, approve: '', experiments: false, json: false, cases: '', help: false, unknown: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--live') out.live = true;
    else if (a === '--offline') out.live = false;
    else if (a === '--experiments') out.experiments = true;
    else if (a === '--json') out.json = true;
    else if (a === '--approve') out.approve = String(argv[i += 1] ?? '');
    else if (a.startsWith('--approve=')) out.approve = a.slice('--approve='.length);
    else if (a === '--cases') out.cases = String(argv[i += 1] ?? '');
    else if (a === '--help' || a === '-h') out.help = true;
    else out.unknown.push(a);
  }
  return out;
}

function loadCases(file) {
  const p = file ? path.resolve(process.cwd(), file) : path.join(here, 'prompt-bench', 'cases.json');
  const doc = JSON.parse(fs.readFileSync(p, 'utf8'));
  const cases = Array.isArray(doc) ? doc : doc?.cases;
  if (!Array.isArray(cases) || !cases.length) throw new Error(`cases.json 里没有 cases 数组：${p}`);
  // id 必须唯一：重复 id 会让「哪个变体在哪道题上失败」这个分布表失去意义
  // （同一 id 出两行，summarizeRuns 的 caseId 无法区分）。
  const ids = cases.map((c) => c.id);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) throw new Error(`cases.json 的 id 必须唯一，重复：${[...new Set(dup)].join(', ')}`);
  for (const c of cases) if (!c || typeof c.id !== 'string' || !c.id.trim()) throw new Error('cases.json 每题必须有非空 id');
  return { path: p, cases };
}

// ---------------------------------------------------------------- 报告
//
// 报告里**禁止**出现百分比提升字段。这些名字的出现即视为缺陷，不是「措辞问题」：
// 每变体 ≤3 次时任何百分比都是把噪声包装成结论（lib/bench.js 的 summarizeRuns 注释同一口径）。
const FORBIDDEN_REPORT_RE = /lift|improvement|deltapercent|提升百分比/i;

function renderReport({ caseFile, variants, records, summary, mode }) {
  const lines = [];
  lines.push('# 提示词基准实验报告（配对比较）');
  lines.push('');
  lines.push(`模式：${mode}`);
  lines.push(`用例文件：${caseFile}`);
  lines.push(`用例数：${new Set(records.map((r) => r.caseId)).size}；变体数：${variants.length}；记录数：${summary.totalRuns}`);
  lines.push('判据层：lib/bench.js 的 collectRun/judgeRun（结构事实，非模型自评）');
  lines.push('');
  lines.push('## 通过计数');
  lines.push('');
  lines.push('| 变体 | 运行 | 通过 | 失败 | 首轮提示词字符数(min/avg/max) |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const v of summary.variants) {
    const pc = v.promptCharsMin === v.promptCharsMax ? String(v.promptCharsAvg) : `${v.promptCharsMin}/${v.promptCharsAvg}/${v.promptCharsMax}`;
    lines.push(`| ${v.variant} | ${v.runs} | ${v.passed} | ${v.failed} | ${pc} |`);
  }
  lines.push('');
  lines.push('## 失败分布（按判据类别，取自 judgeRun 的 failureKinds）');
  lines.push('');
  lines.push('| 变体 | 判据类别 | 次数 |');
  lines.push('| --- | --- | --- |');
  for (const v of summary.variants) {
    const keys = Object.keys(v.failureCounts);
    if (!keys.length) { lines.push(`| ${v.variant} | （无） | 0 |`); continue; }
    for (const k of keys.sort()) lines.push(`| ${v.variant} | ${k} | ${v.failureCounts[k]} |`);
  }
  lines.push('');
  lines.push('## 逐题明细');
  lines.push('');
  lines.push('| 变体 | 用例 | 结果 | 失败原因 |');
  lines.push('| --- | --- | --- | --- |');
  for (const r of records) {
    const verdict = r.pass ? 'PASS' : 'FAIL';
    // Markdown 表格单元格转义：**先反斜杠再竖线**。
    // 顺序不能反：CodeQL js/incomplete-sanitization 报的正是这个形状（0.19.26 前只转 `|`）。
    // 若先转竖线再转反斜杠，新插入的 `\|` 里那个反斜杠会被第二步再转一次，
    // 变成 `\\|` —— 竖线又回到「未被转义」的状态，整张表在该行塌掉。
    // 这类「看着像转义了、其实漏了一种元字符」是本仓库记过的同型缺陷。
    const why = r.pass ? '' : r.failures.join(' ;; ').replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
    lines.push(`| ${r.variant} | ${r.caseId} | ${verdict} | ${why} |`);
  }
  lines.push('');
  lines.push('## 披露（summarizeRuns 的 disclosure 原文）');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(summary.disclosure, null, 2));
  lines.push('```');
  lines.push('');
  lines.push('> 本报告只给计数与分布。每变体运行次数 ≤3，不足以支撑任何「哪个提示词更好」的结论'
    + '（NeurIPS 2024：提示词效果不稳定且无法提前识别最差形态；arXiv 2502.06065：LLM 自评不可靠）。');
  return lines.join('\n') + '\n';
}

/** 从记录里生成 CSV 行（含机器码，便于直接分桶，不用去解析散文）。 */
function renderCsv(records) {
  const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const head = 'variant,caseId,pass,promptChars,failureKinds,failures';
  const rows = records.map((r) => [r.variant, r.caseId, r.pass, r.promptChars, (r.failureKinds || []).join('|'), (r.failures || []).join(' | ')].map(esc).join(','));
  return [head, ...rows].join('\n') + '\n';
}

// ---------------------------------------------------------------- 主流程

function runOffline({ cases, variantList, responses = RESPONSES }) {
  const records = [];
  for (const v of variantList) {
    for (const c of cases) {
      const run = collectRun(chunksFor(c.id, responses));
      const verdict = judgeRun(c, run);
      records.push({
        variant: v.id,
        caseId: c.id,
        pass: verdict.pass,
        failures: verdict.failures,
        failureKinds: verdict.failureKinds,
        promptChars: v.text.length,
        run,
      });
    }
  }
  return records;
}

/**
 * 自检：cases.json 里每一题都必须**至少能被判失败一次**。
 *
 * 为什么这条自检必须在 harness 里而不是只写在测试里：一道从没被判失败过的题，等于
 * 永远通过——「harness 永远通过」这种假绿正是验收 F 要防的东西。判据层是否有效不能
 * 靠默认基线自证（默认基线是按判据写对的产物，本来就该全过），只能靠故意写错的产物反证。
 * 这里用同一个 cases.json、同一个 judgeRun，只换产物；任一道题的反向运行意外通过，
 * 说明该题的判据立不住（例如只声明了 maxTextChars 而正文其实取不到），直接拦下。
 *
 * @returns {string[]} 说明哪些题无法被判失败（空数组 = 每一题的判据都有效）
 */
function selfCheckCoverage({ cases, responses = DELIBERATELY_FAILING_RESPONSES }) {
  const holes = [];
  for (const c of cases) {
    if (!responses[c.id]) { holes.push(`${c.id}：没有故意写错的产物，判据无法被反证`); continue; }
    const verdict = judgeRun(c, collectRun(chunksFor(c.id, responses)));
    if (verdict.pass) holes.push(`${c.id}：用故意写错的产物仍然判为通过 → 该题的判据立不住`);
  }
  return holes;
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write([
      '用法：node test-mock/prompt-bench.mjs [选项]',
      '',
      '  （默认）            离线配对比较：用录制的 chunk 流跑，不联网、不碰真机、不启动浏览器',
      '  --experiments       把 EXPERIMENT_SPECS（reinstruct / slim）一并纳入比较',
      '  --cases <file>      指定 cases.json（默认 test-mock/prompt-bench/cases.json）',
      '  --json              另写一份 JSON 报告（含 disclosure 原文）到 test-mock/prompt-bench/out/',
      '  --live              要求真机跑（必须同时给 --approve ' + LIVE_APPROVAL_TOKEN + '）',
      '  --offline           显式声明离线（默认行为）',
      '',
      '退出码：全部通过 0；有失败 1；参数/文件错误 2；--live 未获批准 3。',
      '',
    ].join('\n'));
    return 0;
  }

  if (opts.unknown.length) {
    process.stderr.write(`未知参数：${opts.unknown.join(' ')}\n用 --help 看用法。\n`);
    return 2;
  }

  // --live 闸门：不给批准串就**明确拒绝**，并且不落下任何网络副作用。
  if (opts.live) {
    if (opts.approve !== LIVE_APPROVAL_TOKEN) {
      process.stderr.write([
        'REFUSED: --live 未获得显式批准，本轮不得联网。',
        '',
        '为什么默认拒绝：反复深链同一会话地址会触发站点风控（0.14.3 事故已实证，见',
        'doc/bridge-failure-ledger.md §3）。因此本 harness 默认离线，真机跑需要人为批准。',
        '',
        `若确需真机跑，必须显式给出批准串：--live --approve ${LIVE_APPROVAL_TOKEN}`,
        '',
        '即使批准，纪律也不放宽（串行 / 每变体 ≤3 次 / 间隔 ≥20s）：',
        `  · serial=${LIVE_LIMITS.serial}  maxRunsPerVariant=${LIVE_LIMITS.maxRunsPerVariant}  minGapMs=${LIVE_LIMITS.minGapMs}`,
        '',
        '注意：本 harness 不实现真机自动化（探针一律走 test-mock/real-probe-*.mjs 并覆盖到',
        '独立 WEBCODE_PROFILE_DIR）。--live 通过后只印闸门参数，不发起任何网络请求。',
        '',
      ].join('\n'));
      return 3;
    }
    process.stdout.write([
      '--live 已显式批准，以下闸门不放宽：',
      `  serial=${LIVE_LIMITS.serial}  maxRunsPerVariant=${LIVE_LIMITS.maxRunsPerVariant}  minGapMs=${LIVE_LIMITS.minGapMs}`,
      '本 harness 不实现真机自动化（无联网代码路径），本次仍按离线矩阵执行。',
      '',
    ].join('\n'));
  }

  const { path: caseFile, cases } = loadCases(opts.cases);
  // 自检先跑：判据立不住的用例要在出报告之前就暴露，而不是让报告"全绿"地过去。
  const holes = selfCheckCoverage({ cases });
  if (holes.length) {
    process.stderr.write('判据自检失败（这些题无法被反证为"判得出来"）：\n' + holes.map((h) => '  ' + h).join('\n') + '\n');
    return 2;
  }
  const { variants } = buildPromptVariants({ experiments: opts.experiments });
  const records = runOffline({ cases, variantList: variants });
  const summary = summarizeRuns(records);
  const report = renderReport({ caseFile, variants, records, summary, mode: opts.live ? 'live-approved（仍离线执行）' : 'offline' });

  // 报告自检：出现百分比提升字段即缺陷（不是措辞问题，见 FORBIDDEN_REPORT_RE）。
  const hit = report.match(FORBIDDEN_REPORT_RE);
  if (hit) {
    process.stderr.write(`报告自检失败：出现禁止的百分比提升字段「${hit[0]}」。\n`);
    return 2;
  }

  const outDir = path.join(here, 'prompt-bench', 'out');
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, 'report.md');
  fs.writeFileSync(reportPath, report, 'utf8');
  fs.writeFileSync(path.join(outDir, 'records.csv'), renderCsv(records), 'utf8');
  if (opts.json) {
    fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ caseFile, experiments: opts.experiments, summary, records }, null, 2), 'utf8');
  }

  const failed = records.filter((r) => !r.pass);
  process.stdout.write(`用例 ${cases.length} 题 × 变体 ${variants.length} 个 = ${summary.totalRuns} 次运行；通过 ${summary.totalPassed}/${summary.totalRuns}\n`);
  process.stdout.write(`变体：${variants.map((v) => `${v.id}(${v.experimental ? 'experimental' : 'production'}, ${v.text.length}字符)`).join('  ')}\n`);
  process.stdout.write(`报告：${path.relative(process.cwd(), reportPath)}\n`);
  if (failed.length) {
    process.stdout.write(`\n失败 ${failed.length} 条：\n`);
    for (const r of failed) process.stdout.write(`  [${r.variant}] ${r.caseId}: ${r.failures.join(' ;; ')}\n`);
  }
  return failed.length ? 1 : 0;
}

// 只在被直接执行时跑主流程（被测试 import 时不跑，便于复用 RESPONSES/chunksFor）。
const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  let code = 2;
  try {
    code = main(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`prompt-bench 失败：${e && e.message ? e.message : e}\n`);
    code = 2;
  }
  process.exitCode = code;
}

export { RESPONSES, DELIBERATELY_FAILING_RESPONSES, chunksFor, parseArgs, loadCases, renderReport, renderCsv, runOffline, selfCheckCoverage, main, LIVE_LIMITS, LIVE_APPROVAL_TOKEN, FORBIDDEN_REPORT_RE, EXPERIMENT_SPECS };
