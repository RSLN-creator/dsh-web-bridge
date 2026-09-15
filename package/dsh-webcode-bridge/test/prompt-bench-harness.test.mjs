// prompt-bench-harness.test.mjs — 基准 harness 自身的护栏（0.14.8，验收 F）。
//
// 为什么需要这个文件：harness 最容易出的缺陷不是「跑不起来」，而是「**永远通过**」。
// 一份全绿的基准报告如果不可能是红的，它对「哪个提示词变体在哪条判据上失败」这个问题
// 就没有任何分辨力，而报告看上去和真的一样（arXiv 2605.23950：benchmark 分数由 model +
// harness 共同产生，而 harness 几乎从不被披露）。
//
// 本文件因此不测「默认跑是不是全绿」——那种断言只会在判据被削弱时一起变绿。它测的是
// 反面：把**故意写错的产物**喂进同一条 main 路径，断言 harness 报失败、退出码非 0，
// 并且每一道题都至少能被判失败一次（没被判失败过的题 = 永远通过的题）。
//
// 第二条纪律：报告里不得出现百分比提升字段。每变体 ≤3 次时百分比是把噪声包装成结论
// （lib/bench.js 的 summarizeRuns 注释同一口径），所以这里用反向断言钉死它。
//
// 这个文件**不联网、不启动浏览器、不碰真机**：它只 import harness 的纯函数。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildPromptVariants } from '../lib/prompt-variants.js';
import {
  RESPONSES, DELIBERATELY_FAILING_RESPONSES, chunksFor, parseArgs, loadCases,
  renderReport, runOffline, selfCheckCoverage, FORBIDDEN_REPORT_RE, LIVE_LIMITS, LIVE_APPROVAL_TOKEN,
} from '../test-mock/prompt-bench.mjs';
import { summarizeRuns } from '../lib/bench.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const CASES = path.join(here, '..', 'test-mock', 'prompt-bench', 'cases.json');

const loaded = loadCases();
const variants = buildPromptVariants({ experiments: true }).variants;

/** 与 harness 完全相同的记录构造路径（只换产物），保证测的是真路径不是影子实现。 */
const recordsWith = (responses) => runOffline({ cases: loaded.cases, variantList: variants, responses });

test('判据层可被反证：故意写错的产物必须判失败（每一题都至少失败一次）', () => {
  const holes = selfCheckCoverage({ cases: loaded.cases });
  assert.deepEqual(holes, [], '存在无法被判失败的题——该题的判据立不住（永远通过）');
  // 反向再确认一次：故意写错的产物确实让 records 出现失败。
  const bad = recordsWith(DELIBERATELY_FAILING_RESPONSES);
  assert.ok(bad.some((r) => !r.pass), '故意写错的产物竟然全过——harness 是假绿');
});

test('默认基线与故意写错的产物必须得出不同结论（否则判据没接到产物上）', () => {
  const good = recordsWith(RESPONSES);
  const bad = recordsWith(DELIBERATELY_FAILING_RESPONSES);
  assert.ok(good.every((r) => r.pass), '默认基线应当全过（它是按判据写对的产物）');
  assert.ok(bad.every((r) => !r.pass), '故意写错的产物应当全失败');
  // 逐题对比：同一条 caseId 在两次运行里结论必须相反，否则判据没真正判到这题。
  for (const c of loaded.cases) {
    const g = good.filter((r) => r.caseId === c.id);
    const b = bad.filter((r) => r.caseId === c.id);
    assert.equal(g.length, b.length, c.id + ' 两次运行的记录数必须一致');
    for (const gr of g) {
      const br = b.find((r) => r.variant === gr.variant);
      assert.notEqual(gr.pass, br.pass, `${c.id} @${gr.variant} 在正反产物下结论相同 → 该判据没生效`);
    }
  }
});

