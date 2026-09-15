// roster.test.mjs — 花名册投影的护栏（0.15.0）。
//
// ## 为什么这个文件必须存在
//
// 0.14.9 的面板消费 `/__webcode/status.subAgents` 与 `.team`，而这两个字段在
// 服务端是**写死的空数组**——面板写得再漂亮也永远显示「当前没有正在运行的
// 子代理或 Team 成员」。这次把它们接上真实数据源（lib/roster.js），于是
// 「接的是真的」这件事必须由护栏钉住，否则下次一次重构就能悄悄退回占位值。
//
// 三条纪律各有一组断言：
//   1. **真实读取**：有官方服务在时，成员必须真的读出来（含 role/status）；
//   2. **不可用 ⇒ 空数组，绝不编造样本**（这是 todo 明确点名要新增的负向断言）。
//      官方包没装 / 服务没注册 / 凭据解析失败，一律空数组 + 非空 *Error，
//      绝不能凭空造出「运行中」的成员；
//   3. **两个分区独立降级**：Team 侧挂了不能连坐子代理侧，反之亦然。
//
// 桩对象刻意做成最小形状（只有本模块真正调用的方法），而不是完整实现——
// 完整桩会掩盖「代码其实依赖了某个没声明的成员」这种漂移。

import test from 'node:test';
import assert from 'node:assert/strict';
import { projectTeam, projectSubAgents, projectRoster } from '../lib/roster.js';

/**
 * 造一个最小 cordis 上下文桩。
 * 只提供本模块会碰的两条取法：属性直取与 ctx.get()。
 */
function ctxWith({ teams = undefined, agents = undefined, sessions = undefined, projections = undefined } = {}) {
  const services = { agentTeams: teams, agents, sessions, sessionProjections: projections };
  const ctx = {};
  for (const [k, v] of Object.entries(services)) if (v !== undefined) ctx[k] = v;
  // ctx.get() 是官方另一条取法（lib/index.js 取 webServer 时两条都试）。
  ctx.get = (name) => services[name];
  return ctx;
}

const LEAD = { id: 'session-lead-1' };

// ---- 1) 真实读取：有服务时成员必须读出来 --------------------------------

test('projectTeam：从官方 agentTeams 服务读出真实成员（含 role/status）', () => {
  const members = [
    { id: 'session-lead-1', name: 'lead', role: 'lead', status: 'running', diagnostics: [] },
    { id: 'session-rev-1', name: 'reviewer', role: 'teammate', status: 'idle', diagnostics: [] },
  ];
  const ctx = ctxWith({
    teams: { listMembers: () => members, listTasks: () => [] },
    agents: { list: () => [LEAD] },
  });
  const { team, teamError } = projectTeam(ctx);
  assert.equal(teamError, null, '真实服务可用时不该报错');
  assert.equal(team.length, 2, '两个成员必须都读出来');
  assert.deepEqual(team.map((m) => m.name), ['lead', 'reviewer']);
  assert.deepEqual(team.map((m) => m.role), ['lead', 'teammate']);
  assert.deepEqual(team.map((m) => m.status), ['running', 'idle']);
  // 任务板归属：有 listTasks 时给出计数（面板显示「任务 N」）。
  assert.deepEqual(team.map((m) => m.taskCount), [0, 0]);
});

test('projectTeam：taskCount 只在真的能读到任务板时才出现（不是 0 占位）', () => {
  const ctx = ctxWith({
    teams: { listMembers: () => [{ id: 'a', name: 'a', role: 'teammate', status: 'idle' }] },
    agents: { list: () => [LEAD] },
  });
  const { team } = projectTeam(ctx);
  assert.equal(team.length, 1);
  // 没有 listTasks ⇒ 不给这个键。给 0 会被读成「有任务板但没任务」，是假事实。
  assert.ok(!('taskCount' in team[0]), '拿不到任务板就不该给 taskCount');
});

test('projectTeam：逐个 agent 试凭据，非 Team 成员抛错不该掩盖后面的成员', () => {
  const seen = [];
  const ctx = ctxWith({
    teams: {
      listMembers: (agent) => {
        seen.push(agent.id);
        if (agent.id === 'not-a-team-member') throw new Error('not a team member');
        return [{ id: 'ok', name: 'lead', role: 'lead', status: 'running' }];
      },
      listTasks: () => [],
    },
    agents: { list: () => [{ id: 'not-a-team-member' }, { id: 'is-a-team-member' }] },
  });
  const { team, teamError } = projectTeam(ctx);
  assert.equal(teamError, null);
  assert.equal(team.length, 1);
  assert.deepEqual(seen, ['not-a-team-member', 'is-a-team-member'], '必须继续试下一个 agent');
});

test('projectTeam：ctx.get() 那条取法也要能用', () => {
  const ctx = { get: (n) => (n === 'agentTeams' ? { listMembers: () => [{ id: 'a', name: 'n', role: 'lead', status: 'idle' }], listTasks: () => [] } : n === 'agents' ? { list: () => [LEAD] } : undefined) };
  const { team, teamError } = projectTeam(ctx);
  assert.equal(teamError, null, '属性直取拿不到时，ctx.get 必须兜住');
  assert.equal(team.length, 1);
});

// ---- 2) 不可用 ⇒ 空数组 + 原因，绝不编造样本（负向断言）------------------

test('★ projectTeam：官方包没装 ⇒ 空数组 + 原因，绝不编造成员', () => {
  const { team, teamError } = projectTeam(ctxWith({}));
  assert.deepEqual(team, [], '没有 agentTeams 服务时必须给空数组');
  assert.equal(teamError, 'official-team-package-not-loaded', '必须说明为什么没有');
});

