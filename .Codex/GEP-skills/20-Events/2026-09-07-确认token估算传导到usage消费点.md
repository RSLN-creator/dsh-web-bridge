---
type: event
date_occurred: 2026-09-07 22:50
capsule_used: ""
---
# 事件：确认 token 估算修复完整传导到全部 usage 消费点

## 背景
- 上上轮把 estimateTokens 从 字符数/4 改为 CJK/ASCII 混权。需核实：harness 真正消费的 usage 事件字段是否都走新版（若存在旁路/漏改用旧公式，则产出函数修了、消费点没生效，等于白修）。

## 执行过程

[2026-09-07] 核查 index.js 全部 usage 消费点
- 技术: grep estimateTokens 在 lib/index.js 的全部引用——仅 4 处 usage yield（行 267/336/346/357），全部为 `estimateTokens(turn.prompt)` / `estimateTokens(acc|finalText|text)`（输入 prompt、输出文本），无任何旧 `字符数/4` 旁路，也无别处内联估算。
- 操作: 只读 grep（未改代码）。
- 功能: 确认中文估算修复确实传导到 harness 消费的 usage（inputTokens/outputTokens），估算 vs 实测的对齐在此仓完整生效。

[2026-09-07] 结论
- 技术: 无需改动；4 点全覆盖，修复无空洞。
- 功能: 中文对话在做 API 语义的 usage 上报时，用贴近真实的估算；status.lastRate 提供实测，二者互补。

## 结论
- ✅ 修复传导一致，无旁路；本仓「估算(usage)+实测(lastRate)」齐备。
- ⏭️ 不在无根据处强加脆测试（usage 是 async generator，mock 整桥成本高、收益低）；一致性核查即充分证据。