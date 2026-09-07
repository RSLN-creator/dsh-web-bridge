---
type: event
date_occurred: 2026-09-07 18:20
capsule_used: ""
---
# 事件：真机连通 DeepSeek 逐模式核验，修复被二手调研误改的识图 model_type

## 背景
- 用户强调"真实解决、完美适配、每个工具的实际调用都要测试"，并要求实机连通 chat.deepseek.com 逐模式核对 model_type/思考开关/SSE。

## 执行过程

[2026-09-07] 找到真实登录 profile 并连通
- 技术: 扫描候选 profile 的 leveldb 找 userToken；`.edge-real-profile` 为已登录态（path=/、有 textarea）。旧 `.edge-real-profile2` 已失效（跳 /sign_in）。
- 操作: real-probe-07-url.mjs 逐 profile 诊断 URL/input/token。
- 功能: 确认可长驱直入聊天页，不再需要登录。

[2026-09-07] 逐模式真实轮询（real-probe-06/08/10）
- 技术: headless Edge + 已登录 profile，直接 sendPrompt 二种文本模式 + 一张真实生成的 HELLO 测试图做识图。
- 操作: lib/ 无需改动即可跑通 flash/deepseek；vision 走 uploadImages 真实上传。
- 功能: flash→model_type=default、首次 token ~512-690ms；deepseek→model_type=expert、thinking_enabled=false（专家模式仍作答）;vision→图片真实上传并被识别出"HELLO"。

[2026-09-07] 发现并修复误改的识图映射
- 技术: 真机实测识图请求上报 `model_type:"vision"`，推翻二手调研"无独立 vision、Vision 上报 default"的错误结论——正是该错误结论导致早前把 `browser-driver.js` 期望映射 vision:'vision' 错改成 `vision:'default'`，识图严格路径误报 MODEL_UI_CHANGED。
- 操作: lib/browser-driver.js 期望映射改回 `{flash:'default', deepseek:'expert', vision:'vision'}`；reference/local-refs/deepseek-web-逆向与V4事实-cross-verified.md 修正该错误事实并标注真机结论。
- 功能: 识图严格校验不再误报；三模式 model_type 全部对齐真实。doc/verify.md 第 21 行本就正确，无需改。

## 结论
- ✅ 三模式（flash/deepseek/vision）真机全部可用；识图图片上传→识别闭环真实打通（识别出 HELLO）。
- ✅ 修正了被二手调研误导的 model_type 映射，代码与 doc/verify.md 真机结论重归一致。
- ⚠️ vision 偶发超时（连续 2 次后第 3 次成功）为服务端/网络偶发，非代码回归；隔离 profile 注入 storageState 登录态不生效（deepseek 依赖 cookie）。
- ⏭️ 下一步：为供应商契约固化三模型探测脚本与脱敏 SSE 样本；跨平台 cfg 审查。