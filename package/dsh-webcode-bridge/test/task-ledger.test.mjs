// task-ledger.test.mjs — 桥自有任务台账的护栏（0.17.0）。
//
// ## 这个文件要证明什么
//
// `lib/task-ledger.js` 是「以任务为导向」那一层的地基：任务有**独立的库**，
// 不寄生在任何会话上。它同时是第一个**写**路径——0.16.x 之前桥对任务只有读。
// 因此这里的每条断言都对着一个「会静默丢数据」的地方：
//
//   · 台账读不动时必须**报原因**，绝不回落成空台账（空台账看起来像「本来就没有」）；
//   · 更高版本的台账必须**拒写**，尽力解析会写回一份丢字段的台账（不可逆损坏）；
//   · CAS 不匹配必须拒——静默覆盖会让前一个人的改动**无声消失**，两人都以为成功；
//   · 非法状态迁移必须拒（`completed → pending` 会让已交付节点的下游重新变回未满足）；
//   · 删除一条任务必须**同时摘掉指向它的边**，否则下游永远不就绪（看起来像卡死）；
//   · 计划导入必须把「本地引用名」整体重写成持久 id，引用不到的名字**丢掉并记明**。
//
// 落盘用真实临时目录（node:test 的 `t.mock` 不用，避免与本仓库既有的
// 「mock 失真」教训同族）。TMPDIR 指向工作区 .tmp 是本机前提（见 doc/progress.md）。

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  applyCreate, applyDelete, applyPlan, applyUpdate, emptyLedger, ledgerPath, readLedger,
  rowsOf, writeLedger, LEDGER_VERSION, MAX_TASKS,
} from '../lib/task-ledger.js';

/** 每个用例一个独立目录，跑完删掉。 */
function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'webcode-ledger-'));
}

const NOW = 1_700_000_000_000;

// ── 落盘与读取 ────────────────────────────────────────────────────────

