// task-graph.js — 任务板的**图诊断**：就绪集、阻塞原因、关键路径、环与悬空边。
//
// ## 为什么需要这个文件
//
// 官方 `agentTeams.listTasks` 给的是**逐行事实**（status / blockedBy / ready /
// writeScopes），它回答「这一条现在能不能开工」。但用户在任务板面板上真正要问的是
// 另外三个问题，官方数据里**一个都没有**：
//
//   1. **为什么整块板没动？** —— 需要「当前阻塞点」与「在等谁」。
//      逐行 `ready:false` 只是症状；根因是某个上游任务卡住了它的全部下游。
//   2. **还要多久？** —— 需要**关键路径**（最长依赖链）。它决定整批任务的下界，
//      也是「并行度够不够」的唯一可核对判据。
//   3. **这张图本身是不是坏的？** —— 需要环检测、自环、悬空边。
//      官方在**写边时**做全图校验（`assertTaskGraphCandidate`），但那是**拒写**；
//      已经落库的历史数据（旧版本写的、手改过的设置文件）仍可能带环，而
//      一个带环的图在 UI 上表现为「一堆永远不 ready 的待办」，看起来像卡死。
//
// 这三条都是**纯图论**计算，与官方服务无关，因此放在桥里自己算：
// 桥不重算官方的 `ready` 布尔（那是官方契约，重算必然漂移——见 roster.js 的注释），
// 只**补充**官方没有的图级视角，并明确标注哪个字段来自谁。
//
// ## 与 `dsh-task-board` 的关系（对照，不是抄）
//
// 对照研究见 `doc/research/task-board-vs-agentteams-graph.md`。这里取它的两条结论：
//
//   · §3①「边的语义要分完成即释放与成功才释放」——**官方只有一种**
//     （`blockedBy.every(status === 'completed')`），所以本模块**不发明第二种**，
//     而是把「阻塞者当前是什么状态」如实摊开，让人自己看出「它在等一个失败的任务」。
//     一旦未来官方加了边语义，这里只需换判据，UI 不用动。
//   · §3⑧「图的状态必须能一眼看出在等谁」——这就是 `blockers` / `waitingCount` /
//     `criticalPath` 三个字段的由来。
//
// ## 刻意不做的事
//
// - **不判写范围重叠**。官方已经算好 `writeScopeWarnings` 并在 `listTasks` 里透出
//   （见 roster.js），桥再算一遍就是第二份真相。
// - **不触发任何东西**。官方明文没有调度器（`reference/agent-team/service/lib/index.js`
//   全文只有两处 `setTimeout`，都是超时上界，没有任何派发），本模块也不引入——
//   它只产出**可读的诊断**，推进仍由 Lead 决定。
// - **不改状态**。纯函数，无副作用，输入是 `listTasks` 的投影行。

/**
 * 官方任务状态机的四个取值（`types.d.ts` 的 `TeamTaskStatus`）。
 *
 * `deleted` 是**软删除**：官方的图校验把它同时排除在「作 blocker」与「被遍历」
 * 之外，因此软删除不会制造悬空边。本模块照此办理——把 deleted 行整行移出图，
 * 而不是把它算成一个「永不完成」的 blocker（那会让下游永远 blocked）。
 */
const DELETED = 'deleted';

/** 终态（成功）。官方就绪判据逐字是 `blockedBy.every(… status === 'completed')`。 */
const COMPLETED = 'completed';

/**
 * 分析一张任务图。
 *
 * 输入是 `roster.projectTasks` 的行（已经是从官方 `listTasks` 塑形过的**最小投影**），
 * 因此本函数不依赖任何官方服务、可在单测里用纯数据驱动。
 *
 * @param {Array<object>} rows 任务行（id/subject/status/ownerName/blockedBy/writeScopes/ready）
 * @returns {{nodes: object[], counts: object, cycles: string[][], selfLoops: string[],
 *   missingEdges: object[], criticalPath: string[], blockedOn: object[]}} 诊断结果
 */
