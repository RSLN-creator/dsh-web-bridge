---
type: event
date_occurred: 2026-09-07 13:30
capsule_used: ""
---
# 事件：核对网页 model_type 并修复识图映射 + 联网调研落盘

## 背景
- 用户反馈"现在是擦边、要真正达到需求"，并按需求 4/9 要求联网了解 dsh/reasonix 对 DeepSeek 的逆向与优化、下载参考到本地。

## 执行过程

[2026-09-07] 并行交叉调研（2 个 Explore 子 agent）
- 技术: agent A 逆向（/api/v0/chat/completion 载荷、PoW、SSE、官方 1M 上下文、主流 web2api 项目）；agent B 行为/prompt（为什么思考浅/不实操作、官方 No-system、推理引导、tool-loop 最佳实践）。
- 操作: WebSearch/WebFetch，多源并行验证。
- 功能: 确认三件关键事实——(1) model_type 只有 default/expert，无独立 vision；(2) 官方 V4 全线 1M 上下文；(3) 官方网页不用 system、指令进 user、需显式 tool-loop。

[2026-09-07] 修复识图 model_type 映射
- 技术: browser-driver.js 期望映射 vision:'vision' → vision:'default'（识图基于 V4-Flash，仍上报 default）；否则严格路径误报 MODEL_UI_CHANGED。
- 操作: lib/browser-driver.js。
- 功能: 识图模式严格路径不再被错误校验拦截。

[2026-09-07] 调研落盘本地参考
- 技术: 汇总两路调研为本地 markdown，含权威来源与对本工程的启示/已修项映射。
- 操作: reference/local-refs/deepseek-web-逆向与V4事实-cross-verified.md。
- 功能: 需求 9"下载参考到本地"以国内可访问方式完成（WebSearch 抓取内容落盘，未依赖 GitHub 直连）。

## 结论
- ✅ 识图 model_type 严格路径已修复；parse/regression8/m1/m4 全绿。
- ⚠️ 仍需真实账号+登录网页做 DOM 与 SSE 实机核对。
- ⏭️ 下一步：实机连通 chat.deepseek.com；跨平台审查。（本回合使用 WebSearch，来源见参考文档与回复末尾）