test('★ 台账不存在 ⇒ 空台账 + 无错；这是**真实的没有任务**', () => {
  const root = tempRoot();
  try {
    const r = readLedger(root);
    assert.equal(r.error, null);
    assert.equal(r.exists, false, 'ENOENT 必须与「读不动」区分开');
    assert.deepEqual(r.ledger.tasks, []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('★ 台账 JSON 坏了 ⇒ 报 ledger-corrupt，**绝不**回落成空台账', () => {
  const root = tempRoot();
  try {
    const file = ledgerPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{"version":1,"taskSeq":2,"tasks":[{"id":"t1"');
    const r = readLedger(root);
    assert.equal(r.ledger, null, '坏文件不得被当成空台账');
    assert.ok(/^ledger-corrupt/.test(r.error), '必须给出可核对的原因：' + r.error);
    assert.equal(r.exists, true, '文件是存在的 —— 这与「没有任务」是两回事');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('★ 台账版本高于本实现 ⇒ 拒读（尽力解析会写回丢字段的台账）', () => {
  const root = tempRoot();
  try {
    const file = ledgerPath(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ version: LEDGER_VERSION + 1, taskSeq: 0, tasks: [] }));
    const r = readLedger(root);
    assert.equal(r.ledger, null);
    assert.ok(/^ledger-version-ahead/.test(r.error), r.error);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('写读往返：落盘再读回逐字相同（含 edges/join/attempts）', () => {
  const root = tempRoot();
  try {
    const { ledger } = applyCreate(emptyLedger(), {
      subject: '做一件事', description: '细节', ownerName: 'w1',
      blockedBy: ['t0'], edges: [{ id: 't0', kind: 'after-settle' }],
      join: { mode: 'quorum', n: 1 }, writeScopes: ['lib/'], maxAttempts: 3,
    }, NOW);
    const w = writeLedger(root, ledger);
    assert.equal(w.ok, true, w.error);
    const r = readLedger(root);
    assert.equal(r.error, null, r.error);
    assert.equal(r.exists, true);
    const t = r.ledger.tasks[0];
    assert.equal(t.subject, '做一件事');
    assert.deepEqual(t.edges, [{ id: 't0', kind: 'after-settle' }]);
    assert.deepEqual(t.join, { mode: 'quorum', n: 1 });
    assert.equal(t.maxAttempts, 3);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('拿不到工作区根 ⇒ 两个 API 各自如实报 no-workspace-root（不猜相对路径）', () => {
  assert.equal(readLedger(null).error, 'no-workspace-root');
  assert.equal(writeLedger(null, emptyLedger()).error, 'no-workspace-root');
  assert.equal(ledgerPath(null), null);
});

// ── 创建 ─────────────────────────────────────────────────────────────

test('★ 空标题必须**拒收并给原因**，不得静默丢弃', () => {
  const r = applyCreate(emptyLedger(), { subject: '   ' }, NOW);
  assert.equal(r.task, null);
  assert.equal(r.error, 'empty-subject', '静默丢弃会让用户点一次「添加」什么都没发生');
  assert.equal(r.ledger.tasks.length, 0);
});

test('创建：id 递增、初始 pending、attempts 0，且**不带 ready 键**', () => {
  let { ledger, task } = applyCreate(emptyLedger(), { subject: 'a' }, NOW);
  assert.equal(task.id, 't1');
  assert.equal(task.status, 'pending');
  assert.equal(task.attempts, 0);
  assert.equal(task.maxAttempts, 1, '缺省 1 次：与「不重试即失败」立场一致');
  // ready 归 task-plan.js 的判据层 —— 写入层给一个就是第二份真相。
  assert.equal('ready' in task, false, '创建的行不得带 ready');
  const second = applyCreate(ledger, { subject: 'b' }, NOW);
  assert.equal(second.task.id, 't2');
});

test('创建：blockedBy 去重（重复边是手写数据的判据，不该被写入路径触发）', () => {
  const { task } = applyCreate(emptyLedger(), { subject: 'a', blockedBy: ['t0', 't0', 't1'] }, NOW);
  assert.deepEqual(task.blockedBy, ['t0', 't1']);
});

test('创建：超过 MAX_TASKS 拒收（含软删除不计入活跃）', () => {
  let ledger = emptyLedger();
  for (let i = 0; i < MAX_TASKS; i++) ledger = applyCreate(ledger, { subject: 's' + i }, NOW).ledger;
  const over = applyCreate(ledger, { subject: 'one-more' }, NOW);
  assert.equal(over.task, null);
  assert.ok(/^too-many-tasks/.test(over.error), over.error);
});

// ── 更新与 CAS ───────────────────────────────────────────────────────

test('★ CAS：expectedRevision 不匹配必须拒（静默覆盖会让前一个人的改动无声消失）', () => {
  let { ledger } = applyCreate(emptyLedger(), { subject: 'a' }, NOW);
  const first = applyUpdate(ledger, 't1', { ownerName: 'w1' }, NOW, 0);
  assert.equal(first.error, null);
  ledger = first.ledger;
  assert.equal(first.task.revision, 1);
  // 第二个人拿着过期的 revision 0 来改。
  const stale = applyUpdate(ledger, 't1', { ownerName: 'w2' }, NOW, 0);
  assert.equal(stale.task, null);
  assert.ok(/^revision-mismatch/.test(stale.error), stale.error);
  assert.equal(stale.ledger.tasks[0].ownerName, 'w1', '旧改动不得被覆盖');
});

test('★ 非法状态迁移必须拒：completed 不得回到 pending', () => {
  let { ledger } = applyCreate(emptyLedger(), { subject: 'a' }, NOW);
  ledger = applyUpdate(ledger, 't1', { status: 'in_progress' }, NOW).ledger;
  ledger = applyUpdate(ledger, 't1', { status: 'completed' }, NOW).ledger;
  const back = applyUpdate(ledger, 't1', { status: 'pending' }, NOW);
  assert.equal(back.task, null);
  assert.ok(/^illegal-transition/.test(back.error), back.error);
  // 已交付节点的下游若因回退重新变回未满足，是**不可见的语义损坏**。
  assert.equal(back.ledger.tasks[0].status, 'completed');
});

test('状态迁移：pending → in_progress 记一次尝试；离开 failed 清掉 outcome', () => {
  let { ledger } = applyCreate(emptyLedger(), { subject: 'a', maxAttempts: 2 }, NOW);
  ledger = applyUpdate(ledger, 't1', { status: 'in_progress' }, NOW).ledger;
  assert.equal(ledger.tasks[0].attempts, 1, '进 in_progress 就记一次尝试');
  ledger = applyUpdate(ledger, 't1', { status: 'failed', outcome: 'failed' }, NOW).ledger;
  assert.equal(ledger.tasks[0].outcome, 'failed');
  // 重试：failed → pending 是允许的（额度判定归 task-plan.js）。
  ledger = applyUpdate(ledger, 't1', { status: 'pending' }, NOW).ledger;
  assert.equal(ledger.tasks[0].outcome, '', '离开 failed 必须清掉上次结局');
  assert.equal(ledger.tasks[0].status, 'pending');
});

test('更新：空标题拒、未知状态拒、任务不存在拒，三者原因各自可辨', () => {
  const { ledger } = applyCreate(emptyLedger(), { subject: 'a' }, NOW);
  assert.equal(applyUpdate(ledger, 't1', { subject: '  ' }, NOW).error, 'empty-subject');
  assert.ok(/^unknown-status/.test(applyUpdate(ledger, 't1', { status: 'whatever' }, NOW).error));
  assert.equal(applyUpdate(ledger, 't9', { subject: 'x' }, NOW).error, 'task-not-found');
});

// ── 删除 ─────────────────────────────────────────────────────────────

test('★ 删除必须**同时摘掉指向它的边**（留下的悬空边会让下游永远不就绪）', () => {
  let ledger = applyCreate(emptyLedger(), { subject: 'up' }, NOW).ledger;
  ledger = applyCreate(ledger, { subject: 'down', blockedBy: ['t1'] }, NOW).ledger;
  const del = applyDelete(ledger, 't1', NOW);
  assert.equal(del.error, null);
  assert.equal(del.ledger.tasks[0].status, 'deleted');
  assert.deepEqual(del.ledger.tasks[1].blockedBy, [], '指向被删任务的边必须摘掉');
  assert.deepEqual(del.prunedFrom, ['t2'], '摘了谁的边要说出来');
});

test('删除：带 edges 的行也一并摘掉那条边（两个字段不得漂移）', () => {
  let ledger = emptyLedger();
  ledger = applyCreate(ledger, { subject: 'up' }, NOW).ledger;
  ledger = applyCreate(ledger, {
    subject: 'down', blockedBy: ['t1'],
    edges: [{ id: 't1', kind: 'after-settle' }, { id: 'other', kind: 'after-success' }],
  }, NOW).ledger;
  const del = applyDelete(ledger, 't1', NOW);
  const down = del.ledger.tasks[1];
  assert.deepEqual(down.blockedBy, []);
  assert.deepEqual(down.edges, [{ id: 'other', kind: 'after-success' }], 'edges 里那条也要摘');
});

test('删除：不存在的 id 报 task-not-found', () => {
  assert.equal(applyDelete(emptyLedger(), 'nope', NOW).error, 'task-not-found');
});

// ── 计划导入（AI 拆分的落库路径） ──────────────────────────────────

test('★ 计划导入：本地引用名必须整体重写成持久 id', () => {
  const r = applyPlan(emptyLedger(), {
    tasks: [
      { ref: 'a', subject: '第一步' },
      { ref: 'b', subject: '第二步', dependencies: ['a'] },
      { ref: 'c', subject: '第三步', dependencies: ['a', 'b'] },
    ],
  }, NOW);
  assert.equal(r.error, null);
  assert.equal(r.created.length, 3);
  const bySubject = new Map(r.created.map((t) => [t.subject, t]));
  // 引用名 a 对应第一条的持久 id —— 下游必须指向它，而不是字符串 'a'。
  const aId = bySubject.get('第一步').id;
  assert.deepEqual(bySubject.get('第二步').blockedBy, [aId]);
  assert.deepEqual(bySubject.get('第三步').blockedBy, [aId, bySubject.get('第二步').id]);
  assert.deepEqual(r.droppedEdges, []);
});

test('★ 计划导入：引用不到的名字**丢掉并记明**，不留成悬空边', () => {
  const r = applyPlan(emptyLedger(), {
    tasks: [{ ref: 'a', subject: 'A', dependencies: ['ghost'] }],
  }, NOW);
  assert.deepEqual(r.created[0].blockedBy, [], '悬空边会让这条永远不就绪 —— 必须丢');
  assert.deepEqual(r.droppedEdges, [{ ref: 'a', dependency: 'ghost', reason: 'undefined-ref' }]);
});

test('★ 计划导入：自环在**落库那一刻**就修掉，并记明', () => {
  const r = applyPlan(emptyLedger(), {
    tasks: [{ ref: 'a', subject: 'A', dependencies: ['a'] }],
  }, NOW);
  assert.deepEqual(r.created[0].blockedBy, []);
  assert.deepEqual(r.droppedEdges, [{ ref: 'a', dependency: 'a', reason: 'self-loop' }]);
});

test('计划导入：空标题整条跳过且不占 id；全部为空则整批拒收', () => {
  const r = applyPlan(emptyLedger(), {
    tasks: [{ ref: 'a', subject: '  ' }, { ref: 'b', subject: '好的' }],
  }, NOW);
  assert.equal(r.created.length, 1);
  assert.equal(r.created[0].id, 't1', '跳过的空标题不得占掉一个 id');
  const allEmpty = applyPlan(emptyLedger(), { tasks: [{ subject: '' }] }, NOW);
  assert.equal(allEmpty.error, 'all-subjects-empty');
  assert.equal(allEmpty.created.length, 0);
});

test('计划导入：空计划拒收；超出 MAX_TASKS 拒收并说清算式', () => {
  assert.equal(applyPlan(emptyLedger(), { tasks: [] }, NOW).error, 'empty-plan');
  assert.equal(applyPlan(emptyLedger(), null, NOW).error, 'empty-plan');
  let ledger = emptyLedger();
  for (let i = 0; i < MAX_TASKS - 1; i++) ledger = applyCreate(ledger, { subject: 's' + i }, NOW).ledger;
  const over = applyPlan(ledger, { tasks: [{ subject: 'x' }, { subject: 'y' }] }, NOW);
  assert.ok(/^too-many-tasks/.test(over.error), over.error);
  assert.equal(over.ledger.tasks.length, MAX_TASKS - 1, '拒收时不得写进半批');
});

test('计划导入：序号接续已有台账，不与既有 id 撞', () => {
  let ledger = applyCreate(emptyLedger(), { subject: 'old' }, NOW).ledger;
  ledger = applyPlan(ledger, { tasks: [{ ref: 'a', subject: 'new' }] }, NOW).ledger;
  const ids = ledger.tasks.map((t) => t.id);
  assert.deepEqual(ids, ['t1', 't2']);
  assert.equal(new Set(ids).size, ids.length, 'id 不得重复');
});

// ── 行塑形 ───────────────────────────────────────────────────────────

test('★ rowsOf：软删除行不出现，且**不带 ready**（判据只有一个来源）', () => {
  let ledger = applyCreate(emptyLedger(), { subject: 'a' }, NOW).ledger;
  ledger = applyCreate(ledger, { subject: 'b' }, NOW).ledger;
  ledger = applyDelete(ledger, 't1', NOW).ledger;
  const rows = rowsOf(ledger);
  assert.deepEqual(rows.map((r) => r.id), ['t2'], '软删除行不进面板');
  assert.equal('ready' in rows[0], false, 'rowsOf 不得给 ready —— 那会与 task-plan 的第二份真相漂移');
  assert.equal(rows[0].attempts, 0);
  assert.equal(rows[0].maxAttempts, 1);
});

test('rowsOf：畸形台账给空数组，不抛', () => {
  for (const bad of [null, undefined, {}, { tasks: null }, { tasks: [null, 42, { id: 'x' }] }]) {
    assert.doesNotThrow(() => rowsOf(bad));
    assert.ok(Array.isArray(rowsOf(bad)));
  }
});
