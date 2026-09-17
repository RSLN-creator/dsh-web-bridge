# 任务面板需求（用户原话逐条）

本文件把用户对**任务面板 / 任务数据层**的要求逐条写死，供下一轮直接照着做。
它只写**要什么**：判据怎么验、做没做在 [`ROADMAP.md`](ROADMAP.md) P2/P3 与
[`progress.md`](progress.md)；为什么要做在 [`PROJECT-INTENT.md`](PROJECT-INTENT.md)。

建立时间：2026-09-17（0.16.4 轮）。

## 0. 每条需求的出处口径（先读这一节，别把转述当原话）

本项目的既定纪律是「凡属归纳的，标注『归纳』，不与原话混排」
（`doc/PROJECT-INTENT.md:4`）。因此下表每一条都带 `出处` 列：

- **用户原话** —— 逐字，给出文件:行号，任何人可 `Test-Path`/打开核对；
- **本轮任务书转述** —— 用户在本轮对 lead 说的话，lead 写进共享任务书（`task-8`）
  时用的措辞。**它不是逐字原话**，本文件照抄它的措辞并如实标注；
  等拿到逐字记录（会话日志）时再替换，替换后删掉这一句。

---

## 1. 需求条目

### R1 · 右侧不驻留任务板

| 项 | 内容 |
| --- | --- |
| 要求 | 右侧栏**不再**驻留「任务板」标签：只移除右侧那一条 tab 注册，**保留组件与主列路由**（同一份面板只画一次，不做第二份实现） |
| 出处 | 本轮任务书转述（`task-8` §1） |
| 判据 | 右栏标签清单里没有任务板；左侧入口与主列路由仍然可用；`test/client-render.test.mjs` 的登记断言按「成对且同名」验 |
| 现状 | 0.16.0 已注册左侧 `sidebar.panellist` + 同名 `main` 座位；右侧标签的移除**未做** |
| 落点 | `lib/client.cjs`（注册处）、`test/client-render.test.mjs` |

### R2 · 左侧入口参考官方「新会话」按钮的 UI

| 项 | 内容 |
| --- | --- |
| 要求 | 左栏固定入口，位置在官方「新会话」按钮下方；外观与交互**参考官方那个按钮**（不是自绘一套） |
| 出处 | 用户原话：「把任务板入口放在左栏那里固定，**新开对话下方**，参加 task board…」（`doc/progress.md:337`） |
| 判据 | 走官方 `sidebar.panellist` 契约（shell 画按钮：Tooltip、`aria-current`、选中高亮、折叠态 56px 轨道），因此**不得自绘 `button`、不得自挂 `onClick`**、不得用 `MutationObserver` 抢 DOM |
| 现状 | **已做**（0.16.0）：`id=webcode-tasks-panel`、`order=40`、`label` 为 thunk；`test/client-render.test.mjs` 有「不得自绘 button」断言 |
| 落点 | `lib/client.cjs`（约 L982–L1030 的注册段） |
| 反例（历史） | `reference/dsh-task-board` 当年必须做 DOM 注入，是因为它的目标版本**没有**可注册的侧栏槽（`src/client/sidebar-entry-core.ts` 头注释）；本仓库这一版的 `sidebar.panellist` 已经存在，所以**不要**把 DOM 注入那条路线搬进来 |

### R3 · 要能 graph 布置任务

| 项 | 内容 |
| --- | --- |
| 要求 | 任务之间要有依赖关系（依赖边、就绪/阻塞、关键路径），而不是一张线性看板 |
| 出处 | 本轮任务书转述（`task-8` §3） |
| 判据 | 读侧直接用既有 `lib/task-graph.js` / `lib/task-plan.js`：`ready` / `blockedBy` / 关键路径 / 环与自环 / 悬空边都要能在面板上回答「为什么整块板没动」 |
| 现状 | 读侧**已具备**（0.15.12 的图诊断 + 0.16.2 的执行语义，见 `/status` 的 `graph` / `plan` 字段）；**写侧（在界面上画边）未做** |
| 落点 | 写侧落在 P2 的新动作 + 填单 UI；读侧不动 |
| 一条必须先读的对照 | [`research/task-board-vs-agentteams-graph.md`](research/task-board-vs-agentteams-graph.md) §3：两个参考实现都**没有**调度器；图能画出来 ≠ 图会自己往前走 |

### R4 · 能设置「接任务的智能体 / 时间 / 模式 / 权限」

