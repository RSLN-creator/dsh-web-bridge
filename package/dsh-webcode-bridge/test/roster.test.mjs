// roster.test.mjs — 花名册投影的护栏（0.15.0 建，0.15.4 按官方真实契约重写）。
//
// ## 为什么这个文件必须存在
//
// 0.14.9 的面板消费 `/__webcode/status.subAgents` 与 `.team`，而这两个字段在
// 服务端是**写死的空数组**——面板写得再漂亮也永远显示「当前没有正在运行的
// 子代理或 Team 成员」。0.15.0 把它们接上真实数据源（lib/roster.js）。
//
// ## 为什么 0.15.4 要重写它（这是一次「护栏自己失真」的教训）
//
// 旧版所有 Team 用例都基于一个**错误的假设**：`listMembers(agent)` 对
// 「不是 Team 成员的 agent」会**抛错**，所以要挨个试 `agents.list()`。
// 官方实现恰恰相反 —— `tryMembership`
// （dsh-experimental-agent-team/lib/index.js:397-430）对**任何**没有
// `subagentDescriptor` 的顶层 Agent 都返回 `{ role:'lead', name:'lead' }`
// 而**不抛错**（:412-417 与 :421-426 两条出口），`list(membership)` 还无条件
// 先插一行 lead 伪行（:439-446）。
//
// 于是旧实现读到的是「进程里**第一个**顶层 agent 自己的 lead 伪行」，
// 与用户正在看的会话无关。活进程实证：换两个不同 sessionId 查询
// `/__webcode/status`，`team` 段**逐字相同**。
//
// 旧护栏全绿，因为它给了一个「会抛错的假服务」——**桩的语义错了，
// 再多的断言也只是在验证那个错语义**。这与本项目另外两次同族教训
// （mock fetch 不看方法、useState 桩按名字取值）是同一类：护栏自己失真时，
// 全绿毫无意义。所以本版每个桩都按官方**真实**行为写，并额外加一条
// 「反向验证」用例，证明判据抓得住旧实现。
//
// ## 三条纪律各有一组断言
//
//   1. **真实读取 + 凭据正确**：成员必须真读出来，且凭据必须是**当前会话自己**；
//   2. **不可用 ⇒ 空数组 + 原因，绝不编造**：包没装 / 服务没注册 / 会话不在
//      注册表 / 非 Team 成员，一律空数组 + 非空 `*Error`；
//   3. **分区独立降级**：Team 侧挂了不能连坐子代理侧，反之亦然。
//
// 桩对象刻意做成最小形状（只有本模块真正调用的方法），而不是完整实现——
// 完整桩会掩盖「代码其实依赖了某个没声明的成员」这种漂移。

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { projectTeam, projectTasks, projectSubAgents, projectRoster } from '../lib/roster.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * 造一个最小 cordis 上下文桩。
 *
 * `agents` 必须同时提供 `get` 与 `list`：`get` 是 0.15.4 起的**唯一**权威凭据
 * 取法，`list` 只在旧实现里用过（保留它是为了证明新实现**不再**依赖它）。
 */
function ctxWith({ teams = undefined, agents = undefined, sessions = undefined, projections = undefined, subagents = undefined } = {}) {
  const services = { agentTeams: teams, agents, sessions, sessionProjections: projections, subagents };
  const ctx = {};
  for (const [k, v] of Object.entries(services)) if (v !== undefined) ctx[k] = v;
  // ctx.get() 是官方另一条取法（lib/index.js 取 webServer 时两条都试）。
  ctx.get = (name) => services[name];
  return ctx;
}

const LEAD = { id: 'session-lead-1' };

/** 一个「会话在注册表里」的 agents 桩：get 只认给定的 id。 */
function agentsWith(...ids) {
  const live = ids.map((id) => ({ id }));
  return {
    get: (id) => live.find((a) => a.id === id),
    list: () => live.slice(),
  };
}

// ---- 1) Team：凭据必须是当前会话自己 ---------------------------------------

