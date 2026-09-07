# DeepSeek Web · flash · SSE 结构样本（脱敏）

- 采集时间: 2026-09-07T02:47:37.053Z
- 来源: chat.deepseek.com /api/v0/chat/completion（真机 flash 模式）
- 用途: 供应商契约回归样本，页面升级前比对格式是否变化

## 概要
```json
{
  "events": 5,
  "data": 8,
  "types": {
    "ready": 1,
    "update_session": 2,
    "title": 1,
    "close": 1
  },
  "longestData": 480
}
```

## 帧骨架（内容已脱敏）
```
event: ready
data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}
event: update_session
data: {"updated_at":1788749195.7142239}
data: {"v":{"response":{"message_id":2,"parent_id":1,"model":"","role":"ASSISTANT","thinking_enabled":false,"ban_edit":false,"ban_regenerate":false,"status":"WIP","incomplete_message":null,"accumulated_token_usage":0,"feedback":null,"inserted_at":1788749195.705288,"search_enabled":true,"fragments":[<redacted>],"stage_id":1}],"conversation_mode":"DEFAULT","has_pending_fragment":false,"auto_continue":fals
data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":38},{"p":"quasi_status","v":"FINISHED"}]}
data: {"p":"response/status","o":"SET","v":"FINISHED"}
event: update_session
data: {"updated_at":1788749195.976955}
event: title
data: {"content":"<redacted:n>，由采集截断"}
event: close
data: {"click_behavior":"none","auto_resume":false}
```
