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
//    其公开方法是 `listMembers(agent)` / `listTasks(agent)` / `createTask` /
//    `updateTask` / `sendMessage` / `spawnTeammate`（同一文件 1731-1800 行）。
//    `listMembers` 的文档原话是「List the runtime-enriched roster visible to
//    one Team member」，参数是**一个活着的 Team 成员**当权威凭据。
//
// 2. **子代理**：官方 `@deepseek-ai/dsh-subagent` 的 `subagentCatalog` 投影
//    （`lib/index.js` 里的 `subagentCatalogProjectionDefinition`）由**父会话**
//    持久化它的直接子代理目录：每条是 `{ id, createdAt, mode, label? }`。
//    它是**发现事实**而非运行时状态，所以运行时状态另取权威源（见下一条）。
//
// ## 0.15.4 修掉的两个语义缺陷（真机 + 官方源码双重证据）
//
// ### 缺陷 A：「挑第一个能通过 listMembers 的 agent」会读到**别人的** lead
//
// 旧实现挨个试 `agents.list()` 里的 agent，谁不抛错就用谁。官方
// `tryMembership`（dsh-experimental-agent-team/lib/index.js:397-430）对
// **任何没有 subagentDescriptor 的顶层 Agent** 都返回
// `{ role: 'lead', name: 'lead' }` 而**不抛错**（:412-417 与 :421-426 两条出口），
// `list(membership)` 还无条件先插一行 lead 伪行（:439-446）。官方 README 也明文
// 「每个普通顶层会话都是隐式 Team 的 Lead」。
//
// 于是旧实现读到的是「进程里**第一个**顶层 agent 自己的 lead 伪行」——与用户
// 正在看的会话无关。活进程实证：换两个不同 `sessionId` 查询 `/__webcode/status`，
// `team` 段**逐字相同**（都是同一个别的会话的 lead）。
//
// 修法：**只用当前会话自己**当凭据（`agents.get(sessionId)`）。它就是那个
// 「隐式 Team 的 Lead」，语义唯一且与面板显示的对象一致。拿不到就如实说
// `caller-not-live`，绝不用别的 agent 顶替。
//
// ### 缺陷 B：把 Team 总任务数当成「每个成员的任务数」
//
// 旧实现对每个成员都调 `listTasks(agent).length` —— 那个数是**整个任务板**的
// 条数，对每个成员都一样；还同一 agent 调了两次。现在按官方任务视图的
// `ownerName` 归属（`TeamTaskView.ownerName`，types.d.ts），并整表读一次。
//
// ### 顺带：Team 的「成员」与「任务板」拆成两个字段
//
// 官方 `remoteView` 返回的是 `{ members, tasks }`（types.d.ts 的 `TeamView`）——
// 任务板是**团队级**的，不是某个成员的属性。面板要能显示「待办 / 进行中 /
// 被谁卡住 / 写哪些文件」，否则「Team 成员平级」这句话只剩一个名字。
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
 * 绑定一个方法到它的宿主对象，拿不到就返回 null。
 *
 * **为什么必须绑定**：官方服务（`agentTeams` / `subagents` / `sessionProjections`）
 * 都是 class 实例，其公开方法里用 `this.roster` / `this.tasks` / `this.ctx`。
 * 这里取到的是**解引用后的函数**，直接调用会让 `this` 变成 undefined 并抛
 * TypeError —— 而我们的 try/catch 会把它降级成一句「读不到」，症状与
 * 「官方包没装」完全一样。绑定这一步看着多余，实际是这条链路上最容易被
 * 静默吞掉的一环。
 *
 * @template T
 * @param {Function|null|undefined} fn 候选方法
 * @param {object|null} thisArg 宿主
 * @returns {Function|null} 已绑定的函数，或 null
 */
function bindMethod(fn, thisArg) {
  if (typeof fn !== 'function') return null;
  try {
    return fn.bind(thisArg);
  } catch {
    return null;
  }
}

/**
 * Team 成员的**平级**投影（官方 `listMembers` 语义）。
 *
 * 与旧实现的唯一区别：凭据是**当前会话自己**，不是「列表里第一个不抛错的」。
 *
 * @param {object} ctx cordis 上下文
 * @param {string|null} sessionId 当前会话 id（它就是隐式 Team 的 Lead）
 * @returns {{team: object[], teamError: string|null}} 成员行与不可用原因
 */
