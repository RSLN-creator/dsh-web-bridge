// task-ledger.js — 桥**自己**的任务台账：任务是一等公民，不寄生在任何会话上。
//
// ## 为什么必须有这个文件（0.17.0，即「以任务为导向」那一层）
//
// 0.16.x 的两个面板都只能**读**：读官方 `agentTeams` 服务，或读它的磁盘落盘
//（team-state.js）。这带来两个结构性缺陷，本轮要一起修掉：
//
//   1. **面板上没法加任务**。用户在任务板上看到「可开工 0 / 被阻塞 3」，却没有任何
//      入口去建一条、改一条、或让 AI 把一个大目标拆成依赖图。任务只能来自模型
//      调用 Team 工具——而模型不一定调，用户也看不见它怎么拆的。
//   2. **任务寄生在会话上**。AgentTeams 的权威状态是 **Lead 会话的事件日志**
//      （对照研究 §2.3 的 TeamJournal）。会话被 compact、被删除、被换掉，
//      图就跟着走。一个跑了三天的 DAG 不能因为 Lead 会话结束而消失。
//
// 对照研究 `doc/research/task-board-vs-agentteams-graph.md` §4 给的落地形态就是
// 这两条：**图有独立的库**（取 task-board 的立场）+ **不重造图语义**（沿用官方
// blockedBy 的词与判据）。本模块是「独立的库」，判据仍在 task-plan.js。
//
// ## 落盘位置与格式
//
// `<workspace>/.webcode-tasks/ledger.json`。选工作区而不是 DSH_HOME：任务图的
// 语义是「在这份 checkout 上要做的功能节点」，跟着仓库走才正确——两个仓库各有
// 自己的图，换工作区就该换图。
//
// ## 从 task-board 借的三道防线（§1.4，与图无关但直接决定多 agent 能否安全写同一张图）
//
//   · **原子落盘**：临时文件 + rename。进程在写一半时死掉不会留下半截 JSON。
//   · **CAS**：每次写都要带 `expectedRevision`，不匹配就拒。两个成员同时改同一条，
//     后到的那个收到明确拒绝而不是静默覆盖前者的改动。
//   · **不重试即失败**：读不动的台账报 `ledger-unreadable`，**不**回落成空台账——
//     空台账看起来像「本来就没有任务」，那会让用户以为数据丢了。
//
// ## 与 task-plan.js 的分工
//
// 本模块只管**存储与状态迁移**（增删改、版本、落盘）。「这条现在能不能开工」
// 是 task-plan.js 的判据，两者不重复。因此本模块产出的行**不带 `ready`**——
// 那个键由判据层现算并标注来源。

import fs from 'node:fs';
import path from 'node:path';

/** 台账目录名（工作区下）。 */
export const LEDGER_DIR_NAME = '.webcode-tasks';
/** 台账文件名。 */
export const LEDGER_FILE_NAME = 'ledger.json';
/** 当前格式版本。读到更高版本时拒写（见 `readLedger`）。 */
export const LEDGER_VERSION = 1;
/** 一条任务最多带几条边（防止手滑写出爆炸图）。 */
export const MAX_EDGES_PER_TASK = 64;
/** 一张图最多几条任务。与官方 composer patch 的 maxTasks: 256 对齐。 */
export const MAX_TASKS = 256;

/** 官方状态机取值（与 AgentTeams 的 TeamTaskStatus 逐字一致）。 */
const STATUSES = ['pending', 'in_progress', 'completed', 'failed', 'deleted'];

/**
 * 合法状态迁移表（§1.1 的教训：状态是**权威**，由「谁在做」决定）。
 *
 * 为什么要有这张表：`completed → pending` 这种「回退」在界面上看起来只是拖了一下
 * 卡片，实际会让一个已经交付的节点的下游**重新变回未满足**。允许的迁移要显式，
 * 其余的拒掉并说清原因。
 *
 * 注意 `failed → pending` 是**允许**的：那是重试（§3⑤），归 task-plan.js 的
 * 额度判定管；这里只保证「状态跳变本身合法」。
 */
const TRANSITIONS = {
  pending: ['in_progress', 'completed', 'failed', 'deleted'],
  in_progress: ['completed', 'failed', 'pending', 'deleted'],
  completed: ['deleted'],
  failed: ['pending', 'in_progress', 'deleted'],
  deleted: [],
};

