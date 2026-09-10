---
type: gene
tags: [gene/dsh, gene/web-bridge, gene/prompt]
created: 2026-09-10
---

# DSH 的工具规则在 tools.description 里，不在系统提示词里

## 输入
- 要给 webcode 桥写「首轮预设」——教网页模型有哪些本地工具、怎么调用
- 直觉做法：抄 DSH 的真实系统提示词。**抄不到东西**，因为那里根本没写工具规则。

## 执行
- 查证安装本体（不要信插件里的转述）：
  `%APPDATA%\npm\node_modules\@deepseek-ai\dsh\config\agent-presets\*\agent.cordis.yml`
- DSH 的系统提示词只有两段：`@deepseek-ai/dsh-system-prompt` 注册的
  `harness:identity`（原文 `You are an AI agent powered by DeepSeek Harness.`）
  与 persona。persona 由预设给，`complete: true` 时它**就是全文系统提示词**：
  - 极简模式：`You are a helpful software engineer assistant.`（complete，运行时上下文被抑制，**无压缩**）
  - 标准/PTC 模式：`You are a coding agent powered by the {{model}} model. Your working directory is {{cwd}}.`
- 工具规则由 API 的 `tools` 数组承载，**每条工具的 `description` 本身就是提示词**。
  实测最长约 400 字符（`dsh-tool-fs` 373、`dsh-tool-fs-search` 375、
  `dsh-tool-subagent` 397），硬约束写在里面，例如 `dsh-tool-pwsh-persistent` 的
  `Use native Windows paths (C:\...) and $env:NAME variables; this is PowerShell, not bash.`
- 结论：网页桥的首轮预设是工具规则的**唯一载体**，`description` 必须原样搬运。

## 环境依赖
- `lib/agent-preset.js` 的 `buildPreset`（描述上限 `MAX_TOOL_DESC_CHARS = 1200`）
- DeepSeek 网页模型没有原生 function calling，只能靠文本协议

## 常见陷阱
- 截断工具描述＝截断规则：旧实现 `slice(0, 300)` 正好砍掉上面那句路径约束，
  真机轨迹里约一半工具错误是模型用 `ls -la`、`&&` 打 Windows。
- DSH 的 persona 不保证带平台信息（极简模式那句里既没有平台也没有 cwd），
  预设里要自己补一行运行环境。
- 别把网页桥的预设和 DSH 系统提示词对齐成同一份文本：前者要教文本协议，
  后者是给原生 function calling 的，混用会两头不讨好。