test('projectTeam：从官方 agentTeams 服务读出真实成员（含 role/status/model）', () => {
  const members = [
    { id: 'session-lead-1', name: 'lead', role: 'lead', status: 'running', model: 'deepseek:deepseek', diagnostics: [] },
    { id: 'session-rev-1', name: 'reviewer', role: 'teammate', status: 'idle', context: 'fresh', diagnostics: [] },
  ];
  const seen = [];
  const ctx = ctxWith({
    teams: {
      listMembers(agent) { seen.push(agent.id); return members; },
      listTasks() { return []; },
    },
    agents: agentsWith('session-lead-1'),
  });
  const { team, teamError } = projectTeam(ctx, 'session-lead-1');
  assert.equal(teamError, null, '真实服务可用时不该报错');
  assert.deepEqual(seen, ['session-lead-1'], '凭据必须是**当前会话**，不是列表里第一个');
  assert.equal(team.length, 2, '两个成员必须都读出来');
  assert.deepEqual(team.map((m) => m.name), ['lead', 'reviewer']);
  assert.deepEqual(team.map((m) => m.role), ['lead', 'teammate']);
  assert.deepEqual(team.map((m) => m.status), ['running', 'idle']);
  // 模型 / 上下文模式：Team 与子代理最直观的差别之一，官方 TeamMemberView 有。
  assert.equal(team[0].model, 'deepseek:deepseek');
  assert.equal(team[1].context, 'fresh');
});

test('★ projectTeam：绝不拿别的 agent 顶替（0.15.3 的真 bug，判据在此）', () => {
  // 旧实现：挨个试 agents.list()，谁不抛错就用谁 ⇒ 这里会返回别人的 lead。
  // 新实现：当前会话不在注册表 ⇒ caller-not-live，宁可为空。
  const ctx = ctxWith({
    // 官方 tryMembership 对任何顶层 agent 都返回 lead、不抛错——桩必须照抄这一点，
    // 否则这条判据会「因为桩会抛错」而假绿。
    teams: { listMembers: () => [{ id: 'someone-else', name: 'lead', role: 'lead', status: 'running' }], listTasks: () => [] },
    agents: agentsWith('some-other-session'),
  });
  const { team, teamError } = projectTeam(ctx, 'session-mine');
  assert.deepEqual(team, [], '当前会话不在注册表时不得返回任何成员行');
  assert.equal(teamError, 'caller-not-live');
});

test('projectTeam：非 Team 成员（官方 TEAM_NOT_MEMBER）⇒ 空数组 + 原因', () => {
  const ctx = ctxWith({
    teams: {
      listMembers() { const e = new Error('agent "x" is not a member of an active Agent Team'); e.code = 'TEAM_NOT_MEMBER'; throw e; },
      listTasks: () => [],
    },
    agents: agentsWith('session-lead-1'),
  });
  const { team, teamError } = projectTeam(ctx, 'session-lead-1');
  assert.deepEqual(team, []);
  assert.ok(/^not-a-team-member/.test(teamError), '必须带上原因，实际：' + teamError);
});

test('★ projectTeam：方法里的 this 必须还活着（服务是 class 实例）', () => {
  // 官方服务是 class 实例，方法体里用 this.roster / this.tasks。
  // 解引用后直接调用会让 this 变 undefined 并抛 TypeError，而我们的 catch
  // 会把它降级成一句「读不到」——症状与「官方包没装」一模一样。
  const svc = {
    _members: [{ id: 'session-lead-1', name: 'lead', role: 'lead', status: 'running' }],
    listMembers() { return this._members; },
    listTasks() { return []; },
  };
  const ctx = ctxWith({ teams: svc, agents: agentsWith('session-lead-1') });
  const { team, teamError } = projectTeam(ctx, 'session-lead-1');
  assert.equal(teamError, null, 'this 绑定丢了会让这个方法静默降级：' + teamError);
  assert.equal(team.length, 1);
});

