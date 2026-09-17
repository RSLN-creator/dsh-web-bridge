// task-plan.test.mjs — 任务图**执行语义**的护栏（0.16.2）。
//
// ## 这个文件要证明什么
//
// `lib/task-plan.js` 补的是 Graph Engineering 里「纯函数能补」的那一层
//（对照研究 doc/research/task-board-vs-agentteams-graph.md §3 的十条）。
// 每一条都对应一个**会静默出错**的地方，所以每条都要有断言：
//
//   · 官方行（只有 blockedBy）必须与官方 taskReady() 判定**逐字一致**——
//     桥不能在官方说「不行」时说「行」（那是提前开工，最难查的一类 bug）。
//   · 没边 ⇒ 依赖轴天然满足。写成 `satisfied.length >= n` 的退化实现在这里会红。
//   · 「等依赖」与「等资源」必须是两个轴：合成一个之后两种卡法长得一样。
//   · 超时/取消/环境不可用**不吃**重试额度，但 `failed` 吃。
//   · quorum 越界必须 clamp **并**留警告（静默 clamp 等于配置不生效还看不出来）。
//   · 自环给独立错误码（官方归到 cycle，调用方分不开——§3③ 点名了）。
//
// 纪律：本文件不 mock 任何服务，全部用纯数据驱动——task-plan.js 是纯函数。

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  admissionOf, analyzePlan, normalizeEdges, normalizeJoin, retryOf, validatePlan, writeScopeConflicts,
} from '../lib/task-plan.js';

/** 造一行任务，缺省是最简单的「无依赖待办」。 */
const row = (id, over = {}) => ({ id, subject: id, status: 'pending', ...over });

/** 把行数组变成 admissionOf 需要的 byId。 */
const mapOf = (rows) => new Map(rows.map((t) => [String(t.id), t]));

// ── 归一化 ──────────────────────────────────────────────────────────────

test('normalizeEdges：官方 blockedBy 等价 after-success，且与 edges 去重', () => {
  const e = normalizeEdges({ id: 'a', blockedBy: ['b', 'b'], edges: [{ id: 'b', kind: 'after-success' }, { id: 'c', kind: 'after-settle' }] });
  // b/after-success 在两边都出现 ⇒ 只留一条；c 是另一种语义 ⇒ 另算一条。
  assert.deepEqual(e, [{ id: 'b', kind: 'after-success' }, { id: 'c', kind: 'after-settle' }]);
});

test('normalizeEdges：非法 kind 回落到 after-success，绝不丢边', () => {
  const e = normalizeEdges({ id: 'a', edges: [{ id: 'b', kind: 'whatever' }] });
  // 丢边会让本该被阻塞的任务变成可开工 —— 那是提前开工。
  assert.deepEqual(e, [{ id: 'b', kind: 'after-success' }]);
});

test('normalizeJoin：缺省必须是 all（与官方 AND 一致），quorum 越界被 clamp', () => {
  assert.deepEqual(normalizeJoin({}, 3), { mode: 'all', n: null });
  assert.deepEqual(normalizeJoin({ join: { mode: 'any' } }, 3), { mode: 'any', n: null });
  // n=0 与 n=9（边只有 3 条）都被夹到 [1, 3]。
  assert.deepEqual(normalizeJoin({ join: { mode: 'quorum', n: 0 } }, 3), { mode: 'quorum', n: 1 });
  assert.deepEqual(normalizeJoin({ join: { mode: 'quorum', n: 9 } }, 3), { mode: 'quorum', n: 3 });
});

// ── 官方语义零位移（最重要的一组） ────────────────────────────────────

test('★ 官方行判定必须与 taskReady() 逐字一致：上游 completed 才放行', () => {
  const done = row('up', { status: 'completed' });
  const running = row('up', { status: 'in_progress' });
  const mine = row('me', { blockedBy: ['up'] });

  assert.equal(admissionOf(mine, mapOf([done, mine])).depsOk, true, '上游已完成 ⇒ 依赖满足');
  assert.equal(admissionOf(mine, mapOf([running, mine])).depsOk, false, '上游在跑 ⇒ 依赖未满足');
  // 上游**失败**同样未满足：官方 after-success 语义下它是永远等不到的。
  const failed = row('up', { status: 'failed' });
  const a = admissionOf(mine, mapOf([failed, mine]));
  assert.equal(a.depsOk, false);
  assert.deepEqual(a.unsatisfiedEdges, [{ id: 'up', kind: 'after-success', status: 'failed' }]);
});

