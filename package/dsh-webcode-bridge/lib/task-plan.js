// task-plan.js — 任务图的**执行语义**：谁能开工、为什么不能、还要不要重试、跑完没有。
//
// ## 为什么它与 task-graph.js 是两个文件
//
// 两者回答的问题不同，混在一个文件里会让「结构诊断」与「调度判据」互相污染：
//
//   • `task-graph.js` 回答**结构**问题：环在哪、关键路径多长、谁卡住了几个下游。
//     它的输出是给人看的**诊断**，不影响任何判定。
//   • 本模块回答**准入**问题：这一条现在允许开工吗？如果不允许，是依赖没满足、
//     还是资源不可用、还是重试额度用尽？它的输出是**可执行的判定**。
//
// 对照研究 `doc/research/task-board-vs-agentteams-graph.md` §3 把 Graph Engineering
// 缺的东西列成十条。官方 AgentTeams 只做到 §3③（环检测）与一半的 §3②（ready 只是
// **准入**，`taskReady()` 判完就结束，全服务没有一处因为 ready 为真去启动谁）。
// 本模块补的是那十条里**纯函数能补**的部分：
//
//   §3① 边的语义      → `edge.kind`：after-success / after-settle / after-attempt
//   §3② 触发者        → `dispatch`：把「可以开工」与「有谁空闲」**分成两个轴**
//   §3④ 就绪≠可执行   → 同上；依赖满足但无空闲成员必须能看出来
//   §3⑤ 失败语义      → 区分**失败**与**没跑成**：超时/取消/环境不可用不吃重试额度
//   §3⑥ 扇出收敛      → `join`：all（AND） / any（OR） / quorum(n)
//   §3⑩ 终止性        → `termination`：还剩几个非终态节点，以及「整批跑完没有」
//
// ## 为什么这些语义只**加法式**扩展，不改官方字段
//
// 官方的 `blockedBy: TeamTaskId[]` + `taskReady()`（`blockedBy.every(status === 'completed')`）
// 是**已经正确且有测试**的契约。本模块不重写它，而是：
//
//   · 官方行**没有** `edges`/`join` 时，一律按官方语义解释——即
//     `after-success` + `all`。于是官方数据进来得到的判定与官方 `ready` 逐字一致，
//     桥不会在「官方说不行」时说行。
//   · 只有桥自己的台账（未来的自有图）才写 `edges`/`join`，表达能力更强，
//     而**判据集中在这里**，不会出现两套。
//
// ## 刻意不做的事
//
// - **不派发、不唤醒、不起会话**。本模块只产出判定（`dispatch` 数组），执行仍由
//   调用方决定。理由与 task-graph.js 同：官方明文没有调度器，桥也不引入——
//   自动派发会带出「谁决定并行度」「失败怎么重试」两个需要人拍板的语义。
// - **不读磁盘、不读服务**。纯函数，输入是塑形后的任务行 + 成员行。

/** 软删除：与 task-graph.js 同一口径，整行移出图。 */
const DELETED = 'deleted';

/** 终态（成功）。 */
const COMPLETED = 'completed';

/**
 * 三种边语义（§3①）。
 *
 * 官方只有一种（blocker 必须 `completed`），那等价于 `after-success`。另外两种
 * 是真实需求：清理/回滚节点要在上游**失败时也跑**（`after-settle`），
 * 记录性前置只要上游**跑过**就算（`after-attempt`）。
 *
 * 为什么必须显式：`after-success` 下「A 失败 ⇒ B 永不跑」是**静默**的——
 * 界面上 B 永远停在「被阻塞」，用户看不出它在等一个**再也不会完成**的任务。
 */
export const EDGE_KINDS = ['after-success', 'after-settle', 'after-attempt'];

/**
 * 一次上游尝试的结局是否满足某条边。
 *
 * 「没跑成」的三种（`timeout` / `cancelled` / `env-unavailable`）在这三种边语义下
 * 都**不算满足** `after-success`（它确实没成功），但**算满足** `after-attempt`
 *（上游确实跑过一次）。把它们与 `failed` 分开，是为了让重试判定（见 `retryOf`）
 * 能对它们用不同策略——那是 §3⑤ 的核心。
 *
 * @param {object} task 上游任务行
 * @param {string} kind 边语义
 * @returns {boolean} 这条边是否已满足
 */
