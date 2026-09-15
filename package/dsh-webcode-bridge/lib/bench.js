// bench.js — 提示词基准实验的**纯判据层**（0.14.8）。
//
// 为什么要有这一层，以及它刻意不做什么：
//
//   用户要求「用同一基准性能测试问题」比较提示词。文献（见
//   doc/research/prompt-engineering-evidence-2026-09-14.md）明确了两条硬约束：
//
//     ① NeurIPS 2024《On the Worst Prompt Performance of LLMs》：提示词效果
//        不稳定，且**无法提前识别最差形态**（Llama-2-70B 最好最差差 45.48%），
//        既有技巧对最差表现的提升「impact is limited」。
//     ② arXiv 2502.06065：LLM **自己判断不了**哪个提示词变体更好。
//
//   所以本层只做一件事：把「一段网页回复经过桥之后，产物是否符合确定性判据」
//   判出来。**不做模型自评、不算显著性、不输出百分比提升**——每变体跑 ≤3 次，
//   报百分比就是把噪声当结论。
//
//   判据全部是机器可判的结构事实（发了哪些调用、参数对不对、有没有协议残片、
//   本轮以什么收尾），因此同一段回复在任何时候跑都得到同一个结论。

import { findProtocolStart } from './agent-preset.js';

/** 把一次运行的 chunk 流压成可判的结构事实。 */
export function collectRun(chunks) {
  const list = Array.isArray(chunks) ? chunks : [];
  const calls = [];
  const texts = [];
  const deltas = [];
  let finishKind = null;
  for (const c of list) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'block-end' && c.block?.type === 'tool-call') {
      calls.push({ name: c.block.name, args: safeParse(c.block.arguments) });
    } else if (c.type === 'block-end' && c.block?.type === 'text') {
      texts.push(String(c.block.text ?? ''));
    } else if (c.type === 'text-delta' && typeof c.text === 'string') {
      // text-delta 与 text 块在同一轮里是**同一段正文的两种呈现**（index.js 的
      // 配平契约要求两者逐字一致），所以块存在时以块为准、deltas 只作兜底。
      // 旧写法把 delta 也塞进同一个数组再过滤，等于把兜底路径整个丢掉了——
      // 只出 delta 不出块的异常路径会被误判成「正文为空」。
      deltas.push(c.text);
    } else if (c.type === 'finish' && c.reason && typeof c.reason === 'object') {
      finishKind = c.reason.kind ?? null;
    }
  }
  const blocks = texts.filter((t) => typeof t === 'string');
  const text = blocks.length ? blocks.join('\n') : deltas.join('');
  return {
    calls,
    text,
    finishKind,
    // 协议残片检测**复用生产正则**（findProtocolStart 与保护正文用的是同一套
    // 锚点）。这一条是有来历的：0.14.6 之前检测器与被保护的正则共享同一个盲区，
    // 于是「日志没有泄漏告警」是假阴性。基准实验不能重犯——
    // 所以这里不另写一份模式表，直接用生产函数。
    // 【但「直接用」不等于「直接当数字用」】findProtocolStart 返回的是
    // {index, name, transport} 对象，index=-1 才表示未命中——取 .index 这一步
    // 是复用生产函数的代价，漏掉它比不写检测器更糟（见 findLeaks 的注释）。
    leaks: findLeaks(blocks.length ? blocks : deltas),
    textChars: text.length,
  };
}

function safeParse(s) {
  if (s && typeof s === 'object') return s;
  try { return JSON.parse(String(s)); } catch { return null; }
}

/** 残片命中数上限（跨块累计）；到顶就收住循环（见下方「无界循环」注释）。 */
const MAX_LEAK_HITS = 200;

