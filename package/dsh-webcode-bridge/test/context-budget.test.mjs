// context-budget.test.mjs — 发送前预算闸（0.14.1，B-2）。
//
// 为什么需要这道闸（用户报的「越跑越傻 / 网页端截半截」这一类）：
// 桥向 DSH 声明的 `contextWindow` 是乐观值（glm/zai 现在是真机实测的 1M，见
// providers.js 的 GLM_CONTEXT_WINDOW），而「声明偏大」的旧代价是**静默的**——
// DSH 的自动压缩永不触发、transcript 只增不减，最后要么被网页端截半截，要么撞
// 240s 超时。已有的 PROMPT_TRUNCATED 回读校验发生在**填写之后**，报错只有长度差，
// 看不出超了多少、也不知道下一步做什么。
//
// 本文件钉住三件事：
//   1. 判定口径（> 100% 才拒；恰好等于不拒）；
//   2. 三个刻意边界（无窗口不拦 / 非法输入不拦 / 图片不参与）；
//   3. 接线：越界必须在**发出之前**抛 CONTEXT_WINDOW_EXCEEDED，且错误文本里
//      真的带得出「多少字符 / 约多少 token / 声明窗口多少」——否则用户拿到的是
//      一句无法行动的报错。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkContextBudget, estimateTokens } from '../lib/metrics.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, '..');
const readLib = (f) => fs.readFileSync(path.join(pkgRoot, 'lib', f), 'utf8');

