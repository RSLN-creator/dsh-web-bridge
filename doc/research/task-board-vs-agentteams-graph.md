# Graph Engineering 视角：`dsh-task-board` 逻辑拆解 与 AgentTeams 任务图对照

调研时间：2026-09-17。对象：`reference/dsh-task-board`（第三方 `@linxin666/dsh-client-ui-task-board`
0.3.23 解包副本）与 `reference/agent-team`（DSH 官方 `@deepseek-ai/dsh-experimental-agent-team`
0.1.5-rc.1 源码副本）。

> **口径**：本文所有「它怎么做的」都来自这两个副本的源码（行号可核）；所有「Graph Engineering
> 需要什么」都是**本项目的分析**，与官方明文区分开。凡是官方文档写明的限制，标「官方明文」。
> 本文不重复 `reference/local-refs/agent-teams-reference-notes.md`（那份记 AgentTeams 的
> **契约面**：九个工具名与语义、安装钉版、composer patch）；本文记**调度语义面**——
> 即「谁在什么条件下允许开工」，那是两者真正的分野。

---

## 0. 一句话结论

**`dsh-task-board` 是一套「有人按按钮 / 有 cron 到点」的执行台账；AgentTeams 是一张
「谁依赖谁」的准入图。两者都叫 task，但回答的是不同的问题——前者回答「什么时候跑」，
后者回答「现在轮到谁」。**

Graph Engineering 要的是**后者加一层自动推进**：一套能把「依赖满足」直接变成
「可以开工」的**调度策略**。这两个参考实现各自给出了一半，**任何一半单独拿来都会缺东西**：

| | `dsh-task-board` | AgentTeams `task-board` |
| --- | --- | --- |
| 图的表示 | **没有依赖边**。只有 5 个线性状态列 | `blockedBy: TeamTaskId[]` 显式 DAG |
| 环检测 | 不适用（无图） | ✅ DFS 三色，抛 `cycle`/`TEAM_TASK_DEPENDENCY_CYCLE` |
| 开工判据 | `status !== 'running'` + 非归档 + 权限已确认 | `status === 'pending' && taskReady()`（`:1518` 全是 AND：`blockedBy.every(… status === 'completed')`） |
| 触发者 | **人**或 **cron 到点** | **调用方自己**（claim 时判 ready） |
| 自动推进 | cron 定时（时间驱动） | **无**（无 scheduler、无 timer 派发） |
| 并发保护 | `applyRequest` 串行 + 单写者文件锁 | `expectedRevision` CAS + 单 owner |
| 崩溃恢复 | ✅ 打开态执行按 session 重对账 | 投影自持久会话日志（Host 侧） |

---

## 1. `dsh-task-board` 的逻辑（逐层拆）

### 1.1 领域模型：5 列线性状态机，**刻意没有依赖概念**

`src/core/tasks.ts:11` 定义 `TaskStatus = 'backlog' | 'todo' | 'running' | 'done' | 'failed'`，
`COLUMNS:339` 把它们排成看板五列。状态迁移是**受控的小集合**：

| 迁移 | 谁可以做 | 源码 |
| --- | --- | --- |
| → `backlog`/`todo` | 人（拖拽） | `MANUAL_STATUSES:348` |
| → `running` | **只有 runner**（`startExecution`） | `tasks.ts:449` |
| `running` → `done`/`failed` | **只有 runner**（`settleExecution`） | `RUNNER_SETTLE_STATUSES:351` |

**读法**：状态是**权威**（authoritative），由「谁在做」而不是「谁在点」决定。
`canMoveManually:364` 明确拒绝从 `running` 手动移动——执行态归 runner 独占。

### 1.2 真正的「图」在哪？在 `settleExecution` 的一条隐式回边

`tasks.ts:500` 是这套设计里唯一带**图论意味**的一行：

```ts
const status = outcome === 'succeeded'
  ? (task.schedule?.enabled ? 'todo' : 'done')   // ← 开了 cron 的成功任务回到 todo
  : outcome === 'failed' ? 'failed'
    : task.status === 'running' ? 'todo' : task.status
```

**成功 ≠ 终态**：若该任务有启用的 cron，成功后被送回 `todo` 等下一次触发。
这是「周期任务」的标准写法，但它意味着**状态图不是 DAG——存在 `todo → running → todo` 环**。
这个环是**有意**的，且被 `ARCHIVABLE_STATUSES:286` 配合：`running` 不可归档，
否则「归档一个正在跑的任务」会让它的 settle 写回一个已离场的卡片。