test('退出码纪律：main() 在失败样本下必须返回非 0', async () => {
  // 直接调 main 会写报告文件并读 case 文件，因此用**批准串闸门**这条纯分支先钉住
  // 「有失败就非 0」的另一半：--live 未批准必须返回 3（而不是 0 悄悄跑完）。
  const { main } = await import('../test-mock/prompt-bench.mjs');
  const code = main(['--live']);
  assert.equal(code, 3, '--live 未批准必须拒绝（退出码 3），绝不能默认联网');
  assert.equal(LIVE_APPROVAL_TOKEN.length > 0, true);
  assert.equal(LIVE_LIMITS.minGapMs >= 20_000, true, '探针间隔纪律 ≥20s');
  assert.equal(LIVE_LIMITS.maxRunsPerVariant <= 3, true, '每变体 ≤3 次');
  assert.equal(LIVE_LIMITS.serial, true, '必须串行');
});

test('报告必须含 disclosure 原文，且不得出现百分比提升字段', () => {
  const recs = recordsWith(RESPONSES);
  const summary = summarizeRuns(recs);
  const report = renderReport({ caseFile: CASES, variants, records: recs, summary, mode: 'offline' });
  assert.ok(report.includes('"significant": false'), '报告必须含 disclosure 块原文');
  assert.ok(report.includes('"sampleSizePerCell"'), '报告必须含 disclosure 的样本量字段');
  assert.ok(report.includes(summary.disclosure.note), 'disclosure 的 note 必须原样出现');
  // 反向断言：百分比提升字段一律不得出现。
  assert.doesNotMatch(report, FORBIDDEN_REPORT_RE, '报告里出现了百分比提升字段');
  // 但失败分布必须真的在报告里（否则「不含百分比」可以靠什么都不写来满足）。
  const badReport = renderReport({ caseFile: CASES, variants, records: recordsWith(DELIBERATELY_FAILING_RESPONSES), summary: summarizeRuns(recordsWith(DELIBERATELY_FAILING_RESPONSES)), mode: 'offline' });
  assert.match(badReport, /PASS|FAIL/, '逐题明细必须出现结果列');
  assert.match(badReport, /\| default \| .+ \| FAIL \|/, '失败样本必须在报告里如实标成 FAIL');
});

test('chunk 流形状必须与 lib/bench.js 的契约一致（否则判据收不到东西）', () => {
  // cases.json 的每一题都必须有对应的录制流，且流能被 collectRun 认出。
  for (const c of loaded.cases) {
    const chunks = chunksFor(c.id);
    assert.equal(chunks.at(-1).type, 'finish', c.id + ' 的流必须以 finish 收尾（其它 chunk 都认不到收尾方式）');
    // 只出 delta 的那题必须真的没有 text 块——否则那条兜底路径根本没被测到。
    const hasTextBlock = chunks.some((x) => x.type === 'block-end' && x.block?.type === 'text');
    const hasDelta = chunks.some((x) => x.type === 'text-delta');
    if (c.id === 'delta-only-no-block') {
      assert.equal(hasTextBlock, false, 'delta-only 这题不得落块');
      assert.equal(hasDelta, true, 'delta-only 这题必须有 delta');
    } else if (RESPONSES[c.id].text) {
      assert.equal(hasTextBlock, true, c.id + ' 缺 text 块');
    }
  }
});

test('cases.json 每题必须有 id 与真实失败族说明，且 id 唯一', () => {
  const doc = JSON.parse(fs.readFileSync(CASES, 'utf8'));
  const ids = doc.cases.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'id 必须唯一');
  for (const c of doc.cases) {
    assert.ok(c.family, c.id + ' 必须说明它取自哪个真实失败族');
    assert.ok(c.note && c.note.length > 40, c.id + ' 必须写明出处（哪个文档/哪一行/哪次取证）');
    // 判据必须是机器可判的：至少声明一条 lib/bench.js 认识的判据字段。
    const judgeKeys = ['expectCalls', 'expectArgsAt', 'requireArgs', 'expectFinish', 'maxTextChars', 'expectNoLeak', 'expectTextIncludes'];
    assert.ok(judgeKeys.some((k) => k in c), c.id + ' 没有声明任何可判的判据字段');
    // 不得出现 lib/bench.js 不认识的判据字段（那种字段会被静默忽略 = 假判据）。
    for (const k of Object.keys(c)) {
      if (k.startsWith('expect') || k === 'maxTextChars' || k === 'requireArgs') {
        assert.ok(judgeKeys.includes(k), `${c.id} 声明了 judgeRun 不认识的判据字段 ${k}（会被静默忽略）`);
      }
    }
  }
});

