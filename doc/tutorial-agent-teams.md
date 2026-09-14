# 教程：官方 Agent Teams 插件

本文件是**入库长期文档**，记录 `@deepseek-ai/dsh-experimental-agent-team-profile` 的确切身份、
安装方式、用法与边界。取证口径：包身份来自 npm registry 元数据，用法来自 tarball 内实际
发布的 `README.zh.md` 与 `cordis.patch.yml`（不抄二手介绍）。

安装与验证时间：2026-09-14。目标 profile：`web`。

## 1. 这个插件到底是什么

「官方 agents team 插件」的确切身份是 **DeepSeek Harness 官方 monorepo 里的一组实验性包**，
不是一个社区插件。

| 项 | 值 |
| --- | --- |
| 仓库 | `github.com/deepseek-ai/deepseek-harness` |
| 目录 | `packages/experimental/agent-team`、`packages/experimental/agent-team-profile`、`packages/experimental/tool-agent-team` |
| 维护者 | `imccyu`、`tianyicui-deepseek` |
| 许可证 | MIT |
| 状态 | **实验原型，无稳定性承诺**（包名自带 `experimental`） |
| 已发布版本 | 只有 `0.1.5-alpha.2`、`0.1.5-rc.1`、`0.1.5-rc.2` |

它由三个包组成，职责分离：

| 包 | 角色 |
| --- | --- |
| `@deepseek-ai/dsh-experimental-agent-team-profile` | **安装单元**。声明 `dsh.bundle.patch`，依赖下面两个包。装它即可 |
| `@deepseek-ai/dsh-experimental-agent-team` | Team 领域服务：持久名册（roster）、对等信箱（mailbox）、共享任务板（task DAG） |
| `@deepseek-ai/dsh-experimental-tool-agent-team` | 面向模型的 9 个 Team-scoped 工具 |

profile 包本身**没有运行时逻辑**——它的运行时内容就是那份 `cordis.patch.yml`。

## 2. 为什么锁 0.1.5-rc.1（而不是 rc.2）

这是本机最关键的兼容性判断，值得单独记一条。

本机 DSH 核心是 **`0.1.5-rc.1`**（`dsh --version`），核心包解析根
`C:\Users\rsyhn\.dsh\profiles\node_modules\@deepseek-ai\*` 下的
`dsh-agent` / `dsh-session` / `dsh-tools` / `dsh-invariants` / `dsh-typert-protocol` /
`dsh-session-projection` / `dsh-session-persistence` / `dsh-subagent` 全是 `0.1.5-rc.1`。

而两个子包的 peer 范围随版本变化：

| 包版本 | peer 范围 | 与本机 `0.1.5-rc.1` 的关系 |
| --- | --- | --- |
| `0.1.5-rc.1` | `^0.1.5-rc.1` | **满足** |
| `0.1.5-rc.2` | `^0.1.5-rc.2` | **不满足**（要求 ≥ rc.2） |

而 `profile` 包对自己两个依赖的声明是 `^0.1.5-rc.1`（caret），语义上允许解析到 rc.2。
**实测确实会解析到 rc.2**：第一次只装 `profile@0.1.5-rc.1` 后，pnpm 装进来的
`dsh-experimental-agent-team` 与 `dsh-experimental-tool-agent-team` 都是 **0.1.5-rc.2**，
于是 peer 要求 `^0.1.5-rc.2` 而本机只有 rc.1 —— 这是一个**装得上但 peer 不满足**的坑，
pnpm 只打了 `[WARN] Issues with peer dependencies found`，退出码仍是 0。

修法：把两个子包**显式钉到 rc.1**。

```powershell
dsh plugin --profile web add '@deepseek-ai/dsh-experimental-agent-team-profile@0.1.5-rc.1'
dsh plugin --profile web add '@deepseek-ai/dsh-experimental-agent-team@0.1.5-rc.1' '@deepseek-ai/dsh-experimental-tool-agent-team@0.1.5-rc.1'
```

装完要核对的是**解析后的版本**，不是命令退出码：