> **Graph Engineering 对照点 ①**：任何「可重复触发的节点」都会让图**不再是 DAG**。
> 要么把环显式建模成「同节点多实例（每次执行一个 attempt」），要么像这里一样
> 靠「状态 + 执行记录」两层来拆开「节点」与「这次运行」。AgentTeams 选了前者
> （`TeamTaskSnapshot` 里的任务不可重跑，重跑要新建任务）；task-board 选了后者
> （`ExecutionRecord:18` + `EXECUTION_HISTORY_LIMIT=20` 保留最近 20 次）。

### 1.3 调度：cron 是**时间**驱动，不是**依赖**驱动

`src/core/schedule.ts` 是一个自洽的 5 字段 cron（含 day/weekday OR 语义、
DST 按墙钟、五年视野覆盖闰年）。但它回答的只有「**下一个时刻**是何时」
（`nextRunAtMs:88`），**没有任何跨任务条件**。

调度闭环在 `host-ledger.ts`：

| 步骤 | 位置 | 语义 |
| --- | --- | --- |
| 找到期 | `dueSchedules(now)` `:379` | `nextRunAt <= now` 且 `enabled` 且未归档 |
| 拒绝开工 | `openScheduled:434` | 三种情况**滚到下一次**：权限未确认 / `status==='running'` / 有未结束执行 |
| 补跳过 | `skipMissed(now)` `:457` | 停机期间错过的**一律跳过**，不补跑 |

**「拒绝就滚到下一次」是本文件最关键的调度语义**（`:437-449`）：

```ts
if (requiresPermissionConfirmation(task, this.sessionDefaultPermission)) {
  // 未确认的提权绑定绝不允许无人值守地跑：cron 拒绝并滚到下一次
  this.document.tasks = [...applyScheduleNextRun(..., nextRunAt, ...)]
  this.commit(); return undefined
}
if (task.status === 'running' || hasOpenExecution(task)) { /* 同样滚到下一次 */ }
```

**读法**：这里是**「就绪性检查」（readiness check）**，不是「排队」。
被拒绝的触发**不留痕迹、不进队列**——它只是把 `nextRunAt` 推到下一个 cron 匹配点。
所以「任务 A 完成后任务 B 跑」在这套系统里**表达不出来**。

> **Graph Engineering 对照点 ②**：cron 给的是**周期**，DAG 给的是**因果**。
> 「B 依赖 A」在 cron 里只能退化成「B 的 cron 定得比 A 晚」——这是**时钟假设**，
> 而不是**事实依赖**。A 慢了 10 分钟，B 就在 A 没完成时开工。task-board 的
> `skipMissed` + 「拒绝即滚」把这种不确定性**放大**：不是延后，而是**整轮跳过**。

### 1.4 并发与幂等：单写者 + 请求指纹，这是最值得抄的一层

`host-ledger.ts` 的三道防线（**这三条与「图」无关，但与「多 agent 同时改同一张图」
直接相关**，是 Graph Engineering 的**地基**）：

| 防线 | 位置 | 作用 |
| --- | --- | --- |
| 单进程独占 | `ledger-v2.lock` + pid/token `:839` | 第二个 Host 用同一 `DSH_HOME` **fail closed** |
| 请求幂等 | `applyRequest:408` | `requestId` → sha256(action) 指纹；同 id 不同动作**抛错** |
| 原子落盘 | `:800-810` | 临时文件 + `fsync` + `rename` |

`applyRequest:413-423` 的写法值得逐字看：

```ts
const fingerprint = createHash('sha256').update(JSON.stringify(action)).digest('hex')
const cached = this.requestCache.get(requestId)
if (cached !== undefined) {
  if (cached.fingerprint !== fingerprint) throw new Error('request id was reused with a different action')
  return { state: this.state() }        // ← 重放安全
}
this.requestCache.set(requestId, { fingerprint })   // ← 在 apply() **之前**写入
```

**「先写指纹再 apply」+「失败时回滚指纹」（`:427-431`）** 是关键：
保证「成功即已记录、失败即不留痕」与状态变更**在同一个原子写里**。

### 1.5 崩溃恢复：区分「有 session」与「没 session」

`LedgerState:37` / `OpenExecutionReference:49` 把「打开的 run」分两类：