function edgeSatisfied(task, kind) {
  const status = String(task?.status || '');
  const outcome = String(task?.outcome || '');
  if (kind === 'after-attempt') {
    // 「跑过就算」：只要有过一次尝试记录即可，无论成败。
    // 没有尝试记录但状态已是 completed/failed 的，同样算跑过——那是旧数据
    //（那时还没有 outcome 字段），当成「跑过」比当成「没跑」更接近事实。
    return Boolean(task?.lastAttemptAt) || status === COMPLETED || status === 'failed';
  }
  if (kind === 'after-settle') {
    // 「有结局就算」：失败、取消、超时都算有结局；仍在跑或还没开始不算。
    return status === COMPLETED
      || status === 'failed'
      || (status === 'cancelled')
      || outcome === 'cancelled' || outcome === 'timeout' || outcome === 'env-unavailable';
  }
  // after-success（默认，= 官方语义）
  return status === COMPLETED;
}

/**
 * 归一化一条任务上的依赖声明。
 *
 * 两种输入形态：
 *   · 官方行：`blockedBy: string[]` —— 等价 `after-success`。
 *   · 桥自有行：`edges: [{id, kind}]` —— 显式语义。
 *
 * 两者**可以同时存在**（官方字段是契约面，edges 是扩展面）。去重按
 * `id + kind`，同一上游不同语义算两条边——那是合法的（既要求成功、又要求跑过）。
 *
 * 非法 kind 一律**回落到 `after-success`** 而不是丢掉这条边：丢边会让一个
 * 本该被阻塞的任务变成「可开工」，那是最难查的一类错（提前开工）。
 *
 * @param {object} task 任务行
 * @returns {Array<{id: string, kind: string}>} 归一化后的边
 */
export function normalizeEdges(task) {
  const out = [];
  const seen = new Set();
  const push = (id, kind) => {
    const key = id + '\u0000' + kind;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id, kind });
  };
  for (const raw of Array.isArray(task?.edges) ? task.edges : []) {
    const id = String(raw?.id || '');
    if (!id) continue;
    const kind = EDGE_KINDS.includes(String(raw?.kind)) ? String(raw.kind) : 'after-success';
    push(id, kind);
  }
  for (const raw of Array.isArray(task?.blockedBy) ? task.blockedBy : []) {
    const id = String(raw || '');
    if (id) push(id, 'after-success');
  }
  return out;
}

/**
 * 归一化一个任务的收敛模式（§3⑥）。
 *
 * 官方只有 AND（`blockedBy.every(...)`）。OR 与 quorum 在真实图里是刚需
 *（「任一镜像源可用即可」「N 个评审里过 2 个」），而它们在官方表达不出来——
 * 所以只能在桥自有语义里加，且**缺省必须是 AND**，否则官方数据进来会被
 * 判成比官方更宽松，那是提前开工。
 *
 * `quorum` 的 n 会被 clamp 到 `[1, 边数]`：n > 边数是**永远不可能满足**的
 * 配置，静默地让它永不就绪比报错更坏——这里 clamp 之后由
 * `validatePlan()` 把它记成一条警告，两处都能看到。
 *
 * @param {object} task 任务行
 * @param {number} edgeCount 归一化后的边数
 * @returns {{mode: string, n: number|null}} 收敛模式
 */
export function normalizeJoin(task, edgeCount) {
  const mode = String(task?.join?.mode || 'all');
  if (mode === 'any') return { mode: 'any', n: null };
  if (mode === 'quorum') {
    const raw = Number(task?.join?.n);
    const n = Number.isFinite(raw) ? Math.floor(raw) : 1;
    return { mode: 'quorum', n: Math.min(Math.max(n, 1), Math.max(edgeCount, 1)) };
  }
  return { mode: 'all', n: null };
}

/**
 * 「没跑成」的结局（§3⑤）：它们**不吃**重试额度。
 *
 * 理由：超时是环境慢、取消是人改主意、环境不可用是依赖缺失——三种都不是
 *「这个节点做错了」。把它们记成失败会让人去修一个没坏的东西，而真正的失败
 *（做完了但结果不对）反而被淹没。
 */
const NOT_RUN_OUTCOMES = ['cancelled', 'timeout', 'env-unavailable'];

