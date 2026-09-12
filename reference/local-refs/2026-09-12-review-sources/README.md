# 2026-09-12 右栏一致性评审 Sources 清单

来源：dsh-webcode-bridge 右栏一致性评估书（P0/P1/P2 路线）所引参考项目。
文档快照存本目录；代码仓库按 `reference/` 约定以纯 git clone 存于 `reference/` 根下。

## 代码仓库（reference/ 根下，git clone --depth 1）

| 仓库 | 本地路径 | 用途 |
| --- | --- | --- |
| vercel-labs/agent-browser v0.37.1 | `reference/agent-browser/` | CDP screencast over WebSocket + ack 流水线（ack/push 双模式）；P2 工程储备参照。关键文件 `cli/src/native/stream/websocket.rs`（ack 语义 L27-32、累计 ack L109-112）、`cli/src/native/stream/cdp_loop.rs`（startScreencast 参数 L156-162） |
| webrecorder/wabac.js | `reference/wabac.js/` | 同源改写代理嵌入 iframe 的成熟引擎；**第三种 cookie 模式**：上游 Set-Cookie → 剥成 name=value → `x-wabac-preset-cookie` 请求头回放（`src/response.ts:89-105`），完全不依赖浏览器 cookie jar，连带消灭前缀 cookie 语义与镜像 jar 单边腐化两问题。`examples/live-proxy/` 为实时代理示例 |
| http-party/node-http-proxy | `reference/node-http-proxy/` | cookieDomainRewrite/cookiePathRewrite 语义基准（README L351-375）：只重写 domain/path，**不动 Secure** |
| steel-dev/steel-browser | **未获取** | 本机三通道全败（git clone ×2 early EOF；codeload tarball 截断于 30.5MB 元数据区；npm registry 不通），价值随 screencast 搁置降级，待网络好转重试 |

## 文档快照（本目录，原始 HTML）

- `playwright-screencast-api.html` — Playwright Screencast API（onFrame JPEG / size / quality；playwright-core 1.63.0 本地 node_modules 已验证存在，`types/types.d.ts:18621`）
- `cdp-page-domain.html` — CDP Page domain（Page.startScreencast / screencastFrameAck）
- `replayweb-embedding.html` — ReplayWeb.page 嵌入文档（service worker 拦截 + iframe）
- `mcpui-protocol-details.html` — MCP-UI 协议细节（iframe 沙箱 + CSP 元数据）
- `devto-chatgpt-iframe-sandbox.html` — ChatGPT Apps 双 iframe 沙箱逆向（infoxicator.com 原文）
- `mcp-apps-blog.html` — MCP Apps 官方公告（宿主/沙箱必须异源规范）
- `cloudflare-browser-run.html` — Cloudflare Browser Run「Live View」
- `browserbase-what-is.html` — Browserbase Live View（WebRTC 路线，商业参照）
- `http-proxy-middleware-npm.html` 已弃（npm 页为 JS 壳），语义以 node-http-proxy 克隆内 README 为准
- Stack Overflow CDP 低 FPS 问答 403 拒绝抓取，结论已并入 agent-browser ack 流水线代码证据

## 本机实测结论（2026-09-12，Edge 150.0.4078.83 headless）

- playwright-core 1.63.0 `page.screencast.start({onFrame, size, quality})` 存在（回应评审方"无法核实"）。
- **http://127.0.0.1 属 trustworthy origin：`__Secure-*`/`__Host-*` 带 Secure 属性的 cookie 可正常落盘并在后续请求原样回传**（`.tmp/loopback-secure-cookie-test*.mjs` 双脚本验证）。镜像 `rewriteCookie` 剥 Secure 不仅无必要，还会让前缀 cookie 被浏览器拒收——保持 Secure 即可。
- Playwright `ctx.cookies()` CDP 查询对回环 Secure cookie 返回不全（只见非前缀非 Secure 条目），属 CDP 查询面偏差；浏览器真实行为以 document.cookie + 二次请求头为准。