test('projectTeam：ctx.get() 那条取法也要能用', () => {
  const ctx = {
    get: (n) => (n === 'agentTeams'
      ? { listMembers: () => [{ id: 'a', name: 'n', role: 'lead', status: 'idle' }], listTasks: () => [] }
      : n === 'agents' ? { get: (id) => ({ id }), list: () => [LEAD] } : undefined),
  };
  const { team, teamError } = projectTeam(ctx, 'session-lead-1');
  assert.equal(teamError, null, '属性直取拿不到时，ctx.get 必须兜住');
  assert.equal(team.length, 1);
});

// ---- 2) Team：任务板归属按 ownerName，不是团队总数 -------------------------

test('★ projectTeam：taskCount 按 ownerName 归属（旧实现给的是团队总数，是假事实）', () => {
  const ctx = ctxWith({
    teams: {
      listMembers: () => [
        { id: 'l', name: 'lead', role: 'lead', status: 'running' },
        { id: 'r', name: 'reviewer', role: 'teammate', status: 'idle' },
      ],
      listTasks: () => [
        { id: 't1', ownerName: 'lead' },
        { id: 't2', ownerName: 'reviewer' },
        { id: 't3', ownerName: 'reviewer' },
      ],
    },
    agents: agentsWith('session-lead-1'),
  });
  const { team } = projectTeam(ctx, 'session-lead-1');
  assert.deepEqual(team.map((m) => m.taskCount), [1, 2],
    '旧实现会对每个成员给同一个「团队总数 3」——那是假事实');
});

test('projectTeam：taskCount 只在真的能读到任务板时才出现（不是 0 占位）', () => {
  const ctx = ctxWith({
    teams: { listMembers: () => [{ id: 'a', name: 'a', role: 'teammate', status: 'idle' }] },
    agents: agentsWith('session-lead-1'),
  });
  const { team } = projectTeam(ctx, 'session-lead-1');
  assert.equal(team.length, 1);
  // 没有 listTasks ⇒ 不给这个键。给 0 会被读成「有任务板但没任务」，是假事实。
  assert.ok(!('taskCount' in team[0]), '拿不到任务板就不该给 taskCount');
});

// ---- 3) Team：不可用 ⇒ 空数组 + 原因，绝不编造 ------------------------------

test('★ projectTeam：官方包没装 ⇒ 空数组 + 原因，绝不编造成员', () => {
  const { team, teamError } = projectTeam(ctxWith({}), 's');
  assert.deepEqual(team, [], '没有 agentTeams 服务时必须给空数组');
  assert.equal(teamError, 'official-team-package-not-loaded', '必须说明为什么没有');
});

test('★ projectTeam：注册表不可用 ⇒ 空数组 + 原因，绝不编造成员', () => {
  const ctx = ctxWith({ teams: { listMembers: () => [{ id: 'ghost', name: 'ghost', role: 'lead', status: 'running' }] } });
  const { team, teamError } = projectTeam(ctx, 's');
  assert.deepEqual(team, [], '拿不到权威凭据时，宁可为空也不返回成员');
  assert.equal(teamError, 'agent-registry-unavailable');
});

test('★ projectTeam：服务没有 listMembers ⇒ 空数组 + 原因（不抛错）', () => {
  const ctx = ctxWith({ teams: {}, agents: agentsWith('s') });
  assert.doesNotThrow(() => projectTeam(ctx, 's'));
  assert.equal(projectTeam(ctx, 's').teamError, 'agentTeams-service-has-no-listMembers');
});

test('★ projectTeam：没有 sessionId ⇒ 空数组 + 原因（不猜会话）', () => {
  const ctx = ctxWith({ teams: { listMembers: () => [] }, agents: agentsWith('s') });
  assert.equal(projectTeam(ctx, null).teamError, 'no-session-id');
});

test('★ projectTeam：agents.get 抛错 ⇒ 空数组 + 原因（不把异常漏给 /status）', () => {
  const ctx = ctxWith({
    teams: { listMembers: () => [] },
    agents: { get: () => { throw new Error('registry boom'); }, list: () => [] },
  });
  assert.doesNotThrow(() => projectTeam(ctx, 's'));
  assert.ok(/^agent-lookup-threw: registry boom/.test(projectTeam(ctx, 's').teamError));
});