test('★ 没有边 ⇒ 依赖轴天然满足（退化的 quorum 实现会在这里红）', () => {
  const solo = row('solo');
  assert.equal(admissionOf(solo, mapOf([solo])).depsOk, true, '无依赖任务必须能开工');
  // 显式 quorum 且没有边：同样必须满足 —— 否则一个「0 条边的 quorum」永远开不了工。
  const q = row('q', { join: { mode: 'quorum', n: 1 } });
  assert.equal(admissionOf(q, mapOf([q])).depsOk, true, '0 条边的 quorum 不得永久阻塞');
});

// ── 边语义三态（§3①） ────────────────────────────────────────────────

test('★ after-settle：上游**失败也要跑**（清理/回滚节点）', () => {
  const failed = row('up', { status: 'failed' });
  const cleanup = row('cleanup', { edges: [{ id: 'up', kind: 'after-settle' }] });
  assert.equal(admissionOf(cleanup, mapOf([failed, cleanup])).depsOk, true,
    'after-settle 下上游失败必须放行 —— 否则清理节点永远不跑');
  // 但上游还在跑时不能放行。
  const running = row('up', { status: 'in_progress' });
  assert.equal(admissionOf(cleanup, mapOf([running, cleanup])).depsOk, false);
});

test('★ after-attempt：上游跑过就算（记录性前置）', () => {
  const ran = row('up', { status: 'failed', lastAttemptAt: 123 });
  const after = row('after', { edges: [{ id: 'up', kind: 'after-attempt' }] });
  assert.equal(admissionOf(after, mapOf([ran, after])).depsOk, true);
  // 从没跑过（pending 且无尝试记录）⇒ 不满足。
  const never = row('up', { status: 'pending' });
  assert.equal(admissionOf(after, mapOf([never, after])).depsOk, false);
});

// ── 两个轴必须分开（§3④） ────────────────────────────────────────────

test('★ 就绪 ≠ 可执行：「等依赖」与「等资源」必须是两个不同的卡点', () => {
  const up = row('up', { status: 'in_progress' });
  const busy = row('me', { blockedBy: ['up'], ownerName: 'w1' });
  const noOwner = () => false;

  // 依赖没满足 + 成员也没空 ⇒ 卡在依赖（先解依赖才对）。
  const a1 = admissionOf(busy, mapOf([up, busy]), { ownerAvailable: noOwner });
  assert.equal(a1.depsOk, false);
  assert.equal(a1.resourceOk, false);
  assert.equal(a1.blockedBy, 'deps', '两个轴都假时应报依赖 —— 它才是上游原因');

  // 依赖满足但成员忙 ⇒ 卡在资源。这与上一行**必须可区分**。
  const done = row('up', { status: 'completed' });
  const a2 = admissionOf(busy, mapOf([done, busy]), { ownerAvailable: noOwner });
  assert.equal(a2.depsOk, true);
  assert.equal(a2.resourceOk, false);
  assert.equal(a2.blockedBy, 'resource');
  assert.equal(a2.canStart, false, '资源不可用就不能开工');

  // 无主任务进共享池：资源轴不该阻塞它。
  const pooled = row('p', { blockedBy: ['done'] });
  assert.equal(admissionOf(pooled, mapOf([done, pooled]), { ownerAvailable: noOwner }).resourceOk, true);
});

// ── 收敛模式（§3⑥） ─────────────────────────────────────────────────

test('★ join=any：任一上游完成即放行；join=quorum：过 n 个才放行', () => {
  const a = row('a', { status: 'completed' });
  const b = row('b', { status: 'in_progress' });
  const any = row('any', { edges: [{ id: 'a', kind: 'after-success' }, { id: 'b', kind: 'after-success' }], join: { mode: 'any' } });
  assert.equal(admissionOf(any, mapOf([a, b, any])).depsOk, true, 'OR-join：一条满足即可');

  const q2 = row('q2', { edges: [{ id: 'a', kind: 'after-success' }, { id: 'b', kind: 'after-success' }], join: { mode: 'quorum', n: 2 } });
  assert.equal(admissionOf(q2, mapOf([a, b, q2])).depsOk, false, 'quorum 2：只过 1 个，不放行');
  const c = row('c', { status: 'completed' });
  const q2b = row('q2', { edges: [{ id: 'a', kind: 'after-success' }, { id: 'c', kind: 'after-success' }], join: { mode: 'quorum', n: 2 } });
  assert.equal(admissionOf(q2b, mapOf([a, c, q2b])).depsOk, true, 'quorum 2：过 2 个，放行');
});