/**
 * 重试判定（§3⑤）。
 *
 * 三个独立问题，分开回答，因为它们的**动作不同**：
 *
 *   1. `allowed` —— 还能不能再试一次？（额度问题）
 *   2. `countsAgainstBudget` —— 上一次尝试算不算「用掉一次」？（语义问题）
 *   3. `reason` —— 不能重试时说清是为什么（额度尽 / 不是失败 / 已在跑）
 *
 * 旧式写法把三者压成一个布尔，于是「额度用尽」与「上次是超时不算数」在
 * 界面上长得一样——而前者要人去改计划，后者只要再点一次。
 *
 * @param {object} task 任务行
 * @returns {{allowed: boolean, used: number, max: number, countsAgainstBudget: boolean, reason: string|null}}
 */
export function retryOf(task) {
  const max = Number.isFinite(Number(task?.maxAttempts)) ? Math.max(1, Math.floor(Number(task.maxAttempts))) : 1;
  // `attempts` 是**已结算**的尝试次数；正在跑的那次不算（它还没结算）。
  const used = Number.isFinite(Number(task?.attempts)) ? Math.max(0, Math.floor(Number(task.attempts))) : 0;
  const outcome = String(task?.outcome || '');
  const status = String(task?.status || '');
  const countsAgainstBudget = !NOT_RUN_OUTCOMES.includes(outcome);
  if (status === 'in_progress') return { allowed: false, used, max, countsAgainstBudget, reason: 'already-running' };
  if (status === COMPLETED || status === DELETED) return { allowed: false, used, max, countsAgainstBudget, reason: 'terminal' };
  if (status !== 'failed') return { allowed: false, used, max, countsAgainstBudget, reason: 'not-failed' };
  // 额度按「算数的那些尝试」计：一次超时不占用重试次数。
  const charged = countsAgainstBudget ? used : Math.max(used - 1, 0);
  if (charged >= max) return { allowed: false, used, max, countsAgainstBudget, reason: 'attempts-exhausted' };
  return { allowed: true, used, max, countsAgainstBudget, reason: null };
}

/**
 * 一个任务的准入判定（§3②④）。
 *
 * **两个轴必须分开**，这是本模块最重要的一条：
 *
 *   · `deps` 轴 = 依赖是否满足（图的因果）
 *   · `resource` 轴 = 有没有可用的执行者（成员是否空闲）
 *
 * 旧写法把两者合成一个「能不能开工」，于是两种完全不同的卡法在界面上
 * 长得一样：依赖全满足但没人空闲（在等资源，看起来像卡死）、有人空闲但依赖
 * 没满足（提前开工，最难查的一类 bug）。分开之后界面能分别说清。
 *
 * @param {object} task 任务行
 * @param {Map<string, object>} byId 全表（判依赖满足要看上游状态）
 * @param {object} options `{ ownerAvailable?: (name) => boolean }`
 * @returns {object} 准入判定
 */
export function admissionOf(task, byId, options = {}) {
  const id = String(task?.id || '');
  const status = String(task?.status || '');
  const edges = normalizeEdges(task);
  const join = normalizeJoin(task, edges.length);
  const satisfied = [];
  const unsatisfied = [];
  const dangling = [];
  for (const edge of edges) {
    const up = byId.get(edge.id);
    if (!up) { dangling.push(edge); continue; }
    if (edgeSatisfied(up, edge.kind)) satisfied.push(edge);
    else unsatisfied.push(edge);
  }
  let depsOk;
  // 没有边 = 没有依赖 = 依赖轴天然满足。这条必须在三种模式**之前**判，
  // 否则 `quorum` 在 0 条边上会算出 `satisfied.length >= 1` = false，
  // 于是一个无依赖任务永远开不了工——那是纯粹的配置退化，不是事实。
  if (edges.length === 0) depsOk = true;
  else if (join.mode === 'any') depsOk = satisfied.length >= 1;
  else if (join.mode === 'quorum') depsOk = satisfied.length >= (join.n || 1);
  else depsOk = unsatisfied.length === 0;
  // 悬空边（指向不存在/已删除的上游）**不能**算满足：那会提前开工。
  // 但也**不永久阻塞**——由 `validatePlan()` 报成结构问题，人修掉那条边。
  // 这里如实标出来，让调用方自己决定（默认按未满足处理，见下方 depsOk 的收口）。
  if (dangling.length > 0 && join.mode === 'all') depsOk = false;

  const owner = task?.ownerName ? String(task.ownerName) : null;
  const resourceOk = owner === null
    ? true                       // 无主任务进共享池，谁能取谁取：资源轴不阻塞它
    : options.ownerAvailable ? options.ownerAvailable(owner) : true;

  const retry = retryOf(task);
  const actionable = status === 'pending' || (status === 'failed' && retry.allowed);
  return {
    id,
    status,
    ownerName: owner,
    join,
    edges,
    satisfiedEdges: satisfied.map((e) => e.id),
    unsatisfiedEdges: unsatisfied.map((e) => ({ id: e.id, kind: e.kind, status: String(byId.get(e.id)?.status || '') })),
    danglingEdges: dangling.map((e) => ({ id: e.id, kind: e.kind })),
    // 两个轴各自回答，且 `canStart` 只在两者都真时为真。
    depsOk,
    resourceOk,
    canStart: actionable && depsOk && resourceOk,
    // 卡在哪：一个词，供面板分组显示。null = 没有阻塞。
    blockedBy: !actionable ? null
      : !depsOk ? 'deps'
        : !resourceOk ? 'resource' : null,
    retry,
  };
}