- **有 `sessionId`** → 重启后按 session 重对账（`inspect()` 读 `turn/end` 判成败）
- **没 `sessionId`**（launch 中途死）→ **按 cancelled 结算，绝不重发**

`host-runner.ts:308` 的 `inspect()` 用 `scanMemos`（`:173`）做**扫描去重**：
最新事件 seq 没变就返回 pending，避免 30s 心跳反复重扫同一段历史（`:353`）。

> **这条对应 Graph Engineering 的「节点执行幂等」**：**「发出去了但不知道成没成」
> （unknown outcome）是分布式调度最危险的状态**。这里的答案是——**无凭据即判失败，
> 不重试**。宁可报 cancelled 让用户重跑，也不赌一次重发。

---

## 2. AgentTeams 的图逻辑（对照）

### 2.1 图校验：完整快照校验，不是增量检查

`service/lib/index.js:1006` 的 `assertTaskGraphCandidate(current, candidate)` 做四件事：

| 检查 | 触发条件 | 错误 |
| --- | --- | --- |
| 自环 | `blockerId === task.id` | `cycle`（注意：归类为 cycle，不是单独码） |
| 重复边 | 同一个 blocker 出现两次 | `duplicate` |
| 悬空边 | blocker 不存在 **或已 deleted** | `missing` |
| 环 | DFS `visiting` 集合命中 | `cycle` |

**架构要点**：它把 `candidate` 合并进 `current` 后**重跑整张图**（`:1011-1029`），
而不是只检查受影响子图。官方注释明说「Validate the **complete** active task graph
after replacing one candidate snapshot」。

**为什么这么选**：`maxTasks: 256`（composer patch）下，O(V+E) 全图遍历是微秒级；
而增量校验要维护「反向邻接表」的额外不变量，一旦漂移就是**静默的错**。
这是**「以可证明的简单换取性能」**——256 个节点的图上，全量重验永远是对的选择。

`deleted` 任务被**同时**排除在「作 blocker」和「被遍历」之外（`:1012`、`:1020`），
所以**软删除不会制造悬空边**——这是软的删除语义与图不变量**互相配合**的设计。

### 2.2 就绪是「准入」，不是「触发」（**本文最重要的一条**）

`index.js:1395` 的 claim 分支：

```ts
if (current.status !== "pending" || !this.taskReady(state, current))
  throw new TeamError(`team task "${current.id}" is not ready to claim`, "TEAM_TASK_BLOCKED");
```

`taskView` 里同样只是**算出**一个布尔（`:1548`）：

```ts
ready: task.status === "pending" && this.taskReady(state, task),
```

**而整个 service 里没有任何东西会因为 `ready === true` 去启动谁**。实测证据：
全文件只有**两处** `setTimeout`——`:80` 是 `wait_agent` 的超时上界，
`:226` 是 runtime disposal 的兜底超时。**没有 cron、没有轮询派发、没有自动开工**。

> **所以 AgentTeams 的图是「被动图」**：它保证**错的顺序会被拒绝**
> （`TEAM_TASK_BLOCKED`），但**不保证对的顺序会被执行**。推进靠 Lead 读状态、
> 发现 ready 后自己去 `send_message` 唤醒 owner。
>
> 这**不是缺陷**——它是刻意的：官方明文（notes §5）写着 owner 不自动释放、
> 进程内共享 checkout。自动派发会引入「谁来决定并行度」「失败怎么重试」两个
> 官方明确不想背的语义。**但在 Graph Engineering 的语境里，这正是必须补的那一层。**

### 2.3 两个系统共有的、图之外的真实约束

| 约束 | task-board | AgentTeams |
| --- | --- | --- |
| 串行化 | `applyRequest` 同步串行 | `transact(rootId, op)` 每 Lead 一条队列 |
| 权威日志 | `ledger-v2.json` 原子写 | **Lead 自己的 Session 日志**（`TeamJournal.appendAndFlush`） |
| 系统提示词注入 | `SystemPrompt.section` order 200 | —（Team 靠工具描述） |
| 上限 | 执行记录 20/任务 | `maxTasks: 256`、`maxMembers: 8` |
| 写入隔离 | 无（共享 checkout） | 无（共享 checkout，官方明文） |

**注意 `TeamJournal` 的立场**：AgentTeams 的权威状态**不是自己的文件**，
而是 **Lead Session 的事件日志**（`journal.d.ts` 的 `appendAndFlush` → 投影）。
好处是「会话日志即真相」，坏处是**离开那个 Lead 会话就没有队**。

