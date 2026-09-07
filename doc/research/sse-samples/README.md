# DeepSeek Web · SSE 结构样本（供应商契约）

真机采集自 chat.deepseek.com `/api/v0/chat/completion` 的脱敏 SSE 结构骨架，
供 DeepSeek 页面升级前做「格式回归比对」——若帧 event 名 / `p/o/v` 操作 / 字段名变化，
应按新结构更新解析器，避免静默降级。

## 现有样本
- `flash.md`：快速模式（`model_type:"default"`）。已确认帧类型：`ready`、
  `update_session`（`fragments`、`thinking_enabled:false`、`search_enabled`、
  `accumulated_token_usage`、`stage_id`）、`p/o/v` BATCH/SET（`accumulated_token_usage`、
  `quasi_status=FINISHED`、`response/status=FINISHED`）、`title`、`close`。

## 真实模型类型（本仓库契约，真机核验）
- `flash` → `model_type:"default"`；`deepseek`（专家）→ `"expert"`；`vision`（识图）→ `"vision"`。
- 专家/识图模式把思考正文放 `fragments:[{type:"THINK"|"RESPONSE",content}]`。

## 采集方法
`node package/dsh-webcode-bridge/test-mock/real-probe-13-sse-sample.mjs [flash|deepseek]`
（需已登录的真实 Edge profile `d:\...\.edge-real-profile`）。

## 已知限制
- 只稳定捕获到「会话元事件 + 更新/结束帧」；逐 token 正文 `p/o/v` 帧因模型回复快、
  捕获来回合并而不稳定，未作为独立样本。功能正确性由 `test-mock/real-verify.mjs`
  的真机契约自检（三模型 + 工具闭环）保证。
- 内容一律脱敏为占位符，不含真实回复文本或 token。