| 项 | 内容 |
| --- | --- |
| 要求 | 每个任务能声明：由哪个智能体接（模型 / 预设）、什么时候跑（手动 / 定时）、什么模式（规划 / 执行）、什么权限（沙箱与审批） |
| 出处 | 本轮任务书转述（`task-8` §4） |
| 判据 | 四项都在 Task 结构里有独立字段（见 §2 的冻结结构），并且**能在面板上读写**；时间一项要有时区明确的纯函数（`nextRunAt`，`Asia/Shanghai`） |
| 现状 | 未做（数据层尚未落地） |
| 落点 | `lib/task-store.js` + `lib/task-schedule.js`（新建）、`lib/client.cjs`（填单 UI） |

### R5 · 以项目为导向，而不是会话

| 项 | 内容 |
| --- | --- |
| 要求 | 一个**项目**下若干任务；能查看「同一需求前后几次实现」；**删掉会话不丢任务** |
| 出处 | 本轮任务书转述（`task-8` §5） |
| 判据 | 任务真身在**本插件自有存储域**（`<DSH storage>/webcode-tasks/projects.json` + `tasks-<projectId>.json`），不挂在会话日志里；`projectId` 是 Task 的必填字段；把某个会话删掉后读任务仍然在（可离线验证） |
| 现状 | 未做 |
| 为什么这条是结构性的 | AgentTeams 的任务图随会话生灭；`dsh-task-board` 的台账独立于会话。长跑的项目级任务必须选后者那一侧的取向（对照点见 research §2.3③） |

### R6 · 手动填单 → 自动进入审批等待 → 通过后才可执行

| 项 | 内容 |
| --- | --- |
| 要求 | 手工点「新建任务」填内容并保存后，任务**自动进入** `awaiting-approval`；由用户或指定智能体审批通过后才变成可执行 |
| 出处 | 本轮任务书转述（`task-8` §6） |
| 判据 | 状态机里有 `draft` 与 `awaiting-approval` 两个**分开**的状态；保存动作的默认落点是 `awaiting-approval`（不是 `ready`）；审批动作写 `approval.decidedBy/decidedAt`；「就绪但未授权」在面板上**不能**与「就绪」长得一样 |
| 现状 | 未做 |
| 对照 | `dsh-task-board` 的 `permissionConfirmedAt` 是图上一个额外的准入条件，且「任何 permission/handover 变更都重新武装闸门」（防止 confirm-then-swap 提权）——这条**要抄**（research §3⑨） |

### R7 · 参考 `reference/dsh-task-board`（并对照 `dsh-task-graph`）

| 项 | 内容 |
| --- | --- |
| 要求 | 设计与交互参考 `reference/dsh-task-board`（`@linxin666/dsh-client-ui-task-board` v0.3.23 解包副本）；思路不够时再看 `doc/research/task-board-vs-agentteams-graph.md` |
| 出处 | 本轮任务书转述（`task-8` §7）；参考副本的存在与版本见 `reference/README.md:124,131` |
| 判据 | 抄什么、不抄什么必须逐条写清（见 §5）——照抄它的 cron 语义到图上是**错的** |
| 附带对照 | `reference/dsh-task-graph`（KevinZhangNothing，HEAD `7c230e0`）只作可视化思路参考 |
| 纪律 | `reference/` 下的副本**都不在运行链路里**（research §6）：不得 import，不得复制其源码进 `lib/` |

---

## 2. 数据层（本轮任务书冻结的结构，落到实现时逐字对齐）

存储域：`<DSH storage>/webcode-tasks/projects.json` + `tasks-<projectId>.json`
（按项目分文件；原子写；带 `schemaVersion`）。

```
Task {
  id, projectId, title, body,
  status: 'draft'|'awaiting-approval'|'ready'|'running'|'blocked'|'done'|'failed'|'cancelled',
  deps: [],                                  // 依赖边（图的输入）
  agent: { model, preset? },                 // R4 的「接任务的智能体」
  schedule: { mode:'manual'|'at'|'cron', at?, cron? },   // R4 的「时间」
  mode: 'plan'|'execute',                    // R4 的「模式」
  permissions: { sandbox, approval },        // R4 的「权限」
  approval: { required, state:'none'|'pending'|'approved'|'rejected', decidedBy?, decidedAt? },
  runs: [{ runId, startedAt, endedAt, status, sessionKey, summary }],
  writeScopes: [],
  history: [{ at, by, op, note }],
}
```

