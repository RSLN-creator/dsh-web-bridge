// task-graph.test.mjs — 任务板**图诊断**的护栏（0.15.12 建）。
//
// ## 为什么这个文件必须存在
//
// 官方 `agentTeams.listTasks` 只给逐行事实（status / blockedBy / ready / writeScopes），
// 而任务板面板要回答的是三个官方数据里**一个都没有**的问题：
//
//   1. 为什么整块板没动？ → 「当前阻塞点」：谁在卡住几个下游；
//   2. 还要多久？         → **关键路径**（最长依赖链），整批任务的下界；
//   3. 图本身坏了吗？     → 环 / 自环 / 悬空边。
//
// 这三条由 `lib/task-graph.js` 纯计算得出。纯函数的好处是「可以被反证」：
// 每条判据都能用一个手算得出答案的小图钉住，而不是靠「跑起来看着像对的」。
//
// ## 每条断言都在钉一个具体的错法
//
// 图算法的错法不显眼——它不会抛错，只会**安静地给出错的答案**：
// 关键路径算短了一个节点、带环时也照样返回一条「路径」、软删除的行被当成
// 永不完成的阻塞者。所以本文件刻意包含**反向用例**（带环时关键路径必须是空、
// 不是编一条出来），并逐条对应文件头里那份分析中的 §3 条目。
//
// 桩刻意做成**纯数据行**（与 roster.projectTasks 的输出同形），不构造 cordis
// 上下文——图的正确性与官方服务无关，混进服务桩只会掩盖「代码其实依赖了
// 某个没声明的字段」这种漂移。

import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeTaskGraph } from '../lib/task-graph.js';

/** 一行任务的最小形状（与 lib/roster.js projectTasks 的输出逐字段同形）。 */
const row = (id, extra = {}) => ({
  id, subject: 'T-' + id, status: 'pending', ownerName: null,
  blockedBy: [], writeScopes: [], revision: 1, ready: false, ...extra,
});

// ---- 1) 就绪与阻塞：官方判据是「全部 blocker 都 completed」 -----------------

test('就绪判据：blocker 全部 completed 才 ready（与官方 taskReady 同义）', () => {
  const g = analyzeTaskGraph([
    row('a', { status: 'completed', ready: false }),
    row('b', { blockedBy: ['a'], ready: true }),
    row('c', { blockedBy: ['a'], ready: true }),
  ]);
  assert.equal(g.nodes.find(n => n.id === 'b').ready, true);
  assert.equal(g.counts.ready, 2, 'b 与 c 都应就绪');
  assert.equal(g.counts.blocked, 0);
  // a 卡住两个下游（b、c 都未完成）——这是「阻塞点」的原始读数。
  assert.equal(g.blockedOn[0].id, 'a');
  assert.equal(g.blockedOn[0].waitingCount, 2);
});

test('阻塞：上游还在跑时下游未就绪，且**阻塞者状态必须一并给出**', () => {
  // 为什么状态必须一起给：只看「被 1 项卡住」分不清是「正常等待」还是
  // 「上游已经失败、需要人来处理」——那是两个完全不同的动作。
  const g = analyzeTaskGraph([
    row('a', { status: 'in_progress', ownerName: 'lead' }),
    row('b', { blockedBy: ['a'] }),
  ]);
  const b = g.nodes.find(n => n.id === 'b');
  assert.equal(b.ready, false);
  assert.deepEqual(b.unresolvedBlockers, ['a']);
  assert.equal(b.blockers[0].status, 'in_progress');
  assert.equal(b.blockers[0].ownerName, 'lead');
  assert.equal(g.counts.blocked, 1);
});

test('failed 的上游同样不算完成：下游仍未就绪（官方只有一种边语义）', () => {
  // 对照研究 §3① 指出「失败也要跑」（after-settle）这种边在本项目里**不发明**——
  // 官方逐字是 completed 才算通过。这条把那个立场钉住：failed 不等于通过。
  const g = analyzeTaskGraph([
    row('a', { status: 'failed' }),
    row('b', { blockedBy: ['a'] }),
  ]);
  assert.equal(g.nodes.find(n => n.id === 'b').ready, false);
  assert.equal(g.nodes.find(n => n.id === 'b').blockers[0].status, 'failed');
});