/**
 * 毫秒时间戳归一：**非正数、null、NaN、非数字一律回 null**。
 *
 * 为什么不能只判 `Number.isFinite(Number(x))`：`Number(null)` 是 **0** 且
 * `Number.isFinite(0)` 为真，于是「没有排期」会被读成 **1970-01-01**——
 * 界面上就显示成「开始时间 1970/1/1」，看起来像一个真实但荒谬的排期。
 * 本项目在 `stall-settle` 那条上记过**同一个** `Number(null)` 陷阱。
 *
 * @param {*} x 候选值
 * @returns {number|null} 正整数毫秒，或 null
 */
function msOrNull(x) {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * 排期与执行面的字段归一（0.19.0）。
 *
 * ## 为什么这些字段现在才有（用户 2026-09-22 原话）
 *
 * 「功能我要能够实现 graph 布置任务，**设置接任务智能体和时间**，以及**模式，权限**
 * 等等等详细的」「任务面板手动点击填写内容，自动放入**审批等待我的通过**」。
 * 参考实现 `reference/dsh-task-board` 的 `NewTaskModal` 有 schedule（cron）/ mode /
 * permission / model / reuseSession 一整套；本桥 0.17.3 移植任务板时**只搬了
 * subject/description/model/projectId/writeScopes**，于是「设置开始时间」在界面上
 * 根本没有输入框、在台账里也没有落脚字段——不是坏了，是**从来没做**。
 *
 * ## 口径
 *
 * · `schedule.cron` —— 周期排期（与参考实现同一套 cron 词，见 `isValidCron`）。
 * · `schedule.startAt` —— **一次性开始时间**（毫秒时间戳）。用户说的「开始时间」
 *   主要指这个；两者可同时存在，`startAt` 只作「最早不早于」约束。
 * · `mode` / `permission` —— 执行预设与权限档（参考实现的同名词，原样存字符串，
 *   本模块**不解释**它们的取值合法性：那是执行侧的事，这里存不住才是缺陷）。
 * · `reuseSession` —— 是否复用同一网页会话。
 *
 * 非法/缺省一律**回落成「没排期」**（`{enabled:false}`），绝不抛错：这是人手填的
 * 表单，一个填错的时间不该让整条任务写不进去。
 *
 * @param {object} input 任务输入（含 `schedule` / `startAt` / `mode` / `permission` / `reuseSession`）
 * @returns {object} 要摊进任务行的字段
 */
function scheduleOf(input) {
  const raw = input?.schedule && typeof input.schedule === 'object' ? input.schedule : {};
  // `startAt` 允许写在顶层或 schedule 里：界面两种写法都有人在用，读两处而不是
  // 押一个（押错了表现就是「我填了时间但它没保存」，而且界面上看不出来）。
  const startAtRaw = raw.startAt !== undefined ? raw.startAt : input?.startAt;
  const startAt = msOrNull(startAtRaw);
  const cron = String(raw.cron || input?.cron || '').trim();
  const enabled = raw.enabled === true || startAt !== null || cron !== '';
  const out = {
    schedule: {
      enabled,
      cron,
      startAt,
      // nextRunAt 由排期侧现算后回填；这里只保证字段存在且为 null 而不是 undefined
      //（前端按键取值，缺字段会让那一行显示成 undefined）。
      nextRunAt: msOrNull(raw.nextRunAt),
      lastTriggeredAt: msOrNull(raw.lastTriggeredAt),
    },
    mode: String(input?.mode || ''),
    permission: String(input?.permission || ''),
    reuseSession: input?.reuseSession === true,
  };
  return out;
}

/** 空台账。 */
export function emptyLedger() {
  return { version: LEDGER_VERSION, taskSeq: 0, tasks: [] };
}

/**
 * 台账目录的绝对路径。
 * @param {string|null} root 工作区根
 * @returns {string|null} 目录路径，或 null（拿不到工作区根）
 */
export function ledgerDir(root) {
  if (typeof root !== 'string' || root === '') return null;
  return path.join(root, LEDGER_DIR_NAME);
}

/**
 * 台账文件的绝对路径。
 * @param {string|null} root 工作区根
 * @returns {string|null} 文件路径，或 null
 */
export function ledgerPath(root) {
  const dir = ledgerDir(root);
  return dir === null ? null : path.join(dir, LEDGER_FILE_NAME);
}

/**
 * 读台账。
 *
 * **读不动时报原因，绝不回落成空台账**：空台账看起来像「本来就没有任务」，
 * 用户会以为数据丢了；而真实的「没有任务」是文件不存在（ENOENT）。
 * 这两件事必须可区分——这是本仓库「不造假状态」纪律在存储层的落点。
 *
 * @param {string|null} root 工作区根
 * @returns {{ledger: object|null, error: string|null, exists: boolean}}
 */
export function readLedger(root) {
  const file = ledgerPath(root);
  if (file === null) return { ledger: null, error: 'no-workspace-root', exists: false };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { ledger: emptyLedger(), error: null, exists: false };
    return { ledger: null, error: `ledger-unreadable: ${String(e?.message || e).slice(0, 120)}`, exists: true };
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    // 半截 JSON（进程在写之前死掉）会走到这里。**不静默重建**——那会丢用户的图。
    return { ledger: null, error: `ledger-corrupt: ${String(e?.message || e).slice(0, 120)}`, exists: true };
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.tasks)) {
    return { ledger: null, error: 'ledger-shape-invalid', exists: true };
  }
  if (Number(parsed.version) > LEDGER_VERSION) {
    // 更高版本：**拒读**而不是尽力解析。尽力解析会写回一份丢字段的台账，
    // 那是不可逆的数据损坏。
    return { ledger: null, error: `ledger-version-ahead: ${parsed.version}`, exists: true };
  }
  return {
    ledger: {
      version: LEDGER_VERSION,
      taskSeq: Number(parsed.taskSeq) || 0,
      tasks: parsed.tasks.filter((t) => t && typeof t === 'object' && t.id),
    },
    error: null,
    exists: true,
  };
}