export function projectTeam(ctx, sessionId) {
  const svc = serviceOf(ctx, 'agentTeams');
  if (!svc) return { team: [], teamError: 'official-team-package-not-loaded' };
  const listMembers = bindMethod(svc.listMembers, svc);
  if (!listMembers) {
    return { team: [], teamError: 'agentTeams-service-has-no-listMembers' };
  }
  if (!sessionId) return { team: [], teamError: 'no-session-id' };
  const agents = serviceOf(ctx, 'agents');
  const agentsGet = bindMethod(agents?.get, agents);
  if (!agentsGet) return { team: [], teamError: 'agent-registry-unavailable' };

  // 权威凭据 = 当前会话自己。官方 tryMembership 对普通顶层会话返回
  // { role: 'lead', name: 'lead' }，所以这条路径在「没在用 Team」时也会
  // 成功返回一行 lead —— 那是**如实的**（官方 README：每个普通顶层会话都是
  // 隐式 Team 的 Lead），不是伪造。
  let caller;
  try {
    caller = agentsGet(String(sessionId));
  } catch (e) {
    return { team: [], teamError: `agent-lookup-threw: ${String(e?.message || e).slice(0, 160)}` };
  }
  if (!caller) {
    // 会话不在注册表里（已结束 / 还没起来）——**不许**拿别的 agent 顶替，
    // 那正是 0.15.3 那个「读别人的 lead」的 bug。
    return { team: [], teamError: 'caller-not-live' };
  }

  let members;
  try {
    members = listMembers(caller);
  } catch (e) {
    // 官方对非成员抛 `TEAM_NOT_MEMBER`。这是**正常**情况（当前会话不属于
    // 任何活跃 Team），如实带原因。
    return { team: [], teamError: `not-a-team-member: ${String(e?.message || e).slice(0, 160)}` };
  }
  if (!Array.isArray(members)) return { team: [], teamError: 'listMembers-returned-non-array' };

  // 任务板是**团队级**的：整表读一次，按 ownerName 归属到成员行。
  // 旧实现对每个成员调一次 listTasks().length —— 那个数是全表条数，
  // 每个成员都一样，读起来像「这个成员有几个任务」，是**假事实**。
  const listTasks = bindMethod(svc.listTasks, svc);
  let tasks = null;
  if (listTasks) {
    try {
      const t = listTasks(caller);
      if (Array.isArray(t)) tasks = t;
    } catch { /* 拿不到任务板就不给 taskCount，也不让成员列表消失 */ }
  }

  return {
    team: members.map((m) => {
      const name = String(m?.name || '');
      const owned = tasks ? tasks.filter((t) => String(t?.ownerName || '') === name && name) : null;
      return {
        id: String(m?.id || ''),
        name,
        // 官方给的就是这两个角色词，原样透出，不在桥里另造一套。
        role: String(m?.role || ''),
        status: String(m?.status || ''),
        // 成员的模型与上下文模式（官方 TeamMemberView 有）：面板据此显示
        // 「谁跑在哪个模型上」，这是 Team 与子代理最直观的差别之一。
        ...(m?.model ? { model: String(m.model) } : {}),
        ...(m?.context ? { context: String(m.context) } : {}),
        // 任务板归属：**只统计归到这个成员名下的**任务。拿不到任务板时
        // 不给这个键，而不是给 0——0 会被读成「有任务板但没任务」。
        ...(owned ? { taskCount: owned.length } : {}),
      };
    }),
    teamError: null,
  };
}

/**
 * Team 任务板的只读投影（官方 `listTasks` → `TeamTaskView[]`）。
 *
 * 「Team 成员平级」这句话如果只显示名字，用户看不出他们**在协作什么**。
 * 任务板是团队级事实：状态、被谁卡住（blockedBy）、写哪些文件（writeScopes）、
 * 是否就绪（ready）——全部原样透出，桥不重新解释。
 *
 * @param {object} ctx cordis 上下文
 * @param {string|null} sessionId 当前会话 id
 * @returns {{tasks: object[], tasksError: string|null}}
 */
export function projectTasks(ctx, sessionId) {
  const svc = serviceOf(ctx, 'agentTeams');
  if (!svc) return { tasks: [], tasksError: 'official-team-package-not-loaded' };
  const listTasks = bindMethod(svc.listTasks, svc);
  if (!listTasks) return { tasks: [], tasksError: 'agentTeams-service-has-no-listTasks' };
  if (!sessionId) return { tasks: [], tasksError: 'no-session-id' };
  const agents = serviceOf(ctx, 'agents');
  const agentsGet = bindMethod(agents?.get, agents);
  if (!agentsGet) return { tasks: [], tasksError: 'agent-registry-unavailable' };
  let caller;
  try {
    caller = agentsGet(String(sessionId));
  } catch (e) {
    return { tasks: [], tasksError: `agent-lookup-threw: ${String(e?.message || e).slice(0, 160)}` };
  }
  if (!caller) return { tasks: [], tasksError: 'caller-not-live' };
  try {
    const rows = listTasks(caller);
    if (!Array.isArray(rows)) return { tasks: [], tasksError: 'listTasks-returned-non-array' };
    return {
      tasks: rows.map((t) => ({
        id: String(t?.id || ''),
        revision: Number(t?.revision) || 0,
        subject: String(t?.subject || ''),
        // 官方状态机：pending | in_progress | completed | deleted（types.d.ts）。
        status: String(t?.status || ''),
        ownerName: t?.ownerName ? String(t.ownerName) : null,
        blockedBy: Array.isArray(t?.blockedBy) ? t.blockedBy.map(String) : [],
        writeScopes: Array.isArray(t?.writeScopes) ? t.writeScopes.map(String) : [],
        // ready / writeScopeWarnings 是官方算好的诊断，原样透出——
        // 桥自己重算一遍迟早与官方漂移。
        ready: t?.ready === true,
        ...(Array.isArray(t?.writeScopeWarnings) && t.writeScopeWarnings.length
          ? { writeScopeWarnings: t.writeScopeWarnings.map(String) }
          : {}),
      })),
      tasksError: null,
    };
  } catch (e) {
    return { tasks: [], tasksError: `not-a-team-member: ${String(e?.message || e).slice(0, 160)}` };
  }
}

