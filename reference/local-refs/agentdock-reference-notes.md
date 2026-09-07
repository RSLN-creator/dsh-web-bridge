# AgentDock 等智能体工程参考（本地存档）

> 抓取时间：2026-09-07。同名「AgentDock」多个项目，按与 dsh-webcode-bridge 关联度整理。

## 1. AgentDock — AI 编码会话汇诊台（vishalnarkhede/agentdock）
- Mission control for parallel Claude Code / Cursor Agent sessions
- Isolated git worktrees、Live working / waiting / done status、Plans and diffs before merge
- Local-first（本机、无云）
- → 参考点：把「并行 agent 会话」做成独立可并行的隔离会话（本桥已按 `sessionId::agentId` 隔离网页会话），并给出工作/等待/完成状态与 diff 预览。

## 2. AgentDock — 独立工具运行时（uvwt/agentdock）
- 为 AI 智能体提供统一、安全、受控的 file / command / git / Skill / MCP / 浏览器自动化 / 任务执行
- 可连接多设备，一个 AI 会话操作多台设备
- → 参考点：工具执行器与「真实环境执行」的思路，与 Harness 原生本地工具执行器一致；确认「浏览器自动化 + 本地工具」组合是 Agent 基础设施的通用组成。

## 3. AgentDock — Agent 框架（AgentDock/agentdock）
- AgentDock Core：backend-first 的开源 Agent 构建框架，framework-agnostic / provider-independent，可配置确定性（determinism）
- Open Source Client：Next.js 参考实现
- → 参考点：provider 无关 + 可配置确定性，与本桥「provider contract 先行、多站点 adapter」路线契合。

## 对 dsh-webcode-bridge 的落点
- 「并行 agent 会话」能力与 AgentDock 汇诊台诉求一致：本桥已按 `sessionKey = sessionId::agentId` 为每个 agent 分配独立网页会话，互不串扰。
- 工具执行交由 Harness 原生（本地真实执行）而非网页模拟，正是 AgentDock 工具运行时强调的「统一安全受控执行」。
- 后续多站点扩展可借鉴「先抽 provider contract，再分别实现 ChatGPT / Gemini adapter」的确定性分层。