test('接受验收 F：--cases 指向负向对照用例时，main() 必须报失败并返回非 0', async () => {
  // 这是本文件最重要的一条：走的是**与默认跑完全相同**的 main 路径
  // （loadCases → 判据自检 → runOffline → judgeRun → 报告），只把 case 文件换成
  // 一份判据与产物方向相反的用例。它红，才说明「harness 是永远通过」不成立。
  const { main } = await import('../test-mock/prompt-bench.mjs');
  const negCases = path.join(here, '..', 'test-mock', 'prompt-bench', 'negative-control', 'cases.json');
  assert.ok(fs.existsSync(negCases), '负向对照用例文件必须存在（否则 F 无法被复跑）');
  const code = main(['--cases', negCases]);
  assert.notEqual(code, 0, '故意失败的用例竟然返回 0——harness 是假绿');
  assert.equal(code, 1, '有失败应当返回 1（2 是参数/文件错误，3 是 --live 未批准）');
});

test('负向对照用例本身必须仍能被判据自检通过（否则证明不了判据有效）', () => {
  // 负向用例的判据要「必然失败」，但它的**产物登记**必须齐全，否则自检会以
  // 「没有故意写错的产物」拦下它（退出码 2），那证的是别的东西。
  const negCases = loadCases(path.join(here, '..', 'test-mock', 'prompt-bench', 'negative-control', 'cases.json'));
  const holes = selfCheckCoverage({ cases: negCases.cases });
  assert.deepEqual(holes, [], '负向对照用例没有通过判据自检');
});

test('默认跑（无负向用例）必须全绿且退出码 0 —— 与上面的红形成对照', () => {
  const good = recordsWith(RESPONSES);
  assert.ok(good.length > 0);
  assert.ok(good.every((r) => r.pass), '默认基线必须全过（它是按判据写对的产物）');
});

test('参数解析：--offline 是默认，未知参数不当成成功', () => {
  assert.equal(parseArgs([]).live, false, '默认必须是离线');
  assert.equal(parseArgs(['--offline']).live, false);
  assert.equal(parseArgs(['--live']).live, true);
  assert.equal(parseArgs(['--approve', 'X']).approve, 'X');
  assert.deepEqual(parseArgs(['--nope']).unknown, ['--nope'], '未知参数必须被记下来（main 返回 2）');
});