export function analyzeTaskGraph(rows) {
  const list = Array.isArray(rows) ? rows : [];
  /** 软删除整行移出图：见文件头 DELETED 的说明。 */
  const active = list.filter((t) => t && t.id && String(t.status || '') !== DELETED);
  const byId = new Map(active.map((t) => [String(t.id), t]));

  /** 邻接表 blocker → dependents（正向）与 task → blockers（反向）。 */
  const dependents = new Map();
  const blockersOf = new Map();
  const missingEdges = [];
  const selfLoops = [];
  for (const t of active) {
    const id = String(t.id);
    const raw = Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : [];
    const kept = [];
    for (const b of raw) {
      if (b === id) {
        // 自环是**单点错误**（写边时手滑），与「结构性的环」定位手段完全不同
        //（前者改一行，后者要看整张图），因此单独成字段而不是混进 cycles。
        // 对照研究 §3③ 点名了官方把它归到 cycle 码、调用方分不开这一点。
        if (!selfLoops.includes(id)) selfLoops.push(id);
        continue;
      }
      if (!byId.has(b)) {
        // 悬空边：blocker 不存在或已删除。官方写边时拒收（missing），但历史数据
        // 与手改文件仍可能出现——如实报出来，而不是把它当「未完成」永远阻塞。
        missingEdges.push({ from: id, to: b });
        continue;
      }
      if (!kept.includes(b)) kept.push(b);
    }
    blockersOf.set(id, kept);
    for (const b of kept) {
      if (!dependents.has(b)) dependents.set(b, []);
      dependents.get(b).push(id);
    }
  }

  /**
   * DFS 三色环检测（白=未访问、灰=在栈上、黑=已完成）。
   *
   * 灰节点被再次遇到即找到环，且栈上从该节点起的一段就是环成员——这比
   * 「只报有一个环」有用得多：UI 要能高亮**具体哪几个任务**把图锁死了。
   */
  const color = new Map();
  const stack = [];
  const cycles = [];
  const inCycle = new Set();
  const visit = (id) => {
    color.set(id, 'gray');
    stack.push(id);
    for (const next of dependents.get(id) || []) {
      const c = color.get(next);
      if (c === 'gray') {
        const at = stack.indexOf(next);
        const ring = stack.slice(at >= 0 ? at : 0);
        cycles.push(ring);
        for (const m of ring) inCycle.add(m);
      } else if (c !== 'black') {
        visit(next);
      }
    }
    stack.pop();
    color.set(id, 'black');
  };
  for (const t of active) {
    const id = String(t.id);
    if (color.get(id) !== 'black') visit(id);
  }

  /**
   * 深度（最长上游链的节点数）。只在**无环**时计算：带环的图上「最长路径」
   * 无定义（可以绕环无限长），此时给 null 并让 UI 说「图里有环，无法计算」。
   */
  const depthMemo = new Map();
  const pathMemo = new Map();
  const acyclic = cycles.length === 0;
  const depthOf = (id) => {
    if (depthMemo.has(id)) return depthMemo.get(id);
    const bs = blockersOf.get(id) || [];
    let best = 0;
    let bestPath = [];
    for (const b of bs) {
      const d = depthOf(b);
      if (d.depth > best) { best = d.depth; bestPath = d.path; }
    }
    const out = { depth: best + 1, path: [...bestPath, id] };
    depthMemo.set(id, out);
    pathMemo.set(id, out.path);
    return out;
  };
  let criticalPath = [];
  if (acyclic) for (const t of active) {
    const d = depthOf(String(t.id));
    if (d.depth > criticalPath.length) criticalPath = d.path;
  }

  /**
   * 逐节点成行。
   *
   * `ready` **原样取官方算好的布尔**（`t.ready === true`）——这是本模块唯一一条
   * 不自己算的判据，理由与 roster.js 同：官方重算迟早漂移。只有当官方**没给**
   * 这个键（旧版本 / 桩）时才按官方判据现算一次，并在 `readySource` 里说明来源。
   */
  const nodes = active.map((t) => {
    const id = String(t.id);
    const bs = blockersOf.get(id) || [];
    const blockers = bs.map((b) => ({
      id: b,
      subject: String(byId.get(b)?.subject || ''),
      // 阻塞者**当前状态**必须一起给出：否则「被 3 项卡住」看不出是「还在跑」
      //（正常等待）还是「已经失败」（需要人来处理）——那是两个完全不同的动作。
      status: String(byId.get(b)?.status || ''),
      ownerName: byId.get(b)?.ownerName ? String(byId.get(b).ownerName) : null,
    }));
    const unresolved = blockers.filter((b) => b.status !== COMPLETED);
    const officialReady = t.ready === true;
    const computedReady = String(t.status || '') === 'pending' && unresolved.length === 0;
    return {
      id,
      subject: String(t.subject || ''),
      status: String(t.status || ''),
      ownerName: t.ownerName ? String(t.ownerName) : null,
      revision: Number(t.revision) || 0,
      blockedBy: bs,
      blockers,
      // 未完成的阻塞者：这是「为什么它没动」的直接答案。
      unresolvedBlockers: unresolved.map((b) => b.id),
      ready: t.ready === undefined ? computedReady : officialReady,
      readySource: t.ready === undefined ? 'computed' : 'official',
      writeScopes: Array.isArray(t.writeScopes) ? t.writeScopes.map(String) : [],
      // 有多少个**未完成**的下游在等它：找出「阻塞点」靠的就是这个数。
      waitingCount: (dependents.get(id) || []).filter((d) => String(byId.get(d)?.status || '') !== COMPLETED).length,
      depth: acyclic ? depthOf(id).depth : null,
      inCycle: inCycle.has(id),
    };
  });

  /**
   * 「在等谁」的聚合：按阻塞者分组，给出它在卡住几个下游、它自己是什么状态。
   *
   * 排序口径是**卡住的下游数降序**——第一行就是当前最该处理的那个。
   * 同级按 id 升序，保证同一次输入永远给出同一顺序（面板轮询时行不跳动）。
   */
  const blockedOn = nodes
    .filter((n) => n.waitingCount > 0)
    .map((n) => ({ id: n.id, subject: n.subject, status: n.status, ownerName: n.ownerName, waitingCount: n.waitingCount }))
    .sort((a, b) => (b.waitingCount - a.waitingCount) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const counts = {
    total: nodes.length,
    // 软删除行不进图，但**要计数**：否则「板上有 5 条、图里 3 条」看起来像丢了数据。
    deleted: list.length - nodes.length,
    pending: nodes.filter((n) => n.status === 'pending').length,
    inProgress: nodes.filter((n) => n.status === 'in_progress').length,
    completed: nodes.filter((n) => n.status === COMPLETED).length,
    ready: nodes.filter((n) => n.status === 'pending' && n.ready).length,
    blocked: nodes.filter((n) => n.status === 'pending' && !n.ready).length,
    unowned: nodes.filter((n) => n.status !== COMPLETED && !n.ownerName).length,
  };

  return {
    nodes,
    counts,
    cycles,
    selfLoops,
    missingEdges,
    // 带环时给空数组而不是编一条「最长路径」——无定义的东西不该有值。
    criticalPath: acyclic ? criticalPath : [],
    criticalPathLength: acyclic ? criticalPath.length : null,
    acyclic,
    blockedOn,
  };
}