test('预算够：窗口 1000 token，本轮远低于它 → ok', () => {
  // 1000 字符按 0.7 tok/字符 + 10% 余量 ≈ 770 token < 1000
  const r = checkContextBudget({ chars: 1000, contextWindow: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.window, 1000);
  assert.ok(r.ratio < 1, `ratio 应 < 1，实际 ${r.ratio}`);
  assert.equal(r.overflowTokens, 0);
});

test('预算超：字符数折算后超过窗口 → 不 ok，且给出超出量', () => {
  // 2000 字符 ≈ 1540 token > 1000
  const r = checkContextBudget({ chars: 2000, contextWindow: 1000 });
  assert.equal(r.ok, false);
  assert.ok(r.tokens > r.window);
  assert.equal(r.overflowTokens, r.tokens - r.window);
  assert.ok(r.ratio > 1);
});

test('边界：恰好等于窗口 → 放行（闸门只拦「超」，不做「接近就拦」的节流）', () => {
  // 反解出恰好命中窗口的字符数：tokens = ceil(n*0.7*1.1) === window
  const window = 770;
  const n = Math.floor(window / (0.7 * 1.1));
  const r = checkContextBudget({ chars: n, contextWindow: window });
  assert.ok(r.tokens <= window, `tokens=${r.tokens} 应 <= window=${window}`);
  assert.equal(r.ok, true);
});

test('折算口径与 estimateTokens 同源：同一段文本两边一致', () => {
  const text = '你好世界，这是一个用来对齐口径的句子。';
  const r = checkContextBudget({ chars: text.length, contextWindow: 10_000_000 });
  // estimateTokens 按实际字符构成算（CJK 0.7 / ASCII 0.25），这里传的是**纯字符数**，
  // 因此全 CJK 文本两边应一致；混合文本只要求同一数量级。
  const direct = estimateTokens(text);
  assert.ok(Math.abs(r.tokens - direct) <= 1, `口径应一致：闸=${r.tokens} estimateTokens=${direct}`);
});

test('边界：拿不到窗口（缺失/0/负数/NaN）→ 一律不拦（返回 null）', () => {
  // 猜一个窗口去拒绝用户，比放行更糟；这种情况交给 PROMPT_TRUNCATED 兜底。
  for (const w of [undefined, null, 0, -1, NaN, 'abc']) {
    assert.equal(checkContextBudget({ chars: 10_000_000, contextWindow: w }), null, `window=${w} 应返回 null`);
  }
});

test('边界：非法 chars 不拦，也不抛错', () => {
  assert.equal(checkContextBudget({ chars: NaN, contextWindow: 1000 }), null);
  assert.equal(checkContextBudget({ chars: -5, contextWindow: 1000 }), null);
  assert.equal(checkContextBudget({ chars: undefined, contextWindow: 1000 }), null);
  // 空轮（0 字符）是合法输入：不超预算
  assert.equal(checkContextBudget({ chars: 0, contextWindow: 1000 }).ok, true);
});

test('图片不参与文本预算：chars 只算文本长度（调用方口径）', () => {
  // 这条是「契约备忘」型断言：图片走附件上传，不占 composer 文本长度。
  // 若将来有人把图片 base64 也算进 chars，这条会提醒他预算语义变了。
  const textOnly = checkContextBudget({ chars: 100, contextWindow: 1000 });
  assert.equal(textOnly.ok, true);
  assert.equal(textOnly.chars, 100);
});

// ---- 接线断言（源码级）：越界必须在发出之前抛码，且报错可行动 ----

test('接线：适配器流在 buildTurn 之后、发送之前就调用预算闸', () => {
  const src = readLib('index.js');
  const streamAt = src.indexOf('async *stream(options) {');
  assert.ok(streamAt > 0, 'index.js 应有适配器 stream 实现');
  const head = src.slice(streamAt, streamAt + 900);
  const turnAt = head.indexOf('const turn = buildTurn(options);');
  const gateAt = head.indexOf('assertContextBudget(');
  assert.ok(turnAt >= 0, 'stream 内应先 buildTurn');
  assert.ok(gateAt > turnAt, '预算闸必须在 buildTurn 之后（要拿到本轮 prompt 与模型）');
  // 而且必须早于 attach/上传：附件上传是有副作用的动作，越界时不该发生
  const attachAt = head.indexOf('turn.attach');
  assert.ok(attachAt < 0 || gateAt < attachAt, '预算闸必须早于 attach（越界时不上传附件）');
});

test('接线：越界抛的是 CONTEXT_WINDOW_EXCEEDED，且文本带得出可行动信息', () => {
  const src = readLib('index.js');
  const at = src.indexOf('function assertContextBudget(');
  assert.ok(at > 0, 'index.js 应有 assertContextBudget');
  const body = src.slice(at, at + 1800);
  assert.ok(/err\.code = 'CONTEXT_WINDOW_EXCEEDED'/.test(body), '必须带专用错误码');
  // 报错要能直接回答「超了多少、下一步做什么」
  assert.ok(/token/.test(body) && /声明的上下文窗口/.test(body), '报错应含 token 与声明窗口');
  assert.ok(/新开一个会话/.test(body), '报错应给出可行动建议');
  assert.ok(/网页端未被写入/.test(body), '报错应说明网页端未被污染');
});

test('接线：窗口取值只有一个来源（contextWindowFor），声明与闸门不会各算一套', () => {
  const src = readLib('index.js');
  assert.ok(/function contextWindowFor\(/.test(src), '应有唯一的窗口取值函数');
  const uses = (src.match(/contextWindowFor\(/g) || []).length;
  assert.ok(uses >= 3, `resolveModel 与预算闸都应走它（至少 3 处引用，实际 ${uses}）`);
  // 旧的散落三元表达式不得回来
  assert.ok(!/m\.siteId === 'deepseek' \? 1_000_000 : 64_000/.test(src.replace(/function contextWindowFor[\s\S]{0,600}/, '')),
    '窗口兜底只应存在于 contextWindowFor 内');
});

test('GLM/Z.ai 的窗口声明有真机依据：常量被引用且注释记录了探针', () => {
  const src = readLib('providers.js');
  assert.ok(/const GLM_CONTEXT_WINDOW = 1_000_000;/.test(src), '应有实测下界常量');
  const refs = (src.match(/GLM_CONTEXT_WINDOW/g) || []).length;
  assert.ok(refs >= 7, `glm(3)+zai(4) 条目都该引用它（含定义至少 8 处，实际 ${refs}）`);
  assert.ok(/real-probe-23/.test(src) && /real-probe-24/.test(src), '注释必须记下探针出处');
  assert.ok(/不是模型注意力窗口的规格/.test(src), '必须说清它不是什么（避免被读成规格）');
});