/**
 * 原子写台账（临时文件 + rename）。
 *
 * 为什么必须原子：进程在 `writeFileSync` 中途死掉会留下半截 JSON，而下次
 * `readLedger` 报 `ledger-corrupt` —— 用户的整张图就没了。rename 在同一文件系统
 * 内是原子的，因此要么旧文件、要么新文件，不存在「半截」这一态。
 *
 * @param {string|null} root 工作区根
 * @param {object} ledger 台账
 * @returns {{ok: boolean, error: string|null}}
 */
export function writeLedger(root, ledger) {
  const dir = ledgerDir(root);
  const file = ledgerPath(root);
  if (dir === null || file === null) return { ok: false, error: 'no-workspace-root' };
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = file + '.tmp-' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(ledger, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
    return { ok: true, error: null };
  } catch (e) {
    return { ok: false, error: `ledger-write-failed: ${String(e?.message || e).slice(0, 120)}` };
  }
}

/**
 * 造一条任务行。**不带 `ready`**（判据归 task-plan.js）。
 *
 * @param {object} input `{subject, description, ownerName, blockedBy, edges, join, writeScopes, maxAttempts}`
 * @param {string} id 已铸造的 id
 * @param {number} now 当前时刻
 * @returns {object} 任务行
 */
function mintTask(input, id, now) {
  const edges = (Array.isArray(input?.edges) ? input.edges : [])
    .map((e) => ({ id: String(e?.id || ''), kind: String(e?.kind || 'after-success') }))
    .filter((e) => e.id)
    .slice(0, MAX_EDGES_PER_TASK);
  const blockedBy = (Array.isArray(input?.blockedBy) ? input.blockedBy : [])
    .map(String).filter(Boolean).slice(0, MAX_EDGES_PER_TASK);
  // 去重：`blockedBy` 是官方的词，`edges` 是扩展面。同一上游只留一条 blockedBy，
  // 否则 validatePlan 会报 duplicate-edge —— 那是给**手写**数据用的判据，
  // 不该被桥自己的写入路径触发。
  const uniqBlocked = [...new Set(blockedBy)];
  const isPlainObj = (o) => Boolean(o && typeof o === 'object' && !Array.isArray(o));
  const assignedModel = isPlainObj(input?.assignedModel)
    ? {
      siteId: String(input.assignedModel.siteId || 'deepseek'),
      accountSlot: Math.max(0, Math.floor(Number(input.assignedModel.accountSlot) || 0)),
      modelId: String(input.assignedModel.modelId || ''),
    }
    : null;
  const sessionKey = String(input?.sessionKey || `task-session-${id}-${now.toString(36)}`);
  const projectId = String(input?.projectId || 'default');
  const comments = Array.isArray(input?.comments) ? input.comments : [];

  return {
    id,
    subject: String(input?.subject || '').trim(),
    description: String(input?.description || ''),
    status: 'pending',
    ownerName: input?.ownerName ? String(input.ownerName) : null,
    assignedModel,
    sessionKey,
    projectId,
    comments,
    // 排期与执行面（0.19.0 补齐，见文件末尾「为什么这些字段现在才有」）。
    ...scheduleOf(input),
    blockedBy: uniqBlocked,
    ...(edges.length > 0 ? { edges } : {}),
    ...(input?.join ? { join: input.join } : {}),
    writeScopes: (Array.isArray(input?.writeScopes) ? input.writeScopes : []).map(String).filter(Boolean),
    attempts: 0,
    // 缺省 1 次：与「不重试即失败」的立场一致（§1.5）。要重试必须显式声明额度。
    maxAttempts: Number.isFinite(Number(input?.maxAttempts)) ? Math.max(1, Math.floor(Number(input.maxAttempts))) : 1,
    outcome: '',
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 往台账里加一条任务。
 *
 * 空标题**拒收**并给原因（而不是静默丢弃）：静默丢弃会让用户在界面上点一次
 * 「添加」什么都没发生。
 *
 * @param {object} ledger 当前台账
 * @param {object} input 新任务输入
 * @param {number} now 当前时刻
 * @returns {{ledger: object, task: object|null, error: string|null}}
 */
export function applyCreate(ledger, input, now) {
  const base = ledger && Array.isArray(ledger.tasks) ? ledger : emptyLedger();
  if (base.tasks.filter((t) => String(t.status) !== 'deleted').length >= MAX_TASKS) {
    return { ledger: base, task: null, error: `too-many-tasks: max ${MAX_TASKS}` };
  }
  const subject = String(input?.subject || '').trim();
  if (subject === '') return { ledger: base, task: null, error: 'empty-subject' };
  const seq = (Number(base.taskSeq) || 0) + 1;
  const task = mintTask({ ...input, subject }, 't' + seq, now);
  return {
    ledger: { ...base, taskSeq: seq, tasks: [...base.tasks, task] },
    task,
    error: null,
  };
}

/**
 * 批量应用一份计划（AI 拆分或人手写的一份 DAG）。
 *
 * ## 为什么要「本地引用 → 持久 id」两步
 *
 * 一份计划里任务之间互相引用（`dependencies: ['a', 'b']`），但那些是**计划内的
 * 本地名**，不是台账 id。必须先把全部节点铸成持久 id，再把引用整体重写一遍——
 * 边引用一个不存在的名字，`validatePlan` 会报 `missing-edge`，而用户看不懂
 * 「a 是谁」。
 *
 * 引用不到的名字**丢掉并记进 `droppedEdges`**，而不是保留成悬空边：悬空边会让
 * 那条任务永远不就绪（看起来像卡死），而真实原因是「AI 引用了一个它没定义的名字」。
 * 两者必须可区分。
 *
 * @param {object} ledger 当前台账
 * @param {object} plan `{members?: string[], tasks: Array<{ref?, subject, description?, assignee?, dependencies?, writeScopes?}>}`
 * @param {number} now 当前时刻
 * @returns {{ledger: object, created: object[], droppedEdges: object[], error: string|null}}
 */
export function applyPlan(ledger, plan, now) {
  const base = ledger && Array.isArray(ledger.tasks) ? ledger : emptyLedger();
  const rows = Array.isArray(plan?.tasks) ? plan.tasks : [];
  if (rows.length === 0) return { ledger: base, created: [], droppedEdges: [], error: 'empty-plan' };
  const active = base.tasks.filter((t) => String(t.status) !== 'deleted').length;
  if (active + rows.length > MAX_TASKS) {
    return { ledger: base, created: [], droppedEdges: [], error: `too-many-tasks: ${active}+${rows.length} > ${MAX_TASKS}` };
  }

  // 第一步：铸 id。本地引用名缺省用 `t1`、`t2`…（与界面上的序号一致）。
  let seq = Number(base.taskSeq) || 0;
  const minted = [];
  const refToId = new Map();
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i] || {};
    const subject = String(row.subject || '').trim();
    if (subject === '') continue;                  // 空标题整条跳过，不占 id
    seq += 1;
    const id = 't' + seq;
    const ref = String(row.ref || row.id || ('t' + (i + 1)));
    if (!refToId.has(ref)) refToId.set(ref, id);
    minted.push({ id, ref, row, subject });
  }
  if (minted.length === 0) return { ledger: base, created: [], droppedEdges: [], error: 'all-subjects-empty' };

  // 第二步：重写引用。指向自己的边**直接丢掉**——自环是单点错误，
  // 让 AI 的输出在落库那一刻就被修掉，比事后让用户在界面上看到一个红框好。
  const droppedEdges = [];
  const created = minted.map(({ id, ref, row, subject }) => {
    const deps = Array.isArray(row.dependencies) ? row.dependencies.map(String) : [];
    const blockedBy = [];
    for (const dep of deps) {
      const target = refToId.get(dep);
      if (target === undefined) { droppedEdges.push({ ref, dependency: dep, reason: 'undefined-ref' }); continue; }
      if (target === id) { droppedEdges.push({ ref, dependency: dep, reason: 'self-loop' }); continue; }
      if (!blockedBy.includes(target)) blockedBy.push(target);
    }
    return mintTask({
      subject,
      description: row.description,
      ownerName: row.assignee,
      blockedBy,
      writeScopes: row.writeScopes,
      maxAttempts: row.maxAttempts,
    }, id, now);
  });

  return {
    ledger: { ...base, taskSeq: seq, tasks: [...base.tasks, ...created] },
    created,
    droppedEdges,
    error: null,
  };
}

