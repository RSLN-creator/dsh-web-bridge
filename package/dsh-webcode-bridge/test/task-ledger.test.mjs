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
  applyCreate, applyDelete, applyPlan, applyUpdate, applyAddComment, applyResolveComment, emptyLedger, ledgerPath, readLedger,
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

test('★ Notion 式正文批注：添加评论、切换 resolved 状态与字段保留', () => {
  const l0 = emptyLedger();
  const { ledger: l1, task: t1 } = applyCreate(l0, {
    subject: '实现登录表单',
    description: '请在前端添加用户名和密码输入框',
    assignedModel: { siteId: 'glm', accountSlot: 1, modelId: 'glm-4' },
    projectId: 'proj-auth',
  }, NOW);
  assert.equal(t1.assignedModel?.siteId, 'glm');
  assert.equal(t1.projectId, 'proj-auth');
  assert.equal(t1.comments.length, 0);

  // 添加评论
  const { ledger: l2, comment: c1, error: err1 } = applyAddComment(l1, t1.id, {
    quote: '用户名和密码输入框',
    text: '请同时支持记住密码和验证码登录',
    author: 'user',
  }, NOW + 1);
  assert.equal(err1, null);
  assert.equal(c1.quote, '用户名和密码输入框');
  assert.equal(c1.text, '请同时支持记住密码和验证码登录');
  assert.equal(c1.resolved, false);

  const rows = rowsOf(l2);
  assert.equal(rows[0].comments.length, 1);
  assert.equal(rows[0].comments[0].id, c1.id);
  assert.equal(rows[0].assignedModel?.siteId, 'glm');
  assert.equal(rows[0].projectId, 'proj-auth');

  // 切换 resolved 状态
  const { ledger: l3, comment: c1Resolved, error: err2 } = applyResolveComment(l2, t1.id, c1.id, NOW + 2);
  assert.equal(err2, null);
  assert.equal(c1Resolved.resolved, true);

  const rowsResolved = rowsOf(l3);
  assert.equal(rowsResolved[0].comments[0].resolved, true);
});

// 0.17.3（第三轮真机自审抓到）：`web-control.js` 的 `POST task-comment` /
// `POST task-comment-resolve` **一直在传**第五个参数 `expectedRevision`，而这两个
// 函数原先的签名**没有**这个形参 —— 传进来的值被静默丢弃。
//
// 这不是「少了个校验」：它是**假成功**。两个成员同时批注同一条任务时，后到的那个
// 会覆盖前者，而双方都收到 `ok: true`。本文件第 11 行把头注里的 CAS 列为「静默丢
// 数据」的那一类，那么它就必须在这里被钉住 —— 删掉 `applyAddComment` /
// `applyResolveComment` 里的 `revision-mismatch` 判定，本条立刻变红。
test('★ 批注写路径必须吃 CAS：过期 revision 不许静默覆盖（0.17.3 自审缺陷）', () => {
  const l0 = emptyLedger();
  const { ledger: l1, task: t1 } = applyCreate(l0, { subject: '并发批注' }, NOW);
  assert.equal(t1.revision, 0, '新任务 revision 从 0 起，夹具依赖这个起点');

  // ① 过期 revision 必须拒，且**不能**把评论写进去。
  const stale = applyAddComment(l1, t1.id, { text: '甲先写' }, NOW + 1, t1.revision + 7);
  assert.equal(stale.error, 'revision-mismatch: expected 7, actual 0');
  assert.equal(stale.comment, null);
  assert.equal(stale.ledger.tasks[0].comments.length, 0, '被拒的写不得留下半截评论');

  // ② 正确 revision 通过，并把任务 revision 推到 1。
  const ok = applyAddComment(l1, t1.id, { text: '甲先写' }, NOW + 1, t1.revision);
  assert.equal(ok.error, null);
  assert.equal(ok.ledger.tasks[0].revision, 1);

  // ③ 乙拿着**旧** revision(=0) 再来一条：必须拒，甲的评论原样保留。
  const second = applyAddComment(ok.ledger, t1.id, { text: '乙后写' }, NOW + 2, t1.revision);
  assert.equal(second.error, 'revision-mismatch: expected 0, actual 1');
  assert.equal(second.ledger.tasks[0].comments.length, 1);
  assert.equal(second.ledger.tasks[0].comments[0].text, '甲先写');

  // ④ 不传 expectedRevision（旧调用点/内部调用）仍走「不做 CAS」的旧行为 ——
  //    这条是**兼容性**约束，不是安全约束，因此必须与 ① 分开断言。
  const noCas = applyAddComment(ok.ledger, t1.id, { text: '无 CAS' }, NOW + 3);
  assert.equal(noCas.error, null);

  // ⑤ resolve 同一条缺陷、同一个判据。
  const cid = ok.comment.id;
  const badResolve = applyResolveComment(ok.ledger, t1.id, cid, NOW + 4, t1.revision);
  assert.equal(badResolve.error, 'revision-mismatch: expected 0, actual 1');
  assert.equal(badResolve.comment, null);

  const goodResolve = applyResolveComment(ok.ledger, t1.id, cid, NOW + 4, 1);
  assert.equal(goodResolve.error, null);
  assert.equal(goodResolve.comment.resolved, true);
});

