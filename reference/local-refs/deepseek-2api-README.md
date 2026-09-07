# deepseek-2api（本地参考存档）

> 源自 `masterzerno-commits/deepseek-2api` README，Go 编写的零依赖 DeepSeek 网页逆向代理。
> 抓取时间：2026-09-07

## 定位
把 DeepSeek 网页聊天转成 OpenAI 兼容 `/v1/chat/completions`，支持 8 个模型、SSE 流式、R1/R1 思考、工具调用、多 token 轮换、PoW 求解。

## 对本桥最有价值的工程点
1. **协议转换**：DeepSeek 网页用自定义 JSON Patch 风格 SSE（字段 `p`/`o`/`v`），实时转 OpenAI chunk：
   - `response/fragments/…/content` → `delta.content` / `delta.reasoning_content`
   - Fragment 类型 `THINK`/`THINKING` → `reasoning_content`（思考过程）
   - Fragment 类型 `RESPONSE` → `content`
   - 状态 `FINISHED` → `finish_reason: "stop"`
2. **工具调用适配（提示词模拟 + 正则解析）**：
   - 系统提示注入结构化 JSON 指令描述工具
   - 解析模型输出 `{"action":"tool_call","tool_calls":[…]}` 或 `{"action":"final","content":"…"}`
   - 增量流式解析：流式输出 `final` 内容，同时缓冲 `tool_call` 计划
   - 多格式回退：结构化 JSON → `<tool Name {json}>` → `##TOOL_CALL##`
3. **PoW 求解器**：`DeepSeekHashV1` = SHA3-256 使用 Keccak-f 仅第 1–23 轮（跳过第 0 轮），匹配官方 WASM 求解器。

## 与 deepseek-free-api 共同确认的结论
- 工具调用基于提示词模拟 + 正则解析**不稳定**，官方也建议生产环境用付费官方 API。
- 本桥驱动真实页面，让官方页面自己处理 PoW 与 token，规避了直接逆向的不稳定面。