> **Graph Engineering 对照点 ③**：这给出两种持久化立场——**「图有独立的库」**
> （task-board，可跨会话存续、可被 cron 唤醒）vs **「图寄生在会话日志里」**
> （AgentTeams，随会话生灭）。**长时间运行的图必须选前者**：会话会被 compact、
> 会被删除，而一个跑了三天的 DAG 不能因为 Lead 会话结束而消失。

---

## 3. Graph Engineering 还需要考虑什么

以下 10 条，按「现在的两个参考实现都不满足」排列。前 5 条是**必须**的（缺了就不成图），
后 5 条是**规模化才痛**的。

### A. 必须项

**① 边的语义要分「完成即释放」与「成功才释放」**
两个实现都只有「blocker 完成」一种。实际需要至少三种，且**必须显式**：
- `after-success`：A 失败则 B 永不跑（现在的默认）
- `after-settle`：A 失败 B 也要跑（清理、回滚）
- `after-attempt`：A 跑过就算（无论成败，用于「记录性」前置）

`task-board` 的 `settleExecution` 把 failed 归到 `failed` 列**不再前进**——
所以它天然是 `after-success`，而且**没有任何地方表达得出「失败也要跑」**。

**② 「派发」必须有明确的触发者，且要能区分「我唤醒」与「你自取」**
AgentTeams 靠 Lead 手动 `send_message`。规模化后这不可靠（Lead 的上下文会满）。
需要显式选择：
- **push**（调度器 wake owner）——需要「成员是否空闲」的可靠读数
- **pull**（owner 轮询 claim）——需要退避与公平性，否则空转烧 token

**③ 环检测必须**在**每次写边时**跑，且必须是**全图**的
AgentTeams 已做对（§2.1）。**但要注意它的错误分类**：自环归到 `cycle` 而不是
独立码——调用方想给「你写了个自环」和「你造了个环」不同提示时，**分不开**。
Graph Engineering 应该给自环一个独立码，因为它是**单点错误**（用户手滑），
而真环是**结构错误**（需要可视化帮忙定位）。

**④ 就绪 ≠ 可执行：要拆开「依赖满足」与「资源可用」**
`taskReady()`（依赖）与「有没有空闲成员」（资源）是**两件事**，两个实现都混在
调用方脑子里。必须拆开，否则：
- 依赖全满足但没人空闲 → 静默不动（看起来像卡死）
- 有人空闲但依赖没满足 → 提前开工，**最难查的一类 bug**

**⑤ 失败语义：重试 ≠ 重放**
`task-board` 的立场是**不重试**（§1.5：无 session 即判 cancelled）。
AgentTeams **没有重试概念**（任务失败要人手动重开）。
DAG 需要**明确**：
- 重试次数与退避（谁的策略：节点自己声明 / 图上声明 / 全局默认）
- 重试是否**复用 session**（task-board 的 `reuseSession` 是在做这件事，但它**只对
  「同一任务的下一次执行」**生效，不是「同一次执行的重试」）
- **区分「失败」与「没跑成」**：超时、被取消、环境不可用都不该算「任务失败」

### B. 规模化的痛点

**⑥ 扇出的收敛语义（join 的计数）**
`blockedBy: [A, B]` 是「A 和 B 都完成」。但「任一完成即可」（OR-join）
或「N 个里完成 M 个」（quorum）在很多图里是刚需。两个实现都只有 AND——
AgentTeams 的 `taskReady`（`index.js:1518`）逐字就是
`task.blockedBy.every(… status === 'completed')`，**没有第二种模式**。
`writeScopes` 的**重叠警告**（AgentTeams `scopesOverlap:1297`，前缀按路径分量比较；
`:1537` 只对**同时 in-progress** 的另一个任务发警告）提示了另一维：
**并行度受写作用域限制**，不只是依赖。

**⑦ 动态图：运行时增删节点**
`edit_plan` 式的「跑着跑着加任务」AgentTeams 支持（`set_dependencies`），
但**加节点后谁来评估新节点是否 ready**？AgentTeams 的答案：等 Lead 再查。
自动推进的图必须有**「图变更后重算就绪集」**这一步，且要幂等。

**⑧ 可观测性：图的状态必须能一眼看出「在等谁」**
`task-board` 的 5 列看板对**线性**流程很好，对图会退化成「一堆 todo」。
AgentTeams 给了 `ready` 布尔 + `blockedBy` 列表。
真正需要的是**关键路径**与**当前阻塞点**——即「为什么整张图没动」。