// ---- 2) 关键路径：最长依赖链，且必须真的**最长** ---------------------------

test('关键路径：取最长链而不是任意一条（菱形图里正确的一条）', () => {
  //   a → b → c
  //   a → d
  // 最长链 a→b→c（3 个节点）。若实现按「第一个 blocker」递归，会给出 a→d。
  const g = analyzeTaskGraph([
    row('a', { status: 'completed' }),
    row('b', { blockedBy: ['a'] }),
    row('d', { blockedBy: ['a'] }),
    row('c', { blockedBy: ['b'] }),
  ]);
  assert.equal(g.acyclic, true);
  assert.equal(g.criticalPathLength, 3);
  assert.deepEqual(g.criticalPath, ['a', 'b', 'c']);
  // 深度也逐节点核对：d 的深度是 2（a→d），不是 3。
  assert.equal(g.nodes.find(n => n.id === 'd').depth, 2);
  assert.equal(g.nodes.find(n => n.id === 'c').depth, 3);
});

test('关键路径：无依赖的孤立任务，最长链长度是 1', () => {
  const g = analyzeTaskGraph([row('a'), row('b')]);
  assert.equal(g.criticalPathLength, 1);
  // 两个都是深度 1，取先出现的那个；顺序必须稳定（面板轮询时行不能跳动）。
  assert.deepEqual(g.criticalPath, ['a']);
});

// ---- 3) 结构问题：环 / 自环 / 悬空边 ---------------------------------------

test('★ 带环时关键路径必须为空，而不是编一条出来', () => {
  // 为什么这条最重要：带环的图上「最长路径」**无定义**（可以绕环无限长）。
  // 一个「照样返回某条路径」的实现不会抛错，只会给出一个看起来正常的数——
  // 那比报错更坏，因为用户会照着它做计划。
  const g = analyzeTaskGraph([
    row('a', { blockedBy: ['c'] }),
    row('b', { blockedBy: ['a'] }),
    row('c', { blockedBy: ['b'] }),
  ]);
  assert.equal(g.acyclic, false);
  assert.deepEqual(g.criticalPath, [], '带环时不得给出关键路径');
  assert.equal(g.criticalPathLength, null, '带环时长度必须是 null 而不是某个数');
  assert.equal(g.cycles.length, 1);
  assert.deepEqual([...g.cycles[0]].sort(), ['a', 'b', 'c'], '环成员必须全被列出');
  for (const id of ['a', 'b', 'c']) assert.equal(g.nodes.find(n => n.id === id).inCycle, true);
});

test('自环单独成字段，不混进 cycles（单点错误 vs 结构错误定位手段不同）', () => {
  // 对照研究 §3③ 点名了官方把自环归到 cycle 码、调用方分不开这一点。
  // 本模块给独立字段：自环是「改掉那一行依赖」就能修的单点错误。
  const g = analyzeTaskGraph([row('a', { blockedBy: ['a'] })]);
  assert.deepEqual(g.selfLoops, ['a']);
  assert.deepEqual(g.cycles, [], '自环不该同时出现在 cycles 里');
  assert.deepEqual(g.nodes.find(n => n.id === 'a').blockedBy, [], '自环不该留在阻塞列表里');
});

test('悬空边如实报出，且不得把下游算成「被一个不存在的任务阻塞」', () => {
  const g = analyzeTaskGraph([row('a', { blockedBy: ['ghost'] })]);
  assert.deepEqual(g.missingEdges, [{ from: 'a', to: 'ghost' }]);
  assert.deepEqual(g.nodes.find(n => n.id === 'a').blockedBy, []);
  // 悬空边不是「未完成的上游」——它必须被移出阻塞列表，否则下游会永远 blocked。
  // 注意这里**不能**断言 ready===true：`row()` 夹具带了官方的 `ready:false`，
  // 而就绪一律以官方值为准（见下一条「就绪来源」用例）。本用例只钉图的形状。
  assert.equal(g.nodes.find(n => n.id === 'a').unresolvedBlockers.length, 0);
});