test('★ 悬空边不得算满足（否则提前开工），也不得永久静默阻塞', () => {
  const t = row('t', { blockedBy: ['ghost'] });
  const a = admissionOf(t, mapOf([t]));
  assert.equal(a.depsOk, false, '指向不存在的上游 ⇒ 不放行');
  assert.deepEqual(a.danglingEdges, [{ id: 'ghost', kind: 'after-success' }]);
  // 结构校验要把它报成错误，人才能去修掉那条边。
  const v = validatePlan([t]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'missing-edge' && e.edge === 'ghost'));
});

// ── 失败语义（§3⑤） ────────────────────────────────────────────────

test('★ 超时/取消/环境不可用**不吃**重试额度，failed 吃', () => {
  const timedOut = row('t', { status: 'failed', outcome: 'timeout', attempts: 1, maxAttempts: 2 });
  const r1 = retryOf(timedOut);
  assert.equal(r1.countsAgainstBudget, false, '超时不算这个节点做错了');
  assert.equal(r1.allowed, true, '超时后还能再试一次');

  const realFail = row('t', { status: 'failed', outcome: 'failed', attempts: 1, maxAttempts: 1 });
  const r2 = retryOf(realFail);
  assert.equal(r2.allowed, false);
  assert.equal(r2.reason, 'attempts-exhausted', '必须说清是额度尽，而不是「上次是超时」');
});

test('retryOf：三类原因各自可区分（额度尽 / 不是失败 / 已在跑）', () => {
  assert.equal(retryOf(row('a', { status: 'in_progress' })).reason, 'already-running');
  assert.equal(retryOf(row('a', { status: 'pending' })).reason, 'not-failed');
  assert.equal(retryOf(row('a', { status: 'completed' })).reason, 'terminal');
  assert.equal(retryOf(row('a', { status: 'failed', outcome: 'failed', attempts: 0, maxAttempts: 1 })).allowed, true);
});

// ── 全图与终止性（§3⑩） ──────────────────────────────────────────────

test('★ analyzePlan：三类集合互不重叠，且终止性能回答「整批跑完没有」', () => {
  const rows = [
    row('ready1'),
    row('up', { status: 'in_progress' }),
    row('waiting', { blockedBy: ['up'] }),
    row('done', { status: 'completed' }),
    row('dead', { status: 'failed', outcome: 'failed', attempts: 1, maxAttempts: 1 }),
    row('gone', { status: 'deleted' }),
  ];
  const p = analyzePlan(rows);
  assert.deepEqual(p.dispatchable.map((a) => a.id), ['ready1'], '可派发的只有无依赖那条');
  assert.deepEqual(p.waitingDeps.map((a) => a.id), ['waiting']);
  assert.deepEqual(p.waitingResource, [], '没有指定 owner，资源轴不该拦任何东西');
  assert.equal(p.termination.total, 5, '软删除不计入图');
  assert.equal(p.termination.deleted, 1, '但软删除要计数 —— 否则像丢了数据');
  assert.equal(p.termination.completed, 1);
  assert.equal(p.termination.failedTerminal, 1);
  assert.equal(p.termination.allSettled, false, '还有在跑/待办 ⇒ 没跑完');
  assert.equal(p.termination.hasTerminalFailure, true, '有终态失败必须单独说出来');
});