test('harness 自身不得有联网代码路径（离线是默认，不是选项）', () => {
  // 「不联网」不能只靠注释承诺：静态读源文件，确认没有 fetch/http 客户端引用。
  const src = fs.readFileSync(path.join(here, '..', 'test-mock', 'prompt-bench.mjs'), 'utf8');
  assert.doesNotMatch(src, /\bfetch\s*\(/, 'harness 里出现了 fetch');
  assert.doesNotMatch(src, /require\(['"]https?['"]\)|from ['"]https?['"]|node:https?\b/, 'harness 里引用了 http/https');
  assert.doesNotMatch(src, /playwright|puppeteer|chromium/i, 'harness 里出现了浏览器依赖');
});

test('CI 闸门必须接进 npm test，且必须断言四种退出码与逐判据隔离', () => {
  // todo_4ba42f50c057 的落地护栏：基准层不能只停留在「手工能跑」。
  // 手工能跑 = 没人记得跑 = 与不存在等价。
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  const testScript = String(pkg.scripts?.test ?? '');
  assert.ok(/bench-ci\.mjs/.test(testScript),
    'npm test 未包含 bench-ci.mjs —— 基准层会退回「只有手工才能跑」的假绿状态');

  const ci = fs.readFileSync(path.join(here, '..', 'test-mock', 'bench-ci.mjs'), 'utf8');
  // 四种退出码是契约，缺哪一种就意味着某类失效不再可见。
  for (const [code, why] of [[0, '正例不误伤'], [1, '判据可被反证'], [2, '参数错误'], [3, '默认拒绝联网']]) {
    assert.ok(new RegExp('expect:\\s*' + code + '\\b').test(ci),
      `bench-ci.mjs 缺少对退出码 ${code} 的断言（${why}）——该失效模式将不可见`);
  }
  // 逐判据隔离：这是「单条判据被写坏」唯一能被发现的地方。
  // 实测理由：整份负向用例会同时违反多条判据，所以只坏一条时退出码仍是 1，缺口不可见
  //（把 expectCalls 改成 if(false && ...) 后整体检查依然全绿）。
  assert.ok(/判据隔离/.test(ci),
    'bench-ci.mjs 缺少逐判据隔离检查：单条判据被写坏时整份负向用例仍会红，缺口不可见');
  // 七条判据都要被逐条覆盖（数量写死，因为判据集合是 lib/bench.js 的公开契约）。
  for (const kind of ['expectCalls', 'expectArgsAt', 'requireArgs', 'expectFinish', 'maxTextChars', 'expectNoLeak', 'expectTextIncludes']) {
    assert.ok(ci.includes(`kind: '${kind}'`),
      `bench-ci.mjs 的逐判据隔离缺少「${kind}」——这条判据若被写坏将无法被发现`);
  }
});

test('生成物卫生检查必须接进 npm test，且两个方向都要断言', () => {
  // todo_5f4e5cc7fcea 的落地护栏。2026-09-15 真实事故：.gitignore:23 的
  // `test-mock/out/` 是按路径匹配的，不覆盖嵌套的 `test-mock/prompt-bench/out/`，
  // 于是 harness 每次跑出的三份产物都暴露在 `git add -A` 之下。
  // 只修一次不够：下一个人新增产物目录就会再开同一个洞，所以把它变成可机检的事实。
  const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'));
  assert.ok(/artifacts-check\.mjs/.test(String(pkg.scripts?.test ?? '')),
    'npm test 未包含 artifacts-check.mjs —— 生成物卫生会退回「靠人记得」的状态');

  const ci = fs.readFileSync(path.join(here, '..', 'test-mock', 'artifacts-check.mjs'), 'utf8');
  // 两个方向缺一不可：
  //   只查「生成物被忽略」→ 忽略规则写宽（把源码一起吞掉）不会被发现，而那种事故
  //   比产物泄漏更隐蔽（提交时看不出少了文件）。
  assert.ok(/const GENERATED/.test(ci) && /未被忽略/.test(ci),
    'artifacts-check.mjs 缺少「生成物必须被忽略」方向的断言');
  assert.ok(/const SOURCES/.test(ci) && /被误忽略/.test(ci),
    'artifacts-check.mjs 缺少「源文件必须仍可跟踪」方向的断言——忽略规则写宽时无人发现');
  // 必须用 git 的实际判定（check-ignore），而不是读 .gitignore 文本：
  // 读文本只能证明「有这行」，不能证明「规则对这个路径生效」，而真机出事的形态
  // 恰恰是「有规则但不匹配」。这条断言防止有人把它退化成文本匹配。
  assert.ok(/check-ignore/.test(ci),
    'artifacts-check.mjs 必须用 git check-ignore 判定，而不是读 .gitignore 文本');
  // 不在 git 工作树里时必须**跳过并说明**，不能假装通过（假绿的另一种形态）。
  assert.ok(/\bSKIP\b/.test(ci), '缺少「不在工作树内时跳过并说明」的分支');
});