/**
 * 改一条任务（CAS）。
 *
 * `expectedRevision` 不匹配 ⇒ 拒。这是 §1.4 借来的那条：两个成员同时改同一条，
 * 后到的那个必须收到明确拒绝。静默覆盖会让前者的改动**无声消失**，而两人都以为
 * 自己成功了——那是多 agent 协作里最难查的一类缺陷。
 *
 * @param {object} ledger 当前台账
 * @param {string} taskId 目标任务 id
 * @param {object} patch `{subject?, description?, ownerName?, status?, outcome?, writeScopes?, maxAttempts?}`
 * @param {number} now 当前时刻
 * @param {number|null} expectedRevision 期望的当前 revision（null = 不检查，仅用于内部迁移）
 * @returns {{ledger: object, task: object|null, error: string|null}}
 */
export function applyUpdate(ledger, taskId, patch, now, expectedRevision = null) {
  const base = ledger && Array.isArray(ledger.tasks) ? ledger : emptyLedger();
  const at = base.tasks.findIndex((t) => String(t.id) === String(taskId));
  if (at < 0) return { ledger: base, task: null, error: 'task-not-found' };
  const cur = base.tasks[at];
  if (expectedRevision !== null && Number(cur.revision) !== Number(expectedRevision)) {
    return { ledger: base, task: null, error: `revision-mismatch: expected ${expectedRevision}, actual ${cur.revision}` };
  }
  if (patch?.status !== undefined) {
    const next = String(patch.status);
    if (!STATUSES.includes(next)) return { ledger: base, task: null, error: `unknown-status: ${next}` };
    if (next !== cur.status) {
      const allowed = TRANSITIONS[String(cur.status)] || [];
      if (!allowed.includes(next)) {
        return { ledger: base, task: null, error: `illegal-transition: ${cur.status} -> ${next}` };
      }
    }
  }
  const next = { ...cur };
  if (patch?.subject !== undefined) {
    const s = String(patch.subject).trim();
    if (s === '') return { ledger: base, task: null, error: 'empty-subject' };
    next.subject = s;
  }
  if (patch?.description !== undefined) next.description = String(patch.description);
  if (patch?.ownerName !== undefined) next.ownerName = patch.ownerName ? String(patch.ownerName) : null;
  if (patch?.assignedModel !== undefined) {
    next.assignedModel = patch.assignedModel && typeof patch.assignedModel === 'object'
      ? {
        siteId: String(patch.assignedModel.siteId || 'deepseek'),
        accountSlot: Number(patch.assignedModel.accountSlot) || 0,
        modelId: String(patch.assignedModel.modelId || ''),
      }
      : null;
  }
  if (patch?.sessionKey !== undefined) next.sessionKey = String(patch.sessionKey || '');
  if (patch?.projectId !== undefined) next.projectId = String(patch.projectId || 'default');
  if (patch?.comments !== undefined && Array.isArray(patch.comments)) next.comments = patch.comments;
  // 排期/执行面（0.19.0）：与 mintTask 走**同一个**归一函数，避免「建的时候存得住、
  // 改的时候存不住」这种一分为二的口径。
  if (patch?.schedule !== undefined || patch?.startAt !== undefined || patch?.cron !== undefined) {
    const curSchedule = cur.schedule && typeof cur.schedule === 'object' ? cur.schedule : {};
    const given = patch.schedule && typeof patch.schedule === 'object' ? patch.schedule : {};
    // **`enabled` 不参与合并**——它必须由「合并之后的 startAt / cron 是否为空」重新算出来。
    // 若把旧的 `enabled: true` 一起摊进去，用户清空开始时间与 cron 之后那条任务会
    // 永远停在「有排期」，而界面上两个框都是空的：一个再也关不掉的排期。
    const merged = scheduleOf({
      schedule: {
        cron: given.cron !== undefined ? given.cron : curSchedule.cron,
        startAt: given.startAt !== undefined ? given.startAt : curSchedule.startAt,
        nextRunAt: given.nextRunAt !== undefined ? given.nextRunAt : curSchedule.nextRunAt,
        lastTriggeredAt: given.lastTriggeredAt !== undefined ? given.lastTriggeredAt : curSchedule.lastTriggeredAt,
      },
      startAt: patch.startAt,
      cron: patch.cron,
    });
    next.schedule = merged.schedule;
  }
  if (patch?.mode !== undefined) next.mode = String(patch.mode || '');
  if (patch?.permission !== undefined) next.permission = String(patch.permission || '');
  if (patch?.reuseSession !== undefined) next.reuseSession = patch.reuseSession === true;
  if (patch?.writeScopes !== undefined) {
    next.writeScopes = (Array.isArray(patch.writeScopes) ? patch.writeScopes : []).map(String).filter(Boolean);
  }
  if (patch?.maxAttempts !== undefined && Number.isFinite(Number(patch.maxAttempts))) {
    next.maxAttempts = Math.max(1, Math.floor(Number(patch.maxAttempts)));
  }
  if (patch?.status !== undefined) {
    next.status = String(patch.status);
    // 进 in_progress 就记一次尝试：`attempts` 是**已结算**次数，这里先记上，
    // 由结算路径决定它算不算数（超时/取消在 task-plan.js 里不吃额度）。
    if (next.status === 'in_progress' && cur.status !== 'in_progress') next.attempts = (Number(cur.attempts) || 0) + 1;
    // 离开 failed 时清掉上一次的结局，否则「failed 的 outcome」会挂在一个
    // 已经重新开跑的任务上，让 retryOf 判错。
    if (next.status !== 'failed' && cur.status === 'failed') next.outcome = '';
  }
  if (patch?.outcome !== undefined) next.outcome = String(patch.outcome);
  next.revision = (Number(cur.revision) || 0) + 1;
  next.updatedAt = now;
  const tasks = [...base.tasks];
  tasks[at] = next;
  return { ledger: { ...base, tasks }, task: next, error: null };
}

