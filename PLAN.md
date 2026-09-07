# Harness Web Bridge 路线

## 当前版本 0.6.0

多站点内容服务打通：模型选择器与 /v1/models 暴露全部 9 个内容服务的模型（'site:model' 限定 id），executor 按站点路由到独立 driver（独立 profile，避免登录态串号），未初始化站点在状态接口给占位、不启动浏览器；思考链（onThink → DSH reasoning 块）与网页图片（onImage → markdown/OpenAI image parts）贯穿 DeepSeek/GLM/ChatGPT/Kimi/Qwen/豆包/Grok/Claude/Gemini。

0.6.0 新增（本轮）：
- 模型目录收口 `listAllModels()`（providers.js），DSH 选择器与 OpenAI /v1/models 同源；
- 多 driver 容器 `driverFor(siteId)`：deepseek 沿用默认驱动（兼容测试注入），其余站点懒创建 `profileDir/sites/<siteId>`；
- executor/OpenAI 前端共用 `qualifyModelId()` 归一化限定 id，杜绝跨站点重名串模型；
- /bridge/login 与 /__webcode/login 支持 `siteId` 参数按站点登录；status 聚合 `sites[]` 列表；
- 设置页「默认模型」下拉列全站点模型；
- 解码器按逆向证据对齐：GLM（parts[].content[] 嵌套）、Kimi（event:'cmpl'）、ChatGPT（JSON-patch + 结构帧双形态）、Qwen（OpenAI 兼容 SSE + qwen-free-api 兜底），见 reference/glm-free-api、Kimi-Free-API、LLMs2API 等仓库。

已复用：MIT 的 webcode SSE 协议实现、Playwright Core、Harness 原生 LLM 与权限契约、已安装 better-sidebar 注册接口。没有复制侧栏插件本体，也没有引入另一套本地工具执行器。

## 后续顺序

1. DeepSeek 契约维护：将 DOM、模型目录、请求类型、SSE 样本集中为供应商契约；升级前运行三模型探测、真实只读工具闭环和脱敏样本回归。未知页面或请求类型拒绝继续，不静默降级模型。（探针脚本 test-mock/real-probe-05*.mjs 已就位；统一契约自检见 test-mock/real-verify.mjs，真机 7 项全绿：三模式 model_type=default/expert/vision + 工具闭环自主 read→真实执行→总结收束）
2. ~~支持图片附件~~（0.5.0 完成：消息图片块 → 网页文件上传，真机验证）
3. ~~恢复网页列表与导入~~（0.5.1 完成：真机验证 `chat_session/fetch_page` 与 `chat/history_messages` 当前结构；设置页「网页历史」可导入为主线 DSH 会话）
4. ~~设置持久化~~（0.5.0 完成 consent 持久化）；剩余：接入宿主 settingsScope 保存默认模式、预览刷新率等界面偏好。
5. ~~多站点~~（0.6.0 完成：9 站点模型目录 + 独立 driver 路由 + 按站点登录；各站点解码器已按 reference 逆向证据对齐，真实登录后的 DOM 契约仍需逐站真机校准——completionPaths 子串匹配、模型选择器标签、图片回传形态以真机为准）
6. 强化可靠性：同一 Harness 会话并发提交隔离（0.5.0 已按 agentId 隔离网页会话）、网页上下文超限、删除网页会话后的完整重建、IME 和复制选区体验。
7. ~~自定义全局指令~~（0.5.1 完成：设置页「全局指令」保存到 webcode-settings.json，追加到每个新网页会话首轮提示词）