/**
 * 逐块找协议残片；返回命中片段（空数组 = 干净）。
 *
 * **必须终止**（0.14.8 修）：findProtocolStart 返回的是对象 `{index, name, transport}`
 * （index 为数字，-1 表示未命中），不是数字。旧实现写的是
 *
 *     const at = findProtocolStart(t, from);
 *     if (at === -1) break;          // 对象 !== -1，永不成立
 *     from = at + 1;                 // 对象 + 1 → 字符串 "[object Object]1"
 *
 * 于是 from 变成非数字字符串，findProtocolStart 内部 `Number(from) || 0` 得 0，
 * 又从 0 重新命中同一处 —— 循环**永不终止**，每轮 push 一个 40 字符切片直到堆耗尽。
 * 与 0.14.6「检测器不能只覆盖已知形态」是同一族教训：检测器自己出错时同样会
 * 静默失效，只是这次表现为 OOM 而不是漏报。
 *
 * 实测证据（2026-09-14 本机）：`node --test test/bench.test.mjs` 单独跑 141ms 通过
 * （那 17 项断言恰好都没碰到含残片的正文）；与 `test/protocol-leak.test.mjs` 一起跑
 * 直接 `FATAL ERROR: Reached heap limit`，约 4GB 堆耗尽、耗时 669849ms（≈11 分钟）。
 * 那两个数字就是全部证据，**刻意不指向某个留痕文件**：这类「每次跑都会变」的输出
 * 已被 .gitignore 排除（见根目录 .gitignore 的 `bench-out.txt`），把它写进注释会让
 * 注释指向一个读者手上没有的文件——而失效的引用比没有引用更坏。
 * 对照：旧实现 findLeaks(['x </call> y']) 返回 ['', '', '', ''] 且不终止，
 * 正确实现返回 ['</call> y']。
 *
 * 因此这里有两道各自的护栏，缺一不可：
 *   ① 老老实实解构 `.index` 并做数字健全性检查——对象、NaN、越界一律当「未命中」；
 *   ② 命中数上限兜底：from = at + 1 已经保证游标只增，这才是「必然终止」的依据；
 *      上限只是第二保险——万一将来 findProtocolStart 又给出一个推进不了的下标，
 *      数组不至于无界增长。**注意它证明不了「整段正文被找完了」**，所以到顶时
 *      宁可把这段正文判成「有残片」（expectNoLeak 失败、结果偏严）也不放行。
 */
function findLeaks(texts) {
  const hits = [];
  for (const t of texts) {
    let from = 0;
    for (;;) {
      const r = findProtocolStart(t, from);
      const at = r && typeof r.index === 'number' ? r.index : -1;
      if (!Number.isFinite(at) || at < 0) break;
      hits.push(t.slice(at, at + 40));                      // 单条命中固定 ≤40 字符
      from = at + 1;                                        // 数字 + 1，游标只增不减
      if (hits.length >= MAX_LEAK_HITS) return hits;
    }
  }
  return hits;
}

/**
 * 按 case 声明的判据判一次运行。
 *
 * 判据字段（cases.json 里逐条声明，全部可选，只判声明了的）：
 *   expectCalls        期望的调用名序列（严格顺序、严格条数）
 *   expectArgsAt        { index, key, value }[] —— 第 index 个调用的某参数必须等于 value
 *   requireArgs         { index, keys: [] }[] —— 第 index 个调用必须含这些参数键（非空）
 *   expectFinish       'tool-calls' | 'stop'
 *   maxTextChars       正文块总长上限
 *   expectNoLeak       布尔；true 时 leaks 必须为空
 *   expectTextIncludes 字符串数组，正文必须都出现
 *
 * `failures` 与 `failureKinds` **一一对应、等长**：前者给人读，后者给机器分桶。
 * 为什么类别要单独出一个数组，而不是让调用方从文案里猜：文案是给人看的散文，
 * 措辞随时会为了说清楚而改，而「这是哪条判据失败的」是稳定的事实。此前
 * summarizeRuns 靠「取第一个冒号之前」来猜类别，而 judgeRun 有 7 条判据里只有
 * 3 条（expectCalls / expectNoLeak / expectTextIncludes）的文案带冒号——
 * 「第 N 个调用缺少必填参数 X」这条最高频的失败根本没有冒号，于是整句被当成类别名，
 * 不同 key 被算成不同类别（2026-09-14 实测：description 与 command 两条 → 2 个桶）。
 * 类别改为显式数据后，分桶不再依赖文案标点。
 *
 * @returns {{pass: boolean, failures: string[], failureKinds: string[]}}
 */
