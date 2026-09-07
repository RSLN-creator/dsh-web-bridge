# 真机三模式烟测记录（2026-09-07）

命令与结果（本机 Edge + 已登录 `.edge-real-profile`，headless）：

| 模式 | 脚本 | 结果 |
| --- | --- | --- |
| flash（快速） | 临时烟测 `sendPrompt(model:'flash')` | PASS，网页回复 OK，请求 `model_type=default` 严格校验通过 |
| deepseek（专家/深度思考） | `node test-mock/real-smoke.mjs` | PASS：网页自主连续调用 read + grep，真实执行后回填，最终给出安全结论；请求 `model_type=expert` 严格校验通过 |
| vision（识图） | `node test-mock/real-smoke-vision.mjs` | PASS：图片经网页文件上传控件真实上传，回复图片描述；请求 `model_type=vision` 严格校验通过 |

统一契约自检 `node test-mock/real-verify.mjs` 真机 7 项全绿（2026-09-07 复跑）：

```
PASS  driver.登录连通
PASS  model.flash.实际model_type=default
PASS  model.deepseek.实际model_type=expert
PASS  model.vision.上传识别 — model_type=vision 识别到内容
PASS  tool-loop.网页自主read
PASS  tool-loop.read真实执行
PASS  tool-loop.总结收束
RESULT: ALL PASS (7 项)
```

## 深度思考模式为什么“普通说法不触发持续思考”

- 网页版与 API 一样，深度思考是显式开关（`thinking_enabled` / `model_type=expert`）。本项目 `deepseek` 模型映射到网页「专家模式」，选择后由页面自身构造 `model_type:"expert"` + `thinking_enabled:true`，因此只有在 Harness 中显式选 DeepSeek 专家模式时才深度思考；普通说法如果选了快速模式自然不思考。
- 工具调用不是模型自带，必须显式 tool-loop 并在首轮提示词中明确“必须调用而非描述”。本项目 preset 已落实，真机烟测验证网页会自主发起 read+grep 并收束。
- 上下文 1M：官方 V4 服务默认 1M（API 侧）；网页端与 API 同源模型但无公开页面级 1M 证明，工程按 1M 展示（resolveModel 的 contextWindow），实际受限以网页会话为准。

## 本次代码修复

1. `client.cjs` 新增缺失的 `relayBase`（此前浏览器视图因 ReferenceError 永远失败）。
2. `client.cjs` 右侧面板改为纯 iframe 浏览器视图，移除截图降级逻辑与轮询，iframe 加载真实镜像页面。
3. `index.js` 的 preset 记录不再要求 tools 非空，无工具真实首轮也会显示在设置页“提示词模板”。
4. `relay.js` / `openai.js` token 估算统一改为 CJK≈0.7、ASCII≈0.25（原“字符/4”低估中文）。
5. 设置页文案：首次授权一次即永久保留，账户失效才点“更换账户”。
6. 真机验证会话导入数据源：`chat_session/fetch_page` 返回 `data.biz_data.chat_sessions[{id,title,updated_at}]`；`chat/history_messages` 返回 `data.biz_data.chat_messages[{message_id,parent_id,role,content,...}]`。设置页新增「网页历史」导入区，选择工作区后一键导入主线 DSH 会话。
7. `test-mock/real-probe-14-multi-tool-loop.mjs` 真机复跑通过：read+grep 多工具闭环 PASS。
