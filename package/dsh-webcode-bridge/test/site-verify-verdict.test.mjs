// site-verify-verdict.test.mjs — 站点验收工具**自身**的反向验证（0.19.75）。
//
// ## 为什么必须给验收工具写测试
//
// 复审指出的三个缺陷全都是「**工具自己制造假结论**」：
//
//   ① 收尾写成 `failed ? 'FAIL' : 'PASS'` ⇒ 只要没有 FAIL，连 UNVERIFIED 也变 PASS
//      （真实后果：一个站点**一条工具调用都没产出**，照样被盖章 PASS）；
//   ② 从未真正执行工具、也没把结果回填 ⇒ 却把验收范围写成「工具结果回填后能收束」；
//   ③ `String(text || sent?.text || '')` ⇒ 没有增量时只要全文非空就判「流有正文」，
//      **恰好掩盖 Issue #1 的症状**（页面有正文、流式链没送到）。
//
// 因此本文件的重点不是「正确实现能通过」，而是**错误实现必须变红**：
// 下面每条负向用例都对应一个具体的偷懒写法，并且该写法在本文件里是可复现的。
import test from 'node:test';
import assert from 'node:assert/strict';
import { verdictOf, streamDeliveryVerdict, REQUIRED_CHECKS } from '../test-mock/site-verify-verdict.mjs';

/** 造一份「所有必要项都在、且都通过」的检查清单。 */
function allPass(over = {}) {
  return REQUIRED_CHECKS.map((name) => ({ name, status: over[name] || 'PASS' }));
}

// ── ① 最终状态必须遵守四态：UNVERIFIED 绝不得被汇总成 PASS ───────────────────

test('① 一项 UNVERIFIED + 其余全 PASS ⇒ 站点必须是 UNVERIFIED，不得是 PASS', () => {
  const checks = allPass({ 'tool.callParsed': 'UNVERIFIED' });
  const v = verdictOf(checks);
  assert.equal(v.status, 'UNVERIFIED',
    '旧写法 `failed ? FAIL : PASS` 在这一格会给出 PASS —— 这正是复审指出的假绿');
  assert.notEqual(v.status, 'PASS');
});

test('①b 零工具调用（callParsed 与 roundTrip 都 UNVERIFIED）⇒ 不得盖章 PASS', () => {
  // 这是最贴近真实后果的一格：站点一条调用都没产出，却拿到「通过」。
  const checks = allPass({ 'tool.callParsed': 'UNVERIFIED', 'tool.resultRoundTrip': 'UNVERIFIED' });
  const v = verdictOf(checks);
  assert.equal(v.status, 'UNVERIFIED');
  assert.ok(v.counts.UNVERIFIED >= 2, '两项未验证都要计入');
});

test('①c 有 FAIL 时优先报 FAIL（即使同时有 BLOCKED/UNVERIFIED）', () => {
  const checks = allPass({ 'stream.deltaReceived': 'FAIL', 'turn.settled': 'UNVERIFIED' });
  assert.equal(verdictOf(checks).status, 'FAIL');
});

test('①d 有 BLOCKED 且无 FAIL ⇒ 报 BLOCKED（外部条件挡住，不是产品结论）', () => {
  const checks = allPass({ 'send.text': 'BLOCKED' });
  assert.equal(verdictOf(checks).status, 'BLOCKED');
});

test('①e 全部 PASS ⇒ PASS（正向：修法不能把所有站点都判成不确定）', () => {
  assert.equal(verdictOf(allPass()).status, 'PASS');
});

// ── ② 缺项本身不得被当成「通过」───────────────────────────────────────────

test('② 必要检查项**缺失**（不是 UNVERIFIED，而是压根没出现）⇒ 不得判 PASS', () => {
  // 旧写法在这一格是最危险的：checks 里没有 UNVERIFIED，于是 `failed=false` ⇒ PASS。
  // 而真相是「这一段根本没跑」（例如未登录时只跑了 login 就返回）。
  const checks = [
    { name: 'login.loggedIn', status: 'PASS' },
    { name: 'login.verdictConsistent', status: 'PASS' },
  ];
  const v = verdictOf(checks);
  assert.notEqual(v.status, 'PASS', '缺项必须导致非 PASS');
  assert.equal(v.status, 'UNVERIFIED');
  assert.ok(v.missing.length >= 3, '未出现的必要项要被列出来：' + JSON.stringify(v.missing));
});

test('②b 缺项时 reasons 必须点名缺了什么（否则下一次没人知道漏跑哪段）', () => {
  const v = verdictOf([{ name: 'login.loggedIn', status: 'PASS' }]);
  assert.ok(v.reasons.some((r) => /缺少必要检查项/.test(r)), JSON.stringify(v.reasons));
});