export function judgeRun(caseSpec, run) {
  const failures = [];
  // 与 failures 同下标推进：两者永远等长，summarizeRuns 才能安全地按下标取类别。
  const failureKinds = [];
  const fail = (kind, message) => { failureKinds.push(kind); failures.push(message); };
  const spec = caseSpec && typeof caseSpec === 'object' ? caseSpec : {};
  const got = run && typeof run === 'object' ? run : collectRun([]);

  if (Array.isArray(spec.expectCalls)) {
    const names = got.calls.map((c) => c.name);
    if (names.length !== spec.expectCalls.length || names.some((n, i) => n !== spec.expectCalls[i])) {
      fail('expectCalls', `调用序列不符：期望 [${spec.expectCalls.join(', ')}]，实际 [${names.join(', ')}]`);
    }
  }
  for (const rule of Array.isArray(spec.expectArgsAt) ? spec.expectArgsAt : []) {
    const call = got.calls[rule.index];
    if (!call) { fail('expectArgsAt', `第 ${rule.index} 个调用不存在（期望其 ${rule.key}=${JSON.stringify(rule.value)}）`); continue; }
    const actual = call.args ? call.args[rule.key] : undefined;
    if (actual !== rule.value) {
      fail('expectArgsAt', `第 ${rule.index} 个调用的 ${rule.key} 期望 ${JSON.stringify(rule.value)}，实际 ${JSON.stringify(actual)}`);
    }
  }
  for (const rule of Array.isArray(spec.requireArgs) ? spec.requireArgs : []) {
    const call = got.calls[rule.index];
    if (!call) { fail('requireArgs', `第 ${rule.index} 个调用不存在（期望含参数 ${(rule.keys || []).join(', ')}）`); continue; }
    for (const key of rule.keys || []) {
      const v = call.args ? call.args[key] : undefined;
      if (v === undefined || v === null || v === '') fail('requireArgs', `第 ${rule.index} 个调用缺少必填参数 ${key}`);
    }
  }
  if (spec.expectFinish && got.finishKind !== spec.expectFinish) {
    fail('expectFinish', `收尾方式期望 ${spec.expectFinish}，实际 ${got.finishKind}`);
  }
  if (typeof spec.maxTextChars === 'number' && got.textChars > spec.maxTextChars) {
    fail('maxTextChars', `正文长度 ${got.textChars} 超过上限 ${spec.maxTextChars}`);
  }
  if (spec.expectNoLeak === true && got.leaks.length) {
    fail('expectNoLeak', `正文含协议残片 ${got.leaks.length} 处：${got.leaks.slice(0, 3).join(' | ')}`);
  }
  for (const needle of Array.isArray(spec.expectTextIncludes) ? spec.expectTextIncludes : []) {
    if (!got.text.includes(needle)) fail('expectTextIncludes', `正文缺少必须出现的内容：${needle}`);
  }
  return { pass: failures.length === 0, failures, failureKinds };
}

/** 只带 failures（没有 failureKinds）的老 record 用的文案回落规则。 */
const FALLBACK_KIND_RULES = [
  // 类别码本身就是文案的开头（如「调用序列不符：…」「正文含协议残片 …」）。
  ['expectCalls', /^调用序列不符/],
  ['expectArgsAt', /^第 \d+ 个调用的 .+ 期望 /],
  ['requireArgs', /^第 \d+ 个调用缺少必填参数 /],   // 无冒号，必须靠模式认出来
  ['expectFinish', /^收尾方式期望 /],
  ['maxTextChars', /^正文长度 \d+ 超过上限 /],
  ['expectNoLeak', /^正文含协议残片 /],
  ['expectTextIncludes', /^正文缺少必须出现的内容/],
  // 再兜一层「剥掉前缀后剩下的词」：老调用方可能已经把 judgeRun 的文案截过头
  // （历史上游就是这么做的），只留下「缺少必填参数 X」这类片段。不补这层的话，
  // 同一批数据里有的记录落进 requireArgs、有的落进其他，分布表又被拆成两类。
  ['requireArgs', /^缺少必填参数 /],
];

