// task-split.js — 把一个目标**拆成依赖图**：AI 拆分 + 分配 + 结构校验。
//
// ## 为什么需要这个文件（0.17.0，用户点名的「让 AI 拆分分配」）
//
// 0.16.x 的任务板只能**看**：任务从哪来？只能来自模型自己调 Team 工具。
// 用户看得到「被阻塞 3」，却没有任何入口去建一条——更没法让 AI 把一个大目标
// 拆成一串有依赖的功能节点。对照研究 §4 给的落地形态里，「图的表示与校验」
// 沿用官方 `blockedBy`，而「**谁把目标拆成图**」两个参考实现都没有——
// dsh-task-board 只有「粘贴一段文本 → 拆出**一条**任务的三个字段」
//（`host-ai.ts` 的 `parseTaskDraft`），它拆的是**标题/描述/提示词**，不是图。
//
// 本模块补的正是那一层：**目标 → 带依赖与归属的节点集**。
//
// ## 与 dsh-task-board 的 host-ai.ts 的关系（借立场，不抄实现）
//
// 那份代码有一条值得逐字借的立场：**模型回包是不可信文本，提取要防御**——
// 剥代码围栏、取第一个 JSON 对象、不可用时回落到用户自己的话而不是空表单。
// 本模块照此办理，但多两道：
//
//   1. **结构必须过 `validatePlan`**。一份带环或悬空边的计划在 UI 上表现为
//      「一堆永远不 ready 的待办」，看起来像卡死；必须在**落库之前**就拒掉，
//      并把具体错在哪告诉用户。
//   2. **引用名必须能解析**。模型输出的是计划内的本地名（`a`/`b`），落库时要
//      整体重写成持久 id（`task-ledger.js` 的 `applyPlan` 负责），解析不到的名字
//      丢掉并记明——而不是留成一条让下游永远等不到的悬空边。
//
// ## 拆不出来时给什么
//
// **不编一个假计划**。模型没回包 / 回包不可解析 / 计划结构不合法，一律返回
// 带原因的空结果（`error` 字段），由界面如实说明。这比给一个看起来能用、
// 实际全是悬空边的图好得多——后者会让用户以为拆分成功了。

/**
 * 一次拆分最多产出多少节点。
 *
 * 与 `task-ledger.js` 的 `MAX_TASKS` 同量级但更小：一次拆分给 60 个节点，
 * 人已经读不过来了，而模型在这种规模上的依赖设计质量急剧下降。
 */
export const MAX_SPLIT_NODES = 60;

/** 一个目标最多接受多少字符（防止把整份文档塞进去）。 */
export const MAX_GOAL_CHARS = 16 * 1024;

/** 单次拆分的模型超时（毫秒）。 */
export const SPLIT_TIMEOUT_MS = 60_000;

/** 节点标题上限（与界面一行能显示的长度对齐）。 */
const SUBJECT_LIMIT = 120;

/**
 * 拆分用的系统提示词。
 *
 * ## 每一条约束都对应一个具体的失败模式
 *
 * 不写清这些，模型会给出一份「看起来对」的计划，然后在落库时才炸：
 *
 *   · **只输出 JSON** —— 带散文的回包要额外提取，而提取失败就等于白跑一轮。
 *   · **ref 必须唯一且被依赖引用** —— 重复 ref 会让两条边指向同一个节点；
 *     依赖引用不存在的 ref 就是悬空边（下游永远不就绪）。
 *   · **不许自依赖** —— 自环是单点错误，虽然 `applyPlan` 会修掉，但修掉等于
 *     静默改了模型的输出；能在提示词里避免就别让它发生。
 *   · **依赖必须指向更早的节点** —— 这一条不是图论要求（DAG 允许任意拓扑序），
 *     而是**可读性**要求：按拓扑序输出时人才能顺序读下去，也才看得出执行顺序。
 *   · **assignee 只能取给定成员名** —— 编一个不存在的成员名会让任务挂在一个
 *     永远不会有人认领的归属上，界面上显示「等资源」，而实际是名字打错了。
 */