test('软删除的行整行移出图，但**计数**保留（deleted 字段）', () => {
  // 官方把 deleted 同时排除在「作 blocker」与「被遍历」之外，所以软删除
  // 不会制造悬空边。本模块照此办理；同时必须计数，否则「板上有 3 条、图里 2 条」
  // 看起来像丢了数据。
  const g = analyzeTaskGraph([
    row('a', { status: 'completed' }),
    row('b', { blockedBy: ['a'] }),
    row('z', { status: 'deleted' }),
  ]);
  assert.equal(g.counts.total, 2);
  assert.equal(g.counts.deleted, 1);
  assert.equal(g.nodes.find(n => n.id === 'z'), undefined);
  // 删掉的任务不再是悬空边。
  assert.deepEqual(g.missingEdges, []);
});

// ---- 4) 就绪来源必须如实标注（官方值 vs 桥现算） ---------------------------

test('★ ready 取官方算好的布尔，并在 readySource 里说明来源', () => {
  // 官方已经算好 ready；桥重算一遍迟早与官方漂移（roster.js 顶部记的那一族缺陷）。
  // 因此只有官方**没给**这个键时才现算，且必须标成 computed。
  const official = analyzeTaskGraph([row('a', { status: 'pending', blockedBy: [], ready: false })]);
  assert.equal(official.nodes[0].readySource, 'official');
  assert.equal(official.nodes[0].ready, false, '官方说 false 就必须是 false（即使看起来该就绪）');
  const computed = analyzeTaskGraph([{ id: 'a', subject: 'A', status: 'pending', blockedBy: [] }]);
  assert.equal(computed.nodes[0].readySource, 'computed');
  assert.equal(computed.nodes[0].ready, true);
});

// ---- 5) 健壮性：畸形输入不得抛错（面板轮询会一直调用它） -------------------

test('畸形输入不抛错：非数组 / 缺 id / 缺字段一律安全降级', () => {
  for (const bad of [null, undefined, 'x', 42, {}, [null], [{ subject: '无 id' }], [{ id: 'a', blockedBy: 'not-an-array' }]]) {
    assert.doesNotThrow(() => analyzeTaskGraph(bad), 'input=' + JSON.stringify(bad));
    const g = analyzeTaskGraph(bad);
    assert.ok(Array.isArray(g.nodes) && Array.isArray(g.cycles) && Array.isArray(g.criticalPath));
    assert.equal(typeof g.counts.total, 'number');
  }
});

test('重复 blocker 不会把下游算成被两项卡住', () => {
  const g = analyzeTaskGraph([
    row('a', { status: 'in_progress' }),
    row('b', { blockedBy: ['a', 'a'] }),
  ]);
  assert.deepEqual(g.nodes.find(n => n.id === 'b').blockedBy, ['a']);
  assert.equal(g.nodes.find(n => n.id === 'a').waitingCount, 1);
});

test('阻塞点按「卡住的下游数」降序排列，同级按 id 稳定排序', () => {
  const g = analyzeTaskGraph([
    row('p'), row('q'),
    row('x', { blockedBy: ['p'] }),
    row('y', { blockedBy: ['p'] }),
    row('z', { blockedBy: ['q'] }),
  ]);
  assert.deepEqual(g.blockedOn.map(b => b.id), ['p', 'q']);
  assert.deepEqual(g.blockedOn.map(b => b.waitingCount), [2, 1]);
});

// ---- 6) 未归属计数：面板要能提示「有任务没人认领」 -------------------------

test('counts.unowned 只数未完成的无人认领任务', () => {
  const g = analyzeTaskGraph([
    row('a', { status: 'in_progress' }),
    row('b', { status: 'completed' }),
    row('c'),
  ]);
  assert.equal(g.counts.unowned, 2, 'a 与 c 都还没完成且没有 ownerName');
});