/**
 * 把一条失败文案归到一个稳定类别（回落路径，仅供没有 failureKinds 的老调用方）。
 *
 * **不再用 `.slice(0, 24)` 截文案当类别名**：中文一个词常常超过 24 个字符，
 * 硬截断会把词切两半——实测 `第 0 个调用缺少必填参数 description` 被切成
 * `…descriptio`（0.14.8 之前线上就是这么打标签的），标签损坏且同一类问题
 * 因 key 长度不同还会裂成多个桶。这里宁可回落到一个明确的兜底类别名。
 */
function kindFromMessage(message) {
  const text = String(message ?? '').trim();
  for (const [kind, re] of FALLBACK_KIND_RULES) {
    if (re.test(text)) return kind;
  }
  // 未识别的文案（未来新增判据但没同步本表）统一进 '其他'，而不是各自成一个桶：
  // 分布表的用途是「哪条判据失败得多」，不是「出现了几种措辞」。
  return '其他';
}

/**
 * 汇总多次运行。
 *
 * **刻意只输出计数与分布，不输出百分比提升**：样本 ≤3 次时百分比是把噪声
 * 包装成结论。要比较就看「哪个变体在哪条判据上失败了几次」。
 *
 * failureCounts 的类别来源**优先取显式数据**（record.failureKinds，judgeRun 直接
 * 产出），只有老调用方不带它时才回落到按文案推断（kindFromMessage）。这样
 * 「类别」不受文案措辞变动影响，同一判据的不同 key 也必然落进同一个桶。
 *
 * @param {Array<{variant: string, caseId: string, pass: boolean, failures: string[], failureKinds?: string[], promptChars: number, run: object}>} records
 */
export function summarizeRuns(records) {
  const rows = Array.isArray(records) ? records : [];
  const byVariant = new Map();
  for (const r of rows) {
    const v = String(r?.variant ?? 'unknown');
    if (!byVariant.has(v)) {
      byVariant.set(v, {
        variant: v, runs: 0, passed: 0, failed: 0,
        promptChars: [], promptCharsMin: null, promptCharsMax: null,
        failureCounts: {}, leakRuns: 0, callCounts: [],
      });
    }
    const agg = byVariant.get(v);
    agg.runs += 1;
    if (r.pass) agg.passed += 1; else agg.failed += 1;
    const failures = Array.isArray(r?.failures) ? r.failures : [];
    const kinds = Array.isArray(r?.failureKinds) ? r.failureKinds : null;
    // 长度必须相等才敢按下标取：不等长就当没有类别码，免得类别与文案错位。
    const usable = kinds && kinds.length === failures.length;
    for (let i = 0; i < failures.length; i += 1) {
      // 失败原因按「判据类别」归并，不按具体文案——否则同一问题的两种措辞会
      // 被算成两类，看表的人会以为问题更多。
      const kind = usable
        ? (String(kinds[i] ?? '').trim() || '其他')
        : kindFromMessage(failures[i]);
      agg.failureCounts[kind] = (agg.failureCounts[kind] || 0) + 1;
    }
    const pc = Number(r.promptChars);
    if (Number.isFinite(pc)) agg.promptChars.push(pc);
    if (r.run?.leaks?.length) agg.leakRuns += 1;
    if (Number.isFinite(r.run?.calls?.length)) agg.callCounts.push(r.run.calls.length);
  }
  const variants = [...byVariant.values()].map((a) => ({
    ...a,
    promptCharsMin: a.promptChars.length ? Math.min(...a.promptChars) : null,
    promptCharsMax: a.promptChars.length ? Math.max(...a.promptChars) : null,
    promptCharsAvg: a.promptChars.length
      ? Math.round(a.promptChars.reduce((s, n) => s + n, 0) / a.promptChars.length) : null,
    callCounts: undefined,
  }));
  return {
    totalRuns: rows.length,
    totalPassed: rows.filter((r) => r?.pass).length,
    variants,
    // 披露是硬要求（arXiv 2605.23950：benchmark 分数由 model + harness 共同产生，
    // 而 harness 几乎从不披露）。调用方把 disclosure 原样写进报告。
    disclosure: {
      sampleSizePerCell: rows.length ? Math.max(...variants.map((v) => v.runs)) : 0,
      significant: false,
      note: '每变体运行次数 ≤3：只报计数与分布，不做显著性检验，不报百分比提升。',
    },
  };
}