export const SPLIT_SYSTEM_PROMPT = [
  'You split one goal into a dependency graph of feature nodes for a task board.',
  'Reply with a single JSON object and nothing else, with exactly this shape:',
  '{"nodes":[{"ref":string,"subject":string,"description":string,"assignee":string,"dependencies":string[],"writeScopes":string[]}]}',
  '- ref: a short unique local name for this node (a, b, c, ...). Every node needs its own.',
  '- subject: one line, at most 80 characters, in the language of the goal. It names one feature node, not a phase.',
  '- description: what must be done, as plain text. Enough for an agent to start without asking.',
  '- assignee: one of the provided member names, or an empty string for the shared pool.',
  '- dependencies: refs of nodes that must finish first. Only refer to refs you defined.',
  '- writeScopes: workspace-relative POSIX paths this node may change (may be empty).',
  'Rules you must follow:',
  '- Never make a node depend on itself.',
  '- Only list a dependency on a node defined earlier in the array.',
  '- Split by feature node, not by waterfall phase: one node = one verifiable piece of work.',
  '- Prefer a flat graph with real parallelism over a long chain.',
  '- Do not invent member names; use only the ones provided, or an empty string.',
].join('\n');

/**
 * 拼出这次拆分的用户消息。
 *
 * 成员名单**单独一段**而不是混在目标里：模型很容易把目标正文里出现的人名
 * 当成成员名，而那多半不是成员。
 *
 * @param {string} goal 用户给的目标
 * @param {string[]} members 可用的成员名
 * @returns {string} 用户消息
 */
export function buildSplitPrompt(goal, members) {
  const names = Array.isArray(members) ? members.filter((m) => String(m || '').trim()) : [];
  const roster = names.length > 0
    ? 'Available member names (use only these, or an empty string): ' + names.join(', ')
    : 'No members are defined yet; leave every assignee as an empty string.';
  return roster + '\n\nGoal:\n' + String(goal || '').trim();
}

/**
 * 从模型回包里抽出节点数组。
 *
 * 防御层次与 `host-ai.ts` 的 `extractTaskParseReply` 一致（剥围栏 → 取第一个
 * `{` 到最后一个 `}` → JSON.parse → 形状检查），因为它们面对的是同一个问题：
 * 回包是**不可信文本**。多出来的一层是：这里要的是**数组**，且每个节点都要过
 * 字段白名单——多出来的键一律丢掉，免得把模型的自由发挥带进台账。
 *
 * @param {string} reply 模型原文
 * @returns {{nodes: object[]|null, error: string|null}}
 */