test('★ projectTeam：listMembers 返回非数组 ⇒ 空数组 + 原因', () => {
  const ctx = ctxWith({ teams: { listMembers: () => null, listTasks: () => [] }, agents: agentsWith('s') });
  assert.equal(projectTeam(ctx, 's').teamError, 'listMembers-returned-non-array');
});

// ---- 4) Team 任务板（官方 TeamView.tasks）---------------------------------

test('projectTasks：任务板原样透出官方字段（状态/归属/阻塞/写范围/就绪）', () => {
  const ctx = ctxWith({
    teams: {
      listMembers: () => [],
      listTasks: () => [
        { id: 't1', revision: 3, subject: '修 405', status: 'in_progress', ownerName: 'lead', blockedBy: ['t0'], writeScopes: ['lib/'], ready: false, writeScopeWarnings: ['与 t2 重叠'] },
        { id: 't2', revision: 1, subject: '写文档', status: 'pending', blockedBy: [], writeScopes: ['doc/'], ready: true },
      ],
    },
    agents: agentsWith('session-lead-1'),
  });
  const { tasks, tasksError } = projectTasks(ctx, 'session-lead-1');
  assert.equal(tasksError, null);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].status, 'in_progress');
  assert.deepEqual(tasks[0].blockedBy, ['t0']);
  assert.deepEqual(tasks[0].writeScopes, ['lib/']);
  assert.equal(tasks[0].ready, false);
  assert.deepEqual(tasks[0].writeScopeWarnings, ['与 t2 重叠']);
  // 没有归属/阻塞/告警的项不该凭空多出字段。
  assert.equal(tasks[1].ownerName, null);
  assert.deepEqual(tasks[1].blockedBy, []);
  assert.ok(!('writeScopeWarnings' in tasks[1]), '没有告警就不给这个键');
});

test('★ projectTasks：非 Team 成员 ⇒ 空数组 + 原因（不抛给 /status）', () => {
  const ctx = ctxWith({
    teams: { listMembers: () => [], listTasks: () => { throw new Error('TEAM_NOT_MEMBER'); } },
    agents: agentsWith('s'),
  });
  assert.doesNotThrow(() => projectTasks(ctx, 's'));
  assert.ok(/^not-a-team-member/.test(projectTasks(ctx, 's').tasksError));
});

// ---- 5) 子代理：权威源优先，回落投影 ---------------------------------------

test('★ projectSubAgents：优先用官方 subagents.listChildren 的**权威** activity', () => {
  const ctx = ctxWith({
    subagents: {
      listChildren: () => [
        { kind: 'child', id: 'sub-1', mode: 'one-shot', label: 'recon', activity: 'inactive', hasChildren: false },
        { kind: 'child', id: 'sub-2', mode: 'continuable', label: 'worker', activity: 'running', hasChildren: true },
      ],
    },
    // 投影故意给一份**不同**的数据：只要权威源可用，就不该读它。
    sessions: { get: () => ({ id: 'sess-1' }) },
    projections: { snapshot: () => ({ values: { subagentCatalog: [{ id: 'stale', mode: 'one-shot', label: 'stale' }] } }) },
  });
  const { subAgents, subAgentsError } = projectSubAgents(ctx, 'sess-1');
  assert.equal(subAgentsError, null);
  assert.deepEqual(subAgents.map((s) => s.name), ['recon', 'worker'], '权威源优先，不该回落到投影');
  assert.deepEqual(subAgents.map((s) => s.status), ['inactive', 'running'],
    'activity 必须原样透出——旧实现用 agents.list() 猜 running，会把已结束的显示成运行中');
  assert.equal(subAgents[1].hasChildren, true);
});