/**
 * 软删除一条任务，并**同时摘掉指向它的边**。
 *
 * 为什么必须摘边：留下的边会变成悬空边，让下游**永远不就绪**——界面上表现为
 * 「一堆永远开不了工的待办」，看起来像卡死，而真实原因是「它等的那个已经被删了」。
 * 官方靠「deleted 同时排除在作 blocker 与被遍历之外」解决同一问题（§2.1），
 * 这里在写入侧就把它摘干净，两处判据因此一致。
 *
 * @param {object} ledger 当前台账
 * @param {string} taskId 目标任务 id
 * @param {number} now 当前时刻
 * @returns {{ledger: object, task: object|null, prunedFrom: string[], error: string|null}}
 */
export function applyDelete(ledger, taskId, now) {
  const base = ledger && Array.isArray(ledger.tasks) ? ledger : emptyLedger();
  const at = base.tasks.findIndex((t) => String(t.id) === String(taskId));
  if (at < 0) return { ledger: base, task: null, prunedFrom: [], error: 'task-not-found' };
  const prunedFrom = [];
  const tasks = base.tasks.map((t, i) => {
    if (i === at) return { ...t, status: 'deleted', revision: (Number(t.revision) || 0) + 1, updatedAt: now };
    const b = Array.isArray(t.blockedBy) ? t.blockedBy.map(String) : [];
    if (!b.includes(String(taskId))) return t;
    prunedFrom.push(String(t.id));
    const kept = b.filter((x) => x !== String(taskId));
    const edges = Array.isArray(t.edges) ? t.edges.filter((e) => String(e?.id) !== String(taskId)) : undefined;
    return {
      ...t,
      blockedBy: kept,
      ...(edges ? { edges } : {}),
      revision: (Number(t.revision) || 0) + 1,
      updatedAt: now,
    };
  });
  return { ledger: { ...base, tasks }, task: tasks[at], prunedFrom, error: null };
}