```powershell
foreach ($p in @('@deepseek-ai/dsh-experimental-agent-team-profile','@deepseek-ai/dsh-experimental-agent-team','@deepseek-ai/dsh-experimental-tool-agent-team')) {
  $j = Get-Content "C:\Users\rsyhn\.dsh\profiles\web\node_modules\$p\package.json" -Raw | ConvertFrom-Json
  "$p = $($j.version)"
}
```

三个都必须是 `0.1.5-rc.1`。

> 通用的：`dsh plugin --profile <p> add` 是 pnpm 的薄封装，它会把**声明了
> `dsh.bundle.patch` 的依赖自动追加**进 profile 的 `dsh.profile.bundles`，
> 无需手工编辑那个数组。反过来，只声明为普通依赖的包会打一条
> `declares no dsh.bundle — installed as a plain dependency, not a profile layer` 警告，
> 这是**正常**的：两个子包本来就不该单独成为 profile 层。

## 3. 安装（本机实际执行的步骤）

前置：web profile 必须已含 `@deepseek-ai/dsh-base`（本机有，是 bundles 第一项）。

```powershell
# 1) 安装。本机 pnpm install 会因无关依赖 dsh-loopx-plugin 的证书问题整体失败，
#    所以务必带 NODE_OPTIONS（Node 24 用系统证书库）。
$env:NODE_OPTIONS='--use-system-ca'

# 2) 安装单元 + 把两个子包钉到 rc.1（见 §2）
dsh plugin --profile web add '@deepseek-ai/dsh-experimental-agent-team-profile@0.1.5-rc.1'
dsh plugin --profile web add '@deepseek-ai/dsh-experimental-agent-team@0.1.5-rc.1' '@deepseek-ai/dsh-experimental-tool-agent-team@0.1.5-rc.1'

# 3) 重启 DSH 让它生效
dsh web
```

### 装完必须核对的三件事

1. **三个包解析版本都是 `0.1.5-rc.1`**（命令见 §2）。
2. **`dsh.profile.bundles` 里出现了 `@deepseek-ai/dsh-experimental-agent-team-profile`**，
   且原有 11 项一个不少：

   ```powershell
   (Get-Content "C:\Users\rsyhn\.dsh\profiles\web\package.json" -Raw | ConvertFrom-Json).dsh.profile.bundles
   ```

3. **离线组合验证**（不需要重启，不会 boot，不会跑 `!!js`）：

   ```powershell
   dsh --profile web --dump-config
   ```

   输出里应能看到名为 `@deepseek-ai/dsh-experimental-agent-team-profile` 的层，
   内容含 `- id: agent-team` 与 `- id: tool-agent-team` 两个 insert 行。

### 本机安装实测记录（2026-09-14）

- 四个包（三个 agent-team + `dsh-local-link`）逐文件 SHA256 与 tarball 比对：
  `8/8`、`43/43`、`7/7`、`22/22` **零差异**。
- pnpm 输出里的 `Packages: +5 -19` 是**重新链接的噪声，不是删除**。
  当时立刻核对了 10 个原有依赖目录与 11 个原有 bundle 项，全部在位。
  **教训：不要用 `+N -M` 判断是否被删，要直接核目录与 manifest。**

## 4. 它给你什么 / 拿走什么

### 新增：9 个 Team-scoped 工具

分四类（来自 `tool-agent-team` 包 README，已发布文本）：

| 类别 | 工具 |
| --- | --- |
| 创建 teammate | `spawn_teammate`（**仅 Lead 可调**） |
| 发消息 | `send_message` |
| 查看与等待 | `list_agents`、`wait_agent`、`interrupt_agent`（interrupt **仅 Lead**） |
| 任务板 | `team_task_create`、`team_task_list`、`team_task_get`、`team_task_update` |

任何成员都能给任何成员发消息、都能用任务板；**只有 Lead 能创建与中断 teammate**。

### 替换：全局 continuable-child 控件被禁用

patch 里明确做了两处 `disabled: true`：

- `tool-subagent-control`
- `tool-subagent-list-agents`

原因写在 patch 注释里：Team 工具注册了**同名**的 `list_agents`、`send_message`、
`interrupt_agent`，必须先移除全局的 continuable-child 控件，才能避免重名冲突。

