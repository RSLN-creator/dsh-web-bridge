# Harness Web Bridge

已登录的 DeepSeek 网页作为 Harness 的模型提供方，复用原生本地工具、会话持久化及权限系统。当前版本 0.9.4。

安装：`pnpm pack` 后执行 `dsh plugin --profile web add ./dsh-webcode-bridge-0.9.4.tgz`，重启 `dsh web`。需要 Node.js 20+、系统 Edge；无需浏览器扩展。

原生「设置 > 网页桥接」管理登录与启用开关。默认沿用 `~/.dsh/webcode-edge-profile`。模型分组 Harness Web Bridge 提供 flash（快速）、vision（识图）、deepseek（专家）。旧模型 ID 保留别名兼容。

右侧 DeepSeek 会话复用已安装 better-sidebar 标签页；没有该插件时回退右侧抽屉。主视图通过本地固定上游代理加载真实网页，可直接输入、滚动和操作；代理不可用时才降级为驱动截图，登录独立放在原生设置。

已验证真实 Harness 本地文件读取、工具结果回传、最终审查、重载续聊。`pnpm test`、`node test-mock/run-m2b-driver.js`、`node test-mock/run-m2c-webapi.js` 为回归入口。

限制：只支持 DeepSeek；网页端没有独立 Vision 控件时，识图模式会使用当前网页模型加图片附件；旧网页会话导入 API 仍待适配。速度中的 token 数按字符估算，耗时来自网页 SSE 观测。工具请求受 Harness 原生权限管理。

本地 OpenAI 兼容 HTTP 地址 `http://127.0.0.1:8931/v1` 目前提供文本问答及模型选择；原生工具循环通过 Harness provider `webcode` 接入。

## 0.9.4

协议文本不再进助手文本：截在正确的层。

真机会话里助手消息存的是整段协议原文（正文里出现 `<tool_call>` / 全角
DSML 标记加 JSON）。真因不在渲染，而在流式边界探测与解析器各认一套形态：
`parseAgentReply` 有 DSML 归一化，所以工具照常执行；而流式那句行内 `marker()`
只认半角标签 / 围栏 / Calling / 裸 `{`，对全角 DSML 恒返回 -1，于是协议原文被当
正文一路发出去。显示层折叠救不了它（那段是正文段落，不是 `<pre>`）。

- `findProtocolStart()`（`lib/agent-preset.js`）：与 `parseAgentReply` 共用同一套形态
  知识，探测协议起点与工具名；流式循环改用它。
- `stripProtocolText()`：下游兜底，保证写进会话的助手文本是散文。
- `normalizeDsml()`：归一化收为一处，探测与解析不再各写一份正则。

**工具闭环一字不改**：解析仍吃原文，只是“发往界面”的那一侧被截断。
回归：`test/protocol-leak.test.mjs`（9 项，真机夹具 `test/fixtures/leaked-dsml-reply.txt`）锁住
探测命中、解析照旧拿到完整调用、探测与解析形态不得漂移。
MIT。SSE 解码协议参考 MIT 项目 three-water666/webcode。产品展示名更新，安装包名及 provider ID 保持兼容。
