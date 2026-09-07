# dsh-webcode-bridge · Web AI (webcode)

把**已登录的 DeepSeek 网页版**桥接为 DeepSeek Harness (DSH) 的模型提供商：
模型选择器出现 **"Web AI (webcode)"** 分组，选中后 DSH 的调用自动经本地中继
打进网页（浏览器扩展在页面内自动收发），流式回传，原生 fs/shell/skills/MCP
不受影响。侧边栏提供可收起的内嵌网页抽屉（首次登录一次，之后无感）。

## 组成

- **Host**（`lib/index.js`）：注册 `llm` 提供商/适配器 + 本地中继
  （WS 给扩展 + OpenAI 兼容 HTTP 前端 `GET /v1/models`、
  `POST /v1/chat/completions`，JSON/SSE 双格式，仅 127.0.0.1）。
- **Client**（`lib/client.cjs`）：右缘 "Web AI" 按钮 + 滑出抽屉内嵌网页，
  带连接状态点；可收起，纯展示不拦截任何 DSH 交互。
- **浏览器扩展**（仓库 `extension/`，需手动加载）：MV3，Edge 优先，
  同意门（风险告知 + 主动启用）、XHR/fetch 捕获 DeepSeek SSE、自动发送，
  `all_frames` 支持 iframe。Firefox/Zen 用 `manifest-firefox.json` 变体。

## 安装（DSH web profile）

```sh
npm pack                       # 在本目录生成 dsh-webcode-bridge-0.1.0.tgz
dsh plugin --profile web add ./dsh-webcode-bridge-0.1.0.tgz
# 然后在 ~/.dsh/profiles/web/package.json 的 dsh.profile.bundles 加入 "dsh-webcode-bridge"，重启 dsh web
```

## 扩展加载与同意门

1. Edge → `edge://extensions` → 开发人员模式 → 加载解压缩的扩展（`extension/` 目录）。
2. 点击扩展图标：阅读自动化风险告知 → 勾选同意 → 开启"启用桥接"。
3. 侧边栏抽屉内登录 DeepSeek 网页一次；扩展未同意/未连接时中继拒绝派发任何请求。

## 本地验证（无需 DSH）

```sh
node bin/bridge-standalone.js 8931
node test/run-m1.js            # 桥接 + 模拟扩展自动化验收
node test-mock/run-m2.js       # 真实 Edge 扩展全链路（本地模拟站点）
```

## 已知限制

- 纯文本模型：不透传工具调用（DSH 原生工具在其它模型下不受影响）；
  reasoning(THINK) 片段不外泄。
- contextMode=fresh：每次调用新开网页会话、全量上下文拍平为一条消息。
- 网页 DOM/端点改版可能使选择器失效（集中配置，便于修复）。
- 自动化操作网页可能违反站点服务条款——风险由最终用户在扩展同意门确认。

## 许可

MIT。DeepSeek SSE 解码器改编自 [three-water666/webcode](https://github.com/three-water666/webcode)（MIT）。