/**
 * 往任务里追加一条正文行间/段落评论（Notion 式批注）。
 *
 * @param {object} ledger 当前台账
 * @param {string} taskId 目标任务 id
 * @param {{quote?: string, text: string, author?: string}} comment 批注内容
 * @param {number} now 当前时刻
 * @returns {{ledger: object, comment: object|null, error: string|null}}
 */
export function applyAddComment(ledger, taskId, comment, now, expectedRevision = null) {
  const base = ledger && Array.isArray(ledger.tasks) ? ledger : emptyLedger();
  const at = base.tasks.findIndex((t) => String(t.id) === String(taskId));
  if (at < 0) return { ledger: base, comment: null, error: 'task-not-found' };
  const cur = base.tasks[at];
  // CAS：本模块的头注把「每次写都要带 expectedRevision」列为三道防线之一，而
  // web-control.js 的 `POST task-comment` 一直在传第五个参数。0.17.3 实测发现
  // 函数签名**没有**这个形参 —— 传进来的值被静默丢弃，两个成员同时批注同一条
  // 任务时后到的会覆盖前者且双方都收到 ok。这不是「少了个校验」，是**假成功**。
  if (expectedRevision !== null && Number(cur.revision) !== Number(expectedRevision)) {
    return { ledger: base, comment: null, error: `revision-mismatch: expected ${expectedRevision}, actual ${cur.revision}` };
  }
  const text = String(comment?.text || '').trim();
  if (!text) return { ledger: base, comment: null, error: 'empty-comment-text' };

  const commentItem = {
    id: 'c-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 6),
    quote: String(comment?.quote || '').trim(),
    text,
    author: String(comment?.author || 'user'),
    createdAt: now,
    resolved: false,
  };

  const nextComments = [...(Array.isArray(cur.comments) ? cur.comments : []), commentItem];
  const nextTask = {
    ...cur,
    comments: nextComments,
    revision: (Number(cur.revision) || 0) + 1,
    updatedAt: now,
  };

  const tasks = [...base.tasks];
  tasks[at] = nextTask;
  return { ledger: { ...base, tasks }, comment: commentItem, error: null };
}

