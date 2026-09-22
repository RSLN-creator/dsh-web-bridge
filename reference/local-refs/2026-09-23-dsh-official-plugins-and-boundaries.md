# DSH 官方插件与约束协议参考（0.19.0 能力边界基线）

> 日期：2026-09-23　项目：dsh-webcode-bridge
> 用途：本条记录「0.19.0 三项能力边界」的官方参考来源，供后续 Chromium 持久登录、
>       任务板/并行界面 UI 适配时对照官方实现，避免自造协议与官方 harness 漂移。

## 一、能力边界（本次明确的三条，不得超出）

1. **Chromium 内核 + 持久登录（目标 0.19.0）**
   - 参考官方做法：DSH 官方浏览器 provider 初始引擎即 Chromium（Playwright MCP /
     Chrome DevTools MCP / Stagehand，见 `docs/subsystems/browser-use.md`）。
   - 本地做法：用本地 Chromium（当前 Edge）以 `launchPersistentContext`/`userDataDir`
     承载真实站点登录，登录态按站点持久化（默认 `~/.dsh/webcode-edge-profile`）。
   - ⚠️ 关键约束：**复制官方实现思路而不是直接使用官方 browser-use provider**；
     除具体的浏览器界面相关改动外，其余链路（协议转换、解码、token、权限）不得更改。
   - 官方持久登录边界证据：官方「live Session 内保留浏览器状态」但**不从历史会话
     恢复 cookies/profile**；我们走 userDataDir 持久 profile，两者语义不同，需注意。

2. **任务板界面 / 并行界面 UI 适配官方 harness（目标 0.19.0）**
   - 不做其它功能，只把任务板与并行界面（agent-team）的 UI 对齐官方 UI harness。
   - 官方并行界面对应物：`packages/experimental/agent-team`（逻辑）+ `client-ui-agent-team`（UI）。
   - 官方 UI harnass 契约：`packages/client/ui-slots`（index/renderer/store）+ 各 `ui-*` 包
     `lib/types/client/contract/`。

3. **拉取官方插件 + 约束协议到本地 reference**（本条已完成）
   - 来源：`deepseek-ai/deepseek-harness` 官方 monorepo + `@deepseek-ai/*` 独立 npm 包。

## 二、官方来源与版本

### 官方 monorepo（最权威，已更新到最新）
- remote：`https://github.com/deepseek-ai/deepseek-harness.git`
- 本地目录：`reference/deepseek-harness`
- HEAD：`00102833d`（`Merge pull request #4978 ... release-dsh-0.1.7-alpha.2`）
- 版本：root 包 `@deepseek-ai/dsh-root 0.1.6-alpha.2` → master 最新 0.1.7-alpha.2
- 关键子目录：
  - `packages/client/ui-*`：官方全部 UI 组件源码（sidebar-right、subagent、chat、layout、slots…）
  - `packages/boot/plugin-manager/src/`：官方插件管理协议（install-spec.ts / operations.ts / types.ts）
  - `packages/browser-use/` + `packages/experimental/browser-use-*`：官方 Chromium 浏览器 provider
  - `packages/experimental/agent-team/` + `client-ui-agent-team/`：官方并行界面
  - `SAFETY.md` / `BRAND_GUIDELINES*.md`：官方约束规范（含 .zh.md）

### 官方独立 npm 插件（已拉取到 `reference/dsh-official-plugins/`）

| 包 | 版本 | 用途 |
| --- | --- | --- |
| `dsh-client-ui-sidebar-right` | 0.1.5-alpha.1 | 官方右栏（本项目已在用） |
| `dsh-client-ui-chat` | 0.1.2-alpha.2 | 聊天 UI |
| `dsh-client-ui-session` | 0.1.2-alpha.2 | 会话 UI |
| `dsh-client-ui-subagent` | 0.0.1-rc.1 | 子代理 UI |
| `dsh-agent-preset` | 0.1.7-alpha.1 | agent preset 逻辑 |
| `dsh-browser-use` | 0.1.6-alpha.1 | 官方浏览器注册服务（Chromium provider 挂载点） |
| `dsh-experimental-browser-use-playwright-mcp` | 0.1.6-alpha.1 | Playwright MCP Chromium provider |
| `dsh-experimental-browser-use-chrome-devtools-mcp` | 0.1.6-alpha.1 | Chrome DevTools MCP provider |
| `dsh-experimental-agent-team` | 0.1.5-alpha.2 | 并行界面逻辑 |
| `dsh-experimental-client-ui-agent-team` | 0.1.5-alpha.2 | 并行界面 UI |
| `dsh-client-ui-plan` | 0.0.1-rc.1 | 计划界面（任务板相关） |
| `dsh-client-ui-jobs` | 0.0.1-rc.3 | 任务/作业 UI |

> 官方**没有**独立 `-task-board` npm 包；「任务板」官方实现位于 monorepo
> `packages/experimental/agent-team/src/task-board.ts` 与 `task-graph.ts`（源码形态）。

> 说明：官方独立包已编译分发（`lib/types/client/contract/` 含契约类型）；
> monorepo 是源码形态，做「复制实现」时应以 monorepo `packages/client/**` 为蓝本。

## 三、官方 UI harness 约束协议（对照锚点）
- ui-slots 插槽：`reference/deepseek-harness/packages/client/ui-slots/src/{index,renderer,store}.ts`
- 插件管理契约：`reference/deepseek-harness/packages/boot/plugin-manager/src/install-spec.ts`
- 浏览器契约：`reference/deepseek-harness/docs/subsystems/browser-use.md`（会话所有权、持久状态边界）
- 品牌/安全约束：`reference/deepseek-harness/{SAFETY.md,BRAND_GUIDELINES.md}` + `.zh.md`
- 插件开发官方文档页：https://deepseek-harness.github.io/deepseek-harness/develop/basic/

## 四、口径提醒（与官方一致的判断依据）
- dsh npm org 有 354 包；官方独立 UI 包版本普遍 alpha，说明官方仍在迭代，
  做「复制实现」时以 master monorepo 源码为准、npm 包为分发抽查参考。
- 「任务板」官方**没有**独立 `-task-board` 包（`@linxin666/dsh-client-ui-task-board` 是第三方，
  已按 0.3.23 拉在 `reference/dsh-task-board`）；官方并行对应 **agent-team**，UI 适配应优先对齐它。