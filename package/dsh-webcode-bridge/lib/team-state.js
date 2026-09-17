// team-state.js — Team/任务状态的**磁盘**投影：AgentTeams 包不在时的权威来源。
//
// ## 为什么需要这个文件（0.16.1，即「取代 AgentTeams」那一半）
//
// 桥的 Team / 任务板两个面板一直只读官方 `agentTeams` 服务（roster.js 的
// projectTeam / projectTasks）。那条链路有一个结构性后果：**那个包一旦不在，
// 面板就永远是空的**——于是「取代 AgentTeams」在实现上无从落地，卸载等于连
// 面板一起卸掉。本模块把第二个来源接上，卸载才成立。
//
// ## 为什么读磁盘是正当的，而不是绕开官方去读私有格式
//
// AgentTeams 自己就把磁盘当真相来源。第三方实现
//（@nanmicoder/dsh-agent-teams）的 lib/snapshot.js 开头逐字写着：
//
//   > read the durable team files (the truth source) and enrich with live
//   > subagent activity, so the panel always reflects the on-disk state even
//   > when a model skipped a tool "ritual"
//
// 也就是说：运行时状态是**叠加**在磁盘事实之上的活动信息，磁盘才是底。桥读的是
// 这份公开约定的落盘格式（`.agent-teams/<teamId>/team.json`），与官方服务读的
// 是同一份文件，不存在第二套格式。
//
// ## 与官方服务的关系：优先级，不是替代
//
// 官方服务在时仍然优先——它多给两样磁盘上没有的东西：成员的**实时 activity**
//（running / idle）与任务**就绪布尔**（官方算好的 ready）。本模块只在服务不可用
// 时接手，返回值里如实标 `source`，让面板能说清这一屏数据是从哪来的。
//
// ## 刻意不做的事
//
// - **不写**。只读，与 roster.js 同一纪律。
// - **不算 ready**。塑形结果**不带 `ready` 键**，交给 task-graph.js 现算并标
//   `readySource: 'computed'`——那里已经有一条「官方给了就不重算」的判据，
//   在这里再算一遍就是第二份真相。
// - **不跨会话张冠李戴**。只认 `captainSessionId` 与当前会话相同的那个团队；
//   磁盘上有别人的团队时如实报数量，绝不拿它顶替（这正是 0.15.3 那个「读到
//   别人的 lead」缺陷的同族病根）。

import fs from 'node:fs';
import path from 'node:path';

/** 磁盘状态目录名：与 AgentTeams 的 `stateDir` 默认值一致。 */
export const STATE_DIR_NAME = '.agent-teams';

/**
 * 工作区根 → 磁盘状态根。
 *
 * 拿不到工作区根时返回 null（面板据此报 `no-session-cwd`，而不是去猜一个
 * 相对路径——`path.join(undefined, …)` 会拼出 `undefined/.agent-teams`，
 * 那是一个**看起来正常但永远读不到**的路径）。
 *
 * @param {string|null} cwd 会话的工作区根目录
 * @returns {string|null} 状态根绝对路径，或 null
 */
export function teamStateRoot(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  return path.join(cwd, STATE_DIR_NAME);
}

/**
 * 列出一个状态根下的**活跃**团队。
 *
 * `archive/` 是 AgentTeams 归档已删除团队的地方（第三方实现的
 * `listArchivedTeamIds` 读的就是它），那些不是活跃团队，必须排除——否则
 * 「已删除的团队」会重新出现在面板上。
 *
 * 没有 `team.json` 的目录**不是**团队（可能只是别的程序留下的空目录），
 * 静默跳过；`team.json` 存在但读不动/解析失败才是异常，逐条记进 `skipped`。
 *
 * @param {string|null} stateRoot `teamStateRoot` 的产物
 * @returns {{states: object[], skipped: Array<{id: string, reason: string}>, error: string|null}}
 */
export function listTeamStates(stateRoot) {
  if (!stateRoot) return { states: [], skipped: [], error: 'no-state-root' };
  let entries;
  try {
    entries = fs.readdirSync(stateRoot, { withFileTypes: true });
  } catch (e) {
    // 目录不存在是**正常情况**（这台机器从没跑过 Team），与「目录存在但读不动」
    // 必须分开报：前者面板该说「本会话没有团队」，后者该说「读不到」。
    if (e && e.code === 'ENOENT') return { states: [], skipped: [], error: 'no-team-state-dir' };
    return { states: [], skipped: [], error: `state-dir-unreadable: ${String(e?.message || e).slice(0, 120)}` };
  }
  const states = [];
  const skipped = [];
  for (const ent of entries) {
    if (!ent.isDirectory() || ent.name === 'archive') continue;
    const file = path.join(stateRoot, ent.name, 'team.json');
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        // 目录名兜底：team.json 里缺 id 时用目录名，面板至少能显示一行。
        if (!parsed.id) parsed.id = ent.name;
        states.push(parsed);
      } else {
        skipped.push({ id: ent.name, reason: 'team-json-not-an-object' });
      }
    } catch (e) {
      if (e && e.code === 'ENOENT') continue;
      skipped.push({ id: ent.name, reason: String(e?.message || e).slice(0, 120) });
    }
  }
  return { states, skipped, error: null };
}

/**
 * 从磁盘上的团队里挑出**属于当前会话**的那个。
 *
 * 判据是 `captainSessionId` 与当前会话**逐字相同**。同一会话可能有多个团队
 *（历史遗留 + 当前那个），取 `createdAt` 最大的——那是最近创建的那个。
 *
 * 找不到时**不拿别人的团队顶替**，如实报原因：
 *   · 磁盘上一个团队都没有 → `no-team-state-on-disk`
 *   · 有团队但都属于别的会话 → 带数量的说明（面板据此说「磁盘上有 N 个别的
 *     会话的团队」，用户才知道去哪儿找）
 *
 * @param {object[]} states `listTeamStates` 的 states
 * @param {string|null} sessionId 当前会话 id
 * @returns {{state: object|null, error: string|null}}
 */