/**
 * 切换评论的解决状态（resolved）。
 *
 * @param {object} ledger 当前台账
 * @param {string} taskId 目标任务 id
 * @param {string} commentId 批注 id
 * @param {number} now 当前时刻
 * @returns {{ledger: object, comment: object|null, error: string|null}}
 */
export function applyResolveComment(ledger, taskId, commentId, now, expectedRevision = null) {
  const base = ledger && Array.isArray(ledger.tasks) ? ledger : emptyLedger();
  const at = base.tasks.findIndex((t) => String(t.id) === String(taskId));
  if (at < 0) return { ledger: base, comment: null, error: 'task-not-found' };
  const cur = base.tasks[at];
  // CAS：与 applyAddComment 同一条缺陷、同一个修法（见那里的注释）。
  if (expectedRevision !== null && Number(cur.revision) !== Number(expectedRevision)) {
    return { ledger: base, comment: null, error: `revision-mismatch: expected ${expectedRevision}, actual ${cur.revision}` };
  }
  const comments = Array.isArray(cur.comments) ? cur.comments : [];
  const cIndex = comments.findIndex((c) => String(c.id) === String(commentId));
  if (cIndex < 0) return { ledger: base, comment: null, error: 'comment-not-found' };

  const target = comments[cIndex];
  const updatedComment = { ...target, resolved: !target.resolved, resolvedAt: target.resolved ? null : now };
  const nextComments = [...comments];
  nextComments[cIndex] = updatedComment;

  const nextTask = {
    ...cur,
    comments: nextComments,
    revision: (Number(cur.revision) || 0) + 1,
    updatedAt: now,
  };

  const tasks = [...base.tasks];
  tasks[at] = nextTask;
  return { ledger: { ...base, tasks }, comment: updatedComment, error: null };
}

