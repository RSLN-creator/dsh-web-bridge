# Agent Teams 参考笔记（官方实验包）

调研时间：2026-09-14。来源：**已发布的 tarball 内容**（SHA1 与 registry 声明逐字核对通过），
不是二手介绍。本文件是 `reference/` 的调研笔记（`.gitignore` 白名单 `!reference/local-refs/`，**可入库**）。

> 口径说明：凡「官方明文」都指包内已发布的 `README.md` / `README.zh.md` / `cordis.patch.yml` 原文；
> 凡「本项目推断」都单独标注。不做推测性归因。

## 1. 身份

| 项 | 值 |
| --- | --- |
| 仓库 | `github.com/deepseek-ai/deepseek-harness` |
| 目录 | `packages/experimental/{agent-team,agent-team-profile,tool-agent-team}` |
| 维护者 | `imccyu`、`tianyicui-deepseek` |
| 许可证 | MIT |
| 状态 | **实验原型，无稳定性承诺** |

三个包（职责分离）：

| 包 | 角色 | 已装版本 | shasum（SHA1） |
| --- | --- | --- | --- |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | **安装单元**，`dsh.bundle.patch` | 0.1.5-rc.1 | `2126c0c847093845e9b085f0959335add2cefc30` |
| `@deepseek-ai/dsh-experimental-agent-team` | Team 领域服务（roster/mailbox/task） | 0.1.5-rc.1 | `e58573c2bc780adc9bed285719bdee1d306308ee` |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | 9 个 Team-scoped 模型工具 | 0.1.5-rc.1 | `9ce64f673074c9018749721c85bf64a759f1ac7c` |

本目录 `reference/agent-team/{profile,service,tools}/` 是这三个包的**源码副本**（已排除 `node_modules`），
`reference/*/` 被 `.gitignore:9` 排除，**不入库**——与其余 31 个参考项目同规格。

## 2. rc.1 vs rc.2：本机最关键的兼容结论

只发布过 `0.1.5-alpha.2` / `0.1.5-rc.1` / `0.1.5-rc.2`。两个子包的 peer 随版本变：

| 包版本 | peer 范围 | 与本机核心 `0.1.5-rc.1` |
| --- | --- | --- |
| `0.1.5-rc.1` | `^0.1.5-rc.1` | **满足** |
| `0.1.5-rc.2` | `^0.1.5-rc.2` | **不满足**（要求 ≥ rc.2） |

而 `profile` 包对两个子包的依赖写的是 `^0.1.5-rc.1`（caret），**语义上允许解析到 rc.2，实测也确实会**。
结果：只装 `profile@0.1.5-rc.1` 时，pnpm 会把两个子包装成 **0.1.5-rc.2**，peer 要求 `^0.1.5-rc.2`
而本机只有 rc.1 → **装得上但 peer 不满足**，pnpm 只打 `[WARN] Issues with peer dependencies found`，
**退出码仍是 0**。

**结论：必须把两个子包显式钉到 rc.1。**

```powershell
dsh plugin --profile web add '@deepseek-ai/dsh-experimental-agent-team-profile@0.1.5-rc.1'
dsh plugin --profile web add '@deepseek-ai/dsh-experimental-agent-team@0.1.5-rc.1' '@deepseek-ai/dsh-experimental-tool-agent-team@0.1.5-rc.1'
```

核对的是**解析后版本**，不是退出码（见 `doc/tutorial-agent-teams.md` §2）。

## 3. composition 语义（`cordis.patch.yml` 原文）

```yaml
- id: tool-subagent-control
  disabled: true
- id: tool-subagent-list-agents
  disabled: true
- id: tool-subagent
  config: { provider: spawn, toolName: subagent, backgroundMode: one-shot }
- id: tool-subagent-fork
  config: { provider: fork, toolName: subagent_fork, backgroundMode: one-shot }
- insert:
    - id: agent-team
      name: '@deepseek-ai/dsh-experimental-agent-team'
      config: { maxMembers: 8, maxTasks: 256, maxPendingMessagesPerMember: 64, maxMessageBytes: 65536, disposalTimeoutMs: 5000 }
    - id: tool-agent-team
      name: '@deepseek-ai/dsh-experimental-tool-agent-team'
      config: { freshProvider: spawn, forkProvider: fork }
```

关键点（官方 patch 注释原文）：**Team 工具注册了与全局 continuable-child 控件同名的
`list_agents` / `send_message` / `interrupt_agent`，所以必须先禁用全局那两行**，否则重名冲突。

## 4. 九个工具与语义

| 类别 | 工具 | 权限 |
| --- | --- | --- |
| 创建 teammate | `spawn_teammate` | **仅 Lead** |
| 发消息 | `send_message` | 任何成员 |
| 查看/等待 | `list_agents`、`wait_agent`、`interrupt_agent` | interrupt **仅 Lead** |
| 任务板 | `team_task_create`、`team_task_list`、`team_task_get`、`team_task_update` | 任何成员 |

可复用的语义细节：

- **发送即成功**：结果为 `accepted`（已送达）或 `queued`（等待中）；**排队的消息绝不能重发**。
- 投递用 Steer：running 在**最近步骤边界**收到；idle 启动一轮；inactive **冷恢复**。
- `wait_agent`：无成员 running/provisioning 时**立即返回 `noProgress`**，只报告是否超时，调用方随后重读状态。
- 任务板：**CAS + `expectedRevision`**，过期编辑被拒（`TEAM_TASK_STALE_REVISION`），不覆盖新成果。
- `writeScopes`：**只对两个 in-progress 任务路径重叠发警告，绝不阻止、绝不授权**。
- teammate 名字**永久**，创建失败也保留，**永不复用**。