同时把两个一次性委派工具保留为 one-shot：

```yaml
- id: tool-subagent
  config: { provider: spawn, toolName: subagent, backgroundMode: one-shot }
- id: tool-subagent-fork
  config: { provider: fork, toolName: subagent_fork, backgroundMode: one-shot }
```

### 可调限制（patch 内默认值）

| 字段 | 默认 | 含义 |
| --- | --- | --- |
| `maxMembers` | 8 | 一支团队最多创建的 teammate 数（含失败的） |
| `maxTasks` | 256 | 任务板上最多的活动任务数 |
| `maxPendingMessagesPerMember` | 64 | 单成员最多排队消息数 |
| `maxMessageBytes` | 65536 | 单条消息最大字节数 |
| `disposalTimeoutMs` | 5000 | 关闭清理允许时间 |
| `freshProvider` / `forkProvider` | `spawn` / `fork` | teammate 的创建 provider |

要改这些值，编辑 web profile 的 `cordis.patch.yml` 里对应的 `agent-team` / `tool-agent-team`
插入行的 `config`，而不是改包内文件。

## 5. 怎么用

### 核心心智模型

- 你的**普通会话**就是 Lead。每个运行时 root 都是一个隐式 Team 的 Lead，
  `TeamId` 等于 `SessionId`——**不需要任何「建队」动作**。
- 你说「创建一个叫 reviewer 的 teammate 检查 diff」，模型调 `spawn_teammate`。
- teammate 名字是**永久的**：即使创建失败也保留名字，**名字永不复用**。
- teammate 有两种：**fresh**（不带 Lead 对话记忆）与 **fork**（继承 Lead 已完成的轮次前缀）。
  由创建请求决定。
- 名册状态：`running` / `idle` / `inactive`（存在但未加载）/ `provisioning` / `failed`。
  未加载的成员会在**被唤醒后**收到排队消息。

### 最小可用示例（官方 README 原文场景）

直接对 Lead 说：

```
创建一个名为 reviewer 的 teammate 检查 diff，再把变更摘要发给 reviewer
```

模型会先调创建工具，再调消息工具。

### 消息语义（重要，容易误用）

- 发消息**在安全存储后即算成功**，结果是 `accepted`（已送达）或 `queued`（等待中）。
- **排队的消息已经安全存储，绝不能重发**——重发会导致重复。
- 投递机制是 Steer：running target 在**最近的步骤边界**收到；idle target 启动一个轮次；
  inactive teammate 冷恢复。
- `wait_agent`：当没有其他成员处于 running / provisioning 时**立即返回 `noProgress`**，
  这是在提示你「先唤醒 teammate」；否则等到下一次变化，然后你**重新读取状态**。
  它只报告是否超时，不返回状态本身。

### 任务板

- 任务有：标题、详情、对其它任务的可选**依赖**、可选**文件触及提示**（`writeScopes`）。
- **只有全部依赖完成后任务才可 claim**。
- 每次变更是 compare-and-set：基于过期 `expectedRevision` 的编辑会被**拒绝**
  （`TEAM_TASK_STALE_REVISION`），而不是覆盖更新的成果。
- `writeScopes` 只对**两个 in-progress 任务触及重叠路径**发**警告**，绝不阻止任何操作、
  也绝不授予写权限。

## 6. 边界与已知限制（官方明文，别指望它做不到的事）

- **不会自主建队**——固定策略只在明确要求团队或 teammate 时才创建成员；普通任务不会自行触发委派。
- **单进程、共享 checkout**——所有 teammate 观察**同一个工作目录**，改动立即可见。
  不提供 worktree 隔离、远端成员、merge 或文件锁。
- **`write scope` 只是提示**——Bash、formatter、代码生成器与任何直接外部写入
  **可以绕过**文件版本检查。Lead 必须自己协调 owner 并检查最终 diff。
- **扁平且不可变的 roster**——只有 Lead 能创建**直接** teammate；不支持嵌套 Team、
  重命名、删除或名字复用。