/**
 * 台账 → 面板行（与 roster.js 的塑形口径**逐字对齐**）。
 *
 * 刻意不产出 `ready`：判据归 task-plan.js，它会按官方判据现算并标
 * `readySource: 'computed'`。在这里给一个 ready 就是第二份真相。
 *
 * @param {object|null} ledger 台账
 * @returns {object[]} 任务行（不含 deleted）
 */
export function rowsOf(ledger) {
  const tasks = Array.isArray(ledger?.tasks) ? ledger.tasks : [];
  return tasks
    .filter((t) => String(t?.status || '') !== 'deleted')
    .map((t) => ({
      id: String(t?.id || ''),
      revision: Number(t?.revision) || 0,
      subject: String(t?.subject || ''),
      description: String(t?.description || ''),
      status: String(t?.status || ''),
      ownerName: t?.ownerName ? String(t.ownerName) : null,
      assignedModel: t?.assignedModel || null,
      sessionKey: String(t?.sessionKey || ''),
      projectId: String(t?.projectId || 'default'),
      comments: Array.isArray(t?.comments) ? t.comments : [],
      // 排期/执行面（0.19.0）：行必须带出去，否则台账里存住了、面板上读不到
      //（「说做了、其实没做」的存储版）。缺字段时给空形状而不是 undefined。
      schedule: t?.schedule && typeof t.schedule === 'object'
        ? {
          enabled: t.schedule.enabled === true,
          cron: String(t.schedule.cron || ''),
          startAt: msOrNull(t.schedule.startAt),
          nextRunAt: msOrNull(t.schedule.nextRunAt),
          lastTriggeredAt: msOrNull(t.schedule.lastTriggeredAt),
        }
        : { enabled: false, cron: '', startAt: null, nextRunAt: null, lastTriggeredAt: null },
      mode: String(t?.mode || ''),
      permission: String(t?.permission || ''),
      reuseSession: t?.reuseSession === true,
      // 时间戳（0.19.0）：任务行一直有这两个字段，但界面**从不渲染**它们，
      // 于是用户看不到「什么时候建的、最后一次动是什么时候」。这里一并透出，
      // 由面板显示——用户问的「开始时间」有一半指的是这个。
      createdAt: Number(t?.createdAt) || 0,
      updatedAt: Number(t?.updatedAt) || 0,
      blockedBy: Array.isArray(t?.blockedBy) ? t.blockedBy.map(String) : [],
      ...(Array.isArray(t?.edges) && t.edges.length ? { edges: t.edges.map((e) => ({ id: String(e?.id || ''), kind: String(e?.kind || 'after-success') })) } : {}),
      ...(t?.join ? { join: t.join } : {}),
      writeScopes: Array.isArray(t?.writeScopes) ? t.writeScopes.map(String) : [],
      // 重试判定的两个输入（task-plan.js 的 retryOf 读它们）。
      attempts: Number(t?.attempts) || 0,
      maxAttempts: Number(t?.maxAttempts) || 1,
      outcome: String(t?.outcome || ''),
    }));
}