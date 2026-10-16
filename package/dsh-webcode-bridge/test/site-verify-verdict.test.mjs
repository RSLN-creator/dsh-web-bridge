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
import { verdictOf, streamDeliveryVerdict, sameSessionVerdict, REQUIRED_CHECKS } from '../test-mock/site-verify-verdict.mjs';

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

// ── ⑥ 槽目录必须与产品同源（0.19.82 修出的第四个「工具自己制造假结论」）──────────
//
// ## 缺陷现场（真机，2026-10-16）
//
// `site-verify.mjs` 旧实现手写 `path.join(PROFILE, siteId)` 取站点 profile 子目录，
// 而**产品**（`index.js:1212 / :3125 / :3964`、`web-control.js:1271`）一律经
// `accounts.slotProfileDir()`，非 primary 站点的默认槽落在 `<root>/sites/<siteId>`
// ——多一层 `sites/`。两者对**除 deepseek 外的全部站点**都不同。
//
// 后果：验收工具指向一个**不存在的空目录**，于是每个非 deepseek 站点都只会得到
// `BLOCKED 未登录`。而 deepseek（`primary=true`，目录恰好相同）不受影响 ⇒
// **错误只在非 deepseek 站点上显形**，正好是「一跑就全是未登录」的那种假读数，
// 既像外部条件又不像工具缺陷，极容易漏过。
//
// 本文件自己的定位就是「错误实现必须变红」，所以这里**不比对某个字面路径**，
// 而是比「工具算出来的路径 == 产品算出来的路径」——手写第二份公式必红。
test('⑥ site-verify 的槽目录必须等于产品 slotProfileDir 给出的那一个（含 sites/ 层）', async () => {
  const { readFileSync } = await import('node:fs');
  const { join, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const { slotProfileDir, DEFAULT_SLOT } = await import('../lib/accounts.js');
  const here = dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(join(here, '..', 'test-mock', 'site-verify.mjs'), 'utf8');

  // ① 源码必须**调用产品那一个真源**，不许手写第二份目录公式。
  //
  // ⚠ 首版这条判据写成 `assert.match(src, /slotProfileDir\s*\(/)`，**自己是个假绿**：
  //   它匹配到的是 import 行与注释里提到的 `slotProfileDir(...)`，于是把实现换回
  //   手写的 `path.join(PROFILE, …)` 之后**仍然 PASS**（反向变异实验当场抓到）。
  //   ⇒ 现在先把 `//` 注释整行剥掉，再要求**行首**就是那条赋值语句：
  //   实现一旦改回手写公式，这一行就不再以 `slotProfileDir(` 开头，护栏变红。
  const code = src.split(/\r?\n/).filter((l) => !/^\s*\/\//.test(l)).join('\n');
  assert.match(code, /^\s*const profileDir = slotProfileDir\(/m,
    'site-verify.mjs 必须用产品真源 slotProfileDir() 算槽目录 —— '
    + '手写第二份公式（旧实现是 path.join(PROFILE, siteId)）就会与产品分叉：'
    + '非 primary 站点的产品布局是 <root>/sites/<siteId>，手写那份少了 sites/ 一层，'
    + '于是验收工具读进一个空目录，每个非 deepseek 站点都只会得到假的「未登录」');

  // ② 对每个声明了 mountAtRelayRoot 的站点，产品真源给出的路径必须包含 sites/ 层
  //    （deepseek 是唯一的 primary，它恰好落在根本身——这条同时钉住「例外只有一个」）。
  const root = process.env.USERPROFILE
    ? join(process.env.USERPROFILE, '.dsh', 'webcode-edge-profile')
    : join('/tmp', 'webcode-edge-profile');
  const primaries = [];
  const { SITES } = await import('../lib/providers.js');
  for (const st of SITES) {
    const got = slotProfileDir(root, st.id, DEFAULT_SLOT, { primary: st.mountAtRelayRoot === true });
    if (st.mountAtRelayRoot === true) {
      primaries.push(st.id);
      assert.equal(got, root, `${st.id} 是 primary ⇒ 槽目录必须就是 profile 根`);
    } else {
      assert.equal(got, join(root, 'sites', st.id),
        `${st.id} 不是 primary ⇒ 槽目录必须在 sites/ 层下（旧 site-verify 手写的 <root>/<id> 就在这里读空）`);
    }
  }
  assert.deepEqual(primaries, ['deepseek'],
    '「挂在中继根上」的站点只允许 deepseek 一个 —— 多一个或少一个都会让上面这条判据失去意义');
});

// ── ⑦ 「同一会话」的第二判据：无地址形状站点不得被误记 UNVERIFIED（2026-10-16 真机）──
//
// ## 真机背景（zai，本轮的读数）
//
// zai 三轮全程同一会话、工具闭环成立，但**三个 `sessionId` 全是 `null`** ——
// 因为它没有地址形状（`conversationIdFromUrl` 对它没有形状表）。
// 若只认 `sessionId`，验收就会把「明明停在同一个网页会话上」记成 UNVERIFIED。
//
// ⚠ 但**放宽**必须是有判据的放宽：第二个判据用驱动 0.19.52 起维护的**落地地址锚**
//   （槽里的 `landedUrl`，`conversationStay` 认的就是它，换会话会判 `WEB_SESSION_LOST`）。
//   两个判据都拿不到时**仍记 UNVERIFIED** —— 确实没有证据时不许猜。
test('⑦ sessionId 两侧相同 ⇒ 判成立（有地址形状站点的主路径）', () => {
  const r = sameSessionVerdict({ kind: 'webSessionId', value: 'abc123' }, { kind: 'webSessionId', value: 'abc123' }, 'abc123', 'abc123');
  assert.equal(r.ok, true);
  assert.equal(r.basis, 'sessionId');
});

test('⑦b ★ sessionId 都是 null 但槽锚相同 ⇒ 判成立（zai 真机形态，旧判据在这里会误记 UNVERIFIED）', () => {
  const url = 'https://chat.z.ai/c/6ad10e751f3554f7945c959f';
  const r = sameSessionVerdict({ kind: 'landedUrl', value: url }, { kind: 'landedUrl', value: url }, null, null);
  assert.equal(r.ok, true, '无地址形状站点：槽锚相同必须判成立（否则工具闭环会被误记 UNVERIFIED）');
  assert.equal(r.basis, 'slot-anchor');
});

test('⑦c 反向：两个判据都拿不到 ⇒ 必须 UNVERIFIED，不许猜成通过', () => {
  const r = sameSessionVerdict({ kind: 'none', value: null }, { kind: 'none', value: null }, null, null);
  assert.equal(r.ok, false, '没有证据时必须记「不确定」，不得记成成立');
  assert.equal(r.basis, null);
});

test('⑦d 反向：sessionId 不同 / 槽锚不同 ⇒ 必须不成立（这半条丢了就成了恒真）', () => {
  assert.equal(sameSessionVerdict({ kind: 'none', value: null }, { kind: 'none', value: null }, 'a', 'b').ok, false,
    '两次独立提问（sessionId 不同）不得算同一会话');
  assert.equal(sameSessionVerdict(
    { kind: 'landedUrl', value: 'https://x/c/aaa' }, { kind: 'landedUrl', value: 'https://x/c/bbb' }, null, null,
  ).ok, false, '槽锚不同 ⇒ 页面换了会话，不得算同一会话');
});

test('⑦e 反向变异：把「判成立」写宽（任一侧非空即成立）⇒ ⑦c/⑦d 必须变红', () => {
  // 这条不模拟实现，而是验证「宽松版」确实过不了上面的断言——说明那些断言是判据。
  const loose = (a, b, sidA, sidB) => Boolean((sidA || sidB) || (a?.value || b?.value));
  assert.equal(loose({ kind: 'none', value: null }, { kind: 'none', value: null }, null, null), false,
    '宽松版在「两侧都空」时也必须不成立');
  assert.equal(loose({ kind: 'landedUrl', value: 'aaa' }, { kind: 'landedUrl', value: 'bbb' }, null, null), true,
    '宽松版会在「槽锚不同」时误判成立 —— 这正是 ⑦d 要钉住的东西');
  assert.notEqual(loose({ kind: 'landedUrl', value: 'aaa' }, { kind: 'landedUrl', value: 'bbb' }, null, null),
    sameSessionVerdict({ kind: 'landedUrl', value: 'aaa' }, { kind: 'landedUrl', value: 'bbb' }, null, null).ok,
    '宽松版与真实判据在该场景下必须给出不同结果');
});