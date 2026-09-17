# 路线图：从「能跑」到「敢长期放手跑」

本文件回答一个问题：**接下来按什么顺序做什么、做到什么算完。**
它只写**未来框架与退出条件**；已经发生了什么在 [`progress.md`](progress.md)，
为什么要做在 [`PROJECT-INTENT.md`](PROJECT-INTENT.md)，缺陷欠账在
[`long-term-issues.md`](long-term-issues.md)，任务面板的需求在
[`REQUIREMENTS-TASKBOARD.md`](REQUIREMENTS-TASKBOARD.md)。

建立时间：2026-09-17（0.16.4 轮）。**版本推进不改本文件**：一轮做完就把它的
「当前坐标」换成新读数、把做完的阶段标上日期。

---

## 一、当前坐标（2026-09-17 实测读数）

| 项 | 读数 | 取法 |
| --- | --- | --- |
| 工作树 | **0.16.4** | `package/dsh-webcode-bridge/package.json` |
| 已装（web / headless） | 均 **0.16.3** | `~/.dsh/profiles/*/node_modules/dsh-webcode-bridge/package.json` |
| 运行中的进程 | **0.16.3**，`hash=412c7c099919` | `GET http://127.0.0.1:3080/__webcode/status` |
| 上游 | `origin/main = HEAD = 6b836d2`（0.15.12），**0 个未推送提交** | `git log origin/main..HEAD` |
| 未提交改动 | **59 项**（19 改 + 40 新） | `git status --porcelain` |
| 单测文件 | **57 个**（台账 `单测基线` 必须与它逐字相等） | `Get-ChildItem package/dsh-webcode-bridge/test/*.test.mjs` |

**这个坐标里最重要的一行是「未提交改动 59 项」**：0.16.0–0.16.4 五轮的产品代码、
护栏与真机夹具全部只在工作树里。工作树一旦被误删或误覆盖，五轮修复与全部真机夹具
（`test/fixtures/dsml-real-*.txt`、`marker-typo-dsh-calls.txt`）会同时消失——而它们
正是「真实调用被丢 / 标记畸变 / 会话槽丢失」那几族缺陷的**唯一离线防线**。

---

## 二、阶段划分（P0 → P5）

排序原则来自用户原话：「**team 最后实现，优先解决前面问题**」
（`doc/progress.md:1233`）。即：**先把已有的路修到能用，再往上加新面板**。

### P0 · 装机与提交（收口，最高优先）

**做什么**：把 0.16.4 打包 → 校验 → 装进两个 profile → 重启 → 重新核对运行版本；
并把 0.16.x 五轮的改动**分刀提交**进 git。

**为什么排第一**：现在「工作树 0.16.4 / 已装与运行 0.16.3」这一行本身就是风险——
交付物与工作树不一致，而它与「59 项未提交」叠在一起，等于**没有任何可回滚的基线**。

**判据 / 退出条件**（每条都能自己跑一遍）：

1. `pnpm pack` + `node scripts/verify-pack.mjs` → 逐文件 sha256 与工作树相同、接线完好，退出 0；
2. 两个 profile 的 `node_modules/dsh-webcode-bridge/package.json` 均读到 **0.16.4**；
3. 重启后 `GET /__webcode/status` → `version=0.16.4`（哈希与本轮 build 一致）；
4. `git log origin/main..HEAD` 非空且每一刀都能独立 `git revert`；提交前逐刀跑
   `check-ledger` / `lint-comments` / `check-repo-hygiene` + 相关单测文件。

### P1 · 三条根因的真机验收（0.16.4 的判据必须在真机上读一次）

**做什么**：把本轮三条修复的真机读数取回来，逐条贴进 `progress.md`：

| 要验证的 | 真机判据（可核对） |
| --- | --- |
| 会话连续性 | 连续三轮的 `navTrace`：`requestedFresh` 全为 `false`、`messageChars` 只有首轮是四十万级；`GET /__webcode/session-slot` 与落盘文件一致 |
| 标记畸变 | 出现畸形标记的那一轮，会话里**不再有协议原文**（`POST /__webcode/history` 的 assistant 消息里搜不到标记字符） |
| 附件形态 | `POST /__webcode/attach-probe` 的 `{ ok, evidence, selector, cleaned }`；`/status.driver.attachTransport` 不再恒 `ATTACH_NOT_CONFIRMED` |