// ── ③ 流式交付必须与「全文回读」分开判 ─────────────────────────────────────

test('③ 只有全文、零增量 ⇒ 必须判「交付链没送到」，绝不得算流式通过', () => {
  const v = streamDeliveryVerdict({ fullText: '网页生成的正文', deltaText: '' });
  assert.equal(v.fullTextOk, true);
  assert.equal(v.deltaOk, false, '没有增量就不能说增量到了');
  assert.equal(v.consistent, false);
  assert.match(v.note, /流式增量为 0/);
});

test('③b 反向：增量与全文一致 ⇒ 才算流式交付通过', () => {
  const v = streamDeliveryVerdict({ fullText: '网页生成的正文', deltaText: '网页生成的正文' });
  assert.equal(v.fullTextOk, true);
  assert.equal(v.deltaOk, true);
  assert.equal(v.consistent, true);
});

test('③c 全文与增量不一致 ⇒ 必须标出不一致并指向逐层比对', () => {
  const v = streamDeliveryVerdict({ fullText: '一二三四五六七八九十', deltaText: '一二三' });
  assert.equal(v.consistent, false);
  assert.match(v.note, /不一致/);
  assert.match(v.note, /capture/, '必须指向分层定位，而不是笼统说「不一样」');
});

test('③d 两者都空 ⇒ 说清是网页没产出，不含糊', () => {
  const v = streamDeliveryVerdict({ fullText: '', deltaText: '' });
  assert.equal(v.fullTextOk, false);
  assert.equal(v.deltaOk, false);
  assert.match(v.note, /没有产出正文/);
});

// ── ④ 状态码拼错不得落进 PASS 桶 ───────────────────────────────────────────

test('④ 未知状态码一律折算成 UNVERIFIED（宽松方向只能是「更不确定」）', () => {
  const checks = allPass({ 'turn.settled': 'TYPO_STATUS' });
  const v = verdictOf(checks);
  assert.notEqual(v.status, 'PASS', '拼错的状态码不得让站点变成通过');
  // 该状态折算进 UNVERIFIED 桶（不是自成一桶「TYPO_STATUS: 1」——那样它会对
  // VERDICT_ORDER 完全不可见，站点照样 PASS；首版正是这么写错的，被本条抓住）。
  assert.equal(v.counts.UNVERIFIED, 1, '未知状态必须折算进 UNVERIFIED 桶');
  assert.ok(!('TYPO_STATUS' in v.counts), '不得留下未知状态自成的桶');
});

// ── ⑤ 必要项清单自身必须与 site-verify.mjs 实际产生的 id 对齐 ────────────────

test('⑤ 必要项清单必须被 site-verify.mjs 真的产出（否则缺项判定永远误报）', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'test-mock', 'site-verify.mjs'), 'utf8');
  for (const id of REQUIRED_CHECKS) {
    assert.ok(src.includes(`'${id}'`),
      `必要项 ${id} 在 site-verify.mjs 里根本没有被 add() 产出——清单与实际实现漂移了`);
  }
});

test('⑤b 清单必须覆盖「登录依据」——漏了它，probe-fallback 就仍能被判 PASS', () => {
  // 这条来自一次真实漏项：首版清单里**没有** `login.basis`，于是
  // 「登录靠输入框兜底（probe-fallback）」这一形态在离线负向探针里
  // **仍然得到 PASS**（.tmp/probe-verdict-negative.mjs 的 N4 当场抓到）。
  // 换句话说：清单少一项，就等于给那一类缺口开了后门。
  assert.ok(REQUIRED_CHECKS.includes('login.basis'),
    'login.basis 必须在必要项里：它是 #53 三态的承载项');
});

test('⑤c 清单必须覆盖流式交付的三项（全文 / 增量 / 一致性）', () => {
  // 少任何一项，Issue #1 那种「有全文、无增量」的形状都可能被汇总成 PASS。
  for (const id of ['stream.fullText', 'stream.deltaReceived', 'stream.consistency']) {
    assert.ok(REQUIRED_CHECKS.includes(id), `${id} 必须在必要项里`);
  }
});

test('⑤d probe-fallback 记 UNVERIFIED 后，站点整体不得是 PASS（#53 三态的汇总侧）', () => {
  const checks = REQUIRED_CHECKS.map((name) => ({
    name, status: name === 'login.basis' ? 'UNVERIFIED' : 'PASS',
  }));
  assert.notEqual(verdictOf(checks).status, 'PASS',
    '登录依据是猜测时，站点整体不得显示为通过');
});