test('★ analyzePlan：全部终态时 allSettled 为真；有终态失败时两个字段同时为真', () => {
  const ok = analyzePlan([row('a', { status: 'completed' }), row('b', { status: 'completed' })]);
  assert.equal(ok.termination.allSettled, true);
  assert.equal(ok.termination.hasTerminalFailure, false);
  assert.equal(ok.termination.remaining, 0);

  // 「跑完了」与「跑完了但失败了」是两种结局，不得压成一个布尔。
  const bad = analyzePlan([row('a', { status: 'completed' }), row('b', { status: 'failed', outcome: 'failed', attempts: 1, maxAttempts: 1 })]);
  assert.equal(bad.termination.allSettled, true);
  assert.equal(bad.termination.hasTerminalFailure, true);
  // 还能重试的失败不算终态，因此没跑完。
  const retryable = analyzePlan([row('b', { status: 'failed', outcome: 'failed', attempts: 0, maxAttempts: 2 })]);
  assert.equal(retryable.termination.allSettled, false);
  assert.deepEqual(retryable.retryable.map((a) => a.id), ['b']);
});

// ── 结构校验（§3③） ───────────────────────────────────────────────

test('★ validatePlan：自环必须是**独立**错误码，不能混进 cycle', () => {
  const v = validatePlan([row('a', { blockedBy: ['a'] })]);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.code === 'self-loop' && e.taskId === 'a'),
    '自环是单点错误（手滑），要与结构性环分开 —— 两者的修法完全不同');
  assert.ok(!v.errors.some((e) => e.code === 'cycle'), '单节点自环不该同时报 cycle');
});

test('★ validatePlan：真环报 cycle 并给出环成员；重复边报 duplicate-edge', () => {
  const cyc = validatePlan([
    row('a', { blockedBy: ['b'] }),
    row('b', { blockedBy: ['a'] }),
  ]);
  assert.equal(cyc.ok, false);
  const ring = cyc.errors.find((e) => e.code === 'cycle');
  assert.ok(ring && Array.isArray(ring.ring) && ring.ring.length >= 2, '环成员要给出，人才能定位');

  const dup = validatePlan([row('x', { blockedBy: ['y', 'y'] }), row('y', { status: 'completed' })]);
  assert.ok(dup.errors.some((e) => e.code === 'duplicate-edge'));
});

test('★ validatePlan：quorum 越界必须给警告（静默 clamp 等于配置不生效还看不出来）', () => {
  const v = validatePlan([
    row('a', { status: 'completed' }),
    row('q', { edges: [{ id: 'a', kind: 'after-success' }], join: { mode: 'quorum', n: 5 } }),
  ]);
  assert.equal(v.ok, true, 'quorum 越界不是结构错误（clamp 后仍可执行）');
  const w = v.warnings.find((x) => x.code === 'quorum-clamped');
  assert.ok(w, '必须留警告 —— 否则用户看不出自己写的 n 没生效');
  assert.equal(w.requested, 5);
  assert.equal(w.edges, 1);
});

// ── 写作用域（§3⑥ 另一维） ──────────────────────────────────────────

test('★ writeScopeConflicts：按路径分量判相交，且只报还没结束的任务', () => {
  const c = writeScopeConflicts([
    row('a', { writeScopes: ['src/foo'] }),
    row('b', { writeScopes: ['src/foo/bar'] }),
  ]);
  assert.equal(c.length, 1, 'src/foo 与 src/foo/bar 相交');
  assert.deepEqual(c[0].paths, ['src/foo']);

  // srcx 不是 src 的子路径（前缀必须落在分量边界上）。
  assert.deepEqual(writeScopeConflicts([
    row('a', { writeScopes: ['src'] }),
    row('b', { writeScopes: ['srcx'] }),
  ]), []);

  // 已完成的任务不与新任务打架。
  assert.deepEqual(writeScopeConflicts([
    row('a', { status: 'completed', writeScopes: ['src'] }),
    row('b', { writeScopes: ['src/a'] }),
  ]), []);
});

// ── 健壮性：纯函数不得抛 ─────────────────────────────────────────────

test('task-plan 全部导出函数对畸形输入都不抛', () => {
  for (const bad of [null, undefined, {}, 42, 'x', []]) {
    assert.doesNotThrow(() => normalizeEdges(bad));
    assert.doesNotThrow(() => normalizeJoin(bad, 0));
    assert.doesNotThrow(() => retryOf(bad));
    assert.doesNotThrow(() => admissionOf(bad, new Map()));
    assert.doesNotThrow(() => analyzePlan(bad));
    assert.doesNotThrow(() => validatePlan(bad));
    assert.doesNotThrow(() => writeScopeConflicts(bad));
  }
  assert.deepEqual(analyzePlan(null).dispatchable, []);
  assert.equal(validatePlan(null).ok, true);
});
