# deepseek-harness（官方 DSH 源码）

- **来源（官方）**：https://github.com/deepseek-ai/deepseek-harness.git —— DeepSeek 官方组织
  `deepseek-ai` 下的 DSH（DeepSeek Harness）monorepo。npm 包 `@deepseek-ai/dsh`
  （本机安装 0.1.6-alpha.2，`AppData/Roaming/npm/node_modules/@deepseek-ai/dsh`）的
  `package.json.repository` 指向本仓库的 `apps/cli` 目录。
- **用途**：工具调用的**官方协议基线**。官方 LLM 层（`packages/llm/llm-deepseek/src/protocols/`
  的 chat-completions / messages）走 **API 原生 function calling**（请求带 `tools`、
  响应用结构化 `tool_calls`），没有文本协议、没有解析失败问题。
  本桥（webcode）因网页只吐文本被迫走文本协议，网页模型的 `｜｜DSML｜｜` 标记
  **不出现在官方仓库任何地方**——它是网页端内部格式，模型对它无稳定先验，持续漂移。
- **对照要点**：内置工具表（本会话 32 个：read/grep/glob/edit/pwsh/cordis_inspect_list/
  cordis_inspect_query/web_search/x_search/…）；无参工具的 schema 是
  `parameters: {type:"object", properties:{}}`。
- **克隆时间**：2026-09-19。不入库（`reference/*/` 约定），本文件记录来源与用途。
