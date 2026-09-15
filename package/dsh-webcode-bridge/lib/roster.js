// roster.js — 真实花名册投影：把「谁在跑」变成可从服务端读取的事实。
//
// ## 为什么需要这个文件（0.15.0，取代此前的恒空数组）
//
// 0.14.9 的 `AgentRoster` 面板（lib/client.cjs）早就写好了，但它消费的
// `/__webcode/status.subAgents` 与 `.team` 从上线起就是**写死的空数组**——
// 当时的理由是「桥尚未消费官方 agentTeams Remote，给空数组 = 如实说没有」。
// 诚实，但用户看到的花名册永远是「当前没有正在运行的子代理或 Team 成员」，
// 面板等于不存在。本条把它接上真实数据源。
//
// ## 数据来源（全部是官方公开 API，不猜、不编造）
//
// 1. **Team 成员**：官方 `@deepseek-ai/dsh-experimental-agent-team` 把
//    `agentTeams` 注册为 cordis 服务（`lib/index.js` 的 `super(ctx, "agentTeams")`），
//    其公开方法是 `listMembers(agent)` / `listTasks(agent)`（`remoteView` 只是
//    给 Remote 层用的包装，内部就调这两个）。`listMembers` 需要**一个活着的
//    Team 成员**当权威凭据，返回含 `role`（lead|teammate）、`status`
//    （running|idle|inactive|provisioning|failed）的 `TeamMemberView[]`。
//    凭据从 `ctx.agents.list()` 里挑第一个能通过 `roster.tryMembership` 的 agent；
//    没有任何成员是 Team 成员时返回空数组——这正是「没在跑 Team」的如实回答。
//
// 2. **子代理**：官方 `@deepseek-ai/dsh-subagent` 的 `subagentCatalog` 投影
//    （`lib/types/catalog.d.ts`）由**父会话**持久化它的直接子代理目录：
//    每条是 `{ id, createdAt, mode: 'one-shot'|'continuable', label? }`。它不是
//    运行时状态而是**发现事实**，所以这里只声明「它是谁、什么时候建的、
//    一次性还是可持续」——**不**声明 running/idle。运行时状态需要 agent 注册表里
//    还有这个 id；拿不到就不写状态词，让前端按「未知」如实显示（空 status ⇒
//    `stateOf()` 回落到 `x.status || x.state || ''` ⇒ 显示「未知」）。
//    这一条是刻意的：编造「运行中」比不显示更坏。
//
// ## 为什么不做成「一个带 type 的数组」
//
// 两者的信息结构本来就不同（子代理从属于发起它的会话，Team 成员平级、带角色
// 与任务板归属），前端要按不同缩进与分组渲染（doc/research/agent-ui-design-
// references.md §4.5）。合成一个数组会把「谁从属于谁」这个结构丢掉。
//
// ## 明确的边界
//
// - **只读**。本模块不创建、不中断、不改任何 Team 状态；`listTasks` 的写侧
//   （createTask/updateTask）不在这里调用。
// - **不可用时给空数组，不抛错**。官方包没装、服务没注册、凭据解析失败——
//   一律回落空数组并**在返回值里带上原因**（`teamError` / `subAgentsError`），
//   面板因此能说「为什么没有数据」，而不是让用户以为是「确实没有成员在跑」。
//   这是本项目一贯的「不造假状态」纪律（同账户头像的三态环）。

/**
 * 从 cordis 上下文里取一个服务，容忍两种取法。
 *
 * 两种都要试是有真机依据的：`lib/index.js` 里取 `webServer` 时就是
 * `ctx.webServer` 与 `ctx.get('webServer')` 两条路都试（见该文件里那段注释
 * 「Service instances as context properties」）。cordis 版本差异下哪个可用
 * 并不稳定，而这里失败一次的代价是花名册整块消失，不值得赌。
 *
 * @param {object} ctx cordis 上下文
 * @param {string} name 服务名
 * @returns {object|null} 服务实例，或 null
 */
function serviceOf(ctx, name) {
  if (!ctx) return null;
  for (const attempt of [() => ctx[name], () => ctx.get?.(name)]) {
    try {
      const svc = attempt();
      if (svc && typeof svc === 'object') return svc;
    } catch { /* 未声明 inject 时取属性会抛——按「没有」处理 */ }
  }
  return null;
}

/**
 * Team 成员的真实投影。
 *
 * @param {object} ctx cordis 上下文
 * @returns {{team: object[], teamError: string|null}} 成员行与不可用原因
 */