**纪律**：站点风控节制——探针间隔 ≥20s、单站点 ≤3 次，命中风控页立即停
（`doc/PROJECT-INTENT.md` §3.5）。**不做成 CI 门禁**：真机验收是人工矩阵，
由维护者按发版节奏跑（`doc/ci-cd.md` §9）。

**退出条件**：三条各有一段「读数 + 取法 + 时间」写进 `progress.md` 的 0.16.4 段；
凡没有读数的，明确写成「未验证」而不是「已修好」。

### P2 · 任务面板项目化：骨架 + 只读图 + 手工填单 + 审批态

**做什么**：按 [`REQUIREMENTS-TASKBOARD.md`](REQUIREMENTS-TASKBOARD.md) 的 R1–R6
落地数据层与读写面：插件自有存储域（`webcode-tasks/projects.json` +
`tasks-<projectId>.json`）、只读图诊断（复用 `lib/task-graph.js` / `lib/task-plan.js`）、
左侧入口与右侧标签收口、手工填单 → `awaiting-approval` → 审批后 `ready`。

**这一阶段刻意不做**：图编辑器、cron 自动派发、自动开子代理闭环。理由：
三者都依赖「调度触发者」这个还没定的问题（见 P3），先做会把一个未定的语义钉死。

**判据 / 退出条件**：

1. 同一份任务的存储 → 读回 → 审批 → `ready` 全链路有测试；删会话不丢任务；
2. 就绪（依赖满足）与可执行（资源/授权可用）**在数据结构上分开**，面板分别呈现；
3. 拿不到官方 `ctx.subagents` 时**抛可识别错误**（`TASK_DISPATCH_UNAVAILABLE`），
   绝不伪造「已派发」——这是从 0.15.x 那几族「说做了其实没做」换来的纪律；
4. 右侧标签的移除必须与左侧入口同时验证（`sidebar.panellist` 与同名 `main` 座位成对，
   上一轮已经因为「只注册一半」踩过一次，见 `doc/progress.md` 0.16.0 §二）。

### P3 · 调度与自动推进（先把语义定下来，再写代码）

**做什么**：回答 `doc/research/task-board-vs-agentteams-graph.md` §3 的五个**必须项**，
并把答案写进文档（不是先写调度器）：

| # | 必须定的语义 | 为什么必须先定 |
| --- | --- | --- |
| ① | 边是「完成即释放」还是「成功才释放」（`after-success` / `after-settle` / `after-attempt`） | 两个参考实现都只有一种，而「失败也要跑」（清理/回滚）表达不出来 |
| ② | 派发是 push（调度器唤醒）还是 pull（owner 取） | 决定「谁来叫醒一个就绪节点」；cron 的「拒绝就滚到下一次」在图上是**不可恢复的丢就绪** |
| ③ | 写边时跑**全图**环检测，自环给独立错误码 | 自环是手滑（单点错误），真环是结构错误，两者的修复路径完全不同 |
| ④ | 就绪 ≠ 资源可用（拆成两个读数） | 混在一起时「依赖全满足但没人空闲」看起来就是卡死 |
| ⑤ | 重试 ≠ 重放；「失败」与「没跑成」分开记 | 超时/取消/环境不可用都不该算任务失败，否则重试策略会误伤 |

**退出条件**：`nextRunAt` 一类的纯函数（manual / at / cron，时区 `Asia/Shanghai`）
有独立测试且覆盖非法输入；五个语义各有**一处**权威定义（文档 + 代码注释指向它），
并且面板能回答「这张图为什么没动、在等谁、还剩几个没有终态」。

### P4 · 与官方 AgentTeams 的边界收口

**做什么**：把「桥只做只读消费 + 磁盘回落」这条边界写成一条可核对的判据，
并明确**不重造**官方词汇（`blockedBy`、`ready`、`ownerName`、`writeScopes`）。

**为什么单独一阶段**：官方三件套已在两个 profile 里（0.1.5-alpha.2），桥的
`lib/roster.js` 从 0.15.0 起读 `ctx.agentTeams`、0.16.1 起在服务不可用时回落到
`.agent-teams/<teamId>/team.json` 并如实标注 `teamSource: 'service' | 'disk'`。
这条链的价值在于「卸载第三方实现之后面板仍然活着」，而它的风险是**两边各算一份真相**。

