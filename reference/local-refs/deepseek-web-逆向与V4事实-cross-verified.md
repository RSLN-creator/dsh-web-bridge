# DeepSeek 网页版逆向与新模型事实（cross-verified 2026-09）

> 两份独立 Explore 调研交叉验证的结论，含权威来源。对应问题：为什么网页一直思考/思考浅/不实操作/上下文是否 1M/提示词。

## 1. 网页版 `/api/v0/chat/completion` 请求载荷（事实）

加"深度思考(DeepThink/R1)"后，请求体核心字段：

```json
{
  "chat_session_id": "<uuid>",
  "parent_message_id": null /* 数字，首轮 null，后续递增 */,
  "prompt": "用户文本",
  "ref_file_ids": [],
  "model_type": "expert",        /* 关键：only "default" | "expert" */
  "thinking_enabled": true,      /* expert 下常强制 true */
  "search_enabled": false,
  "preempt": false,
  "stream": true
}
```

- `model_type` 映射：`"default"`=一般/快速(V4-Flash)，`"expert"`=专家/深度思考(V4-Pro)，`"vision"`=识图模式。
- ⚠️ **【真机修正 2026-09-07】存在独立的 `model_type:"vision"`**。早前二手调研误判"无独立 vision、Vision 仍上报 default"，据此把期望映射错改成 `vision→default` 导致识图严格校验误报 MODEL_UI_CHANGED。real-probe-08/10 真机实测确认识图请求上报 `model_type:"vision"`，正确期望映射应为 `vision→'vision'`，已修正。
- PoW：需先 `POST /api/v0/chat/create_pow_challenge` 得 `DeepSeekHashV1` 挑战，算出答案放请求头 `X-Ds-Pow-Response`（我们走真实浏览器注入脚本，由页面原生处理，已覆盖）。
- 认证：网页用 `Authorization: Bearer user_token` + Cookie（`cf_clearance` 等）；官方 API 用 API Key。
- SSE 格式不同：网页版是 `ready/toast/hint` 事件 + `p/o/v` 数据帧，expert 用 `v.response.fragments:[{type:"THINK"|"RESPONSE",content}]`；官方 API 是 OpenAI 兼容 `data:` 帧。两者不能混用。

## 2. 官方模型与上下文（事实）

- **DeepSeek-V4 Preview**：所有官方服务默认上下文 **1M tokens**（`deepseek-v4-flash`、`deepseek-v4-pro`）。
- `deepseek-chat`、`deepseek-reasoner` 为旧模型，2026-07-24 后停用并路由到 V4 Flash 的非思考/思考模式。
- 思考开关/强度：`{"thinking":{"type":"enabled/disabled"}}`，`reasoning_effort` 支持 `high/max`（`low/medium→high`、`xhigh→max`）；Claude Code/OpenCode 类复杂 agent 自动 `max`。
- 思考模式不支持/不生效：`temperature/top_p/presence_penalty/frequency_penalty`。
- 网页版上下文是否等同 1M：未找到权威直接来源，仅能确认与官方用同源底层模型/模式，工程上按 1M 假设但勿依赖。

## 3. 为什么"不主动思考/思考浅/只有明确让做才做"（事实 + 归因）

- 深度思考是**显式开关**（网页按钮/`thinking_enabled`），不是自动常驻——普通说法不触发深度思考是设计使然。
- DeepSeek-R1 官方 README：**官方网页/App 不用 system prompt**，所有指令放进 user prompt；用空串+换行引导推理（推荐 `\u200b thinking\n` 前缀以"强制"推理、防止跳步）。
- 工具调用不是模型自带，需要**显式的 tool-loop + 明确告诉它"必须调用而非描述"**。只把工具列在 schema 里，模型可能"只描述不调用"；显式指令如 *"依赖真实数据时必须调用工具，不要只描述将做什么"* 能显著改善。
- 工具 description 本身就是 prompt engineering（Anthropic 官文）：好的描述会进上下文、提升选择与参数正确性。

## 4. 对本项目（dsh-webcode-bridge）的工程启示（已落实/待落实）

- ✅ 已修（真机）：web 真实 `model_type` 含 `default/expert/vision` 三种；识图(Vision) 上报 `model_type:"vision"`。早期二手调研误判"仅 default/expert、Vision 上报 default"，导致把期望映射错改成 `vision→default` 而误报；真机修正为 `vision→'vision'`（real-probe-08/10 已验证）。
- ✅ 已落实：preset 把系统/工具/协议都并进**首条 user 文本**（非 system 角色），符合官方"指令进 user prompt"；并强化"依赖真实数据必须调用工具、拿到结果即简洁收束"。
- ✅ 已修：工具 `arguments` 支持"转义 JSON 字符串"（OpenAI 风格），避免参数被丢→工具空参失败→empty response。
- ⏳ 待实机：连真实账号逐模式核对 `model_type`/思考开关 DOM 与 SSE `p/o/v` 解码；确认库深。

## 来源
- [deepseek-web2api-free adapter.py](https://github.com/snake-aabb-wtf/deepseek-web2api-free/blob/main/adapter.py)
- [Fu-Jie/deepseek-free-api REVERSE_ENGINEERING_EXPERT_MODE.md](https://github.com/Fu-Jie/deepseek-free-api/blob/master/REVERSE_ENGINEERING_EXPERT_MODE.md)
- [DeepSeek-V4 Preview Release](https://api-docs.deepseek.com/news/news260424)
- [DeepSeek Vision 官方文档](https://api-docs.deepseek.com/guides/vision/)
- [DeepSeek 思考模式官方文档](https://api-docs.deepseek.com/zh-cn/guides/thinking_mode)
- [DeepSeek-R1 GitHub README](https://github.com/DeepSeek-AI/DeepSeek-R1)
- [Writing effective tools for agents — Anthropic](https://www.anthropic.com/engineering/writing-tools-for-agents)
- [OpenAI + MCP Tool Calling（tool-loop 最佳实践）](https://sudoall.com/mcp-openai-tool-calling/)
- [deepseek-free-api PoW 系统说明（DeepWiki）](https://deepwiki.com/LLM-Red-Team/deepseek-free-api/5.3-proof-of-work-system)