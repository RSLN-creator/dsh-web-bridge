# Harness Web Bridge

已登录的 DeepSeek 网页作为 Harness 的模型提供方，复用原生本地工具、会话持久化及权限系统。当前版本 0.5.0。

安装：`pnpm pack` 后执行 `dsh plugin --profile web add ./dsh-webcode-bridge-0.4.1.tgz`，重启 `dsh web`。需要 Node.js 20+、系统 Edge；无需浏览器扩展。

原生「设置 > 网页桥接」管理登录与启用开关。默认沿用 `~/.dsh/webcode-edge-profile`。模型分组 Harness Web Bridge 提供 flash（快速）、vision（识图）、deepseek（专家）。旧模型 ID 保留别名兼容。

右侧 DeepSeek 会话复用已安装 better-sidebar 标签页；没有该插件时回退右侧抽屉。主视图通过本地固定上游代理加载真实网页，可直接输入、滚动和操作；代理不可用时才降级为驱动截图，登录独立放在原生设置。

已验证真实 Harness 本地文件读取、工具结果回传、最终审查、重载续聊。`pnpm test`、`node test-mock/run-m2b-driver.js`、`node test-mock/run-m2c-webapi.js` 为回归入口。

限制：只支持 DeepSeek；网页端没有独立 Vision 控件时，识图模式会使用当前网页模型加图片附件；旧网页会话导入 API 仍待适配。速度中的 token 数按字符估算，耗时来自网页 SSE 观测。工具请求受 Harness 原生权限管理。

本地 OpenAI 兼容 HTTP 地址 `http://127.0.0.1:8931/v1` 目前提供文本问答及模型选择；原生工具循环通过 Harness provider `webcode` 接入。

MIT。SSE 解码协议参考 MIT 项目 three-water666/webcode。产品展示名更新，安装包名及 provider ID 保持兼容。
