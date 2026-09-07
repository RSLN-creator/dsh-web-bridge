# DeepSeek Free API（本地参考存档）

> 源自 `Fu-Jie/deepseek-free-api` README（DeepSeek-V4 逆向 API，持续维护版）。
> 抓取时间：2026-09-07

## 特性概览
- 多协议端点：OpenAI Chat Completions / OpenAI Responses / Anthropic Messages
- **DeepSeek V4**：V4-Flash / V4-Pro，上下文上限 1M tokens
- 联网搜索：自动解析搜索结果并附加引用
- 深度思考 (R1)：完美适配 Fragment-based 协议，思考过程与回答严格分离
- 智能会话复用：基于消息指纹自动接续 DeepSeek 会话，减少 Agent 全量历史重放
- 多 Token 支持 + 负载均衡

## 模型映射（官方协议参数注入）
| 模型名 | 后端版本 | 专家 | 深度思考 | 联网搜索 |
| :--- | :---: | :---: | :---: | :---: |
| `deepseek` | V4-Flash | ❌ | ❌ | ❌ |
| `deepseek-expert` | V4-Pro | ✅ | ❌ | ❌ |
| `deepseek-r1` | V4-Flash | ❌ | ✅ | ❌ |
| `deepseek-search` | V4-Flash | ❌ | ❌ | ✅ |
| `deepseek-expert-r1` | V4-Pro | ✅ | ✅ | ❌ |
| `deepseek-expert-search` | V4-Pro | ✅ | ❌ | ✅ |
| `deepseek-r1-search` | V4-Flash | ❌ | ✅ | ✅ |
| `deepseek-expert-r1-search` | V4-Pro | ✅ | ✅ | ✅ |

> 映射逻辑：含 `expert` → V4-Pro，否则 V4-Flash；含 `think`/`r1` → 开启思考；含 `search` → 开启搜索。

## 会话复用
- 基于 SQLite：除最后一条消息外提取「指纹」匹配旧会话自动接续
- 显式复用：`conversation_id: "session_id@parent_id"`
- 优势：模型继承之前搜索/思考/专家状态；仅发送最新一轮消息到官网，避免会话分裂。

## 重要警示
- 工具调用基于提示词模拟 + 正则解析，**不稳定**，不适合生产级 Agent 任务。
- 逆向 API 不稳定，官方建议付费使用官方 API。

## 对 dsh-webcode-bridge 的直接价值
- 确认 1M 上下文为官方能力，本桥 `resolveModel` 的 `contextWindow: 1_000_000` 正确。
- 本桥「每 DSH 会话 = 一个网页会话，增量发最新一轮」与会话复用思路一致，且无需 SQLite。
- 印证工具调用走「提示词 + 围栏解析」是生态通用做法，但有不确定性——这正是用户担忧「擦边」的根源；保持 Harness 原生工具审批兜底是正确的。