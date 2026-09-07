# DeepSeek 专家模式逆向工程（本地参考存档）

> 本地存档自 `Fu-Jie/deepseek-free-api` 的 `REVERSE_ENGINEERING_EXPERT_MODE.md`
> 抓取时间：2026-09-07（因本机无法直连 GitHub，改用 WebFetch 抓取原始内容落盘）

## 背景
DeepSeek 官方 Web UI 推出"专家模式"。逆向目标是识别开启专家模式后 `POST /api/v0/chat/completion` 请求参数的变化。

## 关键差异（Default vs Expert）
| 维度 | 普通模式 (Default) | 专家模式 (Expert) |
| :--- | :--- | :--- |
| API 参数 | `"model_type": "default"`（或缺失） | **`"model_type": "expert"`** |
| 深度思考 | 可选 | 默认锁定开启 |
| 响应特征 | 标准 SSE 流 | 首帧声明 expert 模型类型 |

## 请求头与载荷
除标准浏览器头外必须包含：
- `Authorization: Bearer <Access_Token>`
- `X-Ds-Pow-Response`：PoW（Proof of Work）挑战答案，用于防暴力破解

JSON 载荷：
```json
{
  "chat_session_id": "97e6...",
  "parent_message_id": 2,
  "prompt": "你好",
  "ref_file_ids": [],
  "model_type": "expert",
  "search_enabled": false,
  "thinking_enabled": true,
  "preempt": false
}
```

## 常见故障点
1. `chat_session/create` 返回结构更新：ID 提取需从 `biz_data.id` 改为 `biz_data.chat_session.id`。
2. `parent_message_id` 类型错误：2026 协议要求为**数字（Number）**而非字符串，需 `parseInt()` 强转。
3. 多轮：首轮 `parent_message_id=null` → 返回 `chat_session_id`；后续携带相同 `chat_session_id` 且序号递增。

## 对 dsh-webcode-bridge 的意义
本桥采用「驱动页面 UI」而非「直接组包」，因此 PoW / `parent_message_id` / `model_type` 均由官方页面自身构造，天然避开了上述易碎点，这与 deepseek-2api / deepseek-free-api 的直接逆向方案相比更稳。本桥的 `MODEL_UI_CHANGED` 严格校验（`requestMetadata.model_type` 必须匹配：flash→default、deepseek→expert、vision→vision）即是对官方该字段的契约化约束。