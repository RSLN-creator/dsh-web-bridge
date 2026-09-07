# Harness Web Bridge 路线

## 当前版本 0.5.1

范围限 DeepSeek：真实模型切换、流式解码、原生工具循环、右侧会话和原生设置。包与 provider ID 保持兼容；展示名称改为 Harness Web Bridge。

0.5.1 新增（本轮）：右侧面板改为纯 iframe 浏览器视图（修复 relayBase 缺失导致的 ReferenceError，移除截图降级与轮询）、首轮提示词模板记录覆盖无工具真实会话、token 估算统一 CJK/ASCII 口径、真机三模式烟测全绿（flash/default、deepseek/expert+工具闭环、vision/vision+图片上传，见 doc/research/real-smoke-2026-09-07.md）。

已复用：MIT 的 webcode SSE 协议实现、Playwright Core、Harness 原生 LLM 与权限契约、已安装 better-sidebar 注册接口。没有复制侧栏插件本体，也没有引入另一套本地工具执行器。

## 后续顺序

1. DeepSeek 契约维护：将 DOM、模型目录、请求类型、SSE 样本集中为供应商契约；升级前运行三模型探测、真实只读工具闭环和脱敏样本回归。未知页面或请求类型拒绝继续，不静默降级模型。（探针脚本 test-mock/real-probe-05*.mjs 已就位；统一契约自检见 test-mock/real-verify.mjs，真机 7 项全绿：三模式 model_type=default/expert/vision + 工具闭环自主 read→真实执行→总结收束）
2. ~~支持图片附件~~（0.5.0 完成：消息图片块 → 网页文件上传，真机验证）
3. ~~恢复网页列表与导入~~（0.5.1 完成：真机验证 `chat_session/fetch_page` 与 `chat/history_messages` 当前结构；设置页「网页历史」可导入为主线 DSH 会话）
4. ~~设置持久化~~（0.5.0 完成 consent 持久化）；剩余：接入宿主 settingsScope 保存默认模式、预览刷新率等界面偏好。
5. 多站点：先抽取 provider contract，再分别添加 ChatGPT、Gemini adapter。每站点独立 profile、模型能力、解析器、错误分类；共享 Harness 工具协议、单页串行调度和 UI。
6. 强化可靠性：同一 Harness 会话并发提交隔离（0.5.0 已按 agentId 隔离网页会话）、网页上下文超限、删除网页会话后的完整重建、IME 和复制选区体验。
7. ~~自定义全局指令~~（0.5.1 完成：设置页「全局指令」保存到 webcode-settings.json，追加到每个新网页会话首轮提示词）