**为什么这些字段一个都不能省**：R5 要「项目化」⇒ `projectId`；R6 要「审批闸门」⇒
`approval` 必须与 `status` 分开（一个任务可以「就绪但未授权」）；R3 要「图」⇒ `deps`；
R4 的四项各占一个字段。`history` 是给「同一需求前后几次实现」看的（R5 的后半句）。

---

## 3. 与官方 AgentTeams 的分工（不许两边各算一份真相）

| | 谁说了算 | 桥怎么用 |
| --- | --- | --- |
| Team 成员花名册 | 官方 `ctx.agentTeams` | **只读消费**（`lib/roster.js`），服务不可用时回落到 `.agent-teams/<teamId>/team.json` 并如实标注 `teamSource: 'disk'` |
| 图的表示与校验 | 官方 AgentTeams 的 `blockedBy` + 全图环检测 | **沿用官方词汇，不另造一套**（research §4 的表） |
| 任务真身与持久化 | **本插件自己的存储域** | 官方任务图随会话生灭；项目级台账必须独立于会话（R5） |

**不做**：不重造一套与官方并行的成员/任务服务；不在桥里复刻官方的就绪判定
（磁盘行不带 `ready`，由 `task-graph.js` 按官方判据现算并标 `readySource: 'computed'`）。

---

## 4. 「派发」的诚实边界（写死在需求里，不许绕过）

- 调度**只做**两件事：算下一次该跑的时间（`nextRunAt`）+ 把状态写回存储；
- 真正派发若拿不到官方 `ctx.subagents`，必须抛可识别错误 **`TASK_DISPATCH_UNAVAILABLE`**，
  **绝不伪造「已派发」**——这条与本项目 0.15.x 反复出现的「说做了、其实没做」是同一族，
  代价是用户按面板显示去等一个永远不会来的结果；
- 面板上的每个状态都必须能回答「这个读数是从哪来的」（服务 / 磁盘 / 现算）。

---

## 5. 参考实现对照：抄什么、不抄什么

| 层 | 取谁 | 理由（来源：research §1–§4） |
| --- | --- | --- |
| 图的表示与校验 | **AgentTeams**（`blockedBy` + 全图 DFS 环检测） | 已正确且有测试；官方明文不重造 |
| 持久化 | **task-board 的独立台账** | 长跑图不能随会话生灭（§2.3③） |
| 幂等与锁 | **task-board 的 `applyRequest` 指纹 + 单写者锁** | 这是用「可证明的简单」挡住重复执行的唯一一层（§1.4） |
| 崩溃恢复 | **task-board 的「有 session 才对账」** | unknown outcome 判失败而非重发（§1.5） |
| 权限闸门 | **task-board 的 `permissionConfirmedAt`** | 就绪与授权必须分开呈现（§3⑨） |
| 调度触发 | **都要新造** | 两者都没有调度器（§3②） |
| **不抄** | task-board 的 cron 语义「拒绝就滚到下一次」 | cron 场景丢一次触发可接受（下个周期会来）；**图上丢一次就绪是不可恢复的**——除了那张图，没有人会再来叫醒它（research §4 末段） |
| **不抄** | task-board 的 5 列线性看板当作图的呈现 | 对图会退化成「一堆 todo」（§3⑧） |

---

## 6. 未决问题（需要用户或下一轮裁决，不要自行假定）

1. **审批人是谁**：R6 说「由用户或指定智能体审批」——默认是「必须人来点」还是
   「可指定一个智能体自动批」？两种默认对「无人值守长跑」的影响完全相反。
2. **项目的边界**：一个 workspace 一个项目，还是可以多项目并存？这决定
   `projects.json` 是单条还是列表、以及左侧入口点进去看到的是哪一个。
3. **`deps` 的释放语义**：完成即释放 / 成功才释放 / 跑过就算（research §3①）——
   在 P3 定下来之前，图上的边只有一种含义，写进需求会导致后面改不动。
4. **失败重试**：谁声明重试次数（节点 / 图 / 全局）？重试是否复用同一个网页会话？
   （与 `lib/task-ledger.js` 的 `reuseSession` 取向要对齐。）

---

## 7. 这份文档怎么维护

- 需求**变更**时改这里，并在条目的「现状」列写上日期与版本；
- 拿到逐字原话后替换 §0 标注为「本轮任务书转述」的条目，并删掉那句免责说明；
- 与代码冲突时**以本文件为准**，然后改代码或改需求——不许让两者各说一套。