/**
 * 子代理的真实投影。
 *
 * ## 两条取法，权威优先
 *
 * 1. **权威（首选）**：官方 `ctx.subagents.listChildren(parentSessionId)` ——
 *    dsh-subagent 的公开方法（`lib/index.js:2981` → `listChildren` :2071），
 *    返回的行里带 `activity: 'running' | 'inactive'`（`childRow` :2271-2286，
 *    取值来自 `agents.get(entry.id)?.status`，同一文件 :79）。这是**官方自己
 *    算好的运行时状态**，比桥拿 `agents.list()` 猜要准，而且不会漏掉
 *    「目录里有、但 agent 没加载」这一态。
 * 2. **回落**：`sessionProjections.snapshot(session, ['subagentCatalog'])` ——
 *    投影注册表的真实契约（`snapshot(session, keys)` 返回 `{ asOfSeq, values }`，
 *    只输出声明了 `wire` 的单元；`subagentCatalogProjectionDefinition` 的
 *    `wire.view` 就是 `subagentCatalogEntries`）。这一层给的是**发现事实**，
 *    不含运行时状态。
 *
 * 回落链**必须保留**：`subagents` 服务由 `@deepseek-ai/dsh-subagent` 提供，
 * 而投影由同一个包注册——但两者的可用性可以不同（服务被替换、投影被别处
 * 抢先注册）。任一条能读到真实行就是好结果；两条都读不到才如实报原因。
 *
 * ## 不编造状态
 *
 * 权威源给了 `activity` 就用它；**没给就不写 status 键**，由前端显示「未知」。
 * 旧实现用「id 是否还在 `agents.list()` 里」猜 `running`，那会把
 * 「已结束但目录还在」的子代理永久显示成「运行中」——编造状态比不显示更坏。
 *
 * @param {object} ctx cordis 上下文
 * @param {string|null} sessionId 当前会话 id（子代理目录挂在它自己的会话上）
 * @returns {{subAgents: object[], subAgentsError: string|null}}
 */
export function projectSubAgents(ctx, sessionId) {
  if (!sessionId) return { subAgents: [], subAgentsError: 'no-session-id' };

  const authoritative = subAgentsFromService(ctx, sessionId);
  if (authoritative) return authoritative;

  const projections = serviceOf(ctx, 'sessionProjections');
  if (!projections) return { subAgents: [], subAgentsError: 'session-projections-unavailable' };
  const sessions = serviceOf(ctx, 'sessions');
  const sessionsGet = bindMethod(sessions?.get, sessions);
  if (!sessionsGet) return { subAgents: [], subAgentsError: 'session-store-unavailable' };
  let session;
  try {
    session = sessionsGet(String(sessionId));
  } catch (e) {
    return { subAgents: [], subAgentsError: `session-lookup-threw: ${String(e?.message || e).slice(0, 160)}` };
  }
  if (!session) return { subAgents: [], subAgentsError: 'session-not-found' };
  const snapshot = bindMethod(projections.snapshot, projections);
  if (!snapshot) return { subAgents: [], subAgentsError: 'projections-have-no-snapshot' };
  let cut;
  try {
    // 只请求自己需要的那一个 unit。投影注册表对未注册的 key 会跳过，因此
    // 「官方 subagent 包没装」在这里表现为 values 里没有这个键，而不是抛错。
    cut = snapshot(session, ['subagentCatalog']);
  } catch (e) {
    return { subAgents: [], subAgentsError: `snapshot-failed: ${String(e?.message || e).slice(0, 160)}` };
  }
  const entries = cut?.values?.subagentCatalog;
  if (!Array.isArray(entries)) return { subAgents: [], subAgentsError: 'subagent-catalog-not-registered' };
  return { subAgents: entries.map(shapeCatalogEntry), subAgentsError: null };
}

