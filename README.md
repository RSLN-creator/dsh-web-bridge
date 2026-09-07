# Harness Web Bridge

将已登录的 DeepSeek 网页接入 DeepSeek Harness。当前只支持 DeepSeek，包名 `dsh-webcode-bridge` 和 provider `webcode` 保留兼容。

## 使用

1. 在 `package/dsh-webcode-bridge` 执行 `pnpm install --frozen-lockfile`、`pnpm pack`。
2. 执行 `dsh plugin --profile web add ./dsh-webcode-bridge-0.5.0.tgz`，重启 Harness。
3. 原生「设置 > 网页桥接」管理登录和自动化开关。默认复用 `~/.dsh/webcode-edge-profile`。
4. 模型选择器的 Harness Web Bridge 分组提供 Flash、Vision、DeepSeek。
5. 右侧 DeepSeek 入口复用已安装 `dsh-better-sidebar` 的标签页、展开收起与拖动；无该插件时使用右侧抽屉。

系统需要 Node.js 20+ 和 Microsoft Edge，无需另外加载浏览器扩展。当前本机运行入口为 http://127.0.0.1:3080。

## 当前能力

| 模型 ID | 网页模式 | 实际请求 model_type |
| --- | --- | --- |
| flash | 快速模式 | default |
| vision | 识图模式 | vision |
| deepseek | 专家模式 | expert |

网页模型生成工具请求，由 Harness 原生权限系统执行本地工具，结果回传同一网页会话。支持完整首轮上下文、增量工具结果、历史改写后重建和重启后从 Harness 历史恢复。网页智能搜索在自动生成前关闭。

右侧主视图通过本地固定上游代理加载真实 DeepSeek 网页 iframe，可直接输入、滚动和操作，登录放在原生设置；不再使用截图降级。设置页首次授权后永久保留，账户失效时才需更换登录；设置页还可追加「全局指令」，会注入每个新网页会话的首轮提示词。

普通输出及已识别工具名称会流式传递，工具参数完整解析后才交给 Harness。token 估算统一为 CJK≈0.7、ASCII≈0.25；速度指标为网页 SSE 实测（首字/思考/正文），与估算口径区分。

## 验证和边界

- `pnpm test`：回归、解析和 Harness 适配契约。
- `node test-mock/run-m2b-driver.js`：真实 Edge 加模拟站点 JSON/SSE。
- `node test-mock/run-m2c-webapi.js`：控制面、预览和跨站拒绝。
- 已真实跑通本地 `providers.js` 读取、审查、工具结果回注、刷新续聊；详见 [验收](doc/verify.md)。
- Vision 模式切换与 Harness 图片附件上传已接入；网页版本没有独立 Vision 控件时会使用图片附件兼容路径。
- 设置页新增「网页历史」导入区：读取真实网页会话列表，选择工作区后一键导入为主线 DSH 会话（已真机验证 fetch_page / history_messages 解析）。
- 不保证模型审查结论正确；网页输出中的工具示例也可能被误识别，必须保留 Harness 的工具权限与审批。

[路线](PLAN.md)记录多站点适配与 DeepSeek 更新策略；[安全审查](doc/security-review.md)记录实际防护及剩余限制。