/**
 * 全图的可派发集与卡点分布（§3②④⑩）。
 *
 * @param {object[]} rows 任务行
 * @param {object} options `{ ownerAvailable?: (name) => boolean }`
 * @returns {object} `{ admissions, dispatchable, waitingDeps, waitingResource, retryable, termination }`
 */
export function analyzePlan(rows, options = {}) {
  const list = Array.isArray(rows) ? rows : [];
  // 软删除整行移出图：与 task-graph.js 同一口径（deleted 既不作 blocker 也不被遍历）。
  const active = list.filter((t) => t && t.id && String(t.status || '') !== DELETED);
  const byId = new Map(active.map((t) => [String(t.id), t]));
  const admissions = active.map((t) => admissionOf(t, byId, options));

  const dispatchable = admissions.filter((a) => a.canStart);
  // 「等依赖」与「等资源」分开列：它们是两种不同的卡法，动作也不同
  //（前者去催上游，后者去腾出一个成员）。
  const waitingDeps = admissions.filter((a) => a.blockedBy === 'deps');
  const waitingResource = admissions.filter((a) => a.blockedBy === 'resource');
  const retryable = admissions.filter((a) => a.status === 'failed' && a.retry.allowed);

  const terminal = (s) => s === COMPLETED || s === 'cancelled';
  const failedNoRetry = admissions.filter((a) => a.status === 'failed' && !a.retry.allowed);
  const remaining = admissions.filter((a) => !terminal(a.status) && !(a.status === 'failed' && !a.retry.allowed));
  return {
    admissions,
    dispatchable,
    waitingDeps,
    waitingResource,
    retryable,
    // §3⑩ 终止性：能回答「整批跑完没有」，而不是只看某一列空了。
    termination: {
      total: admissions.length,
      // 软删除行要计数：否则「板上有 5 条、图里 3 条」看起来像丢了数据。
      deleted: list.length - active.length,
      completed: admissions.filter((a) => a.status === COMPLETED).length,
      failedTerminal: failedNoRetry.length,
      remaining: remaining.length,
      // 只有「剩余为 0」才算整批结束。跑完但**有失败**是另一种结局，
      // 用两个字段分别说，不压成一个布尔。
      allSettled: remaining.length === 0,
      hasTerminalFailure: failedNoRetry.length > 0,
    },
  };
}

/**
 * 计划级结构校验（§3③，并给自环**独立**错误码）。
 *
 * 与 `task-graph.js` 的图诊断分工：那里算「环成员是谁」（给人看），这里算
 *「这份计划还能不能被执行」（给判定用）。因此这里的判据更严：**悬空边与
 * 重复边都算错**，因为它们会让准入判定给出错的答案。
 *
 * 自环单独成码（官方把它归到 `cycle`，调用方分不开——§3③ 点名了这一点）：
 * 自环是**单点错误**（写边时手滑，改一行），真环是**结构错误**（要看整张图）。
 *
 * @param {object[]} rows 任务行
 * @returns {{ok: boolean, errors: object[], warnings: object[]}}
 */