/**
 * 官方 `ctx.subagents.listChildren` 那条权威路径。
 *
 * @param {object} ctx cordis 上下文
 * @param {string} sessionId 父会话 id
 * @returns {{subAgents: object[], subAgentsError: null}|null} 成功时返回结果，服务不可用时返回 null（交给回落链）
 */
function subAgentsFromService(ctx, sessionId) {
  const svc = serviceOf(ctx, 'subagents');
  if (!svc) return null;
  const listChildren = bindMethod(svc.listChildren, svc);
  if (!listChildren) return null;
  let rows;
  try {
    rows = listChildren(String(sessionId));
  } catch {
    // 官方在「父会话不存在 / 从未有过子代理」时会抛 SubagentError——
    // 这是正常降级，交回投影回落链再试一次（那条路径给的是空数组 + 原因）。
    return null;
  }
  if (!Array.isArray(rows)) return null;
  return {
    subAgents: rows
      .filter((r) => r && (r.kind === undefined || r.kind === 'child'))
      .map((r) => ({
        id: String(r?.id || ''),
        // label 是官方在创建子代理时冻结的标签；one-shot 模式可能没有 label，
        // 此时回落空串，由前端显示「（未命名）」而不是桥来编一个名字。
        name: String(r?.label || ''),
        // 官方算好的运行时状态：running | inactive（childRow :2271-2286）。
        // 缺字段时**不给这个键**——前端显示「未知」，桥不做任何猜测。
        ...(r?.activity ? { status: String(r.activity) } : {}),
        mode: String(r?.mode || ''),
        createdAt: null,
        // hasChildren 是官方给的「这个子代理自己还有下级」事实，
        // 面板可以据此显示层级，而不是桥去递归猜。
        ...(r?.hasChildren === true ? { hasChildren: true } : {}),
      })),
    subAgentsError: null,
  };
}

/**
 * 把投影目录条目塑造成前端行。
 * @param {object} e subagentCatalog 条目
 * @returns {object} 花名册行
 */
function shapeCatalogEntry(e) {
  return {
    id: String(e?.id || ''),
    name: String(e?.label || ''),
    // **刻意不给 status**：目录条目本身不含运行时状态。旧实现在这里用
    // `agents.list()` 猜 running，会把「目录还在、agent 已结束」显示成
    // 「运行中」。交回前端显示「未知」。
    mode: String(e?.mode || ''),
    createdAt: Number(e?.createdAt) || null,
  };
}

/**
 * 一次读全花名册的三个分区。
 *
 * 三个分区各自独立降级：Team 侧失败不该让子代理侧也消失，反之亦然。
 * 返回值固定含 `team` / `subAgents` / `tasks` 三个数组（不可用时为空数组），
 * 外加三个 `*Error` 字段说明原因——面板据此区分「确实没有」与「读不到」。
 *
 * `members` 是 `team` 的**同值别名**：0.15.3 之前 Team 成员叫 `team`，
 * 而官方 `TeamView` 用的词是 `members`。两个名字都给，是为了让面板与外部
 * 消费者不必因为一次改名而同时改两端（那正是本文件顶部记的那一族缺陷）。
 *
 * @param {object} ctx cordis 上下文
 * @param {string|null} sessionId 当前会话 id
 * @returns {{team: object[], members: object[], tasks: object[], subAgents: object[],
 *   teamError: string|null, membersError: string|null, tasksError: string|null, subAgentsError: string|null}}
 */
export function projectRoster(ctx, sessionId) {
  let team = { team: [], teamError: null };
  let tasks = { tasks: [], tasksError: null };
  let sub = { subAgents: [], subAgentsError: null };
  try { team = projectTeam(ctx, sessionId); } catch (e) {
    team = { team: [], teamError: `team-projection-threw: ${String(e?.message || e).slice(0, 160)}` };
  }
  try { tasks = projectTasks(ctx, sessionId); } catch (e) {
    tasks = { tasks: [], tasksError: `task-projection-threw: ${String(e?.message || e).slice(0, 160)}` };
  }
  try { sub = projectSubAgents(ctx, sessionId); } catch (e) {
    sub = { subAgents: [], subAgentsError: `subagent-projection-threw: ${String(e?.message || e).slice(0, 160)}` };
  }
  const teamRows = Array.isArray(team.team) ? team.team : [];
  return {
    team: teamRows,
    // 同值别名：官方 TeamView 的词是 members。见函数注释。
    members: teamRows,
    tasks: tasks.tasks,
    subAgents: sub.subAgents,
    teamError: team.teamError ?? null,
    membersError: team.teamError ?? null,
    tasksError: tasks.tasksError ?? null,
    subAgentsError: sub.subAgentsError ?? null,
  };
}