test('★ projectSubAgents：权威源不可用时回落投影，且**不给 status**（不猜）', () => {
  const entries = [
    { id: 'sub-1', createdAt: 100, mode: 'one-shot', label: 'recon' },
    { id: 'sub-2', createdAt: 200, mode: 'continuable', label: 'worker' },
  ];
  const ctx = ctxWith({
    // 没有 subagents 服务 ⇒ 走投影
    sessions: { get: (id) => (id === 'sess-1' ? { id: 'sess-1' } : undefined) },
    projections: { snapshot: () => ({ asOfSeq: 5, values: { subagentCatalog: entries } }) },
    // 旧实现就是拿这个列表猜 running 的；新实现**完全不该**用它。
    agents: agentsWith('sub-2'),
  });
  const { subAgents, subAgentsError } = projectSubAgents(ctx, 'sess-1');
  assert.equal(subAgentsError, null);
  assert.equal(subAgents.length, 2);
  assert.deepEqual(subAgents.map((s) => s.name), ['recon', 'worker']);
  assert.deepEqual(subAgents.map((s) => s.mode), ['one-shot', 'continuable']);
  // 目录条目不含运行时状态 ⇒ **两个都不给 status**，由前端显示「未知」。
  // 旧实现会给 sub-2 一个 running —— 那是桥在替官方断言，属于编造状态。
  assert.ok(!('status' in subAgents[0]) && !('status' in subAgents[1]),
    '投影路径不得推断运行时状态');
});

test('★ projectSubAgents：listChildren 抛错时回落投影，不是直接报错', () => {
  const ctx = ctxWith({
    subagents: { listChildren: () => { throw new Error('SubagentError: parent session not found'); } },
    sessions: { get: () => ({ id: 'sess-1' }) },
    projections: { snapshot: () => ({ values: { subagentCatalog: [{ id: 'a', mode: 'one-shot', label: 'x' }] } }) },
  });
  const { subAgents, subAgentsError } = projectSubAgents(ctx, 'sess-1');
  assert.equal(subAgentsError, null, '权威源抛错是正常降级，不该把整个分区判死：' + subAgentsError);
  assert.equal(subAgents.length, 1);
});

test('★ projectSubAgents：投影未注册 ⇒ 空数组 + 原因，绝不编造子代理', () => {
  const ctx = ctxWith({
    sessions: { get: () => ({ id: 'sess-1' }) },
    projections: { snapshot: () => ({ asOfSeq: 0, values: {} }) },
  });
  const { subAgents, subAgentsError } = projectSubAgents(ctx, 'sess-1');
  assert.deepEqual(subAgents, []);
  assert.equal(subAgentsError, 'subagent-catalog-not-registered');
});

test('★ projectSubAgents：没有 sessionId ⇒ 空数组 + 原因（不猜会话）', () => {
  const ctx = ctxWith({ sessions: { get: () => ({}) }, projections: { snapshot: () => ({ values: {} }) } });
  assert.equal(projectSubAgents(ctx, null).subAgentsError, 'no-session-id');
});

test('★ projectSubAgents：会话不存在 ⇒ 空数组 + 原因', () => {
  const ctx = ctxWith({ sessions: { get: () => undefined }, projections: { snapshot: () => ({ values: {} }) } });
  assert.equal(projectSubAgents(ctx, 'ghost-session').subAgentsError, 'session-not-found');
});

test('★ projectSubAgents：snapshot 抛错 ⇒ 空数组 + 原因，不把异常漏给 /status', () => {
  const ctx = ctxWith({
    sessions: { get: () => ({ id: 's' }) },
    projections: { snapshot: () => { throw new Error('boom'); } },
  });
  assert.doesNotThrow(() => projectSubAgents(ctx, 's'));
  assert.ok(/^snapshot-failed: boom/.test(projectSubAgents(ctx, 's').subAgentsError));
});

// ---- 6) 分区独立降级 -------------------------------------------------------

test('★ projectRoster：Team 侧挂了不连坐子代理侧', () => {
  const ctx = ctxWith({
    // 没有 agentTeams（Team 侧不可用）
    sessions: { get: () => ({ id: 's' }) },
    projections: { snapshot: () => ({ values: { subagentCatalog: [{ id: 'x', createdAt: 1, mode: 'one-shot', label: 'w' }] } }) },
  });
  const r = projectRoster(ctx, 's');
  assert.deepEqual(r.team, [], 'Team 侧为空');
  assert.ok(r.teamError, 'Team 侧必须带原因');
  assert.equal(r.subAgents.length, 1, '子代理侧不受影响');
  assert.equal(r.subAgentsError, null);
});