test('★ projectTeam：注册表不可用 ⇒ 空数组 + 原因，绝不编造成员', () => {
  const ctx = ctxWith({ teams: { listMembers: () => [{ id: 'ghost', name: 'ghost', role: 'lead', status: 'running' }] } });
  const { team, teamError } = projectTeam(ctx);
  assert.deepEqual(team, [], '拿不到权威凭据时，宁可为空也不返回成员');
  assert.equal(teamError, 'agent-registry-unavailable');
});

test('★ projectTeam：谁都解析不出 Team 身份 ⇒ 空数组 + 原因', () => {
  const ctx = ctxWith({
    teams: { listMembers: () => { throw new Error('not a team member'); }, listTasks: () => [] },
    agents: { list: () => [LEAD] },
  });
  const { team, teamError } = projectTeam(ctx);
  assert.deepEqual(team, []);
  assert.ok(/^no-team-member-authority/.test(teamError), '必须带上原因，实际：' + teamError);
});

test('★ projectTeam：服务没有 listMembers ⇒ 空数组 + 原因（不抛错）', () => {
  const ctx = ctxWith({ teams: {}, agents: { list: () => [LEAD] } });
  assert.doesNotThrow(() => projectTeam(ctx));
  const { team, teamError } = projectTeam(ctx);
  assert.deepEqual(team, []);
  assert.equal(teamError, 'agentTeams-service-has-no-listMembers');
});

// ---- 3) 子代理分区 --------------------------------------------------------

test('projectSubAgents：从会话的 subagentCatalog 投影读出子代理', () => {
  const entries = [
    { id: 'sub-1', createdAt: 100, mode: 'one-shot', label: 'recon' },
    { id: 'sub-2', createdAt: 200, mode: 'continuable', label: 'worker' },
  ];
  const ctx = ctxWith({
    sessions: { get: (id) => (id === 'sess-1' ? { id: 'sess-1' } : undefined) },
    projections: { snapshot: () => ({ asOfSeq: 5, values: { subagentCatalog: entries } }) },
    agents: { list: () => [{ id: 'sub-2' }] },
  });
  const { subAgents, subAgentsError } = projectSubAgents(ctx, 'sess-1');
  assert.equal(subAgentsError, null);
  assert.equal(subAgents.length, 2);
  assert.deepEqual(subAgents.map((s) => s.name), ['recon', 'worker']);
  assert.deepEqual(subAgents.map((s) => s.mode), ['one-shot', 'continuable']);
  // 只有还在 agent 注册表里的那一个才谈得上「在跑」；另一个**不给** status，
  // 由前端显示「未知」——目录条目本身不含运行时状态，不能替它断言。
  assert.equal(subAgents[1].status, 'running');
  assert.ok(!('status' in subAgents[0]), '不在注册表里的子代理不该被断言成任何状态');
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
  const { subAgents, subAgentsError } = projectSubAgents(ctx, null);
  assert.deepEqual(subAgents, []);
  assert.equal(subAgentsError, 'no-session-id');
});

test('★ projectSubAgents：会话不存在 ⇒ 空数组 + 原因', () => {
  const ctx = ctxWith({ sessions: { get: () => undefined }, projections: { snapshot: () => ({ values: {} }) } });
  const { subAgents, subAgentsError } = projectSubAgents(ctx, 'ghost-session');
  assert.deepEqual(subAgents, []);
  assert.equal(subAgentsError, 'session-not-found');
});

test('★ projectSubAgents：snapshot 抛错 ⇒ 空数组 + 原因，不把异常漏给 /status', () => {
  const ctx = ctxWith({
    sessions: { get: () => ({ id: 's' }) },
    projections: { snapshot: () => { throw new Error('boom'); } },
  });
  assert.doesNotThrow(() => projectSubAgents(ctx, 's'));
  const { subAgents, subAgentsError } = projectSubAgents(ctx, 's');
  assert.deepEqual(subAgents, []);
  assert.ok(/^snapshot-failed: boom/.test(subAgentsError), subAgentsError);
});

// ---- 4) 两个分区独立降级 --------------------------------------------------

test('★ projectRoster：Team 侧挂了不连坐子代理侧', () => {
  const ctx = ctxWith({
    // 没有 agentTeams（Team 侧不可用）
    sessions: { get: () => ({ id: 's' }) },
    projections: { snapshot: () => ({ values: { subagentCatalog: [{ id: 'x', createdAt: 1, mode: 'one-shot', label: 'w' }] } }) },
    agents: { list: () => [] },
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
    agents: { list: () => [LEAD] },
    // 没有 sessionProjections（子代理侧不可用）
  });
  const r = projectRoster(ctx, 's');
  assert.equal(r.team.length, 1, 'Team 侧不受影响');
  assert.equal(r.teamError, null);
  assert.deepEqual(r.subAgents, []);
  assert.equal(r.subAgentsError, 'session-projections-unavailable');
});

test('★ projectRoster：整块不可用时仍返回四个键，且形状可被前端消费', () => {
  const r = projectRoster(ctxWith({}), 's');
  assert.deepEqual(Object.keys(r).sort(), ['subAgents', 'subAgentsError', 'team', 'teamError']);
  assert.ok(Array.isArray(r.team) && Array.isArray(r.subAgents));
  assert.ok(r.teamError && r.subAgentsError, '两个分区都要说明原因');
});

test('projectRoster 从不抛错：畸形 ctx 也只是空数组 + 原因', () => {
  for (const bad of [null, undefined, {}, { get: () => { throw new Error('nope'); } }]) {
    assert.doesNotThrow(() => projectRoster(bad, 's'), 'ctx=' + JSON.stringify(bad));
    const r = projectRoster(bad, 's');
    assert.deepEqual(r.team, []);
    assert.deepEqual(r.subAgents, []);
  }
});