- **不会自动释放 owner**——idle、interrupt、进程退出、工作失败都**不**释放任务 owner。
- **mailbox 不保证跨进程 exactly-once**——不支持多个 harness 进程并发操作同一 Team。
  其保证是「进程内重试 + target Session 去重」。
- **没有 Web 控制功能**——浏览器里的 roster 与任务板呈现**不属于**这个运行时包
  （`agent-team` 包提供了 Remote method，但 Web 挂载是另一件事）。
- **需要持久会话存储**才能激活（本机 `dsh-session-persistence-jsonl` 已在 base 里）。

## 7. 与内置 `subagent` / `workflow` 的分工

装了这个插件之后，你的工具目录里**同时**有：

- `subagent` / `subagent_fork`（一次性，one-shot）——用完即走，子代理**拿不到**
  continuable-child 的 `report` 工具；
- 9 个 Team 工具——持久名册、持久信箱、共享任务板。

选择原则：

| 场景 | 用哪个 |
| --- | --- |
| 一次性、互不依赖的独立调研/审查 | `subagent`（更轻） |
| 需要多轮来回、需要消息能挺过重启、需要共享任务依赖关系 | Team 工具 |
| 对大量文件做同一模式的扇出审计 | `workflow` |

注意：Team 工具是 **scoped** 注册——它们只出现在 Team member scope 里，
非 Team 的 subagent 保持默认工具目录。

## 8. 卸载与回滚

```powershell
$env:NODE_OPTIONS='--use-system-ca'
dsh plugin --profile web remove '@deepseek-ai/dsh-experimental-agent-team-profile'
dsh web
```

移除 bundle 时 `dsh.profile.bundles` 里的对应项会自动移除。

回滚到装之前：用备份覆盖 manifest 再 `pnpm install`。

```powershell
Copy-Item "C:\Users\rsyhn\.dsh\profiles\web\package.json.bak-2026-09-14-addplugins" `
          "C:\Users\rsyhn\.dsh\profiles\web\package.json" -Force
Copy-Item "C:\Users\rsyhn\.dsh\profiles\web\pnpm-lock.yaml.bak-2026-09-14-addplugins" `
          "C:\Users\rsyhn\.dsh\profiles\web\pnpm-lock.yaml" -Force
cd C:\Users\rsyhn\.dsh\profiles\web; pnpm install
```

## 9. 故障排查

| 现象 | 原因与处置 |
| --- | --- |
| `pnpm peers check` 报 agent-team 子包 peer 不满足 | 子包被解析成 rc.2 了。按 §2 显式钉回 rc.1 |
| `dump-config` 里看不到 `agent-team` 插入行 | profile 包没进 `dsh.profile.bundles`。检查它是否真的声明了 `dsh.bundle.patch`，并重跑 `add` |
| 全局 `list_agents` / `send_message` 行为变了 | 这是**预期**的：Team 工具按设计取代了同名全局 continuable-child 控件 |
| 装了但重启后毫无变化 | 确认重启的是 **web** profile；确认 `dsh --version` 与子包 peer 匹配 |
| 想同时保留旧全局 subagent 控件 | **做不到**——官方 README 明说想同时用两者必须禁用旧定义，本 patch 已经这么做了 |

`dsh --profile web --dump-default-config` 会打印**不含用户层**的 bundle 层列表，
当 profile 的 `cordis.patch.yml` 被改坏时，用它可以先把用户层排除掉再定位。

## 10. 参考出处

- npm：`@deepseek-ai/dsh-experimental-agent-team-profile@0.1.5-rc.1`
  （shasum `2126c0c847093845e9b085f0959335add2cefc30`）
- npm：`@deepseek-ai/dsh-experimental-agent-team@0.1.5-rc.1`
  （shasum `e58573c2bc780adc9bed285719bdee1d306308ee`）
- npm：`@deepseek-ai/dsh-experimental-tool-agent-team@0.1.5-rc.1`
  （shasum `9ce64f673074c9018749721c85bf64a759f1ac7c`）
- 包内 `README.zh.md`（三个包都带中文 README）与 `cordis.patch.yml`