test('rowsOf：畸形台账给空数组，不抛', () => {
  for (const bad of [null, undefined, {}, { tasks: null }, { tasks: [null, 42, { id: 'x' }] }]) {
    assert.doesNotThrow(() => rowsOf(bad));
    assert.ok(Array.isArray(rowsOf(bad)));
  }
});

// ── 排期 / 开始时间（0.19.0）────────────────────────────────────────────
//
// 用户 2026-09-22 原话：「设置接任务智能体和**时间**，以及模式，权限等等等详细的」。
// 移植任务板时这一整块被漏掉了。下面每条都对着一个**会静默丢数据**的位置：
// 建的时候存不住、改的时候存不住、行不带出去（存住了但界面读不到）各一条。

test('★ 0.19.0 排期：开始时间必须真的落盘，且缺省时不得伪装成 1970', () => {
  const startAt = NOW + 3_600_000;
  const r = applyCreate(emptyLedger(), { subject: 'A', schedule: { startAt } }, NOW);
  assert.equal(r.error, null);
  assert.equal(r.task.schedule.startAt, startAt, '开始时间必须原样存住');
  assert.equal(r.task.schedule.enabled, true, '设了开始时间就是「有排期」');
  // 没设时必须是 **null**，不能是 0。`Number(null)` 是 0 且 `Number.isFinite(0)` 为真，
  // 只判 isFinite 会把「没排期」读成 1970-01-01 —— 本项目在 stall-settle 上记过同一个坑。
  const bare = applyCreate(emptyLedger(), { subject: 'B' }, NOW);
  assert.equal(bare.task.schedule.startAt, null);
  assert.equal(bare.task.schedule.enabled, false);
  assert.equal(rowsOf({ tasks: [bare.task] })[0].schedule.startAt, null, '缺省经 rowsOf 仍必须是 null 而不是 0');
});

test('★ 0.19.0 排期：改的时候也必须存得住（只建时能存 = 半个功能）', () => {
  const created = applyCreate(emptyLedger(), { subject: 'A', schedule: { startAt: NOW + 1000, cron: '0 9 * * *' } }, NOW);
  const moved = applyUpdate(created.ledger, 't1', { schedule: { startAt: NOW + 9999 } }, NOW, 0);
  assert.equal(moved.error, null);
  assert.equal(moved.task.schedule.startAt, NOW + 9999, '改过的开始时间必须赢');
  assert.equal(moved.task.schedule.cron, '0 9 * * *', '没提交的 cron 不得被顺手抹掉');
  // 清空开始时间：必须真的变回「没排期」，而不是被旧值粘住。
  const cleared = applyUpdate(moved.ledger, 't1', { schedule: { startAt: null, cron: '' } }, NOW, 1);
  assert.equal(cleared.task.schedule.startAt, null, '清空必须生效');
  assert.equal(cleared.task.schedule.enabled, false);
});

test('★ 0.19.0 排期：行必须把排期/模式/权限带出去（存住了但读不到 = 没做）', () => {
  const r = applyCreate(emptyLedger(), {
    subject: 'A', mode: 'preset-x', permission: 'auto', reuseSession: true,
    schedule: { startAt: NOW + 5, cron: '*/10 * * * *' },
  }, NOW);
  const row = rowsOf({ tasks: [r.task] })[0];
  assert.equal(row.schedule.startAt, NOW + 5);
  assert.equal(row.schedule.cron, '*/10 * * * *');
  assert.equal(row.mode, 'preset-x');
  assert.equal(row.permission, 'auto');
  assert.equal(row.reuseSession, true);
  // 时间戳也要透出：用户问的「开始时间」有一半指的是「什么时候建的」。
  assert.equal(row.createdAt, NOW);
  assert.equal(row.updatedAt, NOW);
});

test('★ 0.19.0 排期：非法时间回落成「没排期」，不得抛错也不得写坏值', () => {
  const r = applyCreate(emptyLedger(), { subject: 'A', schedule: { startAt: 'not-a-number' } }, NOW);
  assert.equal(r.error, null, '人手填的表单，一个填错的时间不该让整条任务写不进去');
  assert.equal(r.task.schedule.startAt, null);
  assert.equal(r.task.schedule.enabled, false);
});