## 5. 官方明文限制（务必尊重，不要假装有）

- **单进程、共享 checkout**：所有 teammate 看**同一个 cwd**，改动立即可见；**无 worktree 隔离、无文件锁**。
- **write scope 仅是提示**：Bash / formatter / codegen / 外部写入**可绕过**文件版本检查。
- **扁平不可变 roster**：只有 Lead 能创建**直接** teammate；无嵌套 Team、无重命名、无删除、无名字复用。
- **owner 不自动释放**：idle / interrupt / 进程退出 / 失败都不释放任务 owner。
- **mailbox 不保证跨进程 exactly-once**：保证是「进程内重试 + target Session 去重」。
- **不会自主建队**：固定策略只在明确要求团队/teammate 时创建成员。
- **需持久会话存储**才能激活（本机 `dsh-session-persistence-jsonl` 已在 base 层）。

## 6. 已装状态（2026-09-14）

- web profile `dependencies` 含三个包，全部 `0.1.5-rc.1`；`dsh.profile.bundles` 含
  `@deepseek-ai/dsh-experimental-agent-team-profile`，原有 11 项一个不少。
- 三包 + `dsh-local-link` 安装副本与 tarball 逐文件 SHA256：`8/8`、`43/43`、`7/7`、`22/22` **零差异**。
- `dsh --profile web --dump-config` 确认 `# == @deepseek-ai/dsh-experimental-agent-team-profile` 层存在，
  含 `- id: agent-team` 与 `- id: tool-agent-team`。
- 回滚备份：`profiles/web/{package.json,pnpm-lock.yaml,pnpm-workspace.yaml}.bak-2026-09-14-addplugins`。

## 7. 融入本项目：设计方向（**待实现，本轮不做**）

用户明确要求「team 这个最后实现」。以下只记方向，不实现。

### 7.1 官方认可的挂载形态（应优先参考，而非另造）

`agent-team` 包除了 roster/mailbox/task 服务，还**直接生成** Remote method：
`agentTeams/view`、`agentTeams/createTask`、`agentTeams/updateTask`；
`./remote` 导出由 Web UI 挂载的 Client contribution，`./client` 重新导出可在浏览器
compilation face 安全使用的 request/view/task mutation 类型。

> 即：**官方自己就把「Team 面板」做成了 remote + client contribution**，这是最该参照的形态。

### 7.2 与本项目既有立场的对齐

| 本项目既有决定 | 与 Team 面板的关系 |
| --- | --- |
| 右栏使用 **DSH 官方右侧栏**（不依赖第三方侧栏插件） | Team 面板应挂成官方右栏的一个标签页，不另起侧栏 |
| 工具名/语义尽量沿用既有生态 | 若暴露 Team 能力，**沿用官方九个工具名与语义**，不另造 |
| 写作用域是**建议而非锁** | 与官方 `writeScopes` 立场一致，可直接对齐 |
| scoped 注册避免污染普通会话 | 照抄：Team 工具只注册在 Team member scope |

### 7.3 「并行界面显示不同」

- **一个 teammate 一个面板/标签**，展示其 roster 状态（`running`/`idle`/`inactive`/`provisioning`/`failed`）、
  消息、任务归属。
- 但**必须尊重单进程共享 checkout**：并行的是**会话与呈现**，不是文件系统。
  任何「看起来像隔离」的呈现都是误导——官方明文没有 worktree、没有文件锁。
- 接入 agents 进程：Team 服务是**进程内**的，同进程多 agent；不要假装跨进程编排。

### 7.4 同站多账户（用户要求：可选择 + 可显示）

现状：`lib/providers.js` 站点契约 + `lib/browser-driver.js` 按站点持久化登录态
（`webcode-sessions-<site>.json`）——**一个站点当前只有一份登录态**。

设计要点：

- **账户槽**：把「站点级单份 profile」扩为「站点 × 槽」，槽 id 形如 `<siteId>#<slot>`；
  **默认槽保持 `<siteId>`**，历史设置值必须仍可解析（0.14.0 已确立的纪律）。
- **持久化**：每槽独立 profile 目录 `webcode-edge-profile/<siteId>/<slot>`；会话槽文件按槽拆分。
- **模型 id**：沿用 `site:model`，扩为 `site@slot:model`，**保留别名解析**。
- **显示**：模型选择器分组里站点名后追加槽标签（如 `deepseek (账户2)`）；
  下拉去重逻辑需同时考虑槽。
- **发送间隔**：`sendGapMs` 是**站点级还是槽级**必须显式决定。
  倾向**槽级**（不同账户是不同登录态，风控独立），并在设置页文案写清。

### 7.5 风控纪律（写进实现前提，不是可选项）

- **反复深链同一会话地址会触发站点风控**（0.14.3 事故已实证）：探针间隔 **≥20s、最多 3 次**。
- **风控页 ≠ 未登录**：`detectChallenge` 必须在 `judgeLoggedIn` **之前**判定；
  `navReason='challenge-page'` 与「会话过期」分开报。
- 多账户会**成倍**增加同一站点的登录/探针次数 → 风控风险成倍。
  实现时必须：每槽独立限流、探针串行化、默认不并发探测。