export function extractSplitReply(reply) {
  const text = String(reply || '');
  const unfenced = text.replace(/```[a-zA-Z]*\s*/g, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start === -1 || end <= start) return { nodes: null, error: 'no-json-object' };
  let payload;
  try {
    payload = JSON.parse(unfenced.slice(start, end + 1));
  } catch (e) {
    return { nodes: null, error: 'json-parse-failed: ' + String(e?.message || e).slice(0, 80) };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { nodes: null, error: 'reply-not-an-object' };
  }
  const raw = Array.isArray(payload.nodes) ? payload.nodes : null;
  if (raw === null) return { nodes: null, error: 'no-nodes-array' };
  if (raw.length === 0) return { nodes: null, error: 'empty-nodes' };

  const nodes = [];
  for (const item of raw.slice(0, MAX_SPLIT_NODES)) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const subject = String(item.subject || '').trim().slice(0, SUBJECT_LIMIT);
    // 没有标题的节点直接跳过：它在界面上会显示成「（无标题）」，
    // 而用户无法判断那是漏了还是本来如此。
    if (subject === '') continue;
    const ref = String(item.ref || '').trim();
    nodes.push({
      // ref 缺省用序号补：模型偶尔会漏，而 `applyPlan` 需要一个引用名。
      ref: ref || ('n' + (nodes.length + 1)),
      subject,
      description: String(item.description || ''),
      assignee: String(item.assignee || '').trim(),
      dependencies: (Array.isArray(item.dependencies) ? item.dependencies : []).map(String).filter(Boolean),
      writeScopes: (Array.isArray(item.writeScopes) ? item.writeScopes : []).map(String).filter(Boolean),
    });
  }
  if (nodes.length === 0) return { nodes: null, error: 'no-usable-nodes' };
  return { nodes, error: null };
}

/**
 * 把模型给的节点规范化成一份**可落库**的计划。
 *
 * 三件事，各自对应一个会静默出错的点：
 *
 *   1. **成员名白名单**。编出来的成员名会让任务挂在没人认领的归属上，
 *      界面显示「等资源」而实际是名字打错了——必须回落到共享池（空串）。
 *   2. **自依赖直接丢掉**（而不是留着）。`applyPlan` 也会修，但那是在**写入侧**
 *      静默改模型输出；这里先修并记进 `notes`，用户才知道模型写了什么。
 *   3. **写范围去重**。同一路径写两遍在 `writeScopeConflicts` 里会被算成
 *      两条冲突，而那只是同一个路径。
 *
 * @param {object[]} nodes `extractSplitReply` 的产物
 * @param {string[]} members 合法成员名
 * @returns {{plan: object, notes: object[]}} 规范化后的计划与改动记录
 */
export function normalizeSplit(nodes, members) {
  const allowed = new Set((Array.isArray(members) ? members : []).map((m) => String(m || '').trim()).filter(Boolean));
  const known = new Set();
  const notes = [];
  const tasks = [];
  for (const node of Array.isArray(nodes) ? nodes : []) {
    const ref = String(node?.ref || '');
    if (known.has(ref)) {
      notes.push({ ref, code: 'duplicate-ref-dropped' });
      continue;
    }
    known.add(ref);
    const rawAssignee = String(node?.assignee || '').trim();
    let assignee = rawAssignee;
    if (rawAssignee !== '' && !allowed.has(rawAssignee)) {
      notes.push({ ref, code: 'unknown-assignee-pooled', value: rawAssignee });
      assignee = '';
    }
    const deps = Array.isArray(node?.dependencies) ? node.dependencies.map(String) : [];
    const kept = [];
    for (const dep of deps) {
      if (dep === ref) {
        notes.push({ ref, code: 'self-dependency-dropped' });
        continue;
      }
      if (!kept.includes(dep)) kept.push(dep);
    }
    const scopes = [];
    for (const s of Array.isArray(node?.writeScopes) ? node.writeScopes : []) {
      const v = String(s || '').trim();
      if (v && !scopes.includes(v)) scopes.push(v);
    }
    tasks.push({ ref, subject: String(node?.subject || ''), description: String(node?.description || ''), assignee, dependencies: kept, writeScopes: scopes });
  }
  return { plan: { tasks }, notes };
}

/**
 * 一次拆分的**纯**部分：回包 → 规范化计划 → 结构校验。
 *
 * 抽成纯函数是为了能在单测里用**真实模型回包样本**驱动：模型输出是最不可控的
 * 输入，而它恰恰最需要在没有网络的情况下反复回归（本仓库已有的教训：
 * 桩的语义错了，再多断言也只是在验证那个错语义）。
 *
 * @param {string} reply 模型原文
 * @param {string[]} members 合法成员名
 * @returns {{plan: object|null, notes: object[], validation: object|null, error: string|null}}
 */
export function planFromReply(reply, members) {
  const extracted = extractSplitReply(reply);
  if (extracted.nodes === null) return { plan: null, notes: [], validation: null, error: extracted.error };
  const { plan, notes } = normalizeSplit(extracted.nodes, members);
  if (plan.tasks.length === 0) return { plan: null, notes, validation: null, error: 'no-usable-nodes' };
  // 校验用**落库前的形状**（本地 ref 还在 dependencies 里）做一张临时图：
  // 悬空引用在这里表现为「依赖了一个没定义的 ref」，那是拆分阶段就该拦住的事，
  // 不该留到 applyPlan 里变成一条被丢掉的边（那时用户已经看到「导入成功」了）。
  const refs = new Set(plan.tasks.map((t) => t.ref));
  const refErrors = [];
  for (const t of plan.tasks) {
    for (const dep of t.dependencies) {
      if (!refs.has(dep)) refErrors.push({ code: 'undefined-ref', ref: t.ref, dependency: dep });
    }
  }
  if (refErrors.length > 0) {
    return { plan, notes, validation: { ok: false, errors: refErrors }, error: 'plan-has-undefined-refs' };
  }
  return { plan, notes, validation: { ok: true, errors: [] }, error: null };
}