test('★ projectRoster：子代理侧挂了不连坐 Team 侧', () => {
  const ctx = ctxWith({
    teams: { listMembers: () => [{ id: 'a', name: 'lead', role: 'lead', status: 'running' }], listTasks: () => [] },
    agents: agentsWith('s'),
    // 没有 sessionProjections（子代理侧不可用）
  });
  const r = projectRoster(ctx, 's');
  assert.equal(r.team.length, 1, 'Team 侧不受影响');
  assert.equal(r.teamError, null);
  assert.deepEqual(r.subAgents, []);
  assert.equal(r.subAgentsError, 'session-projections-unavailable');
});

test('★ projectRoster：四个分区键齐全，且 members 是 team 的同值别名', () => {
  const r = projectRoster(ctxWith({}), 's');
  // 0.15.12 追加 `graph`（图诊断：就绪集/阻塞点/关键路径/结构问题）。
  // 它**不是**第五个分区——分区仍是四个（team/subAgents/tasks 各带一个 *Error），
  // graph 是 tasks 的补充视角，服务端算不出来时为 null 而不是缺席。
  assert.deepEqual(Object.keys(r).sort(),
    ['graph', 'members', 'membersError', 'subAgents', 'subAgentsError', 'tasks', 'tasksError', 'team', 'teamError']);
  assert.equal(r.graph, null, '读不到任务板时不得凭空造一张图');
  assert.ok(Array.isArray(r.team) && Array.isArray(r.subAgents) && Array.isArray(r.tasks) && Array.isArray(r.members));
  assert.ok(r.teamError && r.subAgentsError && r.tasksError, '三个分区都要说明原因');
  // 官方 TeamView 的词是 members，0.15.0 起本项目叫 team —— 两个名字同值，
  // 任何一端改名都不会让另一端读到 undefined。
  assert.deepEqual(r.members, r.team);
});

test('projectRoster 从不抛错：畸形 ctx 也只是空数组 + 原因', () => {
  for (const bad of [null, undefined, {}, { get: () => { throw new Error('nope'); } }]) {
    assert.doesNotThrow(() => projectRoster(bad, 's'), 'ctx=' + JSON.stringify(bad));
    const r = projectRoster(bad, 's');
    assert.deepEqual(r.team, []);
    assert.deepEqual(r.subAgents, []);
    assert.deepEqual(r.tasks, []);
  }
});

// ---- 7) 反向验证：证明上面的判据抓得住旧实现 --------------------------------

test('★ 反向验证：源码里不得再出现「挨个试 agents.list() 挑凭据」的旧写法', () => {
  // 这条不是「grep 某个名字」，而是钉住**唯一**的凭据来源：
  // 源码中必须出现 `agentsGet(String(sessionId))` 形态的取法，且不得出现
  // 「遍历 agents.list() 逐个尝试」的循环（那正是读到别人 lead 的那条路）。
  const src = readFileSync(path.resolve(here, '../lib/roster.js'), 'utf8');
  assert.ok(/agentsGet\(String\(sessionId\)\)/.test(src),
    'projectTeam/projectTasks 必须用 agents.get(sessionId) 取权威凭据');
  assert.ok(!/for\s*\(\s*const\s+\w+\s+of\s+agents\.list\(\)/.test(src),
    '不得再遍历 agents.list() 挑凭据——官方 tryMembership 对任何顶层会话都返回 lead 且不抛错，'
    + '那条路会读到别的会话的 lead（0.15.3 真机缺陷）');
  // 绑定这一步也不能丢：丢了会静默降级成「读不到」。
  assert.ok(/fn\.bind\(thisArg\)/.test(src), 'bindMethod 的 this 绑定不能丢');
});