export function projectTeam(ctx) {
  const svc = serviceOf(ctx, 'agentTeams');
  if (!svc) return { team: [], teamError: 'official-team-package-not-loaded' };
  if (typeof svc.listMembers !== 'function') {
    return { team: [], teamError: 'agentTeams-service-has-no-listMembers' };
  }
  const agents = serviceOf(ctx, 'agents');
  if (!agents || typeof agents.list !== 'function') {
    return { team: [], teamError: 'agent-registry-unavailable' };
  }
  // listMembers 要一个**活着的 Team 成员**当权威凭据。挨个试：Team 里任何一个
  // 成员（lead 或 teammate）都有权读花名册，所以第一个成功的就行。
  // 不缓存结果——成员可能在两次轮询之间被创建或停止，缓存会让面板显示幽灵成员。
  let lastError = null;
  for (const agent of agents.list()) {
    try {
      const members = svc.listMembers(agent);
      if (!Array.isArray(members)) continue;
      return {
        team: members.map((m) => ({
          id: String(m?.id || ''),
          name: String(m?.name || ''),
          // 官方给的就是这两个角色词，原样透出，不在桥里另造一套。
          role: String(m?.role || ''),
          status: String(m?.status || ''),
          // 任务板归属是 Team 成员「平级」的具体体现（面板按它显示「任务 N」）。
          // 拿不到任务板时不给这个键，而不是给 0——0 会被读成「有任务板但没任务」。
          ...(Array.isArray(svc.listTasks?.(agent))
            ? { taskCount: svc.listTasks(agent).length }
            : {}),
        })),
        teamError: null,
      };
    } catch (e) {
      // 「这个 agent 不是 Team 成员」是**正常**情况（绝大多数会话都是），
      // 不能让它的异常盖住真正的原因。记下来，继续试下一个。
      lastError = e?.message || String(e);
    }
  }
  return {
    team: [],
    teamError: lastError ? `no-team-member-authority: ${String(lastError).slice(0, 160)}` : 'no-team-member-authority',
  };
}

/**
 * 子代理的真实投影（来自父会话的 `subagentCatalog` 持久化投影）。
 *
 * @param {object} ctx cordis 上下文
 * @param {string|null} sessionId 当前会话 id（子代理目录挂在它自己的会话上）
 * @returns {{subAgents: object[], subAgentsError: string|null}}
 */
export function projectSubAgents(ctx, sessionId) {
  const projections = serviceOf(ctx, 'sessionProjections');
  if (!projections) return { subAgents: [], subAgentsError: 'session-projections-unavailable' };
  const sessions = serviceOf(ctx, 'sessions');
  if (!sessions || typeof sessions.get !== 'function') {
    return { subAgents: [], subAgentsError: 'session-store-unavailable' };
  }
  if (!sessionId) return { subAgents: [], subAgentsError: 'no-session-id' };
  const session = sessions.get(String(sessionId));
  if (!session) return { subAgents: [], subAgentsError: 'session-not-found' };
  let snapshot;
  try {
    // 只请求自己需要的那一个 unit。投影注册表对未注册的 key 会跳过，因此
    // 「官方 subagent 包没装」在这里表现为 values 里没有这个键，而不是抛错。
    snapshot = projections.snapshot(session, ['subagentCatalog']);
  } catch (e) {
    return { subAgents: [], subAgentsError: `snapshot-failed: ${String(e?.message || e).slice(0, 160)}` };
  }
  const entries = snapshot?.values?.subagentCatalog;
  if (!Array.isArray(entries)) return { subAgents: [], subAgentsError: 'subagent-catalog-not-registered' };
  const agents = serviceOf(ctx, 'agents');
  const liveIds = new Set(
    (agents && typeof agents.list === 'function' ? agents.list() : [])
      .map((a) => String(a?.id || ''))
      .filter(Boolean),
  );
  return {
    subAgents: entries.map((e) => ({
      id: String(e?.id || ''),
      // label 是官方在创建子代理时冻结的标签；one-shot 模式可能没有 label，
      // 此时回落空串，由前端显示「（未命名）」而不是桥来编一个名字。
      name: String(e?.label || ''),
      // **只在这一条为真时才给 status**：目录条目本身不含运行时状态，
      // 只有当子代理的 agent 还在注册表里活着，才谈得上「在跑」。
      // 不在就整个键不给 → 前端显示「未知」，而不是被桥断言成「已停止」。
      ...(liveIds.has(String(e?.id || '')) ? { status: 'running' } : {}),
      mode: String(e?.mode || ''),
      createdAt: Number(e?.createdAt) || null,
    })),
    subAgentsError: null,
  };
}

/**
 * 一次读全花名册的两个分区。
 *
 * 两个分区各自独立降级：Team 侧失败不该让子代理侧也消失，反之亦然。
 * 返回值固定含 `team` / `subAgents` 两个数组（不可用时为空数组），
 * 外加两个 `*Error` 字段说明原因——面板据此区分「确实没有」与「读不到」。
 *
 * @param {object} ctx cordis 上下文
 * @param {string|null} sessionId 当前会话 id
 * @returns {{team: object[], subAgents: object[], teamError: string|null, subAgentsError: string|null}}
 */
export function projectRoster(ctx, sessionId) {
  let team = { team: [], teamError: null };
  let sub = { subAgents: [], subAgentsError: null };
  try { team = projectTeam(ctx); } catch (e) {
    team = { team: [], teamError: `team-projection-threw: ${String(e?.message || e).slice(0, 160)}` };
  }
  try { sub = projectSubAgents(ctx, sessionId); } catch (e) {
    sub = { subAgents: [], subAgentsError: `subagent-projection-threw: ${String(e?.message || e).slice(0, 160)}` };
  }
  return {
    team: team.team,
    subAgents: sub.subAgents,
    teamError: team.teamError ?? null,
    subAgentsError: sub.subAgentsError ?? null,
  };
}