export function pickTeamForSession(states, sessionId) {
  const list = Array.isArray(states) ? states : [];
  const wanted = String(sessionId || '');
  if (!wanted) return { state: null, error: 'no-session-id' };
  const mine = list.filter((s) => String(s?.captainSessionId || '') === wanted);
  if (mine.length === 0) {
    return {
      state: null,
      error: list.length === 0
        ? 'no-team-state-on-disk'
        : `no-team-for-this-session: ${list.length}-other-team(s)-on-disk`,
    };
  }
  mine.sort((a, b) => (Number(b?.createdAt) || 0) - (Number(a?.createdAt) || 0));
  return { state: mine[0], error: null };
}

/**
 * 磁盘团队 → 面板的成员行。
 *
 * 字段口径与 roster.js 的 `projectTeam` **对齐**（同一份 UI 消费两边）：
 * `name` / `role` / `status` / `model` / `taskCount`。
 *
 * `model` 拼成 `provider/model` 路由：磁盘把两者分开存，而面板只有一格，
 * 只显示 model 会丢掉「跑在哪个 provider 上」——那是 Team 成员与普通子代理
 * 最直观的差别之一。两边都缺时**不给这个键**（面板显示「未知」），不编。
 *
 * `taskCount` 只在 > 0 时给：给 0 会让「这个成员名下没有任务」与「磁盘没记
 * 任务」看起来一样，而前者是事实、后者是缺数据。
 *
 * @param {object} state team.json 的内容
 * @returns {object[]} 成员行
 */
export function shapeTeamFromDisk(state) {
  const members = Array.isArray(state?.members) ? state.members : [];
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  return members.map((m) => {
    const name = String(m?.name || '');
    const provider = String(m?.provider || '').trim();
    const model = String(m?.model || '').trim();
    const route = model && provider ? `${provider}/${model}` : (model || provider);
    // 只统计**归到这个成员名下**的任务：拿全表条数当每人任务数是假事实
    //（roster.js 的 projectTeam 注释里记过这条旧缺陷）。
    const owned = name ? tasks.filter((t) => String(t?.assignee || '') === name) : [];
    return {
      id: String(m?.id || ''),
      name,
      role: String(m?.role || ''),
      status: String(m?.status || ''),
      ...(route ? { model: route } : {}),
      ...(owned.length > 0 ? { taskCount: owned.length } : {}),
    };
  });
}

/**
 * 磁盘团队 → 任务板的行。
 *
 * 字段名映射（磁盘 → 面板）：
 *   · `dependencies` → `blockedBy`（官方 `listTasks` 的词）
 *   · `inScope`      → `writeScopes`
 *   · `attempt`      → `revision`
 *   · `assignee`     → `ownerName`
 *
 * **刻意不产出 `ready`**：见文件头。缺这个键时 task-graph.js 会按官方判据现算
 * 一次并把 `readySource` 标成 `computed`——于是「这一屏的就绪是谁算的」在数据
 * 里可查，而不是靠读代码猜。
 *
 * @param {object} state team.json 的内容
 * @returns {object[]} 任务行
 */
export function shapeTasksFromDisk(state) {
  const tasks = Array.isArray(state?.tasks) ? state.tasks : [];
  return tasks.map((t) => ({
    id: String(t?.id || ''),
    revision: Number(t?.attempt) || 0,
    subject: String(t?.subject || ''),
    status: String(t?.status || ''),
    ownerName: t?.assignee ? String(t.assignee) : null,
    blockedBy: Array.isArray(t?.dependencies) ? t.dependencies.map(String) : [],
    writeScopes: Array.isArray(t?.inScope) ? t.inScope.map(String) : [],
  }));
}

/**
 * 磁盘 Team 成员的完整投影（roster.js 的回落入口）。
 *
 * @param {string|null} cwd 会话的工作区根
 * @param {string|null} sessionId 当前会话 id
 * @returns {{team: object[], teamError: string|null, source: string|null}}
 */
export function projectTeamFromDisk(cwd, sessionId) {
  const root = teamStateRoot(cwd);
  if (!root) return { team: [], teamError: 'no-session-cwd', source: null };
  const { states, error } = listTeamStates(root);
  if (error) return { team: [], teamError: error, source: null };
  const { state, error: pickErr } = pickTeamForSession(states, sessionId);
  if (!state) return { team: [], teamError: pickErr, source: 'disk' };
  return { team: shapeTeamFromDisk(state), teamError: null, source: 'disk' };
}

/**
 * 磁盘任务板的完整投影（roster.js 的回落入口）。
 *
 * 本函数**不**算图：图由调用方用 task-graph.js 对塑形后的行算一次，
 * 这样「官方路径」与「磁盘路径」共用同一份图论实现（两份迟早会不一致）。
 *
 * @param {string|null} cwd 会话的工作区根
 * @param {string|null} sessionId 当前会话 id
 * @returns {{tasks: object[], tasksError: string|null, source: string|null}}
 */
export function projectTasksFromDisk(cwd, sessionId) {
  const root = teamStateRoot(cwd);
  if (!root) return { tasks: [], tasksError: 'no-session-cwd', source: null };
  const { states, error } = listTeamStates(root);
  if (error) return { tasks: [], tasksError: error, source: null };
  const { state, error: pickErr } = pickTeamForSession(states, sessionId);
  if (!state) return { tasks: [], tasksError: pickErr, source: 'disk' };
  return { tasks: shapeTasksFromDisk(state), tasksError: null, source: 'disk' };
}