**退出条件**：`teamSource` / `tasksSource` 在任何降级路径上都不为 `null` 而撒谎；
官方服务在时仍是首选（有测试桩固定这个优先级）；磁盘解析只认官方公开的落盘格式。

### P5 · 长期质量（持续，不设终点）

- **提交欠账**：P0 之后每一次改动都当场提交；「59 项未提交」这种状态不再出现；
- **注释闸门**：`lint-comments.mjs` error 0 / warn 0 是合并前的常态（当前 104 个文件）；
- **测试基数**：台账 `单测基线` 与实际文件数由 `check-ledger.mjs` 逐字比对，**不靠人抄**；
- **God file**：`lib/index.js` / `lib/browser-driver.js` / `lib/client.cjs` 三个大文件的
  继续膨胀要有理由（见 [`CODE-STRUCTURE.md`](CODE-STRUCTURE.md) §四/§七）。

---

## 三、与官方 AgentTeams / 外部调度插件的关系

| | 位置 | 桥的关系 | 判据（可核对） |
| --- | --- | --- | --- |
| **官方 AgentTeams**（`@deepseek-ai/dsh-experimental-agent-team*`） | 已装在两个 profile（0.1.5-alpha.2） | **只读消费**：`ctx.agentTeams.listMembers/listTasks`；服务不可用时回落磁盘并标注来源 | `lib/roster.js` 的 `projectTeam` / `projectTasks`；`test/roster.test.mjs` |
| **第三方 `@nanmicoder/dsh-agent-teams`** | **已从 web profile 摘除**（0.16.1） | 不依赖、也不提供面板数据 | `~/.dsh/profiles/web/package.json` 的 `dependencies` 与 `dsh.profile.bundles` 里都已没有它 |
| **`dsh-schedule`**（外部同名插件族） | **本仓库没有它的副本**（`reference/` 下只有 `dsh-task-board` 与 `dsh-task-graph`） | **只作对照，不引入依赖**：参照它「严格时间校验」的风格写 `nextRunAt`；调度触发语义由本项目自己定（P3） | `reference/README.md` 的来源表；`doc/research/awesome-deepseek-harness-README.zh-CN.md:268,706,2983` 记录了三个同名外部项目 |
| **`reference/dsh-task-board`**（0.3.23 解包） | 只读参考 | 抄它的**幂等指纹 + 单写者锁 + 崩溃恢复**；**不抄**它「拒绝即滚到下一次」的 cron 语义 | 对照结论见 [`REQUIREMENTS-TASKBOARD.md`](REQUIREMENTS-TASKBOARD.md) §5 与 `doc/research/task-board-vs-agentteams-graph.md` §1.4/§1.5 |
| **`reference/dsh-task-graph`**（HEAD `7c230e0`） | 只读参考 | 只读其图诊断的可视化思路 | 同上 §6「两个副本不在运行链路里」 |

**一条纪律**：`reference/` 下的克隆与解包副本**都不在运行链路里**
（`doc/research/task-board-vs-agentteams-graph.md` §6）。任何「桥依赖 reference 里的某个文件」
的说法都必须先推翻这一条。

---

## 四、依赖与前置条件（不满足就别开下一阶段）

| 阶段 | 前置 |
| --- | --- |
| P1 | P0 完成（否则验的是旧装机版本——进度台账已经因为「装了没重启」返工过至少两次） |
| P2 | P1 的三条真机读数落地（任务面板要在「会话已经不乱开、协议已经不泄漏」的地基上做） |
| P3 | P2 的数据层冻结（Task 结构与存储域定了才谈调度） |
| P4 | 无（可并行），但改 `lib/roster.js` 前先读 `test/wiring-roster.test.mjs` 的头注释（0.15.0 那次静默缺陷） |

---

## 五、这份文档怎么维护

- **只写未来**：已完成的阶段保留标题与退出条件（它是判据的来源），把日期补在标题后；
- **读数必须可复现**：任何数字都写取法；写「实测」的必须有命令；
- **不复制别处的结论**：意图在 `PROJECT-INTENT.md`、状态在 `progress.md`、
  缺陷在 `long-term-issues.md`——这里只写顺序与退出条件；
- **阶段可以合并，判据不能删**：退出条件是「这一阶段有没有做完」的唯一依据。
