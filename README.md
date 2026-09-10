# Harness Web Bridge

将已登录的网页 AI 接入 DeepSeek Harness：网页模型产生工具调用，由 Harness 原生权限系统执行本地工具，结果回传同一网页会话。包名 `dsh-webcode-bridge` 与 provider `webcode` 保留兼容。

## 使用

1. 在 `package/dsh-webcode-bridge` 执行 `pnpm install --frozen-lockfile`、`pnpm pack`。
2. 执行 `dsh plugin --profile web add ./dsh-webcode-bridge-<版本>.tgz`，重启 Harness。
3. 原生「设置 > 网页桥接」管理登录和自动化开关。默认复用 `~/.dsh/webcode-edge-profile`。
4. 模型选择器的 Harness Web Bridge 分组只提供 **一个** `DeepSeek` 模型（深度思考）。
5. 右侧网页面板使用 **DSH 官方右侧栏**（`@deepseek-ai/dsh-client-ui-sidebar-right`）的标签页；
   与会话头右上角的 Web Bridge 按钮互为一对（点击展开/收起）。**不依赖任何第三方侧栏插件。**

系统需要 Node.js 20+ 和 Microsoft Edge，无需另外加载浏览器扩展。当前本机运行入口为 http://127.0.0.1:3080。

## 工具调用折叠

网页面板里，模型按协议输出的工具调用与结果（```json 围栏 / `<tool_call>` 标签）会折成
**一行摘要**，点击才展开原文：

```
▶ ⚙ pwsh   command: Get-ChildItem -Force
▶ ✓ pwsh   success   1.2 千字符
```

- 判定按 `mcp_action` / `tool_call` 字样，纯字符串扫描（不用正则，避免转义失真）；
- **只动工具协议块**，普通代码块原样保留；
- 不改站点 DOM 结构：仅在 `<pre>` 前插一行 header，切换该 `<pre>` 的 display；
- `MutationObserver` 跟随流式渲染，新出现的块自动折叠。

实现见 `lib/toolfold.js`，护栏见 `test/toolfold.test.mjs`（真机 Edge 断言折叠与展开）。

## 当前能力

| 模型 ID | 名称 | 实际请求（旧三 pill UI） | 实际请求（2026-09-10 新版 UI） |
| --- | --- | --- | --- |
| `deepseek:deepseek` | DeepSeek | model_type=expert | model_type=default + thinking_enabled=true |

带图能力对该模型自动生效：有图就上传（网页自行路由为 `default + ref_file_ids`），无图不受限。
历史模型 id（`flash` / `vision` / `deepseek-web` / `deepseek-reasoner`）保留为别名，升级后旧设置值仍可解析。

网页模型生成工具请求，由 Harness 原生权限系统执行本地工具，结果回传同一网页会话。支持完整首轮上下文、增量工具结果、历史改写后重建和重启后从 Harness 历史恢复。网页智能搜索在自动生成前关闭。

右侧主视图通过本地固定上游代理加载真实网页 iframe，可直接输入、滚动和操作，登录放在原生设置；不再使用截图降级。设置页首次授权后永久保留，账户失效时才需更换登录；设置页还可追加「全局指令」，会注入每个新网页会话的首轮提示词。面板顶栏提供 **刷新** 按钮（官方右侧栏本身没有该入口）。

普通输出及已识别工具名称会流式传递，工具参数完整解析后才交给 Harness。token 估算统一为 CJK≈0.7、ASCII≈0.25；速度指标为网页 SSE 实测（首字/思考/正文），与估算口径区分。

## 多站点与跨域资源

9 个内容服务共用同一套镜像与驱动（见 `lib/providers.js` 的 `SITES`）。站点 HTML 常把脚本/样式放在**另一个域**上并用 `crossorigin` 引用，而该域返回的 `Access-Control-Allow-Origin` 可能是非法通配（DeepSeek 的 `https://*.deepseek.com`），浏览器会硬性拒绝执行，整页退化成「页面资源加载异常」。

因此站点声明 `staticOrigins` 后，`lib/mirror.js` 会：

1. 把 HTML/CSS 里指向这些域的绝对 URL 改写成同源 `/__static/<host>/…`；
2. 剥离 `integrity`（URL 变了必然失配）与 `crossorigin`；
3. 把脚本运行时发往这些域的 `fetch`/`XHR`（埋点上报等）一并改写，避免控制台刷 CORS 错误。

**顺序很关键**：先改写站点 HTML，再注入 bootstrap。反过来的话 bootstrap 里的 `UP`/`ASSETS` 常量会被一起改写，运行时比较永不命中（此坑已由 `test/mirror.test.mjs` 的护栏锁住）。

站点不可达（本机网络/代理不通）时，面板给出的是带站点名与重试按钮的说明页，而不是裸 JSON。

各站点静态域现状（2026-09-11 实测）：

| 站点 | staticOrigins | 实测 |
| --- | --- | --- |
| deepseek | `fe-static.deepseek.com` | 200，CORS 0 |
| glm | `sdata.chatglm.cn` | 200，CORS 52→0 |
| kimi | `statics.moonshot.cn` | 200（域名已由 `kimi.moonshot.cn` 迁移到 `www.kimi.com`） |
| qwen | `g.alicdn.com`、`img.alicdn.com` | 200，CORS 0 |
| doubao | — | 200，CORS 3→0 |
| claude | — | 200（地区受限，网页自身提示） |
| chatgpt / grok / gemini | — | 本机网络不可达（502 + 说明页） |

## 验证和边界

- `pnpm test`：回归、解析和 Harness 适配契约（含镜像同源改写护栏）。
- `node test-mock/run-m2b-driver.js`：真实 Edge 加模拟站点 JSON/SSE。
- `node test-mock/run-m2c-webapi.js`：控制面、预览和跨站拒绝。
- 已真实跑通本地 `providers.js` 读取、审查、工具结果回注、刷新续聊；详见 [验收](doc/verify.md)。
- 图片附件上传已接入；网页没有独立 Vision 控件时走图片附件兼容路径。
- 设置页新增「网页历史」导入区：读取真实网页会话列表，选择工作区后一键导入为主线 DSH 会话（已真机验证 fetch_page / history_messages 解析）。
- 不保证模型审查结论正确；网页输出中的工具示例也可能被误识别，必须保留 Harness 的工具权限与审批。
- 网页会话被删/过期时不再静默降级：桥会用整段首轮提示词重建（见 [长跑审查](doc/deepseek-longrun.md)）；网页输入框截断超长提示词会报 `PROMPT_TRUNCATED` 而不是发出半截。
- 2026-09-10 新版 UI（无模型 pill、只剩深度思考开关）已适配：驱动按 UI 代际自动选择操作路径，`pnpm doctor` 在新版真机 8/8 通过；取证见 [新版 UI 取证](doc/research/deepseek-newui-2026-09-10.md)。

[路线](PLAN.md)记录多站点适配与 DeepSeek 更新策略；[安全审查](doc/security-review.md)记录实际防护及剩余限制；[审查入口](doc/review-guide.md)给出「只看这 15 个文件」的代码地图与探针清单。