**⑨ 与「人」的边界：权限确认已经是图的一部分**
`task-board` 的 `permissionConfirmedAt`（§1.3）是**图上一个额外的准入条件**，
且「任何 permission/handover 变更都重新武装闸门」（`handover.ts` 头注释：
防止 confirm-then-swap 提权）。**这是图论之外的、必须建模的东西**：
一个「就绪但未授权」的节点，在 UI 上不该和人看到的「就绪」长得一样。

**⑩ 终止性：图会停止吗**
`task-board` 的 cron 任务**永不终止**（成功回 `todo`），靠人归档；
AgentTeams 的图**没有终态概念**（没有「这张图完成了」）。自动调度的图必须能回答
「还剩几个节点没终态」，否则「跑完了没有」这个问题**无法回答**——
`task-board` 的 `AllStatuses` 里 `done`/`failed` 是终态，但**没有「整批」的终态**。

---

## 4. 如果要在本项目里落地，建议的形态（**方向，未实现**）

本项目已有的立场（`reference/local-refs/agent-teams-reference-notes.md` §7.2）是
「沿用官方工具名与语义，不另造」。照此，**图的表达能力应该加在官方词汇上，而不是新造一套**：

| 层次 | 取谁 | 理由 |
| --- | --- | --- |
| 图的表示与校验 | **AgentTeams**（`blockedBy` + 全图 DFS 环检测） | 已经正确且有测试；官方明文不重造 |
| 持久化 | **task-board 的独立台账**（不在会话日志里） | §2.3 对照点 ③：长跑图不能随会话生灭 |
| 幂等与锁 | **task-board 的 `applyRequest` 指纹 + 单写者锁** | §1.4；这是能用「可证明的简单」挡住重复执行的唯一一层 |
| 崩溃恢复 | **task-board 的「有 session 才对账」** | §1.5；unknown outcome 判失败而非重发 |
| 调度触发 | **新增**（两者都没有） | §3②；必须显式选 push/pull 并写下来 |
| 权限闸门 | **task-board 的 `permissionConfirmedAt`** | §3⑨；就绪与授权必须分开呈现 |

**最要紧的一条**：`task-board` 的「拒绝即滚到下一次」**不能**直接搬到图上。
cron 场景丢掉一次触发是**可接受**的（下一个周期会来）；**图上丢掉一次就绪
是不可恢复的**（再没有人会来叫醒它）。这是两个场景**根本不同**的地方，
也是把 cron 思维带进图调度最容易犯的错。

---

## 5. 复现命令（判据可自查）

```powershell
# ① 确认 AgentTeams 没有调度器（应只看到两处 setTimeout：wait 超时与 disposal 超时）
Select-String -Path reference\agent-team\service\lib\index.js -Pattern "setInterval|setTimeout"

# ② 看环检测与错误码映射
Select-String -Path reference\agent-team\service\lib\index.js -Pattern "assertTaskGraphCandidate|TASK_GRAPH_ERROR_CODES" -Context 0,3

# ③ 确认 task-board 没有依赖边（应只见 status/executions，无 blockedBy 之类）
Select-String -Path reference\dsh-task-board\src\core\tasks.ts -Pattern "blockedBy|dependenc|dependsOn"
Select-String -Path reference\dsh-task-board\src\core\tasks.ts -Pattern "TaskStatus =|COLUMNS|MANUAL_STATUSES|RUNNER_SETTLE"

# ④ 看「拒绝就滚到下一次」的调度语义
Select-String -Path reference\dsh-task-board\src\host-ledger.ts -Pattern "openScheduled|skipMissed" -Context 0,12

# ⑤ 看幂等指纹
Select-String -Path reference\dsh-task-board\src\host-ledger.ts -Pattern "applyRequest" -Context 0,20
```

## 6. 两个副本不在运行链路里（不要误当依赖）

`reference/*/` 被 `.gitignore:9` 排除，两者都**不是**本仓库的依赖：
`dsh-task-board` 已从本机 web profile **卸载**（`reference/README.md` §6 有取回命令）；
`agent-team` 是官方实验包的已发布形态副本。它们的作用是**证据与对照**——
本项目自己的结论写在本文与 `reference/local-refs/` 里，而不是把那两棵代码树搬进来。