export function validatePlan(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const active = list.filter((t) => t && t.id && String(t.status || '') !== DELETED);
  const byId = new Map(active.map((t) => [String(t.id), t]));
  const errors = [];
  const warnings = [];

  for (const t of active) {
    const id = String(t.id);
    // 重复边必须从**原始**声明里看：`normalizeEdges` 会按 id+kind 去重，
    // 去重之后重复就再也看不见了——那正是「静默地少报一条结构错误」。
    const rawIds = [
      ...(Array.isArray(t?.edges) ? t.edges : []).map((e) => String(e?.id || '')),
      ...(Array.isArray(t?.blockedBy) ? t.blockedBy : []).map((b) => String(b || '')),
    ].filter(Boolean);
    const seenRaw = new Set();
    const dupReported = new Set();
    for (const rawId of rawIds) {
      if (seenRaw.has(rawId) && !dupReported.has(rawId)) {
        dupReported.add(rawId);
        errors.push({ code: 'duplicate-edge', taskId: id, edge: rawId });
      }
      seenRaw.add(rawId);
    }
    const rawEdges = normalizeEdges(t);
    for (const edge of rawEdges) {
      if (edge.id === id) { errors.push({ code: 'self-loop', taskId: id, edge: edge.id }); continue; }
      if (!byId.has(edge.id)) errors.push({ code: 'missing-edge', taskId: id, edge: edge.id });
    }
    // quorum 的 n 越界会被 normalizeJoin clamp 掉，但**clamp 是静默的**——
    // 因此在这里补一条警告，让「你写的 n 不生效」看得见。
    const requestedN = Number(t?.join?.n);
    if (String(t?.join?.mode || '') === 'quorum'
      && Number.isFinite(requestedN)
      && (requestedN < 1 || requestedN > rawEdges.length)) {
      warnings.push({ code: 'quorum-clamped', taskId: id, requested: requestedN, edges: rawEdges.length });
    }
  }

  // 全图 DFS 三色环检测：与 task-graph.js 同一算法，但这里只关心「有没有」。
  // 全量重验而非增量——256 节点上限下 O(V+E) 是微秒级，而增量校验要维护反向
  // 邻接表的不变量，一旦漂移就是**静默的错**（对照研究 §2.1 记的就是这个取舍）。
  const color = new Map();
  const visit = (id, stack) => {
    color.set(id, 'gray');
    stack.push(id);
    for (const edge of normalizeEdges(byId.get(id))) {
      if (!byId.has(edge.id)) continue;
      // 自环已经在上面单独报成 `self-loop`，这里必须**跳过**：
      // 否则同一个单点错误会同时产生 `self-loop` 与 `cycle` 两条，
      // 调用方按 `cycle` 去画「环成员图」时会得到一个只有一个节点的假环——
      // 那正是 §3③ 点名要避免的「两类错误分不开」。
      if (edge.id === id) continue;
      const c = color.get(edge.id);
      if (c === 'gray') {
        const at = stack.indexOf(edge.id);
        errors.push({ code: 'cycle', ring: stack.slice(at >= 0 ? at : 0) });
      } else if (c !== 'black') visit(edge.id, stack);
    }
    stack.pop();
    color.set(id, 'black');
  };
  for (const t of active) {
    const id = String(t.id);
    if (color.get(id) !== 'black') visit(id, []);
  }

  return { ok: errors.length === 0, errors, warnings };
}

/**
 * 写作用域重叠（§3⑥ 的另一维）。
 *
 * 只在**两个任务都还没终态且写范围相交**时报——已完成的不会与新任务打架。
 * 与官方 `writeScopeWarnings` 的关系：官方那条判的是「同时 in_progress」；
 * 这里判的是「都还没结束」，更早一步（能在开工**前**提醒），因此是**补充**
 * 而不是重复。前缀按路径分量比较（`src` 与 `src/a` 相交，`src` 与 `srcx` 不相交）。
 *
 * @param {object[]} rows 任务行
 * @returns {Array<{a: string, b: string, paths: string[]}>} 重叠对
 */
export function writeScopeConflicts(rows) {
  const list = (Array.isArray(rows) ? rows : []).filter(
    (t) => t && t.id && String(t.status || '') !== DELETED
      && String(t.status || '') !== COMPLETED && String(t.status || '') !== 'cancelled',
  );
  const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\/+/g, '').replace(/\/+$/, '');
  const intersects = (a, b) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
  const out = [];
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const sa = (Array.isArray(list[i].writeScopes) ? list[i].writeScopes : []).map(norm).filter(Boolean);
      const sb = (Array.isArray(list[j].writeScopes) ? list[j].writeScopes : []).map(norm).filter(Boolean);
      const hit = [];
      for (const a of sa) for (const b of sb) if (intersects(a, b) && !hit.includes(a)) hit.push(a);
      if (hit.length > 0) out.push({ a: String(list[i].id), b: String(list[j].id), paths: hit });
    }
  }
  return out;
}
